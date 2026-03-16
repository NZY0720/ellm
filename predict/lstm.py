import argparse
import json
from pathlib import Path
from typing import Dict, List

import numpy as np
import pandas as pd

# Optional ML stack. If unavailable, we will fall back to a simple baseline forecast.
HAS_ML = True
try:
    import joblib
    import torch
    from sklearn.preprocessing import MinMaxScaler
    from torch import nn
    from torch.utils.data import DataLoader, TensorDataset
except Exception:
    HAS_ML = False
    joblib = None  # type: ignore[assignment]
    torch = None  # type: ignore[assignment]
    MinMaxScaler = None  # type: ignore[assignment]
    nn = None  # type: ignore[assignment]
    DataLoader = None  # type: ignore[assignment]
    TensorDataset = None  # type: ignore[assignment]


ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_CSV = ROOT_DIR / "data" / "虚拟电厂_24h15min_数据.csv"
MODEL_DIR = Path(__file__).resolve().parent / "models"
OUTPUT_DIR = ROOT_DIR / "data" / "output"


TARGET_COLUMN_CANDIDATES = {
    # New default data source (24h, 15min): uses kW units and Chinese headers
    "Load": ["Load_MW", "负荷消耗_kW"],
    "PV": ["PV_MW", "光伏出力_kW"],
    # Wind not available in the new CSV; keep key to output a valid file for downstream.
    "Wind": ["Wind_MW", "风电出力_kW", "风电_kW"],
}


if HAS_ML:

    class LSTMForecaster(nn.Module):
        def __init__(self, input_size=1, hidden_size=64, num_layers=2, dropout=0.1):
            super().__init__()
            self.lstm = nn.LSTM(
                input_size=input_size,
                hidden_size=hidden_size,
                num_layers=num_layers,
                dropout=dropout if num_layers > 1 else 0.0,
                batch_first=True,
            )
            self.head = nn.Linear(hidden_size, 1)

        def forward(self, x):
            # x: (batch, seq_len, 1)
            output, _ = self.lstm(x)
            last_step = output[:, -1, :]
            return self.head(last_step)


def set_seed(seed: int = 42):
    np.random.seed(seed)
    if HAS_ML and torch is not None:
        torch.manual_seed(seed)


def make_sequences(series: np.ndarray, lookback: int):
    xs, ys = [], []
    for i in range(len(series) - lookback):
        xs.append(series[i : i + lookback])
        ys.append(series[i + lookback])
    x = np.array(xs, dtype=np.float32)
    y = np.array(ys, dtype=np.float32)
    return x, y


def train_model(
    series: np.ndarray,
    lookback: int,
    epochs: int,
    batch_size: int,
    lr: float,
    device,
):
    x, y = make_sequences(series, lookback)
    x_tensor = torch.from_numpy(x).unsqueeze(-1)
    y_tensor = torch.from_numpy(y).unsqueeze(-1)

    dataset = TensorDataset(x_tensor, y_tensor)
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=True)

    model = LSTMForecaster().to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    loss_fn = nn.MSELoss()

    model.train()
    for _ in range(epochs):
        for batch_x, batch_y in loader:
            batch_x = batch_x.to(device)
            batch_y = batch_y.to(device)
            optimizer.zero_grad()
            preds = model(batch_x)
            loss = loss_fn(preds, batch_y)
            loss.backward()
            optimizer.step()

    return model


def iterative_forecast(model, last_window: np.ndarray, steps: int, device):
    model.eval()
    window = last_window.copy()
    preds = []
    with torch.no_grad():
        for _ in range(steps):
            x = torch.from_numpy(window).float().unsqueeze(0).unsqueeze(-1).to(device)
            pred = model(x).cpu().numpy().reshape(-1)[0]
            preds.append(pred)
            window = np.concatenate([window[1:], np.array([pred], dtype=np.float32)])
    return np.array(preds, dtype=np.float32)


def load_or_train(
    target_name: str,
    series: np.ndarray,
    lookback: int,
    epochs: int,
    batch_size: int,
    lr: float,
    device,
    retrain: bool,
):
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    model_path = MODEL_DIR / f"lstm_{target_name}.pt"
    scaler_path = MODEL_DIR / f"scaler_{target_name}.pkl"
    config_path = MODEL_DIR / f"config_{target_name}.json"

    if model_path.exists() and scaler_path.exists() and not retrain:
        model = LSTMForecaster().to(device)
        model.load_state_dict(torch.load(model_path, map_location=device))
        scaler = joblib.load(scaler_path)
        return model, scaler

    scaler = MinMaxScaler()
    scaled = scaler.fit_transform(series.reshape(-1, 1)).reshape(-1)
    model = train_model(scaled, lookback, epochs, batch_size, lr, device)
    torch.save(model.state_dict(), model_path)
    joblib.dump(scaler, scaler_path)
    config_path.write_text(
        json.dumps(
            {
                "lookback": lookback,
                "epochs": epochs,
                "batch_size": batch_size,
                "lr": lr,
            },
            ensure_ascii=True,
            indent=2,
        ),
        encoding="utf-8",
    )
    return model, scaler


def _resolve_target_column(df: pd.DataFrame, target_name: str) -> str:
    candidates = TARGET_COLUMN_CANDIDATES.get(target_name) or []
    for c in candidates:
        if c in df.columns:
            return c
    return ""


def _to_float_series(series: pd.Series) -> np.ndarray:
    values = pd.to_numeric(series, errors="coerce").astype(float).values
    return values


def baseline_forecast(series: np.ndarray, steps: int) -> np.ndarray:
    series = np.asarray(series, dtype=np.float32)
    if series.size == 0:
        return np.zeros(steps, dtype=np.float32)
    if series.size >= steps:
        return series[-steps:].astype(np.float32)
    reps = int(np.ceil(steps / series.size))
    tiled = np.tile(series, reps)[:steps]
    return tiled.astype(np.float32)


def forecast_target(
    df: pd.DataFrame,
    target_name: str,
    lookback: int,
    steps: int,
    args,
    *,
    strict_ml: bool = False,
) -> np.ndarray:
    col = _resolve_target_column(df, target_name)
    if not col:
        if strict_ml:
            raise ValueError(f"missing column for target={target_name}")
        return np.zeros(steps, dtype=np.float32)

    series = _to_float_series(df[col])
    series = series[np.isfinite(series)]
    if series.size == 0:
        if strict_ml:
            raise ValueError(f"empty series for target={target_name}")
        return np.zeros(steps, dtype=np.float32)

    # For very small datasets (e.g., 96 points/day), prefer baseline.
    safe_lookback = int(min(max(4, lookback), max(4, series.size - 2)))
    if not HAS_ML:
        if strict_ml:
            raise RuntimeError("ML stack not available. Install torch, scikit-learn, joblib.")
        return baseline_forecast(series, steps)
    if series.size < (safe_lookback + 8):
        if strict_ml:
            raise ValueError(f"not enough history points for LSTM: size={series.size} lookback={safe_lookback}")
        return baseline_forecast(series, steps)

    model, scaler = load_or_train(
        target_name=target_name,
        series=series,
        lookback=safe_lookback,
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        device=args.device,
        retrain=args.retrain,
    )
    scaled = scaler.transform(series.reshape(-1, 1)).reshape(-1)
    last_window = scaled[-safe_lookback:]
    scaled_preds = iterative_forecast(model, last_window, steps, args.device)
    preds = scaler.inverse_transform(scaled_preds.reshape(-1, 1)).reshape(-1)
    return preds.astype(np.float32)


def forecast_recent_window(
    *,
    csv_path: str,
    targets: List[str],
    window_rows: int,
    steps: int,
    lookback: int = 32,
    retrain: bool = False,
    base_date: str = "2026-01-01",
) -> Dict[str, np.ndarray]:
    """
    Load CSV, take the most recent `window_rows`, and forecast `steps` ahead for each target.
    This function is intended to be called by the local Flask service for one-shot inference.
    """
    if not HAS_ML:
        raise RuntimeError("ML stack not available. Install torch, scikit-learn, joblib.")

    p = Path(csv_path)
    if not p.exists():
        raise FileNotFoundError(f"CSV not found: {csv_path}")

    df = pd.read_csv(p, encoding="utf-8-sig")
    df = _ensure_datetime(df, base_date)
    df = df.sort_values("Datetime").reset_index(drop=True)
    if window_rows > 0 and len(df) > window_rows:
        df = df.iloc[-window_rows:].reset_index(drop=True)

    class _Args:
        pass

    args = _Args()
    args.epochs = 20
    args.batch_size = 64
    args.lr = 1e-3
    args.retrain = retrain
    args.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    outputs: Dict[str, np.ndarray] = {}
    for t in targets:
        outputs[t] = forecast_target(df, t, lookback, steps, args, strict_ml=True)
    return outputs


def build_future_index(df: pd.DataFrame, steps: int):
    dt = pd.to_datetime(df["Datetime"])
    dt = dt.dropna()
    if dt.empty:
        base = pd.Timestamp.today().normalize()
        return pd.date_range(base, periods=steps, freq="15min")

    dt = dt.sort_values()
    last_time = dt.iloc[-1]

    freq = pd.infer_freq(dt)
    if freq is None:
        diffs = dt.diff().dropna().dt.total_seconds().values
        if diffs.size:
            median_s = float(np.median(diffs))
            freq = f"{int(max(1, round(median_s / 60.0)))}min"
        else:
            freq = "15min"

    offset = pd.tseries.frequencies.to_offset(freq)
    future_index = pd.date_range(last_time + offset, periods=steps, freq=freq)
    return future_index


def _ensure_datetime(df: pd.DataFrame, base_date: str) -> pd.DataFrame:
    if "Datetime" in df.columns:
        df["Datetime"] = pd.to_datetime(df["Datetime"], errors="coerce")
        return df
    if "时间_小时" in df.columns:
        base = pd.Timestamp(base_date)
        hours = pd.to_numeric(df["时间_小时"], errors="coerce").astype(float)
        df["Datetime"] = base + pd.to_timedelta(hours, unit="h")
        return df
    raise ValueError("CSV must include 'Datetime' or '时间_小时' column.")


def main():
    parser = argparse.ArgumentParser(description="Train or load LSTM models and forecast 24h.")
    parser.add_argument("--csv", type=str, default=str(DEFAULT_CSV))
    parser.add_argument("--lookback", type=int, default=32)
    parser.add_argument("--steps", type=int, default=96, help="24h for 15min data is 96 steps")
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--retrain", action="store_true")
    parser.add_argument("--base-date", type=str, default="2026-01-01", help="used when CSV has only '时间_小时'")
    args = parser.parse_args()

    if HAS_ML and torch is not None:
        args.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    else:
        args.device = None

    csv_path = Path(args.csv)
    if not csv_path.exists():
        raise FileNotFoundError(f"CSV not found: {csv_path}")

    df = pd.read_csv(csv_path, encoding="utf-8-sig")
    df = _ensure_datetime(df, args.base_date)
    df = df.sort_values("Datetime").reset_index(drop=True)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    future_index = build_future_index(df, args.steps)

    for target in ["Load", "Wind", "PV"]:
        preds = forecast_target(df, target, args.lookback, args.steps, args)
        output_df = pd.DataFrame(
            {
                "Datetime": future_index,
                f"{target}_Forecast": preds,
            }
        )
        output_path = OUTPUT_DIR / f"{target}_forecast_24h.csv"
        output_df.to_csv(output_path, index=False, encoding="utf-8-sig")


if __name__ == "__main__":
    set_seed(42)
    main()
