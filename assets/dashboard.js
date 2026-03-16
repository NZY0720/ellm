/* global Papa, echarts */

const DATA_ROOT = 'data';
const CSV_FILE = `${DATA_ROOT}/虚拟电厂_24h15min_数据.csv`;
const REFRESH_MS = 60 * 1000;
const SIM_STATUS_FILE = `${DATA_ROOT}/output/realtime_sim_status.json`;
const SIM_WATCH_MS = 5000;

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
  // Numeric hours like "6" / "6.25" / "120.5" for cumulative-hour data.
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
  const d = new Date(ms);
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function compactDatetimeLabel(text) {
  const ms = parseDatetime(text);
  if (!Number.isFinite(ms)) return String(text);
  const d = new Date(ms);
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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
      axisLabel: {
        color: 'rgba(255,255,255,0.62)',
        formatter: (value) => compactDatetimeLabel(value),
      },
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

async function loadJsonOptional(file) {
  try {
    const url = encodeURI(`./${file}`);
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
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

function initAssistant(bridge) {
  if (!window.AssistantRuntime || typeof window.AssistantRuntime.createRuntime !== 'function') return null;
  window.DashboardAssistantBridge = bridge;
  return window.AssistantRuntime.createRuntime({ bridge });
}

async function main() {
  // 等待 CDN 脚本加载（防止极端网络情况下顺序问题）
  if (typeof Papa === 'undefined' || typeof echarts === 'undefined') {
    throw new Error('依赖加载失败：请检查网络是否能访问 jsdelivr CDN。');
  }

  function normalize(rawRows) {
    return rawRows.map((r) => {
      const dtText = String(r.Datetime ?? '').trim();
      const directTs = parseDatetime(dtText);
      const hour = Number(r['时间_小时']);
      const period = Number(r['时间_时段']);
      const fallbackHours = Number.isFinite(hour)
        ? hour
        : (Number.isFinite(period) ? (period - 1) / 60 : NaN);
      const fallbackTs = Number.isFinite(fallbackHours) ? fallbackHours * 60 * 60 * 1000 : NaN;
      const ts = Number.isFinite(directTs) ? directTs : fallbackTs;
      const label = Number.isFinite(directTs)
        ? formatDatetime(directTs)
        : (Number.isFinite(fallbackTs) ? formatDatetime(fallbackTs) : '');
      return {
        Datetime: label || String(r.Datetime ?? ''),
        _ts: ts,
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
  const dashboardState = {
    dataset: {
      totalRows: rows.length,
      filteredRows: 0,
    },
    filters: {
      start: '',
      end: '',
      metric: '',
      metricLabel: '',
    },
    kpis: {
      load: null,
      pv: null,
      price: null,
    },
    forecast: {
      key: forecastEl.value,
      ready: false,
      hint: '',
      rows: 0,
      agentRows: 0,
    },
    decision: {
      ready: false,
      hint: '',
      rows: 0,
    },
    updatedAt: Date.now(),
  };

  function publishDashboardState() {
    dashboardState.updatedAt = Date.now();
    window.__dashboardState = JSON.parse(JSON.stringify(dashboardState));
    window.dispatchEvent(new CustomEvent('dashboard:state', {
      detail: window.__dashboardState,
    }));
  }

  function render() {
    const filtered = pickRowsByTime(rows, startEl.value, endEl.value);
    const load = stat(filtered.map((r) => Number(r['负荷消耗_kW'])));
    const pv = stat(filtered.map((r) => Number(r['光伏出力_kW'])));
    const price = stat(filtered.map((r) => Number(r['实时电价_元/kWh'])));
    const metricLabel = (METRICS.find((m) => m.key === metricEl.value)?.label) ?? metricEl.value;
    setKpis(filtered);
    renderMainChart(chartMain, filtered, metricEl.value);
    renderMixChart(chartMix, filtered);
    buildTable(tableEl, columns, filtered, 200);
    dashboardState.dataset.totalRows = rows.length;
    dashboardState.dataset.filteredRows = filtered.length;
    dashboardState.filters = {
      start: startEl.value,
      end: endEl.value,
      metric: metricEl.value,
      metricLabel,
    };
    dashboardState.kpis = {
      load,
      pv,
      price,
    };
    publishDashboardState();
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
    dashboardState.forecast.key = config.key;
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
      dashboardState.forecast.ready = true;
      dashboardState.forecast.hint = `数据源：${config.file}${agentHint}`;
      dashboardState.forecast.rows = forecastRows.length;
      dashboardState.forecast.agentRows = forecastAgentRows.length;
    } catch (e) {
      console.warn('读取预测数据失败：', e);
      const msg = (e && e.message) ? e.message : String(e);
      const missing = /404/.test(msg) || /Not Found/i.test(msg);
      setForecastHint(missing
        ? `暂无预测文件：${config.file}。点击“运行预测”生成一次 12h 预测。`
        : `读取预测数据失败：${msg}`
      );
      renderForecastChart(chartForecast, [], [], config);
      dashboardState.forecast.ready = false;
      dashboardState.forecast.hint = missing
        ? `暂无预测文件：${config.file}。点击“运行预测”生成一次 12h 预测。`
        : `读取预测数据失败：${msg}`;
      dashboardState.forecast.rows = 0;
      dashboardState.forecast.agentRows = 0;
    } finally {
      forecastRefreshing = false;
      publishDashboardState();
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
          step_minutes: 1,
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
      dashboardState.decision.ready = true;
      dashboardState.decision.hint = `数据源：${file}（${raw.length} 行）`;
      dashboardState.decision.rows = raw.length;
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      const missing = /404/.test(msg) || /Not Found/i.test(msg);
      setDecisionHint(missing
        ? `暂无决策文件：${file}。先点击“运行预测”，再点击“生成决策”。`
        : `读取决策数据失败：${msg}`
      );
      renderDecisionChart(chartDecision, []);
      dashboardState.decision.ready = false;
      dashboardState.decision.hint = missing
        ? `暂无决策文件：${file}。先点击“运行预测”，再点击“生成决策”。`
        : `读取决策数据失败：${msg}`;
      dashboardState.decision.rows = 0;
    } finally {
      decisionRefreshing = false;
      publishDashboardState();
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
          step_minutes: 1,
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

  let simRevision = null;
  let simWatching = false;
  async function watchSimulatorStatus() {
    if (simWatching) return;
    simWatching = true;
    try {
      const status = await loadJsonOptional(SIM_STATUS_FILE);
      if (!status || status.kind !== 'realtime-simulator') return;
      if (simRevision == null) {
        simRevision = status.revision;
        return;
      }
      if (status.revision !== simRevision) {
        simRevision = status.revision;
        await refreshData();
        await refreshForecast();
        await refreshDecision();
      }
    } finally {
      simWatching = false;
    }
  }

  setInterval(() => {
    watchSimulatorStatus();
  }, SIM_WATCH_MS);

  const assistantBridge = {
    getSnapshot: () => window.__dashboardState || JSON.parse(JSON.stringify(dashboardState)),
    refreshData,
    refreshDecision,
    refreshForecast,
  };
  publishDashboardState();
  initAssistant(assistantBridge);
}

window.addEventListener('DOMContentLoaded', () => {
  main().catch((err) => {
    console.error(err);
    const msg = (err && err.message) ? err.message : String(err);
    alert(`页面初始化失败：\n${msg}\n\n建议：用静态服务器打开本页面（详见 README.md）。`);
  });
});


