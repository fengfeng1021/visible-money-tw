/* 招牌視覺縮圖。
   首頁不能只是一份文字清單 —— 訪客要在一眼之內看出每張單據長什麼樣子。
   這些是「形狀的草稿」，畫的是視覺的形式而不是任何一組真實數據，
   所以每一張都標為示意，避免被誤讀成績效或預測。 */

const css = (n, f) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f;

function frame(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 132;
  const h = canvas.clientHeight || 48;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  return { ctx, w, h };
}

const PAD = 4;

const SKETCH = {
  /** 房貸懸崖：平段 → 垂直跳升 → 平段 */
  cliff({ ctx, w, h }) {
    const y1 = h - PAD - 8, y2 = PAD + 6, x = w * 0.42;
    ctx.strokeStyle = css('--series-1', '#123A72');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PAD, y1); ctx.lineTo(x, y1); ctx.lineTo(x, y2); ctx.lineTo(w - PAD, y2);
    ctx.stroke();
    ctx.strokeStyle = css('--up', '#B4232C');
    ctx.setLineDash([2, 2]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, PAD); ctx.lineTo(x, h - PAD); ctx.stroke();
    ctx.setLineDash([]);
  },

  /** 預算天花板：現金流瀑布，最後一段沉到零線以下 */
  waterfall({ ctx, w, h }) {
    const base = h - PAD - 10;
    const bw = (w - PAD * 2) / 5 - 2;
    const tops = [PAD + 2, PAD + 8, PAD + 15, PAD + 21, base + 6];
    const bots = [base, PAD + 8, PAD + 15, PAD + 21, base];
    for (let i = 0; i < 5; i++) {
      const x = PAD + i * (bw + 2);
      const t = Math.min(tops[i], bots[i]), b = Math.max(tops[i], bots[i]);
      ctx.fillStyle = i === 4 ? css('--up', '#B4232C') : css('--series-1', '#123A72');
      ctx.globalAlpha = i === 4 ? 1 : 0.75;
      ctx.fillRect(x, t, bw, Math.max(3, b - t));
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = css('--rule-strong', '#9B9B92');
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD, base + 0.5); ctx.lineTo(w - PAD, base + 0.5); ctx.stroke();
  },

  /** 年金賽跑：三條線交叉 */
  race({ ctx, w, h }) {
    const L = PAD, R = w - PAD, B = h - PAD - 4, T = PAD + 2;
    const lines = [
      { c: css('--series-2', '#B4232C'), x0: 0.0, k: 0.62 },
      { c: css('--series-1', '#123A72'), x0: 0.18, k: 0.86 },
      { c: css('--series-3', '#0C6B44'), x0: 0.36, k: 1.16 },
    ];
    for (const ln of lines) {
      ctx.strokeStyle = ln.c; ctx.lineWidth = 1.6;
      ctx.beginPath();
      let started = false;
      for (let t = 0; t <= 1.001; t += 0.05) {
        if (t < ln.x0) continue;
        const x = L + t * (R - L);
        const v = (t - ln.x0) * ln.k;
        const y = B - Math.min(1, v) * (B - T);
        started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true);
      }
      ctx.stroke();
    }
  },

  /** 退休扇形：從一點展開的路徑束 */
  fan({ ctx, w, h }) {
    const L = PAD, R = w - PAD, mid = h / 2;
    ctx.strokeStyle = css('--series-1', '#123A72');
    ctx.lineWidth = 1;
    for (let i = -4; i <= 4; i++) {
      ctx.globalAlpha = 0.28;
      ctx.beginPath();
      ctx.moveTo(L, mid);
      const spread = (i / 4) * (h / 2 - PAD - 1);
      ctx.bezierCurveTo(L + (R - L) * 0.4, mid + spread * 0.25, L + (R - L) * 0.7, mid + spread * 0.8, R, mid + spread);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = css('--up', '#B4232C');
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(L, mid);
    ctx.bezierCurveTo(L + (R - L) * 0.4, mid + 6, L + (R - L) * 0.7, mid + 16, R, h - PAD - 1);
    ctx.stroke();
  },

  /** ETF 分布：直方圖 */
  hist({ ctx, w, h }) {
    const n = 13, base = h - PAD - 2;
    const bw = (w - PAD * 2) / n;
    for (let i = 0; i < n; i++) {
      const t = (i - (n - 1) / 2) / ((n - 1) / 2);
      const v = Math.exp(-t * t * 2.2);
      const hh = v * (h - PAD * 2 - 6);
      ctx.fillStyle = css('--series-1', '#123A72');
      ctx.globalAlpha = 0.35 + v * 0.5;
      ctx.fillRect(PAD + i * bw, base - hh, Math.max(1, bw - 1.5), hh);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = css('--up', '#B4232C');
    ctx.setLineDash([2, 2]); ctx.lineWidth = 1;
    const mx = PAD + ((n - 1) / 2) * bw + bw / 2;
    ctx.beginPath(); ctx.moveTo(mx, PAD); ctx.lineTo(mx, base); ctx.stroke();
    ctx.setLineDash([]);
  },

  /** 稅務地圖：兩塊區域與一條有折點的分界線 */
  map({ ctx, w, h }) {
    const L = PAD, R = w - PAD, T = PAD, B = h - PAD;
    const kink = L + (R - L) * 0.55;
    const path = new Path2D();
    path.moveTo(L, B - (B - T) * 0.22);
    path.lineTo(kink, B - (B - T) * 0.55);
    path.lineTo(R, B - (B - T) * 0.66);
    // 上區
    const upper = new Path2D(path);
    upper.lineTo(R, T); upper.lineTo(L, T); upper.closePath();
    ctx.fillStyle = css('--accent', '#123A72'); ctx.globalAlpha = 0.16; ctx.fill(upper);
    // 下區
    const lower = new Path2D(path);
    lower.lineTo(R, B); lower.lineTo(L, B); lower.closePath();
    ctx.fillStyle = css('--warn', '#8A5A00'); ctx.globalAlpha = 0.16; ctx.fill(lower);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = css('--ink-2', '#454A50'); ctx.lineWidth = 1.4; ctx.stroke(path);
    ctx.fillStyle = css('--up', '#B4232C');
    ctx.beginPath(); ctx.arc(kink, B - (B - T) * 0.55, 2.4, 0, Math.PI * 2); ctx.fill();
  },

  /** 除息：柱子被切掉一塊，那一塊飛向右邊 */
  cut({ ctx, w, h }) {
    const base = h - PAD - 2;
    const bx = PAD + 4, bw = 16;
    const cutY = PAD + 10;
    ctx.fillStyle = css('--series-1', '#123A72');
    ctx.fillRect(bx, cutY, bw, base - cutY);
    ctx.fillStyle = css('--down', '#0C6B44');
    ctx.fillRect(bx + 34, PAD + 2, bw, 8);
    ctx.strokeStyle = css('--rule-strong', '#9B9B92');
    ctx.setLineDash([2, 2]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(bx, PAD + 2.5); ctx.lineTo(bx + bw, PAD + 2.5); ctx.stroke();
    ctx.setLineDash([]);
    // 錢包
    ctx.strokeStyle = css('--ink-2', '#454A50'); ctx.lineWidth = 1.4;
    ctx.strokeRect(w - PAD - 22, base - 16, 20, 14);
    ctx.beginPath(); ctx.moveTo(w - PAD - 22, base - 11); ctx.lineTo(w - PAD - 2, base - 11); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx + bw + 24, PAD + 6); ctx.lineTo(w - PAD - 24, base - 14); ctx.stroke();
    ctx.strokeStyle = css('--rule-strong', '#9B9B92');
    ctx.beginPath(); ctx.moveTo(PAD, base + 0.5); ctx.lineTo(w - PAD, base + 0.5); ctx.stroke();
  },
};

export function drawThumb(canvas, kind) {
  const fn = SKETCH[kind];
  if (!fn || !canvas) return;
  const draw = () => { const f = frame(canvas); fn(f); };
  draw();
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', draw);
  new ResizeObserver(draw).observe(canvas);
}
