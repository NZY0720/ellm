import csv
import os
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, Iterable, List, Optional, Tuple

from function_predict import write_agent_csv


DEFAULT_HORIZONS = [1, 6, 12, 24]


@dataclass
class DecisionStats:
    soc_min: float
    soc_max: float
    soc_initial: float
    discharge_max: float
    charge_max: float
    net_target: float


@dataclass
class DecisionOutput:
    ok: bool
    message: str
    outputs: Dict[str, str] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)
    stats: Optional[DecisionStats] = None


def _safe_float(value: object) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_datetime(value: str) -> Optional[datetime]:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    fmts = [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y/%m/%d %H:%M:%S",
        "%Y/%m/%d %H:%M",
        "%Y/%m/%d %H:%M:%S",
    ]
    for fmt in fmts:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def _load_csv_rows(path: str) -> List[Dict[str, str]]:
    with open(path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return [row for row in reader if row]


def _compute_history_stats(rows: List[Dict[str, str]]) -> Tuple[DecisionStats, List[str]]:
    warnings: List[str] = []
    soc_values: List[float] = []
    es_values: List[float] = []
    net_values: List[float] = []

    for row in rows:
        load = _safe_float(row.get("Load_MW"))
        wind = _safe_float(row.get("Wind_MW"))
        pv = _safe_float(row.get("PV_MW"))
        es = _safe_float(row.get("ES_MW_Optimized"))
        soc = _safe_float(row.get("ES_SOC_Optimized"))

        if soc is not None:
            soc_values.append(soc)
        if es is not None:
            es_values.append(es)
        if load is not None and wind is not None and pv is not None:
            net_values.append(load - wind - pv)

    if not soc_values:
        soc_min = 0.0
        soc_max = 0.0
        soc_initial = 0.0
        warnings.append("历史数据缺少 ES_SOC_Optimized，SOC 统计使用 0 兜底")
    else:
        soc_min = min(soc_values)
        soc_max = max(soc_values)
        soc_initial = soc_values[-1]

    if not es_values:
        discharge_max = 0.0
        charge_max = 0.0
        warnings.append("历史数据缺少 ES_MW_Optimized，功率上限使用 0 兜底")
    else:
        discharge_max = max(0.0, max(es_values))
        charge_max = max(0.0, abs(min(es_values)))

    if not net_values:
        net_target = 0.0
        warnings.append("历史数据缺少净负荷统计，净负荷目标使用 0 兜底")
    else:
        net_target = sum(net_values) / len(net_values)

    stats = DecisionStats(
        soc_min=soc_min,
        soc_max=soc_max,
        soc_initial=soc_initial,
        discharge_max=discharge_max,
        charge_max=charge_max,
        net_target=net_target,
    )
    return stats, warnings


def _build_forecast_rows(
    load_path: str,
    wind_path: str,
    pv_path: str,
) -> Tuple[List[Dict[str, object]], List[str]]:
    warnings: List[str] = []
    load_rows = _load_csv_rows(load_path)
    if not load_rows:
        return [], ["负荷预测文件为空或无法解析"]

    wind_map: Dict[datetime, float] = {}
    pv_map: Dict[datetime, float] = {}

    if os.path.exists(wind_path):
        for row in _load_csv_rows(wind_path):
            ts = _parse_datetime(row.get("Datetime", ""))
            value = _safe_float(row.get("Wind_Forecast"))
            if ts and value is not None:
                wind_map[ts] = value
    else:
        warnings.append("风电预测文件不存在，默认使用 0")

    if os.path.exists(pv_path):
        for row in _load_csv_rows(pv_path):
            ts = _parse_datetime(row.get("Datetime", ""))
            value = _safe_float(row.get("PV_Forecast"))
            if ts and value is not None:
                pv_map[ts] = value
    else:
        warnings.append("光伏预测文件不存在，默认使用 0")

    forecast_rows: List[Dict[str, object]] = []
    for row in load_rows:
        ts = _parse_datetime(row.get("Datetime", ""))
        load_value = _safe_float(row.get("Load_Forecast"))
        if ts is None or load_value is None:
            continue
        wind_value = wind_map.get(ts, 0.0)
        pv_value = pv_map.get(ts, 0.0)
        forecast_rows.append(
            {
                "Datetime": ts,
                "Load_Forecast": load_value,
                "Wind_Forecast": wind_value,
                "PV_Forecast": pv_value,
            }
        )

    if not forecast_rows:
        warnings.append("负荷预测数据无法解析为时间序列")

    forecast_rows.sort(key=lambda r: r["Datetime"])
    return forecast_rows, warnings


def _format_float(value: Optional[float], digits: int = 4) -> str:
    if value is None:
        return ""
    return f"{value:.{digits}f}".rstrip("0").rstrip(".")


def _clamp_power(
    desired: float,
    soc: float,
    stats: DecisionStats,
) -> float:
    if desired > 0:
        desired = min(desired, stats.discharge_max)
        desired = min(desired, max(0.0, soc - stats.soc_min))
    else:
        desired = max(desired, -stats.charge_max)
        desired = max(desired, -(stats.soc_max - soc))
    return desired


def _build_decision_rows(
    forecast_rows: List[Dict[str, object]],
    stats: DecisionStats,
    horizon_hours: int,
) -> List[Dict[str, object]]:
    rows: List[Dict[str, object]] = []
    soc = min(max(stats.soc_initial, stats.soc_min), stats.soc_max)
    target_soc = soc

    total_steps = min(horizon_hours, len(forecast_rows))
    for idx in range(total_steps):
        item = forecast_rows[idx]
        load_value = float(item["Load_Forecast"])
        wind_value = float(item["Wind_Forecast"])
        pv_value = float(item["PV_Forecast"])
        net_load = load_value - wind_value - pv_value

        remaining = max(1, total_steps - idx)
        base_power = net_load - stats.net_target
        soc_bias = -(target_soc - soc) / remaining
        desired = base_power + soc_bias
        power = _clamp_power(desired, soc, stats)
        soc = soc - power

        if power > 0.001:
            action = "discharge"
        elif power < -0.001:
            action = "charge"
        else:
            action = "idle"

        rows.append(
            {
                "Datetime": item["Datetime"],
                "Load_Forecast": load_value,
                "Wind_Forecast": wind_value,
                "PV_Forecast": pv_value,
                "Net_Load": net_load,
                "ES_MW_Decision": power,
                "ES_SOC_Decision": soc,
                "Action": action,
            }
        )

    return rows


def _build_csv(rows: List[Dict[str, object]]) -> str:
    headers = [
        "Datetime",
        "Load_Forecast",
        "Wind_Forecast",
        "PV_Forecast",
        "Net_Load",
        "ES_MW_Decision",
        "ES_SOC_Decision",
        "Action",
    ]
    lines = [",".join(headers)]
    for row in rows:
        dt = row["Datetime"]
        if isinstance(dt, datetime):
            dt_text = dt.strftime("%Y-%m-%d %H:%M:%S")
        else:
            dt_text = str(dt)
        lines.append(
            ",".join(
                [
                    dt_text,
                    _format_float(row.get("Load_Forecast")),
                    _format_float(row.get("Wind_Forecast")),
                    _format_float(row.get("PV_Forecast")),
                    _format_float(row.get("Net_Load")),
                    _format_float(row.get("ES_MW_Decision")),
                    _format_float(row.get("ES_SOC_Decision")),
                    str(row.get("Action", "")),
                ]
            )
        )
    return "\n".join(lines)


def build_decision_csvs(
    data_dir: str,
    horizons: Optional[Iterable[int]] = None,
    history_file: str = "VPP一年优化数据.csv",
    load_forecast: str = "output/Load_forecast_24h.csv",
    wind_forecast: str = "output/Wind_forecast_24h.csv",
    pv_forecast: str = "output/PV_forecast_24h.csv",
    output_prefix: str = "output/ES_decision",
) -> DecisionOutput:
    horizons = list(horizons or DEFAULT_HORIZONS)
    if not horizons:
        return DecisionOutput(ok=False, message="horizons 不能为空")

    history_path = os.path.join(data_dir, history_file)
    if not os.path.exists(history_path):
        return DecisionOutput(ok=False, message=f"历史数据不存在: {history_file}")

    try:
        history_rows = _load_csv_rows(history_path)
    except OSError as exc:
        return DecisionOutput(ok=False, message=f"历史数据读取失败: {exc}")

    if not history_rows:
        return DecisionOutput(ok=False, message="历史数据为空")

    stats, warnings = _compute_history_stats(history_rows)

    load_path = os.path.join(data_dir, load_forecast)
    wind_path = os.path.join(data_dir, wind_forecast)
    pv_path = os.path.join(data_dir, pv_forecast)
    forecast_rows, forecast_warnings = _build_forecast_rows(load_path, wind_path, pv_path)
    warnings.extend(forecast_warnings)

    if not forecast_rows:
        return DecisionOutput(ok=False, message="预测数据为空或无法解析", warnings=warnings, stats=stats)

    outputs: Dict[str, str] = {}
    for horizon in horizons:
        if horizon <= 0:
            warnings.append(f"忽略非法时段 {horizon}h")
            continue
        rows = _build_decision_rows(forecast_rows, stats, horizon)
        filename = f"{output_prefix}_{horizon}h_agent.csv"
        outputs[filename] = _build_csv(rows)

    if not outputs:
        return DecisionOutput(ok=False, message="未生成任何决策结果", warnings=warnings, stats=stats)

    return DecisionOutput(ok=True, message="ok", outputs=outputs, warnings=warnings, stats=stats)


def write_decision_csvs(
    data_dir: str,
    horizons: Optional[Iterable[int]] = None,
    history_file: str = "VPP一年优化数据.csv",
    load_forecast: str = "output/Load_forecast_24h.csv",
    wind_forecast: str = "output/Wind_forecast_24h.csv",
    pv_forecast: str = "output/PV_forecast_24h.csv",
    output_prefix: str = "output/ES_decision",
) -> DecisionOutput:
    result = build_decision_csvs(
        data_dir=data_dir,
        horizons=horizons,
        history_file=history_file,
        load_forecast=load_forecast,
        wind_forecast=wind_forecast,
        pv_forecast=pv_forecast,
        output_prefix=output_prefix,
    )
    if not result.ok:
        return result

    saved_outputs: Dict[str, str] = {}
    warnings = list(result.warnings)
    for rel_path, content in result.outputs.items():
        write_result = write_agent_csv(rel_path, content, data_dir)
        if write_result.ok:
            saved_outputs[write_result.filename] = content
        else:
            warnings.append(f"{rel_path} 写入失败: {write_result.message}")

    return DecisionOutput(
        ok=bool(saved_outputs),
        message="ok" if saved_outputs else "写入失败",
        outputs=saved_outputs,
        warnings=warnings,
        stats=result.stats,
    )


if __name__ == "__main__":
    data_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))
    result = write_decision_csvs(data_dir)
    if not result.ok:
        raise SystemExit(result.message)
    print("生成决策文件:", ", ".join(result.outputs.keys()))
