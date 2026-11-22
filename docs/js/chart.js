// 時間変化の折れ線グラフ（SVG）。
// 動画の現在位置を示すカーソルを持ち、グラフをなぞると onScrub(秒) を呼ぶ。
// 色や線の太さは CSS 側（.chart ...）で決める。

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const node = document.createElementNS(NS, name);
  for (const key in attrs) node.setAttribute(key, attrs[key]);
  if (text != null) node.textContent = text;
  return node;
}

// 目盛りの間隔を 1・2・5 の倍数に丸める
function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

const trimNumber = (v, step) => (step < 1 ? v.toFixed(1) : String(Math.round(v)));

export class LineChart {
  /**
   * @param {SVGSVGElement} svg
   * @param {{ onScrub?: (t: number) => void }} options
   */
  constructor(svg, { onScrub } = {}) {
    this.svg = svg;
    this.onScrub = onScrub;
    this.data = null;
    this.scale = null;
    this.cursor = null;
    this.margin = { l: 46, r: 14, t: 24, b: 26 };
    this.clipId = `plot-${Math.random().toString(36).slice(2, 8)}`;

    new ResizeObserver(() => this.render()).observe(svg);

    let dragging = false;
    const scrub = (e) => {
      if (!this.scale) return;
      const x = e.clientX - svg.getBoundingClientRect().left;
      this.onScrub?.(this.scale.invX(x));
    };
    svg.addEventListener('pointerdown', (e) => {
      if (!this.scale) return;
      dragging = true;
      svg.setPointerCapture?.(e.pointerId);
      scrub(e);
    });
    svg.addEventListener('pointermove', (e) => { if (dragging) scrub(e); });
    const end = () => { dragging = false; };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }

  /**
   * data = {
   *   domain: [開始秒, 終了秒],
   *   series: [{ id: 'a' | 'b', points: [[秒, 値 | null], ...] }],
   *   markers: [{ t, label, side: 'left' | 'right' }],
   *   format: (値) => 目盛りの文字,
   *   minSpan: 縦軸の最小の幅,
   * }
   */
  setData(data) {
    this.data = data;
    this.render();
  }

  render() {
    const { svg, margin: m } = this;
    const W = svg.clientWidth, H = svg.clientHeight;
    svg.replaceChildren();
    this.scale = null;
    this.cursor = null;
    if (!W || !H) return;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const data = this.data;
    if (!data) return;

    const [x0, x1] = data.domain;
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    if (!(x1 > x0) || pw <= 0 || ph <= 0) return;

    let lo = Infinity, hi = -Infinity;
    for (const s of data.series) {
      for (const [t, v] of s.points) {
        if (v == null || t < x0 || t > x1) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!Number.isFinite(lo)) {
      svg.append(el('text', { class: 'empty', x: W / 2, y: H / 2, 'text-anchor': 'middle' }, 'この範囲では読み取れませんでした'));
      return;
    }
    const minSpan = data.minSpan ?? 1;
    if (hi - lo < minSpan) {
      const c = (hi + lo) / 2;
      lo = c - minSpan / 2;
      hi = c + minSpan / 2;
    }
    const yStep = niceStep((hi - lo) / 4);
    const y0 = Math.floor(lo / yStep + 1e-9) * yStep;
    const y1 = Math.ceil(hi / yStep - 1e-9) * yStep;

    const sx = (t) => m.l + ((t - x0) / (x1 - x0)) * pw;
    const sy = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * ph;
    const invX = (x) => Math.min(x1, Math.max(x0, x0 + ((x - m.l) / pw) * (x1 - x0)));
    this.scale = { sx, sy, invX, x0, x1 };

    // 横の目盛り線と縦軸の数字
    for (let v = y0; v <= y1 + yStep * 1e-6; v += yStep) {
      const y = sy(v);
      svg.append(el('line', { class: v === y0 ? 'axis' : 'grid', x1: m.l, x2: W - m.r, y1: y, y2: y }));
      svg.append(el('text', { class: 'tick', x: m.l - 8, y: y + 4, 'text-anchor': 'end' }, data.format(v)));
    }

    // 横軸（秒）
    const xStep = niceStep((x1 - x0) / 6);
    const ticks = [];
    for (let t = Math.ceil(x0 / xStep - 1e-9) * xStep; t <= x1 + xStep * 1e-6; t += xStep) ticks.push(t);
    ticks.forEach((t, i) => {
      const label = trimNumber(t, xStep) + (i === ticks.length - 1 ? '秒' : '');
      svg.append(el('text', { class: 'tick', x: sx(t), y: H - 7, 'text-anchor': 'middle' }, label));
    });

    // トロフィーポーズ・インパクトの目印
    for (const mark of data.markers ?? []) {
      if (mark.t < x0 || mark.t > x1) continue;
      const x = sx(mark.t);
      svg.append(el('line', { class: 'mark', x1: x, x2: x, y1: m.t, y2: m.t + ph }));
      const width = mark.label.length * 11.5;
      let left = mark.side === 'left';
      if (left && x - 4 - width < 0) left = false;
      if (!left && x + 4 + width > W) left = true;
      svg.append(el('text', {
        class: 'mark-label', x: left ? x - 4 : x + 4, y: m.t - 8, 'text-anchor': left ? 'end' : 'start',
      }, mark.label));
    }

    // 折れ線（値が欠けた所で線を切る）
    const defs = el('defs');
    const clip = el('clipPath', { id: this.clipId });
    clip.append(el('rect', { x: m.l, y: m.t - 2, width: pw, height: ph + 4 }));
    defs.append(clip);
    svg.append(defs);
    for (const s of data.series) {
      let d = '', pen = false;
      for (const [t, v] of s.points) {
        if (v == null) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${sx(t).toFixed(1)} ${sy(v).toFixed(1)}`;
        pen = true;
      }
      svg.append(el('path', { class: `line s-${s.id}`, d, 'clip-path': `url(#${this.clipId})` }));
    }

    // 現在位置のカーソル
    const group = el('g', { class: 'cursor', visibility: 'hidden' });
    const line = el('line', { y1: m.t, y2: m.t + ph });
    group.append(line);
    const dots = {};
    for (const s of data.series) {
      dots[s.id] = el('circle', { class: `dot s-${s.id}`, r: 5 });
      group.append(dots[s.id]);
    }
    svg.append(group);
    this.cursor = { group, line, dots };
    if (this.last) this.setCursor(this.last.t, this.last.values);
  }

  /** カーソルを時刻 t に置く。values は { a: 値, b: 値 }（null なら点を出さない） */
  setCursor(t, values = {}) {
    this.last = { t, values };
    const { cursor, scale } = this;
    if (!cursor || !scale) return;
    if (t == null || t < scale.x0 || t > scale.x1) {
      cursor.group.setAttribute('visibility', 'hidden');
      return;
    }
    const x = scale.sx(t);
    cursor.group.setAttribute('visibility', 'visible');
    cursor.line.setAttribute('x1', x);
    cursor.line.setAttribute('x2', x);
    for (const id in cursor.dots) {
      const dot = cursor.dots[id];
      const v = values[id];
      if (v == null) {
        dot.setAttribute('visibility', 'hidden');
      } else {
        dot.setAttribute('visibility', 'inherit');
        dot.setAttribute('cx', x);
        dot.setAttribute('cy', scale.sy(v));
      }
    }
  }
}
