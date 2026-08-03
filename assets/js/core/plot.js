/* Canvas 圖表引擎。
   為什麼自己寫：七個 App 需要的是分布、扇形、瀑布、賽跑交叉點與區域地圖，
   通用圖表庫做這些反而要繞路，而且會拖進一包和本世界視覺無關的樣式。
   規則：格線是髮絲線、數字對齊、圖表結論同時以文字提供（不讓視覺是唯一通道）。 */

import { gsap, still } from './motion.js';

const css = (name, fallback) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};

export class Plot {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts { padding, xLabel, yLabel, xFormat, yFormat, aspect }
   */
  constructor(canvas, opts = {}) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = {
      padding: { top: 16, right: 16, bottom: 30, left: 56 },
      aspect: 0.56,
      minHeight: 200,
      maxHeight: 460,
      xFormat: (v) => String(Math.round(v)),
      yFormat: (v) => String(Math.round(v)),
      xTicks: 6,
      yTicks: 5,
      ...opts,
      padding: { top: 16, right: 16, bottom: 30, left: 56, ...(opts.padding || {}) },
    };
    this.series = [];
    this.marks = [];
    this.domain = null;
    this.cursor = null;
    this.dpr = 1;
    this._raf = 0;

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement || canvas);
    this._bindPointer();
    this.resize();

    this._onTheme = () => this.render();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', this._onTheme);
  }

  destroy() {
    this._ro.disconnect();
    window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', this._onTheme);
    cancelAnimationFrame(this._raf);
  }

  resize() {
    const host = this.c.parentElement || this.c;
    const w = Math.max(240, host.clientWidth);
    const h = Math.round(
      Math.min(this.opts.maxHeight, Math.max(this.opts.minHeight, w * this.opts.aspect))
    );
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.c.style.width = '100%';
    this.c.style.height = h + 'px';
    this.c.width = Math.round(w * this.dpr);
    this.c.height = Math.round(h * this.dpr);
    this.w = w; this.h = h;
    // 窄螢幕縮小左側刻度區，否則圖面被吃掉
    this.pad = { ...this.opts.padding };
    if (w < 420) { this.pad.left = Math.min(this.pad.left, 44); this.pad.right = 10; }
    this.render();
  }

  /** @param {Array} series 每筆 { type, data, color, width, dash, fill, label, hidden } */
  setSeries(series, { animate = true } = {}) {
    const prev = this.series;
    this.series = series;
    if (animate && !still() && prev.length && prev.length === series.length) {
      this._morph(prev, series);
    } else {
      this.autoDomain();
      this.render();
    }
    return this;
  }

  setMarks(marks) { this.marks = marks || []; this.render(); return this; }

  setDomain(d) { this.domain = d; this.render(); return this; }

  /** 資料換形狀時，讓柱子／線像被重新流動地成形，而不是硬切。 */
  _morph(from, to) {
    const same = from.every((s, i) => s.data.length === to[i].data.length);
    if (!same) { this.autoDomain(); this.render(); return; }
    const startDomain = this.domain ? { ...this.domain } : null;
    this.series = to.map((s, i) => ({ ...s, data: from[i].data.map((p) => ({ ...p })) }));
    this.autoDomain();
    const endDomain = { ...this.domain };
    if (startDomain) this.domain = { ...startDomain };
    const o = { t: 0 };
    gsap.killTweensOf(o);
    gsap.to(o, {
      t: 1, duration: 0.5, ease: 'power2.out',
      onUpdate: () => {
        const t = o.t;
        this.series.forEach((s, i) => {
          const a = from[i].data, b = to[i].data;
          for (let k = 0; k < s.data.length; k++) {
            s.data[k].x = a[k].x + (b[k].x - a[k].x) * t;
            s.data[k].y = a[k].y + (b[k].y - a[k].y) * t;
            if (a[k].y1 != null && b[k].y1 != null) s.data[k].y1 = a[k].y1 + (b[k].y1 - a[k].y1) * t;
          }
        });
        if (startDomain) {
          this.domain = {
            x0: startDomain.x0 + (endDomain.x0 - startDomain.x0) * t,
            x1: startDomain.x1 + (endDomain.x1 - startDomain.x1) * t,
            y0: startDomain.y0 + (endDomain.y0 - startDomain.y0) * t,
            y1: startDomain.y1 + (endDomain.y1 - startDomain.y1) * t,
          };
        }
        this.render();
      },
      onComplete: () => { this.series = to; this.autoDomain(); this.render(); },
    });
  }

  autoDomain() {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of this.series) {
      if (s.hidden || !s.data || !s.data.length) continue;
      for (const p of s.data) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
        const lo = Math.min(p.y, p.y1 ?? p.y);
        const hi = Math.max(p.y, p.y1 ?? p.y);
        if (lo < y0) y0 = lo; if (hi > y1) y1 = hi;
      }
    }
    if (!Number.isFinite(x0)) { x0 = 0; x1 = 1; y0 = 0; y1 = 1; }
    if (x0 === x1) { x0 -= 0.5; x1 += 0.5; }
    if (y0 === y1) { y0 -= Math.abs(y0) * 0.05 || 1; y1 += Math.abs(y1) * 0.05 || 1; }

    // 先決定基準（是否壓到零），再依「最終」範圍留白。
    // 順序顛倒的話，一條水平線的原始範圍是 0，留白也會是 0，線就會貼在畫面最上緣。
    const forceZero = this.opts.zeroBase !== false;
    const base = forceZero && y0 > 0 ? 0 : y0;
    const padY = (y1 - base) * 0.08 || 1;
    this.domain = {
      x0, x1,
      y0: forceZero && y0 > 0 ? 0 : base - padY,
      y1: y1 + padY,
    };
    return this.domain;
  }

  sx(v) {
    const { x0, x1 } = this.domain;
    return this.pad.left + ((v - x0) / (x1 - x0)) * (this.w - this.pad.left - this.pad.right);
  }
  sy(v) {
    const { y0, y1 } = this.domain;
    return this.h - this.pad.bottom - ((v - y0) / (y1 - y0)) * (this.h - this.pad.top - this.pad.bottom);
  }
  ix(px) {
    const { x0, x1 } = this.domain;
    return x0 + ((px - this.pad.left) / (this.w - this.pad.left - this.pad.right)) * (x1 - x0);
  }

  render() {
    if (!this.domain) this.autoDomain();
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    const inkFaint = css('--rule-faint', '#E0E0D8');
    const rule = css('--rule', '#C6C6BE');
    const ink3 = css('--ink-3', '#5F656C');

    const L = this.pad.left, R = this.w - this.pad.right;
    const T = this.pad.top, B = this.h - this.pad.bottom;

    // 格線
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = inkFaint;
    ctx.font = `500 10px ${css('--font-mono', 'monospace')}`;
    ctx.fillStyle = ink3;

    const yt = niceTicks(this.domain.y0, this.domain.y1, this.opts.yTicks);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of yt) {
      const y = Math.round(this.sy(v)) + 0.5;
      if (y < T - 1 || y > B + 1) continue;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke();
      ctx.fillText(this.opts.yFormat(v), L - 6, y);
    }

    const xt = this.opts.xTickValues || niceTicks(this.domain.x0, this.domain.x1, this.opts.xTicks);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const v of xt) {
      const x = Math.round(this.sx(v)) + 0.5;
      if (x < L - 1 || x > R + 1) continue;
      ctx.strokeStyle = inkFaint;
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, B); ctx.stroke();
      ctx.fillText(this.opts.xFormat(v), x, B + 6);
    }

    // 軸線
    ctx.strokeStyle = rule;
    ctx.beginPath();
    ctx.moveTo(L + 0.5, T); ctx.lineTo(L + 0.5, B + 0.5); ctx.lineTo(R, B + 0.5);
    ctx.stroke();

    // 零線
    if (this.domain.y0 < 0 && this.domain.y1 > 0) {
      const y = Math.round(this.sy(0)) + 0.5;
      ctx.strokeStyle = css('--rule-strong', '#9B9B92');
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke();
    }
    ctx.restore();

    // 資料
    ctx.save();
    ctx.beginPath(); ctx.rect(L, T - 4, R - L, B - T + 8); ctx.clip();
    for (const s of this.series) {
      if (s.hidden || !s.data || !s.data.length) continue;
      switch (s.type) {
        case 'band': this._band(s); break;
        case 'area': this._area(s); break;
        case 'bars': this._bars(s); break;
        case 'stack': this._stack(s); break;
        case 'points': this._points(s); break;
        case 'step': this._line(s, true); break;
        default: this._line(s, false);
      }
    }
    ctx.restore();

    // 標記線
    for (const m of this.marks) this._mark(m);

    // 游標
    if (this.cursor != null) this._crosshair();
  }

  _stroke(s) {
    const ctx = this.ctx;
    ctx.lineWidth = s.width || 2;
    ctx.strokeStyle = s.color || css('--series-1', '#123A72');
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    ctx.globalAlpha = s.alpha ?? 1;
    if (s.dash) ctx.setLineDash(s.dash); else ctx.setLineDash([]);
  }

  _line(s, step) {
    const ctx = this.ctx;
    this._stroke(s);
    ctx.beginPath();
    let started = false;
    let px = 0, py = 0;
    for (const p of s.data) {
      if (!Number.isFinite(p.y)) { started = false; continue; }
      const x = this.sx(p.x), y = this.sy(p.y);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else if (step) { ctx.lineTo(x, py); ctx.lineTo(x, y); }
      else ctx.lineTo(x, y);
      px = x; py = y;
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  _area(s) {
    const ctx = this.ctx;
    const base = this.sy(Math.max(this.domain.y0, 0));
    ctx.beginPath();
    let started = false;
    for (const p of s.data) {
      if (!Number.isFinite(p.y)) continue;
      const x = this.sx(p.x), y = this.sy(p.y);
      if (!started) { ctx.moveTo(x, base); ctx.lineTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    const last = s.data[s.data.length - 1];
    if (started && last) ctx.lineTo(this.sx(last.x), base);
    ctx.closePath();
    ctx.globalAlpha = s.fillAlpha ?? 0.16;
    ctx.fillStyle = s.color || css('--series-1', '#123A72');
    ctx.fill();
    ctx.globalAlpha = 1;
    if (s.line !== false) this._line(s, false);
  }

  /** 百分位帶：p.y = 下界, p.y1 = 上界 */
  _band(s) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < s.data.length; i++) {
      const p = s.data[i];
      const x = this.sx(p.x), y = this.sy(p.y1 ?? p.y);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    for (let i = s.data.length - 1; i >= 0; i--) {
      const p = s.data[i];
      ctx.lineTo(this.sx(p.x), this.sy(p.y));
    }
    ctx.closePath();
    ctx.globalAlpha = s.fillAlpha ?? 0.18;
    ctx.fillStyle = s.color || css('--series-1', '#123A72');
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  _bars(s) {
    const ctx = this.ctx;
    const n = s.data.length;
    const span = (this.w - this.pad.left - this.pad.right);
    const bw = Math.max(1, (span / Math.max(1, n)) * (s.barRatio ?? 0.86));
    const base = this.sy(Math.max(this.domain.y0, 0));
    for (const p of s.data) {
      if (!Number.isFinite(p.y)) continue;
      const x = this.sx(p.x) - bw / 2;
      const y = this.sy(p.y);
      ctx.fillStyle = p.color || s.color || css('--series-1', '#123A72');
      ctx.globalAlpha = p.alpha ?? s.alpha ?? 1;
      const top = Math.min(y, base), hh = Math.max(1, Math.abs(base - y));
      ctx.fillRect(Math.round(x), Math.round(top), Math.max(1, Math.round(bw)), Math.round(hh));
    }
    ctx.globalAlpha = 1;
  }

  /** 堆疊：p.y = 底, p.y1 = 頂 */
  _stack(s) {
    const ctx = this.ctx;
    const n = s.data.length;
    const span = (this.w - this.pad.left - this.pad.right);
    const bw = Math.max(1, (span / Math.max(1, n)) * (s.barRatio ?? 0.86));
    for (const p of s.data) {
      const x = this.sx(p.x) - bw / 2;
      const yTop = this.sy(p.y1), yBot = this.sy(p.y);
      ctx.fillStyle = p.color || s.color || css('--series-1', '#123A72');
      ctx.fillRect(Math.round(x), Math.round(yTop), Math.max(1, Math.round(bw)), Math.max(1, Math.round(yBot - yTop)));
    }
  }

  _points(s) {
    const ctx = this.ctx;
    ctx.fillStyle = s.color || css('--series-2', '#B4232C');
    const r = s.r || 3;
    for (const p of s.data) {
      if (!Number.isFinite(p.y)) continue;
      const x = this.sx(p.x), y = this.sy(p.y);
      ctx.beginPath();
      if (s.shape === 'square') ctx.rect(x - r, y - r, r * 2, r * 2);
      else ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** 標記：{ axis:'y'|'x', value, label, color, dash } */
  _mark(m) {
    const ctx = this.ctx;
    const color = m.color || css('--warn', '#8A5A00');
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(m.dash || [5, 4]);
    ctx.beginPath();
    if (m.axis === 'x') {
      const x = Math.round(this.sx(m.value)) + 0.5;
      ctx.moveTo(x, this.pad.top); ctx.lineTo(x, this.h - this.pad.bottom);
    } else {
      const y = Math.round(this.sy(m.value)) + 0.5;
      ctx.moveTo(this.pad.left, y); ctx.lineTo(this.w - this.pad.right, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    if (m.label) {
      ctx.font = `700 10px ${css('--font-cjk', 'sans-serif')}`;
      ctx.fillStyle = color;
      if (m.axis === 'x') {
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        const x = this.sx(m.value);
        const flip = x > this.w - 90;
        ctx.textAlign = flip ? 'right' : 'left';
        ctx.fillText(m.label, x + (flip ? -4 : 4), this.pad.top + 2);
      } else {
        ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText(m.label, this.pad.left + 4, this.sy(m.value) - 3);
      }
    }
    ctx.restore();
  }

  _crosshair() {
    const ctx = this.ctx;
    const x = Math.round(this.sx(this.cursor)) + 0.5;
    if (x < this.pad.left || x > this.w - this.pad.right) return;
    ctx.save();
    ctx.strokeStyle = css('--ink-3', '#5F656C');
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x, this.pad.top); ctx.lineTo(x, this.h - this.pad.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const s of this.series) {
      if (s.hidden || s.noCursor || !s.data.length) continue;
      const p = nearest(s.data, this.cursor);
      if (!p || !Number.isFinite(p.y)) continue;
      const y = this.sy(p.y);
      ctx.fillStyle = css('--sheet', '#fff');
      ctx.strokeStyle = s.color || css('--series-1', '#123A72');
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  _bindPointer() {
    const move = (e) => {
      const rect = this.c.getBoundingClientRect();
      const px = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      if (px < this.pad.left - 8 || px > this.w - this.pad.right + 8) { this.clearCursor(); return; }
      this.cursor = this.ix(px);
      this.render();
      this.onCursor?.(this.cursor, px);
    };
    this.c.addEventListener('pointermove', move);
    this.c.addEventListener('pointerdown', move);
    this.c.addEventListener('pointerleave', () => this.clearCursor());
    this.c.addEventListener('touchmove', move, { passive: true });
  }

  clearCursor() {
    if (this.cursor == null) return;
    this.cursor = null;
    this.render();
    this.onCursor?.(null);
  }
}

export function nearest(data, x) {
  if (!data.length) return null;
  let best = data[0], bd = Math.abs(data[0].x - x);
  for (let i = 1; i < data.length; i++) {
    const d = Math.abs(data[i].x - x);
    if (d < bd) { bd = d; best = data[i]; }
  }
  return best;
}

export function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const span = max - min;
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    out.push(Number(v.toFixed(10)));
  }
  return out;
}

/** 直方圖分箱 */
export function histogram(values, bins = 30, lo, hi) {
  const vs = values.filter(Number.isFinite);
  if (!vs.length) return { bins: [], lo: 0, hi: 1, width: 1 };
  const min = Number.isFinite(lo) ? lo : Math.min(...vs);
  const max = Number.isFinite(hi) ? hi : Math.max(...vs);
  const width = (max - min) / bins || 1;
  const counts = new Array(bins).fill(0);
  for (const v of vs) {
    let i = Math.floor((v - min) / width);
    if (i < 0) i = 0; if (i >= bins) i = bins - 1;
    counts[i]++;
  }
  return {
    bins: counts.map((n, i) => ({ x: min + width * (i + 0.5), y: n, x0: min + width * i, x1: min + width * (i + 1) })),
    lo: min, hi: max, width,
  };
}

export function quantile(sortedAsc, q) {
  const a = sortedAsc;
  if (!a.length) return NaN;
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
