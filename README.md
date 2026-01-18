# VPP 年度数据 Dashboard

本项目是纯前端页面，右侧集成本地 DeepSeek Agent 对话助手。
数据统一放在 `data/` 目录下（含 `VPP一年优化数据.csv` 与 `data/output/` 预测结果）。

## 一键启动（推荐）

1. 安装依赖：
```bash
py -m pip install httpx flask
```

2. 双击运行 `serve.cmd`  
会自动打开浏览器并同时启动本地 Agent。

## 只启动页面（不启用 Agent）

在运行前执行：
```bash
set NO_AGENT=1
```
然后双击 `serve.cmd`。

## 手动启动（可选）

启动页面：
```bash
powershell -ExecutionPolicy Bypass -File .\\serve.ps1 -Port 5173
```

启动 Agent：
```bash
python .\llm\main.py --server --host 127.0.0.1 --port 8000
```

## Key 配置

优先用环境变量 `DEEPSEEK_API_KEY`，否则读取 `llm/key.txt`。
