/**
 * Force-directed canvas graph of the unrolled LSTM, adapted from bzui/examples/network-graph.
 * Each window step has an input node and a cell node; cells are linked by their c and h state,
 * and the last cell feeds the forecast node. Node positions are kept by id across updates, so
 * the layout stays put while the model trains. Nodes can be dragged, the background panned,
 * and the wheel or buttons zoom around the cursor or the view centre.
 */
const MIN_SCALE = 0.05;
const MAX_SCALE = 4;
const SPACING = 150;
const REPULSION = 5000;
const REST_LENGTH = 130;
const SPRING = 0.05;
const GRAVITY = 0.002;
const MAX_SPEED = 25;
const ALPHA_DECAY = 0.985;
const ALPHA_MIN = 0.002;
const ACCENT = '#2563eb';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const f2 = (v) => v.toFixed(2);

function readColors(canvas) {
  const cs = getComputedStyle(canvas);
  const token = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    text: token('--bz-text', '#0f172a'),
    muted: token('--bz-text-muted', '#64748b'),
    bg: token('--bz-surface', '#ffffff'),
    font: cs.fontFamily,
  };
}

export function createUnrollGraph({ canvas, stage, tip }) {
  const ctx = canvas.getContext('2d');
  const view = { scale: 1, panX: 0, panY: 0 };
  let nodes = [];
  let links = [];
  let byId = new Map();
  let width = 0;
  let height = 0;
  let dpr = 1;
  let alpha = 1;
  let userView = false;
  let hovered = null;
  let dragNode = null;
  let dragOffset = { x: 0, y: 0 };
  let panState = null;
  let colors = readColors(canvas);

  function toWorld(px, py) {
    return { x: (px - width / 2 - view.panX) / view.scale, y: (py - height / 2 - view.panY) / view.scale };
  }

  function toScreen(x, y) {
    return { x: x * view.scale + width / 2 + view.panX, y: y * view.scale + height / 2 + view.panY };
  }

  function localPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function hitTest(px, py) {
    const w = toWorld(px, py);
    const pad = 4 / view.scale;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const reach = n.r + pad;
      const dx = n.x - w.x;
      const dy = n.y - w.y;
      if (dx * dx + dy * dy <= reach * reach) return n;
    }
    return null;
  }

  function zoomAt(factor, px, py) {
    const next = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
    const ratio = next / view.scale;
    view.panX = px - width / 2 - (px - width / 2 - view.panX) * ratio;
    view.panY = py - height / 2 - (py - height / 2 - view.panY) * ratio;
    view.scale = next;
    userView = true;
  }

  /** Scales and centres the graph so every node fits the canvas (never zooms in past 100%). */
  function fit() {
    if (!nodes.length || !width) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x - n.r);
      maxX = Math.max(maxX, n.x + n.r);
      minY = Math.min(minY, n.y - n.r - 40);
      maxY = Math.max(maxY, n.y + n.r + 40);
    }
    // Horizontal margin of 120 leaves room for the node labels, which are wider than the circles.
    const s = clamp(Math.min(width / (maxX - minX + 120), height / (maxY - minY + 40)), MIN_SCALE, 1);
    view.scale = s;
    view.panX = -((minX + maxX) / 2) * s;
    view.panY = -((minY + maxY) / 2) * s;
  }

  function build(cache, yNorm, closes) {
    const next = new Map();
    const put = (id, spec, x, y) => {
      const node = byId.get(id) ?? { id, x, y, vx: 0, vy: 0, fixed: false };
      Object.assign(node, spec);
      next.set(id, node);
      return node;
    };

    const list = [];
    const edges = [];
    let prevCell = null;
    // Seed the chain centred on the origin so gravity (toward x = 0) does not drag it sideways.
    const offset = (cache.length * SPACING) / 2;
    cache.forEach((s, t) => {
      const x = t * SPACING - offset;
      const input = put(`x${t}`, {
        kind: 'input', r: 14, label: `x${t + 1}`, sub: `z=${f2(s.x)}`,
        info: [`Input, step ${t + 1}`, `z = ${f2(s.x)}`, `close = ${closes[t].toFixed(2)} USDT`],
      }, x, -110);
      const cell = put(`c${t}`, {
        kind: 'cell', r: 30, label: `step ${t + 1}`, sub: `h=${f2(s.h)}`,
        info: [
          `LSTM cell, step ${t + 1}`,
          `forget f = ${f2(s.f)}`,
          `input i = ${f2(s.i)}`,
          `candidate c̃ = ${f2(s.cTilde)}`,
          `output o = ${f2(s.o)}`,
          `cell c = ${f2(s.c)}`,
          `hidden h = ${f2(s.h)}`,
        ],
      }, x, 0);
      list.push(input, cell);
      edges.push({ a: input, b: cell, kind: 'in' });
      if (prevCell) edges.push({ a: prevCell, b: cell, kind: 'state' });
      prevCell = cell;
    });

    const out = put('y', {
      kind: 'out', r: 26, label: 'forecast ŷ', sub: f2(yNorm),
      info: ['Forecast ŷ (normalized)', `ŷ = ${f2(yNorm)}`],
    }, cache.length * SPACING - offset, 0);
    list.push(out);
    if (prevCell) edges.push({ a: prevCell, b: out, kind: 'state' });

    const countChanged = next.size !== byId.size;
    nodes = list;
    links = edges;
    byId = next;
    if (hovered && !byId.has(hovered.id)) hovered = null;
    if (countChanged && !userView) fit();
    alpha = Math.max(alpha, 0.2);
  }

  function simulate() {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const minDist = a.r + b.r + 16;
        let f = REPULSION / d2;
        if (d < minDist) f += (minDist - d) * 0.5;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    for (const l of links) {
      const dx = l.b.x - l.a.x;
      const dy = l.b.y - l.a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d - REST_LENGTH) * SPRING;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      l.a.vx += fx;
      l.a.vy += fy;
      l.b.vx -= fx;
      l.b.vy -= fy;
    }

    for (const n of nodes) {
      n.vx -= n.x * GRAVITY;
      n.vy -= n.y * GRAVITY;
      if (n.fixed) {
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.vx = clamp(n.vx, -MAX_SPEED, MAX_SPEED);
      n.vy = clamp(n.vy, -MAX_SPEED, MAX_SPEED);
      n.x += n.vx * alpha;
      n.y += n.vy * alpha;
      n.vx *= 0.6;
      n.vy *= 0.6;
    }
    if (!dragNode) alpha *= ALPHA_DECAY;
  }

  function drawArrow(bx, by, ux, uy) {
    const px = -uy;
    const py = ux;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - 10 * ux + 5 * px, by - 10 * uy + 5 * py);
    ctx.lineTo(bx - 10 * ux - 5 * px, by - 10 * uy - 5 * py);
    ctx.closePath();
    ctx.fill();
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = 'round';

    for (const l of links) {
      const active = hovered !== null && (l.a === hovered || l.b === hovered);
      const a = toScreen(l.a.x, l.a.y);
      const b = toScreen(l.b.x, l.b.y);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const color = active ? ACCENT : colors.muted;
      ctx.globalAlpha = hovered && !active ? 0.25 : 0.7;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.5 * Math.sqrt(view.scale);
      const tipR = l.b.r * view.scale + 2;
      ctx.beginPath();
      ctx.moveTo(a.x + ux * l.a.r * view.scale, a.y + uy * l.a.r * view.scale);
      ctx.lineTo(b.x - ux * tipR, b.y - uy * tipR);
      ctx.stroke();
      drawArrow(b.x - ux * tipR, b.y - uy * tipR, ux, uy);

      if (l.kind === 'state' && view.scale >= 0.4) {
        ctx.font = `600 11px ${colors.font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = color;
        ctx.fillText('c, h', (a.x + b.x) / 2, (a.y + b.y) / 2 - 4);
      }
    }

    for (const n of nodes) {
      const p = toScreen(n.x, n.y);
      const r = n.r * view.scale;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = n.kind === 'out' ? ACCENT : colors.bg;
      ctx.fill();
      ctx.lineWidth = n === hovered || n === dragNode ? 3 : 2;
      ctx.strokeStyle = n.kind === 'input' ? colors.muted : ACCENT;
      ctx.stroke();

      if (view.scale >= 0.4 || n === hovered) {
        ctx.font = `600 ${n === hovered ? 13 : 12}px ${colors.font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = colors.text;
        ctx.fillText(n.label, p.x, p.y + r + 4);
        ctx.font = `12px ${colors.font}`;
        ctx.fillStyle = ACCENT;
        ctx.fillText(n.sub, p.x, p.y + r + 20);
      }
    }
    ctx.globalAlpha = 1;
  }

  function frame() {
    const simulating = alpha > ALPHA_MIN || dragNode;
    if (simulating) simulate();
    // Follow the contracting chain while the layout settles, unless the user set the view.
    if (simulating && !dragNode && !userView) fit();
    draw();
    requestAnimationFrame(frame);
  }

  function showTip(node, clientX, clientY) {
    const heading = document.createElement('div');
    heading.className = 'bz-chart-tooltip-title';
    heading.textContent = node.info[0];
    tip.replaceChildren(heading, ...node.info.slice(1).map((text) => {
      const row = document.createElement('div');
      row.textContent = text;
      return row;
    }));
    tip.hidden = false;
    placeTip(clientX, clientY);
  }

  function placeTip(clientX, clientY) {
    tip.style.left = `${clientX + 14}px`;
    tip.style.top = `${clientY + 14}px`;
  }

  function hideTip() {
    tip.hidden = true;
  }

  canvas.addEventListener('pointerdown', (e) => {
    const p = localPoint(e);
    canvas.setPointerCapture(e.pointerId);
    const hit = hitTest(p.x, p.y);
    if (hit) {
      const w = toWorld(p.x, p.y);
      dragNode = hit;
      dragNode.fixed = true;
      dragOffset = { x: hit.x - w.x, y: hit.y - w.y };
      alpha = Math.max(alpha, 0.35);
      canvas.style.cursor = 'grabbing';
      hideTip();
    } else {
      panState = { x: p.x, y: p.y, panX: view.panX, panY: view.panY };
      canvas.style.cursor = 'grabbing';
      userView = true;
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = localPoint(e);
    if (dragNode) {
      const w = toWorld(p.x, p.y);
      dragNode.x = w.x + dragOffset.x;
      dragNode.y = w.y + dragOffset.y;
      dragNode.vx = 0;
      dragNode.vy = 0;
      alpha = Math.max(alpha, 0.35);
      return;
    }
    if (panState) {
      view.panX = panState.panX + (p.x - panState.x);
      view.panY = panState.panY + (p.y - panState.y);
      return;
    }
    const hit = hitTest(p.x, p.y);
    canvas.style.cursor = hit ? 'pointer' : 'grab';
    if (hit !== hovered) {
      hovered = hit;
      if (hovered) showTip(hovered, e.clientX, e.clientY);
      else hideTip();
    } else if (hovered) {
      placeTip(e.clientX, e.clientY);
    }
  });

  function endPointer(e) {
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (dragNode) {
      dragNode.fixed = false;
      dragNode = null;
    }
    panState = null;
    canvas.style.cursor = 'grab';
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('pointerleave', () => {
    if (dragNode || panState) return;
    hovered = null;
    hideTip();
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = localPoint(e);
    const lineScale = e.deltaMode === 1 ? 16 : 1;
    zoomAt(Math.exp(-e.deltaY * lineScale * 0.0015), p.x, p.y);
  }, { passive: false });

  function resize() {
    const rect = stage.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    if (!userView) fit();
  }
  new ResizeObserver(resize).observe(stage);
  new MutationObserver(() => { colors = readColors(canvas); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });

  requestAnimationFrame(frame);

  return {
    update(cache, yNorm, closes) {
      build(cache, yNorm, closes);
    },
    zoomBy(factor) {
      zoomAt(factor, width / 2, height / 2);
    },
    reset() {
      userView = false;
      fit();
    },
  };
}
