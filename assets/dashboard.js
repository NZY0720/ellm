/* global Papa, echarts */

const DATA_ROOT = 'data';
const CSV_FILE = `${DATA_ROOT}/虚拟电厂_24h15min_数据.csv`;
const REFRESH_MS = 60 * 1000;

const METRICS = [
  { key: '负荷消耗_kW', label: '负荷（kW）' },
  { key: '光伏出力_kW', label: '光伏（kW）' },
  { key: '实时电价_元/kWh', label: '实时电价（元/kWh）' },
];

const FORECAST_TYPES = [
  {
    key: 'load',
    label: '负荷',
    file: `${DATA_ROOT}/output/Load_forecast_12h.csv`,
    agentFile: `${DATA_ROOT}/output/Load_forecast_12h_agent.csv`,
    valueKey: 'Load_Forecast',
    color: '#5b8cff',
    agentColor: '#9bb7ff',
  },
  {
    key: 'pv',
    label: '光伏',
    file: `${DATA_ROOT}/output/PV_forecast_12h.csv`,
    agentFile: `${DATA_ROOT}/output/PV_forecast_12h_agent.csv`,
    valueKey: 'PV_Forecast',
    color: '#ffcc66',
    agentColor: '#ffe19b',
  },
];

const ASSISTANT_API = 'http://127.0.0.1:8000/chat';
const ASSISTANT_AGENT = 'http://127.0.0.1:8000/agent';
const ASSISTANT_HEALTH = 'http://127.0.0.1:8000/health';
const ASSISTANT_PREDICT12H = 'http://127.0.0.1:8000/predict12h';
const ASSISTANT_DECISION12H = 'http://127.0.0.1:8000/decision12h';
const MAX_FILE_CHARS = 200000;
const AGENT_TARGETS = [
  { value: '虚拟电厂_24h15min_数据_agent.csv', label: 'data/虚拟电厂_24h15min_数据_agent.csv' },
  { value: 'output/Load_forecast_12h_agent.csv', label: 'data/output/Load_forecast_12h_agent.csv' },
  { value: 'output/PV_forecast_12h_agent.csv', label: 'data/output/PV_forecast_12h_agent.csv' },
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
  // Numeric hours like "6" / "6.25" (for 15min data)
  if (/^\d+(\.\d+)?$/.test(s)) {
    const hours = Number(s);
    if (!Number.isFinite(hours)) return NaN;
    return hours * 60 * 60 * 1000;
  }
  // "H:MM"
  const hm = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (hm) {
    const h = Number(hm[1]);
    const m2 = Number(hm[2]);
    if (!Number.isFinite(h) || !Number.isFinite(m2)) return NaN;
    return (h * 60 + m2) * 60 * 1000;
  }
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
  const ms = dt instanceof Date ? dt.getTime() : Number(dt);
  if (!Number.isFinite(ms)) return '';
  // If it's a small synthetic range (<= 48h), render as H:MM.
  if (ms >= 0 && ms <= 48 * 60 * 60 * 1000) {
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    const pad2 = (n) => String(n).padStart(2, '0');
    return `${h}:${pad2(m)}`;
  }
  const d = new Date(ms);
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
  const startMs = Math.max(base.minMs, base.maxMs - hours * 60 * 60 * 1000);
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

function initMetricSelect(selectEl) {
  selectEl.innerHTML = METRICS.map((m) => `<option value="${m.key}">${m.label}</option>`).join('');
  selectEl.value = '负荷消耗_kW';
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
  const load = stat(rows.map((r) => Number(r['负荷消耗_kW'])));
  const pv = stat(rows.map((r) => Number(r['光伏出力_kW'])));
  const price = stat(rows.map((r) => Number(r['实时电价_元/kWh'])));

  $('kpi-load').textContent = `${fmt(load.avg)} / ${fmt(load.max)}`;
  $('kpi-pv').textContent = `${fmt(pv.avg)} / ${fmt(pv.max)}`;
  $('kpi-price').textContent = `${fmt(price.avg, 3)} / ${fmt(price.max, 3)}`;
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
  const pv = rows.map((r) => Number(r['光伏出力_kW']));
  const load = rows.map((r) => Number(r['负荷消耗_kW']));
  const price = rows.map((r) => Number(r['实时电价_元/kWh']));

  const { x: x2, seriesArr: [pv2, load2, price2] } = downsampleCategory(x, [pv, load, price], 2500);
  const opt = baseChartOption('负荷 / 光伏 / 电价', x2);
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
    {
      name: '负荷(kW)',
      type: 'line',
      showSymbol: false,
      data: load2,
      lineStyle: { width: 2.2, color: '#5b8cff' },
      emphasis: { focus: 'series' },
    },
    { name: '光伏(kW)', type: 'line', showSymbol: false, data: pv2, lineStyle: { width: 1.8, color: '#ffcc66' } },
    { name: '电价(元/kWh)', type: 'line', yAxisIndex: 1, showSymbol: false, data: price2, lineStyle: { width: 1.6, color: '#3ddc97', type: 'dashed' } },
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
  const opt = baseChartOption(`${config.label}预测（12h）`, x2);
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

function renderDecisionChart(chart, rawRows) {
  const rows = (rawRows || []).map((r) => ({
    Datetime: r.Datetime,
    Battery_Power_kW: Number(r.Battery_Power_kW),
    SOC_kWh: Number(r.SOC_kWh),
    Grid_Power_kW: Number(r.Grid_Power_kW),
    Price_yuan_per_kWh: Number(r.Price_yuan_per_kWh),
  }));
  const x = rows.map((r) => String(r.Datetime));
  const batt = rows.map((r) => (Number.isFinite(r.Battery_Power_kW) ? r.Battery_Power_kW : null));
  const grid = rows.map((r) => (Number.isFinite(r.Grid_Power_kW) ? r.Grid_Power_kW : null));
  const soc = rows.map((r) => (Number.isFinite(r.SOC_kWh) ? r.SOC_kWh : null));
  const price = rows.map((r) => (Number.isFinite(r.Price_yuan_per_kWh) ? r.Price_yuan_per_kWh : null));

  const { x: x2, seriesArr: [batt2, grid2, soc2, price2] } = downsampleCategory(x, [batt, grid, soc, price], 500);
  const opt = baseChartOption('储能 / 购售电决策（12h）', x2);
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
    { name: '电池功率(kW，放电为正)', type: 'bar', data: batt2, itemStyle: { color: 'rgba(155,123,255,0.75)' } },
    { name: '电网功率(kW，购电为正)', type: 'line', showSymbol: false, data: grid2, lineStyle: { width: 2, color: '#5b8cff' } },
    { name: 'SOC(kWh)', type: 'line', yAxisIndex: 1, showSymbol: false, data: soc2, lineStyle: { width: 2, color: '#ffcc66' } },
    { name: '电价(元/kWh)', type: 'line', yAxisIndex: 1, showSymbol: false, data: price2, lineStyle: { width: 1.6, color: '#3ddc97', type: 'dashed' } },
  ];
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
    // New data source (24h, 15min): build a time axis from 时间_小时 / 时间_时段
    const pad2 = (n) => String(n).padStart(2, '0');
    const fmtHM = (hours) => {
      const h = Math.floor(hours);
      const minutes = Math.round((hours - h) * 60);
      const mm = Math.max(0, Math.min(59, minutes));
      return `${h}:${pad2(mm)}`;
    };

    return rawRows.map((r) => {
      const hour = Number(r['时间_小时']);
      const period = Number(r['时间_时段']);
      const hours = Number.isFinite(hour)
        ? hour
        : (Number.isFinite(period) ? (period - 1) * 0.25 : NaN);
      const label = Number.isFinite(hours) ? fmtHM(hours) : '';
      return {
        Datetime: label || String(r.Datetime ?? ''),
        _ts: Number.isFinite(hours) ? hours * 60 * 60 * 1000 : parseDatetime(label),
        '时间_小时': r['时间_小时'],
        '时间_时段': r['时间_时段'],
        '负荷消耗_kW': r['负荷消耗_kW'],
        '光伏出力_kW': r['光伏出力_kW'],
        '实时电价_元/kWh': r['实时电价_元/kWh'],
      };
    }).filter((r) => Number.isFinite(r._ts));
  }

  let rows = normalize(await loadCsv());
  setLastUpdated(new Date());

  let range = guessTimeRange(rows);
  const startEl = $('start');
  const endEl = $('end');
  const metricEl = $('metric');
  const applyEl = $('apply');
  const resetEl = $('reset');
  const downloadEl = $('download');
  const forecastEl = $('forecast-type');
  const forecastRunEl = $('forecast-run');
  const forecastHintEl = $('forecast-hint');
  const decisionRunEl = $('decision-run');
  const decisionHintEl = $('decision-hint');

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
  const chartForecast = echarts.init($('chart-forecast'));
  const chartDecision = echarts.init($('chart-decision'));
  attachResize([chartMain, chartMix, chartForecast, chartDecision]);

  const columns = ['Datetime', '时间_小时', '时间_时段', '负荷消耗_kW', '光伏出力_kW', '实时电价_元/kWh'];
  const tableEl = $('table');

  function render() {
    const filtered = pickRowsByTime(rows, startEl.value, endEl.value);
    setKpis(filtered);
    renderMainChart(chartMain, filtered, metricEl.value);
    renderMixChart(chartMix, filtered);
    buildTable(tableEl, columns, filtered, 200);
  }

  applyEl.addEventListener('click', render);
  resetEl.addEventListener('click', () => {
    const recent = recentWindowRange(rows, 24);
    startEl.value = recent.minLabel;
    endEl.value = recent.maxLabel;
    metricEl.value = '负荷消耗_kW';
    render();
  });
  metricEl.addEventListener('change', render);

  function setForecastHint(text) {
    if (forecastHintEl) forecastHintEl.textContent = text;
  }
  function setDecisionHint(text) {
    if (decisionHintEl) decisionHintEl.textContent = text;
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
      const msg = (e && e.message) ? e.message : String(e);
      const missing = /404/.test(msg) || /Not Found/i.test(msg);
      setForecastHint(missing
        ? `暂无预测文件：${config.file}。点击“运行预测”生成一次 12h 预测。`
        : `读取预测数据失败：${msg}`
      );
      renderForecastChart(chartForecast, [], [], config);
    } finally {
      forecastRefreshing = false;
    }
  }

  async function runPredictOnce() {
    if (!forecastRunEl) return;
    forecastRunEl.disabled = true;
    const oldText = forecastRunEl.textContent;
    forecastRunEl.textContent = '预测中...';
    setForecastHint('正在调用本地 Agent 生成 12h 预测...');
    try {
      const res = await fetch(ASSISTANT_PREDICT12H, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          history_file: '虚拟电厂_24h15min_数据.csv',
          window_hours: 24,
          horizon_hours: 12,
          step_minutes: 15,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        const err = data.error || `HTTP ${res.status}`;
        throw new Error(err);
      }
      setForecastHint(`预测已生成并覆盖写入：${(data.files || []).join(', ') || 'ok'}`);
      await refreshForecast();
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      setForecastHint(`运行预测失败：${msg}（请确认本地 Agent 已启动，端口 8000 可用）`);
    } finally {
      forecastRunEl.disabled = false;
      forecastRunEl.textContent = oldText || '运行预测';
    }
  }

  let decisionRefreshing = false;
  async function refreshDecision() {
    if (decisionRefreshing) return;
    decisionRefreshing = true;
    const file = `${DATA_ROOT}/output/Market_decision_12h.csv`;
    setDecisionHint(`数据源：${file}（加载中...）`);
    try {
      const raw = await loadCsv(file);
      renderDecisionChart(chartDecision, raw);
      setDecisionHint(`数据源：${file}（${raw.length} 行）`);
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      const missing = /404/.test(msg) || /Not Found/i.test(msg);
      setDecisionHint(missing
        ? `暂无决策文件：${file}。先点击“运行预测”，再点击“生成决策”。`
        : `读取决策数据失败：${msg}`
      );
      renderDecisionChart(chartDecision, []);
    } finally {
      decisionRefreshing = false;
    }
  }

  async function runDecisionOnce() {
    if (!decisionRunEl) return;
    decisionRunEl.disabled = true;
    const oldText = decisionRunEl.textContent;
    decisionRunEl.textContent = '生成中...';
    setDecisionHint('正在生成 12h 决策（经济效益最大化）...');
    try {
      const res = await fetch(ASSISTANT_DECISION12H, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          history_file: '虚拟电厂_24h15min_数据.csv',
          load_forecast: 'output/Load_forecast_12h.csv',
          pv_forecast: 'output/PV_forecast_12h.csv',
          output_file: 'output/Market_decision_12h.csv',
          horizon_hours: 12,
          step_minutes: 15,
          window_hours: 24,
          capacity_kwh: 200,
          p_max_kw: 100,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        const err = data.error || `HTTP ${res.status}`;
        throw new Error(err);
      }
      setDecisionHint(`决策已生成并覆盖写入：${(data.files || []).join(', ') || 'ok'}`);
      await refreshDecision();
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      setDecisionHint(`生成决策失败：${msg}（请确认本地 Agent 已启动，且已先生成预测文件）`);
    } finally {
      decisionRunEl.disabled = false;
      decisionRunEl.textContent = oldText || '生成决策';
    }
  }

  forecastEl.addEventListener('change', () => {
    refreshForecast();
  });
  if (forecastRunEl) {
    forecastRunEl.addEventListener('click', runPredictOnce);
  }
  if (decisionRunEl) {
    decisionRunEl.addEventListener('click', runDecisionOnce);
  }

  downloadEl.addEventListener('click', () => {
    const filtered = pickRowsByTime(rows, startEl.value, endEl.value);
    const csv = buildCsv(filtered, columns);
    const name = `虚拟电厂筛选_${startEl.value}-${endEl.value}.csv`;
    downloadText(name, csv);
  });

  render();
  refreshForecast();
  refreshDecision();

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
    refreshForecast();
    refreshDecision();
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


