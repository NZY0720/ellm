import os
import re
import argparse
import csv
import math
import tempfile
from datetime import datetime, timedelta
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
    tool_manifest = [
        {
            "name": "summarizeCurrentDashboard",
            "label": "总结当前页面",
            "description": "读取当前筛选、KPI 与图表状态，生成页面摘要。",
            "danger": "safe",
            "requiresConfirmation": False,
        },
        {
            "name": "readDataFile",
            "label": "读取数据文件",
            "description": "读取 data/ 下的文本或 CSV 文件内容。",
            "danger": "safe",
            "requiresConfirmation": False,
            "parameters": ["path"],
        },
        {
            "name": "runForecast",
            "label": "运行 12h 预测",
            "description": "生成未来 12 小时的负荷与光伏预测。",
            "danger": "safe",
            "requiresConfirmation": False,
        },
        {
            "name": "runDecision",
            "label": "生成 12h 决策",
            "description": "根据历史数据和预测结果生成市场决策文件。",
            "danger": "guarded",
            "requiresConfirmation": False,
        },
        {
            "name": "writeAgentFile",
            "label": "写入 Agent 文件",
            "description": "让模型将结果写入指定的 _agent.csv 文件。",
            "danger": "high",
            "requiresConfirmation": True,
            "parameters": ["targetPath", "prompt"],
        },
    ]

    @app.after_request
    def add_cors_headers(response):
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS, GET"
        return response

    @app.route("/health", methods=["GET"])
    def health():
        return jsonify({"ok": True})

    @app.route("/assistant/tools", methods=["GET"])
    def assistant_tools():
        return jsonify({"ok": True, "tools": tool_manifest, "version": 1})

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

    def _dashboard_summary_text(dashboard: Optional[Dict[str, Any]]) -> str:
        if not isinstance(dashboard, dict):
            return "当前没有页面摘要。"

        filters = dashboard.get("filters") or {}
        kpis = dashboard.get("kpis") or {}
        forecast = dashboard.get("forecast") or {}
        decision = dashboard.get("decision") or {}

        def _fmt_stat(name: str, payload: Optional[Dict[str, Any]]) -> str:
            if not isinstance(payload, dict):
                return f"{name}: -"
            return (
                f"{name}: 均值 {payload.get('avg', '-')}, "
                f"峰值 {payload.get('max', '-')}"
            )

        parts = [
            f"筛选范围: {filters.get('start', '-')} -> {filters.get('end', '-')}",
            f"当前指标: {filters.get('metricLabel', filters.get('metric', '-'))}",
            _fmt_stat("负荷", kpis.get("load")),
            _fmt_stat("光伏", kpis.get("pv")),
            _fmt_stat("电价", kpis.get("price")),
            f"预测状态: {'已就绪' if forecast.get('ready') else '缺失'}; {forecast.get('hint', '-')}",
            f"决策状态: {'已就绪' if decision.get('ready') else '缺失'}; {decision.get('hint', '-')}",
        ]
        return "\n".join(parts)

    def _match_any(text: str, words: List[str]) -> bool:
        return any(word in text for word in words)

    def _extract_data_path(text: str) -> Optional[str]:
        match = re.search(r"(data/[^\s`'\"，。；]+)", text)
        if not match:
            return None
        return match.group(1).strip()

    def _plan_actions(user_message: str, dashboard: Optional[Dict[str, Any]], forced_target: str) -> Tuple[str, List[Dict[str, Any]], List[Dict[str, Any]]]:
        message = (user_message or "").strip()
        lowered = message.lower()
        actions: List[Dict[str, Any]] = []
        suggestions: List[Dict[str, Any]] = []
        dashboard = dashboard or {}
        forecast_ready = bool((dashboard.get("forecast") or {}).get("ready"))
        decision_ready = bool((dashboard.get("decision") or {}).get("ready"))

        if forced_target:
            actions.append(
                {
                    "tool": "writeAgentFile",
                    "title": "写入 Agent 文件",
                    "detail": f"目标文件：{forced_target}",
                    "args": {
                        "targetPath": forced_target,
                        "prompt": message,
                    },
                    "requiresConfirmation": True,
                }
            )
            return (
                f"我已经按固定目标文件为你规划了写入动作：先让模型生成 CSV 内容，再写入 `{forced_target}`。这一步默认需要确认。",
                actions,
                suggestions,
            )

        path = _extract_data_path(message)
        if path and _match_any(message, ["读取", "read", "查看文件", "加载文件"]):
            actions.append(
                {
                    "tool": "readDataFile",
                    "title": "读取数据文件",
                    "detail": f"读取文件 {path}",
                    "args": {"path": path},
                    "requiresConfirmation": False,
                }
            )

        wants_forecast = _match_any(lowered, ["预测", "forecast", "重跑预测", "运行预测"])
        wants_decision = _match_any(lowered, ["决策", "strategy", "调度", "储能策略"])
        wants_summary = _match_any(lowered, ["总结", "概览", "分析", "建议", "怎么看", "状态"]) and not wants_forecast and not wants_decision

        if wants_decision and not forecast_ready:
            actions.append(
                {
                    "tool": "runForecast",
                    "title": "补齐预测结果",
                    "detail": "当前决策依赖预测结果，先自动生成 12h 预测。",
                    "args": {},
                    "requiresConfirmation": False,
                }
            )

        if wants_forecast and not any(action.get("tool") == "runForecast" for action in actions):
            actions.append(
                {
                    "tool": "runForecast",
                    "title": "运行 12h 预测",
                    "detail": "生成负荷与光伏预测文件。",
                    "args": {},
                    "requiresConfirmation": False,
                }
            )

        if wants_decision:
            actions.append(
                {
                    "tool": "runDecision",
                    "title": "生成 12h 决策",
                    "detail": "基于历史数据和预测结果生成决策文件。",
                    "args": {},
                    "requiresConfirmation": False,
                }
            )

        if wants_summary and not actions:
            actions.append(
                {
                    "tool": "summarizeCurrentDashboard",
                    "title": "总结当前页面",
                    "detail": "读取当前筛选、KPI 和图表状态生成摘要。",
                    "args": {},
                    "requiresConfirmation": False,
                }
            )

        if not forecast_ready:
            suggestions.append(
                {
                    "id": "backend-forecast-missing",
                    "title": "建议先生成预测",
                    "body": "当前还没有可用的 12h 预测结果，后续决策或分析会缺少未来窗口。",
                    "action": {"tool": "runForecast", "args": {}},
                    "severity": "info",
                    "actionLabel": "运行预测",
                }
            )
        elif not decision_ready:
            suggestions.append(
                {
                    "id": "backend-decision-missing",
                    "title": "建议继续生成决策",
                    "body": "预测结果已存在，但决策文件还没有生成，可以继续串联执行下一步。",
                    "action": {"tool": "runDecision", "args": {}},
                    "severity": "info",
                    "actionLabel": "生成决策",
                }
            )

        if actions:
            titles = " -> ".join(action["title"] for action in actions)
            return (
                f"我已经根据你的目标规划了以下动作：{titles}。执行过程会在任务区中持续展示。",
                actions,
                suggestions,
            )

        return ("", [], suggestions)

    def _agent_write_to_target(messages: List[Dict[str, str]], target_path: str, prompt: str, temperature: float, max_tokens: int) -> Dict[str, Any]:
        system_guard = {
            "role": "system",
            "content": (
                "你现在是本地数据助手，只能写入指定目标文件，且目标必须是 data/ 下的 _agent.csv 文件。"
                "你必须严格输出一个文件块，并使用如下格式：\n"
                f"```file:{target_path}\n"
                "CSV内容\n"
                "```\n"
                "除文件块之外，可以附加极简说明。"
            ),
        }

        safe_messages = [msg for msg in messages if isinstance(msg, dict) and msg.get("role") and msg.get("content")]
        if prompt and (not safe_messages or safe_messages[-1].get("content") != prompt):
            safe_messages.append({"role": "user", "content": prompt})

        raw = agent.chat(
            messages=[system_guard, *safe_messages],
            temperature=temperature,
            max_tokens=max_tokens,
        )
        text = raw["choices"][0]["message"]["content"]
        extracted = _extract_file_block(text)
        saved = False
        filename = ""
        error = ""
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
        else:
            error = "未检测到文件块输出"

        return {
            "ok": saved and not error,
            "text": text,
            "raw": raw,
            "saved": saved,
            "filename": filename,
            "error": error,
        }

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

    @app.route("/agent/write-target", methods=["POST", "OPTIONS"])
    def agent_write_target():
        if request.method == "OPTIONS":
            return ("", 204)

        payload = request.get_json(silent=True) or {}
        messages = payload.get("messages") or []
        prompt = str(payload.get("prompt", "") or "").strip()
        target_path = str(payload.get("target_path", "") or "").strip()
        temperature = float(payload.get("temperature", 0.4))
        max_tokens = int(payload.get("max_tokens", 768))

        if not target_path:
            return jsonify({"ok": False, "error": "target_path is required"}), 400

        result = _agent_write_to_target(messages, target_path, prompt, temperature, max_tokens)
        status = 200 if result.get("saved") else 400
        return jsonify(result), status

    @app.route("/assist", methods=["POST", "OPTIONS"])
    def assist():
        if request.method == "OPTIONS":
            return ("", 204)

        payload = request.get_json(silent=True) or {}
        messages = payload.get("messages") or []
        user_message = str(payload.get("user_message", "") or "").strip()
        dashboard = payload.get("dashboard") or {}
        attachment_context = str(payload.get("attachment_context", "") or "").strip()
        forced_target = str(payload.get("forced_target", "") or "").strip()

        reply, actions, suggestions = _plan_actions(user_message, dashboard, forced_target)
        if not reply:
            context_messages: List[Dict[str, str]] = []
            if isinstance(messages, list):
                for item in messages:
                    if isinstance(item, dict) and item.get("role") and item.get("content"):
                        context_messages.append({"role": str(item["role"]), "content": str(item["content"])})
            context_messages.append(
                {
                    "role": "system",
                    "content": (
                        "以下是当前页面摘要，仅供回答时参考：\n"
                        f"{_dashboard_summary_text(dashboard)}"
                    ),
                }
            )
            if attachment_context:
                context_messages.append(
                    {
                        "role": "system",
                        "content": f"以下是用户附加的文件上下文，仅供回答时参考：\n{attachment_context}",
                    }
                )
            if user_message:
                context_messages.append({"role": "user", "content": user_message})

            raw = agent.chat(messages=context_messages, temperature=0.6, max_tokens=512)
            reply = raw["choices"][0]["message"]["content"]

        approval_required = any(bool(action.get("requiresConfirmation")) for action in actions)
        return jsonify(
            {
                "ok": True,
                "reply": reply,
                "actions": actions,
                "suggestions": suggestions,
                "plan_summary": reply,
                "approval_required": approval_required,
                "tool_contract_version": 1,
            }
        )

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

    def _extract_hour_value(row: Dict[str, str]) -> Optional[float]:
        hour = _safe_float(row.get("时间_小时"))
        if hour is not None:
            return hour
        period = _safe_float(row.get("时间_时段"))
        if period is not None:
            return period - 1.0
        return None

    def _parse_row_datetime(row: Dict[str, str]) -> Optional[datetime]:
        text = str(row.get("Datetime", "") or "").strip()
        if not text:
            return None
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M"):
            try:
                return datetime.strptime(text, fmt)
            except ValueError:
                continue
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
        mid = diffs[len(diffs) // 2]
        return max(1, int(round(mid)))

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

        buckets: List[Dict[str, str]] = []
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

            buckets.append(
                {
                    "Datetime": str(last.get("Datetime", "")),
                    "时间_小时": str(last.get("时间_小时", "")),
                    "时间_时段": str(last.get("时间_时段", "")),
                    "光伏出力_kW": _avg("光伏出力_kW"),
                    "负荷消耗_kW": _avg("负荷消耗_kW"),
                    "实时电价_元/kWh": _avg("实时电价_元/kWh"),
                }
            )
        return buckets

    def _read_recent_vpp_rows(history_path: str, limit: int) -> List[Dict[str, str]]:
        with open(history_path, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            rows = [row for row in reader if row]
        return rows[-limit:] if len(rows) > limit else rows

    def _build_hourly_maps(rows: List[Dict[str, str]]) -> Tuple[Dict[float, float], Dict[float, float], List[str]]:
        """Build time-of-day -> value maps from history rows."""
        warnings: List[str] = []
        buckets_load: Dict[float, List[float]] = {}
        buckets_pv: Dict[float, List[float]] = {}

        for r in rows:
            hour = _extract_hour_value(r)
            if hour is None:
                continue
            tod = float(hour) % 24.0

            load = _safe_float(r.get("负荷消耗_kW"))
            pv = _safe_float(r.get("光伏出力_kW"))
            if load is not None:
                buckets_load.setdefault(tod, []).append(load)
            if pv is not None:
                buckets_pv.setdefault(tod, []).append(pv)

        if not buckets_load:
            warnings.append("历史窗口中未解析到 负荷消耗_kW")
        if not buckets_pv:
            warnings.append("历史窗口中未解析到 光伏出力_kW")

        load_map = {k: sum(v) / len(v) for k, v in buckets_load.items() if v}
        pv_map = {k: sum(v) / len(v) for k, v in buckets_pv.items() if v}
        return load_map, pv_map, warnings

    def _needs_baseline_fallback(preds: List[float], history_rows: List[Dict[str, str]], key: str) -> bool:
        history_values = [_safe_float(row.get(key)) for row in history_rows]
        history_clean = [abs(float(v)) for v in history_values if v is not None]
        pred_clean = [abs(float(v)) for v in preds if v is not None]
        if not history_clean or not pred_clean:
            return False
        history_avg = sum(history_clean) / len(history_clean)
        pred_avg = sum(pred_clean) / len(pred_clean)
        if history_avg <= 1e-6:
            return False
        return pred_avg < history_avg * 0.05

    def _nearest_lookup(map_: Dict[float, float], hour: float) -> float:
        if not map_:
            return 0.0
        keys = list(map_.keys())
        nearest = min(keys, key=lambda k: abs(k - hour))
        return float(map_.get(nearest, 0.0))

    def _format_hour(value: float) -> str:
        # Render as H:MM (supports 0..48h+), aligned to minute grid.
        total_minutes = int(round(value * 60.0))
        h = total_minutes // 60
        m = total_minutes % 60
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
        history_path = os.path.join(data_dir, history_file)
        if not os.path.exists(history_path):
            return jsonify({"ok": False, "error": f"history file not found: {history_file}"}), 400

        try:
            raw_history_rows = _read_recent_vpp_rows(history_path, 50000)
            history_step_minutes = _infer_history_step_minutes(raw_history_rows)
            raw_window_rows = int(round(window_hours * 60 / history_step_minutes))
            recent_raw = _read_recent_vpp_rows(history_path, raw_window_rows)
            recent = _resample_history_rows(recent_raw, step_minutes)
        except OSError as exc:
            return jsonify({"ok": False, "error": f"history read failed: {exc}"}), 500

        if not recent:
            return jsonify({"ok": False, "error": "history is empty"}), 400

        last_row = recent[-1]
        last_hour = _extract_hour_value(last_row)
        if last_hour is None:
            return jsonify({"ok": False, "error": "cannot parse last timestamp from history"}), 400

        # LSTM inference (trained model). This does NOT call DeepSeek.
        temp_csv_path = None
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
            with tempfile.NamedTemporaryFile("w", encoding="utf-8-sig", newline="", suffix=".csv", delete=False) as handle:
                writer = csv.DictWriter(
                    handle,
                    fieldnames=["Datetime", "时间_小时", "时间_时段", "光伏出力_kW", "负荷消耗_kW", "实时电价_元/kWh"],
                )
                writer.writeheader()
                writer.writerows(recent)
                temp_csv_path = handle.name
            preds = forecast_recent_window(
                csv_path=temp_csv_path,
                targets=["Load", "PV"],
                window_rows=len(recent),
                steps=steps,
                lookback=lookback,
                retrain=retrain,
            )
        except Exception as exc:
            return jsonify({"ok": False, "error": f"lstm forecast failed: {exc}"}), 500
        finally:
            if temp_csv_path and os.path.exists(temp_csv_path):
                try:
                    os.remove(temp_csv_path)
                except OSError:
                    pass

        step_h = step_minutes / 60.0
        out_load: List[List[object]] = []
        out_pv: List[List[object]] = []
        load_preds = preds.get("Load")
        pv_preds = preds.get("PV")
        if load_preds is None or pv_preds is None:
            return jsonify({"ok": False, "error": "missing Load/PV predictions"}), 500

        if step_minutes == 1:
            recent_load = [_safe_float(row.get("负荷消耗_kW")) or 0.0 for row in recent]
            recent_pv = [_safe_float(row.get("光伏出力_kW")) or 0.0 for row in recent]
            if len(recent_load) < steps:
                reps = int(math.ceil(steps / max(1, len(recent_load))))
                recent_load = (recent_load * reps)[:steps]
                recent_pv = (recent_pv * reps)[:steps]
            load_pred_list = [float(v) for v in recent_load[:steps]]
            pv_pred_list = [float(v) for v in recent_pv[:steps]]
        else:
            load_map, pv_map, _ = _build_hourly_maps(recent)
            load_pred_list = [float(v) for v in load_preds]
            pv_pred_list = [float(v) for v in pv_preds]
            if _needs_baseline_fallback(load_pred_list, recent, "负荷消耗_kW"):
                load_pred_list = [_nearest_lookup(load_map, (last_hour + step_h * i) % 24.0) for i in range(1, steps + 1)]
            if _needs_baseline_fallback(pv_pred_list, recent, "光伏出力_kW"):
                pv_pred_list = [_nearest_lookup(pv_map, (last_hour + step_h * i) % 24.0) for i in range(1, steps + 1)]

        last_dt = _parse_row_datetime(last_row)
        for i in range(1, steps + 1):
            future_hour_abs = last_hour + step_h * i
            future_dt = last_dt + timedelta(minutes=step_minutes * i) if last_dt is not None else None
            load_kw = float(load_pred_list[i - 1])
            pv_kw = float(pv_pred_list[i - 1])
            dt_text = future_dt.strftime("%Y-%m-%d %H:%M:%S") if future_dt is not None else _format_hour(future_hour_abs)
            out_load.append([dt_text, f"{load_kw:.4f}".rstrip("0").rstrip(".")])
            out_pv.append([dt_text, f"{pv_kw:.4f}".rstrip("0").rstrip(".")])

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
                    "history_step_minutes": history_step_minutes,
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
