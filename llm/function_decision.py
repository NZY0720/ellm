import csv
import math
import os
from datetime import datetime
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from function_predict import write_data_csv


@dataclass
class DecisionStats:
    horizon_hours: float
    step_minutes: int
    steps: int
    window_hours: float
    window_rows: int
    capacity_kwh: float
    soc_initial_kwh: float
    soc_final_kwh: float
    p_max_kw: float
    objective: str


@dataclass
class DecisionOutput:
    ok: bool
    message: str
    filename: str = ""
    csv_text: str = ""
    warnings: List[str] = field(default_factory=list)
    stats: Optional[DecisionStats] = None


def _safe_float(value: object) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _read_csv_rows(path: str) -> List[Dict[str, str]]:
    with open(path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        return [row for row in reader if row]


def _extract_hour_value(row: Dict[str, str]) -> Optional[float]:
    hour = _safe_float(row.get("时间_小时"))
    if hour is not None:
        return hour
    period = _safe_float(row.get("时间_时段"))
    if period is not None:
        return period - 1.0
    return None


def _infer_history_step_minutes(rows: List[Dict[str, str]]) -> int:
    diffs: List[float] = []
    prev: Optional[float] = None
    for row in rows[-256:]:
        hour = _extract_hour_value(row)
        if hour is None:
            continue
        if prev is not None:
            diff_h = hour - prev
            if diff_h > 0:
                diffs.append(diff_h * 60.0)
        prev = hour
    if not diffs:
        return 1
    diffs.sort()
    return max(1, int(round(diffs[len(diffs) // 2])))


def _resample_history_rows(rows: List[Dict[str, str]], target_step_minutes: int) -> List[Dict[str, str]]:
    if not rows:
        return rows
    actual_step = _infer_history_step_minutes(rows)
    if actual_step >= target_step_minutes:
        return rows
    if target_step_minutes % actual_step != 0:
        return rows

    group_size = int(round(target_step_minutes / actual_step))
    if group_size <= 1:
        return rows

    usable = len(rows) - (len(rows) % group_size)
    if usable <= 0:
        return rows

    result: List[Dict[str, str]] = []
    for start in range(0, usable, group_size):
        chunk = rows[start : start + group_size]
        last = chunk[-1]

        def _avg(key: str) -> str:
            values = [_safe_float(item.get(key)) for item in chunk]
            clean = [float(v) for v in values if v is not None]
            if not clean:
                return ""
            avg = sum(clean) / len(clean)
            return f"{avg:.6f}".rstrip("0").rstrip(".")

        result.append(
            {
                "Datetime": str(last.get("Datetime", "")),
                "时间_小时": str(last.get("时间_小时", "")),
                "时间_时段": str(last.get("时间_时段", "")),
                "光伏出力_kW": _avg("光伏出力_kW"),
                "负荷消耗_kW": _avg("负荷消耗_kW"),
                "实时电价_元/kWh": _avg("实时电价_元/kWh"),
            }
        )
    return result


def _parse_hour(text: str) -> Optional[float]:
    if not text:
        return None
    s = str(text).strip()
    if not s:
        return None
    if s.replace(".", "", 1).isdigit():
        return float(s)
    if ":" in s:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M"):
            try:
                dt = datetime.strptime(s, fmt)
                return float(dt.hour) + float(dt.minute) / 60.0
            except ValueError:
                continue
        parts = s.split(":")
        if len(parts) == 2:
            h = _safe_float(parts[0])
            m = _safe_float(parts[1])
            if h is None or m is None:
                return None
            return float(h) + float(m) / 60.0
    return None


def _build_time_of_day_price_map(history_rows: List[Dict[str, str]]) -> Tuple[Dict[float, float], List[str]]:
    warnings: List[str] = []
    buckets: Dict[float, List[float]] = {}

    for r in history_rows:
        hour = _extract_hour_value(r)
        if hour is None:
            continue
        hour = float(hour) % 24.0
        price = _safe_float(r.get("实时电价_元/kWh"))
        if price is None:
            continue
        buckets.setdefault(float(hour), []).append(float(price))

    if not buckets:
        warnings.append("历史数据缺少 实时电价_元/kWh，电价将按 0 处理")
        return {}, warnings

    price_map = {k: (sum(v) / len(v)) for k, v in buckets.items() if v}
    return price_map, warnings


def _nearest_lookup(map_: Dict[float, float], hour: float, default: float = 0.0) -> float:
    if not map_:
        return default
    keys = list(map_.keys())
    nearest = min(keys, key=lambda k: abs(k - hour))
    return float(map_.get(nearest, default))


def _format_num(x: float, digits: int = 6) -> str:
    return f"{x:.{digits}f}".rstrip("0").rstrip(".")


def _dp_optimize_storage(
    *,
    load_kw: List[float],
    pv_kw: List[float],
    price: List[float],
    dt_h: float,
    soc_min_kwh: float,
    soc_max_kwh: float,
    soc0_kwh: float,
    socT_kwh: float,
    p_max_kw: float,
    soc_step_kwh: float,
    power_step_kw: float = 1.0,
) -> Tuple[List[float], List[float], List[float]]:
    """
    Minimize total grid cost: sum(grid_kW * price * dt_h)
    where grid_kW = (load - pv) - p_batt (p_batt>0 discharge).
    """
    steps = min(len(load_kw), len(pv_kw), len(price))
    if steps <= 0:
        return [], [], []

    soc_step = soc_step_kwh
    if soc_step <= 0:
        raise ValueError("invalid soc step")

    def to_idx(soc: float) -> int:
        return int(round((soc - soc_min_kwh) / soc_step))

    n_states = int(round((soc_max_kwh - soc_min_kwh) / soc_step)) + 1
    if n_states <= 1:
        raise ValueError("invalid soc bounds")

    # DP over SOC states: cost[t][i] = min cost up to time t with SOC index i
    inf = 1e30
    cost = [inf] * n_states
    prev_idx: List[List[int]] = [[-1] * n_states for _ in range(steps)]
    prev_p: List[List[float]] = [[0.0] * n_states for _ in range(steps)]

    i0 = max(0, min(n_states - 1, to_idx(soc0_kwh)))
    cost[i0] = 0.0

    for t in range(steps):
        next_cost = [inf] * n_states
        net = float(load_kw[t]) - float(pv_kw[t])
        pr = float(price[t])

        for i in range(n_states):
            base = cost[i]
            if base >= inf / 2:
                continue
            soc = soc_min_kwh + i * soc_step

            # Feasible power bounds from SOC + power limit
            p_min = max(-p_max_kw, -(soc_max_kwh - soc) / dt_h)
            p_max = min(p_max_kw, (soc - soc_min_kwh) / dt_h)

            p = math.ceil(p_min / power_step_kw) * power_step_kw
            while p <= p_max + 1e-9:
                soc_next = soc - p * dt_h
                j = int(round((soc_next - soc_min_kwh) / soc_step))
                if 0 <= j < n_states:
                    grid = net - p
                    step_cost = grid * pr * dt_h
                    cand = base + step_cost
                    if cand < next_cost[j]:
                        next_cost[j] = cand
                        prev_idx[t][j] = i
                        prev_p[t][j] = float(p)
                p += power_step_kw

        cost = next_cost

    iT = max(0, min(n_states - 1, to_idx(socT_kwh)))
    if cost[iT] >= inf / 2:
        # If exact terminal SOC isn't reachable due to discretization, pick nearest.
        best_i = min(range(n_states), key=lambda i: cost[i])
    else:
        best_i = iT

    # Backtrack
    p_schedule: List[float] = [0.0] * steps
    soc_schedule: List[float] = [0.0] * steps
    grid_schedule: List[float] = [0.0] * steps

    j = best_i
    soc = soc_min_kwh + j * soc_step
    for t in range(steps - 1, -1, -1):
        i = prev_idx[t][j]
        p = prev_p[t][j]
        if i < 0:
            i = j
            p = 0.0
        soc_prev = soc_min_kwh + i * soc_step
        # Forwards definition: soc_next = soc_prev - p*dt
        p_schedule[t] = float(p)
        soc_schedule[t] = float(soc_prev - p * dt_h)
        grid_schedule[t] = (float(load_kw[t]) - float(pv_kw[t])) - float(p)
        j = i
        soc = soc_prev

    return p_schedule, soc_schedule, grid_schedule


def build_market_decision_12h(
    *,
    data_dir: str,
    history_file: str = "虚拟电厂_24h15min_数据.csv",
    load_forecast_file: str = "output/Load_forecast_12h.csv",
    pv_forecast_file: str = "output/PV_forecast_12h.csv",
    output_file: str = "output/Market_decision_12h.csv",
    horizon_hours: float = 12.0,
    step_minutes: int = 15,
    window_hours: float = 24.0,
    capacity_kwh: float = 200.0,
    soc_initial_kwh: Optional[float] = None,
    soc_final_kwh: Optional[float] = None,
    p_max_kw: float = 100.0,
) -> DecisionOutput:
    warnings: List[str] = []
    if step_minutes <= 0 or 60 % step_minutes != 0:
        return DecisionOutput(ok=False, message="step_minutes 必须能整除 60（例如 15）")
    if horizon_hours <= 0:
        return DecisionOutput(ok=False, message="horizon_hours 必须 > 0")
    if capacity_kwh <= 0:
        return DecisionOutput(ok=False, message="capacity_kwh 必须 > 0")
    if p_max_kw <= 0:
        return DecisionOutput(ok=False, message="p_max_kw 必须 > 0")

    dt_h = step_minutes / 60.0
    steps = int(round(horizon_hours / dt_h))
    history_path = os.path.join(data_dir, history_file)
    if not os.path.exists(history_path):
        return DecisionOutput(ok=False, message=f"历史数据不存在: {history_file}")

    load_path = os.path.join(data_dir, load_forecast_file)
    pv_path = os.path.join(data_dir, pv_forecast_file)
    if not os.path.exists(load_path):
        return DecisionOutput(ok=False, message=f"负荷预测不存在: {load_forecast_file}")
    if not os.path.exists(pv_path):
        return DecisionOutput(ok=False, message=f"光伏预测不存在: {pv_forecast_file}")

    try:
        history_rows_all = _read_csv_rows(history_path)
        history_step_minutes = _infer_history_step_minutes(history_rows_all)
        raw_window_rows = int(round(window_hours * 60.0 / history_step_minutes))
        history_rows_raw = history_rows_all[-raw_window_rows:] if len(history_rows_all) > raw_window_rows else history_rows_all
        history_rows = _resample_history_rows(history_rows_raw, step_minutes)
    except OSError as exc:
        return DecisionOutput(ok=False, message=f"历史数据读取失败: {exc}")

    if not history_rows:
        return DecisionOutput(ok=False, message="历史数据为空")

    price_map, price_warnings = _build_time_of_day_price_map(history_rows)
    warnings.extend(price_warnings)

    # Determine last hour from history (time axis base)
    last = history_rows[-1]
    last_hour = _extract_hour_value(last)
    if last_hour is None:
        return DecisionOutput(ok=False, message="无法从历史数据解析最后时间点（时间_小时/时间_时段）")

    # Forecast series
    load_rows = _read_csv_rows(load_path)
    pv_rows = _read_csv_rows(pv_path)
    if not load_rows or not pv_rows:
        return DecisionOutput(ok=False, message="预测文件为空")

    aligned = min(steps, len(load_rows), len(pv_rows))
    if aligned <= 0:
        return DecisionOutput(ok=False, message="预测长度不足")

    dts: List[str] = []
    load_kw: List[float] = []
    pv_kw: List[float] = []
    price: List[float] = []

    for i in range(aligned):
        dt_text = str(load_rows[i].get("Datetime", "")).strip()
        if not dt_text:
            dt_text = str(pv_rows[i].get("Datetime", "")).strip()
        dts.append(dt_text)

        lv = _safe_float(load_rows[i].get("Load_Forecast"))
        pv = _safe_float(pv_rows[i].get("PV_Forecast"))
        load_kw.append(float(lv or 0.0))
        pv_kw.append(float(pv or 0.0))

        h = _parse_hour(dt_text)
        if h is None:
            # fallback: use last_hour + step
            h = float(last_hour) + dt_h * (i + 1)
        tod = float(h) % 24.0
        price.append(_nearest_lookup(price_map, tod, default=0.0))

    soc0 = float(soc_initial_kwh) if soc_initial_kwh is not None else capacity_kwh * 0.5
    socT = float(soc_final_kwh) if soc_final_kwh is not None else soc0
    soc0 = min(max(soc0, 0.0), capacity_kwh)
    socT = min(max(socT, 0.0), capacity_kwh)

    p_schedule, soc_schedule, grid_schedule = _dp_optimize_storage(
        load_kw=load_kw,
        pv_kw=pv_kw,
        price=price,
        dt_h=dt_h,
        soc_min_kwh=0.0,
        soc_max_kwh=capacity_kwh,
        soc0_kwh=soc0,
        socT_kwh=socT,
        p_max_kw=p_max_kw,
        soc_step_kwh=1.0 if step_minutes <= 5 else 0.5,
        power_step_kw=5.0 if step_minutes <= 5 else 2.0,
    )

    # Build CSV
    headers = [
        "Datetime",
        "Load_Forecast_kW",
        "PV_Forecast_kW",
        "Price_yuan_per_kWh",
        "Net_Load_kW",
        "Battery_Power_kW",
        "SOC_kWh",
        "Grid_Power_kW",
        "Grid_Cost_yuan",
    ]
    lines = [",".join(headers)]
    for i in range(aligned):
        net = load_kw[i] - pv_kw[i]
        p = p_schedule[i]
        soc = soc_schedule[i]
        grid = grid_schedule[i]
        cost = grid * price[i] * dt_h
        lines.append(
            ",".join(
                [
                    dts[i],
                    _format_num(load_kw[i], 4),
                    _format_num(pv_kw[i], 4),
                    _format_num(price[i], 6),
                    _format_num(net, 4),
                    _format_num(p, 4),
                    _format_num(soc, 4),
                    _format_num(grid, 4),
                    _format_num(cost, 6),
                ]
            )
        )
    csv_text = "\n".join(lines)

    stats = DecisionStats(
        horizon_hours=horizon_hours,
        step_minutes=step_minutes,
        steps=aligned,
        window_hours=window_hours,
        window_rows=len(history_rows),
        capacity_kwh=capacity_kwh,
        soc_initial_kwh=soc0,
        soc_final_kwh=socT,
        p_max_kw=p_max_kw,
        objective="minimize grid cost (buy positive / sell negative) at market price",
    )
    return DecisionOutput(ok=True, message="ok", filename=output_file, csv_text=csv_text, warnings=warnings, stats=stats)


def write_market_decision_12h(**kwargs) -> DecisionOutput:
    data_dir = kwargs.get("data_dir")
    if not data_dir:
        return DecisionOutput(ok=False, message="data_dir is required")
    result = build_market_decision_12h(**kwargs)
    if not result.ok:
        return result
    wr = write_data_csv(result.filename, result.csv_text, data_dir)
    if not wr.ok:
        return DecisionOutput(ok=False, message=wr.message, warnings=result.warnings, stats=result.stats)
    result.filename = wr.filename
    return result
