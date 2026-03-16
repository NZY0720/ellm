# VPP 年度数据 Dashboard

本项目是纯前端页面，右侧集成本地 DeepSeek Agent 对话助手。
数据统一放在 `data/` 目录下（含 `VPP一年优化数据.csv` 与 `data/output/` 预测结果）。

## 一键启动

1. 安装依赖：

前置要求：
- Windows + PowerShell
- Python（建议 3.9+）

当前项目推荐直接使用现有虚拟环境：
`predict/env/python.exe`

启动器会按以下顺序查找 Python：

1. `predict/env/python.exe`
2. `predict/env/Scripts/python.exe`
3. `.venv/Scripts/python.exe`
4. 系统 `py`
5. 系统 `python`

2. 双击运行 `StartFrontendBackend.exe`  
会自动打开浏览器，并同时启动前端静态服务和本地 Agent（后端）。

3. 停止服务：

- 任务栏托盘会出现启动器图标
- 右键选择 `Exit` 即可同时关闭前端服务和本地 Agent

启动器会自动选择可用端口（默认优先 `5173`），并把 Agent 启动日志写入 `llm/agent.log`。

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

- **当前推荐环境路径**：`predict/env/python.exe`
- **查看日志**：Agent 启动日志在 `llm/agent.log`。
