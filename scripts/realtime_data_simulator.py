import argparse
import csv
import json
import math
import random
import shutil
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional
from urllib import error, request


ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_TARGET = ROOT_DIR / "data" / "虚拟电厂_24h15min_数据.csv"
DEFAULT_SEED = ROOT_DIR / "data" / "output" / "realtime_sim_seed.csv"
DEFAULT_STATUS = ROOT_DIR / "data" / "output" / "realtime_sim_status.json"
STEP_MINUTES = 1
STEP_HOURS = STEP_MINUTES / 60.0
DAY_STEPS = 24 * 60
WINDOW_DAYS = 30
WINDOW_STEPS = WINDOW_DAYS * DAY_STEPS


def read_csv_rows(path: Path) -> List[Dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return [dict(row) for row in reader if row]


def write_csv_atomic(path: Path, rows: List[Dict[str, str]], fieldnames: List[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8-sig", newline="", delete=False, dir=str(path.parent)) as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
        temp_path = Path(handle.name)
    temp_path.replace(path)


def write_json_atomic(path: Path, payload: Dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=str(path.parent)) as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        temp_path = Path(handle.name)
    temp_path.replace(path)


def ensure_seed_file(seed_path: Path, target_path: Path) -> None:
    if seed_path.exists():
        return
    seed_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(target_path, seed_path)


def load_status(path: Path) -> Dict[str, object]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def floor_to_minute(dt: datetime) -> datetime:
    return dt.replace(second=0, microsecond=0)


def parse_status_datetime(text: object) -> Optional[datetime]:
    if not text:
        return None
    try:
        return datetime.fromisoformat(str(text))
    except ValueError:
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def format_number(value: float, digits: int) -> str:
    text = f"{value:.{digits}f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def create_time_axis(total_steps: int) -> List[Dict[str, float]]:
    axis = []
    for idx in range(total_steps):
        hour = idx * STEP_HOURS
        axis.append({
            "时间_小时": hour,
            "时间_时段": idx + 1,
        })
    return axis


def _template_point(row: Dict[str, str]) -> Dict[str, float]:
    return {
        "hour": float(row.get("时间_小时", "0") or 0),
        "pv": float(row.get("光伏出力_kW", "0") or 0),
        "load": float(row.get("负荷消耗_kW", "0") or 0),
        "price": float(row.get("实时电价_元/kWh", "0") or 0),
    }


def _interpolate(points: List[Dict[str, float]], hour: float, key: str) -> float:
    if not points:
        return 0.0
    if hour <= points[0]["hour"]:
        return float(points[0][key])
    for idx in range(1, len(points)):
        left = points[idx - 1]
        right = points[idx]
        if hour <= right["hour"]:
            span = right["hour"] - left["hour"]
            if span <= 0:
                return float(right[key])
            ratio = (hour - left["hour"]) / span
            return float(left[key]) + (float(right[key]) - float(left[key])) * ratio
    return float(points[-1][key])


def build_seed_profiles(seed_rows: List[Dict[str, str]]) -> Dict[int, Dict[str, float]]:
    points = sorted((_template_point(row) for row in seed_rows), key=lambda item: item["hour"])
    if len(points) < 2:
        raise ValueError("种子数据至少需要两行有效模板数据")

    if points[0]["hour"] > 0:
        points.insert(0, {**points[0], "hour": 0.0})
    if points[-1]["hour"] < 24.0:
        points.append({**points[-1], "hour": 24.0})

    profiles: Dict[int, Dict[str, float]] = {}
    axis = create_time_axis(DAY_STEPS)
    for idx, point in enumerate(axis):
        hour = float(point["时间_小时"])
        profiles[idx] = {
            "pv": _interpolate(points, hour, "pv"),
            "load": _interpolate(points, hour, "load"),
            "price": _interpolate(points, hour, "price"),
        }
    return profiles


def _slot_noise(sim_step: int, slot: int, salt: int, amplitude: float) -> float:
    rng = random.Random((sim_step + 1) * 100003 + slot * 997 + salt * 131)
    return rng.uniform(-amplitude, amplitude)


def generate_rows(seed_profiles: Dict[int, Dict[str, float]], sim_step: int, end_dt: datetime) -> List[Dict[str, str]]:
    rows: List[Dict[str, str]] = []
    axis = create_time_axis(WINDOW_STEPS)
    window_end_minute = (WINDOW_STEPS - 1) + max(0, sim_step - 1)

    day_index = sim_step / DAY_STEPS
    seasonal_bias = 1.0 + 0.05 * math.sin(day_index * 2 * math.pi / 3.5)
    price_bias = 1.0 + 0.08 * math.sin(day_index * 2 * math.pi / 5.0 + 0.8)
    weather_bias = 0.92 + 0.18 * math.sin(day_index * 2 * math.pi / 2.2 + 1.4)

    for idx, point in enumerate(axis):
        absolute_minute = window_end_minute - (WINDOW_STEPS - 1 - idx)
        source_slot = absolute_minute % DAY_STEPS
        source = seed_profiles[source_slot]
        hour = source_slot / 60.0
        point_dt = end_dt - timedelta(minutes=(WINDOW_STEPS - 1 - idx))
        daytime_curve = max(0.0, math.sin((hour - 6.0) / 12.0 * math.pi))
        peak_curve = math.exp(-((hour - 19.0) ** 2) / 7.0)
        morning_curve = math.exp(-((hour - 9.0) ** 2) / 5.0)

        pv = source["pv"] * weather_bias * (0.85 + 0.22 * daytime_curve)
        pv *= 1.0 - 0.15 * max(0.0, math.sin(sim_step * 0.09 + idx * 0.37))
        pv += _slot_noise(sim_step, idx, 1, 6.0)
        pv = clamp(pv, 0.0, max(source["pv"] * 1.45 + 30.0, 0.0))

        load = source["load"] * seasonal_bias
        load *= 0.95 + 0.12 * peak_curve + 0.05 * morning_curve
        load += 16.0 * math.sin((hour - 4.5) / 24.0 * 2 * math.pi)
        load += _slot_noise(sim_step, idx, 2, 12.0)
        if 17.5 <= hour <= 21.5:
            load += 8.0 + 12.0 * peak_curve
        load = max(load, 20.0)

        price = source["price"] * price_bias
        price += 0.015 * morning_curve + 0.045 * peak_curve
        price += _slot_noise(sim_step, idx, 3, 0.018)
        if 18.0 <= hour <= 20.5:
            price += 0.03
        price = clamp(price, 0.22, 1.35)

        rows.append({
            "Datetime": point_dt.strftime("%Y-%m-%d %H:%M:%S"),
            "时间_小时": format_number(absolute_minute / 60.0, 4),
            "时间_时段": str(int(point["时间_时段"])),
            "光伏出力_kW": format_number(pv, 2),
            "负荷消耗_kW": format_number(load, 2),
            "实时电价_元/kWh": format_number(price, 3),
        })

    return rows


def post_json(url: str, payload: Dict[str, object], timeout_s: float) -> Dict[str, object]:
    data = json.dumps(payload).encode("utf-8")
    req = request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    with request.urlopen(req, timeout=timeout_s) as resp:
        body = resp.read().decode("utf-8")
        return json.loads(body) if body else {}


def sync_backend(base_url: str, timeout_s: float) -> Dict[str, object]:
    result: Dict[str, object] = {
        "predict": {"ok": False, "error": "not-run"},
        "decision": {"ok": False, "error": "not-run"},
    }
    try:
        predict_payload = {
            "history_file": "虚拟电厂_24h15min_数据.csv",
            "window_hours": 24,
            "horizon_hours": 12,
            "step_minutes": 1,
        }
        predict_result = post_json(f"{base_url.rstrip('/')}/predict12h", predict_payload, timeout_s)
        result["predict"] = predict_result
        if not predict_result.get("ok"):
            return result
    except (error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        result["predict"] = {"ok": False, "error": str(exc)}
        return result

    try:
        decision_payload = {
            "history_file": "虚拟电厂_24h15min_数据.csv",
            "load_forecast": "output/Load_forecast_12h.csv",
            "pv_forecast": "output/PV_forecast_12h.csv",
            "output_file": "output/Market_decision_12h.csv",
            "horizon_hours": 12,
            "step_minutes": 1,
            "window_hours": 24,
            "capacity_kwh": 200,
            "p_max_kw": 100,
        }
        result["decision"] = post_json(f"{base_url.rstrip('/')}/decision12h", decision_payload, timeout_s)
    except (error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        result["decision"] = {"ok": False, "error": str(exc)}
    return result


def build_status_payload(sim_step: int, tick_seconds: float, target_file: Path, backend_result: Optional[Dict[str, object]], end_dt: datetime) -> Dict[str, object]:
    window_end_minute = (WINDOW_STEPS - 1) + max(0, sim_step - 1)
    latest_slot = window_end_minute % DAY_STEPS
    return {
        "kind": "realtime-simulator",
        "revision": sim_step,
        "sim_step": sim_step,
        "latest_slot": latest_slot,
        "latest_hour": round(latest_slot * STEP_HOURS, 2),
        "latest_datetime": end_dt.isoformat(),
        "window_days": WINDOW_DAYS,
        "step_minutes": STEP_MINUTES,
        "tick_seconds": tick_seconds,
        "target_file": str(target_file),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "backend_sync": backend_result or {},
    }


def print_tick(sim_step: int, backend_result: Optional[Dict[str, object]]) -> None:
    window_end_minute = (WINDOW_STEPS - 1) + max(0, sim_step - 1)
    latest_slot = window_end_minute % DAY_STEPS
    message = f"[sim] tick={sim_step} minute={latest_slot + 1}/1440 hour={latest_slot * STEP_HOURS:.2f}"
    if backend_result:
        predict_ok = bool((backend_result.get("predict") or {}).get("ok"))
        decision_ok = bool((backend_result.get("decision") or {}).get("ok"))
        message += f" predict={'ok' if predict_ok else 'fail'} decision={'ok' if decision_ok else 'fail'}"
    print(message, flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成滚动的 1 分钟实时仿真数据，并持续写回当前系统数据源。")
    parser.add_argument("--target", default=str(DEFAULT_TARGET), help="实时写入目标 CSV，默认覆盖当前历史数据文件")
    parser.add_argument("--seed", default=str(DEFAULT_SEED), help="基础形态种子文件；若不存在会从 target 首次复制")
    parser.add_argument("--status", default=str(DEFAULT_STATUS), help="状态文件路径，前端会轮询它感知新数据")
    parser.add_argument("--tick-seconds", type=float, default=1.0, help="每个仿真 tick 对应的真实秒数，默认 1 秒表示前进 1 分钟")
    parser.add_argument("--backend-base-url", default="http://127.0.0.1:8000", help="本地 Agent 后端地址")
    parser.add_argument("--backend-timeout", type=float, default=30.0, help="回调后端刷新预测/决策的超时时间")
    parser.add_argument("--backend-sync-every", type=int, default=15, help="每隔多少个仿真分钟同步一次后端预测/决策，默认 15")
    parser.add_argument("--no-backend-sync", action="store_true", help="只更新历史 CSV，不主动触发预测/决策刷新")
    parser.add_argument("--ticks", type=int, default=0, help="运行指定 tick 数后退出；0 表示持续运行")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    target_path = Path(args.target).resolve()
    seed_path = Path(args.seed).resolve()
    status_path = Path(args.status).resolve()

    if not target_path.exists() and not seed_path.exists():
        print(f"目标文件不存在且找不到种子文件: {target_path}", file=sys.stderr)
        return 1
    if not target_path.exists() and seed_path.exists():
        target_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(seed_path, target_path)

    ensure_seed_file(seed_path, target_path)
    seed_rows = read_csv_rows(seed_path)
    seed_profiles = build_seed_profiles(seed_rows)
    fieldnames = ["Datetime", "时间_小时", "时间_时段", "光伏出力_kW", "负荷消耗_kW", "实时电价_元/kWh"]

    status = load_status(status_path)
    sim_step = int(status.get("sim_step", 0) or 0)
    latest_dt = parse_status_datetime(status.get("latest_datetime"))
    current_end_dt = latest_dt or floor_to_minute(datetime.now())
    tick_count = 0

    while True:
        sim_step += 1
        tick_count += 1
        if latest_dt is None and tick_count == 1:
            current_end_dt = floor_to_minute(datetime.now())
        else:
            current_end_dt = current_end_dt + timedelta(minutes=1)
        rows = generate_rows(seed_profiles, sim_step, current_end_dt)
        write_csv_atomic(target_path, rows, fieldnames)

        backend_result = None
        should_sync_backend = (not args.no_backend_sync) and (args.backend_sync_every <= 1 or sim_step % args.backend_sync_every == 0)
        if should_sync_backend:
            backend_result = sync_backend(args.backend_base_url, args.backend_timeout)

        write_json_atomic(
            status_path,
            build_status_payload(sim_step, float(args.tick_seconds), target_path, backend_result, current_end_dt),
        )
        print_tick(sim_step, backend_result)

        if args.ticks and tick_count >= args.ticks:
            break
        time.sleep(max(args.tick_seconds, 0.5))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
