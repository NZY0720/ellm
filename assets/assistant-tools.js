(function initAssistantTools(global) {
  const API_ROOT = 'http://127.0.0.1:8000';
  const MAX_FILE_CHARS = 200000;

  const DEFAULT_TOOL_DEFINITIONS = [
    {
      name: 'summarizeCurrentDashboard',
      label: '总结当前页面',
      description: '读取当前筛选、KPI 与图表状态，生成摘要。',
      danger: 'safe',
      requiresConfirmation: false,
    },
    {
      name: 'readDataFile',
      label: '读取数据文件',
      description: '读取 data/ 下的文本或 CSV 文件内容作为上下文。',
      danger: 'safe',
      requiresConfirmation: false,
      parameters: ['path'],
    },
    {
      name: 'runForecast',
      label: '运行 12h 预测',
      description: '调用本地预测能力，生成未来 12 小时负荷与光伏预测文件。',
      danger: 'safe',
      requiresConfirmation: false,
    },
    {
      name: 'runDecision',
      label: '生成 12h 决策',
      description: '根据历史数据和预测结果生成 12 小时市场决策文件。',
      danger: 'guarded',
      requiresConfirmation: false,
    },
    {
      name: 'writeAgentFile',
      label: '写入 Agent 文件',
      description: '让模型把结果写入指定的 _agent.csv 文件。',
      danger: 'high',
      requiresConfirmation: true,
      parameters: ['targetPath', 'prompt'],
    },
  ];

  function truncateText(text) {
    if (text.length <= MAX_FILE_CHARS) {
      return { text, truncated: false };
    }
    return {
      text: `${text.slice(0, MAX_FILE_CHARS)}\n\n[内容已截断，超过 ${MAX_FILE_CHARS} 字符]`,
      truncated: true,
    };
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload.error || `HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload;
  }

  function formatStatBlock(label, stat) {
    if (!stat) return `${label}: -`;
    return `${label}: 均值 ${stat.avg ?? '-'}，峰值 ${stat.max ?? '-'}`;
  }

  function formatDashboardSummary(snapshot) {
    if (!snapshot) return '当前还没有可用的页面状态。';

    const sections = [];
    if (snapshot.filters) {
      sections.push(
        `筛选范围：${snapshot.filters.start || '-'} 到 ${snapshot.filters.end || '-'}`,
        `当前指标：${snapshot.filters.metricLabel || snapshot.filters.metric || '-'}`,
      );
    }
    if (snapshot.kpis) {
      sections.push(
        formatStatBlock('负荷', snapshot.kpis.load),
        formatStatBlock('光伏', snapshot.kpis.pv),
        formatStatBlock('电价', snapshot.kpis.price),
      );
    }
    if (snapshot.forecast) {
      sections.push(`预测状态：${snapshot.forecast.ready ? '已就绪' : '缺失'}，${snapshot.forecast.hint || '暂无提示'}`);
    }
    if (snapshot.decision) {
      sections.push(`决策状态：${snapshot.decision.ready ? '已就绪' : '缺失'}，${snapshot.decision.hint || '暂无提示'}`);
    }
    return sections.join('\n');
  }

  function createAssistantTools(options = {}) {
    const dashboardProvider = typeof options.dashboardProvider === 'function'
      ? options.dashboardProvider
      : () => null;

    async function fetchToolManifest() {
      try {
        const payload = await requestJson(`${API_ROOT}/assistant/tools`, { cache: 'no-store' });
        return Array.isArray(payload.tools) && payload.tools.length ? payload.tools : DEFAULT_TOOL_DEFINITIONS;
      } catch (error) {
        return DEFAULT_TOOL_DEFINITIONS;
      }
    }

    async function checkHealth() {
      const response = await fetch(`${API_ROOT}/health`, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json();
    }

    async function chat(payload, signal) {
      return requestJson(`${API_ROOT}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
    }

    async function planAssist(payload, signal) {
      return requestJson(`${API_ROOT}/assist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
    }

    async function runForecast(args = {}, signal) {
      return requestJson(`${API_ROOT}/predict12h`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          history_file: '虚拟电厂_24h15min_数据.csv',
          window_hours: 24,
          horizon_hours: 12,
          step_minutes: 1,
          ...args,
        }),
        signal,
      });
    }

    async function runDecision(args = {}, signal) {
      return requestJson(`${API_ROOT}/decision12h`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          history_file: '虚拟电厂_24h15min_数据.csv',
          load_forecast: 'output/Load_forecast_12h.csv',
          pv_forecast: 'output/PV_forecast_12h.csv',
          output_file: 'output/Market_decision_12h.csv',
          horizon_hours: 12,
          step_minutes: 1,
          window_hours: 24,
          capacity_kwh: 200,
          p_max_kw: 100,
          ...args,
        }),
        signal,
      });
    }

    async function readDataFile(args = {}, signal) {
      const normalized = String(args.path || '').replace(/\\/g, '/').trim();
      if (!normalized.startsWith('data/') || normalized.includes('..')) {
        throw new Error('路径必须以 data/ 开头，且不能包含 ..');
      }
      const response = await fetch(encodeURI(`./${normalized}`), {
        cache: 'no-store',
        signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const rawText = await response.text();
      const { text, truncated } = truncateText(rawText);
      return {
        ok: true,
        path: normalized,
        name: normalized.split('/').pop() || normalized,
        size: rawText.length,
        text,
        truncated,
      };
    }

    async function writeAgentFile(args = {}, signal) {
      return requestJson(`${API_ROOT}/agent/write-target`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_path: args.targetPath,
          prompt: args.prompt,
          messages: args.messages || [],
          temperature: args.temperature ?? 0.4,
          max_tokens: args.max_tokens ?? 768,
        }),
        signal,
      });
    }

    async function summarizeCurrentDashboard() {
      const snapshot = dashboardProvider();
      return {
        ok: true,
        snapshot,
        summary: formatDashboardSummary(snapshot),
      };
    }

    async function executeTool(name, args = {}, context = {}, options2 = {}) {
      const signal = options2.signal;
      switch (name) {
        case 'summarizeCurrentDashboard':
          return summarizeCurrentDashboard();
        case 'readDataFile':
          return readDataFile(args, signal);
        case 'runForecast':
          return runForecast(args, signal);
        case 'runDecision':
          return runDecision(args, signal);
        case 'writeAgentFile':
          return writeAgentFile({
            ...args,
            messages: context.messages || [],
          }, signal);
        default:
          throw new Error(`未知工具：${name}`);
      }
    }

    return {
      API_ROOT,
      DEFAULT_TOOL_DEFINITIONS,
      checkHealth,
      chat,
      executeTool,
      fetchToolManifest,
      formatDashboardSummary,
      planAssist,
      summarizeCurrentDashboard,
      truncateText,
    };
  }

  global.AssistantTools = {
    API_ROOT,
    DEFAULT_TOOL_DEFINITIONS,
    MAX_FILE_CHARS,
    createAssistantTools,
  };
})(window);
