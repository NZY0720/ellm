import argparse
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import torch
from sklearn.preprocessing import MinMaxScaler
from torch import nn
from torch.utils.data import DataLoader, TensorDataset


ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_CSV = ROOT_DIR / "VPP一年优化数据.csv"
MODEL_DIR = Path(__file__).resolve().parent / "models"
OUTPUT_DIR = Path(__file__).resolve().parent / "output"


TARGET_COLUMNS = {
    "Load": "Load_MW",
    "Wind": "Wind_MW",
    "PV": "PV_MW",
}


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
    device: torch.device,
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


def iterative_forecast(model, last_window: np.ndarray, steps: int, device: torch.device):
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
    device: torch.device,
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


def forecast_target(df: pd.DataFrame, target_name: str, lookback: int, steps: int, args):
    series = df[TARGET_COLUMNS[target_name]].astype(float).values
    model, scaler = load_or_train(
        target_name=target_name,
        series=series,
        lookback=lookback,
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        device=args.device,
        retrain=args.retrain,
    )
    scaled = scaler.transform(series.reshape(-1, 1)).reshape(-1)
    last_window = scaled[-lookback:]
    scaled_preds = iterative_forecast(model, last_window, steps, args.device)
    preds = scaler.inverse_transform(scaled_preds.reshape(-1, 1)).reshape(-1)
    return preds


def build_future_index(df: pd.DataFrame, steps: int):
    last_time = pd.to_datetime(df["Datetime"].iloc[-1])
    freq = pd.infer_freq(pd.to_datetime(df["Datetime"]))
    if freq is None:
        freq = "H"
    future_index = pd.date_range(last_time + pd.Timedelta(hours=1), periods=steps, freq=freq)
    return future_index


def main():
    parser = argparse.ArgumentParser(description="Train or load LSTM models and forecast 24h.")
    parser.add_argument("--csv", type=str, default=str(DEFAULT_CSV))
    parser.add_argument("--lookback", type=int, default=168)
    parser.add_argument("--steps", type=int, default=24)
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--retrain", action="store_true")
    args = parser.parse_args()

    args.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    csv_path = Path(args.csv)
    if not csv_path.exists():
        raise FileNotFoundError(f"CSV not found: {csv_path}")

    df = pd.read_csv(csv_path)
    if "Datetime" not in df.columns:
        raise ValueError("CSV must include 'Datetime' column.")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    future_index = build_future_index(df, args.steps)

    for target in TARGET_COLUMNS:
        preds = forecast_target(df, target, args.lookback, args.steps, args)
        output_df = pd.DataFrame(
            {
                "Datetime": future_index,
                f"{target}_Forecast": preds,
            }
        )
        output_path = OUTPUT_DIR / f"{target}_forecast_24h.csv"
        output_df.to_csv(output_path, index=False, encoding="utf-8")


if __name__ == "__main__":
    set_seed(42)
    main()
