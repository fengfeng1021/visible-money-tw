/* 台股 ETF 起始日樂透
   論點：同一檔標的、同樣的持有年數，換一個起始月結果差多少。
   所以這裡不輸出一個報酬率，輸出所有可能起始月的分布。 */

window.addEventListener('error', (e) => { window.__err = String(e.message); });

import { gsap, printRows, stampIn, makeCounter, carbonTransfer, still } from '../../assets/js/core/motion.js';
import { Plot, histogram, quantile } from '../../assets/js/core/plot.js';
import { irr, maxDrawdown, nhiSupplement, twTradeCost } from '../../assets/js/core/fin.js';
import { createStore } from '../../assets/js/core/state.js';
import {
  $, $$, el, bindSlider, bindField, bindSegmented,
  mountTopbar, mountShare, mountTheme, toast, formulaBlock, createTip,
} from '../../assets/js/core/ui.js';
import { int, dec, money, pct, pp, clamp } from '../../assets/js/core/format.js';

/* ==========================================================================
   常數與狀態
   ========================================================================== */

/** 一頁最多同時疊五檔，色票沿用圖表序列色（與漲紅跌綠的語意色分離）。 */
const SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5'];
const BINS = 40;

/** 拒答門檻：起始月少於這個數就不畫分布。載入 rules.json 後會被覆寫。 */
let MIN_STARTS = 24;

let RULES = null;
let MARKET = null;          // { builtAt, dataFloor, tickers: [...] }
const TICKERS = [];         // 依 index.json 順序，含載入後的還原序列

const DEFAULTS = {
  tickers: ['0050', '0056'],
  years: 3,
  mode: 'lump',
  amount: 600000,
  monthly: 10000,
  splitMonths: 12,
  disc: 0.6,
  minFee: 20,
  divMode: 'reinvest',
  taxMode: 'combined',
  marginal: 0.12,
  nhi: true,
};

const store = createStore('vm:etf-lottery', { ...DEFAULTS });

/* ==========================================================================
   版面掛載
   ========================================================================== */
mountTopbar({ title: '台股 ETF 起始日樂透' });
const actions = $('#sheetActions');
mountShare(actions, store);
mountTheme(actions);

const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* ==========================================================================
   資料層：還原權息序列
   ------------------------------------------------------------------------
   規則一：報酬一律只用 adj（還原權息價）。close 是未還原價，只在方法論面板
   裡當作對照顯示，任何報酬運算都不准碰它。
   規則二：分割事件若 bundled 資料未處理，會在序列上留下一道假崩盤。載入時
   逐一比對 rules.json 宣告的分割，只有在「確實還沒被處理」時才補除以倍數，
   避免重複修正。修不掉的異常直接把該檔標成不可用。
   ========================================================================== */

/** 把 YYYY-MM-DD 轉成可比較的字串即可，不需要 Date 物件。 */
const ym = (d) => String(d).slice(0, 7);

function buildTicker(meta, raw) {
  const months = raw.monthly.map((m) => ({ ym: m.ym, date: m.date, adj: m.adj, close: m.close }));
  const events = (raw.adjustments || []).map((a) => ({ date: a.date, f: a.factor, kind: a.kind }));
  const t = {
    id: raw.id, name: raw.name, listed: raw.listed,
    months, events,
    n: months.length,
    splitFixes: [],
    broken: null,
  };

  // --- 分割修正（只在還沒被處理時才做） ---
  for (const sp of (RULES?.splits || [])) {
    if (sp.id !== t.id) continue;
    const k = months.findIndex((m) => m.date >= sp.date);
    if (k <= 0) continue;
    const ratio = months[k].adj / months[k - 1].adj;
    const expectedIfUnfixed = 1 / sp.ratio;   // 1 拆 4 → 未修正時會看到 ≈0.25
    if (Math.abs(ratio - expectedIfUnfixed) < expectedIfUnfixed * 0.4) {
      for (let i = 0; i < k; i++) months[i].adj /= sp.ratio;
      t.splitFixes.push({ ...sp, appliedAt: months[k].ym, fixed: true });
    } else {
      t.splitFixes.push({ ...sp, appliedAt: months[k].ym, fixed: false });
    }
  }

  // --- 完整性檢核：任何月對月 −40% 以上的跳空都視為未還原／未修正的痕跡 ---
  for (let i = 1; i < months.length; i++) {
    const r = months[i].adj / months[i - 1].adj;
    if (!(r > 0.6)) {
      t.broken = `${months[i].ym} 的還原價較前一個月掉了 ${pct(1 - r, 1)}，`
        + '這個幅度不像市場波動，比較像未處理的分割或未還原的價格。這一檔已被停用。';
      break;
    }
  }

  // --- px：與未還原收盤價等比的序列，只用來算「配息現金流」與「領現金」路徑 ---
  //     px_t = adj_t × Π(除息日 ≤ t 的因子)。它與 close 成固定比例，但由 adj 導出，
  //     所以不必、也沒有讀取 close 欄位。
  let cum = 1, ei = 0;
  const sorted = [...events].sort((a, b) => (a.date < b.date ? -1 : 1));
  t.evByMonth = new Array(months.length).fill(null);
  for (let i = 0; i < months.length; i++) {
    while (ei < sorted.length && sorted[ei].date <= months[i].date) {
      cum *= sorted[ei].f;
      (t.evByMonth[i] || (t.evByMonth[i] = [])).push(sorted[ei]);
      ei++;
    }
    months[i].px = months[i].adj * cum;
  }

  t.adj = months.map((m) => m.adj);
  t.px = months.map((m) => m.px);
  return t;
}

/** 這一檔在目前資料量下，最長能回答到幾年。0 代表任何視窗都答不了。 */
function maxYears(t) {
  return Math.max(0, Math.floor((t.n - MIN_STARTS) / 12));
}

/* ==========================================================================
   回測核心
   ------------------------------------------------------------------------
   對每一個可能的起始月 i 各跑一次。同一趟同時記錄「零成本毛路徑」與
   「扣完手續費、證交稅、股利稅、補充保費的淨路徑」，成本瀑布才對得起來。
   ========================================================================== */

function contributionAt(cfg, k, W) {
  if (cfg.mode === 'lump') return k === 0 ? cfg.amount : 0;
  if (cfg.mode === 'dca') return k < W ? cfg.monthly : 0;
  const n = Math.max(1, Math.min(cfg.splitMonths, W));
  return k < n ? cfg.amount / n : 0;
}

function runWindow(t, i, W, cfg) {
  const e = i + W;
  const px = t.px;
  const fee = (amt, side) => (cfg.costs
    ? twTradeCost(amt, { side, discount: cfg.disc, minFee: cfg.minFee, feeRate: cfg.feeRate, taxRate: cfg.stt })
    : 0);

  let shares = 0, sharesG = 0;
  let invested = 0, cash = 0, cashG = 0;
  let tradeCost = 0;
  let nhiTotal = 0;
  const divByYear = new Map();
  const flows = [];

  for (let m = i; m <= e; m++) {
    const k = m - i;

    // 除息：以前一個月底的價格當作除息前價，本月才算得到（買在 i 月底，i 月的息已經過了）
    if (m > i && t.evByMonth[m]) {
      const pre = px[m - 1];
      for (const ev of t.evByMonth[m]) {
        const d = shares * pre * (1 - ev.f);
        const dg = sharesG * pre * (1 - ev.f);
        if (d > 0) {
          const y = ev.date.slice(0, 4);
          divByYear.set(y, (divByYear.get(y) || 0) + d);
          if (cfg.nhi) nhiTotal += nhiSupplement(d, { rate: cfg.nhiRate, floor: cfg.nhiFloor, cap: cfg.nhiCap });
        }
        if (cfg.divMode === 'reinvest') {
          const c = Math.min(d, fee(d, 'buy'));
          tradeCost += c;
          shares += (d - c) / (pre * ev.f);
          sharesG += dg / (pre * ev.f);
        } else {
          cash += d; cashG += dg;
        }
      }
    }

    const c = contributionAt(cfg, k, W);
    if (c > 0) {
      const f0 = fee(c, 'buy');
      tradeCost += f0;
      shares += (c - f0) / px[m];
      sharesG += c / px[m];
      invested += c;
      flows.push(-c);
    } else {
      flows.push(0);
    }
  }

  // 期末一次賣出
  const proceeds = shares * px[e];
  const sellCost = fee(proceeds, 'sell');
  tradeCost += sellCost;

  const grossV = sharesG * px[e] + cashG;
  const beforeTax = proceeds - sellCost + cash;

  // 股利稅：逐年結算（8.5% 抵減上限是「每一申報戶每年」8 萬元）
  let divTax = 0;
  let divTotal = 0;
  for (const [, amt] of divByYear) {
    divTotal += amt;
    if (cfg.taxMode === 'separate') divTax += amt * cfg.sepRate;
    else if (cfg.taxMode === 'combined') {
      divTax += amt * cfg.marginal - Math.min(amt * cfg.creditRate, cfg.creditCap);
    }
  }

  const netV = beforeTax - divTax - nhiTotal;
  flows[flows.length - 1] += netV;

  // 年化：單筆是單一現金流，閉式解即可；分批則求 IRR（不規則現金流的正確年化）
  const years = W / 12;
  let ann;
  if (cfg.mode === 'lump') {
    ann = invested > 0 && netV > 0 ? Math.pow(netV / invested, 1 / years) - 1 : (invested > 0 ? -1 : NaN);
  } else {
    const r = irr(flows, cfg.warm);
    ann = Number.isFinite(r) ? Math.pow(1 + r, 12) - 1 : NaN;
    if (Number.isFinite(r)) cfg.warm = r;
  }

  const dd = maxDrawdown(t.adj.slice(i, e + 1));

  return {
    i, e, startYm: t.months[i].ym, endYm: t.months[e].ym,
    invested, netV, grossV, tradeCost, divTax, nhi: nhiTotal, divTotal,
    ann, mdd: dd.mdd,
  };
}

function runTicker(t, W, cfg) {
  const starts = t.n - 1 - W;
  const out = [];
  const c = { ...cfg, warm: 0.006 };
  for (let i = 0; i <= starts; i++) out.push(runWindow(t, i, W, c));
  return out;
}

/** 分位數摘要。values 必須先排序。 */
function summarize(rows) {
  const vs = rows.map((r) => r.ann).filter(Number.isFinite).sort((a, b) => a - b);
  const mdds = rows.map((r) => r.mdd).filter(Number.isFinite).sort((a, b) => a - b);
  if (!vs.length) return null;
  return {
    n: vs.length,
    min: vs[0], max: vs[vs.length - 1],
    p10: quantile(vs, 0.1), p25: quantile(vs, 0.25),
    med: quantile(vs, 0.5),
    p75: quantile(vs, 0.75), p90: quantile(vs, 0.9),
    win: vs.filter((v) => v > 0).length / vs.length,
    mddMed: quantile(mdds, 0.5),
    values: vs,
  };
}

/* ==========================================================================
   輸入元件
   ========================================================================== */
function patch(p, { recompute = true, from } = {}) {
  store.set(p);
  if (recompute) compute({ from });
}

function renderTickerList() {
  const host = $('#tickerList');
  host.replaceChildren();
  const sel = store.at('tickers');
  TICKERS.forEach((t, idx) => {
    const on = sel.includes(t.id);
    const my = maxYears(t);
    const label = t.broken
      ? '資料異常'
      : (my <= 0 ? '樣本不足' : `${t.months[0].ym.replace('-', '/')} 起・最長 ${my} 年`);
    const row = el('label', {
      class: 'tk',
      dataset: { short: my < 5 || t.broken ? '1' : '0' },
    }, [
      el('input', {
        type: 'checkbox', checked: on, disabled: !!t.broken,
        onchange: (ev) => {
          const cur = store.at('tickers');
          const next = ev.target.checked ? [...cur, t.id] : cur.filter((x) => x !== t.id);
          patch({ tickers: next }, { from: 'ticker' });
          renderTickerList();
        },
      }),
      el('span', { class: 'tk__box' }),
      el('span', { class: 'tk__key', style: `background:${on ? cssv(SERIES_VARS[idx % 5]) : 'var(--rule)'}` }),
      el('span', { class: 'tk__id', text: t.id }),
      el('span', { class: 'tk__name', text: t.name }),
      el('span', { class: 'tk__span', text: label }),
    ]);
    host.appendChild(row);
  });
}

const sYears = bindSlider($('#s-years'), {
  format: (v) => `${v}<small>年</small>`,
  onInput: (v) => patch({ years: v }, { from: 'years' }),
});

const segMode = bindSegmented($('#seg-mode'), {
  onChange: (v) => {
    store.set({ mode: v });
    syncModeUI();
    fAmount.set(v === 'dca' ? store.at('monthly') : store.at('amount'), { silent: true });
    compute({ from: 'mode' });
  },
});

const segDiv = bindSegmented($('#seg-div'), {
  onChange: (v) => patch({ divMode: v }, { from: 'div' }),
});

const fAmount = bindField($('#f-amount'), {
  pretty: int,
  validate: (v) => {
    if (!Number.isFinite(v) || v <= 0) return '請填入大於 0 的金額';
    if (v > 1e9) return '這個金額超出試算範圍';
    return null;
  },
  onChange: (v, { valid }) => {
    if (!valid) return;
    patch(store.at('mode') === 'dca' ? { monthly: v } : { amount: v }, { from: 'amount' });
  },
});

const fSplit = bindField($('#f-split'), {
  validate: (v) => (Number.isFinite(v) && v >= 1 && v <= 60 ? null : '請填 1 到 60 之間的月數'),
  onChange: (v, { valid }) => { if (valid) patch({ splitMonths: Math.round(v) }, { from: 'split' }); },
});

const fDisc = bindField($('#f-disc'), {
  validate: (v) => (Number.isFinite(v) && v > 0 && v <= 1 ? null : '折數請填 0 到 1 之間，例如六折是 0.6'),
  onChange: (v, { valid }) => { if (valid) patch({ disc: v }, { from: 'cost' }); },
});

const fMinFee = bindField($('#f-minfee'), {
  validate: (v) => (Number.isFinite(v) && v >= 0 && v <= 1000 ? null : '請填 0 到 1000 之間'),
  onChange: (v, { valid }) => { if (valid) patch({ minFee: v }, { from: 'cost' }); },
});

const fTaxMode = bindField($('#f-taxmode'), {
  onChange: (v) => { patch({ taxMode: v }, { from: 'tax' }); syncModeUI(); },
});

const fMarginal = bindField($('#f-rate'), {
  onChange: (v) => patch({ marginal: Number(v) }, { from: 'tax' }),
});

$('#chk-nhi').addEventListener('change', (e) => patch({ nhi: e.target.checked }, { from: 'tax' }));

$('#resetBtn').addEventListener('click', () => {
  store.replace({ ...DEFAULTS });
  location.replace(location.pathname);
});

/** 依投入方式切換欄位標籤與可見性；股利稅制決定邊際稅率欄位是否有意義。 */
function syncModeUI() {
  const s = store.get();
  const isDca = s.mode === 'dca';
  $('#l-amount').textContent = isDca ? '每月扣款金額' : (s.mode === 'split' ? '總金額' : '單筆金額');
  $('#h-amount').textContent = isDca
    ? '每月扣款愈小，20 元最低手續費的侵蝕愈兇，成本瀑布會把這件事放大給你看。'
    : '金額只影響最低手續費的侵蝕程度與絕對金額，不影響報酬率的形狀。';
  $('#f-split').hidden = s.mode !== 'split';

  const rate = $('#f-rate');
  const combined = s.taxMode === 'combined';
  rate.querySelector('select').disabled = !combined;
  if (combined) rate.removeAttribute('data-disabled');
  else rate.setAttribute('data-disabled', '');
}

function syncInputs() {
  const s = store.get();
  sYears.set(s.years, { silent: true });
  segMode.set(s.mode);
  segDiv.set(s.divMode);
  fAmount.set(s.mode === 'dca' ? s.monthly : s.amount, { silent: true });
  fSplit.set(s.splitMonths, { silent: true });
  fDisc.set(s.disc, { silent: true });
  fMinFee.set(s.minFee, { silent: true });
  fTaxMode.el.value = s.taxMode;
  fMarginal.el.value = String(s.marginal);
  $('#chk-nhi').checked = !!s.nhi;
  renderTickerList();
  syncModeUI();
}

/* ==========================================================================
   招牌視覺：分布直方圖 ＋ 箱型圖
   ------------------------------------------------------------------------
   直方圖交給 Plot 的 bars（它的 _morph 會把柱子從舊形狀流到新形狀，
   這就是「沙堆重新塌陷」）；箱型圖畫在同一張畫布的上方留白帶，
   用一條平行的 gsap tween 讓兩者同步。
   ========================================================================== */
const distPlot = new Plot($('#chartDist'), {
  aspect: 0.62, minHeight: 260, maxHeight: 420,
  yFormat: (v) => String(Math.round(v)),
  xFormat: (v) => pp(v * 100, 0),
  yTicks: 4, xTicks: 5,
  padding: { left: 40, right: 14, top: 40, bottom: 30 },
});

const distTip = createTip($('#distCard'));

/** boxCur 是「現在畫面上的」箱型圖，boxTarget 是新算出來的，用 tween 補中間。 */
let boxCur = [];

function drawBoxes() {
  const p = distPlot, ctx = p.ctx;
  if (!p.domain || !boxCur.length) return;
  const L = p.pad.left, R = p.w - p.pad.right;
  const X = (v) => clamp(p.sx(v), L, R);
  ctx.save();
  boxCur.forEach((b, row) => {
    if (!b.on) return;
    const y = 6 + row * 15;
    const h = 9;
    ctx.strokeStyle = b.color; ctx.fillStyle = b.color;
    ctx.lineWidth = 1;
    // 鬚：最差 → 最好
    ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.moveTo(X(b.min), y + h / 2); ctx.lineTo(X(b.max), y + h / 2); ctx.stroke();
    for (const v of [b.min, b.max]) {
      const x = Math.round(X(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, y + 1.5); ctx.lineTo(x, y + h - 1.5); ctx.stroke();
    }
    // 箱：P25–P75
    const x0 = X(b.p25), x1 = X(b.p75);
    ctx.globalAlpha = 0.2;
    ctx.fillRect(Math.round(x0), y, Math.max(1, Math.round(x1 - x0)), h);
    ctx.globalAlpha = 0.95;
    ctx.strokeRect(Math.round(x0) + 0.5, y + 0.5, Math.max(1, Math.round(x1 - x0)), h - 1);
    // P10 / P90 細刻
    ctx.globalAlpha = 0.8;
    for (const v of [b.p10, b.p90]) {
      const x = Math.round(X(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, y + 2.5); ctx.lineTo(x, y + h - 2.5); ctx.stroke();
    }
    // 中位：粗線
    ctx.globalAlpha = 1; ctx.lineWidth = 2.5;
    const xm = Math.round(X(b.med));
    ctx.beginPath(); ctx.moveTo(xm, y - 1); ctx.lineTo(xm, y + h + 1); ctx.stroke();
  });
  ctx.restore();
}

const distBaseRender = Plot.prototype.render.bind(distPlot);
distPlot.render = () => { distBaseRender(); drawBoxes(); };

const costPlot = new Plot($('#chartCost'), {
  aspect: 0.42, minHeight: 190, maxHeight: 300,
  yFormat: (v) => (Math.abs(v) >= 10000 ? dec(v / 10000, 1) + '萬' : String(Math.round(v))),
  xFormat: () => '',
  yTicks: 4,
  padding: { left: 48, right: 14, top: 26, bottom: 34 },
});

/* 扣項相對於獲利常常只有百分之幾，柱子矮到看不見——那正是誠實的答案，
   但看不見就沒有溝通到。所以每一根柱子都直接標上金額。 */
let costLabels = [];
const costBaseRender = Plot.prototype.render.bind(costPlot);
costPlot.render = () => {
  costBaseRender();
  if (!costLabels.length || !costPlot.domain) return;
  const ctx = costPlot.ctx;
  ctx.save();
  ctx.font = `700 10px ${cssv('--font-mono') || 'monospace'}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (const L of costLabels) {
    ctx.fillStyle = L.color;
    ctx.fillText(L.text, costPlot.sx(L.x), Math.max(11, costPlot.sy(L.top) - 4));
  }
  ctx.restore();
};

const ddPlot = new Plot($('#chartDD'), {
  aspect: 0.34, minHeight: 150, maxHeight: 240,
  yFormat: (v) => pp(v * 100, 0),
  xFormat: (v) => (v <= 0 ? '起點' : Math.round(v / 12) + '年'),
  yTicks: 4,
  padding: { left: 48, right: 14, top: 14, bottom: 28 },
});

/* ==========================================================================
   讀數
   ========================================================================== */
const cMedian = makeCounter($('#r-median'), (v) => pp(v * 100, 1, { sign: true }));
const cWorst = makeCounter($('#r-worst'), (v) => pp(v * 100, 1, { sign: true }));
const cBest = makeCounter($('#r-best'), (v) => pp(v * 100, 1, { sign: true }));
const cWin = makeCounter($('#r-win'), (v) => pp(v * 100, 0));
const cN = makeCounter($('#r-n'), (v) => int(v));
const cNeff = makeCounter($('#r-neff'), (v) => int(v));
const cLwin = makeCounter($('#r-lwin'), (v) => pp(v * 100, 0));
const cLwinAmt = makeCounter($('#r-lwinamt'), (v) => money(Math.round(v)));
const cLlossAmt = makeCounter($('#r-llossamt'), (v) => money(Math.round(v)));

/* ==========================================================================
   計算與繪製
   ========================================================================== */
let ghostBins = null;       // 上一次的分布輪廓，切換標的時留在圖上
let stampedFor = null;

function cfgFrom(s) {
  const tr = RULES?.trading || {};
  const dt = RULES?.dividendTax || {};
  const nh = RULES?.nhi || {};
  return {
    mode: s.mode,
    amount: s.amount,
    monthly: s.monthly,
    splitMonths: s.splitMonths,
    disc: s.disc,
    minFee: s.minFee,
    feeRate: tr.feeRateMax?.value ?? 0.001425,
    stt: tr.sttEtf?.value ?? 0.001,
    divMode: s.divMode,
    taxMode: s.taxMode,
    marginal: s.marginal,
    creditRate: dt.creditRate?.value ?? 0.085,
    creditCap: dt.creditCapPerHousehold?.value ?? 80000,
    sepRate: dt.separateRate?.value ?? 0.28,
    nhi: !!s.nhi,
    nhiRate: nh.rate?.value ?? 0.0211,
    nhiFloor: nh.floor?.value ?? 20000,
    nhiCap: nh.cap?.value ?? 10000000,
    costs: true,
  };
}

function compute({ from } = {}) {
  if (!TICKERS.length) return;
  const s = store.get();
  const W = Math.round(s.years * 12);
  const cfg = cfgFrom(s);

  const chosen = TICKERS.filter((t) => s.tickers.includes(t.id) && !t.broken);
  $('#tickerError').textContent = s.tickers.length === 0 ? '至少要選一檔標的。' : '';

  // --- 逐檔判斷可不可回答 ---
  const usable = [];
  const refused = [];
  for (const t of chosen) {
    if (t.n - 1 - W < MIN_STARTS - 1) refused.push(t);
    else usable.push(t);
  }

  const results = usable.map((t) => {
    const rows = runTicker(t, W, cfg);
    return { t, rows, sum: summarize(rows) };
  }).filter((r) => r.sum);

  renderRefusal(refused, usable, W);

  const hasData = results.length > 0;
  $('#distCard').hidden = !hasData;
  $('#sampleCard').hidden = !hasData;
  $('#tableCard').hidden = !hasData;
  $('#costCard').hidden = !hasData;
  $('#ddCard').hidden = !hasData;
  $('#lumpCard').hidden = !hasData;

  if (!hasData) {
    $('#verdict-h').textContent = '這個問題現在回答不了';
    $('#verdictBody').textContent = '選到的標的在這個持有年數下沒有足夠的起始月可以取樣。把年數拉短，或改選上市較久的標的。';
    const stamp = $('#verdictStamp');
    stamp.hidden = false;
    if (stampedFor !== 'refuse') {
      stamp.innerHTML = '<span class="stamp stamp--void">資料不足</span>';
      stampIn(stamp.firstElementChild);
      stampedFor = 'refuse';
    }
    return;
  }

  renderDistribution(results, W, from);
  renderReadouts(results, W);
  renderSample(results, W);
  renderTable(results);
  renderCost(results[0], W, s);
  renderDrawdown(results[0]);
  renderLumpVsSplit(results[0].t, W, cfg, s);
  renderVerdict(results, W, s);
  renderFormula(results[0], W, s, cfg);

  if (from) carbonTransfer($$('[data-live]'));
}

/* ---------- 分布圖 ---------- */
function renderDistribution(results, W, from) {
  // 共用的分箱範圍：所有可見標的取聯集，這樣分布之間可以直接比寬窄
  let lo = Infinity, hi = -Infinity;
  for (const r of results) { lo = Math.min(lo, r.sum.min); hi = Math.max(hi, r.sum.max); }
  const padX = (hi - lo) * 0.04 || 0.01;
  lo -= padX; hi += padX;

  const idxOf = (id) => TICKERS.findIndex((t) => t.id === id);
  const series = TICKERS.map((t, idx) => {
    const r = results.find((x) => x.t.id === t.id);
    const h = r ? histogram(r.sum.values, BINS, lo, hi) : null;
    const data = h
      ? h.bins.map((b) => ({ x: b.x, y: b.y }))
      : new Array(BINS).fill(0).map((_, k) => ({ x: lo + ((hi - lo) / BINS) * (k + 0.5), y: 0 }));
    return {
      type: 'bars', data,
      color: cssv(SERIES_VARS[idx % 5]),
      alpha: r ? (results.indexOf(r) === 0 ? 0.72 : 0.46) : 0,
      barRatio: 0.94,
      hidden: !r,
      noCursor: true,
    };
  });

  // 前一個情境的鬼影輪廓
  const ghostData = ghostBins && ghostBins.length === BINS
    ? ghostBins
    : new Array(BINS).fill(0).map((_, k) => ({ x: lo + ((hi - lo) / BINS) * (k + 0.5), y: 0 }));
  series.push({
    type: 'line', data: ghostData, color: cssv('--ghost'),
    width: 1.5, dash: [3, 3], noCursor: true, hidden: !ghostBins,
  });

  // 箱型圖佔用上方留白帶，行數隨可見標的數變動
  const padTop = 12 + results.length * 15;
  if (distPlot.opts.padding.top !== padTop) {
    distPlot.opts.padding.top = padTop;
    distPlot.pad.top = padTop;
  }

  const targets = results.map((r) => ({
    on: 1, color: cssv(SERIES_VARS[idxOf(r.t.id) % 5]),
    min: r.sum.min, p10: r.sum.p10, p25: r.sum.p25,
    med: r.sum.med, p75: r.sum.p75, p90: r.sum.p90, max: r.sum.max,
  }));

  const animate = from === 'years' || from === 'cost' || from === 'tax' || from === 'div';
  if (boxCur.length !== targets.length || !animate || still()) {
    boxCur = targets.map((b) => ({ ...b }));
  } else {
    // 和 Plot._morph 同樣的長度與曲線，柱子與箱子才會一起流動
    const keys = ['min', 'p10', 'p25', 'med', 'p75', 'p90', 'max'];
    boxCur.forEach((b, k) => {
      b.color = targets[k].color;
      gsap.killTweensOf(b);
      gsap.to(b, {
        duration: 0.5, ease: 'power2.out',
        ...Object.fromEntries(keys.map((key) => [key, targets[k][key]])),
      });
    });
  }

  distPlot.setSeries(series, { animate });
  distPlot.setMarks([
    { axis: 'x', value: 0, label: '不賺不賠', color: cssv('--rule-strong'), dash: [4, 4] },
    { axis: 'x', value: results[0].sum.med, label: `${results[0].t.id} 中位`, color: cssv('--accent'), dash: [6, 3] },
  ]);

  // 這一輪的主標的輪廓留給下一輪當鬼影
  const hPrimary = histogram(results[0].sum.values, BINS, lo, hi);
  ghostBins = hPrimary.bins.map((b) => ({ x: b.x, y: b.y }));

  // 游標提示要用的分位查表（順手存起來，不另外重算一次）
  window.__dist = results.map((r) => ({ id: r.t.id, values: r.sum.values }));

  // 圖例
  const lg = $('#legend');
  lg.replaceChildren();
  results.forEach((r) => {
    lg.appendChild(el('span', { class: 'legend__item' }, [
      el('span', { class: 'legend__key', style: `background:${cssv(SERIES_VARS[idxOf(r.t.id) % 5])}` }),
      el('span', { text: r.t.id }),
    ]));
  });

  // 圖表結論的文字通道
  $('#distDesc').innerHTML =
    `橫軸是扣完成本與稅之後的年化報酬率，縱軸是有幾個起始月落在那一格；上方橫條是箱型圖，`
    + `箱體為 P25-P75，粗線為中位，兩端細刻為 P10 與 P90，鬚線兩端是最差與最好的起始月。`
    + results.map((r) => `<br><b>${r.t.id} ${r.t.name}</b>：持有 ${W / 12} 年，${r.sum.n} 個起始月裡`
      + `最差 ${pp(r.sum.min * 100, 1)}、P10 ${pp(r.sum.p10 * 100, 1)}、中位 ${pp(r.sum.med * 100, 1)}、`
      + `P90 ${pp(r.sum.p90 * 100, 1)}、最好 ${pp(r.sum.max * 100, 1)}，`
      + `其中 ${pp(r.sum.win * 100, 0)} 的起始月是正報酬。`).join('');
}

/* ---------- 讀數與樣本 ---------- */
function renderReadouts(results, W) {
  const a = results[0].sum;
  cMedian(a.med); cWorst(a.min); cBest(a.max); cWin(a.win);
  const neff = Math.max(1, Math.floor(results[0].t.n / W));
  // 勝率旁邊永遠掛著有效樣本數，避免它被當成機率讀
  $('#r-winnote').textContent = `${results[0].t.id}・${W / 12} 年・有效樣本 ${neff}`;
}

function renderSample(results, W) {
  const r = results[0];
  const neff = Math.max(1, Math.floor(r.t.n / W));
  cN(r.sum.n);
  cNeff(neff);
  $('#r-span').textContent = `${r.t.months[0].ym} - ${r.t.months[r.t.n - 1].ym}`;
  // 有效樣本掉到個位數以下時，警告從「注意」升級成「停」
  $('#sampleNote').className = neff <= 2 ? 'note note--stop' : 'note note--warn';
  $('#sampleNote').innerHTML =
    `這 ${r.sum.n} 個起始月裡，相鄰兩個視窗共用了 ${pp((1 - 1 / W) * 100, 1)} 的月份，`
    + `所以它們不是 ${r.sum.n} 個獨立樣本。有效獨立樣本數 ≈ 總期間 ${r.t.n} 個月 ÷ 視窗 ${W} 個月 = <b>${neff}</b>。`
    + `<b>${neff} 個樣本不足以支撐任何統計顯著性的宣稱</b>，`
    + `上面的正報酬比例請讀成「歷史上這段期間有幾個起始月是賺的」，不是「未來賺錢的機率」。`
    + (neff <= 2
      ? `<br><b>這個持有年數已經長到整段歷史只裝得下 ${neff} 個不重疊的視窗</b>，`
      + `分布看起來很漂亮，但它其實只是同一段歷史被切了 ${r.sum.n} 次。`
      + `拉短年數會讓樣本變多，但也會讓運氣的影響變大；這個取捨沒有免費的解。`
      : '');
}

function renderTable(results) {
  const body = $('#qBody');
  body.replaceChildren();
  const idxOf = (id) => TICKERS.findIndex((t) => t.id === id);
  const f = (v) => pp(v * 100, 1);
  for (const r of results) {
    const tr = el('tr');
    tr.appendChild(el('td', {}, [
      el('span', { class: 'q-key', style: `background:${cssv(SERIES_VARS[idxOf(r.t.id) % 5])}` }),
      document.createTextNode(r.t.id),
    ]));
    for (const v of [r.sum.min, r.sum.p10, r.sum.p25, r.sum.med, r.sum.p75, r.sum.p90, r.sum.max]) {
      tr.appendChild(el('td', { class: v >= 0 ? 'is-up' : 'is-down', text: f(v) }));
    }
    tr.appendChild(el('td', { text: pp(r.sum.win * 100, 0) }));
    tr.appendChild(el('td', { class: 'is-down', text: f(r.sum.mddMed) }));
    body.appendChild(tr);
  }
  $('#tableFoot').textContent =
    '全部為扣掉手續費、證交稅、股利稅與補充保費之後的年化報酬率。'
    + '最大回撤取自該視窗內還原價的最深跌幅，中位數代表「一半的起始月比這更淺、一半更深」。';
}

/* ---------- 成本瀑布 ---------- */
function renderCost(res, W, s) {
  // 取中位數那一個起始月當代表，才不是挑一個好看的
  const sorted = [...res.rows].filter((r) => Number.isFinite(r.ann)).sort((a, b) => a.ann - b.ann);
  const rep = sorted[Math.floor(sorted.length / 2)];
  if (!rep) return;

  // 以「損益兩平」為基線畫獲利，而不是畫終值——終值的柱子太高，扣項會被壓成一條線。
  // 交易成本含它被扣掉之後少賺的複利，所以用毛淨差額回推，帳才會剛好平。
  const tradeAll = rep.grossV - rep.netV - rep.divTax - rep.nhi;
  const grossP = rep.grossV - rep.invested;
  const netP = rep.netV - rep.invested;
  const cuts = [
    { label: '交易成本', amt: tradeAll },
    { label: '股利稅', amt: rep.divTax },
    { label: '補充保費', amt: rep.nhi },
  ];

  const data = [{ x: 0, y: Math.min(0, grossP), y1: Math.max(0, grossP), color: cssv('--series-1') }];
  costLabels = [{ x: 0, top: Math.max(0, grossP), text: int(Math.round(grossP)), color: cssv('--ink-2') }];
  let run = grossP;
  cuts.forEach((st, k) => {
    const next = run - st.amt;
    data.push({
      x: k + 1,
      y: Math.min(run, next), y1: Math.max(run, next),
      color: st.amt >= 0 ? cssv('--down') : cssv('--up'),
    });
    costLabels.push({
      x: k + 1, top: Math.max(run, next, 0),
      text: st.amt === 0 ? '0' : '−' + int(Math.round(st.amt)),
      color: st.amt > 0 ? cssv('--down') : cssv('--ink-3'),
    });
    run = next;
  });
  data.push({ x: 4, y: Math.min(0, netP), y1: Math.max(0, netP), color: cssv('--accent') });
  costLabels.push({ x: 4, top: Math.max(0, netP), text: int(Math.round(netP)), color: cssv('--ink-2') });

  const labels = ['毛獲利', '交易成本', '股利稅', '補充保費', '淨獲利'];
  costPlot.opts.xTickValues = [0, 1, 2, 3, 4];
  costPlot.opts.xFormat = (v) => labels[Math.round(v)] || '';
  costPlot.setSeries([{ type: 'stack', data, barRatio: 0.6 }], { animate: false });
  // 兩端各留半格，否則第一根與最後一根的金額標籤會被畫布邊緣切掉
  costPlot.setDomain({ ...costPlot.domain, x0: -0.5, x1: 4.5 });

  const erosion = rep.grossV > rep.invested
    ? (rep.grossV - rep.netV) / (rep.grossV - rep.invested)
    : NaN;
  const perBuy = s.mode === 'dca' ? s.monthly : (s.mode === 'split' ? s.amount / Math.max(1, s.splitMonths) : s.amount);
  const minFeeBite = perBuy > 0 ? Math.max(s.minFee, Math.round(perBuy * (RULES?.trading?.feeRateMax?.value ?? 0.001425) * s.disc)) / perBuy : 0;

  $('#costDesc').innerHTML =
    `縱軸以損益兩平為基線畫「獲利」，不畫終值，因為終值的柱子太高，扣項會被壓成一條線。`
    + `以中位數那一個起始月（${rep.startYm} 進場、${rep.endYm} 出場）為例：`
    + `投入 ${int(Math.round(rep.invested))} 元，零成本的毛終值 ${int(Math.round(rep.grossV))} 元、`
    + `毛獲利 ${int(Math.round(grossP))} 元；交易成本吃掉 ${int(Math.round(tradeAll))} 元、`
    + `股利稅 ${int(Math.round(rep.divTax))} 元、補充保費 ${int(Math.round(rep.nhi))} 元，`
    + `淨到手 <b>${int(Math.round(rep.netV))}</b> 元、淨獲利 <b>${int(Math.round(netP))}</b> 元。`
    + (Number.isFinite(erosion) ? `成本與稅吃掉了這段獲利的 <b>${pp(erosion * 100, 1)}</b>。` : '')
    + `<br>每一筆買進的手續費率是 ${pp(minFeeBite * 100, 3)}`
    + (minFeeBite > 0.001 ? `：最低手續費 ${int(s.minFee)} 元把費率放大到牌告的 ${dec(minFeeBite / ((RULES?.trading?.feeRateMax?.value ?? 0.001425) * s.disc), 1)} 倍，這就是小額扣款最容易被忽略的破口。` : '（未觸及最低手續費）。')
    + (rep.nhi === 0 && s.nhi ? '<br>補充保費為 0：每一次配息都沒有達到 20,000 元的單次起扣門檻。' : '');
}

/* ---------- 最差起始月的水下曲線 ---------- */
function renderDrawdown(res) {
  const worst = res.rows.reduce((a, b) => (a && a.ann <= b.ann ? a : b), null);
  if (!worst) return;
  const adj = res.t.adj;
  const data = [];
  let peak = -Infinity;
  for (let k = worst.i; k <= worst.e; k++) {
    if (adj[k] > peak) peak = adj[k];
    data.push({ x: k - worst.i, y: adj[k] / peak - 1 });
  }
  ddPlot.setSeries([{
    type: 'area', data, color: cssv('--down'), fillAlpha: 0.18, width: 2,
  }], { animate: false });
  const deepest = data.reduce((a, b) => (a.y <= b.y ? a : b));
  $('#ddDesc').innerHTML =
    `最差的那一個起始月是 <b>${worst.startYm}</b>（做到 ${worst.endYm}，年化 ${pp(worst.ann * 100, 1)}）。`
    + `期間內最深曾經跌到距離高點 <b>${pp(deepest.y * 100, 1)}</b>，發生在第 ${Math.round(deepest.x)} 個月。`
    + `這條線是「你當時打開帳戶會看到的數字」，分布圖上的中位數不會告訴你這件事。`;
}

/* ---------- 單筆 vs 分批 ---------- */
function renderLumpVsSplit(t, W, cfg, s) {
  const n = Math.max(1, Math.min(s.splitMonths, W));
  const A = s.mode === 'dca' ? s.monthly * W : s.amount;
  const lumpCfg = { ...cfg, mode: 'lump', amount: A, warm: 0.006 };
  const splitCfg = { ...cfg, mode: 'split', amount: A, splitMonths: n, warm: 0.006 };
  const starts = t.n - 1 - W;
  let winN = 0, tot = 0, winSum = 0, winCnt = 0, lossSum = 0, lossCnt = 0;
  for (let i = 0; i <= starts; i++) {
    const a = runWindow(t, i, W, lumpCfg);
    const b = runWindow(t, i, W, splitCfg);
    const d = a.netV - b.netV;
    tot++;
    if (d > 0) { winN++; winSum += d; winCnt++; } else if (d < 0) { lossSum += -d; lossCnt++; }
  }
  if (!tot) return;
  cLwin(winN / tot);
  cLwinAmt(winCnt ? winSum / winCnt : 0);
  cLlossAmt(lossCnt ? lossSum / lossCnt : 0);
  $('#lumpNote').innerHTML =
    `拿 ${int(A)} 元、持有 ${W / 12} 年，比較「一次全買」與「分 ${n} 個月買完再續抱」。`
    + `在 ${t.id} 的 ${tot} 個起始月裡，單筆勝出 ${winN} 次（${pp((winN / tot) * 100, 0)}）。`
    + `<b>單筆通常會贏，因為市場多數時間在漲，晚進場等於少曬到太陽</b>；`
    + `但輸的那些月份輸得比較痛，這就是為什麼分批買的是心理成本、不是報酬。`
    + `這裡的每一次比較都用同一段歷史，所以它們不是獨立事件。`;
}

/* ---------- 拒答 ---------- */
function renderRefusal(refused, usable, W) {
  const box = $('#refuse');
  if (!refused.length && usable.length) { box.hidden = true; return; }
  box.hidden = false;
  if (!refused.length) {
    $('#refuseTitle').textContent = '還沒選標的';
    $('#refuseBody').textContent = '左邊的標的清單至少勾選一檔，這張單子才有東西可以算。';
    $('#refuseFix').hidden = true;
    return;
  }
  const names = refused.map((t) => `${t.id} ${t.name}`).join('、');
  const best = refused.map((t) => maxYears(t));
  const okAll = Math.min(...[...refused, ...usable].map((t) => maxYears(t)));
  $('#refuseTitle').textContent = usable.length ? '有標的的資料不足以回答' : '資料不足以回答這個問題';
  $('#refuseBody').innerHTML =
    `<b>${names}</b> 在持有 ${W / 12} 年的設定下，`
    + refused.map((t, k) => `${t.id} 只剩 ${Math.max(0, t.n - 1 - W + 1)} 個可用的起始月`
      + `（上市至今 ${t.n} 個月，最長只能回答到 ${best[k]} 年）`).join('；')
    + `。起始月少於 ${MIN_STARTS} 個時畫出來的分布只是幾條噪音，`
    + `所以這裡不畫。寧可承認答不了，也不給你一個看起來很專業的假分布。`;
  const btn = $('#refuseFix');
  if (okAll >= 1) {
    btn.hidden = false;
    btn.textContent = `改成 ${okAll} 年（目前這組標的可回答的最長視窗）`;
    btn.onclick = () => { sYears.set(okAll); };
  } else {
    btn.hidden = true;
  }
}

/* ---------- 結論 ---------- */
function renderVerdict(results, W, s) {
  const a = results[0];
  const spread = a.sum.p90 - a.sum.p10;
  const h = $('#verdict-h');
  const body = $('#verdictBody');
  const stamp = $('#verdictStamp');

  h.innerHTML = `同樣持有 ${W / 12} 年，${a.t.id} 最差的起始月年化 <em>${pp(a.sum.min * 100, 1)}</em>，`
    + `最好的 <em>${pp(a.sum.max * 100, 1)}</em>。中位數 ${pp(a.sum.med * 100, 1)}。`;

  const cmp = results[1];
  let tail = '';
  if (cmp) {
    const better = a.sum.med > cmp.sum.med ? a : cmp;
    const other = better === a ? cmp : a;
    const gap = better.sum.med - other.sum.med;
    const overlap = Math.min(a.sum.p90, cmp.sum.p90) - Math.max(a.sum.p10, cmp.sum.p10);
    tail = ` ${better.t.id} 的中位數比 ${other.t.id} 高 ${pp(gap * 100, 1)}，`
      + (overlap > gap * 2
        ? `但兩者的 P10-P90 區間重疊了 ${pp(overlap * 100, 1)}，重疊比差距寬得多，代表「誰比較好」這件事在這個持有年數下還沒被歷史分出勝負。`
        : '而且兩者的分布區間幾乎不重疊，在這段歷史上差距是穩定的。');
  }

  body.innerHTML = `你能拿到哪一個，取決於你哪個月開始買，而那多半不是你選的。`
    + `P10 到 P90 之間的寬度是 <b>${pp(spread * 100, 1)}</b>，`
    + `這就是「起始日運氣」在這個持有年數下還剩多大。把年數拉長，這個寬度會收窄，`
    + `那才是長期投資真正在做的事：不是把報酬變高，是把運氣的影響範圍變小。${tail}`;

  stamp.hidden = false;
  const key = `${a.t.id}:${W}:${Math.round(spread * 1000)}`;
  if (stampedFor !== key) {
    const cls = spread > 0.12 ? 'stamp' : 'stamp stamp--ok';
    stamp.innerHTML = `<span class="${cls}">運氣區間 ${pp(spread * 100, 1)}</span>`;
    stampIn(stamp.firstElementChild);
    stampedFor = key;
  }
}

/* ---------- 公式抽屜 ---------- */
function renderFormula(res, W, s, cfg) {
  const host = $('#formulaHost');
  host.replaceChildren();
  const t = res.t;
  const src = (o) => o
    ? `${o.legalBasis}${o.sourceUrl ? `　<a href="${o.sourceUrl}" target="_blank" rel="noopener">出處</a>` : ''}`
    + `　<b>${o.confidence === 'verified' ? '已查證' : o.confidence === 'probable' ? '可能' : '未查證'}</b>`
    : '';
  const tr = RULES?.trading || {};
  const dt = RULES?.dividendTax || {};
  const nh = RULES?.nhi || {};

  const fixed = t.splitFixes.filter((x) => x.fixed);
  host.appendChild(formulaBlock('攤開看：還原權息序列是怎麼重建的', [
    `<b>除息</b> 調整因子 f<sub>d</sub> = 除權息參考價 ÷ 除權息前收盤價`,
    `<b>還原價</b> Adj<sub>t</sub> = Close<sub>t</sub> × Π<sub>d&gt;t</sub> f<sub>d</sub>`,
    `${t.id} 共 ${t.events.length} 筆除權息調整，序列 ${t.months[0].ym} - ${t.months[t.n - 1].ym}，${t.n} 個月`,
    `<b>分割</b> ${fixed.length
      ? `偵測到 bundled 序列未處理 ${fixed.map((x) => `${x.date} 1 拆 ${x.ratio}`).join('、')}，已在載入時把分割日之前的還原價除以倍數`
      : (t.splitFixes.length
        ? `${t.splitFixes.map((x) => `${x.date} 1 拆 ${x.ratio}`).join('、')}：bundled 序列已處理，本工具不重複修正`
        : '本檔期間內無分割事件')}`,
    `<b>檢核</b> 逐月掃描還原價，任何月對月 −40% 以上的跳空一律視為資料異常並停用該檔`,
    `<b>封死未還原價</b> 報酬只讀 adj 欄位；close（未還原）不參與任何運算`,
    `對照：${t.months[t.n - 1].ym} 收盤 ${dec(t.months[t.n - 1].close, 2)} 元（未還原），還原價 ${dec(t.adj[t.n - 1], 2)}`,
  ], '序列由 TWSE STOCK_DAY 與 TWT49U（除權除息計算結果表）離線建置後 committed 進 repo，執行期不呼叫任何外部 API。'
    + (RULES?.splits?.[0] ? `<br>${src(RULES.splits[0])}` : '')));

  host.appendChild(formulaBlock('攤開看：滾動視窗與年化怎麼算', [
    `<b>視窗</b> 對每個起始月 s ∈ [首月, 末月 − ${W} 個月] 各跑一次`,
    `本次共 ${res.sum.n} 個起始月，視窗長度 ${W} 個月（${W / 12} 年）`,
    `<b>單筆年化</b> (V<sub>s</sub> ÷ C<sub>s</sub>)<sup>1/年</sup> − 1，C<sub>s</sub> 為累計投入`,
    `<b>分批年化</b> 現金流不規則，改解 Σ CF<sub>k</sub>/(1+r)<sup>k</sup> = 0 的月報酬 r，年化 = (1+r)<sup>12</sup> − 1`,
    `　（Newton-Raphson，失敗退回二分法，區間 [−0.99, 10]）`,
    `<b>終值</b> 定期定額 = Σ (每期投入 − 手續費) ÷ Adj<sub>買入月</sub> × Adj<sub>結束月</sub>`,
    `<b>有效獨立樣本</b> ≈ ${t.n} ÷ ${W} = ${Math.max(1, Math.floor(t.n / W))}`,
    `<b>配息估算</b> 每次除息的現金 ≈ 除息前一個月底的持有市值 × (1 − f<sub>d</sub>)；月度序列無法精確到除息當日，這是近似`,
  ], '滾動視窗高度重疊，相鄰樣本共用絕大部分月份，勝率與分位數都不是統計顯著的推論。'
    + '以金額近似買賣，不模擬整股／零股顆粒度，也不模擬買賣價差。'
    + '再投入以除息參考價買回並照樣收取手續費；股利稅與補充保費統一於期末扣除，不模擬繳納時點。'));

  const perBuy = s.mode === 'dca' ? s.monthly : (s.mode === 'split' ? s.amount / Math.max(1, s.splitMonths) : s.amount);
  const feeRate = tr.feeRateMax?.value ?? 0.001425;
  host.appendChild(formulaBlock('攤開看：交易成本、股利稅與補充保費的法源', [
    `<b>買進手續費</b> = max(${int(s.minFee)}, 成交金額 × ${pp(feeRate * 100, 4)} × ${dec(s.disc, 2)} 折)`,
    `　本次每筆 ${int(perBuy)} 元 → ${int(Math.max(s.minFee, Math.round(perBuy * feeRate * s.disc)))} 元`,
    `<b>賣出</b> 同上再加證交稅 ETF ${pp((tr.sttEtf?.value ?? 0.001) * 100, 1)}（個股為 ${pp((tr.sttStock?.value ?? 0.003) * 100, 1)}）`,
    `<b>股利稅・合併計稅</b> 稅額 = 股利 × 邊際稅率 ${pp(s.marginal * 100, 0)} − min(股利 × ${pp((dt.creditRate?.value ?? 0.085) * 100, 1)}, ${int(dt.creditCapPerHousehold?.value ?? 80000)})`,
    `<b>股利稅・分開計稅</b> 稅額 = 股利 × ${pp((dt.separateRate?.value ?? 0.28) * 100, 0)}，且不得再用 8.5% 抵減`,
    `　兩制必須就整個申報戶的全部股利擇一，不能部分合併、部分分開。`,
    `　<b>本工具只算股利那一段的稅，沒有算申報戶的其他扣除額</b>：選 28% 分開計稅還會連帶喪失`
      + `長期照顧與房屋租金兩項特別扣除額（所得稅法第 17 條第 3 項，各 18 萬元），`
      + `這筆代價不在下面的數字裡，所以此處的 28% 稅負是<b>低估</b>的。要比較兩制請用「股利課稅交叉點地圖」。`,
    `　目前採用：<b>${s.taxMode === 'none' ? '不計股利稅' : s.taxMode === 'separate' ? '分開計稅 28%' : `合併計稅（邊際 ${pp(s.marginal * 100, 0)}）`}</b>`,
    `<b>補充保費</b> 單筆配息 ≥ ${int(nh.floor?.value ?? 20000)} 元時，以全額（上限 ${int(nh.cap?.value ?? 10000000)} 元）× ${pp((nh.rate?.value ?? 0.0211) * 100, 2)}`,
    `　${s.nhi ? '已計入' : '未計入（開關關閉）'}；年度結算制修法未上路，本工具只實作現行單筆起扣制`,
  ], [
    src(tr.feeRateMax), src(tr.feeMin), src(tr.sttEtf),
    src(dt.creditRate), src(dt.creditCapPerHousehold), src(dt.separateRate),
    src(nh.rate), src(nh.floor), src(nh.cap), src(nh.annualSettlementReform),
  ].filter(Boolean).join('<br>')));
}

/* ==========================================================================
   圖表游標
   ========================================================================== */
distPlot.onCursor = (x, px) => {
  if (x == null) { distTip.hide(); return; }
  const s = store.get();
  const W = Math.round(s.years * 12);
  const rows = window.__dist || [];
  if (!rows.length) { distTip.hide(); return; }
  const lines = rows.map((r) => {
    const below = r.values.filter((v) => v <= x).length;
    return `<b>${r.id}</b> ${pp((below / r.values.length) * 100, 0)} 的起始月低於這裡`;
  });
  distTip.show(`<b>年化 ${pp(x * 100, 1)}</b>（持有 ${W / 12} 年）<br>${lines.join('<br>')}`,
    px, distPlot.pad.top + 24);
};

/* ==========================================================================
   啟動
   ========================================================================== */
async function boot() {
  // --- 法規常數 ---
  try {
    const r = await fetch('./rules.json');
    RULES = await r.json();
    MIN_STARTS = RULES?.sampling?.minStarts?.value ?? 24;
  } catch {
    RULES = null;
  }

  // --- 市場資料（離線建置、committed 在 repo 裡，執行期不呼叫外部 API） ---
  try {
    const r = await fetch('../../assets/data/market/index.json');
    MARKET = await r.json();
    const files = await Promise.all(
      MARKET.tickers.map((m) => fetch(`../../assets/data/market/${m.id}.json`).then((x) => x.json()))
    );
    MARKET.tickers.forEach((m, k) => TICKERS.push(buildTicker(m, files[k])));
  } catch (e) {
    $('#verdict-h').textContent = '讀不到市場資料';
    $('#verdictBody').textContent = '離線建置的還原權息序列載入失敗。請確認 assets/data/market/ 底下的檔案存在。';
    $('#dataver').textContent = '資料版本 讀取失敗';
    return;
  }

  $('#dataver').textContent = `資料版本 ${RULES?.version || '未載入'}．市場資料 ${MARKET.builtAt}`;
  $('#dataver').title = [
    `序列下限 ${MARKET.dataFloor}（TWSE STOCK_DAY 可回溯到民國 99 年 1 月 4 日）`,
    RULES?.note || '',
  ].filter(Boolean).join('\n');

  // 網址帶進來的標的可能已下架或改名，先過濾成實際存在的
  const valid = TICKERS.filter((t) => !t.broken).map((t) => t.id);
  const picked = store.at('tickers').filter((id) => valid.includes(id));
  store.set({ tickers: picked.length ? picked : valid.slice(0, 2) }, { silent: true });

  syncInputs();
  compute();

  // Plot 只監聽系統色彩偏好，手動按夜間鈕（改 data-theme）不會重繪畫布上的顏色。
  // 這裡在 App 層補一個觀察者；共用層的修法記在 NEEDS.md。
  new MutationObserver(() => compute()).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-theme'],
  });

  // 首次進場：結果逐行推出，讓人感覺數字是被算出來的
  printRows($$('#readouts .readout'), { stagger: 0.06, delay: 0.1 });
  printRows($$('#qBody tr'), { stagger: 0.04, delay: 0.25 });

  const broken = TICKERS.filter((t) => t.broken);
  if (broken.length) toast(`${broken.map((t) => t.id).join('、')} 的還原序列有異常，已停用`);
  if (store.cameFromLink) toast('已載入別人傳給你的情境');
}

boot();
