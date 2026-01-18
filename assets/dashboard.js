/* global Papa, echarts */

const DATA_ROOT = 'data';
const CSV_FILE = `${DATA_ROOT}/VPP一年优化数据.csv`;
const REFRESH_MS = 60 * 1000;

const METRICS = [
  { key: 'Load_MW', label: '负荷 Load_MW' },
  { key: 'Wind_MW', label: '风电 Wind_MW' },
  { key: 'PV_MW', label: '光伏 PV_MW' },
  { key: 'Gas_MW_Optimized', label: '燃气 Gas_MW_Optimized' },
  { key: 'ES_MW_Optimized', label: '储能功率 ES_MW_Optimized（放电为正/充电为负）' },
  { key: 'ES_SOC_Optimized', label: '储能 SOC ES_SOC_Optimized' },
];

const FORECAST_TYPES = [
  {
    key: 'load',
    label: '负荷',
    file: `${DATA_ROOT}/output/Load_forecast_24h.csv`,
    agentFile: `${DATA_ROOT}/output/Load_forecast_24h_agent.csv`,
    valueKey: 'Load_Forecast',
    color: '#5b8cff',
    agentColor: '#9bb7ff',
  },
  {
    key: 'wind',
    label: '风电',
    file: `${DATA_ROOT}/output/Wind_forecast_24h.csv`,
    agentFile: `${DATA_ROOT}/output/Wind_forecast_24h_agent.csv`,
    valueKey: 'Wind_Forecast',
    color: '#3ddc97',
    agentColor: '#7be9bf',
  },
  {
    key: 'pv',
    label: '光伏',
    file: `${DATA_ROOT}/output/PV_forecast_24h.csv`,
    agentFile: `${DATA_ROOT}/output/PV_forecast_24h_agent.csv`,
    valueKey: 'PV_Forecast',
    color: '#ffcc66',
    agentColor: '#ffe19b',
  },
];

const ASSISTANT_API = 'http://127.0.0.1:8000/chat';
const ASSISTANT_AGENT = 'http://127.0.0.1:8000/agent';
const ASSISTANT_HEALTH = 'http://127.0.0.1:8000/health';
const MAX_FILE_CHARS = 200000;
const STORAGE_PLAN_CANDIDATES = [
  'output/ES_decision_24h_agent.csv',
  'output/ES_decision_12h_agent.csv',
  'output/ES_decision_6h_agent.csv',
  'output/ES_decision_1h_agent.csv',
].map((name) => `${DATA_ROOT}/${name}`);
const AGENT_TARGETS = [
  { value: 'VPP一年优化数据_agent.csv', label: 'data/VPP一年优化数据_agent.csv' },
  { value: 'output/Load_forecast_24h_agent.csv', label: 'data/output/Load_forecast_24h_agent.csv' },
  { value: 'output/PV_forecast_24h_agent.csv', label: 'data/output/PV_forecast_24h_agent.csv' },
  { value: 'output/Wind_forecast_24h_agent.csv', label: 'data/output/Wind_forecast_24h_agent.csv' },
  { value: 'output/ES_decision_1h_agent.csv', label: 'data/output/ES_decision_1h_agent.csv' },
  { value: 'output/ES_decision_6h_agent.csv', label: 'data/output/ES_decision_6h_agent.csv' },
  { value: 'output/ES_decision_12h_agent.csv', label: 'data/output/ES_decision_12h_agent.csv' },
  { value: 'output/ES_decision_24h_agent.csv', label: 'data/output/ES_decision_24h_agent.csv' },
];

function $(id) {
  return document.getElementById(id);
}

function setLastUpdated(ts = new Date()) {
  const el = $('last-updated');
  if (!el) return;
  const pad = (n) => String(n).padStart(2, '0');
  const s = `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`;
  el.textContent = s;
}

function fmt(num, digits = 2) {
  if (num == null || Number.isNaN(num)) return '-';
  return Number(num).toFixed(digits);
}

function stat(arr) {
  const xs = arr.filter((v) => Number.isFinite(v));
  if (xs.length === 0) return { min: NaN, max: NaN, avg: NaN };
  let min = xs[0], max = xs[0], sum = 0;
  for (const v of xs) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, avg: sum / xs.length };
}

function buildCsv(rows, columns) {
  const header = columns.join(',');
  const lines = rows.map((r) =>
    columns.map((c) => {
      const v = r[c];
      if (v == null) return '';
      const s = String(v);
      // 简单转义：含逗号/引号/换行时用双引号包裹并转义
      if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    }).join(',')
  );
  return [header, ...lines].join('\n');
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function parseDatetime(text) {
  if (!text) return NaN;
  const s = String(text).trim();
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return NaN;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] ?? 0);
  if ([year, month, day, hour, minute, second].some((v) => !Number.isFinite(v))) return NaN;
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

function formatDatetime(dt) {
  const d = dt instanceof Date ? dt : new Date(dt);
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${pad2(d.getMinutes())}`;
}

function guessTimeRange(rows) {
  let minMs = Infinity;
  let maxMs = -Infinity;
  let minLabel = '';
  let maxLabel = '';
  for (const r of rows) {
    const ts = Number(r._ts);
    if (!Number.isFinite(ts)) continue;
    if (ts < minMs) {
      minMs = ts;
      minLabel = r.Datetime;
    }
    if (ts > maxMs) {
      maxMs = ts;
      maxLabel = r.Datetime;
    }
  }
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) {
    return { minMs: 0, maxMs: 0, minLabel: '', maxLabel: '' };
  }
  return {
    minMs,
    maxMs,
    minLabel: minLabel || formatDatetime(minMs),
    maxLabel: maxLabel || formatDatetime(maxMs),
  };
}

function recentWindowRange(rows, hours = 24) {
  const base = guessTimeRange(rows);
  if (!Number.isFinite(base.maxMs)) return base;
  const startMs = base.maxMs - hours * 60 * 60 * 1000;
  return {
    minMs: startMs,
    maxMs: base.maxMs,
    minLabel: formatDatetime(startMs),
    maxLabel: base.maxLabel || formatDatetime(base.maxMs),
  };
}

function pickRowsByTime(rows, start, end) {
  const s = parseDatetime(start);
  const e = parseDatetime(end);
  const okStart = Number.isFinite(s) ? s : -Infinity;
  const okEnd = Number.isFinite(e) ? e : Infinity;
  return rows.filter((r) => {
    const t = Number(r._ts);
    if (!Number.isFinite(t)) return false;
    return t >= okStart && t <= okEnd;
  });
}

function pickRowsByMs(rows, minMs, maxMs) {
  return rows.filter((r) => {
    const t = Number(r._ts);
    if (!Number.isFinite(t)) return false;
    return t >= minMs && t <= maxMs;
  });
}

function buildTable(tableEl, columns, rows, limit = 200) {
  const head = `
    <thead>
      <tr>${columns.map((c) => `<th>${c}</th>`).join('')}</tr>
    </thead>
  `;
  const bodyRows = rows.slice(0, limit).map((r) => {
    return `<tr>${columns.map((c) => `<td>${r[c] ?? ''}</td>`).join('')}</tr>`;
  }).join('');
  const body = `<tbody>${bodyRows}</tbody>`;
  tableEl.innerHTML = head + body;
}

function baseChartOption(title, x) {
  return {
    backgroundColor: 'transparent',
    animation: false,
    title: { text: title, left: 8, top: 6, textStyle: { color: 'rgba(255,255,255,0.78)', fontSize: 12 } },
    grid: { left: 48, right: 18, top: 42, bottom: 44 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
    xAxis: {
      type: 'category',
      data: x,
      axisLabel: { color: 'rgba(255,255,255,0.62)' },
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.22)' } },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: 'rgba(255,255,255,0.62)' },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.10)' } },
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.22)' } },
    },
    legend: {
      top: 8,
      right: 10,
      textStyle: { color: 'rgba(255,255,255,0.72)' },
    },
    dataZoom: [
      { type: 'inside', throttle: 40 },
      { type: 'slider', height: 18, bottom: 12, borderColor: 'rgba(255,255,255,0.12)', textStyle: { color: 'rgba(255,255,255,0.6)' } },
    ],
  };
}

function downsampleCategory(x, seriesArr, maxPoints = 2000) {
  if (x.length <= maxPoints) return { x, seriesArr };
  const step = Math.ceil(x.length / maxPoints);
  const x2 = [];
  const s2 = seriesArr.map(() => []);
  for (let i = 0; i < x.length; i += step) {
    x2.push(x[i]);
    for (let j = 0; j < seriesArr.length; j++) {
      s2[j].push(seriesArr[j][i]);
    }
  }
  return { x: x2, seriesArr: s2 };
}

async function loadCsv(file = CSV_FILE) {
  const url = encodeURI(`./${file}`);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`读取 CSV 失败：${res.status} ${res.statusText}`);
  const text = await res.text();
  const parsed = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
  });
  if (parsed.errors?.length) {
    // 不直接 throw，仍尝试渲染；但在控制台给出提示
    console.warn('CSV 解析警告：', parsed.errors);
  }
  return parsed.data;
}

async function loadCsvOptional(file) {
  try {
    return await loadCsv(file);
  } catch (e) {
    return null;
  }
}

async function resolveLatestStoragePlan() {
  const loaded = await Promise.all(STORAGE_PLAN_CANDIDATES.map(async (file) => {
    const rows = await loadCsvOptional(file);
    if (!rows) return { file, rows: [], maxTs: -Infinity };
    const maxTs = rows.reduce((acc, r) => {
      const t = parseDatetime(r.Datetime);
      return Number.isFinite(t) ? Math.max(acc, t) : acc;
    }, -Infinity);
    return { file, rows, maxTs };
  }));
  const valid = loaded.filter((item) => item.maxTs > -Infinity);
  if (!valid.length) return { file: '', rows: [] };
  const picked = valid.sort((a, b) => b.maxTs - a.maxTs)[0];
  return { file: picked.file, rows: picked.rows };
}

function initMetricSelect(selectEl) {
  selectEl.innerHTML = METRICS.map((m) => `<option value="${m.key}">${m.label}</option>`).join('');
  selectEl.value = 'Load_MW';
}

function initForecastSelect(selectEl) {
  selectEl.innerHTML = FORECAST_TYPES.map((m) => `<option value="${m.key}">${m.label}</option>`).join('');
  selectEl.value = 'load';
}

function getForecastConfig(key) {
  return FORECAST_TYPES.find((m) => m.key === key) ?? FORECAST_TYPES[0];
}

function setKpis(rows) {
  $('kpi-rows').textContent = `${rows.length}`;
  const load = stat(rows.map((r) => Number(r.Load_MW)));
  const wind = stat(rows.map((r) => Number(r.Wind_MW)));
  const pv = stat(rows.map((r) => Number(r.PV_MW)));
  const gas = stat(rows.map((r) => Number(r.Gas_MW_Optimized)));
  const soc = stat(rows.map((r) => Number(r.ES_SOC_Optimized)));

  $('kpi-load').textContent = `${fmt(load.avg)} / ${fmt(load.max)}`;
  $('kpi-wind').textContent = `${fmt(wind.avg)} / ${fmt(wind.max)}`;
  $('kpi-pv').textContent = `${fmt(pv.avg)} / ${fmt(pv.max)}`;
  $('kpi-gas').textContent = `${fmt(gas.avg)} / ${fmt(gas.max)}`;
  $('kpi-soc').textContent = `${fmt(soc.min)} / ${fmt(soc.max)}`;
}

function buildX(rows) {
  return rows.map((r) => String(r.Datetime));
}

function renderMainChart(chart, rows, metricKey) {
  const metricLabel = (METRICS.find((m) => m.key === metricKey)?.label) ?? metricKey;
  const x = buildX(rows);
  const y = rows.map((r) => Number(r[metricKey]));
  const { x: x2, seriesArr: [y2] } = downsampleCategory(x, [y], 2500);

  const opt = baseChartOption(metricLabel, x2);
  opt.series = [
    {
      name: metricKey,
      type: 'line',
      showSymbol: false,
      data: y2,
      lineStyle: { width: 2, color: '#5b8cff' },
      areaStyle: { opacity: 0.10, color: '#5b8cff' },
      emphasis: { focus: 'series' },
    },
  ];
  chart.setOption(opt, true);
}

function renderMixChart(chart, rows) {
  const x = buildX(rows);
  const wind = rows.map((r) => Number(r.Wind_MW));
  const pv = rows.map((r) => Number(r.PV_MW));
  const gas = rows.map((r) => Number(r.Gas_MW_Optimized));
  const es = rows.map((r) => Number(r.ES_MW_Optimized));
  const load = rows.map((r) => Number(r.Load_MW));

  const { x: x2, seriesArr: [wind2, pv2, gas2, es2, load2] } = downsampleCategory(x, [wind, pv, gas, es, load], 2500);
  const opt = baseChartOption('出力与储能功率（MW）', x2);
  opt.yAxis = [
    opt.yAxis,
    {
      type: 'value',
      axisLabel: { color: 'rgba(255,255,255,0.62)' },
      splitLine: { show: false },
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.22)' } },
    },
  ];

  opt.series = [
    { name: 'Wind_MW', type: 'line', showSymbol: false, data: wind2, lineStyle: { width: 1.8, color: '#3ddc97' } },
    { name: 'PV_MW', type: 'line', showSymbol: false, data: pv2, lineStyle: { width: 1.8, color: '#ffcc66' } },
    { name: 'Gas_MW', type: 'line', showSymbol: false, data: gas2, lineStyle: { width: 1.8, color: '#ff6b6b' } },
    {
      name: 'ES_MW',
      type: 'line',
      showSymbol: false,
      data: es2,
      lineStyle: { width: 1.8, color: '#9b7bff' },
      markLine: {
        silent: true,
        symbol: ['none', 'none'],
        lineStyle: { color: 'rgba(255,255,255,0.25)' },
        data: [{ yAxis: 0 }],
      },
    },
    {
      name: 'Load_MW',
      type: 'line',
      yAxisIndex: 1,
      showSymbol: false,
      data: load2,
      lineStyle: { width: 2.2, color: '#5b8cff' },
      emphasis: { focus: 'series' },
    },
  ];

  chart.setOption(opt, true);
}

function renderSocChart(chart, actualRows, planRows) {
  const actualSorted = [...actualRows].sort((a, b) => a._ts - b._ts);
  const planSorted = [...planRows].sort((a, b) => a._ts - b._ts);
  const lastActualTs = actualSorted.length ? actualSorted[actualSorted.length - 1]._ts : -Infinity;
  const futurePlan = planSorted.filter((r) => r._ts > lastActualTs);

  const combined = [];
  for (const r of actualSorted) {
    combined.push({
      label: String(r.Datetime),
      actual: Number(r.ES_SOC_Optimized),
      plan: null,
    });
  }
  for (const r of futurePlan) {
    combined.push({
      label: String(r.Datetime),
      actual: null,
      plan: Number(r.SOC),
    });
  }

  const x = combined.map((r) => r.label);
  const actual = combined.map((r) => (Number.isFinite(r.actual) ? r.actual : null));
  const plan = combined.map((r) => (Number.isFinite(r.plan) ? r.plan : null));
  const { x: x2, seriesArr: [actual2, plan2] } = downsampleCategory(x, [actual, plan], 2500);

  const opt = baseChartOption('储能规划 SOC（MWh）', x2);
  opt.series = [
    {
      name: '历史 SOC（近24h）',
      type: 'line',
      showSymbol: false,
      data: actual2,
      lineStyle: { width: 2, color: '#ffcc66' },
      areaStyle: { opacity: 0.08, color: '#ffcc66' },
    },
    {
      name: '规划 SOC',
      type: 'line',
      showSymbol: false,
      data: plan2,
      lineStyle: { width: 2, color: '#5b8cff' },
      areaStyle: { opacity: 0.10, color: '#5b8cff' },
      emphasis: { focus: 'series' },
    },
  ];
  chart.setOption(opt, true);
}

function normalizeForecast(rawRows, valueKey) {
  return rawRows.map((r) => ({
    Datetime: r.Datetime,
    _ts: parseDatetime(r.Datetime),
    value: Number(r[valueKey]),
  })).filter((r) => Number.isFinite(r._ts));
}

function renderForecastChart(chart, rows, agentRows, config) {
  const x = rows.map((r) => String(r.Datetime));
  const y = rows.map((r) => (Number.isFinite(r.value) ? r.value : null));
  const agentMap = new Map((agentRows || []).map((r) => [String(r.Datetime), r.value]));
  const yAgent = x.map((dt) => {
    const v = agentMap.get(dt);
    return Number.isFinite(v) ? v : null;
  });

  const { x: x2, seriesArr: [y2, yAgent2] } = downsampleCategory(x, [y, yAgent], 500);
  const opt = baseChartOption(`${config.label}预测（24h）`, x2);
  opt.series = [
    {
      name: `${config.label}预测`,
      type: 'line',
      showSymbol: false,
      data: y2,
      lineStyle: { width: 2, color: config.color },
      areaStyle: { opacity: 0.12, color: config.color },
      emphasis: { focus: 'series' },
    },
  ];
  if (agentRows && agentRows.length) {
    opt.series.push({
      name: `${config.label}预测（Agent）`,
      type: 'line',
      showSymbol: false,
      data: yAgent2,
      lineStyle: { width: 2, color: config.agentColor, type: 'dashed' },
      emphasis: { focus: 'series' },
    });
  }
  chart.setOption(opt, true);
}

function attachResize(charts) {
  const ro = new ResizeObserver(() => {
    for (const c of charts) c.resize();
  });
  ro.observe(document.body);
  window.addEventListener('resize', () => {
    for (const c of charts) c.resize();
  });
}

function initAssistant() {
  const messagesEl = $('assistant-messages');
  const inputEl = $('assistant-input');
  const sendEl = $('assistant-send');
  const clearEl = $('assistant-clear');
  const statusEl = $('assistant-status');
  const modeEl = $('assistant-mode');
  const fileEl = $('assistant-file');
  const pathEl = $('assistant-path');
  const loadEl = $('assistant-load');
  const targetEl = $('assistant-target');
  const writeTargetEl = $('assistant-write-target');
  const filesEl = $('assistant-files');
  const fileHintEl = $('assistant-file-hint');
  if (!messagesEl || !inputEl || !sendEl || !clearEl || !statusEl || !modeEl || !fileEl || !pathEl || !loadEl || !targetEl || !writeTargetEl || !filesEl || !fileHintEl) return;

  const history = [
    { role: 'system', content: '你是一个简洁、专注于数据分析的助手。' },
  ];
  const attachments = [];

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function addBubble(role, text) {
    const div = document.createElement('div');
    div.className = `assistant__bubble assistant__bubble--${role}`;
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '-';
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(2)} MB`;
  }

  function setFileHint(text, isError = false) {
    fileHintEl.textContent = text;
    fileHintEl.style.color = isError ? 'var(--bad)' : 'var(--muted)';
  }

  function renderFileList() {
    if (attachments.length === 0) {
      filesEl.innerHTML = '<div class="assistant__file-sub">未加载文件。</div>';
      return;
    }
    filesEl.innerHTML = '';
    for (const item of attachments) {
      const row = document.createElement('div');
      row.className = 'assistant__file-item';
      const meta = document.createElement('div');
      meta.className = 'assistant__file-meta';
      const name = document.createElement('div');
      name.className = 'assistant__file-name';
      name.textContent = item.name;
      const sub = document.createElement('div');
      sub.className = 'assistant__file-sub';
      sub.textContent = `${item.source} · ${formatBytes(item.size)}${item.truncated ? ' · 已截断' : ''}`;
      meta.appendChild(name);
      meta.appendChild(sub);
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = '移除';
      btn.addEventListener('click', () => {
        const idx = attachments.findIndex((a) => a.id === item.id);
        if (idx >= 0) attachments.splice(idx, 1);
        renderFileList();
        setFileHint('已更新文件列表。');
      });
      row.appendChild(meta);
      row.appendChild(btn);
      filesEl.appendChild(row);
    }
  }

  function truncateText(text) {
    if (text.length <= MAX_FILE_CHARS) return { text, truncated: false };
    return {
      text: `${text.slice(0, MAX_FILE_CHARS)}\n\n[内容已截断，超过 ${MAX_FILE_CHARS} 字符]`,
      truncated: true,
    };
  }

  function addAttachment(payload) {
    attachments.push(payload);
    renderFileList();
  }

  function buildAttachmentContext() {
    if (attachments.length === 0) return '';
    return attachments.map((a, index) => {
      return [
        `【文件${index + 1}】${a.name}`,
        `来源：${a.source}`,
        `大小：${formatBytes(a.size)}${a.truncated ? '（已截断）' : ''}`,
        '内容：',
        a.text,
      ].join('\n');
    }).join('\n\n');
  }

  async function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
      reader.readAsText(file);
    });
  }

  async function sendMessage(forcedPath = '') {
    const content = inputEl.value.trim();
    if (!content) return;
    inputEl.value = '';
    addBubble('user', content);
    setStatus('请求中...');
    sendEl.disabled = true;

    try {
      const mode = modeEl.value === 'agent' ? 'agent' : 'chat';
      const endpoint = mode === 'agent' ? ASSISTANT_AGENT : ASSISTANT_API;
      const attachmentContext = buildAttachmentContext();
      const payloadMessages = [...history];
      if (attachmentContext) {
        payloadMessages.push({
          role: 'system',
          content: `以下是用户已上传/读取的文件内容，仅供回答问题使用：\n\n${attachmentContext}`,
        });
      }
      if (mode === 'agent' && forcedPath) {
        payloadMessages.push({
          role: 'system',
          content: (
            '请将最终结果写入固定目标文件，并严格使用以下文件块格式输出：\n' +
            `\`\`\`file:${forcedPath}\n` +
            'CSV内容\n' +
            '```\n'
          ),
        });
      }
      payloadMessages.push({ role: 'user', content });
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: payloadMessages,
          temperature: 0.7,
          max_tokens: 512,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      const data = await res.json();
      const reply = data.text || '(无返回)';
      history.push({ role: 'user', content });
      history.push({ role: 'assistant', content: reply });
      addBubble('assistant', reply);
      if (mode === 'agent') {
        if (data.saved && data.filename) {
          addBubble('assistant', `已写入文件：${data.filename}`);
        } else if (data.error) {
          addBubble('assistant', `写入失败：${data.error}`);
        } else {
          addBubble('assistant', '未检测到可写入的文件块。');
        }
      }
      setStatus('已连接');
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      const hint = msg.includes('Failed to fetch')
        ? '（请确认本地 Agent 已启动，且 8000 端口可用）'
        : '';
      addBubble('assistant', `请求失败：${msg} ${hint}`.trim());
      setStatus('连接失败');
    } finally {
      sendEl.disabled = false;
    }
  }

  sendEl.addEventListener('click', sendMessage);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  clearEl.addEventListener('click', () => {
    messagesEl.innerHTML = '';
    history.length = 0;
    history.push({ role: 'system', content: '你是一个简洁、专注于数据分析的助手。' });
    attachments.length = 0;
    renderFileList();
    setStatus('未连接');
    setFileHint('已清空对话与文件。');
  });

  async function checkHealth() {
    try {
      const res = await fetch(ASSISTANT_HEALTH, { cache: 'no-store' });
      if (res.ok) {
        setStatus('已连接');
        return true;
      }
    } catch (e) {
      // ignore
    }
    setStatus('未连接');
    return false;
  }

  addBubble('assistant', '你好，我是本地 DeepSeek 助手，可以帮你分析当前页面数据。');
  checkHealth();
  renderFileList();
  targetEl.innerHTML = AGENT_TARGETS.map((t) => `<option value="${t.value}">${t.label}</option>`).join('');

  fileEl.addEventListener('change', async () => {
    const files = Array.from(fileEl.files || []);
    if (files.length === 0) return;
    setFileHint('正在读取上传文件...');
    for (const file of files) {
      try {
        const rawText = await readFileAsText(file);
        const { text, truncated } = truncateText(rawText);
        addAttachment({
          id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
          name: file.name,
          source: '本地上传',
          size: file.size,
          text,
          truncated,
        });
        setFileHint(`已读取：${file.name}`);
      } catch (e) {
        setFileHint(`读取失败：${file.name}`, true);
      }
    }
    fileEl.value = '';
  });

  loadEl.addEventListener('click', async () => {
    const path = String(pathEl.value || '').trim();
    if (!path) {
      setFileHint('请输入 data/ 下的文件路径。', true);
      return;
    }
    const normalized = path.replace(/\\/g, '/');
    if (!normalized.startsWith('data/') || normalized.includes('..')) {
      setFileHint('路径必须以 data/ 开头，且不能包含 ..', true);
      return;
    }
    setFileHint(`正在读取：${normalized}`);
    try {
      const res = await fetch(encodeURI(`./${normalized}`), { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const rawText = await res.text();
      const { text, truncated } = truncateText(rawText);
      addAttachment({
        id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        name: normalized.split('/').pop() || normalized,
        source: normalized,
        size: rawText.length,
        text,
        truncated,
      });
      setFileHint(`已读取：${normalized}`);
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      setFileHint(`读取失败：${msg}`, true);
    }
  });

  writeTargetEl.addEventListener('click', async () => {
    modeEl.value = 'agent';
    if (!inputEl.value.trim()) {
      setFileHint('请先输入要生成/修正的内容，再使用固定写入。', true);
      return;
    }
    const target = String(targetEl.value || '').trim();
    if (!target) {
      setFileHint('请选择一个写入目标文件。', true);
      return;
    }
    setFileHint(`已启用固定目标文件写入：${target}`);
    await sendMessage(target);
  });
}

async function main() {
  // 等待 CDN 脚本加载（防止极端网络情况下顺序问题）
  if (typeof Papa === 'undefined' || typeof echarts === 'undefined') {
    throw new Error('依赖加载失败：请检查网络是否能访问 jsdelivr CDN。');
  }

  function normalize(rawRows) {
    // 标准化：确保字段存在且数值为 number
    return rawRows.map((r) => ({
      Datetime: r.Datetime,
      _ts: parseDatetime(r.Datetime),
      Load_MW: r.Load_MW,
      Wind_MW: r.Wind_MW,
      PV_MW: r.PV_MW,
      ES_MW_Optimized: r.ES_MW_Optimized,
      Gas_MW_Optimized: r.Gas_MW_Optimized,
      ES_SOC_Optimized: r.ES_SOC_Optimized,
    })).filter((r) => Number.isFinite(r._ts));
  }

  function normalizePlan(rawRows, baseSoc) {
    const parsed = rawRows.map((r) => {
      const soc = r.SOC ?? r.ES_SOC_Decision ?? r.ES_SOC_Optimized ?? r.ES_SOC;
      const power = r.ES_Power ?? r.ES_MW_Decision ?? r.ES_MW ?? r.ES_MW_Optimized;
      return {
        Datetime: r.Datetime,
        _ts: parseDatetime(r.Datetime),
        SOC: Number(soc),
        power: Number(power),
      };
    }).filter((r) => Number.isFinite(r._ts));

    const hasSoc = parsed.some((r) => Number.isFinite(r.SOC));
    if (hasSoc) {
      return parsed.filter((r) => Number.isFinite(r.SOC));
    }

    if (!Number.isFinite(baseSoc)) return [];
    const withPower = parsed.filter((r) => Number.isFinite(r.power)).sort((a, b) => a._ts - b._ts);
    let soc = baseSoc;
    return withPower.map((r) => {
      soc -= r.power;
      return { Datetime: r.Datetime, _ts: r._ts, SOC: soc };
    });
  }

  function getLatestSoc(rows) {
    let latestTs = -Infinity;
    let latestSoc = NaN;
    for (const r of rows) {
      if (Number.isFinite(r._ts) && r._ts >= latestTs) {
        const soc = Number(r.ES_SOC_Optimized);
        if (Number.isFinite(soc)) {
          latestTs = r._ts;
          latestSoc = soc;
        }
      }
    }
    return latestSoc;
  }

  let rows = normalize(await loadCsv());
  let planRows = [];
  let planFile = '';
  setLastUpdated(new Date());

  let range = guessTimeRange(rows);
  const startEl = $('start');
  const endEl = $('end');
  const metricEl = $('metric');
  const applyEl = $('apply');
  const resetEl = $('reset');
  const downloadEl = $('download');
  const forecastEl = $('forecast-type');
  const forecastHintEl = $('forecast-hint');

  function clampInputsToRange() {
    const s = parseDatetime(startEl.value);
    const e = parseDatetime(endEl.value);
    const nextS = Number.isFinite(s) ? Math.min(Math.max(s, range.minMs), range.maxMs) : range.minMs;
    const nextE = Number.isFinite(e) ? Math.min(Math.max(e, range.minMs), range.maxMs) : range.maxMs;
    // 保证 start <= end
    const finalS = Math.min(nextS, nextE);
    const finalE = Math.max(nextS, nextE);
    startEl.value = formatDatetime(finalS);
    endEl.value = formatDatetime(finalE);
  }

  // 初始默认：最近 24 个时间点
  const recentRange = recentWindowRange(rows, 24);
  startEl.value = recentRange.minLabel;
  endEl.value = recentRange.maxLabel;
  clampInputsToRange();
  initMetricSelect(metricEl);
  initForecastSelect(forecastEl);

  const chartMain = echarts.init($('chart-main'));
  const chartMix = echarts.init($('chart-mix'));
  const chartSoc = echarts.init($('chart-soc'));
  const chartForecast = echarts.init($('chart-forecast'));
  attachResize([chartMain, chartMix, chartSoc, chartForecast]);

  const columns = ['Datetime', 'Load_MW', 'Wind_MW', 'PV_MW', 'ES_MW_Optimized', 'Gas_MW_Optimized', 'ES_SOC_Optimized'];
  const tableEl = $('table');

  function render() {
    const filtered = pickRowsByTime(rows, startEl.value, endEl.value);
    const recent = recentWindowRange(rows, 24);
    const actualSocRows = pickRowsByMs(rows, recent.minMs, recent.maxMs);
    setKpis(filtered);
    renderMainChart(chartMain, filtered, metricEl.value);
    renderMixChart(chartMix, filtered);
    renderSocChart(chartSoc, actualSocRows, planRows);
    buildTable(tableEl, columns, filtered, 200);
  }

  applyEl.addEventListener('click', render);
  resetEl.addEventListener('click', () => {
    const recent = recentWindowRange(rows, 24);
    startEl.value = recent.minLabel;
    endEl.value = recent.maxLabel;
    metricEl.value = 'Load_MW';
    render();
  });
  metricEl.addEventListener('change', render);

  function setForecastHint(text) {
    if (forecastHintEl) forecastHintEl.textContent = text;
  }

  let forecastRefreshing = false;
  async function refreshForecast() {
    if (forecastRefreshing) return;
    forecastRefreshing = true;
    const config = getForecastConfig(forecastEl.value);
    setForecastHint(`数据源：${config.file}（加载中...）`);
    try {
      const [rawRows, rawAgentRows] = await Promise.all([
        loadCsv(config.file),
        config.agentFile ? loadCsvOptional(config.agentFile) : Promise.resolve(null),
      ]);
      const forecastRows = normalizeForecast(rawRows, config.valueKey);
      const forecastAgentRows = rawAgentRows ? normalizeForecast(rawAgentRows, config.valueKey) : [];
      renderForecastChart(chartForecast, forecastRows, forecastAgentRows, config);
      const agentHint = forecastAgentRows.length ? ` + Agent ${forecastAgentRows.length} 行` : '';
      setForecastHint(`数据源：${config.file}${agentHint}`);
    } catch (e) {
      console.warn('读取预测数据失败：', e);
      setForecastHint(`读取预测数据失败：${(e && e.message) ? e.message : String(e)}`);
      renderForecastChart(chartForecast, [], [], config);
    } finally {
      forecastRefreshing = false;
    }
  }

  forecastEl.addEventListener('change', () => {
    refreshForecast();
  });

  downloadEl.addEventListener('click', () => {
    const filtered = pickRowsByTime(rows, startEl.value, endEl.value);
    const csv = buildCsv(filtered, columns);
    const name = `VPP筛选_${startEl.value}-${endEl.value}.csv`;
    downloadText(name, csv);
  });

  render();
  let planRefreshing = false;
  async function refreshPlan() {
    if (planRefreshing) return;
    planRefreshing = true;
    try {
      const latest = await resolveLatestStoragePlan();
      const baseSoc = getLatestSoc(rows);
      planFile = latest.file;
      planRows = normalizePlan(latest.rows, baseSoc);
      render();
    } catch (e) {
      console.warn('读取储能规划失败：', e);
    } finally {
      planRefreshing = false;
    }
  }
  refreshPlan();
  refreshForecast();

  // 每分钟刷新一次数据（仅更新 dashboard，不刷新 iframe）
  let refreshing = false;
  async function refreshData() {
    if (refreshing) return;
    refreshing = true;
    try {
      const nextRows = normalize(await loadCsv());
      rows = nextRows;
      range = guessTimeRange(rows);
      clampInputsToRange(); // 保留用户选择，但确保在新范围内
      setLastUpdated(new Date());
      render();
    } catch (e) {
      // 刷新失败不影响现有展示
      console.warn('自动刷新失败：', e);
    } finally {
      refreshing = false;
    }
  }

  setInterval(() => {
    refreshData();
    refreshPlan();
    refreshForecast();
  }, REFRESH_MS);

  initAssistant();
}

window.addEventListener('DOMContentLoaded', () => {
  main().catch((err) => {
    console.error(err);
    const msg = (err && err.message) ? err.message : String(err);
    alert(`页面初始化失败：\n${msg}\n\n建议：用静态服务器打开本页面（详见 README.md）。`);
  });
});


