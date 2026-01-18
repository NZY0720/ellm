import os
import re
import argparse
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import httpx
from flask import Flask, jsonify, request

from function_predict import write_agent_csv
from function_decision import build_decision_csvs


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

    @app.route("/decision", methods=["POST", "OPTIONS"])
    def decision():
        if request.method == "OPTIONS":
            return ("", 204)

        payload = request.get_json(silent=True) or {}
        horizons = payload.get("horizons")
        history_file = payload.get("history_file", "VPP一年优化数据.csv")
        load_forecast = payload.get("load_forecast", "output/Load_forecast_24h.csv")
        wind_forecast = payload.get("wind_forecast", "output/Wind_forecast_24h.csv")
        pv_forecast = payload.get("pv_forecast", "output/PV_forecast_24h.csv")
        output_prefix = payload.get("output_prefix", "output/ES_decision")

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
            return jsonify({"ok": False, "error": result.message, "warnings": result.warnings}), 400

        saved_files = []
        write_warnings = list(result.warnings)
        for rel_path, content in result.outputs.items():
            write_result = write_agent_csv(rel_path, content, data_dir)
            if write_result.ok:
                saved_files.append(write_result.filename)
            else:
                write_warnings.append(f"{rel_path} 写入失败: {write_result.message}")

        return jsonify(
            {
                "ok": bool(saved_files),
                "files": saved_files,
                "warnings": write_warnings,
                "stats": vars(result.stats) if result.stats else {},
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
