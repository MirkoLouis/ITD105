import { BzChart } from 'https://cdn.jsdelivr.net/gh/bonezegei/bzUI/dist/bzChart.min.js';
import { TinyLSTM } from './tiny-lstm.js';
import { createUnrollGraph } from './unroll-graph.js';

const SYMBOL = 'BTCUSDT';
const HORIZON = 20;         // candles to forecast
const EPOCHS_PER_CANDLE = 30; // training passes each time a new closed candle arrives
const LR = 0.005;
const TICK_MS = 1000;

const statusEl = document.getElementById('status');
const forecastEl = document.getElementById('forecast');
const windowInfoEl = document.getElementById('window-info');
const typeSelect = document.getElementById('chart-type');
const windowSelect = document.getElementById('window-size');
const candlesSelect = document.getElementById('candle-count');
const timeframeSelect = document.getElementById('timeframe');
const liveEl = document.getElementById('live-dot');
const accuracyEl = document.getElementById('accuracy');

const chart = new BzChart(document.getElementById('c-btc'), { type: 'candlestick', labels: [], datasets: [], height: 420 });

let WINDOW = Number(windowSelect.value);
let CANDLES = Number(candlesSelect.value);
let INTERVAL = timeframeSelect.value;
let model = null;
let norm = null;
let trainedAt = null; // close time of the newest closed candle the model was trained on
let candles = [];
let forecast = [];
let priceRange = { min: 0, max: 1 };
let busy = false;
let recalcQueued = false;
let lastNet = null;
const INTERVAL_MS = { '1s': 1e3, '1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 };
const predictions = new Map(); // open time of the predicted candle -> forecast of its close

async function fetchCandles() {
  const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${CANDLES}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance responded ${res.status}`);
  const rows = await res.json();
  const now = Date.now();
  // Keep only closed candles: the one still forming changes every second and would move the model.
  return rows
    .filter((r) => r[6] < now)
    .map((r) => ({ time: r[0], o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) }));
}

/** Resets the model and its normalization; both are rebuilt on the next tick. */
function resetModel() {
  model = new TinyLSTM();
  norm = null;
  trainedAt = null;
}

/** Trains only when a new closed candle arrives; otherwise returns the saved forecast unchanged. */
function trainAndForecast(closes, latestTime) {
  if (latestTime === trainedAt && forecast.length === HORIZON) return forecast;
  trainedAt = latestTime;

  // The model predicts each candle's % change rather than the price level. Mean and std are fixed for the model's life.
  const rets = closes.slice(1).map((v, i) => v / closes[i] - 1);
  if (!norm) {
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const std = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) || 1e-9;
    norm = { mean, std };
  }
  const { mean, std } = norm;
  const z = rets.map((r) => (r - mean) / std);

  const samples = [];
  for (let i = 0; i + WINDOW < z.length; i++) {
    samples.push({ x: z.slice(i, i + WINDOW), y: z[i + WINDOW] });
  }
  for (let epoch = 0; epoch < EPOCHS_PER_CANDLE; epoch++) {
    for (const s of samples) model.trainStep(s.x, s.y, LR);
  }

  const seq = z.slice(-WINDOW);
  const first = model.forward(seq);
  const last = first.cache[first.cache.length - 1];
  lastNet = {
    input: seq[seq.length - 1],
    ...last,
    cache: first.cache,
    yNorm: first.yPred,
    closes: closes.slice(-WINDOW),
    weights: { wf: [...model.wf], wi: [...model.wi], wc: [...model.wc], wo: [...model.wo], wy: model.wy },
    windows: samples.length,
  };

  let price = closes[closes.length - 1];
  const out = [];
  const step = (zPred) => {
    price *= 1 + (zPred * std + mean);
    out.push(price);
  };
  step(first.yPred);
  seq.push(first.yPred);
  seq.shift();
  for (let k = 1; k < HORIZON; k++) {
    const next = model.forward(seq).yPred;
    step(next);
    seq.push(next);
    seq.shift();
  }
  return out;
}

const fmtTime = (ms) => new Date(ms).toISOString().slice(11, 19);

function buildOptions(type) {
  const n = candles.length;
  const labels = [
    ...candles.map((c) => fmtTime(c.time)),
    ...Array.from({ length: HORIZON }, (_, k) => `+${k + 1}`),
  ];
  const pad = (arr) => [...arr, ...Array(HORIZON).fill(null)];
  const predictedSeries = pad(candles.map((c) => predictions.get(c.time) ?? null));
  const forecastSeries = Array(n).fill(null);
  if (n) forecastSeries[n - 1] = candles[n - 1].c; // connect forecast to the last close
  forecast.forEach((v) => forecastSeries.push(v));
  const baselineSeries = n ? [...Array(n - 1).fill(null), ...Array(HORIZON + 1).fill(candles[n - 1].c)] : [];

  const { min, max } = priceRange;
  const annotations = [
    { type: 'trendline', x1: n - WINDOW, y1: min, x2: n - WINDOW, y2: max },
    { type: 'trendline', x1: n - 1, y1: min, x2: n - 1, y2: max },
    { type: 'text', x: n - WINDOW, y: max, text: `window ${WINDOW} candles` },
    { type: 'text', x: n + HORIZON / 2, y: min, text: `forecast ${HORIZON} candles` },
  ];

  if (type === 'candlestick') {
    return {
      type: 'mixed',
      labels,
      annotations,
      datasets: [
        { label: `${SYMBOL} ${INTERVAL}`, type: 'candlestick', data: pad(candles.map((c) => ({ o: c.o, h: c.h, l: c.l, c: c.c }))) },
        { label: 'LSTM forecast', type: 'line', points: true, data: forecastSeries },
        { label: 'LSTM predicted', type: 'line', points: true, data: predictedSeries },
        { label: 'Repeat last close', type: 'line', points: false, data: baselineSeries },
      ],
    };
  }
  return {
    type,
    labels,
    annotations,
    datasets: [
      { label: `${SYMBOL} close`, data: pad(candles.map((c) => c.c)), points: false },
      { label: 'LSTM forecast', data: forecastSeries, points: true },
      { label: 'LSTM predicted', data: predictedSeries, points: true },
      { label: 'Repeat last close', data: baselineSeries, points: false },
    ],
  };
}

function updateAccuracy() {
  const pts = candles.flatMap((c, i) => {
    const p = predictions.get(c.time);
    return p == null || i === 0 ? [] : [{ p, b: candles[i - 1].c, a: c.c }];
  });
  if (!pts.length) {
    accuracyEl.textContent = 'Prediction check: waiting for the next candle to open…';
    return;
  }
  const mapeOf = (key) => (pts.reduce((s, q) => s + Math.abs(q[key] - q.a) / q.a, 0) / pts.length) * 100;
  const mape = mapeOf('p');
  const baseMape = mapeOf('b');
  const last = pts[pts.length - 1];
  const lastErr = (Math.abs(last.p - last.a) / last.a) * 100;
  accuracyEl.textContent =
    `Prediction check: ${pts.length} predicted candles · LSTM MAPE ${mape.toFixed(3)}% · ` +
    `repeat-last-close MAPE ${baseMape.toFixed(3)}% · ` +
    `latest predicted ${last.p.toFixed(2)} vs actual ${last.a.toFixed(2)} (${lastErr.toFixed(3)}% error).`;
}

function updateText() {
  const last = candles[candles.length - 1];
  const end = forecast[HORIZON - 1];
  const dir = end > last.c ? 'up' : end < last.c ? 'down' : 'flat';
  forecastEl.textContent =
    `Last close ${last.c.toFixed(2)} USDT · forecast in ${HORIZON} ${INTERVAL} candles ${end.toFixed(2)} USDT (${dir}). ` +
    `Input window: ${WINDOW} candles.`;
  windowInfoEl.textContent = `Windows (training samples): ${lastNet.windows} · window size ${WINDOW}`;
}

// ---- Live network graph (SVG). Geometry is built once; values refresh every tick. ----
const NS = 'http://www.w3.org/2000/svg';
const svg = document.getElementById('lstm-graph');
const nodeGeom = {
  x:     { x: 90,  y: 120, label: 'x_t',        sub: 'input (z)' },
  hPrev: { x: 90,  y: 300, label: 'h_(t-1)',    sub: 'prev hidden' },
  cPrev: { x: 90,  y: 430, label: 'c_(t-1)',    sub: 'prev cell' },
  f:     { x: 290, y: 60,  label: 'σ forget',   sub: 'f_t' },
  i:     { x: 290, y: 200, label: 'σ input',    sub: 'i_t' },
  c:     { x: 290, y: 340, label: 'tanh cand.', sub: 'c̃_t' },
  o:     { x: 290, y: 480, label: 'σ output',   sub: 'o_t' },
  cNow:  { x: 500, y: 300, label: 'c_t',        sub: 'cell state' },
  hNow:  { x: 680, y: 400, label: 'h_t',        sub: 'o ⊙ tanh(c_t)' },
  y:     { x: 860, y: 400, label: 'ŷ',          sub: 'forecast (z)' },
};
const valueEls = {};
const edgeEls = [];

function el(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildGraph() {
  const defs = el('defs');
  const marker = el('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 10, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
  marker.append(el('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--bz-border, #94a3b8)' }));
  defs.append(marker);
  svg.replaceChildren(defs);

  // [from, to, weightKey] — weightKey null for structural edges without a label.
  const edges = [
    ['x', 'f', 'wf1'], ['hPrev', 'f', 'wf0'], ['x', 'i', 'wi1'], ['hPrev', 'i', 'wi0'],
    ['x', 'c', 'wc1'], ['hPrev', 'c', 'wc0'], ['x', 'o', 'wo1'], ['hPrev', 'o', 'wo0'],
    ['cPrev', 'cNow', null, true], ['f', 'cNow', null], ['i', 'cNow', null], ['c', 'cNow', null],
    ['cNow', 'hNow', null], ['o', 'hNow', null], ['hNow', 'y', 'wy'],
  ];
  for (const [a, b, key, dashed] of edges) {
    const A = nodeGeom[a], B = nodeGeom[b];
    const line = el('line', { x1: A.x, y1: A.y, x2: B.x, y2: B.y, class: `lg-edge${dashed ? ' lg-dashed' : ''}`, 'marker-end': 'url(#arrow)' });
    const label = el('text', { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 - 6, class: 'lg-weight', 'text-anchor': 'middle' });
    svg.append(line, label);
    edgeEls.push({ key, line, label });
  }

  for (const [key, n] of Object.entries(nodeGeom)) {
    const g = el('g', { class: `lg-node lg-${key}` });
    const value = el('text', { x: n.x, y: n.y + 13, 'text-anchor': 'middle', class: 'lg-sub' }, n.sub);
    g.append(
      el('rect', { x: n.x - 62, y: n.y - 24, width: 124, height: 48, rx: 10 }),
      el('text', { x: n.x, y: n.y - 4, 'text-anchor': 'middle', class: 'lg-label' }, n.label),
      value,
    );
    valueEls[key] = value;
    svg.append(g);
  }
}

// ---- Unrolled LSTM: force-directed canvas graph, updated every tick. ----
const unrollGraph = createUnrollGraph({
  canvas: document.getElementById('ug-canvas'),
  stage: document.getElementById('ug-stage'),
  tip: document.getElementById('ug-tip'),
});
document.getElementById('ug-in').addEventListener('click', () => unrollGraph.zoomBy(1.25));
document.getElementById('ug-out').addEventListener('click', () => unrollGraph.zoomBy(0.8));
document.getElementById('ug-reset').addEventListener('click', () => unrollGraph.reset());

function updateUnroll() {
  const { cache, yNorm, closes } = lastNet;
  unrollGraph.update(cache, yNorm, closes);
}

function updateGraph() {
  const { input, hPrev, cPrev, f, i, cTilde, o, c, h, yNorm, weights } = lastNet;
  const f2 = (v) => v.toFixed(2);
  const values = {
    x: `z=${f2(input)}`,
    hPrev: `h=${f2(hPrev)}`,
    cPrev: `c=${f2(cPrev)}`,
    f: `f=${f2(f)}`,
    i: `i=${f2(i)}`,
    c: `c̃=${f2(cTilde)}`,
    o: `o=${f2(o)}`,
    cNow: `c=${f2(c)}`,
    hNow: `h=${f2(h)}`,
    y: `ŷ=${f2(yNorm)}`,
  };
  for (const [k, text] of Object.entries(values)) valueEls[k].textContent = text;

  const w = {
    wf1: weights.wf[1], wf0: weights.wf[0], wi1: weights.wi[1], wi0: weights.wi[0],
    wc1: weights.wc[1], wc0: weights.wc[0], wo1: weights.wo[1], wo0: weights.wo[0], wy: weights.wy,
  };
  for (const e of edgeEls) {
    if (!e.key) continue;
    e.label.textContent = `w=${w[e.key].toFixed(2)}`;
    e.line.setAttribute('stroke-width', String(1 + Math.min(4, Math.abs(w[e.key]) * 4)));
  }
}

buildGraph();

// ---- Live loop ----
function render() {
  const prevView = chart.view;
  const prevCount = chart.count();
  chart.setData(buildOptions(typeSelect.value));
  if (chart.count() === prevCount) chart.view = prevView;
}

async function tick() {
  if (busy) return;
  busy = true;
  const iv = INTERVAL;
  try {
    const fetched = await fetchCandles();
    if (iv !== INTERVAL) return; // timeframe changed mid-fetch; the queued recalc handles it
    candles = fetched;
    const closes = candles.map((c) => c.c);
    priceRange = {
      min: Math.min(...candles.map((c) => c.l)) * 0.9995,
      max: Math.max(...candles.map((c) => c.h)) * 1.0005,
    };
    if (!model) resetModel();
    forecast = trainAndForecast(closes, candles[candles.length - 1].time);
    predictions.set(candles[candles.length - 1].time + INTERVAL_MS[INTERVAL], forecast[0]);
    render();
    updateText();
    updateAccuracy();
    updateGraph();
    updateUnroll();
    statusEl.textContent = `Live · updated ${new Date().toLocaleTimeString()} · ${candles.length} × ${INTERVAL} candles`;
    liveEl.dataset.state = 'on'; // successful tick: clear any earlier error state
  } catch (err) {
    liveEl.dataset.state = 'error';
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    busy = false;
    if (recalcQueued) {
      recalcQueued = false;
      tick();
    }
  }
}

/** Retrain from scratch on the current settings; if a tick is running, run again once it finishes. */
function recalc() {
  if (busy) {
    recalcQueued = true;
    return;
  }
  tick();
}

typeSelect.addEventListener('change', () => {
  if (candles.length) render();
});

windowSelect.addEventListener('change', () => {
  WINDOW = Number(windowSelect.value);
  resetModel(); // a different window size needs a fresh model
  statusEl.textContent = `Window set to ${WINDOW}; retraining…`;
  recalc();
});

candlesSelect.addEventListener('change', () => {
  CANDLES = Number(candlesSelect.value);
  resetModel(); // the training set changes size, so start over
  statusEl.textContent = `Loading ${CANDLES} candles; retraining…`;
  recalc();
});

timeframeSelect.addEventListener('change', () => {
  INTERVAL = timeframeSelect.value;
  predictions.clear(); // predictions are only comparable within one timeframe
  resetModel();

  recalc();
});

tick();
setInterval(tick, TICK_MS);
