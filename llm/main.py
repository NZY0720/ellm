import os
import re
import argparse
import csv
import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import httpx
from flask import Flask, jsonify, request

from function_predict import write_agent_csv, write_data_csv
from function_decision import write_market_decision_12h


@dataclass
class LLMConfig:
    api_key_path: str = field(default="key.txt")
    api_key: str = field(default_factory=lambda: os.getenv("DEEPSEEK_API_KEY", ""))
    base_url: str = field(default="https://api.deepseek.com/v1")
    model: str = field(default="deepseek-chat")
    timeout_s: float = field(default=30.0)


class DeepSeekAgent:
    def __init__(self, config: Optional[LLMConfig] = None) -> None:
        self.config = config or LLMConfig()
        if not self.config.api_key:
            self.config.api_key = self._load_key_from_file(self.config.api_key_path)
        if not self.config.api_key:
            raise ValueError("Missing DEEPSEEK_API_KEY or key file")

    def _load_key_from_file(self, path: str) -> str:
        if not path:
            return ""
        try:
            path_candidates = [path]
            if not os.path.isabs(path):
                here = os.path.dirname(os.path.abspath(__file__))
                path_candidates.append(os.path.join(here, path))

            for candidate in path_candidates:
                try:
                    with open(candidate, "r", encoding="utf-8") as f:
                        return f.read().strip()
                except OSError:
                    continue
        except OSError:
            return ""
        return ""

    def chat(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.7,
        max_tokens: int = 512,
        extra: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "model": self.config.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if extra:
            payload.update(extra)

        headers = {"Authorization": f"Bearer {self.config.api_key}"}
        url = f"{self.config.base_url}/chat/completions"

        with httpx.Client(timeout=self.config.timeout_s) as client:
            resp = client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
            return resp.json()


def create_app(agent: DeepSeekAgent) -> Flask:
    app = Flask(__name__)
    data_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))

    @app.after_request
    def add_cors_headers(response):
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS, GET"
        return response

    @app.route("/health", methods=["GET"])
    def health():
        return jsonify({"ok": True})

    @app.route("/chat", methods=["POST", "OPTIONS"])
    def chat():
        if request.method == "OPTIONS":
            return ("", 204)

        payload = request.get_json(silent=True) or {}
        messages = payload.get("messages") or []
        temperature = float(payload.get("temperature", 0.7))
        max_tokens = int(payload.get("max_tokens", 512))

        if not isinstance(messages, list) or not messages:
            return jsonify({"error": "messages is required"}), 400

        raw = agent.chat(
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        text = raw["choices"][0]["message"]["content"]
        return jsonify({"text": text, "raw": raw})

    def _extract_file_block(text: str) -> Optional[Tuple[str, str, bool]]:
        if not text:
            return None
        m = re.search(r"```file:([^\n]+)\n([\s\S]*?)```", text, re.IGNORECASE)
        if m:
            name = m.group(1).strip()
            content = m.group(2).rstrip("\n")
            return name, content, True
        m2 = re.search(r"```file:([^\n]+)\n([\s\S]*)$", text, re.IGNORECASE)
        if not m2:
            return None
        name = m2.group(1).strip()
        content = m2.group(2).rstrip("\n")
        return name, content, False

    @app.route("/agent", methods=["POST", "OPTIONS"])
    def agent_chat():
        if request.method == "OPTIONS":
            return ("", 204)

        payload = request.get_json(silent=True) or {}
        messages = payload.get("messages") or []
        temperature = float(payload.get("temperature", 0.7))
        max_tokens = int(payload.get("max_tokens", 512))

        if not isinstance(messages, list) or not messages:
            return jsonify({"error": "messages is required"}), 400

        system_guard = {
            "role": "system",
            "content": (
                "你现在是本地数据助手，只能生成/修改 data/ 下的 CSV 文件，"
                "允许子目录，且文件名必须以 _agent.csv 结尾。"
                "当需要写文件时，请用如下格式输出：\n"
                "```file:output/xxx_agent.csv\n"
                "CSV内容\n"
                "```\n"
                "允许输出 data/ 前缀或 data/ 内的相对路径。"
            ),
        }

        raw = agent.chat(
            messages=[system_guard, *messages],
            temperature=temperature,
            max_tokens=max_tokens,
        )
        text = raw["choices"][0]["message"]["content"]

        saved = False
        filename = ""
        error = ""
        extracted = _extract_file_block(text)
        if extracted:
            filename, content, closed = extracted
            result = write_agent_csv(filename, content, data_dir)
            if result.ok:
                saved = True
                filename = result.filename
            else:
                error = result.message
            if not closed and not error:
                error = "file block was not closed; saved anyway"

        return jsonify({"text": text, "raw": raw, "saved": saved, "filename": filename, "error": error})

    @app.route("/decision12h", methods=["POST", "OPTIONS"])
    def decision12h():
        if request.method == "OPTIONS":
            return ("", 204)

        payload = request.get_json(silent=True) or {}
        history_file = payload.get("history_file", "虚拟电厂_24h15min_数据.csv")
        load_forecast = payload.get("load_forecast", "output/Load_forecast_12h.csv")
        pv_forecast = payload.get("pv_forecast", "output/PV_forecast_12h.csv")
        output_file = payload.get("output_file", "output/Market_decision_12h.csv")

        capacity_kwh = float(payload.get("capacity_kwh", 200.0))
        soc_initial_kwh = payload.get("soc_initial_kwh")
        soc_final_kwh = payload.get("soc_final_kwh")
        p_max_kw = float(payload.get("p_max_kw", 100.0))

        horizon_hours = float(payload.get("horizon_hours", 12.0))
        step_minutes = int(payload.get("step_minutes", 15))
        window_hours = float(payload.get("window_hours", 24.0))

        result = write_market_decision_12h(
            data_dir=data_dir,
            history_file=history_file,
            load_forecast_file=load_forecast,
            pv_forecast_file=pv_forecast,
            output_file=output_file,
            horizon_hours=horizon_hours,
            step_minutes=step_minutes,
            window_hours=window_hours,
            capacity_kwh=capacity_kwh,
            soc_initial_kwh=float(soc_initial_kwh) if soc_initial_kwh is not None else None,
            soc_final_kwh=float(soc_final_kwh) if soc_final_kwh is not None else None,
            p_max_kw=p_max_kw,
        )

        if not result.ok:
            return jsonify({"ok": False, "error": result.message, "warnings": result.warnings}), 400

        return jsonify(
            {
                "ok": True,
                "files": [result.filename] if result.filename else [],
                "warnings": result.warnings,
                "stats": vars(result.stats) if result.stats else {},
            }
        )

    def _safe_float(value: object) -> Optional[float]:
        try:
            if value is None:
                return None
            return float(value)
        except (TypeError, ValueError):
            return None

    def _read_recent_vpp_rows(history_path: str, limit: int) -> List[Dict[str, str]]:
        with open(history_path, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            rows = [row for row in reader if row]
        return rows[-limit:] if len(rows) > limit else rows

    def _build_hourly_maps(rows: List[Dict[str, str]]) -> Tuple[Dict[float, float], Dict[float, float], List[str]]:
        """
        Build time-of-day -> value maps from the recent 24h window.
        Input uses 15min resolution: 时间_小时 (0..23.75) or 时间_时段 (1..96).
        Returns load_map_kW, pv_map_kW.
        """
        warnings: List[str] = []
        buckets_load: Dict[float, List[float]] = {}
        buckets_pv: Dict[float, List[float]] = {}

        for r in rows:
            hour = _safe_float(r.get("时间_小时"))
            if hour is None:
                period = _safe_float(r.get("时间_时段"))
                if period is not None:
                    hour = (period - 1.0) * 0.25
            if hour is None:
                continue

            load = _safe_float(r.get("负荷消耗_kW"))
            pv = _safe_float(r.get("光伏出力_kW"))
            if load is not None:
                buckets_load.setdefault(hour, []).append(load)
            if pv is not None:
                buckets_pv.setdefault(hour, []).append(pv)

        if not buckets_load:
            warnings.append("历史窗口中未解析到 负荷消耗_kW")
        if not buckets_pv:
            warnings.append("历史窗口中未解析到 光伏出力_kW")

        load_map = {k: sum(v) / len(v) for k, v in buckets_load.items() if v}
        pv_map = {k: sum(v) / len(v) for k, v in buckets_pv.items() if v}
        return load_map, pv_map, warnings

    def _nearest_lookup(map_: Dict[float, float], hour: float) -> float:
        if not map_:
            return 0.0
        keys = list(map_.keys())
        nearest = min(keys, key=lambda k: abs(k - hour))
        return float(map_.get(nearest, 0.0))

    def _format_hour(value: float) -> str:
        # Render as H:MM (supports 0..48h+), aligned to 15min grid.
        snapped = round(value * 4.0) / 4.0
        h = int(math.floor(snapped + 1e-9))
        m = int(round((snapped - h) * 60))
        if m >= 60:
            h += 1
            m -= 60
        if m < 0:
            m = 0
        return f"{h}:{m:02d}"

    def _build_forecast_csv(headers: List[str], rows: List[List[object]]) -> str:
        lines = [",".join(headers)]
        for r in rows:
            lines.append(",".join("" if v is None else str(v) for v in r))
        return "\n".join(lines)

    @app.route("/predict12h", methods=["POST", "OPTIONS"])
    def predict12h():
        if request.method == "OPTIONS":
            return ("", 204)

        payload = request.get_json(silent=True) or {}
        history_file = payload.get("history_file", "虚拟电厂_24h15min_数据.csv")
        horizon_hours = float(payload.get("horizon_hours", 12))
        step_minutes = int(payload.get("step_minutes", 15))
        window_hours = float(payload.get("window_hours", 24))

        if horizon_hours <= 0:
            return jsonify({"ok": False, "error": "horizon_hours must be > 0"}), 400
        if step_minutes <= 0 or 60 % step_minutes != 0:
            return jsonify({"ok": False, "error": "step_minutes must divide 60 (e.g., 15)"}), 400

        steps = int(round(horizon_hours * 60 / step_minutes))
        window_rows = int(round(window_hours * 60 / step_minutes))

        history_path = os.path.join(data_dir, history_file)
        if not os.path.exists(history_path):
            return jsonify({"ok": False, "error": f"history file not found: {history_file}"}), 400

        try:
            recent = _read_recent_vpp_rows(history_path, window_rows)
        except OSError as exc:
            return jsonify({"ok": False, "error": f"history read failed: {exc}"}), 500

        if not recent:
            return jsonify({"ok": False, "error": "history is empty"}), 400

        last_row = recent[-1]
        last_hour = _safe_float(last_row.get("时间_小时"))
        if last_hour is None:
            period = _safe_float(last_row.get("时间_时段"))
            if period is not None:
                last_hour = (period - 1.0) * 0.25
        if last_hour is None:
            return jsonify({"ok": False, "error": "cannot parse last timestamp from history"}), 400

        # LSTM inference (trained model). This does NOT call DeepSeek.
        try:
            import sys
            from pathlib import Path

            root_dir = Path(__file__).resolve().parents[1]
            if str(root_dir) not in sys.path:
                sys.path.insert(0, str(root_dir))
            from predict.lstm import forecast_recent_window  # type: ignore
        except Exception as exc:
            return jsonify(
                {
                    "ok": False,
                    "error": f"cannot import LSTM predictor: {exc}",
                    "hint": "请在本机安装 torch / scikit-learn / joblib，并确保 predict/lstm.py 可导入",
                }
            ), 500

        lookback = int(payload.get("lookback", 32))
        retrain = bool(payload.get("retrain", False))
        try:
            preds = forecast_recent_window(
                csv_path=history_path,
                targets=["Load", "PV"],
                window_rows=window_rows,
                steps=steps,
                lookback=lookback,
                retrain=retrain,
            )
        except Exception as exc:
            return jsonify({"ok": False, "error": f"lstm forecast failed: {exc}"}), 500

        step_h = step_minutes / 60.0
        out_load: List[List[object]] = []
        out_pv: List[List[object]] = []
        load_preds = preds.get("Load")
        pv_preds = preds.get("PV")
        if load_preds is None or pv_preds is None:
            return jsonify({"ok": False, "error": "missing Load/PV predictions"}), 500

        for i in range(1, steps + 1):
            future_hour_abs = last_hour + step_h * i
            load_kw = float(load_preds[i - 1])
            pv_kw = float(pv_preds[i - 1])
            out_load.append([_format_hour(future_hour_abs), f"{load_kw:.4f}".rstrip("0").rstrip(".")])
            out_pv.append([_format_hour(future_hour_abs), f"{pv_kw:.4f}".rstrip("0").rstrip(".")])

        load_csv_text = _build_forecast_csv(["Datetime", "Load_Forecast"], out_load)
        pv_csv_text = _build_forecast_csv(["Datetime", "PV_Forecast"], out_pv)

        saved_files: List[str] = []
        write_errors: List[str] = []

        for rel_path, content in [
            ("output/Load_forecast_12h.csv", load_csv_text),
            ("output/PV_forecast_12h.csv", pv_csv_text),
        ]:
            wr = write_data_csv(rel_path, content, data_dir)
            if wr.ok:
                saved_files.append(wr.filename)
            else:
                write_errors.append(f"{rel_path}: {wr.message}")

        ok = bool(saved_files) and not write_errors
        return jsonify(
            {
                "ok": ok,
                "files": saved_files,
                "warnings": write_errors,
                "stats": {
                    "history_file": history_file,
                    "window_rows": len(recent),
                    "horizon_hours": horizon_hours,
                    "step_minutes": step_minutes,
                    "steps": steps,
                    "last_hour": last_hour,
                    "model": "lstm",
                    "lookback": lookback,
                    "retrain": retrain,
                },
            }
        )

    return app


def run_server(host: str, port: int) -> None:
    agent = DeepSeekAgent()
    app = create_app(agent)
    app.run(host=host, port=port)


def run_demo() -> None:
    agent = DeepSeekAgent()
    messages = [
        {"role": "system", "content": "你是一个简洁的助手。"},
        {"role": "user", "content": "用一句话介绍深度学习。"},
    ]
    data = agent.chat(messages)
    print(data["choices"][0]["message"]["content"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", action="store_true", help="run as HTTP server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    if args.server:
        run_server(args.host, args.port)
    else:
        run_demo()
