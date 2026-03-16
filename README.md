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

## 实时仿真数据

项目新增了一个实时仿真脚本，可持续生成 **1 分钟粒度、30 天窗口** 的历史数据，并直接写回当前系统正在读取的 `data/虚拟电厂_24h15min_数据.csv`。

- 脚本路径：`scripts/realtime_data_simulator.py`
- 推荐解释器：`predict/env/python.exe`
- 默认行为：
  - 先基于当前历史数据自动生成一份种子文件 `data/output/realtime_sim_seed.csv`
  - 当前 `data/虚拟电厂_24h15min_数据.csv` 只作为**初始模板和格式参考**
  - 每个 tick 默认用 **1 秒模拟前进 1 分钟**
  - 历史窗口默认维持最近 **30 天**
  - 新历史数据会带真实 `Datetime` 列，窗口终点与当前系统时间对齐
  - 每次 tick 都会原子覆盖写回 `data/虚拟电厂_24h15min_数据.csv`
  - 同时刷新 `data/output/realtime_sim_status.json`
  - 默认每隔 **15 个仿真分钟** 调用一次本地 Agent 的 `/predict12h` 和 `/decision12h`，让预测与决策文件同步刷新

### 启动示例

```powershell
cd D:\DeskFiles\LLM_project\frontend
.\predict\env\python.exe .\scripts\realtime_data_simulator.py
```

### 常用参数

- `--tick-seconds 1`：1 秒推进一个 1 分钟步长
- `--ticks 12`：只运行 12 个 tick 后退出，便于测试
- `--backend-sync-every 15`：每 15 个仿真分钟刷新一次预测与决策
- `--no-backend-sync`：只更新历史 CSV，不自动刷新预测和决策
- `--backend-base-url http://127.0.0.1:8000`：指定本地 Agent 地址

### 与前后端联动方式

- 前端除了原有的周期刷新，还会额外轮询 `data/output/realtime_sim_status.json`
- 一旦检测到仿真脚本写入了新 revision，页面会立即刷新历史数据、预测图和决策图
- 后端若处于运行状态，脚本会按 `backend-sync-every` 的节奏自动重新生成预测和决策结果，保证前后端都能跟上新的 1 分钟历史数据

## Agent（DeepSeek 本地助手）功能说明

页面右侧的 **E-Agent** 是一个本地 HTTP 服务（默认 `127.0.0.1:8000`），前端通过它调用 DeepSeek 接口，并在必要时把结果写回 `data/` 目录，形成可视化/分析所需的 CSV 文件。

新版本的助手不再只是聊天框，而是一个内嵌式智能操作员，右侧面板分成 3 个区域：

- **对话区**：正常问答、解释当前页面状态、总结趋势。
- **建议区**：根据当前页面状态主动给出建议，例如“预测缺失”“可以继续生成决策”。
- **任务区**：展示助手计划做什么、正在做什么、结果成功或失败，以及哪些动作需要你确认。

### 两种模式（对应界面里的“模式”下拉框）

- **Chat 模式**：普通问答，调用 `/chat`，只返回文本，不写文件。
- **Agent 模式**：混合型智能助手，调用 `/assist` 先做“规划 + 建议 + 动作决策”，再由前端按自治级别执行工具。
  - 可调用的工具包括：页面摘要、读取 `data/` 文件、运行 12h 预测、生成 12h 决策、写入 `_agent.csv` 文件。
  - 写文件动作默认视为高风险动作，会在界面里进入“待确认”状态。
  - 当执行固定目标写入时，后端会调用 `/agent/write-target`，并要求模型严格输出如下格式：

````text
```file:output/xxx_agent.csv
CSV内容...
```
````

### 自治级别

- **只给建议**：助手只规划和提醒，不自动执行。
- **执行前确认**：助手会先规划，再等待你批准。
- **自动执行安全动作**：安全动作（读取、预测、决策、页面摘要）会自动执行；写文件等高风险动作仍需确认。

### 额外能力：预测与决策文件生成（`/predict12h` / `/decision12h`）

Agent 服务内置了一个“本地规则决策器”，用于基于历史数据与预测数据生成储能出力/SOC 决策 CSV。

- **默认输入**（均相对于 `data/`）：
  - 历史：`虚拟电厂_24h15min_数据.csv`
  - 预测：`output/Load_forecast_12h.csv`、`output/PV_forecast_12h.csv`
- **默认输出文件**：
  - 预测：`output/Load_forecast_12h.csv`、`output/PV_forecast_12h.csv`
  - 决策：`output/Market_decision_12h.csv`
- **当前粒度**：
  - 历史：`1 分钟`
  - 预测：`1 分钟`
  - 决策：`1 分钟`

### 接口一览（用于联调/二次开发）

- `GET /health`：健康检查，返回 `{ ok: true }`
- `GET /assistant/tools`：返回当前工具清单与契约版本
- `POST /chat`：普通聊天
  - 请求：`{ messages, temperature?, max_tokens? }`
  - 响应：`{ text, raw }`
- `POST /assist`：结构化助手规划
  - 请求：`{ messages, user_message, dashboard, attachment_context?, autonomy?, forced_target?, tools? }`
  - 响应：`{ ok, reply, actions, suggestions, approval_required, tool_contract_version }`
- `POST /agent`：Agent 聊天（兼容旧模式，可能写入 `data/**/_agent.csv`）
  - 请求：`{ messages, temperature?, max_tokens? }`
  - 响应：`{ text, raw, saved, filename, error }`
- `POST /agent/write-target`：固定目标文件写入
  - 请求：`{ target_path, prompt, messages?, temperature?, max_tokens? }`
  - 响应：`{ ok, text, saved, filename, error }`
- `POST /predict12h`：生成 12h 预测 CSV
  - 请求示例字段：`{ history_file, window_hours, horizon_hours, step_minutes, lookback?, retrain? }`
- `POST /decision12h`：生成 12h 决策 CSV
  - 请求示例字段：`{ history_file, load_forecast, pv_forecast, output_file, horizon_hours, step_minutes, window_hours, capacity_kwh, p_max_kw }`
  - 响应：`{ ok, files, warnings, stats }`

### 前端自治边界说明

- 助手可以**自动读取当前页面状态**，包括筛选范围、KPI、预测是否就绪、决策是否就绪。
- 助手可以**自动执行安全动作**：读取 `data/` 文件、运行预测、生成决策、生成页面摘要。
- 助手**不能无确认直接写文件**；凡是写入 `_agent.csv` 的操作都必须进入确认流程。
- 所有动作都会在任务区留下状态记录，便于中断和追踪。

### 常见问题

- **当前推荐环境路径**：`predict/env/python.exe`
- **实时仿真脚本**：`scripts/realtime_data_simulator.py`
- **查看日志**：Agent 启动日志在 `llm/agent.log`。
