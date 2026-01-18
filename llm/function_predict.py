import os
import re
from dataclasses import dataclass


@dataclass
class AgentFileResult:
    ok: bool
    message: str
    filename: str = ""
    path: str = ""


def _is_agent_csv(name: str) -> bool:
    if not name:
        return False
    lowered = name.lower()
    return lowered.endswith("_agent.csv") or lowered.endswith("agent.csv")


def write_agent_csv(rel_path: str, content: str, data_dir: str) -> AgentFileResult:
    if not rel_path or not content:
        return AgentFileResult(ok=False, message="filename/content is required")
    if not data_dir:
        return AgentFileResult(ok=False, message="data_dir is required")

    normalized = rel_path.replace("\\", "/").strip()
    if normalized.startswith("/") or re.match(r"^[a-zA-Z]:", normalized):
        return AgentFileResult(ok=False, message="absolute path is not allowed")
    if ".." in normalized:
        return AgentFileResult(ok=False, message="invalid path")
    if normalized.lower().startswith("data/"):
        normalized = normalized[5:]
        if not normalized:
            return AgentFileResult(ok=False, message="invalid path")
    if not normalized.lower().endswith(".csv"):
        return AgentFileResult(ok=False, message="only .csv is allowed")
    if not _is_agent_csv(os.path.basename(normalized)):
        return AgentFileResult(ok=False, message="filename must end with _agent.csv")

    data_dir_abs = os.path.abspath(data_dir)
    if not os.path.isdir(data_dir_abs):
        return AgentFileResult(ok=False, message="data directory does not exist")

    target = os.path.abspath(os.path.join(data_dir_abs, normalized))
    if os.path.commonpath([data_dir_abs, target]) != data_dir_abs:
        return AgentFileResult(ok=False, message="invalid target path")

    os.makedirs(os.path.dirname(target), exist_ok=True)
    try:
        with open(target, "w", encoding="utf-8") as f:
            f.write(content)
    except OSError as exc:
        return AgentFileResult(ok=False, message=f"write failed: {exc}")

    return AgentFileResult(ok=True, message="ok", filename=normalized, path=target)