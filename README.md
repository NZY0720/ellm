# VPP 年度数据 Dashboard

本项目是纯前端页面，右侧集成本地 DeepSeek Agent 对话助手。
数据统一放在 `data/` 目录下（含 `VPP一年优化数据.csv` 与 `data/output/` 预测结果）。

## 一键启动

1. 安装依赖（仅 Agent 需要；只看页面可跳过）：

前置要求：
- Windows + PowerShell
- Python（建议 3.9+），并确保有 `py` 启动器（Windows 官方安装包默认带）

推荐使用虚拟环境安装（避免污染全局 Python）：
```bash
py -m venv .venv
.\.venv\Scripts\python -m pip install -U pip
.\.venv\Scripts\python -m pip install flask httpx
```
提示：`serve.cmd`/`serve.ps1` 一键启动时会**优先使用** `.venv\Scripts\python.exe`（如果存在），否则回退到系统的 `py`。

2. 双击运行 `serve.cmd`  
会自动打开浏览器并同时启动本地 Agent。

## 只启动页面（不启用 Agent）

该模式不需要安装 Python 依赖（也不需要配置 Key）。

在运行前执行（CMD）：
```bash
set NO_AGENT=1
```
或（PowerShell）：
```bash
$env:NO_AGENT=1
```
然后双击 `serve.cmd`。

## 手动启动（推荐）

启动页面：
```bash
powershell -ExecutionPolicy Bypass -File .\\serve.ps1 -Port 5173
```

启动 Agent：
```bash
py .\llm\main.py --server --host 127.0.0.1 --port 8000
```

## Key 配置

优先用环境变量 `DEEPSEEK_API_KEY`，否则读取 `llm/key.txt`。

## Agent（DeepSeek 本地助手）功能说明

页面右侧的 **E-Agent** 是一个本地 HTTP 服务（默认 `127.0.0.1:8000`），前端通过它调用 DeepSeek 接口，并在必要时把结果写回 `data/` 目录，形成可视化/分析所需的 CSV 文件。

### 两种模式（对应界面里的“模式”下拉框）

- **Chat 模式**：普通问答，调用 `/chat`，只返回文本，不写文件。
- **Agent 模式**：带“写文件能力”的问答，调用 `/agent`。
  - Agent 会被系统提示严格约束：**只能生成/修改 `data/` 下的 CSV**，允许子目录，且 **文件名必须以 `_agent.csv` 结尾**。
  - 当模型输出包含如下块时，会被自动解析并写入到 `data/`：

````text
```file:output/xxx_agent.csv
CSV内容...
```
````

### 额外能力：决策文件生成（`/decision`）

Agent 服务内置了一个“本地规则决策器”，用于基于历史数据与预测数据生成储能出力/SOC 决策 CSV。

- **默认输入**（均相对于 `data/`）：
  - 历史：`VPP一年优化数据.csv`
  - 预测：`output/Load_forecast_24h.csv`、`output/Wind_forecast_24h.csv`、`output/PV_forecast_24h.csv`
- **默认输出前缀**：`output/ES_decision`
- **输出文件名规则**：会生成 `output/ES_decision_{h}h_agent.csv`（例如 `output/ES_decision_24h_agent.csv`）

### 接口一览（用于联调/二次开发）

- `GET /health`：健康检查，返回 `{ ok: true }`
- `POST /chat`：普通聊天
  - 请求：`{ messages, temperature?, max_tokens? }`
  - 响应：`{ text, raw }`
- `POST /agent`：Agent 聊天（可能写入 `data/**/_agent.csv`）
  - 请求：`{ messages, temperature?, max_tokens? }`
  - 响应：`{ text, raw, saved, filename, error }`
- `POST /decision`：生成决策 CSV
  - 请求示例字段：`{ horizons, history_file, load_forecast, wind_forecast, pv_forecast, output_prefix }`
  - 响应：`{ ok, files, warnings, stats }`

### 常见问题

- **PowerShell 无法激活虚拟环境**：可执行 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 后重试（或直接使用上面 `.\.venv\Scripts\python -m pip ...` 的方式，无需激活）。
- **查看日志**：静态服务器日志在 `serve.log`；Agent 启动日志在 `llm/agent.log`。
