window.addEventListener('error', (e) => { window.__err = String(e.message); });

import { gsap, EASE, printRows, stampIn, makeCounter, carbonTransfer, still } from '../../assets/js/core/motion.js';
import { Plot, niceTicks, histogram, quantile } from '../../assets/js/core/plot.js';
import { createStore } from '../../assets/js/core/state.js';
import {
  $, $$, el, bindSlider, bindField, bindSegmented,
  mountTopbar, mountShare, mountTheme, toast, formulaBlock,
} from '../../assets/js/core/ui.js';
import { int, dec, money, pct, pp, parseNum, clamp } from '../../assets/js/core/format.js';
import { blockBootstrap, mean, stdev } from '../../assets/js/core/fin.js';

/* ==========================================================================
   1. 常數與狀態
   常數一律外部化到 rules.json：法規會變，模型假設更是必須被使用者看見並改掉。
   年度報酬序列則來自共用的 assets/data/tw-returns.json，不在這裡複製一份。
   ========================================================================== */
let RULES = { version: '未載入', legal: [], series: [], assumptions: [], refusals: [] };
let DATA = null;          // tw-returns.json；載不進來時歷史模式退回拒答
const BLOCK = 3;          // 區塊拔靴的區塊長度（年）

const DEFAULTS = () => ({
  assets: 12000000,
  spend: 70000,
  ageRetire: 65,
  ageEnd: 90,
  penLabor: 18000,
  penRetire: 8000,
  cpiLabor: true,      // 勞保條例 65-4：CPI 累計成長率達 ±5% 即調整
  cpiRetire: false,    // 勞退條例 23：依年金生命表計算，條文未設物價連動
  stock: 55,
  bond: 30,
  strategy: 'fixed',
  infl: 2,
  crashOn: false,
  crashDepth: -45,
  mode: 'normal',
  pool: 'taiex',       // 歷史模式的股票抽樣池：台股 22 年 / S&P 500 98 年
  inflMode: 'fixed',   // 通膨：固定值 / 抽台灣 CPI 30 年
  precise: false,
  // 報酬假設（百分點）。全部 unverified，使用者可在「攤開改」裡覆寫。
  mus: 7, sigs: 18, mub: 2.5, sigb: 6, muc: 1.3, rho: 0.15,
});

const store = createStore('vm:retire-fan', DEFAULTS());
const S = () => store.get();

/* ==========================================================================
   2. 版面掛載
   ========================================================================== */
mountTopbar({ title: '退休提領存活扇形' });
const actions = $('#sheetActions');
mountShare(actions, store);
mountTheme(actions);

const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* ==========================================================================
   3. 模擬核心：跑在 Web Worker 裡
   沒有建置步驟，所以 worker 用 Blob URL 建。函式先 toString 再包起來，
   這樣它在編輯器裡仍然是真的程式碼，不是一坨字串。
   worker 內不能 import 共用模組，mulberry32 / gauss 只好各留一份；
   blockBootstrap 則是把 core/fin.js 匯入的那一份原封不動注入進去，
   兩邊不會各寫錯一次。
   ========================================================================== */
function workerMain() {
  /* 可重現的偽隨機：同一組情境每次跑出同一張圖，使用者才信得過 */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rand) {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* 大跌形狀等比縮放：Π(1+s_i)^k = 1+D，解出 k，形狀不變、累計跌幅精確命中 */
  function scaleCrash(shape, depth) {
    let ln = 0;
    for (const s of shape) ln += Math.log(1 + s);
    const k = ln === 0 ? 0 : Math.log(1 + depth) / ln;
    return shape.map((s) => Math.pow(1 + s, k) - 1);
  }

  /** 這一條路徑的通膨序列：固定值就是一條水平線，CPI 模式則同樣用區塊拔靴抽 */
  function inflSeq(rand, c, n) {
    const out = new Float64Array(n);
    if (c.cpiPool) {
      const s = blockBootstrap(c.cpiPool, n, c.blockLen, rand);
      for (let t = 0; t < n; t++) out[t] = s[t];
    } else {
      out.fill(c.infl);
    }
    return out;
  }

  /**
   * 單一路徑的逐年遞推。
   * 期末餘額 = (期初餘額 − 當年淨提領) × (1 + r_t)
   * 名目支出_t = 月支出 × 12 × Π(1+π_k)，k < t
   * 當年淨提領 = 名目支出_t − 年金_t（年金是否隨通膨調整由使用者指定）
   *
   * 報酬有兩種來源：
   *   normal    ─ 股債相關的二維常態，μ／σ／ρ 全是模型假設
   *   bootstrap ─ 從 bundled 的歷史年度序列做區塊拔靴（block = 3 年）。
   *               股與債抽同一組年度索引，所以股債的共動關係直接來自歷史，不用 ρ。
   */
  function simPath(seed, c, capture) {
    const rand = mulberry32(seed);
    const n = c.years;
    const real = new Float64Array(n + 1);
    real[0] = c.assets0;
    let bal = c.assets0;
    let ruinYear = -1;
    const rootRho = Math.sqrt(Math.max(0, 1 - c.rho * c.rho));
    const rets = capture ? [] : null;
    const income = capture ? [] : null;

    // 首年淨提領率：動態護欄的基準
    const pen0 = (c.penLabor + c.penRetire) * 12;
    const w0 = Math.max(0, c.spend0 - pen0) / c.assets0;

    // 歷史模式：先抽出這一條路徑要走的 n 個歷史年度（同一組索引給股與債）
    let hi = null;
    if (c.boot) hi = blockBootstrap(c.poolIdx, n, c.blockLen, rand);

    const inf = inflSeq(rand, c, n);
    let cum = 1;                          // 累積通膨因子 Π(1+π_k)

    for (let t = 0; t < n; t++) {
      const infFac = cum;
      const nominalSpend = c.spend0 * infFac;
      const pen = c.penLabor * 12 * (c.cpiLabor ? infFac : 1)
                + c.penRetire * 12 * (c.cpiRetire ? infFac : 1);
      let draw = Math.max(0, nominalSpend - pen);

      // 動態護欄（Guyton-Klinger 簡化版）
      if (c.strategy === 'guardrail' && t > 0 && bal > 0 && w0 > 0) {
        const wr = draw / bal;
        if (wr > w0 * c.guardUp) draw *= (1 - c.guardCut);
        else if (wr < w0 * c.guardLo) draw *= (1 + c.guardRaise);
      }

      let rs, rb;
      if (c.boot) {
        const k = hi[t];
        rs = c.stockPool[k];
        rb = c.bondPool[k];
      } else {
        const z1 = gauss(rand), z2 = gauss(rand);
        rs = c.mus + c.sigs * z1;
        rb = c.mub + c.sigb * (c.rho * z1 + rootRho * z2);
      }
      // 順序風險：前五年強制套用（歷史模式套真實最差 5 年，含當年的債券報酬）
      if (c.crashR && t < c.crashR.length) {
        rs = c.crashR[t];
        if (c.crashB) rb = c.crashB[t];
      }
      const r = c.ws * rs + c.wb * rb + c.wc * c.muc;
      if (rets) rets.push(r);

      const afterDraw = bal - draw;
      if (income) {
        income.push({
          age: c.ageRetire + t,
          pension: pen / infFac,
          withdraw: Math.min(draw, Math.max(0, bal)) / infFac,
        });
      }
      cum *= (1 + inf[t]);
      if (afterDraw <= 0) {
        ruinYear = t;                      // 這一年錢不夠付當年支出
        for (let k = t + 1; k <= n; k++) real[k] = 0;
        bal = 0;
        break;
      }
      bal = afterDraw * (1 + r);
      if (bal < 0) bal = 0;
      real[t + 1] = bal / cum;
      if (bal === 0) { ruinYear = t; for (let k = t + 2; k <= n; k++) real[k] = 0; break; }
    }
    return { real, ruinYear, rets, income, inf: capture ? Array.from(inf) : null };
  }

  /** 用一組給定的報酬序列走一次（順序風險對照用：同一組報酬與同一組通膨，只有報酬順序不同） */
  function walk(rets, inf, c) {
    const n = c.years;
    const out = new Float64Array(n + 1);
    out[0] = c.assets0;
    let bal = c.assets0;
    const pen0 = (c.penLabor + c.penRetire) * 12;
    const w0 = Math.max(0, c.spend0 - pen0) / c.assets0;
    let cum = 1;
    for (let t = 0; t < n; t++) {
      const infFac = cum;
      const pen = c.penLabor * 12 * (c.cpiLabor ? infFac : 1)
                + c.penRetire * 12 * (c.cpiRetire ? infFac : 1);
      let draw = Math.max(0, c.spend0 * infFac - pen);
      if (c.strategy === 'guardrail' && t > 0 && bal > 0 && w0 > 0) {
        const wr = draw / bal;
        if (wr > w0 * c.guardUp) draw *= (1 - c.guardCut);
        else if (wr < w0 * c.guardLo) draw *= (1 + c.guardRaise);
      }
      cum *= (1 + inf[t]);
      const afterDraw = bal - draw;
      if (afterDraw <= 0) { for (let k = t + 1; k <= n; k++) out[k] = 0; return out; }
      bal = afterDraw * (1 + rets[t]);
      if (bal < 0) bal = 0;
      out[t + 1] = bal / cum;
    }
    return out;
  }

  function sortedAt(matrix, paths, n, y) {
    const col = new Float64Array(paths);
    for (let p = 0; p < paths; p++) col[p] = matrix[p * (n + 1) + y];
    return col.sort();
  }
  function q(sorted, p) {
    const pos = (sorted.length - 1) * p;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  self.onmessage = (ev) => {
    const { runId, cfg } = ev.data;
    const c = { ...cfg };
    if (c.crashOn) {
      // 歷史模式：主執行緒已經算好「這個抽樣池裡實際最差的連續 5 年」
      // 參數化模式：沿用形狀假設，等比縮放到使用者指定的累計跌幅
      if (c.crashHist) { c.crashR = c.crashHist.stock; c.crashB = c.crashHist.bond; }
      else c.crashR = scaleCrash(c.crashShape, c.crashDepth);
    }
    const n = c.years, paths = c.paths;
    const matrix = new Float64Array(paths * (n + 1));
    const ruinYears = new Int16Array(paths);
    const finals = new Float64Array(paths);
    let success = 0;

    const CHUNK = 100;
    for (let p = 0; p < paths; p++) {
      const r = simPath(c.seed + p * 7919, c, false);
      matrix.set(r.real, p * (n + 1));
      ruinYears[p] = r.ruinYear;
      finals[p] = r.real[n];
      if (r.real[n] > 0) success++;
      if ((p + 1) % CHUNK === 0 || p === paths - 1) {
        self.postMessage({ type: 'tick', runId, done: p + 1, total: paths, success });
      }
    }

    // 百分位帶
    const bands = [];
    for (let y = 0; y <= n; y++) {
      const s = sortedAt(matrix, paths, n, y);
      bands.push({
        age: c.ageRetire + y,
        p10: q(s, 0.10), p25: q(s, 0.25), p50: q(s, 0.50), p75: q(s, 0.75), p90: q(s, 0.90),
      });
    }

    // 抽樣路徑：等距抽（代表全體）與最差十分位抽（單獨檢視）
    const order = Array.from({ length: paths }, (_, i) => i).sort((a, b) => finals[a] - finals[b]);
    const pick = (idxs, k) => {
      if (!k) return [];
      const step = Math.max(1, Math.floor(idxs.length / k));
      const out = [];
      for (let i = 0; i < idxs.length && out.length < k; i += step) {
        const p = idxs[i];
        out.push({ v: Array.from(matrix.subarray(p * (n + 1), p * (n + 1) + n + 1)), ruinYear: ruinYears[p] });
      }
      return out;
    };
    const allIdx = Array.from({ length: paths }, (_, i) => i);
    const worstIdx = order.slice(0, Math.max(1, Math.round(paths * 0.1)));
    const keepPaths = pick(allIdx, c.keep);
    const worstPaths = pick(worstIdx, c.keep);

    // 中位路徑：終值最接近中位數的那一條。順序風險對照與收入組成都用它。
    const medIdx = order[Math.floor(paths / 2)];
    const med = simPath(c.seed + medIdx * 7919, c, true);
    const rev = med.rets.slice().reverse();

    const ruinAges = [];
    for (let p = 0; p < paths; p++) if (ruinYears[p] >= 0) ruinAges.push(c.ageRetire + ruinYears[p]);

    const worstFinals = worstIdx.map((i) => finals[i]);
    const worstMean = worstFinals.reduce((a, b) => a + b, 0) / worstFinals.length;

    self.postMessage({
      type: 'done', runId,
      n, ageRetire: c.ageRetire,
      paths, success,
      successRate: success / paths,
      bands, keepPaths, worstPaths, ruinAges,
      worstMean,
      medianReturns: med.rets,
      income: med.income,
      seqOrig: Array.from(walk(med.rets, med.inf, c)),
      seqRev: Array.from(walk(rev, med.inf, c)),
      firstDraw: Math.max(0, c.spend0 - (c.penLabor + c.penRetire) * 12),
    });
  };
}

const workerUrl = URL.createObjectURL(
  new Blob([
    // 區塊拔靴用的是 core/fin.js 的那一份實作，原封不動注入，不在這裡重寫一次
    'const blockBootstrap = ' + blockBootstrap.toString() + ';\n',
    '(' + workerMain.toString() + ')()',
  ], { type: 'text/javascript' })
);
const worker = new Worker(workerUrl);
worker.onerror = (e) => {
  window.__err = 'worker: ' + e.message;
  $('#fanProgress').hidden = true;
  toast('模擬引擎出錯了，請重新整理這一頁');
};

/* ==========================================================================
   4. 招牌視覺：資產路徑扇形圖
   路徑向右生長 → 不確定性從一個詞變成一個會分岔、會有幾條掉下去的形狀。
   歸零的路徑變紅落到地面堆積，那座小丘就是破產年齡分佈本身。
   ========================================================================== */
class Fan {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.data = null;
    this.prev = null;
    this.t = 1;        // 生長進度 0..1
    this.u = 1;        // 形變進度 0..1
    this.dpr = 1;
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement || canvas);
    this._onTheme = () => this.draw();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', this._onTheme);
    this.resize();
  }

  resize() {
    const host = this.c.parentElement;
    const w = Math.max(240, host.clientWidth);
    const h = Math.round(Math.min(420, Math.max(220, w * 0.62)));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.c.style.width = '100%';
    this.c.style.height = h + 'px';
    this.c.width = Math.round(w * this.dpr);
    this.c.height = Math.round(h * this.dpr);
    this.w = w; this.h = h;
    this.pad = { top: 14, right: w < 420 ? 10 : 16, bottom: 40, left: w < 420 ? 44 : 56 };
    this.ground = 16;  // 地面帶：歸零的路徑堆在這裡
    this.draw();
  }

  setData(d, { animate = 'morph' } = {}) {
    this.prev = this.data && this.data.n === d.n ? this.data : null;
    this.data = d;
    this.maxY = Math.max(d.bands.reduce((m, b) => Math.max(m, b.p90), 0), d.assets0) * 1.08 || 1;
    gsap.killTweensOf(this);
    if (still() || animate === 'none') { this.t = 1; this.u = 1; this.draw(); return; }
    if (animate === 'grow' || !this.prev) {
      this.t = 0; this.u = 1;
      gsap.to(this, { t: 1, duration: 1.35, ease: EASE, onUpdate: () => this.draw() });
    } else {
      // 形變：路徑一一對應（同一組亂數種子），所以整把扇子是「塌陷」不是「重畫」
      this.t = 1; this.u = 0;
      gsap.to(this, { u: 1, duration: 0.6, ease: 'power2.inOut', onUpdate: () => this.draw() });
    }
  }

  sx(age) {
    const d = this.data;
    const x0 = d.ageRetire, x1 = d.ageRetire + d.n;
    return this.pad.left + ((age - x0) / Math.max(1, x1 - x0)) * (this.w - this.pad.left - this.pad.right);
  }
  sy(v) {
    const B = this.h - this.pad.bottom - this.ground;
    return B - (v / this.maxY) * (B - this.pad.top);
  }

  /** 形變時取插值；沒有前一組資料就直接用現值 */
  _mix(now, before) {
    if (this.u >= 1 || before == null) return now;
    return before + (now - before) * this.u;
  }

  draw() {
    const d = this.data;
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (!d) return;

    const L = this.pad.left, R = this.w - this.pad.right;
    const T = this.pad.top, B = this.h - this.pad.bottom - this.ground;
    const narrow = this.w < 420;

    /* --- 格線 --- */
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = cssv('--rule-faint') || '#E0E0D8';
    ctx.fillStyle = cssv('--ink-3') || '#5F656C';
    ctx.font = `500 10px ${cssv('--font-mono') || 'monospace'}`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of niceTicks(0, this.maxY, 4)) {
      const y = Math.round(this.sy(v)) + 0.5;
      if (y < T - 1 || y > B + 1) continue;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke();
      ctx.fillText(v >= 1e8 ? (v / 1e8).toFixed(1) + '億' : Math.round(v / 1e4) + '萬', L - 6, y);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const stepAge = d.n > 30 ? 10 : 5;
    for (let a = d.ageRetire; a <= d.ageRetire + d.n; a += stepAge) {
      const x = Math.round(this.sx(a)) + 0.5;
      ctx.strokeStyle = cssv('--rule-faint') || '#E0E0D8';
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, B); ctx.stroke();
      ctx.fillText(a + '歲', x, B + this.ground + 6);
    }
    ctx.strokeStyle = cssv('--rule') || '#C6C6BE';
    ctx.beginPath();
    ctx.moveTo(L + 0.5, T); ctx.lineTo(L + 0.5, B + 0.5); ctx.lineTo(R, B + 0.5);
    ctx.stroke();
    ctx.restore();

    const curYear = this.t * d.n;

    /* --- 百分位帶 --- */
    const bandTop = Math.min(d.n, Math.ceil(curYear));
    const bandPairs = [['p10', 'p90', 0.10], ['p25', 'p75', 0.20]];
    for (const [lo, hi, alpha] of bandPairs) {
      ctx.beginPath();
      let started = false;
      for (let y = 0; y <= bandTop; y++) {
        const b = d.bands[y], pb = this.prev?.bands[y];
        const x = this.sx(b.age), yy = this.sy(this._mix(b[hi], pb?.[hi]));
        started ? ctx.lineTo(x, yy) : (ctx.moveTo(x, yy), started = true);
      }
      for (let y = bandTop; y >= 0; y--) {
        const b = d.bands[y], pb = this.prev?.bands[y];
        ctx.lineTo(this.sx(b.age), this.sy(this._mix(b[lo], pb?.[lo])));
      }
      ctx.closePath();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = cssv('--accent') || '#123A72';
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    /* --- 個別路徑：成功的細灰線，歸零的變紅並墜到地面 --- */
    const paths = d.paths || [];
    const groundY = B + this.ground - 3;
    ctx.lineWidth = narrow ? 0.9 : 1.1;
    ctx.lineJoin = 'round';
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      const pp2 = this.prev?.paths?.[i];
      const ruin = p.ruinYear;
      const upto = Math.min(d.n, Math.floor(curYear));
      ctx.beginPath();
      let dead = -1;
      for (let y = 0; y <= upto; y++) {
        const v = this._mix(p.v[y], pp2?.v[y]);
        if (v <= 0 && dead < 0) { dead = y; break; }
        const x = this.sx(d.ageRetire + y), yy = this.sy(v);
        y === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
      }
      ctx.globalAlpha = narrow ? 0.20 : 0.16;
      ctx.strokeStyle = cssv('--ink-3') || '#5F656C';
      ctx.stroke();

      if (dead > 0 && ruin >= 0) {
        // 墜落：從最後一個有錢的年度直接落到地面，落點對齊地面上那一堆
        const lastV = this._mix(p.v[dead - 1], pp2?.v[dead - 1]);
        ctx.beginPath();
        ctx.moveTo(this.sx(d.ageRetire + dead - 1), this.sy(Math.max(0, lastV)));
        ctx.lineTo(this.sx(d.ageRetire + dead - 1 + 0.35), groundY);
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = cssv('--up') || '#B4232C';
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    /* --- 中位線 --- */
    ctx.beginPath();
    for (let y = 0; y <= Math.min(d.n, Math.ceil(curYear)); y++) {
      const b = d.bands[y], pb = this.prev?.bands[y];
      const x = this.sx(b.age), yy = this.sy(this._mix(b.p50, pb?.p50));
      y === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
    }
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = cssv('--accent') || '#123A72';
    ctx.stroke();

    /* --- 地面與堆積：丘越高，代表越多條人生在那個年齡花光 --- */
    ctx.save();
    ctx.strokeStyle = cssv('--rule-strong') || '#9B9B92';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L, B + 0.5); ctx.lineTo(R, B + 0.5);
    ctx.stroke();
    const pile = d.pile || [];
    const maxPile = Math.max(1, ...pile);
    ctx.fillStyle = cssv('--up') || '#B4232C';
    ctx.globalAlpha = this.u;
    const bw = Math.max(2, (R - L) / Math.max(1, d.n) * 0.7);
    for (let y = 0; y <= d.n; y++) {
      if (!pile[y] || y > curYear) continue;
      const hgt = (pile[y] / maxPile) * (this.ground - 4);
      ctx.fillRect(Math.round(this.sx(d.ageRetire + y) - bw / 2), Math.round(B + this.ground - 3 - hgt),
        Math.round(bw), Math.max(1, Math.round(hgt)));
    }
    ctx.restore();
  }
}

const fan = new Fan($('#fan'));

/* ---------- 成功率環 ---------- */
const ringCanvas = $('#ring');
const ringCtx = ringCanvas.getContext('2d');
let ringValue = 0;
function drawRing(v) {
  ringValue = v;
  const ctx = ringCtx, S2 = 128, r = 50, cx = 64, cy = 64;
  ctx.clearRect(0, 0, S2, S2);
  ctx.lineWidth = 12;
  ctx.strokeStyle = cssv('--rule-faint') || '#E0E0D8';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  if (v > 0) {
    ctx.strokeStyle = cssv('--accent') || '#123A72';
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(v, 0, 1));
    ctx.stroke();
  }
}
const ringNum = makeCounter($('#ringNum'), (v) => Math.round(v / 5) * 5 + '%');
function setRing(v, { animate = true } = {}) {
  ringNum(v * 100);
  if (still() || !animate) { drawRing(v); return; }
  const o = { v: ringValue };
  gsap.killTweensOf(o);
  gsap.to(o, { v, duration: 0.5, ease: EASE, onUpdate: () => drawRing(o.v) });
}
drawRing(0);

/* ==========================================================================
   5. 次要圖表
   ========================================================================== */
const plotRuin = new Plot($('#chartRuin'), {
  aspect: 0.34, minHeight: 150,
  yFormat: (v) => String(Math.round(v)),
  xFormat: (v) => Math.round(v) + '歲',
  padding: { left: 44, bottom: 28, top: 12, right: 14 },
});
const plotSeq = new Plot($('#chartSeq'), {
  aspect: 0.38, minHeight: 170,
  yFormat: (v) => (v >= 1e8 ? (v / 1e8).toFixed(1) + '億' : Math.round(v / 1e4) + '萬'),
  xFormat: (v) => Math.round(v) + '歲',
  padding: { left: 50, bottom: 28, top: 12, right: 14 },
});
const plotIncome = new Plot($('#chartIncome'), {
  aspect: 0.34, minHeight: 150,
  yFormat: (v) => (v >= 1e4 ? Math.round(v / 1e4) + '萬' : String(Math.round(v))),
  xFormat: (v) => Math.round(v) + '歲',
  padding: { left: 50, bottom: 28, top: 12, right: 14 },
});

function legendHTML(host, items) {
  host.replaceChildren();
  for (const it of items) {
    host.appendChild(el('span', { class: 'legend__item' }, [
      el('span', { class: 'legend__key' + (it.band ? ' legend__key--band' : ''), style: `background:${it.color}` }),
      el('span', { text: it.label }),
    ]));
  }
}

/* ==========================================================================
   6. 輸入
   ========================================================================== */
let simTimer = 0;
function patch(p, { fast = true } = {}) {
  store.set(p);
  clearTimeout(simTimer);
  simTimer = setTimeout(() => run(), fast ? 130 : 0);
}

const fAssets = bindField($('#f-assets'), {
  pretty: int,
  validate: (v) => {
    if (!Number.isFinite(v) || v < 0) return '請填入 0 以上的金額';
    if (v > 1e10) return '這個金額超出試算範圍';
    return null;
  },
  onChange: (v, { valid }) => { if (valid) patch({ assets: v }); },
});

const fSpend = bindField($('#f-spend'), {
  pretty: int,
  validate: (v) => (Number.isFinite(v) && v >= 0 ? null : '請填入 0 以上的金額'),
  onChange: (v, { valid }) => { if (valid) patch({ spend: v }); },
});

const fPenLabor = bindField($('#f-pLabor'), {
  pretty: int,
  validate: (v) => (Number.isFinite(v) && v >= 0 ? null : '沒有就填 0'),
  onChange: (v, { valid }) => { if (valid) patch({ penLabor: v }); },
});

const fPenRetire = bindField($('#f-pRetire'), {
  pretty: int,
  validate: (v) => (Number.isFinite(v) && v >= 0 ? null : '沒有就填 0'),
  onChange: (v, { valid }) => { if (valid) patch({ penRetire: v }); },
});

const sAgeRetire = bindSlider($('#s-ageRetire'), {
  format: (v) => `${v}<small>歲</small>`,
  onInput: (v) => {
    const patchObj = { ageRetire: v };
    if (S().ageEnd <= v) { patchObj.ageEnd = v + 1; sAgeEnd.set(v + 1, { silent: true }); }
    patch(patchObj);
    updateAgeHint();
  },
});
const sAgeEnd = bindSlider($('#s-ageEnd'), {
  format: (v) => `${v}<small>歲</small>`,
  onInput: (v) => {
    const patchObj = { ageEnd: v };
    if (v <= S().ageRetire) { patchObj.ageRetire = v - 1; sAgeRetire.set(v - 1, { silent: true }); }
    patch(patchObj);
    updateAgeHint();
  },
});

const sStock = bindSlider($('#s-stock'), {
  format: (v) => `${v}<small>%</small>`,
  onInput: (v) => {
    let bond = S().bond;
    if (v + bond > 100) { bond = 100 - v; sBond.set(bond, { silent: true }); }
    patch({ stock: v, bond });
    paintAlloc();
  },
});
const sBond = bindSlider($('#s-bond'), {
  format: (v) => `${v}<small>%</small>`,
  onInput: (v) => {
    let stock = S().stock;
    if (v + stock > 100) { stock = 100 - v; sStock.set(stock, { silent: true }); }
    patch({ stock, bond: v });
    paintAlloc();
  },
});

const sInfl = bindSlider($('#s-infl'), {
  format: (v) => `${dec(v, 1)}<small>%</small>`,
  onInput: (v) => { patch({ infl: v }); paintInflHint(); },
});

const sCrash = bindSlider($('#s-crash'), {
  format: (v) => `−${Math.abs(v)}<small>%</small>`,
  onInput: (v) => patch({ crashDepth: v }),
});

const segStrategy = bindSegmented($('#seg-strategy'), {
  onChange: (v) => {
    patch({ strategy: v });
    $('#strategyHint').textContent = v === 'fixed'
      ? '固定實質金額：不管市值漲跌，每年都領到同樣的購買力。這就是 4% 法則的本質。'
      : '動態護欄：當年提領率超過初始的 1.2 倍就砍 10%，低於 0.8 倍就加 10%。成功率會變高，代價是你真的要在壞年頭少花錢。';
  },
});

const segMode = bindSegmented($('#seg-mode'), {
  onChange: (v) => { patch({ mode: v }, { fast: false }); paintAlloc(); },
});

const segPool = bindSegmented($('#seg-pool'), {
  onChange: (v) => { patch({ pool: v }, { fast: false }); paintAlloc(); },
});

const segInfl = bindSegmented($('#seg-infl'), {
  onChange: (v) => { patch({ inflMode: v }, { fast: false }); paintInflHint(); },
});

$('#crashOn').addEventListener('change', (e) => {
  patch({ crashOn: e.target.checked }, { fast: false });
  $('.crash-set').dataset.on = String(e.target.checked);
});
$('#preciseOn').addEventListener('change', (e) => patch({ precise: e.target.checked }, { fast: false }));
$('#cpiLabor').addEventListener('change', (e) => patch({ cpiLabor: e.target.checked }));
$('#cpiRetire').addEventListener('change', (e) => patch({ cpiRetire: e.target.checked }));

$('#backToNormal').addEventListener('click', () => { segMode.set('normal'); patch({ mode: 'normal' }, { fast: false }); paintMode(); });

$('#resetBtn').addEventListener('click', () => {
  store.replace(DEFAULTS());
  location.replace(location.pathname);
});

// 這張單子沒有「送出」，按 Enter 只是想確認一個欄位，不該重新整理整頁
$('#inputs').addEventListener('submit', (e) => e.preventDefault());

let worstOnly = false;
$('#worstBtn').addEventListener('click', (e) => {
  worstOnly = !worstOnly;
  e.currentTarget.setAttribute('aria-pressed', String(worstOnly));
  e.currentTarget.textContent = worstOnly ? '看回全部路徑' : '只看最差 10%';
  if (last) paintFan(last, 'grow');
});
$('#playBtn').addEventListener('click', () => { if (last) paintFan(last, 'grow'); });

/* ---------- μ／σ 覆寫：模型假設必須可以被改掉 ---------- */
function renderAdvanced() {
  const host = $('#advBody');
  host.replaceChildren();
  const s = S();
  const rows = [
    ['mus', '股票 μ', '%', s.mus], ['sigs', '股票 σ', '%', s.sigs],
    ['mub', '債券 μ', '%', s.mub], ['sigb', '債券 σ', '%', s.sigb],
    ['muc', '現金 μ', '%', s.muc], ['rho', '股債相關 ρ', '', s.rho],
  ];
  const grid = el('div', { class: 'fieldgrid fieldgrid--2' });
  for (const [key, label, unit, v] of rows) {
    grid.appendChild(el('label', { class: 'field' }, [
      el('span', { class: 'field__label', text: label }),
      el('span', { class: 'field__control' }, [
        el('input', {
          type: 'text', inputmode: 'decimal', value: String(v),
          onchange: (e) => {
            const nv = clamp(parseNum(e.target.value, v), key === 'rho' ? -1 : -20, key === 'rho' ? 1 : 60);
            e.target.value = String(nv);
            patch({ [key]: nv }, { fast: false });
            paintAlloc();
          },
        }),
        unit ? el('span', { class: 'field__unit', text: unit }) : null,
      ]),
    ]));
  }
  host.appendChild(grid);
  host.appendChild(el('p', {
    class: 'adv-note',
    text: '這六個數字全部是未查證的模型假設，不是歷史統計，而且只在「參數化常態」模式生效。'
        + '站上確實內建了台股 2004-2025 與 S&P 500 1928-2025 的年度報酬序列，但那是給「歷史區塊拔靴法」抽樣用的；'
        + '它們的樣本期間太特殊，直接拿去當 μ 會高估，所以這裡不自動代入。改動它們，右邊整張圖就會換一個樣子，這正是重點。',
  }));
}

function paintAlloc() {
  const s = S();
  const cash = 100 - s.stock - s.bond;
  $('#cashPct').textContent = cash + '%';
  const ws = s.stock / 100, wb = s.bond / 100, wc = cash / 100;
  const pool = s.mode === 'bootstrap' ? currentPool() : null;
  if (pool) {
    // 歷史模式：組合的 μ／σ 不是假設出來的，是這個抽樣池逐年算出來的
    const port = pool.stock.map((rs, i) => (ws * rs + wb * pool.bond[i] + wc * s.muc / 100) * 100);
    $('#muPct').textContent = pp(mean(port), 1);
    $('#sigPct').textContent = pp(stdev(port), 1);
    return;
  }
  const mu = ws * s.mus + wb * s.mub + wc * s.muc;
  const varp = (ws * s.sigs) ** 2 + (wb * s.sigb) ** 2 + 2 * ws * wb * s.sigs * s.sigb * s.rho;
  $('#muPct').textContent = pp(mu, 1);
  $('#sigPct').textContent = pp(Math.sqrt(Math.max(0, varp)), 1);
}

/**
 * 分齡平均餘命。內政部 113 年簡易生命表只有 60／65／70／75／80 歲，
 * 不做內插——退休年齡不在表上時就明說「這裡引用的是 65 歲那一列」。
 */
function lifeRow(age) {
  const lt = DATA?.lifeTable;
  if (lt?.ages?.length) {
    let i = lt.ages.indexOf(age);
    const exact = i >= 0;
    if (i < 0) i = lt.ages.indexOf(65);
    if (i < 0) i = 0;
    return { age: lt.ages[i], male: lt.male[i], female: lt.female[i], exact, vintage: '113 年簡易生命表' };
  }
  // 序列檔載不進來時，退回 rules.json 裡那一筆已查證的 65 歲餘命
  const r = RULES.legal?.find((x) => x.key === 'lifeExpectancyAt65');
  if (r?.status === 'verified' && Number.isFinite(r.male)) {
    return { age: 65, male: r.male, female: r.female, exact: age === 65, vintage: '113 年簡易生命表' };
  }
  return null;
}

/** 給結論段落用的一句話：65 歲（或退休年齡那一列）的平均餘命換算成終齡 */
function lifeSentence() {
  const r = lifeRow(S().ageRetire);
  if (!r) return '';
  return `${r.age} 歲男性平均餘命 ${dec(r.male, 2)} 年、女性 ${dec(r.female, 2)} 年（${r.vintage}），`
       + `也就是平均活到約 ${dec(r.age + r.male, 1)} 歲與 ${dec(r.age + r.female, 1)} 歲`;
}

function updateAgeHint() {
  const s = S();
  const r = lifeRow(s.ageRetire);
  const hint = $('#ageEndHint');
  if (!r) { hint.textContent = ''; return; }
  const fAge = r.age + r.female;
  const head = r.exact
    ? `對照：${lifeSentence()}。`
    : `對照：生命表只收 60／65／70／75／80 歲，這裡引用 65 歲那一列，${lifeSentence()}。`;
  hint.textContent = head + (s.ageEnd < Math.round(fAge)
    ? `你的終齡 ${s.ageEnd} 歲還低於女性的平均終齡，成功率有一部分是被縮短的計畫期間撐高的。平均餘命是期望值，大約一半的人會活得更久。`
    : `平均餘命是期望值，大約一半的人會活得更久，所以把終齡設在它之上才是保守的。`);
}

/* ---------- 模擬方式：歷史模式不再拒答，改成把樣本的形狀先講清楚 ---------- */
function paintMode() {
  const s = S();
  const boot = s.mode === 'bootstrap';
  const pool = boot ? currentPool() : null;
  const blocked = boot && !pool;

  const box = $('#refuse');
  box.hidden = !blocked;
  $('#bootNote').hidden = !(boot && pool);
  $$('#fanCard, #ruinCard, #seqCard, #incomeCard').forEach((n) => { n.dataset.stale = String(blocked); });

  $('#poolSet').dataset.on = String(boot);
  $$('#seg-pool .segmented__opt').forEach((b) => { b.disabled = !boot; });

  $('#modeHint').textContent = boot
    ? `每次抽連續 ${BLOCK} 年，保留報酬的自相關（比逐年獨立抽樣誠實）。但抽樣池就只有下面那幾十個年度，抽再多次也不會生出樣本裡沒有的情境。`
    : '報酬由你指定的 μ、σ、ρ 生成。好處是假設全部攤在檯面上、可以自己調；壞處是常態分布沒有真實市場的厚尾，也沒有自相關。';

  $('#poolHint').textContent = pool ? poolHintText(pool) : '';
  paintCrashHint(pool);
  if (pool) renderBootNote(pool);

  if (blocked) {
    const r = RULES.refusals?.[0];
    $('#refuseWhy').textContent = '歷史區塊拔靴法需要 assets/data/tw-returns.json 裡的年度報酬序列，這個檔案現在載不進來（離線開檔或路徑錯誤都會這樣），所以不畫假的分布。'
      + (r ? `　另外仍然沒有 bundled 的是：${r.label}。` : '');
    $('#refuseCan').textContent = '可以回答的範圍：參數化常態模式：你自己指定 μ 與 σ，模型的假設全部攤在檯面上。';
    box.scrollIntoView({ behavior: still() ? 'auto' : 'smooth', block: 'nearest' });
  }
}

function poolHintText(pool) {
  return pool.key === 'taiex'
    ? `台股含息報酬指數 ${pool.startYear}-${pool.endYear}，只有 ${pool.n} 個年度，而且幾乎整段都在結構性多頭。`
    : `S&P 500 ${pool.startYear}-${pool.endYear}，${pool.n} 個年度，含 1929、1973、2000、2008。它不是台股，幣別與稅制都不同。`;
}

/** 順序風險：歷史模式下跌幅由資料決定，滑桿失效，這件事要寫在滑桿旁邊 */
function paintCrashHint(pool) {
  const s = S();
  const hint = $('#crashHint');
  const slider = $('#s-crash input[type="range"]');
  const hist = pool ? worstWindow(pool.stock, 5) : null;
  if (slider) slider.disabled = Boolean(hist);
  $('.crash-set').dataset.hist = String(Boolean(hist));
  if (hist) {
    const y0 = pool.startYear + hist.i;
    hint.textContent =
      `歷史模式下這個滑桿不生效：前五年直接套用「${pool.meta.short}」抽樣池裡實際最差的連續 5 年（${y0}-${y0 + 4}，累計 ${pp((hist.cum - 1) * 100, 1)}），`
      + `債券那一腳也換成同樣那五個年度。`
      + (pool.key === 'taiex'
        ? `注意：這 22 年裡最差的 5 年也只跌 ${dec(Math.abs((hist.cum - 1) * 100), 1)}%，這本身就是樣本太薄的證據，不是台股很安全的證據。`
        : '');
  } else {
    hint.textContent = '這不是某一段真實歷史，是一個你可以調整幅度的壓力情境。同樣的平均報酬，只要壞的年份排在最前面，結局就完全不同。';
  }
  $('.crash-set').dataset.on = String(s.crashOn);
}

function paintInflHint() {
  const s = S();
  const cpi = cpiPool();
  const on = s.inflMode === 'cpi' && cpi;
  const slider = $('#s-infl input[type="range"]');
  const twin = $('#t-infl');
  if (slider) slider.disabled = Boolean(on);
  if (twin) twin.disabled = Boolean(on);
  $('#s-infl').style.opacity = on ? '0.45' : '';
  $('#inflHint').textContent = on
    ? `抽主計總處 CPI 年增率 ${cpi.startYear}-${cpi.endYear} 的 ${cpi.values.length} 個年度，同樣是連續 ${BLOCK} 年一塊。`
      + `這 30 年的平均只有 ${dec(mean(cpi.values), 2)}%、最高 ${dec(Math.max(...cpi.values), 2)}%，沒有涵蓋任何一段高通膨時期，`
      + `所以抽出來的通膨偏低，對退休模擬是樂觀的方向。而且通膨與報酬是各自獨立抽的，不會出現「高通膨＋股債齊跌」那種真實的壞年頭。`
    : `固定 ${dec(s.infl, 1)}%：每一年都一樣。這是模型假設，不是資料。`;
}

/* ---------- 歷史模式的揭露面板：先把樣本長什麼樣子攤開，再看結果 ---------- */
function cagr(pct01) {
  let p = 1;
  for (const r of pct01) p *= 1 + r;
  return { total: p, annual: Math.pow(p, 1 / pct01.length) - 1 };
}

function renderBootNote(pool) {
  const s = S();
  const g = cagr(pool.stock);
  const w = worstWindow(pool.stock, 5);
  const worstYear = pool.raw.indexOf(Math.min(...pool.raw));
  const cpi = s.inflMode === 'cpi' ? cpiPool() : null;

  $('#bootN').textContent = String(pool.n);
  $('#bootLead').textContent =
    `抽樣池是${pool.meta.label}，${pool.startYear}-${pool.endYear} 共 ${pool.n} 個年度，`
    + `每次抽連續 ${BLOCK} 年。重抽一萬次也不會生出這 ${pool.n} 年裡沒發生過的事，`
    + `所以下面那把扇子的形狀，先天就被這段期間的樣子決定了。`;

  const q = $('#bootCaveat');
  q.replaceChildren(
    el('span', { class: 'boot-note__quote-src', text: '資料檔原文的但書：' }),
    el('span', { text: pool.caveat || '（這一份序列沒有附但書）' }),
  );

  const rows = [
    ['樣本', `${pool.n} 個年度（${pool.startYear}-${pool.endYear}）`],
    ['算術平均／標準差', `${pp(mean(pool.raw), 2)}／${dec(stdev(pool.raw), 2)}%`],
    ['年化（幾何）', pp(g.annual * 100, 2)],
    ['累積', `${dec(g.total, 2)} 倍`],
    ['最差單一年度', `${pp(pool.raw[worstYear], 2)}（${pool.startYear + worstYear}）`],
    ['最差連續 5 年', w ? `${pool.startYear + w.i}-${pool.startYear + w.i + 4}，累計 ${pp((w.cum - 1) * 100, 1)}` : '-'],
    ['債券那一腳', `同年度（${pool.startYear}-${pool.endYear}）的美國 10 年期公債模型化報酬`],
    ['通膨', cpi ? `抽台灣 CPI ${cpi.startYear}-${cpi.endYear}（${cpi.values.length} 年，平均 ${dec(mean(cpi.values), 2)}%）` : `固定 ${dec(s.infl, 1)}%`],
  ];
  const dl = $('#bootStats');
  dl.replaceChildren();
  for (const [k, v] of rows) {
    dl.appendChild(el('dt', { text: k }));
    dl.appendChild(el('dd', { text: v }));
  }

  $('#bootBond').textContent =
    (pool.key === 'taiex'
      ? '這 22 個年度的算術平均是 14.15%，遠高於任何長期股票報酬的合理預期值，因為 2008 之後只有三個負報酬年度。用它抽樣，成功率會偏高、尾端會偏薄。'
      : '這 98 個年度含 1929、1973-74、2000-02、2008 幾段真實的大跌，尾端比台股那 22 年厚得多；代價是它是美元計價的美國市場，不是台股，幣別、稅制與集中度都不同。')
    + '　債券那一腳沒有台灣的可用長序列，只能用同年度的美國 10 年期公債模型化報酬替代：那是以殖利率重新定價推算出來的，不是實際可投資指數，也沒有台幣避險。'
    + '　股與債抽的是同一組年度，所以股債的共動關係來自歷史本身，這個模式下不使用 ρ，左欄的 μ、σ、ρ 也全部不生效。'
    + (pool.key === 'taiex' ? '　（累積倍數以本序列逐年連乘為 ' + dec(g.total, 2) + ' 倍，caveat 原文寫約 10.2 倍，口徑略有差異，兩個數字都照列不修飾。）' : '');

  const ul = $('#bootRefuse');
  ul.replaceChildren();
  for (const r of RULES.refusals || []) {
    ul.appendChild(el('li', { text: `仍然沒有：${r.label}。${r.reason}` }));
  }
}

function syncInputs() {
  const s = S();
  fAssets.set(s.assets, { silent: true });
  fSpend.set(s.spend, { silent: true });
  fPenLabor.set(s.penLabor, { silent: true });
  fPenRetire.set(s.penRetire, { silent: true });
  sAgeRetire.set(s.ageRetire, { silent: true });
  sAgeEnd.set(s.ageEnd, { silent: true });
  sStock.set(s.stock, { silent: true });
  sBond.set(s.bond, { silent: true });
  sInfl.set(s.infl, { silent: true });
  sCrash.set(s.crashDepth, { silent: true });
  segStrategy.set(s.strategy);
  segMode.set(s.mode);
  segPool.set(s.pool);
  segInfl.set(s.inflMode);
  paintInflHint();
  $('#strategyHint').textContent = s.strategy === 'fixed'
    ? '固定實質金額：不管市值漲跌，每年都領到同樣的購買力。這就是 4% 法則的本質。'
    : '動態護欄：當年提領率超過初始的 1.2 倍就砍 10%，低於 0.8 倍就加 10%。成功率會變高，代價是你真的要在壞年頭少花錢。';
  $('#crashOn').checked = s.crashOn;
  $('#preciseOn').checked = s.precise;
  $('#cpiLabor').checked = s.cpiLabor;
  $('#cpiRetire').checked = s.cpiRetire;
  $('.crash-set').dataset.on = String(s.crashOn);
  paintAlloc();
  updateAgeHint();
  renderAdvanced();
}

/* ==========================================================================
   7. 跑模擬
   ========================================================================== */
const cSuccess = makeCounter($('#r-success'), (v) => `${Math.round(v / 5) * 5}<small>%</small>`, { html: true });
const cWr = makeCounter($('#r-wr'), (v) => dec(v, 2) + '<small>%</small>', { html: true });
const cWorst = makeCounter($('#r-worst'), (v) => (v <= 0 ? '0' : dec(v / 1e4, 0)) + '<small>萬</small>', { html: true });

let runId = 0;
let last = null;

/* ---------- 抽樣池：全部由 assets/data/tw-returns.json 組出來 ---------- */
const POOL_META = {
  taiex: { seriesKey: 'taiexTotalReturn', short: '台股', label: '臺灣發行量加權股價報酬指數（含息）' },
  sp500: { seriesKey: 'sp500TotalReturn', short: 'S&P 500', label: 'S&P 500 含息年度報酬' },
};

/** 股票池，以及同一批年度的債券池。台灣沒有可引用的公債長序列，債券只能用美債模型化序列替代。 */
function buildPool(poolKey) {
  const meta = POOL_META[poolKey] || POOL_META.taiex;
  const s = DATA?.series?.[meta.seriesKey];
  const b = DATA?.series?.ust10yTotalReturn;
  if (!s?.values?.length || !b?.values?.length) return null;
  const off = s.startYear - b.startYear;
  if (off < 0 || off + s.values.length > b.values.length) return null;
  return {
    key: poolKey, meta,
    startYear: s.startYear, endYear: s.endYear, n: s.values.length,
    raw: s.values,
    caveat: s.caveat || '',
    source: s.source || '',
    stock: s.values.map((v) => v / 100),
    bond: b.values.slice(off, off + s.values.length).map((v) => v / 100),
    bondLabel: b.label, bondCaveat: b.caveat || '',
  };
}
function currentPool() { return DATA ? buildPool(S().pool) : null; }
function cpiPool() {
  const c = DATA?.series?.twCPI;
  return c?.values?.length ? c : null;
}

/** 這個池子裡實際最差的連續 len 年（以累計報酬最低者為準） */
function worstWindow(values, len = 5) {
  if (!values || values.length < len) return null;
  let bi = -1, bc = Infinity;
  for (let i = 0; i + len <= values.length; i++) {
    let c = 1;
    for (let k = 0; k < len; k++) c *= 1 + values[i + k];
    if (c < bc) { bc = c; bi = i; }
  }
  return bi < 0 ? null : { i: bi, cum: bc, len };
}

function buildCfg() {
  const s = S();
  const cash = 100 - s.stock - s.bond;
  const crashShape = RULES.assumptions?.find((a) => a.key === 'crashShape')?.shape || [-0.36, -0.22, 0.05, -0.12, 0.08];
  const g = RULES.assumptions?.find((a) => a.key === 'guardrail') || {};
  const narrow = window.innerWidth < 420;
  const pool = s.mode === 'bootstrap' ? currentPool() : null;
  const boot = Boolean(pool);
  const cpi = s.inflMode === 'cpi' ? cpiPool() : null;
  const w = boot && s.crashOn ? worstWindow(pool.stock, 5) : null;
  return {
    assets0: Math.max(1, s.assets),
    years: Math.max(1, s.ageEnd - s.ageRetire),
    ageRetire: s.ageRetire,
    spend0: s.spend * 12,
    penLabor: s.penLabor, penRetire: s.penRetire,
    cpiLabor: s.cpiLabor, cpiRetire: s.cpiRetire,
    infl: s.infl / 100,
    ws: s.stock / 100, wb: s.bond / 100, wc: cash / 100,
    mus: s.mus / 100, sigs: s.sigs / 100,
    mub: s.mub / 100, sigb: s.sigb / 100,
    muc: s.muc / 100, rho: s.rho,
    strategy: s.strategy,
    guardUp: g.upper ?? 1.2, guardLo: g.lower ?? 0.8, guardCut: g.cut ?? 0.1, guardRaise: g.raise ?? 0.1,
    crashOn: s.crashOn, crashDepth: s.crashDepth / 100, crashShape,
    // 歷史模式
    boot, blockLen: BLOCK,
    poolIdx: boot ? pool.stock.map((_, i) => i) : null,
    stockPool: boot ? pool.stock : null,
    bondPool: boot ? pool.bond : null,
    crashHist: w ? { stock: pool.stock.slice(w.i, w.i + w.len), bond: pool.bond.slice(w.i, w.i + w.len) } : null,
    // 通膨：固定值或抽 CPI
    cpiPool: cpi ? cpi.values.map((v) => v / 100) : null,
    paths: s.precise ? 1000 : 200,
    keep: s.precise ? 0 : (narrow ? 40 : 60),   // 手機路徑數壓低，否則 375px 上糊成灰霧
    seed: 20260803,
  };
}

function run() {
  paintMode();
  // 只有一種情況仍然是拒答：歷史模式所需的序列檔載不進來
  if (S().mode === 'bootstrap' && !DATA) return;
  const cfg = buildCfg();
  runId += 1;
  $('#fanProgress').hidden = false;
  $('#fanProgressBar').style.width = '0%';
  worker.postMessage({ runId, cfg });
}

worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.runId !== runId) return;                     // 舊的一輪，丟掉
  if (m.type === 'tick') {
    $('#fanProgressBar').style.width = (m.done / m.total * 100).toFixed(1) + '%';
    setRing(m.success / m.done, { animate: false });  // 成功率環即時累加
    return;
  }
  $('#fanProgress').hidden = true;
  last = m;
  render(m);
};

/** 第一次出圖走「生長」，之後的參數改動走「形變」，塌陷才看得出來 */
let firstPaint = true;

/* ==========================================================================
   8. 繪製結果
   ========================================================================== */
function paintFan(m, animate) {
  const src = worstOnly ? m.worstPaths : m.keepPaths;
  const pile = new Array(m.n + 1).fill(0);
  for (const a of m.ruinAges) pile[a - m.ageRetire] += 1;
  fan.setData({
    n: m.n, ageRetire: m.ageRetire, bands: m.bands,
    paths: src, pile, assets0: S().assets,
  }, { animate });
}

function render(m) {
  const s = S();
  const rounded = Math.round(m.successRate * 20) * 5;          // 四捨五入到 5%
  const se = Math.sqrt(Math.max(1e-9, m.successRate * (1 - m.successRate) / m.paths));
  const err = 1.96 * se * 100;

  paintFan(m, firstPaint ? 'grow' : 'morph');
  firstPaint = false;
  setRing(m.successRate);

  cSuccess(m.successRate * 100);
  cWr(m.firstDraw / Math.max(1, s.assets) * 100);
  cWorst(m.worstMean);
  $('#r-err').textContent = `${m.paths} 次模擬，95% 誤差 ±${dec(err, 1)} 個百分點`;
  $('#r-err').dataset.dir = 'flat';

  const ruinEl = $('#r-ruin');
  if (m.ruinAges.length) {
    const sorted = m.ruinAges.slice().sort((a, b) => a - b);
    ruinEl.innerHTML = `${Math.round(quantile(sorted, 0.5))}<small>歲</small>`;
  } else {
    ruinEl.textContent = '無';
  }

  renderVerdict(m, rounded);
  renderRuinPlot(m);
  renderSeqPlot(m);
  renderIncomePlot(m);
  renderFormula(m, rounded);
  carbonTransfer($$('[data-live]'));
}

function renderRuinPlot(m) {
  if (!m.ruinAges.length) {
    plotRuin.setSeries([], { animate: false });
    $('#ruinDesc').textContent = '這一組假設下沒有任何一條路徑在終齡前歸零，所以這張圖是空的。這不代表不會發生，只代表在你設定的報酬假設裡沒發生。';
    return;
  }
  const lo = Math.min(...m.ruinAges), hi = Math.max(...m.ruinAges);
  const bins = Math.max(1, Math.min(28, hi - lo + 1));
  const h = histogram(m.ruinAges, bins, lo - 0.5, hi + 0.5);
  plotRuin.setSeries([{
    type: 'bars',
    data: h.bins.map((b) => ({ x: b.x, y: b.y })),
    color: cssv('--up'),
    barRatio: 0.8,
  }], { animate: false });
  const sorted = m.ruinAges.slice().sort((a, b) => a - b);
  $('#ruinDesc').textContent =
    `${m.paths} 條路徑裡有 ${m.ruinAges.length} 條在終齡前歸零，最早 ${lo} 歲、中位 ${Math.round(quantile(sorted, 0.5))} 歲、最晚 ${hi} 歲。`;
}

function renderSeqPlot(m) {
  const mk = (arr) => arr.map((v, i) => ({ x: m.ageRetire + i, y: v }));
  plotSeq.setSeries([
    { type: 'line', data: mk(m.seqOrig), color: cssv('--series-1'), width: 2.4, label: '原順序' },
    { type: 'line', data: mk(m.seqRev), color: cssv('--series-4'), width: 2.4, dash: [5, 4], label: '順序反轉' },
  ], { animate: false });
  const a = m.seqOrig[m.n], b = m.seqRev[m.n];
  const diff = Math.abs(a - b);
  $('#seqDesc').textContent =
    `兩條線用的是完全相同的一組年報酬率，只有先後順序不同。終齡時的餘額差了 ${money(diff, { compact: true })}元（${money(a, { compact: true })} 對 ${money(b, { compact: true })}）。這個差額不是報酬造成的，是順序造成的。`;
}

function renderIncomePlot(m) {
  const pen = m.income.map((r) => ({ x: r.age, y: 0, y1: r.pension, color: cssv('--series-3') }));
  const wd = m.income.map((r) => ({ x: r.age, y: r.pension, y1: r.pension + r.withdraw, color: cssv('--series-1') }));
  plotIncome.setSeries([
    { type: 'stack', data: pen, barRatio: 0.9 },
    { type: 'stack', data: wd, barRatio: 0.9 },
  ], { animate: false });
  legendHTML($('#incomeLegend'), [
    { label: '年金（地板）', color: cssv('--series-3') },
    { label: '投資提領', color: cssv('--series-1') },
  ]);
  const first = m.income[0], lastRow = m.income[m.income.length - 1];
  const s = S();
  const erosion = first && lastRow ? (1 - lastRow.pension / Math.max(1, first.pension)) : 0;
  $('#incomeDesc').textContent =
    `中位路徑的收入組成，全部換算成今日購買力。` +
    (s.cpiRetire || s.penRetire === 0
      ? `你設定的年金全部隨物價調整，所以地板那一層在圖上維持水平。`
      : `勞退月退不隨物價調整，${m.n} 年後年金那一層的實質購買力被磨掉 ${pct(erosion, 0)}，缺口只能由投資部位補上。`);
}

let stampedFor = null;
function renderVerdict(m, rounded) {
  const s = S();
  const h = $('#verdict-h');
  const body = $('#verdictBody');
  const stamp = $('#verdictStamp');
  const cash = 100 - s.stock - s.bond;
  const penMonthly = s.penLabor + s.penRetire;
  const years = m.n;

  /* --- 邊界一：年金已經蓋過支出，成功率必然 100%，這時給滿分是沒有資訊的 --- */
  if (penMonthly >= s.spend && s.spend > 0) {
    const surplus = penMonthly - s.spend;
    const muReal = realRate();
    const extra = annuitize(s.assets, muReal, years) / 12;
    h.innerHTML = `你的年金已經蓋過支出，這個問題的答案不是成功率，是<em>你還可以多花多少</em>。`;
    body.textContent =
      `每月年金 ${int(penMonthly)} 元，已經高於每月支出 ${int(s.spend)} 元，光靠地板就有 ${int(surplus)} 元的月結餘。`
      + `另外，如果把 ${money(s.assets, { compact: true })}元的資產在 ${years} 年內平均花完（以組合實質報酬 ${pp(muReal * 100, 1)} 計、忽略波動），`
      + `每個月還可以再多花約 ${int(extra)} 元。注意勞退月退不隨物價調整，這個結餘會逐年變薄。`;
    setStamp(stamp, '地板夠用', 'ok', `floor:${penMonthly}:${s.spend}`);
    return;
  }

  /* --- 邊界二：全現金而支出高於年金 → 必然失敗。不要只顯示 0%，要指出缺口 --- */
  if (rounded === 0) {
    const sorted = m.ruinAges.slice().sort((a, b) => a - b);
    const medRuin = Math.round(quantile(sorted, 0.5));
    const gapYears = Math.max(0, s.ageEnd - medRuin);
    const annualGap = Math.max(0, s.spend * 12 - penMonthly * 12);
    const need = annualGap * presentValueFactor(realRate(), years);
    const shortfall = Math.max(0, need - s.assets);
    h.innerHTML = cash === 100
      ? `全部放現金而支出高於年金，這不是機率問題，是<em>算術上的必然</em>。`
      : `這組條件下<em>每一條路徑都撐不到 ${s.ageEnd} 歲</em>。`;
    body.textContent =
      `中位路徑在 ${medRuin} 歲花光，之後還有 ${gapYears} 年沒有著落。`
      + `以今日購買力計，每年缺口 ${int(annualGap)} 元；要撐滿 ${years} 年，`
      + `在實質報酬 ${pp(realRate() * 100, 1)} 的假設下大約需要 ${money(need, { compact: true })}元本金，`
      + `你目前差 ${money(shortfall, { compact: true })}元。缺口可以靠三個地方補：多存本金、減少支出、或把終齡拉回現實。`;
    setStamp(stamp, '必然不足', 'void', `zero:${medRuin}:${annualGap}`);
    return;
  }

  /* --- 一般情況 --- */
  const failPct = 100 - rounded;
  h.innerHTML = `在你設定的假設下，這筆錢撐到 ${s.ageEnd} 歲的機率大約是 <em>${rounded}%</em>。`;
  const sorted = m.ruinAges.slice().sort((a, b) => a - b);
  const medRuin = m.ruinAges.length ? Math.round(quantile(sorted, 0.5)) : null;
  const pool = s.mode === 'bootstrap' ? currentPool() : null;
  const w = pool && s.crashOn ? worstWindow(pool.stock, 5) : null;
  const lifeRef = lifeRow(s.ageRetire);
  const fAge = lifeRef ? lifeRef.age + lifeRef.female : null;
  body.textContent =
    (s.crashOn
      ? (w
        ? `已套用「退休前五年遇到大跌」：前五年直接用「${pool.meta.short}」的 ${pool.startYear + w.i}-${pool.startYear + w.i + 4} 這五個真實年度（累計 ${pp((w.cum - 1) * 100, 1)}），之後回到區塊抽樣。`
        : `已套用「退休前五年遇到大跌」：前五年股票累計 ${dec(s.crashDepth, 0)}%，這是形狀假設不是真實歷史，之後回到常態抽樣。`)
      : '')
    + (medRuin
      ? (failPct > 0
        ? `失敗的那 ${failPct}% 裡，中位數在 ${medRuin} 歲花光，離終齡還有 ${s.ageEnd - medRuin} 年。`
        // 四捨五入到 5% 會把「有幾條真的歸零」蓋掉，這時要把原始條數講出來
        : `四捨五入後是 100%，但 ${m.paths} 條裡仍有 ${m.ruinAges.length} 條歸零，中位數在 ${medRuin} 歲花光。`)
      : (pool
        ? `沒有任何一條路徑歸零，但那是從 ${pool.n} 個歷史年度重抽的結果，不是保證，尤其這個抽樣池裡沒發生過的事永遠不會出現。`
        : '沒有任何一條路徑歸零，但那是這組報酬假設的結果，不是保證。'))
    + `你的地板是每月 ${int(penMonthly)} 元的年金，`
    + `所以真正要靠投資部位負擔的只有每月 ${int(Math.max(0, s.spend - penMonthly))} 元。`
    // 終齡設太短會人為拉高成功率，這個提醒要跟著結論走，不能只留在輸入欄旁邊
    + (fAge && s.ageEnd < Math.round(fAge)
      ? `　另外：終齡只設到 ${s.ageEnd} 歲，這個成功率有一部分是被縮短的計畫期間撐高的，${lifeSentence()}，而且大約一半的人會活得比平均更久。`
      : '');
  const key = `${rounded}:${s.crashOn}:${s.ageEnd}`;
  setStamp(stamp, `存活 ${rounded}%`, rounded >= 85 ? 'ok' : rounded >= 60 ? '' : 'void', key);
}

function setStamp(stampEl, text, kind, key) {
  stampEl.hidden = false;
  if (stampedFor === key) return;
  stampedFor = key;
  stampEl.innerHTML = `<span class="stamp${kind ? ' stamp--' + kind : ''}">${text}</span>`;
  stampIn(stampEl.firstElementChild);
}

/* 組合實質報酬：(1+μ)/(1+π) − 1。用在邊界情況的說明，不用在模擬本身。
   歷史模式下 μ 改用抽樣池逐年算出來的平均，通膨改用 CPI 序列的平均。 */
function realRate() {
  const s = S();
  const cash = 100 - s.stock - s.bond;
  const ws = s.stock / 100, wb = s.bond / 100, wc = cash / 100;
  const pool = s.mode === 'bootstrap' ? currentPool() : null;
  const mu = pool
    ? mean(pool.stock.map((rs, i) => ws * rs + wb * pool.bond[i])) + wc * s.muc / 100
    : (s.stock * s.mus + s.bond * s.mub + cash * s.muc) / 10000;
  const cpi = s.inflMode === 'cpi' ? cpiPool() : null;
  const pi = cpi ? mean(cpi.values) / 100 : s.infl / 100;
  return (1 + mu) / (1 + pi) - 1;
}
/** 年金現值因子（期初提領） */
function presentValueFactor(r, n) {
  if (Math.abs(r) < 1e-9) return n;
  return (1 - Math.pow(1 + r, -n)) / r * (1 + r);
}
/** 把一筆本金在 n 年內平均花完的年金額 */
function annuitize(pv, r, n) {
  if (n <= 0) return 0;
  if (Math.abs(r) < 1e-9) return pv / n;
  return pv * r / (1 - Math.pow(1 + r, -n)) / (1 + r);
}

/* ==========================================================================
   9. 公式與法源
   ========================================================================== */
function renderFormula(m, rounded) {
  const s = S();
  const host = $('#formulaHost');
  host.replaceChildren();
  const cash = 100 - s.stock - s.bond;
  const pen0 = (s.penLabor + s.penRetire) * 12;

  const poolF = s.mode === 'bootstrap' ? currentPool() : null;
  const cpiF = s.inflMode === 'cpi' ? cpiPool() : null;
  const wF = poolF && s.crashOn ? worstWindow(poolF.stock, 5) : null;

  host.appendChild(formulaBlock('攤開看：每一年的餘額是怎麼算出來的', [
    `<b>期末餘額</b> = (期初餘額 − 當年淨提領) × (1 + r<sub>t</sub>)`,
    cpiF
      ? `<b>名目支出_t</b> = 月支出 × 12 × Π(1+π<sub>k</sub>)，π 逐年從 CPI ${cpiF.startYear}-${cpiF.endYear} 抽出來，每條路徑都不一樣`
      : `<b>名目支出_t</b> = 月支出 × 12 × (1+π)<sup>t</sup>　= ${int(s.spend)} × 12 × (1+${dec(s.infl / 100, 3)})<sup>t</sup>`,
    `<b>年金_t</b> = 勞保 ${int(s.penLabor)}×12×${s.cpiLabor ? '(1+π)^t' : '1'} ＋ 勞退 ${int(s.penRetire)}×12×${s.cpiRetire ? '(1+π)^t' : '1'}`,
    `<b>當年淨提領</b> = 名目支出_t − 年金_t，下限 0`,
    `第 1 年淨提領 = ${int(s.spend * 12)} − ${int(pen0)} = <b>${int(Math.max(0, s.spend * 12 - pen0))}</b> 元`,
    `首年淨提領率 = ${int(Math.max(0, s.spend * 12 - pen0))} ÷ ${int(s.assets)} = <b>${pct(m.firstDraw / Math.max(1, s.assets), 2)}</b>`,
    `<b>成功</b> = 到 ${s.ageEnd} 歲時餘額 > 0；${m.paths} 條路徑中有 ${m.success} 條成功`,
    `= ${pct(m.successRate, 2)} → 四捨五入到 5% → <b>${rounded}%</b>`,
  ], '成功率一律四捨五入到 5%，是因為蒙地卡羅的輸出本來就沒有兩位數的精度。把 73.4% 寫出來會讓人以為那是一個測量值，它不是。'));

  host.appendChild(poolF
    ? formulaBlock('攤開看：報酬 r_t 是怎麼生成的', [
      `<b>模式</b> 歷史區塊拔靴（block = ${BLOCK} 年），抽樣池 ${poolF.meta.label} ${poolF.startYear}-${poolF.endYear}`,
      `<b>母體</b> ${poolF.n} 個年度，算術平均 ${pp(mean(poolF.raw), 2)}、標準差 ${dec(stdev(poolF.raw), 2)}%、年化 ${pp(cagr(poolF.stock).annual * 100, 2)}`,
      `每 ${BLOCK} 年一塊、隨機起點、跨越尾端就繞回開頭，抽到 ${m.n} 年為止`,
      `r<sub>股</sub>(t) = 抽中年度的實際報酬；r<sub>債</sub>(t) = <b>同一個年度</b>的美國 10 年期公債模型化報酬`,
      `r<sub>t</sub> = ${dec(s.stock / 100, 2)}·r<sub>股</sub> + ${dec(s.bond / 100, 2)}·r<sub>債</sub> + ${dec(cash / 100, 2)}·${pp(s.muc, 2)}（現金無波動）`,
      `<b>不使用</b> μ、σ、ρ：股債共動來自同一批年度，不是相關係數假設`,
      s.crashOn && wF
        ? `<b>順序風險</b> 前 5 年強制換成 ${poolF.startYear + wF.i}-${poolF.startYear + wF.i + 4}，這個池子裡實際最差的連續 5 年（累計 ${pp((wF.cum - 1) * 100, 1)}），債券同年度`
        : `<b>順序風險</b> 未套用。打開左邊的開關，前 5 年會被換成這個池子裡實際最差的連續 5 年`,
      `<b>亂數</b> mulberry32，種子固定，所以同一組輸入永遠畫出同一張圖`,
    ], `區塊拔靴只會重排歷史，不會創造歷史。${poolF.n} 個年度撐 ${m.n} 年的退休期間，樣本本來就薄；${poolF.key === 'taiex' ? '而且台股這 22 年幾乎全在多頭，成功率會偏高、尾端會偏薄。' : '而且它是美元計價的美國市場，不是台股。'}`)
    : formulaBlock('攤開看：報酬 r_t 是怎麼生成的', [
      `<b>模式</b> 參數化常態（另一個選項是歷史區塊拔靴，block = ${BLOCK} 年）`,
      `r<sub>股</sub> = μ<sub>股</sub> + σ<sub>股</sub>·z₁　= ${pp(s.mus, 2)} + ${pp(s.sigs, 2)}·z₁`,
      `r<sub>債</sub> = μ<sub>債</sub> + σ<sub>債</sub>·(ρ·z₁ + √(1−ρ²)·z₂)　ρ = ${dec(s.rho, 2)}`,
      `r<sub>t</sub> = ${dec(s.stock / 100, 2)}·r<sub>股</sub> + ${dec(s.bond / 100, 2)}·r<sub>債</sub> + ${dec(cash / 100, 2)}·${pp(s.muc, 2)}`,
      s.crashOn
        ? `<b>順序風險</b> 前 5 年的 r<sub>股</sub> 被替換成一組形狀固定、等比縮放到累計 ${dec(s.crashDepth, 0)}% 的序列（形狀假設，不是任何一段真實歷史）`
        : `<b>順序風險</b> 未套用。打開左邊的開關，前 5 年的股票報酬會被強制換掉`,
      `<b>亂數</b> mulberry32，種子固定，所以同一組輸入永遠畫出同一張圖`,
    ], 'μ、σ、ρ 全部是模型假設，不是查證過的歷史統計。它們可以在左欄「攤開改：報酬假設」裡改掉，改完這一頁所有數字都會跟著換。'));

  if (s.strategy === 'guardrail') {
    const g = RULES.assumptions?.find((a) => a.key === 'guardrail') || {};
    host.appendChild(formulaBlock('攤開看：動態護欄怎麼動', [
      `初始提領率 w₀ = 首年淨提領 ÷ 期初資產 = <b>${pct(m.firstDraw / Math.max(1, s.assets), 2)}</b>`,
      `當年提領率 > w₀ × ${dec(g.upper ?? 1.2, 2)} → 當年提領 × ${dec(1 - (g.cut ?? 0.1), 2)}`,
      `當年提領率 < w₀ × ${dec(g.lower ?? 0.8, 2)} → 當年提領 × ${dec(1 + (g.raise ?? 0.1), 2)}`,
      `代價：這條規則要求你在壞年頭真的少花錢，模型不會替你做這件事`,
    ], 'Guyton-Klinger 簡化版。原始規則比這複雜，且同樣是研究結論而非法規。'));
  }
}

function renderSources() {
  const tb = $('#sourceRows');
  tb.replaceChildren();
  const rows = [];
  for (const r of RULES.legal || []) {
    rows.push({
      label: r.label,
      value: r.display || (r.value == null ? '未收錄'
        : (r.unit === '累計成長率' ? pct(r.value, 0) : `${r.value}${r.unit === '歲' ? ' 歲' : ''}`)),
      status: r.status, basis: r.legalBasis, url: r.sourceUrl,
    });
  }
  // 序列：數字本身在 assets/data/tw-returns.json，這裡只列描述、用途與出處
  for (const q of RULES.series || []) {
    rows.push({
      label: q.label,
      value: q.display || `${q.n} 個年度`,
      status: q.status,
      basis: (q.role ? `用途：${q.role}。` : '') + (q.legalBasis || ''),
      url: q.sourceUrl,
    });
  }
  for (const a of RULES.assumptions || []) {
    const v = a.mu != null ? `μ ${pp(a.mu * 100, 1)}／σ ${pp((a.sigma || 0) * 100, 1)}`
      : a.shape ? a.shape.map((x) => pp(x * 100, 0)).join(' ')
      : a.value != null ? (a.key === 'correlation' ? dec(a.value, 2) : pp(a.value * 100, 1))
      : a.upper != null ? `${a.upper}／${a.lower}／±${pp(a.cut * 100, 0)}` : '-';
    rows.push({ label: a.label, value: v, status: a.status, basis: a.note, url: a.sourceUrl });
  }
  for (const r of rows) {
    tb.appendChild(el('tr', {}, [
      el('td', { text: r.label }),
      el('td', { text: r.value }),
      el('td', {}, [el('span', {
        class: 'chip' + (r.status === 'verified' ? ' chip--on' : ''),
        text: r.status === 'verified' ? '已查證' : '未查證',
      })]),
      el('td', {}, [
        el('span', { text: (r.basis || '') + ' ' }),
        r.url ? el('a', { href: r.url, target: '_blank', rel: 'noopener', text: '法源' }) : null,
      ]),
    ]));
  }

  // 徽章數字直接從同一份 rows 數出來，不會跟表格對不上
  const bad = rows.filter((r) => r.status !== 'verified').length;
  const badge = $('#unverifiedBadge');
  badge.textContent = bad ? `未查證 ${bad} 項` : '全部已查證';
  badge.classList.toggle('chip--on', bad === 0);
  badge.title = bad ? '這幾項是模型假設，不是事實，全部可以在左欄改掉。' : '';
}

/* ==========================================================================
   10. 啟動
   ========================================================================== */
async function boot() {
  try {
    const res = await fetch('./rules.json');
    if (res.ok) {
      RULES = await res.json();
      $('#dataver').textContent = `資料版本 ${RULES.version}`;
      $('#dataver').title = RULES.note || '';
      $('#dataver2').textContent = `資料版本 ${RULES.version}．建置 ${RULES.builtAt}`;
      // 使用者沒動過報酬假設時，以 rules.json 為準
      const d = DEFAULTS();
      const s = S();
      const untouched = ['mus', 'sigs', 'mub', 'sigb', 'muc', 'rho', 'infl'].every((k) => s[k] === d[k]);
      if (untouched && !store.cameFromLink) {
        const g = (k) => RULES.assumptions.find((a) => a.key === k) || {};
        store.set({
          mus: (g('stock').mu ?? 0.07) * 100, sigs: (g('stock').sigma ?? 0.18) * 100,
          mub: (g('bond').mu ?? 0.025) * 100, sigb: (g('bond').sigma ?? 0.06) * 100,
          muc: (g('cash').mu ?? 0.013) * 100, rho: g('correlation').value ?? 0.15,
          infl: (g('inflation').value ?? 0.02) * 100,
        }, { silent: true });
      }
    } else {
      $('#dataver').textContent = '資料版本 離線';
    }
  } catch {
    $('#dataver').textContent = '資料版本 離線';
  }

  // 年度報酬序列與生命表：共用檔，這個 App 只讀不寫
  try {
    const res = await fetch(RULES.dataFile || '../../assets/data/tw-returns.json');
    if (res.ok) {
      const d = await res.json();
      if (d?.series?.taiexTotalReturn?.values?.length) DATA = d;
      if (DATA) $('#dataver').title = (RULES.note || '') + `\n序列：tw-returns.json ${DATA.version}（查證於 ${DATA.verifiedAt}）`;
    }
  } catch { /* 載不進來就讓歷史模式退回拒答，不猜 */ }

  syncInputs();
  renderSources();
  legendHTML($('#fanLegend'), [
    { label: '中間 50%', color: cssv('--accent'), band: true },
    { label: '10-90%', color: cssv('--accent'), band: true },
    { label: '中位路徑', color: cssv('--accent') },
    { label: '歸零', color: cssv('--up') },
  ]);
  paintMode();

  // 首屏就是論點：預設值一載入就跑出一把看得見失敗路徑的扇子
  run();

  printRows($$('#readouts .readout'), { stagger: 0.06, delay: 0.15 });
  if (store.cameFromLink) toast('已載入別人傳給你的情境');
}

boot();
