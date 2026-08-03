/* 投資與稅：三個工具合成一張單子。

   合併的判準不是把三頁 HTML 接起來，而是：
   股利金額、配息筆數、券商折數、課稅方式、所得級距這五件事只存在一個地方
   （assets/js/core/profile.js 的財務檔案），任何一聯需要就從那裡拿。
   第一聯算出來的「該勾哪一個」與「邊際稅率」，第二聯與第三聯直接吃，
   使用者不會被問第二次。

   自檢用：把執行期錯誤留一份給 probe 讀，使用者端完全無感。 */
window.addEventListener('error', (e) => {
  // Chrome 對「在 ResizeObserver 回呼裡改到版面」發出的良性通知，不是錯誤
  if (/ResizeObserver loop/.test(e.message || '')) return;
  window.__err = String(e.message);
});

import {
  gsap, EASE, still, printRows, stampIn, makeCounter, carbonTransfer, flagCross,
} from '../../assets/js/core/motion.js';
import { Plot, histogram, quantile, niceTicks } from '../../assets/js/core/plot.js';
import { progressiveTax, nhiSupplement, twTradeCost, irr } from '../../assets/js/core/fin.js';
import { createStore } from '../../assets/js/core/state.js';
import {
  $, $$, el, bindSlider, bindField, bindSegmented,
  mountShare, mountTheme, toast, formulaBlock, createTip,
} from '../../assets/js/core/ui.js';
import { int, dec, money, pct, pp, clamp } from '../../assets/js/core/format.js';
import * as P from '../../assets/js/core/profile.js';
import { askBox, fieldControl } from '../../assets/js/core/profile-ui.js';

/* ==========================================================================
   0. 這一頁需要檔案裡的哪幾格
   ========================================================================== */

/** 三聯都要用到的：缺這幾格就在抬頭問一次，問完三聯全部解鎖。 */
const MODULE_NEED = ['salary', 'married', 'dependents', 'annualDividend', 'dividendPayouts'];
/** 只有第一聯（課稅地圖）需要的細節 */
const MAP_NEED = ['interestIncome', 'otherIncome'];
/** 只有第二、三聯（成本）需要的 */
const COST_NEED = ['brokerDiscount'];
/** 第一聯的進階減除項，全部有預設值，不擋計算 */
const FINE_KEYS = [
  'annualBonus', 'dependentsOver70', 'children0to6',
  'longTermCareCount', 'annualRent', 'mortgageInterestPaid',
];

/* 沒有檔案時的範例值。首屏必須有結論，不能是空白表單，
   但每一個範例值都要在畫面上標明它是範例。 */
const EXAMPLE = {
  salary: 60000, married: false, dependents: 0,
  annualDividend: 300000, dividendPayouts: 4, brokerDiscount: 6,
};

/** 起始月少於這個數就不畫分布。非法規，是本模組自訂的拒答門檻。 */
const MIN_STARTS = 24;
const SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5'];
const BINS = 40;

/* ==========================================================================
   1. 資料：法規常數一律讀 assets/data，不在程式碼裡寫死
   ========================================================================== */
let TAX = null;      // assets/data/tw-tax.json
let NHI = null;      // assets/data/tw-nhi.json
let MARKET = null;   // assets/data/market/index.json
const TICKERS = [];
let FEE = null;      // 交易成本：兩份既有 rules.json 的並列，見 NEEDS.md
let dataOK = false;

/* 本地情境（不是使用者的個人資料，是「這一次想看什麼」） */
const DEFAULTS = {
  tab: 'p-map',
  year: '114',
  taxChoice: 'auto',
  tickers: ['0050', '0056'],
  years: 3, etfMode: 'lump', amount: 600000, monthly: 10000, divMode: 'reinvest',
  price: 20, lots: 0, exYears: 10, divYield: 7, qual: 100, fill: 70,
  trend: 1.5, mkt: 8.5, bear: 30, exMode: 'reinvest',
};
const store = createStore('vm:invest-tax', { ...DEFAULTS });
const S = () => store.get();

const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* ==========================================================================
   2. 從檔案讀出這一頁要的數字
   ========================================================================== */
function facts() {
  const married = P.getOr('married', EXAMPLE.married);
  return {
    married,
    monthlySalary: P.getOr('salary', EXAMPLE.salary),
    salary: P.getOr('salary', EXAMPLE.salary) * 12 + P.getOr('annualBonus', 0),
    spouseSalary: married ? P.getOr('spouseSalary', 0) * 12 : 0,
    dependents: P.getOr('dependents', EXAMPLE.dependents),
    over70: P.getOr('dependentsOver70', 0),
    kids: P.getOr('children0to6', 0),
    ltcCount: P.getOr('longTermCareCount', 0),
    rentPaid: P.getOr('annualRent', 0),
    interest: P.getOr('interestIncome', 0),
    other: P.getOr('otherIncome', 0),
    mortgageInterest: P.getOr('mortgageInterestPaid', 0),
    dividend: P.getOr('annualDividend', EXAMPLE.annualDividend),
    payouts: clamp(Math.round(P.getOr('dividendPayouts', EXAMPLE.dividendPayouts)), 1, 12),
    disc: clamp(P.getOr('brokerDiscount', EXAMPLE.brokerDiscount), 1, 10) / 10,
  };
}

/** 目前有幾格還在用範例值 */
function exampleKeys() {
  return MODULE_NEED.filter((k) => !P.has(k));
}

const YR = () => TAX.years[S().year] || TAX.years[String(TAX.defaultYear)];
const DIV = () => TAX.dividend;

/* ==========================================================================
   3. 稅額引擎（第一聯的核心，另外兩聯吃它的結論）
   ========================================================================== */
const fTax = (net) => (net > 0 ? progressiveTax(net, YR().brackets).tax : 0);

function marginalRate(net) {
  const bs = YR().brackets;
  if (!(net > 0)) return bs[0].rate;
  for (const b of bs) if (b.upTo == null || net <= b.upTo) return b.rate;
  return bs[bs.length - 1].rate;
}

const credit = (d) => Math.min(Math.max(0, d) * DIV().creditRate, DIV().creditCapPerHousehold);
/** 抵減上限咬合點：8 萬 ÷ 8.5%。分界線那道折點就是它。 */
const kinkD = () => DIV().creditCapPerHousehold / DIV().creditRate;

/** 選 28% 分開計稅時被追回的長照＋房租特扣。整張地圖的常數位移。 */
let FORFEIT = 0;

function deductions(f) {
  const R = YR();
  const headcount = 1 + (f.married ? 1 : 0) + f.dependents;
  const n70 = Math.min(f.over70, headcount);
  const nNormal = headcount - n70;

  const exemption = nNormal * R.exemption + n70 * R.exemptionAge70;
  const standard = f.married ? R.standardMarried : R.standardSingle;
  const savings = Math.min(f.interest, R.savingsDeduction);

  // 購屋借款利息列舉：先減儲蓄投資特扣，餘額才可列舉，且上限 30 萬。
  // 順序顛倒是同類工具最常算錯的地方，所以單獨留一行給公式抽屜。
  const mortgageNet = clamp(f.mortgageInterest - savings, 0, R.mortgageInterestCap);
  const general = Math.max(standard, mortgageNet);
  const generalUsed = mortgageNet > standard ? 'itemized' : 'standard';

  const salarySpecA = Math.min(f.salary, R.salaryDeduction);
  const salarySpecB = Math.min(f.spouseSalary, R.salaryDeduction);
  const preschool = f.kids > 0 ? R.preschoolFirst + Math.max(0, f.kids - 1) * R.preschoolSecondPlus : 0;

  // 長照與房租是現行僅存的兩項排富特扣，選 28% 分開計稅就整個喪失，
  // 所以必須跟其他扣除額分開存放，兩制才會算出不同的減除總額。
  const ltc = f.ltcCount * R.longTermCare;
  const rent = Math.min(f.rentPaid, R.rentDeduction);
  const forfeitable = ltc + rent;

  let basicTotal = null;
  let basicDiff = 0;
  if (Number.isFinite(R.basicLivingExpense) && R.basicLivingExpense > 0) {
    basicTotal = R.basicLivingExpense * headcount;
    basicDiff = Math.max(0, basicTotal - (exemption + general + savings + preschool + forfeitable));
  }

  const totalOther = f.salary + f.spouseSalary + f.interest + f.other;
  return {
    headcount, nNormal, n70, exemption, standard, general, generalUsed, mortgageNet,
    savings, salarySpecA, salarySpecB, preschool, ltc, rent, forfeitable,
    basicTotal, basicDiff, totalOther,
  };
}

/**
 * 夫妻三種計稅方式各產生候選方案。
 * 模型約定：股利一律歸入合併申報那一方，因為分開計稅那一方只把自己的所得抽出去單獨算；
 * 利息與其他所得一律歸本人。這兩條讓地圖的縱軸有唯一定義。
 */
function candidates(f, A) {
  const R = YR();
  const specTotal = A.salarySpecA + A.salarySpecB;
  const base = A.totalOther - A.exemption - A.general - specTotal
    - A.savings - A.preschool - A.forfeitable - A.basicDiff;
  const all = { method: 'all', label: '全部合併計稅', netOther: base, sepTax: 0, sepNet: 0, who: null };
  if (!f.married) return [all];

  const out = [all];
  for (const k of [0, 1]) {
    const sal = k === 0 ? f.salary : f.spouseSalary;
    const spec = k === 0 ? A.salarySpecA : A.salarySpecB;
    // 薪資分開計稅：分開者之薪資減除本人免稅額與薪資特扣後單獨計稅
    const sepNet = Math.max(0, sal - spec - R.exemption);
    out.push({
      method: 'salary',
      label: `薪資分開計稅（${k === 0 ? '本人' : '配偶'}分開）`,
      netOther: (A.totalOther - sal) - (A.exemption - R.exemption) - A.general
        - (specTotal - spec) - A.savings - A.preschool - A.forfeitable - A.basicDiff,
      sepTax: fTax(sepNet), sepNet, who: k,
    });
    // 各類所得分開計稅：利息與其他所得歸本人，所以只有 k=0 會帶走它們
    const itr = k === 0 ? f.interest : 0;
    const oth = k === 0 ? f.other : 0;
    const sav = k === 0 ? A.savings : 0;
    const sepNet2 = Math.max(0, sal + itr + oth - R.exemption - spec - sav);
    out.push({
      method: 'each',
      label: `各類所得分開計稅（${k === 0 ? '本人' : '配偶'}分開）`,
      netOther: (A.totalOther - sal - itr - oth) - (A.exemption - R.exemption) - A.general
        - (specTotal - spec) - (A.savings - sav) - A.preschool - A.forfeitable - A.basicDiff,
      sepTax: fTax(sepNet2), sepNet: sepNet2, who: k,
    });
  }
  return out;
}

/** 兩制稅額。合併計稅可能為負，那是退稅，不要夾成 0。 */
function evaluate(cand, d) {
  const cr = credit(d);
  const combined = cand.sepTax + fTax(cand.netOther + d) - cr;
  const separate = cand.sepTax + fTax(cand.netOther + FORFEIT) + d * DIV().separateRate;
  const baseline = cand.sepTax + fTax(cand.netOther);
  return { combined, separate, credit: cr, baseline, best: Math.min(combined, separate) };
}

/** g > 0 表示合併計稅較省。分開那一方的稅在兩制相同會自己消掉，所以只有兩個參數。 */
function gapValue(d, y) {
  return (fTax(y + FORFEIT) + d * DIV().separateRate) - (fTax(y + d) - credit(d));
}

/** 給定股利，回傳分界線上的其他所得淨額。g 對 y 單調遞減，可以二分。 */
function boundaryY(d, lo = -2e7, hi = 1e8) {
  if (!(d > 0)) return Infinity;
  if (gapValue(d, hi) > 0) return Infinity;
  if (gapValue(d, lo) < 0) return -Infinity;
  let a = lo; let b = hi;
  for (let i = 0; i < 44; i++) {
    const m = (a + b) / 2;
    if (gapValue(d, m) > 0) a = m; else b = m;
  }
  return (a + b) / 2;
}

/** 給定其他所得淨額，回傳「股利加到多少會翻盤」。g 對 d 是凹的且 g(0)=0，正根至多一個。 */
function boundaryD(y, hiCap = 5e7) {
  const probe = 1000;
  if (gapValue(probe, y) <= 0) return 0;
  let lo = probe; let hi = probe;
  for (let i = 0; i < 64; i++) {
    hi = Math.min(hiCap, hi * 1.6 + 10000);
    if (gapValue(hi, y) <= 0) break;
    if (hi >= hiCap) return Infinity;
    lo = hi;
  }
  if (gapValue(hi, y) > 0) return Infinity;
  for (let i = 0; i < 44; i++) {
    const m = (lo + hi) / 2;
    if (gapValue(m, y) > 0) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}

/** 二代健保：單筆給付達門檻才起扣，全額計費，有單次費基上限。 */
function nhiRows(dividend, payouts) {
  const opt = { rate: NHI.rate, floor: NHI.thresholds.dividend, cap: NHI.singlePaymentCap };
  const each = Math.max(0, dividend) / payouts;
  const rows = Array.from({ length: payouts }, (_, i) => {
    const fee = nhiSupplement(each, opt);
    return { label: `第 ${i + 1} 次配息`, amount: each, fee, hit: fee > 0 };
  });
  return {
    rows,
    total: rows.reduce((a, r) => a + r.fee, 0),
    hits: rows.filter((r) => r.hit).length,
    edge: rows.filter((r) => Math.abs(r.amount - opt.floor) < opt.floor * 0.1).length,
  };
}

/* 這一輪算出來、三聯共用的結論 */
const OUT = {
  f: null, A: null, active: null, ev: null, side: 'combined',
  taxMode: 'combined', marginal: 0.05, nhi: null,
  flipD: Infinity, flipY: Infinity, dividendTax: 0,
};

function computeTax() {
  const f = facts();
  const A = deductions(f);
  FORFEIT = A.forfeitable;
  const cands = candidates(f, A);

  let active = cands[0];
  let ev = evaluate(active, f.dividend);
  for (const c of cands) {
    const e = evaluate(c, f.dividend);
    if (e.best < ev.best - 1e-6) { active = c; ev = e; }
  }

  const diff = ev.separate - ev.combined;
  const side = Math.abs(diff) < 1 ? 'tie' : diff > 0 ? 'combined' : 'separate';
  const choice = S().taxChoice;
  const taxMode = choice === 'auto' ? (side === 'separate' ? 'separate' : 'combined') : choice;

  OUT.f = f;
  OUT.A = A;
  OUT.cands = cands;
  OUT.active = active;
  OUT.ev = ev;
  OUT.side = side;
  OUT.diff = diff;
  OUT.taxMode = taxMode;
  OUT.marginal = marginalRate(active.netOther + f.dividend);
  OUT.nhi = nhiRows(f.dividend, f.payouts);
  OUT.flipD = boundaryD(active.netOther);
  OUT.flipY = boundaryY(f.dividend);
  OUT.picked = taxMode === 'separate' ? ev.separate : ev.combined;
  OUT.dividendTax = OUT.picked - ev.baseline;
}

/* ==========================================================================
   4. 小工具
   ========================================================================== */
/** 萬元刻度。地圖上的數字全部用「萬」，六位數逐位念會讀不完。 */
function wan(v) {
  if (!Number.isFinite(v)) return '-';
  if (Math.abs(v) < 1) return '0';
  if (Math.abs(v) >= 1e8) return dec(v / 1e8, 1) + ' 億';
  return dec(v / 1e4, Math.abs(v) >= 1e6 ? 0 : 1).replace(/\.0$/, '') + ' 萬';
}
const wanNum = (v) => dec(v / 1e4, v % 1e4 === 0 ? 0 : 1).replace(/\.0$/, '');
const fmtTax = (v) => (v < -0.5 ? '退 ' + int(-v) : int(Math.max(0, v)));
const yuan = (v) => money(Math.round(v), { compact: true }) + '元';

function niceUp(v) {
  if (!(v > 0)) return 1e6;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / (mag / 2)) * (mag / 2);
}
const niceDown = (v) => (v >= 0 ? 0 : -niceUp(-v));

function legendItem(text, color, dash = false) {
  return el('span', { class: 'legend__item' }, [
    el('span', {
      class: `legend__key${dash ? ' legend__key--dash' : ''}`,
      style: dash ? `color:${color}` : `background-color:${color}`,
    }),
    el('span', { text }),
  ]);
}

/** 畫布上的小標籤：自己避開四個邊，不讓文字流出圖框 */
function chipLabel(ctx, text, x, y, o) {
  ctx.save();
  ctx.font = o.font;
  const w = ctx.measureText(text).width + 8;
  let left = x;
  if (left + w > o.right - 2) left = x - w - 18;
  left = clamp(left, o.left + 2, Math.max(o.left + 2, o.right - w - 2));
  const top = clamp(y - 12, o.top + 2, o.bottom - 16);
  ctx.fillStyle = o.bg;
  ctx.fillRect(left, top, w, 14);
  ctx.fillStyle = o.fg;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(text, left + 4, top + 7);
  ctx.restore();
}

/* ==========================================================================
   5. 第一聯的招牌視覺：二維決策地圖
   Plot 的 bars/points 畫不出區域，所以這張圖自己畫：逐欄二分求分界線，
   線以下填淡藍（合併較省）、線以上填淡黃加斜線（分開較省）。
   ========================================================================== */
class DecisionMap {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.model = null;
    this.w = 320; this.h = 240; this.dpr = 1;
    this.pad = { left: 58, right: 16, top: 16, bottom: 30 };
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement || canvas);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.render());
    this._bindPointer();
    this.resize();
  }

  resize() {
    const host = this.c.parentElement || this.c;
    const w = Math.max(240, host.clientWidth);
    if (!w) return;
    const h = Math.round(Math.min(430, Math.max(250, w * 0.7)));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.c.style.width = '100%';
    this.c.style.height = h + 'px';
    this.c.width = Math.round(w * this.dpr);
    this.c.height = Math.round(h * this.dpr);
    this.w = w; this.h = h;
    this.pad = w < 420
      ? { left: 46, right: 12, top: 16, bottom: 28 }
      : { left: 58, right: 18, top: 18, bottom: 30 };
    this.render();
  }

  setModel(m) { this.model = m; this.render(); return this; }

  sx(v) { return this.pad.left + (v / (this.model.xMax || 1)) * (this.w - this.pad.left - this.pad.right); }
  sy(v) {
    const m = this.model;
    const span = (m.yMax - m.yMin) || 1;
    return this.h - this.pad.bottom - ((v - m.yMin) / span) * (this.h - this.pad.top - this.pad.bottom);
  }
  ix(px) { return ((px - this.pad.left) / (this.w - this.pad.left - this.pad.right)) * this.model.xMax; }
  iy(py) {
    const m = this.model;
    return m.yMin + ((this.h - this.pad.bottom - py) / (this.h - this.pad.top - this.pad.bottom)) * (m.yMax - m.yMin);
  }

  /** 逐欄求分界線，並把折點那一欄精確插進去，避免取樣把角磨圓。 */
  _boundary() {
    const m = this.model;
    const cols = Math.max(48, Math.min(140, Math.round(this.w / 3)));
    const xs = [];
    for (let i = 0; i <= cols; i++) xs.push((i / cols) * m.xMax);
    const kd = kinkD();
    if (kd > 0 && kd < m.xMax) { xs.push(kd - 1, kd, kd + 1); xs.sort((a, b) => a - b); }
    // 超出範圍時只推出畫面外一點點：推到無窮遠會在左緣拉出一條莫名其妙的垂直線
    const out = (m.yMax - m.yMin) * 0.2;
    return xs.map((d) => {
      let y = boundaryY(d, m.yMin - 5e6, m.yMax + 5e7);
      if (y === Infinity) y = m.yMax + out;
      if (y === -Infinity) y = m.yMin - out;
      return { d, y };
    });
  }

  render() {
    const m = this.model;
    const { ctx } = this;
    if (!m || !this.w || this.c.style.display === 'none') return;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    const L = this.pad.left; const R = this.w - this.pad.right;
    const T = this.pad.top; const B = this.h - this.pad.bottom;
    const inkFaint = cssv('--rule-faint') || '#E0E0D8';
    const rule = cssv('--rule') || '#C6C6BE';
    const ink = cssv('--ink') || '#15181B';
    const ink3 = cssv('--ink-3') || '#5F656C';
    const monoFont = cssv('--font-mono') || 'monospace';
    const cjkFont = cssv('--font-cjk') || 'sans-serif';

    const pts = this._boundary();
    const trace = () => {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = this.sx(p.d); const y = this.sy(p.y);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
    };

    /* ---- 兩區底色：兩種紙色，不是兩種螢光色 ---- */
    ctx.save();
    ctx.beginPath(); ctx.rect(L, T, R - L, B - T); ctx.clip();
    ctx.fillStyle = cssv('--ply-2') || '#F7EEC6';
    ctx.fillRect(L, T, R - L, B - T);
    trace();
    ctx.lineTo(R, B + 40); ctx.lineTo(L, B + 40); ctx.closePath();
    ctx.fillStyle = cssv('--ply-4') || '#DCE7F1';
    ctx.fill();
    // 分開區加斜向髮絲線：灰階列印與色覺差異下也分得出兩區
    ctx.save();
    trace();
    ctx.lineTo(R, T - 40); ctx.lineTo(L, T - 40); ctx.closePath();
    ctx.clip();
    ctx.strokeStyle = rule; ctx.lineWidth = 1; ctx.globalAlpha = 0.5;
    ctx.beginPath();
    for (let x = L - this.h; x < R + this.h; x += 9) { ctx.moveTo(x, B); ctx.lineTo(x + (B - T), T); }
    ctx.stroke();
    ctx.restore();
    ctx.restore();

    /* ---- 髮絲格線與刻度 ---- */
    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = `500 10px ${monoFont}`;
    ctx.fillStyle = ink3;
    ctx.strokeStyle = inkFaint;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of niceTicks(m.yMin, m.yMax, 5)) {
      const y = Math.round(this.sy(v)) + 0.5;
      if (y < T - 1 || y > B + 1) continue;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke();
      ctx.fillText(wan(v), L - 6, y);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const v of niceTicks(0, m.xMax, this.w < 420 ? 4 : 6)) {
      const x = Math.round(this.sx(v)) + 0.5;
      if (x < L - 1 || x > R + 1) continue;
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, B); ctx.stroke();
      ctx.fillText(wan(v), x, B + 6);
    }
    ctx.strokeStyle = rule;
    ctx.beginPath();
    ctx.moveTo(L + 0.5, T); ctx.lineTo(L + 0.5, B + 0.5); ctx.lineTo(R, B + 0.5);
    ctx.stroke();
    ctx.restore();

    /* ---- 二代健保圖層：垂直等高線。
           健保完全不看其他所得，所以它的等高線一定是垂直的。
           兩套彼此不通的規則，形狀上就對不起來。 ---- */
    if (m.nhi && m.nhi.length) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      const c4 = cssv('--series-4') || '#8A5A00';
      ctx.strokeStyle = c4; ctx.fillStyle = c4;
      ctx.font = `700 10px ${cjkFont}`;
      for (const g of m.nhi) {
        if (!(g.d > 0) || g.d > m.xMax) continue;
        const x = Math.round(this.sx(g.d)) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, B); ctx.stroke();
        ctx.save();
        ctx.translate(x - 3, T + 4);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
        ctx.fillText(g.label, 0, 0);
        ctx.restore();
      }
      ctx.restore();
    }

    /* ---- 分界線 ---- */
    ctx.save();
    ctx.beginPath(); ctx.rect(L, T, R - L, B - T); ctx.clip();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    trace();
    ctx.stroke();
    ctx.restore();

    /* ---- 折點：8.5% 抵減撞到 8 萬上限的那一刻，整張圖最有教育價值的一筆 ---- */
    const kd = kinkD();
    if (kd > 0 && kd < m.xMax) {
      const ky = boundaryY(kd, m.yMin - 5e6, m.yMax + 5e7);
      if (Number.isFinite(ky) && ky >= m.yMin && ky <= m.yMax) {
        const x = this.sx(kd); const y = this.sy(ky);
        ctx.save();
        ctx.fillStyle = cssv('--sheet') || '#fff';
        ctx.strokeStyle = ink; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.rect(x - 4, y - 4, 8, 8); ctx.fill(); ctx.stroke();
        chipLabel(ctx, `折點 ${wan(kd)}：抵減撞上限`, x + 9, y - 6, {
          font: `700 10px ${cjkFont}`, fg: cssv('--ink-inv') || '#fff', bg: ink,
          left: L, right: R, top: T, bottom: B,
        });
        ctx.restore();
      }
    }

    /* ---- 你在這裡，以及到分界線的最短距離 ---- */
    const p = m.point;
    if (p && Number.isFinite(p.d) && Number.isFinite(p.y)) {
      const px = clamp(this.sx(p.d), L, R);
      const py = clamp(this.sy(p.y), T, B);
      const stamp = cssv('--stamp') || '#B8342A';
      const dx = Number.isFinite(m.flipD) ? Math.abs(this.sx(clamp(m.flipD, 0, m.xMax)) - px) : Infinity;
      const dy = Number.isFinite(m.flipY) ? Math.abs(this.sy(clamp(m.flipY, m.yMin, m.yMax)) - py) : Infinity;
      ctx.save();
      ctx.strokeStyle = stamp; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      if (Number.isFinite(dx) || Number.isFinite(dy)) {
        ctx.beginPath();
        if (dx <= dy) { ctx.moveTo(px, py); ctx.lineTo(clamp(this.sx(m.flipD), L, R), py); }
        else { ctx.moveTo(px, py); ctx.lineTo(px, clamp(this.sy(m.flipY), T, B)); }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.fillStyle = stamp;
      ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = cssv('--sheet') || '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.stroke();
      chipLabel(ctx, '你在這裡', px + 10, py + 18, {
        font: `700 10px ${cjkFont}`, fg: '#fff', bg: stamp,
        left: L, right: R, top: T, bottom: B,
      });
      ctx.restore();
    }

    /* ---- 區域標籤 ---- */
    ctx.save();
    ctx.font = `800 12px ${cjkFont}`;
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.7;
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('合併計稅較省', L + 8, B - 8);
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText('分開計稅較省', R - 8, T + 6);
    ctx.restore();
  }

  _bindPointer() {
    const move = (e) => {
      if (!this.model) return;
      const rect = this.c.getBoundingClientRect();
      const px = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      const py = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
      if (px < this.pad.left || px > this.w - this.pad.right
        || py < this.pad.top || py > this.h - this.pad.bottom) { this.onHover?.(null); return; }
      this.onHover?.({ d: this.ix(px), y: this.iy(py), px, py });
    };
    this.c.addEventListener('pointermove', move);
    this.c.addEventListener('pointerdown', move);
    this.c.addEventListener('pointerleave', () => this.onHover?.(null));
    this.c.addEventListener('touchmove', move, { passive: true });
  }
}

const map = new DecisionMap($('#map'));
const mapTip = createTip($('#mapCard'));

const marginPlot = new Plot($('#margin'), {
  aspect: 0.42,
  yFormat: (v) => pp(v * 100, 0),
  xFormat: (v) => wan(v),
  padding: { left: 48, bottom: 28, top: 14, right: 14 },
  yTicks: 4,
});

let lastMapModel = null;
map.onHover = (h) => {
  if (!h || !lastMapModel) { mapTip.hide(); return; }
  const g = gapValue(h.d, h.y);
  const winner = Math.abs(g) < 1 ? '兩案同額' : g > 0 ? '合併較省' : '分開較省';
  mapTip.show(
    `<b>股利 ${wan(h.d)}／淨額 ${wan(h.y)}</b><br>${winner}　差 ${int(Math.abs(Math.round(g)))} 元`,
    h.px, h.py + $('#map').offsetTop,
  );
};

/* ---------- 第一聯的繪製 ---------- */
function renderMapPanel() {
  const f = OUT.f; const A = OUT.A; const active = OUT.active;
  const d = Math.max(0, f.dividend);
  const degenerate = d <= 0;

  $('#mapEmpty').hidden = !degenerate;
  $('#map').style.display = degenerate ? 'none' : '';

  if (!degenerate) {
    const xMax = niceUp(Math.max(2500000, d * 1.6));
    const yMax = niceUp(Math.max(6000000, active.netOther * 1.35,
      Number.isFinite(OUT.flipY) ? OUT.flipY * 1.15 : 0));
    const yMin = Math.min(0, niceDown(active.netOther * 1.25));
    // 第二層：二代健保。等高線刻意挑不會撞到折點的級距，
    // 免得兩件不相干的事在圖上疊成同一條線。
    const nhiLines = [];
    const floorAt = NHI.thresholds.dividend * f.payouts;
    if (floorAt > 0 && floorAt <= xMax) nhiLines.push({ d: floorAt, label: `起扣 ${wan(floorAt)}` });
    for (const lvl of [10000, 30000, 60000, 100000]) {
      const dv = lvl / NHI.rate;
      if (dv <= xMax && dv > floorAt * 1.15) nhiLines.push({ d: dv, label: `保費 ${wan(lvl)}` });
    }
    lastMapModel = {
      xMax, yMin, yMax,
      point: { d, y: active.netOther },
      flipD: OUT.flipD, flipY: OUT.flipY, nhi: nhiLines,
    };
    map.setModel(lastMapModel);
    $('#mapLegend').replaceChildren(
      el('span', { class: 'legend__item' }, [
        el('span', { class: 'legend__key legend__key--area', style: `background-color:${cssv('--ply-4')}` }),
        el('span', { text: '合併較省' }),
      ]),
      el('span', { class: 'legend__item' }, [
        el('span', { class: 'legend__key legend__key--area legend__key--hatch', style: `background-color:${cssv('--ply-2')}` }),
        el('span', { text: '分開較省' }),
      ]),
      legendItem('分界線', cssv('--ink')),
      legendItem('二代健保層', cssv('--series-4'), true),
    );
  }

  /* ---- 邊際實質稅負率 ---- */
  const xMax2 = niceUp(Math.max(2500000, d * 1.6));
  const N = 160;
  const combined = []; const separate = []; const mixed = [];
  const perPayout = d / f.payouts;
  const nhiRate = perPayout >= NHI.thresholds.dividend ? NHI.rate : 0;
  for (let i = 0; i <= N; i++) {
    const x = (i / N) * xMax2;
    const mc = marginalRate(active.netOther + x) - (x < kinkD() ? DIV().creditRate : 0);
    const ms = DIV().separateRate;
    combined.push({ x, y: mc });
    separate.push({ x, y: ms });
    mixed.push({ x, y: Math.min(mc, ms) + nhiRate });
  }
  marginPlot.setSeries([
    { type: 'step', data: combined, color: cssv('--series-1'), width: 2.5 },
    { type: 'line', data: separate, color: cssv('--series-2'), width: 2 },
    { type: 'step', data: mixed, color: cssv('--series-4'), width: 1.5, dash: [4, 3], noCursor: true },
  ], { animate: false });
  marginPlot.setMarks([
    { axis: 'x', value: kinkD(), label: `${wan(kinkD())} 抵減上限`, color: cssv('--ink-3'), dash: [3, 3] },
    { axis: 'x', value: d, color: cssv('--stamp'), dash: [2, 2] },
  ]);
  $('#marginLegend').replaceChildren(
    legendItem('合併計稅（含 8.5% 抵減）', cssv('--series-1')),
    legendItem('分開計稅 28%', cssv('--series-2')),
    legendItem('取低者加補充保費', cssv('--series-4'), true),
  );
  $('#marginDesc').textContent =
    '橫軸是全年股利所得，縱軸是「再多領 1 元股利，實際被拿走多少」。'
    + `合併計稅那條線在股利 ${wan(kinkD())}處往上跳 8.5 個百分點，因為抵減從那裡開始不再增加；`
    + '分開計稅永遠是 28% 的水平線，兩線交叉的位置就是翻轉點。'
    + (nhiRate ? '虛線再疊上 2.11% 的二代健保補充保費。' : '目前每筆配息未達 2 萬元，虛線不含補充保費。');

  /* ---- 圖的結論同時給文字：不讓視覺是唯一的資訊通道 ---- */
  const gapD = Number.isFinite(OUT.flipD) ? OUT.flipD - d : Infinity;
  $('#mapDesc').textContent = degenerate
    ? '股利為 0，地圖退化成一個點，兩制稅額完全相同。'
    : '橫軸是全年股利所得，縱軸是其他所得淨額。淡藍區合併計稅較省，淡黃斜線區分開計稅較省，'
      + `分界線在股利 ${wan(kinkD())}處有一道折點，成因是 8.5% 抵減撞到每戶 8 萬元的上限。`
      + `你在股利 ${wan(d)}、其他所得淨額 ${wan(active.netOther)} 的位置，落在`
      + `${OUT.side === 'separate' ? '分開較省' : '合併較省'}那一區`
      + (Number.isFinite(gapD)
        ? `，${gapD >= 0 ? '再多領' : '要少領'} ${wan(Math.abs(gapD))}股利就會換邊。`
        : '，在這個其他所得水準下，股利再高也不會換邊。');

  renderNhiTable();
  renderMapFormula();
}

function renderNhiTable() {
  const f = OUT.f; const n = OUT.nhi;
  const chip = $('#nhiChip');
  chip.textContent = `${n.hits} / ${n.rows.length} 筆起扣`;
  chip.classList.toggle('chip--on', n.hits > 0);

  const tb = $('#nhiBody');
  tb.replaceChildren();
  n.rows.forEach((r, i) => {
    const tr = el('tr', r.hit ? {} : { 'data-off': '1' });
    tr.appendChild(el('td', { text: r.label || `第 ${i + 1} 筆` }));
    tr.appendChild(el('td', { text: int(Math.round(r.amount)) }));
    tr.appendChild(el('td', { text: r.hit ? '起扣' : '未達 2 萬' }));
    tr.appendChild(el('td', { class: r.hit ? 'is-up' : '', text: r.hit ? int(Math.round(r.fee)) : '-' }));
    tb.appendChild(tr);
  });
  $('#nhiFootRow').replaceChildren(
    el('td', { text: '合計' }),
    el('td', { text: int(Math.round(n.rows.reduce((a, r) => a + r.amount, 0))) }),
    el('td', { text: `${n.hits} 筆` }),
    el('td', { text: int(Math.round(n.total)) }),
  );
  $('#nhiFoot').textContent =
    `單筆達 ${int(NHI.thresholds.dividend)} 元起扣，費率 ${pp(NHI.rate * 100, 2)}，`
    + `單次費基上限 ${int(NHI.singlePaymentCap)} 元。達門檻時以全額計費，不是只就超過的部分。`
    + `這裡以你檔案裡的 ${f.payouts} 筆平均分配計算，`
    + `全年股利低於 ${int(NHI.thresholds.dividend * f.payouts)} 元時每一筆都不到門檻，補充保費為 0。`
    + '各次配息金額差很多時，實際結果會與這個平均假設不同。';
}

function renderMapFormula() {
  const R = YR(); const f = OUT.f; const A = OUT.A; const active = OUT.active; const ev = OUT.ev;
  const host = $('#mapFormula');
  const open = $$('details', host).map((x) => x.open);
  host.replaceChildren();
  const srcTax = TAX.sources.map((s) => `<a href="${s.url}" rel="noopener" target="_blank">${s.label}</a>`).join('　');

  const lines1 = [
    `<b>所得總額（不含股利）</b> = 薪資 ${int(f.salary + f.spouseSalary)} ＋ 利息 ${int(f.interest)} ＋ 其他 ${int(f.other)} = <b>${int(A.totalOther)}</b>`,
    `　薪資這一項含你檔案裡的月薪 ${int(f.monthlySalary)} × 12 與年終獎金 ${int(P.getOr('annualBonus', 0))}`,
    `- 免稅額 = ${A.nNormal} 人 × ${int(R.exemption)} ＋ ${A.n70} 人 × ${int(R.exemptionAge70)} = <b>${int(A.exemption)}</b>`,
    `- 一般扣除額（${A.generalUsed === 'itemized' ? '列舉' : '標準'}）= <b>${int(A.general)}</b>`
      + `　標準 ${int(A.standard)}、購屋借款利息可列舉 clamp(${int(f.mortgageInterest)} - 儲蓄投資特扣 ${int(A.savings)}, 0, ${int(R.mortgageInterestCap)}) = ${int(A.mortgageNet)}，取大者`,
    `- 薪資所得特別扣除額 = ${int(A.salarySpecA)}${f.married ? ` ＋ ${int(A.salarySpecB)}` : ''}（每人上限 ${int(R.salaryDeduction)}）`,
    `- 儲蓄投資特別扣除額 = min(利息 ${int(f.interest)}, ${int(R.savingsDeduction)}) = <b>${int(A.savings)}</b>`,
    `- 幼兒學前特別扣除額 = ${int(A.preschool)}（${f.kids} 名 6 歲以下子女，第一名 ${int(R.preschoolFirst)}、第二名起每名 ${int(R.preschoolSecondPlus)}）`,
    `- 長照特別扣除額 ${f.ltcCount} 人 × ${int(R.longTermCare)} = ${int(A.ltc)}`
      + `　- 房租特別扣除額 min(${int(f.rentPaid)}, ${int(R.rentDeduction)}) = ${int(A.rent)}`,
    `　這兩項合計 <b>${int(A.forfeitable)}</b> 元<b>只在合併計稅時能減</b>；選 28% 分開計稅時要加回去（所得稅法第 17 條第 3 項）`,
    A.basicTotal == null
      ? `- 基本生活費差額 = <b>未計入</b>：${R.label} 之每人基本生活費尚未查得公告值，寧可不算也不用舊年度的數字冒充`
      : `- 基本生活費差額 = max(0, ${int(R.basicLivingExpense)} × ${A.headcount} 人 - 比較基礎) = <b>${int(A.basicDiff)}</b>`,
    `<b>其他所得淨額（地圖的縱軸）= ${int(Math.round(active.netOther))}</b>`,
  ];
  if (active.method !== 'all') {
    lines1.push(`目前採用的夫妻計稅方式是「${active.label}」，分開那一方的淨額 ${int(Math.round(active.sepNet))}、單獨稅額 ${int(Math.round(active.sepTax))}`);
    lines1.push('模型約定：股利一律歸入合併申報那一方，利息與其他所得一律歸本人。');
  }
  host.appendChild(formulaBlock('攤開看：其他所得淨額是怎麼從你的檔案算出來的', lines1, srcTax));

  const cr = credit(f.dividend);
  host.appendChild(formulaBlock('攤開看：兩制稅額並排', [
    `<b>合併計稅</b> = f(其他所得淨額 ＋ 股利) - min(股利 × ${pp(DIV().creditRate * 100, 1)}, ${int(DIV().creditCapPerHousehold)})`,
    `= f(${int(Math.round(active.netOther))} ＋ ${int(f.dividend)}) - ${int(Math.round(cr))}`
      + `${active.sepTax ? ` ＋ 分開方 ${int(Math.round(active.sepTax))}` : ''} = <b>${fmtTax(ev.combined)}</b>`,
    `<b>分開計稅</b> = f(其他所得淨額 ＋ 被追回的長照與房租特扣) ＋ 股利 × ${pp(DIV().separateRate * 100, 0)}`,
    `= f(${int(Math.round(active.netOther))} ＋ ${int(A.forfeitable)}) ＋ ${int(f.dividend)} × 0.28`
      + `${active.sepTax ? ` ＋ 分開方 ${int(Math.round(active.sepTax))}` : ''} = <b>${fmtTax(ev.separate)}</b>`,
    A.forfeitable > 0
      ? `　那個 ＋${int(A.forfeitable)} 就是 28% 制的隱藏成本：長照與房租特扣被整個取消。不加回去會系統性高估 28% 制。`
      : '　你目前沒有長照與房租特扣，所以這一項是 0；有的話，28% 制那一側會多出等額的課稅所得。',
    '<b>兩制都必須就整個申報戶的全部股利擇一</b>，不能一部分合併、一部分分開。',
    `f( ) 是 ${R.label} 的速算式：淨額 × 稅率 - 累進差額`,
    ...R.brackets.map((b, i) => {
      const lo = i === 0 ? 0 : R.brackets[i - 1].upTo;
      return `　${int(lo)} 到 ${b.upTo == null ? '以上' : int(b.upTo)}：× ${pp(b.rate * 100, 0)} - ${int(b.quick)}`;
    }),
  ], srcTax));

  host.appendChild(formulaBlock(`攤開看：折點為什麼落在 ${wan(kinkD())}`, [
    `可抵減稅額 = 股利 × ${pp(DIV().creditRate * 100, 1)}，但每一申報戶每年上限 ${int(DIV().creditCapPerHousehold)} 元`,
    `${int(DIV().creditCapPerHousehold)} ÷ ${DIV().creditRate} = <b>${int(kinkD())}</b> 元（常數檔記載的交叉點是 ${int(DIV().crossoverDividend)}）`,
    `低於這個數：多領 1 元股利，抵減多 ${dec(DIV().creditRate * 100, 1)} 分，合併計稅的邊際負擔 = 邊際稅率 - ${pp(DIV().creditRate * 100, 1)}`,
    '高於這個數：抵減不再增加，合併計稅的邊際負擔 = 邊際稅率本身',
    `所以分界線在這裡往下折一次。你的股利是 ${int(f.dividend)}，`
      + `${f.dividend > kinkD() ? '<b>已經越過折點</b>' : '還在折點左邊'}`,
    Number.isFinite(OUT.flipD)
      ? `你的翻轉點：股利 = <b>${int(Math.round(OUT.flipD))}</b> 元`
      : '在目前的其他所得淨額之下，股利再高也不會翻轉',
  ], srcTax));

  host.appendChild(formulaBlock('攤開看：二代健保補充保費', [
    `逐筆判定：單次給付 ≥ ${int(NHI.thresholds.dividend)} 元才起扣，未達完全不扣`,
    `補充保費 = min(單次給付, ${int(NHI.singlePaymentCap)}) × ${pp(NHI.rate * 100, 2)}`,
    '它不看你的其他所得，也不看你選哪一種計稅方式，所以在地圖上它的等高線是垂直的',
    '這也表示：兩制之爭與補充保費之爭是兩件事，計稅方式選錯不會讓補充保費變多或變少',
    `<b>年度累計制</b> ${NHI.annualSettlementReform.status}（查證日 ${NHI.annualSettlementReform.asOf}）。${NHI.annualSettlementReform.detail}`,
  ], NHI.sources.map((s) => `<a href="${s.url}" rel="noopener" target="_blank">${s.label}</a>`).join('　')));

  $$('details', host).forEach((dEl, i) => { if (open[i]) dEl.open = true; });
}

/* ==========================================================================
   6. 第二聯：台股 ETF 起始月樂透
   ------------------------------------------------------------------------
   規則一：報酬一律只用 adj（還原權息價）。close 是未還原價，只在方法論面板裡
   當作對照顯示，任何報酬運算都不准碰它。
   規則二：逐月掃描還原價，任何月對月 -40% 以上的跳空一律視為未還原或未處理
   分割的痕跡，停用該檔並在畫面上說明，不畫一條有假崩盤的曲線。
   ========================================================================== */
function buildTicker(raw) {
  const months = raw.monthly.map((m) => ({ ym: m.ym, date: m.date, adj: m.adj, close: m.close }));
  const events = (raw.adjustments || []).map((a) => ({ date: a.date, f: a.factor, kind: a.kind }));
  const t = {
    id: raw.id, name: raw.name, listed: raw.listed,
    months, events, n: months.length,
    splitFixedAt: raw.splitFixedAt || null,
    broken: null,
  };

  for (let i = 1; i < months.length; i++) {
    const r = months[i].adj / months[i - 1].adj;
    if (!(r > 0.6)) {
      t.broken = `${months[i].ym} 的還原價較前一個月掉了 ${pct(1 - r, 1)}，`
        + '這個幅度不像市場波動，比較像未處理的分割或未還原的價格。這一檔已被停用。';
      break;
    }
  }

  // px：與未還原收盤價等比的序列，只用來算配息現金流與領現金路徑。
  // px_t = adj_t × Π(除息日 ≤ t 的因子)。它由 adj 導出，不讀 close。
  let cum = 1; let ei = 0;
  const sorted = [...events].sort((a, b) => (a.date < b.date ? -1 : 1));
  t.evByMonth = new Array(months.length).fill(null);
  for (let i = 0; i < months.length; i++) {
    while (ei < sorted.length && sorted[ei].date <= months[i].date) {
      cum *= sorted[ei].f;
      if (!t.evByMonth[i]) t.evByMonth[i] = [];
      t.evByMonth[i].push(sorted[ei]);
      ei++;
    }
    months[i].px = months[i].adj * cum;
  }
  t.adj = months.map((m) => m.adj);
  t.px = months.map((m) => m.px);
  return t;
}

/** 這一檔在目前資料量下，最長能回答到幾年。0 代表任何視窗都答不了。 */
const maxYears = (t) => Math.max(0, Math.floor((t.n - MIN_STARTS) / 12));

function contributionAt(cfg, k, W) {
  if (cfg.mode === 'lump') return k === 0 ? cfg.amount : 0;
  return k < W ? cfg.monthly : 0;
}

function runWindow(t, i, W, cfg) {
  const e = i + W;
  const px = t.px;
  const fee = (amt, side) => twTradeCost(amt, {
    side, discount: cfg.disc, minFee: cfg.minFee, feeRate: cfg.feeRate, taxRate: cfg.stt,
  });

  let shares = 0; let sharesG = 0;
  let invested = 0; let cash = 0; let cashG = 0;
  let tradeCost = 0; let nhiTotal = 0;
  const divByYear = new Map();
  const flows = [];

  for (let m = i; m <= e; m++) {
    const k = m - i;
    // 除息：以前一個月底的價格當除息前價（買在 i 月底，i 月的息已經過了）
    if (m > i && t.evByMonth[m]) {
      const pre = px[m - 1];
      for (const ev of t.evByMonth[m]) {
        const d = shares * pre * (1 - ev.f);
        const dg = sharesG * pre * (1 - ev.f);
        if (d > 0) {
          const y = ev.date.slice(0, 4);
          divByYear.set(y, (divByYear.get(y) || 0) + d);
          nhiTotal += nhiSupplement(d, { rate: cfg.nhiRate, floor: cfg.nhiFloor, cap: cfg.nhiCap });
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

  const proceeds = shares * px[e];
  const sellCost = fee(proceeds, 'sell');
  tradeCost += sellCost;
  const grossV = sharesG * px[e] + cashG;
  const beforeTax = proceeds - sellCost + cash;

  // 股利稅逐年結算：8.5% 抵減上限是「每一申報戶每年」8 萬元
  let divTax = 0;
  for (const [, amt] of divByYear) {
    if (cfg.taxMode === 'separate') divTax += amt * cfg.sepRate;
    else divTax += amt * cfg.marginal - Math.min(amt * cfg.creditRate, cfg.creditCap);
  }

  const netV = beforeTax - divTax - nhiTotal;
  flows[flows.length - 1] += netV;

  const years = W / 12;
  let ann;
  if (cfg.mode === 'lump') {
    ann = invested > 0 && netV > 0 ? Math.pow(netV / invested, 1 / years) - 1 : (invested > 0 ? -1 : NaN);
  } else {
    const r = irr(flows, cfg.warm);
    ann = Number.isFinite(r) ? Math.pow(1 + r, 12) - 1 : NaN;
    if (Number.isFinite(r)) cfg.warm = r;
  }

  return {
    i, e, startYm: t.months[i].ym, endYm: t.months[e].ym,
    invested, netV, grossV, tradeCost, divTax, nhi: nhiTotal, ann,
  };
}

function runTicker(t, W, cfg) {
  const starts = t.n - 1 - W;
  const out = [];
  const c = { ...cfg, warm: 0.006 };
  for (let i = 0; i <= starts; i++) out.push(runWindow(t, i, W, c));
  return out;
}

function summarize(rows) {
  const vs = rows.map((r) => r.ann).filter(Number.isFinite).sort((a, b) => a - b);
  if (!vs.length) return null;
  return {
    n: vs.length,
    min: vs[0], max: vs[vs.length - 1],
    p10: quantile(vs, 0.1), p25: quantile(vs, 0.25), med: quantile(vs, 0.5),
    p75: quantile(vs, 0.75), p90: quantile(vs, 0.9),
    win: vs.filter((v) => v > 0).length / vs.length,
    values: vs,
  };
}

/* ---------- 招牌視覺：直方圖 ＋ 箱型圖 ----------
   直方圖交給 Plot 的 bars（_morph 會把柱子從舊形狀流到新形狀，那就是「重新塌陷」）；
   箱型圖畫在同一張畫布的上方留白帶，用一條平行的 gsap tween 讓兩者同步。 */
const distPlot = new Plot($('#chartDist'), {
  aspect: 0.62, minHeight: 260, maxHeight: 420,
  yFormat: (v) => String(Math.round(v)),
  xFormat: (v) => pp(v * 100, 0),
  yTicks: 4, xTicks: 5,
  padding: { left: 40, right: 14, top: 40, bottom: 30 },
});
const distTip = createTip($('#distCard'));

let boxCur = [];
function drawBoxes() {
  const p = distPlot; const ctx = p.ctx;
  if (!p.domain || !boxCur.length) return;
  const L = p.pad.left; const R = p.w - p.pad.right;
  const X = (v) => clamp(p.sx(v), L, R);
  ctx.save();
  boxCur.forEach((b, row) => {
    if (!b.on) return;
    const y = 6 + row * 15;
    const h = 9;
    ctx.strokeStyle = b.color; ctx.fillStyle = b.color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.moveTo(X(b.min), y + h / 2); ctx.lineTo(X(b.max), y + h / 2); ctx.stroke();
    for (const v of [b.min, b.max]) {
      const x = Math.round(X(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, y + 1.5); ctx.lineTo(x, y + h - 1.5); ctx.stroke();
    }
    const x0 = X(b.p25); const x1 = X(b.p75);
    ctx.globalAlpha = 0.2;
    ctx.fillRect(Math.round(x0), y, Math.max(1, Math.round(x1 - x0)), h);
    ctx.globalAlpha = 0.95;
    ctx.strokeRect(Math.round(x0) + 0.5, y + 0.5, Math.max(1, Math.round(x1 - x0)), h - 1);
    ctx.globalAlpha = 0.8;
    for (const v of [b.p10, b.p90]) {
      const x = Math.round(X(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, y + 2.5); ctx.lineTo(x, y + h - 2.5); ctx.stroke();
    }
    ctx.globalAlpha = 1; ctx.lineWidth = 2.5;
    const xm = Math.round(X(b.med));
    ctx.beginPath(); ctx.moveTo(xm, y - 1); ctx.lineTo(xm, y + h + 1); ctx.stroke();
  });
  ctx.restore();
}
const distBaseRender = Plot.prototype.render.bind(distPlot);
distPlot.render = () => { distBaseRender(); drawBoxes(); };

/* 扣項相對於獲利常常只有百分之幾，柱子矮到看不見。那正是誠實的答案，
   但看不見就沒有溝通到，所以每一根柱子都直接標上金額。 */
const costPlot = new Plot($('#chartCost'), {
  aspect: 0.42, minHeight: 190, maxHeight: 300,
  yFormat: (v) => (Math.abs(v) >= 10000 ? dec(v / 10000, 1) + '萬' : String(Math.round(v))),
  xFormat: () => '',
  yTicks: 4,
  padding: { left: 48, right: 14, top: 26, bottom: 34 },
});
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

const cMedian = makeCounter($('#r-median'), (v) => pp(v * 100, 1, { sign: true }));
const cWorst = makeCounter($('#r-worst'), (v) => pp(v * 100, 1, { sign: true }));
const cBest = makeCounter($('#r-best'), (v) => pp(v * 100, 1, { sign: true }));
const cWin = makeCounter($('#r-win'), (v) => pp(v * 100, 0));
const cN = makeCounter($('#r-n'), (v) => int(v));
const cNeff = makeCounter($('#r-neff'), (v) => int(v));

let ghostBins = null;
let etfFrom = null;

function etfCfg() {
  const f = OUT.f;
  return {
    mode: S().etfMode,
    amount: S().amount,
    monthly: S().monthly,
    disc: f.disc,
    minFee: FEE.minFee,
    feeRate: FEE.rate,
    stt: FEE.stt,
    divMode: S().divMode,
    taxMode: OUT.taxMode,
    marginal: OUT.marginal,
    creditRate: DIV().creditRate,
    creditCap: DIV().creditCapPerHousehold,
    sepRate: DIV().separateRate,
    nhiRate: NHI.rate,
    nhiFloor: NHI.thresholds.dividend,
    nhiCap: NHI.singlePaymentCap,
  };
}

function computeEtf() {
  if (!TICKERS.length) return;
  const s = S();
  const W = Math.round(s.years * 12);
  const cfg = etfCfg();

  const chosen = TICKERS.filter((t) => s.tickers.includes(t.id) && !t.broken);
  $('#tickerError').textContent = s.tickers.length === 0 ? '至少要選一檔標的。' : '';

  const usable = []; const refused = [];
  for (const t of chosen) {
    if (t.n - 1 - W < MIN_STARTS - 1) refused.push(t); else usable.push(t);
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
  if (!hasData) {
    $('#etfLead').textContent = '選到的標的在這個持有年數下沒有足夠的起始月可以取樣。'
      + '把年數拉短，或改選上市較久的標的。';
    return;
  }

  renderDistribution(results, W);
  renderEtfReadouts(results, W);
  renderEtfTable(results);
  renderCost(results[0], W);
  renderEtfFormula(results[0], W, cfg);

  const a = results[0];
  const spread = a.sum.p90 - a.sum.p10;
  $('#etfLead').innerHTML =
    `同樣持有 ${W / 12} 年，${a.t.id} 最差的起始月年化 <b>${pp(a.sum.min * 100, 1)}</b>、`
    + `最好的 <b>${pp(a.sum.max * 100, 1)}</b>，你能拿到哪一個取決於你哪個月開始買，而那多半不是你選的。`
    + `P10 到 P90 之間的寬度是 <b>${pp(spread * 100, 1)}</b>，那就是「起始日運氣」在這個持有年數下還剩多大。`
    + '把年數拉長，這個寬度會收窄，那才是長期投資真正在做的事：不是把報酬變高，是把運氣的影響範圍變小。';

  if (etfFrom) carbonTransfer($$('#p-etf [data-live]'));
  etfFrom = null;
}

function renderDistribution(results, W) {
  let lo = Infinity; let hi = -Infinity;
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
      barRatio: 0.94, hidden: !r, noCursor: true,
    };
  });

  const ghostData = ghostBins && ghostBins.length === BINS
    ? ghostBins
    : new Array(BINS).fill(0).map((_, k) => ({ x: lo + ((hi - lo) / BINS) * (k + 0.5), y: 0 }));
  series.push({
    type: 'line', data: ghostData, color: cssv('--ghost'),
    width: 1.5, dash: [3, 3], noCursor: true, hidden: !ghostBins,
  });

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

  const animate = etfFrom === 'years' || etfFrom === 'cost' || etfFrom === 'tax' || etfFrom === 'div';
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

  ghostBins = histogram(results[0].sum.values, BINS, lo, hi).bins.map((b) => ({ x: b.x, y: b.y }));
  window.__dist = results.map((r) => ({ id: r.t.id, values: r.sum.values }));

  const lg = $('#distLegend');
  lg.replaceChildren();
  results.forEach((r) => {
    lg.appendChild(legendItem(r.t.id, cssv(SERIES_VARS[idxOf(r.t.id) % 5])));
  });

  $('#distDesc').innerHTML =
    '橫軸是扣完成本與稅之後的年化報酬率，縱軸是有幾個起始月落在那一格；上方橫條是箱型圖，'
    + '箱體為 P25 到 P75，粗線為中位，兩端細刻為 P10 與 P90，鬚線兩端是最差與最好的起始月。'
    + results.map((r) => `<br><b>${r.t.id} ${r.t.name}</b>：持有 ${W / 12} 年，${r.sum.n} 個起始月裡`
      + `最差 ${pp(r.sum.min * 100, 1)}、P10 ${pp(r.sum.p10 * 100, 1)}、中位 ${pp(r.sum.med * 100, 1)}、`
      + `P90 ${pp(r.sum.p90 * 100, 1)}、最好 ${pp(r.sum.max * 100, 1)}，`
      + `其中 ${pp(r.sum.win * 100, 0)} 的起始月是正報酬。`).join('');
}

function renderEtfReadouts(results, W) {
  const r = results[0];
  const a = r.sum;
  cMedian(a.med); cWorst(a.min); cBest(a.max); cWin(a.win);
  const neff = Math.max(1, Math.floor(r.t.n / W));
  // 勝率旁邊永遠掛著有效樣本數，避免它被當成機率讀
  $('#r-winnote').textContent = `${r.t.id}・${W / 12} 年・有效樣本 ${neff}`;

  cN(a.n);
  cNeff(neff);
  $('#r-span').textContent = `${r.t.months[0].ym} 到 ${r.t.months[r.t.n - 1].ym}`;
  $('#sampleNote').className = neff <= 2 ? 'note note--stop' : 'note note--warn';
  $('#sampleNote').innerHTML =
    `這 ${a.n} 個起始月裡，相鄰兩個視窗共用了 ${pp((1 - 1 / W) * 100, 1)} 的月份，`
    + `所以它們不是 ${a.n} 個獨立樣本。有效獨立樣本數 ≈ 總期間 ${r.t.n} 個月 ÷ 視窗 ${W} 個月 = <b>${neff}</b>。`
    + `<b>${neff} 個樣本不足以支撐任何統計顯著性的宣稱</b>，`
    + '上面的正報酬比例請讀成「歷史上這段期間有幾個起始月是賺的」，不是「未來賺錢的機率」。'
    + (neff <= 2
      ? `<br><b>這個持有年數已經長到整段歷史只裝得下 ${neff} 個不重疊的視窗</b>，`
        + `分布看起來很漂亮，但它其實只是同一段歷史被切了 ${a.n} 次。`
      : '');
}

function renderEtfTable(results) {
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
    body.appendChild(tr);
  }
  $('#etfTableFoot').textContent =
    '全部為扣掉手續費、證交稅、股利稅與補充保費之後的年化報酬率。'
    + `股利稅用的是第一聯替你選的「${OUT.taxMode === 'separate' ? '分開計稅 28%' : '合併計稅'}」`
    + `與邊際稅率 ${pp(OUT.marginal * 100, 0)}，你不需要在這裡再選一次。`;
}

function renderCost(res, W) {
  // 取中位數那一個起始月當代表，才不是挑一個好看的
  const sorted = [...res.rows].filter((r) => Number.isFinite(r.ann)).sort((a, b) => a.ann - b.ann);
  const rep = sorted[Math.floor(sorted.length / 2)];
  if (!rep) return;

  // 以損益兩平為基線畫獲利，而不是畫終值：終值的柱子太高，扣項會被壓成一條線。
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
      x: k + 1, y: Math.min(run, next), y1: Math.max(run, next),
      color: st.amt >= 0 ? cssv('--down') : cssv('--up'),
    });
    costLabels.push({
      x: k + 1, top: Math.max(run, next, 0),
      text: st.amt === 0 ? '0' : '-' + int(Math.round(st.amt)),
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

  const s = S();
  const erosion = rep.grossV > rep.invested ? (rep.grossV - rep.netV) / (rep.grossV - rep.invested) : NaN;
  const perBuy = s.etfMode === 'dca' ? s.monthly : s.amount;
  const disc = OUT.f.disc;
  const minFeeBite = perBuy > 0
    ? Math.max(FEE.minFee, Math.round(perBuy * FEE.rate * disc)) / perBuy : 0;

  $('#costDesc').innerHTML =
    '縱軸以損益兩平為基線畫「獲利」，不畫終值，因為終值的柱子太高，扣項會被壓成一條線。'
    + `以中位數那一個起始月（${rep.startYm} 進場、${rep.endYm} 出場）為例：`
    + `投入 ${int(Math.round(rep.invested))} 元，零成本的毛獲利 ${int(Math.round(grossP))} 元；`
    + `交易成本吃掉 ${int(Math.round(tradeAll))} 元、股利稅 ${int(Math.round(rep.divTax))} 元、`
    + `補充保費 ${int(Math.round(rep.nhi))} 元，淨獲利 <b>${int(Math.round(netP))}</b> 元。`
    + (Number.isFinite(erosion) ? `成本與稅吃掉了這段獲利的 <b>${pp(erosion * 100, 1)}</b>。` : '')
    + `<br>每一筆買進的實際手續費率是 ${pp(minFeeBite * 100, 3)}`
    + (minFeeBite > FEE.rate * disc * 1.02
      ? `：最低手續費 ${int(FEE.minFee)} 元把費率放大到牌告折後的 ${dec(minFeeBite / (FEE.rate * disc), 1)} 倍，這就是小額扣款最容易被忽略的破口。`
      : '（未觸及最低手續費）。')
    + (rep.nhi === 0 ? '<br>補充保費為 0：每一次配息都沒有達到 2 萬元的單次起扣門檻。' : '');
}

function renderRefusal(refused, usable, W) {
  const box = $('#refuse');
  if (!refused.length && usable.length) { box.hidden = true; return; }
  box.hidden = false;
  if (!refused.length) {
    $('#refuseTitle').textContent = '還沒選標的';
    $('#refuseBody').textContent = '左邊的標的清單至少勾選一檔，這一聯才有東西可以算。';
    $('#refuseFix').hidden = true;
    return;
  }
  const names = refused.map((t) => `${t.id} ${t.name}`).join('、');
  const best = refused.map((t) => maxYears(t));
  const okAll = Math.min(...[...refused, ...usable].map((t) => maxYears(t)));
  $('#refuseTitle').textContent = usable.length ? '有標的的資料不足以回答' : '資料不足以回答這個問題';
  $('#refuseBody').innerHTML =
    `<b>${names}</b> 在持有 ${W / 12} 年的設定下，`
    + refused.map((t, k) => `${t.id} 只剩 ${Math.max(0, t.n - W)} 個可用的起始月`
      + `（上市至今 ${t.n} 個月，最長只能回答到 ${best[k]} 年）`).join('；')
    + `。起始月少於 ${MIN_STARTS} 個時畫出來的分布只是幾條噪音，所以這裡不畫。`
    + '寧可承認答不了，也不給你一個看起來很專業的假分布。';
  const btn = $('#refuseFix');
  if (okAll >= 1) {
    btn.hidden = false;
    btn.textContent = `改成 ${okAll} 年（這組標的可回答的最長視窗）`;
    btn.onclick = () => { sYears.set(okAll); };
  } else {
    btn.hidden = true;
  }
}

function renderEtfFormula(res, W, cfg) {
  const host = $('#etfFormula');
  const open = $$('details', host).map((x) => x.open);
  host.replaceChildren();
  const t = res.t;

  host.appendChild(formulaBlock('攤開看：還原權息序列是怎麼重建的', [
    '<b>除息</b> 調整因子 f<sub>d</sub> = 除權息參考價 ÷ 除權息前收盤價',
    '<b>還原價</b> Adj<sub>t</sub> = Close<sub>t</sub> × Π<sub>d&gt;t</sub> f<sub>d</sub>',
    `${t.id} 共 ${t.events.length} 筆除權息調整，序列 ${t.months[0].ym} 到 ${t.months[t.n - 1].ym}，${t.n} 個月`,
    `<b>分割</b> ${t.splitFixedAt ? `建置資料已於 ${t.splitFixedAt} 處理過分割（0050 於 2025-06-18 的 1 拆 4）` : '本檔的建置資料未記載分割修正'}`,
    '<b>檢核</b> 逐月掃描還原價，任何月對月 -40% 以上的跳空一律視為資料異常並停用該檔',
    '<b>封死未還原價</b> 報酬只讀 adj 欄位；close（未還原）不參與任何運算',
    `對照：${t.months[t.n - 1].ym} 收盤 ${dec(t.months[t.n - 1].close, 2)} 元（未還原），還原價 ${dec(t.adj[t.n - 1], 2)}`,
  ], `序列由臺灣證券交易所 STOCK_DAY 與 TWT49U（除權除息計算結果表）離線建置後 committed 進 repo，執行期不呼叫任何外部 API。市場資料建置日 ${MARKET.builtAt}，可回溯下限 ${MARKET.dataFloor}。`));

  host.appendChild(formulaBlock('攤開看：滾動視窗與年化怎麼算', [
    `<b>視窗</b> 對每個起始月 s 各跑一次，本次共 ${res.sum.n} 個起始月，視窗長度 ${W} 個月（${W / 12} 年）`,
    '<b>單筆年化</b> (期末淨值 ÷ 累計投入)<sup>1/年</sup> - 1',
    '<b>定期定額年化</b> 現金流不規則，改解 Σ CF<sub>k</sub>/(1+r)<sup>k</sup> = 0 的月報酬 r，年化 = (1+r)<sup>12</sup> - 1',
    '　（Newton-Raphson，失敗退回二分法，區間 [-0.99, 10]）',
    `<b>有效獨立樣本</b> ≈ ${t.n} ÷ ${W} = ${Math.max(1, Math.floor(t.n / W))}`,
    '<b>配息估算</b> 每次除息的現金 ≈ 除息前一個月底的持有市值 × (1 - f<sub>d</sub>)；月度序列無法精確到除息當日，這是近似',
  ], '滾動視窗高度重疊，相鄰樣本共用絕大部分月份，勝率與分位數都不是統計顯著的推論。'
    + '以金額近似買賣，不模擬整股與零股的成交顆粒度，也不模擬買賣價差與流動性衝擊。'));

  host.appendChild(formulaBlock('攤開看：這一聯的稅是從哪一聯來的', [
    `<b>課稅方式</b> ${cfg.taxMode === 'separate' ? '分開計稅 28%' : '合併計稅（8.5% 可抵減）'}`
      + `，來自第一聯的結論${S().taxChoice === 'auto' ? '（自動採用較省的那一個）' : '（你在抬頭手動指定）'}`,
    `<b>邊際稅率</b> ${pp(cfg.marginal * 100, 0)}，由你檔案裡的薪資、扶養與扣除額推出的其他所得淨額 `
      + `${int(Math.round(OUT.active.netOther))} 元加上股利 ${int(OUT.f.dividend)} 元決定`,
    `<b>合併計稅</b> 稅額 = 該年度股利 × ${pp(cfg.marginal * 100, 0)} - min(股利 × ${pp(cfg.creditRate * 100, 1)}, ${int(cfg.creditCap)})，逐年結算`,
    `<b>分開計稅</b> 稅額 = 該年度股利 × ${pp(cfg.sepRate * 100, 0)}`,
    `<b>補充保費</b> 單筆配息 ≥ ${int(cfg.nhiFloor)} 元時，以全額（上限 ${int(cfg.nhiCap)} 元）× ${pp(cfg.nhiRate * 100, 2)}`,
    `<b>手續費</b> max(${int(cfg.minFee)}, 成交金額 × ${pp(cfg.feeRate * 100, 4)} × ${dec(cfg.disc, 2)})，折數取自你檔案裡的「${dec(cfg.disc * 10, 1).replace(/\.0$/, '')} 折」`,
    `<b>賣出證交稅</b> ${pp(cfg.stt * 100, 1)}（股票型 ETF）`,
    '<b>簡化之處</b> 這一聯把模擬出來的 ETF 配息，套上你其他所得算出來的邊際稅率；'
      + '實際上這些配息本身會把你推進更高的級距，也會改變 8 萬抵減上限的用量。要精算兩制請回第一聯。',
  ], '稅率級距與股利兩制常數取自 assets/data/tw-tax.json，補充保費取自 assets/data/tw-nhi.json。'
    + '交易成本常數的來源與其爭議見本頁最下方「交易成本」那一節。'));

  $$('details', host).forEach((dEl, i) => { if (open[i]) dEl.open = true; });
}

distPlot.onCursor = (x, px) => {
  if (x == null) { distTip.hide(); return; }
  const rows = window.__dist || [];
  if (!rows.length) { distTip.hide(); return; }
  const lines = rows.map((r) => {
    const below = r.values.filter((v) => v <= x).length;
    return `<b>${r.id}</b> ${pp((below / r.values.length) * 100, 0)} 的起始月低於這裡`;
  });
  distTip.show(`<b>年化 ${pp(x * 100, 1)}</b>（持有 ${S().years} 年）<br>${lines.join('<br>')}`,
    px, distPlot.pad.top + 24);
};

/* ==========================================================================
   7. 第三聯：除息填息機
   每一期：價格趨勢 → 除權息 → 填息。稅費在配息當下扣除。
   持股張數預設由檔案裡的「全年股利」回推，配息筆數直接沿用檔案裡的那一格，
   所以第一聯算出來的「每筆配息有沒有過 2 萬」，在這裡是同一個數字。
   ========================================================================== */
const LOT = 1000;   // 上市有價證券一交易單位 = 1,000 股
const PAR = 10;     // 無償配股率 = 股票股利 ÷ 每股面額 10 元（本模組不模擬配股，保留常數）

function exInput() {
  const s = S();
  const f = OUT.f;
  const price = s.price;
  const divYield = s.divYield / 100;
  // 張數 0 代表「還沒手動調過」：用檔案裡的全年股利回推
  const wantLots = (price > 0 && divYield > 0) ? f.dividend / (price * divYield) / LOT : 15;
  const autoLots = clamp(Math.round(wantLots), 1, 2000);
  return {
    price,
    lots: s.lots > 0 ? s.lots : autoLots,
    autoLots,
    // 回推的張數撞到滑桿上限時要說出來，不能讓使用者以為那就是他的部位
    capped: Math.round(wantLots) > 2000,
    auto: !(s.lots > 0),
    years: Math.round(s.exYears),
    divYield,
    freq: f.payouts,
    qual: s.qual / 100,
    fill: s.fill / 100,
    trend: s.trend / 100,
    mkt: s.mkt / 100,
    bear: s.bear / 100,
    bracket: OUT.marginal,
    taxMode: OUT.taxMode,
    disc: f.disc,
    mode: s.exMode,
  };
}

function project(s, dScale = 1) {
  const creditRate = DIV().creditRate;
  const creditCap = DIV().creditCapPerHousehold;
  const sepRate = DIV().separateRate;
  const nhiOpt = { rate: NHI.rate, floor: NHI.thresholds.dividend, cap: NHI.singlePaymentCap };

  const k = s.freq;
  const steps = Math.round(s.years * k);
  const shares0 = s.lots * LOT;
  const invested = shares0 * s.price;
  const gPer = Math.pow(1 + s.trend, 1 / k) - 1;   // 幾何分攤，不是除以 k
  const d = s.divYield * dScale;

  let price = s.price;
  let sharesA = shares0;
  let sharesB = shares0;
  let cashB = 0;
  let year = 0;
  // 8.5% 可抵減稅額是「每一申報戶每年」上限，所以逐年重置，兩個組合各自累計
  let creditUsedA = 0; let creditUsedB = 0;

  const taxOf = (divIncome, used) => {
    if (s.taxMode === 'separate') return { tax: divIncome * sepRate, credit: 0 };
    const c = Math.min(divIncome * creditRate, Math.max(0, creditCap - used));
    return { tax: divIncome * s.bracket - c, credit: c };
  };

  let grossTotal = 0; let taxTotal = 0; let nhiTotal = 0; let feeTotal = 0; let netTotal = 0;
  const rows = [];
  const pathA = [{ x: 0, y: invested }];
  const pathB = [{ x: 0, y: invested }];
  const own = s.mode === 'reinvest' ? 'A' : 'B';

  for (let i = 1; i <= steps; i++) {
    const yNow = Math.ceil(i / k);
    if (yNow !== year) { year = yNow; creditUsedA = 0; creditUsedB = 0; }

    const before = price * (1 + gPer);       // 除息前收盤價
    const D = before * (d / k);              // 每股現金股利
    const ex = before - D;                   // 除息參考價（本模組不模擬配股與現金增資）
    const after = ex + s.fill * D;           // 填息後價位
    const heldA = sharesA; const heldB = sharesB;

    const grossA = sharesA * D;
    const incA = grossA * s.qual;            // 只有股利所得那一部分課稅費
    const nhiA = nhiSupplement(incA, nhiOpt);
    const tA = taxOf(incA, creditUsedA); creditUsedA += tA.credit;
    const netA = grossA - nhiA - tA.tax;
    const feeA = netA > 0 ? twTradeCost(netA, {
      side: 'buy', discount: s.disc, minFee: FEE.minFee, feeRate: FEE.rate,
    }) : 0;
    if (ex > 0.01) sharesA += Math.max(0, netA - feeA) / ex;

    const grossB = sharesB * D;
    const incB = grossB * s.qual;
    const nhiB = nhiSupplement(incB, nhiOpt);
    const tB = taxOf(incB, creditUsedB); creditUsedB += tB.credit;
    const netB = grossB - nhiB - tB.tax;
    cashB += netB;

    price = after;

    // 「你這一聯」：招牌視覺、門檻提示與結論都跟著使用者選的做法走
    const gross = own === 'A' ? grossA : grossB;
    const nhi = own === 'A' ? nhiA : nhiB;
    const tax = own === 'A' ? tA.tax : tB.tax;
    const fee = own === 'A' ? feeA : 0;
    const net = (own === 'A' ? netA : netB) - fee;

    grossTotal += gross; taxTotal += tax; nhiTotal += nhi; feeTotal += fee; netTotal += net;
    rows.push({
      i, year: yNow, before, D, ex, after, gross, nhi, tax, fee, net,
      held: own === 'A' ? heldA : heldB,
    });
    pathA.push({ x: i / k, y: sharesA * price });
    pathB.push({ x: i / k, y: sharesB * price + cashB });
  }

  const endPrice = price;
  const valueA = sharesA * endPrice;
  const valueB = sharesB * endPrice + cashB;
  const valueC = invested * Math.pow(1 + s.mkt, s.years);
  const pathC = [];
  for (let i = 0; i <= steps; i++) pathC.push({ x: i / k, y: invested * Math.pow(1 + s.mkt, i / k) });

  const cagr = (v) => (invested > 0 && s.years > 0 ? Math.pow(v / invested, 1 / s.years) - 1 : NaN);
  return {
    steps, invested, endPrice, rows, pathA, pathB, pathC,
    valueA, valueB, valueC, cashB,
    cagrA: cagr(valueA), cagrB: cagr(valueB), cagrC: cagr(valueC),
    grossTotal, taxTotal, nhiTotal, feeTotal, netTotal,
    valueOwn: s.mode === 'reinvest' ? valueA : valueB,
    cagrOwn: s.mode === 'reinvest' ? cagr(valueA) : cagr(valueB),
  };
}

/* ---------- 招牌視覺：股價柱 → 切下來的那一塊 → 錢包 → 兩滴水 ---------- */
const stageCv = $('#stage');
const sctx = stageCv.getContext('2d');
const STAGE = {
  before: 20, D: 0, ex: 20, after: 20, target: 20,
  gross: 0, nhi: 0, tax: 0, net: 0,
  cumNet: 0, cumTax: 0, cumNhi: 0, idx: 0, total: 1,
};
const A4 = { cut: 0, fly: 0, drip: 0, fill: 0 };
let SW = 320; let SH = 240; let SDPR = 1;

function resizeStage() {
  const host = stageCv.parentElement;
  const w = Math.max(260, host.clientWidth);
  const h = Math.round(Math.min(340, Math.max(250, w * 0.60)));
  if (w === SW && h === SH) return;   // 尺寸沒變就不要再寫樣式，否則 ResizeObserver 會自己餵自己
  SDPR = Math.min(2, window.devicePixelRatio || 1);
  stageCv.style.width = '100%';
  stageCv.style.height = h + 'px';
  stageCv.width = Math.round(w * SDPR);
  stageCv.height = Math.round(h * SDPR);
  SW = w; SH = h;
  drawStage();
}
new ResizeObserver(resizeStage).observe(stageCv.parentElement);
const lerp = (a, b, t) => a + (b - a) * t;

function drawStage() {
  const ctx = sctx;
  ctx.setTransform(SDPR, 0, 0, SDPR, 0, 0);
  ctx.clearRect(0, 0, SW, SH);

  const ink = cssv('--ink'); const ink2 = cssv('--ink-2'); const ink3 = cssv('--ink-3');
  const rule = cssv('--rule'); const ruleF = cssv('--rule-faint'); const ruleS = cssv('--rule-strong');
  const accent = cssv('--accent'); const accentWash = cssv('--accent-wash');
  const up = cssv('--up'); const down = cssv('--down'); const ghost = cssv('--ghost');
  const sheetSunk = cssv('--sheet-sunk');
  const mono = cssv('--font-mono') || 'monospace';
  const cjk = cssv('--font-cjk') || 'sans-serif';
  const small = SW < 420;
  const fs = small ? 9 : 10;

  const padL = small ? 34 : 42;
  const base = SH - 30;
  const top = 30;
  const barW = clamp(SW * 0.12, 22, 54);
  const barCx = padL + barW / 2 + (small ? 6 : 12);
  const walletW = clamp(SW * 0.30, 88, 138);
  const walletCx = SW - 12 - walletW / 2;
  const walletH = 52;
  // 錢包往下坐一點，右半邊才不會空一大塊；但要留得下底下兩滴水的標籤
  const walletTop = Math.min(top + (base - top) * 0.26, base - walletH - 58);

  const pMax = Math.max(0.0001, STAGE.before * 1.14);
  const yOf = (p) => base - (clamp(p, 0, pMax) / pMax) * (base - top);

  ctx.save();
  ctx.font = `500 ${fs}px ${mono}`;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const tickDigits = pMax >= 20 ? 0 : pMax >= 2 ? 1 : 2;
  for (const p of niceTicks(0, pMax, 4)) {
    const y = Math.round(yOf(p)) + 0.5;
    if (y < top - 1 || y > base + 1) continue;
    ctx.strokeStyle = ruleF; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(SW - 8, y); ctx.stroke();
    ctx.fillStyle = ink3;
    ctx.fillText(dec(p, tickDigits), padL - 4, y);
  }
  ctx.strokeStyle = rule;
  ctx.beginPath();
  ctx.moveTo(padL + 0.5, top); ctx.lineTo(padL + 0.5, base + 0.5); ctx.lineTo(SW - 8, base + 0.5);
  ctx.stroke();
  ctx.restore();

  const yBefore = yOf(STAGE.before);
  const yEx = yOf(STAGE.ex);
  const yAfter = yOf(STAGE.after);
  const yTarget = yOf(STAGE.target);

  /* ---- 除息前價位的騎縫虛線：缺口是相對這條線量的 ---- */
  const lineR = walletCx - walletW / 2 - 6;
  ctx.save();
  ctx.strokeStyle = ruleS;
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, Math.round(yBefore) + 0.5);
  ctx.lineTo(lineR, Math.round(yBefore) + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `700 ${fs}px ${cjk}`;
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  ctx.fillStyle = ink3;
  ctx.fillText(`除息前 ${dec(STAGE.before, 2)}`, lineR, yBefore - 3);
  ctx.restore();

  /* ---- 除息參考價：那一刀落在這裡 ---- */
  if (STAGE.D > 0 && A4.fly > 0) {
    ctx.save();
    ctx.strokeStyle = ink2; ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(barCx - barW / 2 - 6, Math.round(yEx) + 0.5);
    ctx.lineTo(lineR, Math.round(yEx) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `700 ${fs}px ${cjk}`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillStyle = ink2;
    ctx.fillText(`參考價 ${dec(STAGE.ex, 2)}`, lineR, yEx + 3);
    ctx.restore();
  }

  /* ---- 股價柱本體 ---- */
  const barTopP = A4.fly > 0 ? lerp(STAGE.ex, STAGE.after, A4.fill) : STAGE.before;
  const barTopY = yOf(barTopP);
  ctx.save();
  ctx.fillStyle = accentWash;
  ctx.fillRect(Math.round(barCx - barW / 2), Math.round(barTopY), Math.round(barW), Math.round(base - barTopY));
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(Math.round(barCx - barW / 2) + 0.5, Math.round(barTopY) + 0.5,
    Math.round(barW) - 1, Math.round(base - barTopY) - 1);
  ctx.restore();

  /* ---- 沒填回來的那一段：陰影就是「沒填息」的具體形狀 ---- */
  if (A4.fill > 0.45 && STAGE.after < STAGE.target - 1e-9) {
    const alpha = clamp((A4.fill - 0.45) / 0.45, 0, 1);
    const gy = Math.round(yTarget);
    const gh = Math.max(3, Math.round(yAfter - yTarget));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.rect(Math.round(barCx - barW / 2), gy, Math.round(barW), gh);
    ctx.clip();
    ctx.strokeStyle = ghost; ctx.lineWidth = 1;
    for (let x = -gh; x < barW + gh; x += 5) {
      ctx.beginPath();
      ctx.moveTo(barCx - barW / 2 + x, gy + gh);
      ctx.lineTo(barCx - barW / 2 + x + gh, gy);
      ctx.stroke();
    }
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = ghost;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(Math.round(barCx - barW / 2) + 0.5, gy + 0.5, Math.round(barW) - 1, gh - 1);
    ctx.setLineDash([]);
    ctx.font = `700 ${fs}px ${cjk}`;
    ctx.fillStyle = ink3;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(`未填 ${dec(STAGE.target - STAGE.after, 2)}`, barCx + barW / 2 + 6, gy + Math.max(gh, 8) / 2);
    ctx.restore();
  }

  /* ---- 切線掃過 ---- */
  if (A4.cut > 0 && A4.fly < 1) {
    ctx.save();
    ctx.strokeStyle = ink; ctx.lineWidth = 1.5;
    const x0 = barCx - barW / 2 - 8;
    const x1 = x0 + (barW + 16) * A4.cut;
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(yEx) + 0.5);
    ctx.lineTo(x1, Math.round(yEx) + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  /* ---- 飛行路徑：靜止時也要看得出「那一塊等一下會飛去哪裡」 ---- */
  const slabH0 = Math.max(4, yEx - yBefore);
  if (A4.fly >= 1 && STAGE.D > 0) {
    const x0 = barCx + barW / 2 + 2; const x1 = walletCx - walletW / 2 - 2;
    const y0 = yBefore + slabH0 / 2; const y1 = walletTop + walletH / 2;
    ctx.save();
    ctx.strokeStyle = ruleS;
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([2, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    for (let t = 0.05; t <= 1.001; t += 0.05) {
      ctx.lineTo(lerp(x0, x1, t), lerp(y0, y1, t) - Math.sin(t * Math.PI) * 22);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    if (!small) {
      ctx.font = `700 ${fs}px ${cjk}`;
      ctx.fillStyle = ink3;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(`配息 ${int(STAGE.gross)}`, (x0 + x1) / 2, (y0 + y1) / 2 - 26);
    }
    ctx.restore();
  }

  /* ---- 切下來的那一塊：從綠（股價跌）飛成紅（現金流入） ---- */
  if (A4.fly > 0 && A4.fly < 1) {
    const t = A4.fly;
    const cx = lerp(barCx, walletCx, t);
    const cy = lerp(yBefore + slabH0 / 2, walletTop + walletH / 2, t) - Math.sin(t * Math.PI) * 26;
    const w = lerp(barW, 38, t);
    const h = lerp(slabH0, 16, t);
    ctx.save();
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = down;
    ctx.fillRect(Math.round(cx - w / 2), Math.round(cy - h / 2), Math.round(w), Math.round(h));
    ctx.globalAlpha = t;
    ctx.fillStyle = up;
    ctx.fillRect(Math.round(cx - w / 2), Math.round(cy - h / 2), Math.round(w), Math.round(h));
    ctx.globalAlpha = 1;
    if (t > 0.25) {
      ctx.font = `700 ${fs}px ${mono}`;
      ctx.fillStyle = up;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(int(STAGE.gross), cx, cy - h / 2 - 3);
    }
    ctx.restore();
  }

  /* ---- 錢包：方角信封，蓋子是一道折線 ---- */
  const wx = Math.round(walletCx - walletW / 2);
  const wy = Math.round(walletTop);
  const ww = Math.round(walletW); const wh = walletH;
  ctx.save();
  ctx.fillStyle = sheetSunk;
  ctx.fillRect(wx, wy, ww, wh);
  ctx.strokeStyle = ruleS;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(wx + 0.5, wy + 0.5, ww - 1, wh - 1);
  ctx.beginPath();
  ctx.moveTo(wx, wy); ctx.lineTo(wx + ww / 2, wy + 14); ctx.lineTo(wx + ww, wy);
  ctx.stroke();
  ctx.font = `700 ${fs}px ${cjk}`;
  ctx.fillStyle = ink3;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('累計淨入帳', wx + ww / 2, wy + 16);
  ctx.font = `700 ${small ? 13 : 15}px ${mono}`;
  ctx.fillStyle = up;
  ctx.fillText(int(STAGE.cumNet + STAGE.net * A4.fly), wx + ww / 2, wy + 28);
  ctx.restore();

  /* ---- 兩滴水：綜所稅與 2.11% 補充保費 ---- */
  const drops = [
    { v: STAGE.tax, label: '綜所稅', cum: STAGE.cumTax, dx: -ww / 4 },
    { v: STAGE.nhi, label: '補充保費', cum: STAGE.cumNhi, dx: ww / 4 },
  ];
  ctx.save();
  ctx.textAlign = 'center';
  drops.forEach((dp) => {
    const cx = wx + ww / 2 + dp.dx;
    const outflow = dp.v >= 0;
    const dy = wy + wh + 4 + A4.drip * 20;
    if (A4.drip > 0 && Math.abs(dp.v) > 0.5) {
      ctx.globalAlpha = 1 - A4.drip * 0.35;
      ctx.fillStyle = outflow ? down : up;
      ctx.beginPath();
      if (outflow) { ctx.moveTo(cx, dy + 9); ctx.lineTo(cx - 5, dy); ctx.lineTo(cx + 5, dy); }
      else { ctx.moveTo(cx, dy); ctx.lineTo(cx - 5, dy + 9); ctx.lineTo(cx + 5, dy + 9); }
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.font = `700 ${fs}px ${cjk}`;
    ctx.fillStyle = ink3;
    ctx.textBaseline = 'top';
    ctx.fillText(dp.label, cx, wy + wh + 34);
    ctx.font = `700 ${fs + 1}px ${mono}`;
    ctx.fillStyle = outflow ? down : up;
    ctx.fillText((outflow ? '-' : '+') + int(Math.abs(dp.cum + dp.v * A4.drip)), cx, wy + wh + 48);
  });
  ctx.restore();

  ctx.save();
  ctx.font = `700 ${fs}px ${cjk}`;
  ctx.fillStyle = ink2;
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText('股價', barCx, base + 18);
  ctx.fillText('錢包', walletCx, base + 18);
  ctx.restore();
}

/* ---- 一次除息的時間軸：切 → 飛 → 滴 → 填 ----
   這一段刻意不用 EASE：'paper' 是紙落定用的前重尾長曲線，套在飛行上會一瞬間就到位，
   使用者根本看不見「錢從左手到右手」這件事。飛行要等速一點才讀得出來。 */
const tl = gsap.timeline({ paused: true, onUpdate: drawStage, onComplete: onStepDone });
tl.fromTo(A4, { cut: 0 }, { cut: 1, duration: 0.30, ease: 'none' }, 0)
  .fromTo(A4, { fly: 0 }, { fly: 1, duration: 0.70, ease: 'power1.inOut' }, 0.28)
  .fromTo(A4, { drip: 0 }, { drip: 1, duration: 0.55, ease: 'power1.in' }, 0.86)
  .fromTo(A4, { fill: 0 }, { fill: 1, duration: 0.66, ease: EASE }, 1.02);

let cursor = 0;
let playing = false;
let RES = null;
let pendingTimer = 0;

function loadStep(n) {
  if (!RES || !RES.rows.length) return;
  const r = RES.rows[clamp(n, 1, RES.rows.length) - 1];
  let cumNet = 0; let cumTax = 0; let cumNhi = 0;
  for (let i = 0; i < n - 1; i++) {
    cumNet += RES.rows[i].net; cumTax += RES.rows[i].tax; cumNhi += RES.rows[i].nhi;
  }
  Object.assign(STAGE, {
    before: r.before, D: r.D, ex: r.ex, after: r.after, target: r.ex + r.D,
    gross: r.gross, nhi: r.nhi, tax: r.tax, net: r.net,
    cumNet, cumTax, cumNhi, idx: n, total: RES.rows.length,
  });
}

function setRest() { A4.cut = 1; A4.fly = 1; A4.drip = 1; A4.fill = 1; }

function runStep(n) {
  loadStep(n);
  updateStageText();
  paintRace();
  if (still()) {
    setRest(); drawStage();
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(onStepDone, 120);
  } else {
    tl.restart();
  }
}

function onStepDone() {
  if (!playing) return;
  if (cursor >= (RES?.rows.length || 0)) { setPlaying(false); return; }
  cursor += 1;
  runStep(cursor);
}

function setPlaying(v) {
  playing = v;
  $('#tPlay').textContent = v ? '暫停' : '播放';
  if (!v) { clearTimeout(pendingTimer); tl.pause(); }
}

function gotoCursor(n, { animate = false } = {}) {
  cursor = clamp(n, 0, RES?.rows.length || 0);
  if (cursor === 0) {
    tl.pause();
    A4.cut = 0; A4.fly = 0; A4.drip = 0; A4.fill = 0;
    if (RES?.rows.length) {
      const r = RES.rows[0];
      Object.assign(STAGE, {
        before: r.before, D: r.D, ex: r.ex, after: r.after, target: r.ex + r.D,
        gross: r.gross, nhi: r.nhi, tax: r.tax, net: r.net,
        cumNet: 0, cumTax: 0, cumNhi: 0, idx: 0, total: RES.rows.length,
      });
    }
    drawStage(); updateStageText(); paintRace();
    return;
  }
  if (animate) { runStep(cursor); return; }
  tl.pause();
  loadStep(cursor); setRest(); drawStage(); updateStageText(); paintRace();
}

function updateStageText() {
  const s = exInput();
  $('#stageCounter').textContent = `第 ${STAGE.idx}／${STAGE.total} 次`;
  const g = STAGE.idx === 0
    ? '目前停在起點，還沒除息。按「單步除息」看一次完整過程。'
    : `第 ${STAGE.idx} 次除息：除息前 ${dec(STAGE.before, 2)} 元，每股配 ${dec(STAGE.D, 3)} 元，`
      + `除息參考價 ${dec(STAGE.ex, 2)} 元；填息 ${pct(s.fill, 0)} 後回到 ${dec(STAGE.after, 2)} 元，`
      + `離完全填息的 ${dec(STAGE.target, 2)} 元還差 ${dec(STAGE.target - STAGE.after, 2)} 元。`
      + `這一次毛配息 ${int(STAGE.gross)} 元，扣掉綜所稅 ${int(Math.round(STAGE.tax))} 元`
      + `與補充保費 ${int(Math.round(STAGE.nhi))} 元，淨入帳 ${int(Math.round(STAGE.net))} 元。`;
  $('#stageDesc').textContent = g + '（配息很小時，切下來的那一塊會以最小可見厚度繪製，數字以文字為準。）';
  stageCv.setAttribute('aria-label', g);
}

/* ---------- 賽跑圖與敏感曲線 ---------- */
const yFmt = (v) => (Math.abs(v) >= 1e8 ? (v / 1e8).toFixed(2) + '億'
  : Math.abs(v) >= 1e4 ? (v / 1e4).toFixed(Math.abs(v) >= 1e5 ? 0 : 1) + '萬'
    : String(Math.round(v)));

const race = new Plot($('#race'), {
  aspect: 0.52, yFormat: yFmt, xFormat: (v) => Math.round(v) + '年',
  padding: { left: 54, bottom: 28, top: 16, right: 14 },
});
const sense = new Plot($('#sense'), {
  aspect: 0.38, yFormat: yFmt, xFormat: (v) => Math.round(v * 100) + '%',
  padding: { left: 54, bottom: 28, top: 14, right: 14 },
});
const EX_SERIES = [
  { key: 'A', token: '--series-1', label: '配息再投入' },
  { key: 'B', token: '--series-4', label: '配息領現金（含已領現金）' },
  { key: 'C', token: '--series-5', label: '市值型不配息' },
];

function paintRace() {
  if (!RES) return;
  const s = exInput();
  const cutX = cursor / s.freq;
  const paths = { A: RES.pathA, B: RES.pathB, C: RES.pathC };
  const series = [];
  for (const def of EX_SERIES) {
    const color = cssv(def.token);
    const all = paths[def.key];
    series.push({ type: 'line', data: all, color, width: 1.2, dash: [4, 3], alpha: 0.4, noCursor: true });
    series.push({ type: 'line', data: all.filter((p) => p.x <= cutX + 1e-9), color, width: 2.4 });
  }
  race.setSeries(series, { animate: false });
  race.setMarks(cursor > 0 && cursor < RES.rows.length
    ? [{ axis: 'x', value: cutX, color: cssv('--ink-3'), dash: [2, 3] }]
    : []);

  const desc = '橫軸是年，縱軸是總價值（市值加已領現金）。實線畫到目前的播放位置，虛線是後面還沒跑到的部分。'
    + `${s.years} 年後：配息再投入 ${yuan(RES.valueA)}（年化 ${pct(RES.cagrA, 2)}）、`
    + `配息領現金 ${yuan(RES.valueB)}（年化 ${pct(RES.cagrB, 2)}）、`
    + `市值型不配息 ${yuan(RES.valueC)}（年化 ${pct(RES.cagrC, 2)}）。`;
  $('#raceDesc').textContent = desc;
  $('#race').setAttribute('aria-label', desc);
  $('#raceLegend').replaceChildren(...EX_SERIES.map((d) => legendItem(d.label, cssv(d.token))));
}

let senseKey = '';
let sensePts = [];
function paintSense(s) {
  const key = JSON.stringify([s.price, s.lots, s.years, s.divYield, s.freq, s.qual,
    s.trend, s.bracket, s.taxMode, s.disc, s.mode]);
  if (senseKey !== key) {
    senseKey = key;
    sensePts = [];
    for (let f = 0; f <= 100; f += 4) {
      const r = project({ ...s, fill: f / 100 });
      sensePts.push({ x: f / 100, y: s.mode === 'reinvest' ? r.valueA : r.valueB });
    }
    sense.setSeries([{ type: 'area', data: sensePts, color: cssv('--series-1'), width: 2.2, fillAlpha: 0.12 }],
      { animate: false });
  }
  sense.setMarks([{ axis: 'x', value: s.fill, color: cssv('--accent'), dash: [4, 3], label: '你現在的填息率' }]);

  const v0 = sensePts[0]?.y;
  const v100 = sensePts[sensePts.length - 1]?.y;
  const desc = `橫軸是填息率 0 到 100%，縱軸是${s.mode === 'reinvest' ? '配息再投入' : '配息領現金'}組合的期末總價值。`
    + `完全不填息 ${yuan(v0)}、完全填息 ${yuan(v100)}，每多填 10 個百分點平均多 ${yuan((v100 - v0) / 10)}。`
    + `你現在填的是 ${Math.round(s.fill * 100)}%。`;
  $('#senseDesc').textContent = desc;
  $('#sense').setAttribute('aria-label', desc);
}

const cFinal = makeCounter($('#r-final'), (v) => money(Math.round(v), { compact: true }));
const cCumDiv = makeCounter($('#r-cumdiv'), (v) => money(Math.round(v), { compact: true }));
const cGain = makeCounter($('#r-gain'), (v) => money(Math.round(v), { compact: true }));
const cLeak = makeCounter($('#r-leak'), (v) => money(Math.round(v), { compact: true }));
let lastThresholdOver = null;
let exFrom = null;

function computeEx() {
  const s = exInput();
  RES = project(s);
  if (playing) setPlaying(false);   // 改了輸入就停下來，不要一邊播一邊換數字

  /* ---- 拒答：股價被配到近乎歸零，這個模型不適用 ---- */
  const collapsed = RES.endPrice < s.price * 0.05;
  $('#exRefuse').hidden = !collapsed;
  $('#raceCard').hidden = collapsed;
  $('#senseCard').hidden = collapsed;
  $('#compareCard').hidden = collapsed;
  if (collapsed) {
    $('#exRefuseBody').textContent =
      `你填的配息率 ${pp(s.divYield * 100, 1)}、填息率 ${pct(s.fill, 0)}、價格趨勢 ${pp(s.trend * 100, 1)}，`
      + `${s.years} 年後股價會掉到 ${dec(RES.endPrice, 2)} 元，只剩起始的 ${pct(RES.endPrice / s.price, 1)}。`
      + '現實中公司或 ETF 會先減配、清算或下市，這個模型不能回答這種情境，'
      + '把填息率往上拉，或把配息率調低，數字才有意義。';
  }

  cursor = clamp(cursor, 0, RES.rows.length);

  const gain = RES.valueOwn - RES.invested;
  const leak = RES.taxTotal + RES.nhiTotal + RES.feeTotal;
  cFinal(RES.valueOwn); cCumDiv(RES.grossTotal); cGain(gain); cLeak(leak);

  const cg = $('#r-cagr');
  cg.textContent = Number.isFinite(RES.cagrOwn) ? `年化 ${pct(RES.cagrOwn, 2, { sign: true })}` : '';
  cg.dataset.dir = RES.cagrOwn > 0 ? 'up' : RES.cagrOwn < 0 ? 'down' : 'flat';
  const lp = $('#r-leakpct');
  lp.textContent = RES.grossTotal > 0
    ? (leak < 0
      ? `負的：8.5% 抵減大於稅費，淨退 ${int(Math.round(-leak))} 元`
      : `佔毛配息 ${pct(leak / RES.grossTotal, 1)}`)
    : '';
  lp.dataset.dir = leak > 0 ? 'down' : leak < 0 ? 'up' : 'flat';

  const taxFee = RES.taxTotal + RES.nhiTotal;
  const diff = RES.grossTotal - gain;
  $('#exLead').innerHTML =
    `${s.years} 年下來你收到 <b>${yuan(RES.grossTotal)}</b>配息，但總價值只增加了 <b>${yuan(gain)}</b>。`
    + (diff > 0
      ? `差的那 ${int(Math.round(diff))} 元，`
        + (taxFee >= 0
          ? `一部分是稅與補充保費（${int(Math.round(taxFee))} 元），其餘是沒有填回來的價格缺口。`
          : `全部來自沒有填回來的價格缺口：這一組設定下稅與補充保費合計是負的 ${int(Math.round(-taxFee))} 元，`
            + '也就是 8.5% 可抵減稅額還大於這筆股利造成的稅。')
        + '除息當天你的總資產一塊都沒變，真正決定結果的是填息與含息總報酬，不是配息金額。'
      : `這一組假設下總價值增加得比配息還多，因為除息以外的價格趨勢（${pp(s.trend * 100, 2)}）也在貢獻。`
        + '配息與報酬本來就是兩件事，這裡剛好是往上的那一面。');

  if (!collapsed) { paintSense(s); renderExCompare(s); }
  gotoCursor(cursor);
  renderThreshold(s);
  renderOtherSide(s);
  renderExFormula(s);
  $('#mktHint').innerHTML =
    `「同樣的獲利能力，一個配出來、一個留在股價裡」對應的市值型報酬是 <b>${dec((s.trend + s.divYield) * 100, 2)}%</b>`
    + `（趨勢 ${dec(s.trend * 100, 2)}% 加配息率 ${dec(s.divYield * 100, 2)}%）。`
    + '這只是一個假設，不是事實：兩個標的本來就可能有不同的報酬。';
  $('#lotsHint').textContent = (s.auto
    ? `依你檔案裡的全年股利 ${int(OUT.f.dividend)} 元、股價 ${dec(s.price, 2)} 元與配息率 ${dec(s.divYield * 100, 2)}% 回推，`
      + `大約是 ${s.autoLots} 張。拖動這一支會改成你自己指定的張數。`
    : `你手動指定了 ${s.lots} 張（依檔案回推是 ${s.autoLots} 張）。`)
    + `這樣的第一年配息是 ${int(s.lots * LOT * s.price * s.divYield)} 元。`
    + (s.capped ? '（回推的張數超過這支滑桿的上限 2,000 張，已經停在上限，所以配息會低於你檔案裡的金額。）' : '');

  if (exFrom) carbonTransfer($$('#p-ex [data-live]'));
  exFrom = null;
}

function renderExCompare(s) {
  const host = $('#compare');
  host.replaceChildren();
  const rows = [
    { def: EX_SERIES[0], v: RES.valueA, c: RES.cagrA },
    { def: EX_SERIES[1], v: RES.valueB, c: RES.cagrB },
    { def: EX_SERIES[2], v: RES.valueC, c: RES.cagrC },
  ];
  host.appendChild(el('div', { class: 'compare__row compare__row--head' }, [
    el('span', { class: 'compare__name', text: `投入 ${int(RES.invested)} 元，${s.years} 年後` }),
    el('span', { class: 'compare__val', text: '期末總價值' }),
    el('span', { class: 'compare__cagr', text: '年化' }),
  ]));
  rows.forEach((r) => {
    host.appendChild(el('div', { class: 'compare__row' }, [
      el('span', { class: 'compare__name' }, [
        el('span', { class: 'compare__key', style: `background:${cssv(r.def.token)}` }),
        el('span', { text: r.def.label }),
      ]),
      el('span', { class: 'compare__val', text: int(Math.round(r.v)) }),
      el('span', { class: 'compare__cagr', text: Number.isFinite(r.c) ? pct(r.c, 2) : '-' }),
    ]));
  });

  const gapAC = RES.valueA - RES.valueC;
  const note = $('#compareNote');
  if (s.fill >= 0.999) {
    note.innerHTML = '<b>填息 100% 的時候</b>，兩個數字會很接近，這不是巧合：在「同樣的獲利能力，'
      + '一個配出來、一個留在股價裡」的假設下，<b>配息本身不改變總報酬</b>。'
      + `剩下的差距來自兩股相反的力量：稅與補充保費 ${yuan(RES.taxTotal + RES.nhiTotal + RES.feeTotal)}把它往下拉；`
      + '而「在除息參考價買進、之後價格又完全填回去」等於用折價買到，把它往上推。'
      + '真正決定結果的是填息，而填息是市場給的。';
  } else {
    note.innerHTML = `把填息率拉到 100% 再看一次這三個數字。現在少掉的那 ${pct(1 - s.fill, 0)} 缺口，`
      + `${s.years} 年累積下來讓配息再投入${gapAC >= 0 ? '仍比市值型多了 ' : '比市值型少了 '}`
      + `${yuan(Math.abs(gapAC))}。這個差距是<b>你填的假設</b>造出來的，不是任何標的的實際表現。`;
  }
}

function renderThreshold(s) {
  const host = $('#thresholdNote');
  const floor = NHI.thresholds.dividend;
  const rate = NHI.rate;
  const r = RES.rows[Math.max(0, Math.min(RES.rows.length - 1, cursor - 1))] || RES.rows[0];
  if (!r) { host.textContent = ''; return; }
  const divIncome = r.gross * s.qual;
  const over = divIncome >= floor;
  const heldLots = r.held / LOT;
  const perLot = r.D * LOT * s.qual;
  const needLots = perLot > 0 ? Math.ceil(floor / perLot) : Infinity;
  const nhiAt = (lots) => nhiSupplement(lots * perLot, { rate, floor, cap: NHI.singlePaymentCap });

  host.dataset.over = String(over);
  host.innerHTML =
    `<span class="threshold__big">${int(Math.round(divIncome))} 元</span>`
    + `這一次配息中屬股利所得的部分（持股 ${dec(heldLots, 1)} 張）。門檻是 <b>${int(floor)} 元</b>，`
    + (over
      ? `已經跨過，所以<b>全額</b>乘上 ${pp(rate * 100, 2)} 等於 ${int(Math.round(r.nhi))} 元補充保費。`
        + '達門檻就是全額計費，不是只算超過的那一段，這就是門檻旁邊會出現階梯的原因。'
        + (Number.isFinite(needLots) && needLots > 1
          ? ` 這一次若只持有 <b>${needLots - 1} 張</b>就不用扣，`
            + `所以第 ${needLots - 1} 張到第 ${needLots} 張之間，補充保費從 0 元直接跳到 ${int(Math.round(nhiAt(needLots)))} 元。`
          : '')
      : '還沒跨過，這一次不用扣補充保費。'
        + (Number.isFinite(needLots)
          ? ` 加到 <b>${needLots} 張</b>就會跨過，一跨過就是全額 ${int(Math.round(nhiAt(needLots)))} 元，`
            + '多配那一點點息，代價是整筆都要扣。'
          : ''));

  if (lastThresholdOver !== null && lastThresholdOver !== over) flagCross(host);
  lastThresholdOver = over;

  const qp = Math.round(s.qual * 100);
  $('#segQual').style.width = qp + '%';
  $('#segOther').style.width = (100 - qp) + '%';
  $('#composeNote').textContent =
    `配息組成假設：${qp}% 是股利所得（要課綜所稅與補充保費）、${100 - qp}% 來自收益平準金或已實現資本利得（不課）。`
    + `第一聯用的是同一個門檻：你檔案裡的全年股利分 ${s.freq} 筆，每筆 ${int(OUT.f.dividend / s.freq)} 元。`;
}

function renderOtherSide(s) {
  const r = RES.rows[Math.max(0, Math.min(RES.rows.length - 1, cursor - 1))] || RES.rows[0];
  if (!r) return;
  const cash = r.gross - r.nhi - r.tax;
  const bearPrice = r.after * (1 - s.bear);
  const sellShares = bearPrice > 0 ? cash / bearPrice : Infinity;
  const ratio = r.held > 0 ? sellShares / r.held : NaN;
  $('#otherSideLead').textContent =
    `假設某一年股價下跌 ${pct(s.bear, 0)}，而你這一年仍然需要拿出同樣一筆生活費。`
    + '高股息的現金是配給你的，市值型的現金要自己賣股票變現，這是高股息真正站得住腳的那一面。';
  $('#o-cash').textContent = int(Math.round(cash));
  $('#o-sell').textContent = Number.isFinite(sellShares) ? int(Math.round(sellShares)) : '-';
  $('#o-pct').textContent = Number.isFinite(ratio) ? pct(ratio, 2) : '-';
  $('#otherSideNote').innerHTML =
    '但這一面也有它的樂觀假設：這裡假設<b>空頭年配息不變</b>。'
    + '實際上配息會隨成分股獲利與收益平準金餘額調整，下跌年份減配是常見的。'
    + '另一邊，市值型如果剛好不需要動用，就不必在低點賣。'
    + '兩邊都有前提，這張單子不替你選。把數字擺出來，選擇是你的。';
}

function renderExFormula(s) {
  const host = $('#exFormula');
  const open = $$('details', host).map((x) => x.open);
  host.replaceChildren();
  const r = RES.rows[Math.max(0, Math.min(RES.rows.length - 1, cursor - 1))] || RES.rows[0];
  if (!r) return;

  host.appendChild(formulaBlock('攤開看：除息參考價與填息', [
    '<b>除息參考價</b> = 前一營業日收盤價 - 現金股利（本模組不模擬配股與現金增資，所以退化成這一式）',
    `= ${dec(r.before, 2)} - ${dec(r.D, 3)} = <b>${dec(r.ex, 2)}</b>`,
    `<b>填息後價位</b> = 除息參考價 ＋ 填息率 × 現金股利 = ${dec(r.ex, 2)} ＋ ${pct(s.fill, 0)} × ${dec(r.D, 3)} = <b>${dec(r.after, 2)}</b>`,
    `<b>每股現金股利</b> = 除息前價 × (年化配息率 ÷ 一年配息筆數) = ${dec(r.before, 2)} × (${pp(s.divYield * 100, 2)} ÷ ${s.freq})`,
    `<b>配息筆數</b> ${s.freq} 筆，直接沿用你檔案裡的「一年配息筆數」，跟第一聯是同一格`,
    '<b>價格趨勢</b> 幾何分攤到每一期：(1 + 年化趨勢)<sup>1/筆數</sup> - 1，不是把年趨勢除以筆數',
  ], '除權除息參考價計算式出自臺灣證券交易所「股票除權除息參考價計算說明」。'
    + '本模組不模擬現金增資與無償配股，兩項以 0 代入。'));

  host.appendChild(formulaBlock('攤開看：這一次的稅與費', [
    `<b>屬股利所得的部分</b> = 毛配息 ${int(Math.round(r.gross))} × ${Math.round(s.qual * 100)}% = ${int(Math.round(r.gross * s.qual))} 元`,
    `<b>補充保費</b> = ${r.gross * s.qual >= NHI.thresholds.dividend
      ? `min(${int(Math.round(r.gross * s.qual))}, ${int(NHI.singlePaymentCap)}) × ${pp(NHI.rate * 100, 2)} = ${int(Math.round(r.nhi))} 元`
      : `未達 ${int(NHI.thresholds.dividend)} 元門檻，這一次為 0 元`}`,
    s.taxMode === 'separate'
      ? `<b>綜所稅（分開計稅）</b> = ${int(Math.round(r.gross * s.qual))} × ${pp(DIV().separateRate * 100, 0)} = ${int(Math.round(r.tax))} 元`
      : `<b>綜所稅（合併計稅）</b> = ${int(Math.round(r.gross * s.qual))} × 邊際稅率 ${pp(s.bracket * 100, 0)}`
        + ` - 可抵減 min(股利 × ${pp(DIV().creditRate * 100, 1)}, 該年度剩餘的 ${int(DIV().creditCapPerHousehold)} 上限) = ${int(Math.round(r.tax))} 元`,
    `　課稅方式與邊際稅率都來自第一聯的結論${S().taxChoice === 'auto' ? '（自動採用較省的那一個）' : '（你在抬頭手動指定）'}，這一聯不再問你一次`,
    s.mode === 'reinvest'
      ? `<b>再投入手續費</b> = max(${int(FEE.minFee)}, 淨入帳 × ${pp(FEE.rate * 100, 4)} × ${dec(s.disc, 2)}) = ${int(Math.round(r.fee))} 元，折數取自你的檔案`
      : '<b>手續費</b> 領現金不買回，這一聯沒有手續費',
    `<b>淨入帳</b> = ${int(Math.round(r.gross))} - ${int(Math.round(r.tax))} - ${int(Math.round(r.nhi))}`
      + `${s.mode === 'reinvest' ? ` - ${int(Math.round(r.fee))}` : ''} = <b>${int(Math.round(r.net))}</b> 元`,
    '<b>簡化之處</b> 稅款依各次配息按比例預扣（實際為隔年 5 月結算）；再投入以除息參考價買進並允許小數股；'
      + '未計入 ETF 內扣費用與賣出時的證交稅。',
  ], '股利兩制常數取自 assets/data/tw-tax.json，補充保費取自 assets/data/tw-nhi.json；'
    + '手續費常數的來源與其爭議見本頁最下方「交易成本」那一節。'));

  $$('details', host).forEach((dEl, i) => { if (open[i]) dEl.open = true; });
}

/* ==========================================================================
   8. 模組層的結論、共用參數帶與交易成本爭議
   ========================================================================== */
const cCombined = makeCounter($('#r-combined'), fmtTax);
const cSeparate = makeCounter($('#r-separate'), fmtTax);
const cTake = makeCounter($('#r-take'), (v) => int(Math.round(v)));
const cEff = makeCounter($('#r-eff'), (v) => dec(v * 100, 2) + '<small>%</small>', { html: true });

let stampedFor = null;
let lastSide = null;

function renderStrip() {
  const f = OUT.f;
  const per = f.dividend / f.payouts;
  $('#sTax').textContent = OUT.taxMode === 'separate' ? '分開計稅 28%' : '合併計稅 8.5% 抵減';
  $('#sRate').textContent = pp(OUT.marginal * 100, 0);
  $('#sPer').textContent = int(Math.round(per)) + ' 元';
  $('#sDisc').textContent = dec(f.disc * 10, 1).replace(/\.0$/, '') + ' 折';
  $('#stripHint').textContent =
    `每筆配息 ${int(Math.round(per))} 元${per >= NHI.thresholds.dividend ? '已跨過' : '還沒跨過'}`
    + ` 2 萬元的補充保費門檻（全年 ${int(f.dividend)} 元分 ${f.payouts} 筆）。`
    + '這四格算一次，第一聯、第二聯、第三聯都吃同一組，不會再問你第二次。';
}

function renderVerdict() {
  const f = OUT.f; const ev = OUT.ev;
  const h = $('#verdict-h');
  const body = $('#verdictBody');
  const stamp = $('#verdictStamp');
  const side = OUT.side;
  const gaps = exampleKeys();

  cCombined(ev.combined);
  cSeparate(ev.separate);

  const nhiTotal = OUT.nhi.total;
  const take = f.dividend - OUT.dividendTax - nhiTotal;
  cTake(take);
  cEff(f.dividend > 0 ? (OUT.dividendTax + nhiTotal) / f.dividend : 0);
  const refund = OUT.dividendTax < -0.5;
  $('#r-takeNote').textContent = f.dividend > 0
    ? (refund
      ? `毛額 ${int(f.dividend)} 元，這筆股利讓你退稅 ${int(Math.round(-OUT.dividendTax))}，再扣保費 ${int(Math.round(nhiTotal))}`
      : `毛額 ${int(f.dividend)} 元扣掉稅 ${int(Math.round(OUT.dividendTax))} 與保費 ${int(Math.round(nhiTotal))}`)
    : '';
  $('#r-effNote').textContent = refund && take > f.dividend
    ? '負值代表抵減大於稅'
    : nhiTotal > 0 ? '含補充保費' : '補充保費為 0';

  if (f.dividend <= 0) {
    h.textContent = '沒有股利，就沒有兩制可選。';
    body.textContent = `這一戶的其他所得淨額是 ${int(Math.round(OUT.active.netOther))} 元，`
      + `應納稅額 ${int(Math.round(ev.baseline))} 元。把股利填上去，這三聯才會長出來。`;
  } else {
    const better = side === 'separate' ? '分開計稅' : '合併計稅';
    const saved = Math.abs(OUT.diff);
    h.innerHTML = side === 'tie'
      ? '兩制算出來一模一樣，勾哪一個都可以。'
      : `五月那一格勾「<em>${better}</em>」，一年少繳 <em>${int(Math.round(saved))}</em> 元。`;

    const parts = [];
    const gapD = Number.isFinite(OUT.flipD) ? OUT.flipD - f.dividend : Infinity;
    if (Number.isFinite(gapD) && gapD > 0) {
      parts.push(`你離翻轉點還有 ${wan(gapD)}股利：全年股利加到 ${wan(OUT.flipD)}就會換邊。`);
    } else if (Number.isFinite(gapD) && gapD < 0) {
      parts.push(`股利要降到 ${wan(OUT.flipD)}以下才會換回合併計稅，也就是少領 ${wan(-gapD)}。`);
    } else {
      parts.push('在這個其他所得水準下，股利再怎麼加都不會換邊。');
    }
    parts.push(OUT.dividendTax < -0.5
      ? `這筆股利不但沒有讓你多繳稅，8.5% 可抵減稅額還超過它造成的稅，整戶退稅 ${int(Math.round(-OUT.dividendTax))} 元；`
        + `扣掉補充保費 ${int(Math.round(nhiTotal))} 元之後，這筆股利實際帶給你 ${int(Math.round(take))} 元，比毛額還多。`
      : `扣掉稅 ${int(Math.round(OUT.dividendTax))} 元與補充保費 ${int(Math.round(nhiTotal))} 元之後，`
        + `這筆股利真正剩下 ${int(Math.round(take))} 元。`);
    if (f.dividend > kinkD()) {
      parts.push(`你的股利超過 ${wan(kinkD())}，8.5% 抵減卡在 8 萬元不再增加，多領的部分抵減率等於 0。`);
    }
    if (OUT.nhi.edge > 0) {
      parts.push(`另外有 ${OUT.nhi.edge} 筆配息就卡在 2 萬元門檻附近，差一點點就決定要不要被扣 2.11%。`);
    }
    if (OUT.active.method !== 'all') parts.push(`目前採用的夫妻計稅方式是「${OUT.active.label}」。`);
    if (S().taxChoice !== 'auto' && S().taxChoice !== (side === 'separate' ? 'separate' : 'combined')) {
      parts.push('注意：你在上面手動指定了另一種課稅方式，第二聯與第三聯用的是你指定的那一個，不是這裡算出來比較省的那一個。');
    }
    if (gaps.length) {
      parts.push(`這組數字裡還有 ${gaps.length} 格是範例值（${gaps.map((k) => P.FIELDS[k].label).join('、')}），填上去才是你自己的答案。`);
    }
    body.textContent = parts.join('');
  }

  stamp.hidden = false;
  const key = `${side}:${S().year}:${f.dividend <= 0 ? 'zero' : 'x'}:${gaps.length ? 'demo' : 'real'}`;
  if (stampedFor !== key) {
    const label = f.dividend <= 0 ? '無股利'
      : side === 'tie' ? '兩案同額'
        : side === 'separate' ? '分開計稅' : '合併計稅';
    const cls = (f.dividend <= 0 || side === 'tie') ? 'stamp stamp--void' : 'stamp';
    stamp.innerHTML = `<span class="${cls}">${label}</span>`;
    stampIn(stamp.firstElementChild);
    stampedFor = key;
    // 招牌動效：真的換邊了才播一次，其他時候保持安靜
    if (lastSide && lastSide !== side && f.dividend > 0) {
      const card = $('#verdict');
      if (flagCross(card)) {
        clearTimeout(window.__crossT);
        window.__crossT = setTimeout(() => { card.style.backgroundColor = ''; }, 1000);
      }
      toast(side === 'separate' ? '你剛剛換邊了：現在分開計稅比較省' : '你剛剛換邊了：現在合併計稅比較省');
    }
  }
  lastSide = side;

  $('#profileNote').textContent = gaps.length === MODULE_NEED.length
    ? '你還沒填過檔案，下面是一組範例數字'
    : gaps.length
      ? `這些數字用的是你在首頁填過的資料，還有 ${gaps.length} 格是範例值`
      : '這些數字用的是你在首頁填過的資料';
}

/* ---------- 交易成本：兩份既有資料互相矛盾，所以兩邊都列 ---------- */
function renderFeeCard() {
  const host = $('#feeHost');
  const open = $$('details', host).map((x) => x.open);
  host.replaceChildren();
  $('#feeChip').textContent = FEE.conflict ? '未查證：兩份資料衝突' : '已查證';
  $('#feeChip').classList.toggle('chip--on', !FEE.conflict);

  host.appendChild(el('p', {
    class: 'state__body',
    style: 'max-width:var(--measure);margin-bottom:var(--s-4)',
    text: FEE.conflict
      ? '本站既有的兩份常數檔對同一件事給出互相衝突的認定，而且兩邊都自我宣稱已查證。'
        + '本模組不替你選一邊：兩種說法原文並列，狀態一律降級為未查證。'
        + '兩邊對「數值」是一致的（費率 0.1425%、單筆最低 20 元），衝突的是它的法律地位，'
        + '所以下面三聯的計算不受影響，受影響的是你能不能把它當成不可協商的下限。'
      : '兩份常數檔的認定一致。',
  }));

  for (const g of FEE.groups) {
    host.appendChild(el('h3', { class: 'plot__title', style: 'margin:var(--s-4) 0 var(--s-2)', text: g.title }));
    const claims = el('div', { class: 'claims' });
    for (const c of g.claims) {
      claims.appendChild(el('div', { class: 'claim' }, [
        el('span', { class: 'claim__who', text: c.who }),
        el('span', { class: 'claim__what', text: c.what }),
        el('p', { class: 'claim__why' }, [
          document.createTextNode(c.why + '（該檔自評：' + c.confidence + '）'),
          c.url ? document.createTextNode('　') : null,
          c.url ? el('a', { href: c.url, target: '_blank', rel: 'noopener', text: '出處' }) : null,
        ]),
      ]));
    }
    host.appendChild(claims);
    host.appendChild(el('p', { class: 'note note--warn', text: g.verdict }));
  }

  host.appendChild(formulaBlock('攤開看：這三聯實際用了哪些數字', [
    `<b>手續費率</b> ${pp(FEE.rate * 100, 4)}（買賣雙向各收一次）`,
    `<b>單筆最低手續費</b> ${int(FEE.minFee)} 元`,
    `<b>折數</b> ${dec((OUT.f ? OUT.f.disc : 0.6) * 10, 1).replace(/\.0$/, '')} 折，來自你檔案裡的「券商手續費折數」`,
    `<b>賣出證交稅</b> ${pp(FEE.stt * 100, 1)}（股票型 ETF；個股為 ${pp(FEE.sttStock * 100, 1)}）`,
    '<b>實際手續費</b> = max(單筆最低, 成交金額 × 費率 × 折數)，四捨五入到元',
    '無論 1.425‰ 是法定上限還是牌告基準，各券商都可以折讓，所以你實際付的一律是折讓後的金額。'
      + '這也是為什麼折數這一格值得填正確，而它的法律地位反而不影響你的錢。',
  ], `這些常數目前暫存在既有工具的 rules.json（apps/etf-lottery 與 apps/ex-dividend），
      還沒有進 assets/data。本模組直接讀那兩份檔案並比對，不複製一份到自己的資料夾。詳見 NEEDS.md。`));

  $$('details', host).forEach((dEl, i) => { if (open[i]) dEl.open = true; });
}

function buildFee(a, b) {
  const tr = a?.trading || {};
  const mk = b?.market || {};
  const claimRateA = tr.feeRateMax;
  const claimRateB = mk.brokerFeeRate;
  const claimMinA = tr.feeMin;
  const claimMinB = mk.brokerFeeMin;
  const conf = (o) => (o?.confidence === 'verified' ? '已查證' : o?.confidence === 'probable' ? '高度可能' : '未查證');

  const groups = [];
  if (claimRateA && claimRateB) {
    groups.push({
      title: '爭點一：1.425‰ 是法定上限，還是牌告基準費率？',
      claims: [
        {
          who: 'apps/etf-lottery/rules.json　trading.feeRateMax',
          what: claimRateA.labelZh || '',
          why: claimRateA.legalBasis || '',
          confidence: conf(claimRateA),
          url: claimRateA.sourceUrl,
        },
        {
          who: 'apps/ex-dividend/rules.json　market.brokerFeeRate',
          what: claimRateB.label || '',
          why: claimRateB.legalBasis || '',
          confidence: conf(claimRateB),
          url: claimRateB.sourceUrl,
        },
      ],
      verdict: '一邊說它是證交所費率標準訂的「上限」，一邊說金管會 97 年函釋開放後它已經不是法定上限、'
        + '而是牌告基準。兩邊都標已查證，但引的是不同層級的文件，而且本站沒有拿到函釋原文。'
        + '在拿到權威來源之前，本模組把這一項標為未查證，兩種說法都保留。'
        + '無論哪一種說法成立，數值都是 0.1425%，計算結果不變。',
    });
  }
  if (claimMinA && claimMinB) {
    groups.push({
      title: '爭點二：單筆最低 20 元有沒有法源？',
      claims: [
        {
          who: 'apps/etf-lottery/rules.json　trading.feeMin',
          what: claimMinA.labelZh || '',
          why: claimMinA.legalBasis || '',
          confidence: conf(claimMinA),
          url: claimMinA.sourceUrl,
        },
        {
          who: 'apps/ex-dividend/rules.json　market.brokerFeeMin',
          what: claimMinB.label || '',
          why: claimMinB.legalBasis || '',
          confidence: conf(claimMinB),
          url: claimMinB.sourceUrl,
        },
      ],
      verdict: '一邊寫「無法源，是券商普遍慣例」並自評未查證，一邊引證交所規章資料庫並自評已查證。'
        + '兩者連自評的把握度都相反。本模組同樣標為未查證：20 元是本模組的預設值，'
        + '不是你一定要付的金額，電子下單與定期定額另有 1 元甚至 0 元的方案。',
    });
  }

  const conflict = groups.length > 0
    && (claimRateA?.confidence === 'verified' && claimRateB?.confidence === 'verified'
      || claimMinA?.confidence !== claimMinB?.confidence);

  return {
    rate: claimRateA?.value ?? claimRateB?.value ?? 0.001425,
    minFee: claimMinA?.value ?? claimMinB?.value ?? 20,
    stt: tr.sttEtf?.value ?? 0.001,
    sttStock: tr.sttStock?.value ?? 0.003,
    groups,
    conflict,
  };
}

/* ==========================================================================
   9. 輸入元件
   ========================================================================== */
const dirty = { etf: true, ex: true };

function recompute({ from, panelOnly } = {}) {
  if (!dataOK) return;
  computeTax();
  renderStrip();
  renderVerdict();
  renderFeeCard();
  const tab = S().tab;
  if (!panelOnly || panelOnly === 'p-map') {
    if (tab === 'p-map') renderMapPanel();
  }
  if (tab === 'p-etf') { etfFrom = from; computeEtf(); dirty.etf = false; } else { dirty.etf = true; }
  if (tab === 'p-ex') { exFrom = from; computeEx(); dirty.ex = false; } else { dirty.ex = true; }
  if (from) carbonTransfer($$('#readouts [data-live]'));
}

/* ---------- 抬頭：只問缺的那幾格 ---------- */
const moduleAsk = askBox(MODULE_NEED, {
  title: '這五格解鎖這一頁全部三段的計算',
  compact: true,
});
$('#askHost').appendChild(moduleAsk.el);

const mapAsk = askBox(MAP_NEED, {
  title: '再兩格，課稅地圖的縱軸就精確了',
  compact: true,
});
$('#mapAsk').appendChild(mapAsk.el);

const etfAsk = askBox(COST_NEED, {
  title: '成本要算對，只差這一格',
  compact: true,
});
$('#etfAsk').appendChild(etfAsk.el);

/* ---------- 抬頭：課稅方式 ---------- */
const segTaxChoice = bindSegmented($('#seg-taxmode'), {
  onChange: (v) => { store.set({ taxChoice: v }); recompute({ from: 'tax' }); },
});

/* ---------- 第一聯 ---------- */
const segYear = bindSegmented($('#seg-year'), {
  onChange: (v) => { store.set({ year: v }); recompute({ from: 'year' }); updateBadge(); },
});

const sDividend = bindSlider($('#s-dividend'), {
  format: (v) => `${wanNum(v)}<small>萬</small>`,
  onInput: (v) => { P.set({ annualDividend: v }, { silent: true }); recompute({ from: 'dividend' }); },
});

/* ---------- 第二聯 ---------- */
function renderTickerList() {
  const host = $('#tickerList');
  host.replaceChildren();
  const sel = S().tickers;
  TICKERS.forEach((t, idx) => {
    const on = sel.includes(t.id);
    const my = maxYears(t);
    const label = t.broken ? '資料異常'
      : (my <= 0 ? '樣本不足' : `${t.months[0].ym.replace('-', '/')} 起・最長 ${my} 年`);
    host.appendChild(el('label', {
      class: 'tk',
      dataset: { short: my < 5 || t.broken ? '1' : '0' },
    }, [
      el('input', {
        type: 'checkbox', checked: on, disabled: !!t.broken,
        onchange: (ev) => {
          const cur = S().tickers;
          store.set({ tickers: ev.target.checked ? [...cur, t.id] : cur.filter((x) => x !== t.id) });
          renderTickerList();
          etfFrom = 'ticker';
          computeEtf();
        },
      }),
      el('span', { class: 'tk__box' }),
      el('span', { class: 'tk__key', style: `background:${on ? cssv(SERIES_VARS[idx % 5]) : 'var(--rule)'}` }),
      el('span', { class: 'tk__id', text: t.id }),
      el('span', { class: 'tk__name', text: t.name }),
      el('span', { class: 'tk__span', text: label }),
    ]));
  });
}

const sYears = bindSlider($('#s-years'), {
  format: (v) => `${v}<small>年</small>`,
  onInput: (v) => { store.set({ years: v }); etfFrom = 'years'; computeEtf(); },
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
    store.set(S().etfMode === 'dca' ? { monthly: v } : { amount: v });
    etfFrom = 'cost';
    computeEtf();
  },
});

const segEtfMode = bindSegmented($('#seg-mode'), {
  onChange: (v) => {
    store.set({ etfMode: v });
    $('#l-amount').textContent = v === 'dca' ? '每月扣款金額' : '單筆金額';
    $('#h-amount').textContent = v === 'dca'
      ? '每月扣款愈小，最低手續費的侵蝕愈兇，成本瀑布會把這件事放大給你看。'
      : '金額只影響最低手續費的侵蝕程度與絕對金額，不影響報酬率的形狀。';
    fAmount.set(v === 'dca' ? S().monthly : S().amount, { silent: true });
    etfFrom = 'cost';
    computeEtf();
  },
});

const segDiv = bindSegmented($('#seg-div'), {
  onChange: (v) => { store.set({ divMode: v }); etfFrom = 'div'; computeEtf(); },
});

/* ---------- 第三聯 ---------- */
const exSlide = (key, from) => (v) => { store.set({ [key]: v }); exFrom = from; computeEx(); };
const sFill = bindSlider($('#s-fill'), { format: (v) => `${v}<small>%</small>`, onInput: exSlide('fill', 'fill') });
const sQual = bindSlider($('#s-qual'), { format: (v) => `${v}<small>%</small>`, onInput: exSlide('qual', 'qual') });
const sBear = bindSlider($('#s-bear'), { format: (v) => `${v}<small>%</small>`, onInput: exSlide('bear', 'bear') });
const sExYears = bindSlider($('#s-exyears'), { format: (v) => `${v}<small>年</small>`, onInput: exSlide('exYears', 'years') });
const sLots = bindSlider($('#s-lots'), {
  format: (v) => `${v}<small>張</small>`,
  onInput: (v, source) => {
    if (source === 'set') return;
    store.set({ lots: v });
    exFrom = 'lots';
    computeEx();
  },
});

const fPrice = bindField($('#f-price'), {
  validate: (v) => (!Number.isFinite(v) || v <= 0 ? '請填入大於 0 的股價' : v > 10000 ? '超出試算範圍' : null),
  onChange: (v, { valid }) => { if (valid) { store.set({ price: v }); exFrom = 'price'; syncLots(); computeEx(); } },
});
const fYield = bindField($('#f-yield'), {
  validate: (v) => (!Number.isFinite(v) || v < 0 ? '請填入 0 以上的數字'
    : v > 40 ? '年化配息率超過 40% 已不是可持續的假設' : null),
  onChange: (v, { valid }) => { if (valid) { store.set({ divYield: v }); exFrom = 'yield'; syncLots(); computeEx(); } },
});
const fTrend = bindField($('#f-trend'), {
  validate: (v) => (!Number.isFinite(v) ? '請填入數字' : v < -30 || v > 30 ? '請填 -30% 到 30% 之間' : null),
  onChange: (v, { valid }) => { if (valid) { store.set({ trend: v }); exFrom = 'trend'; computeEx(); } },
});
const fMkt = bindField($('#f-mkt'), {
  validate: (v) => (!Number.isFinite(v) ? '請填入數字' : v < -30 || v > 30 ? '請填 -30% 到 30% 之間' : null),
  onChange: (v, { valid }) => { if (valid) { store.set({ mkt: v }); exFrom = 'mkt'; computeEx(); } },
});
const segExMode = bindSegmented($('#seg-exmode'), {
  onChange: (v) => { store.set({ exMode: v }); exFrom = 'mode'; computeEx(); },
});

/** 張數回到「依檔案回推」 */
function syncLots() {
  if (S().lots > 0) return;
  const s = exInput();
  sLots.set(s.autoLots, { silent: true });
}

$('#lotsSync').addEventListener('click', () => {
  store.set({ lots: 0 });
  const s = exInput();
  sLots.set(s.autoLots, { silent: true });
  exFrom = 'lots';
  computeEx();
  toast('張數已回到用你檔案裡的股利金額回推的結果');
});

$('#tRewind').addEventListener('click', () => { setPlaying(false); gotoCursor(0); });
$('#tPrev').addEventListener('click', () => { setPlaying(false); gotoCursor(cursor - 1); });
$('#tNext').addEventListener('click', () => {
  setPlaying(false);
  if (cursor >= (RES?.rows.length || 0)) { toast('已經是最後一次配息了'); return; }
  gotoCursor(cursor + 1, { animate: true });
});
$('#tPlay').addEventListener('click', () => {
  if (playing) { setPlaying(false); return; }
  if (cursor >= (RES?.rows.length || 0)) gotoCursor(0);
  setPlaying(true);
  cursor += 1;
  runStep(cursor);
});

/* ==========================================================================
   10. 三聯切換
   ========================================================================== */
const TABS = $$('#tabs .ply');
function activate(panelId, { focus = false } = {}) {
  store.set({ tab: panelId });
  TABS.forEach((b) => {
    const on = b.dataset.panel === panelId;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    $('#' + b.dataset.panel).hidden = !on;
    if (on && focus) b.focus();
  });
  if (panelId === 'p-map') { map.resize(); marginPlot.resize(); renderMapPanel(); }
  if (panelId === 'p-etf') {
    distPlot.resize(); costPlot.resize();
    if (dirty.etf) { computeEtf(); dirty.etf = false; }
  }
  if (panelId === 'p-ex') {
    resizeStage(); race.resize(); sense.resize();
    if (dirty.ex) { computeEx(); dirty.ex = false; } else { drawStage(); }
  }
}
TABS.forEach((b, i) => {
  b.addEventListener('click', () => activate(b.dataset.panel));
  b.addEventListener('keydown', (e) => {
    const k = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!k) return;
    e.preventDefault();
    activate(TABS[(i + k + TABS.length) % TABS.length].dataset.panel, { focus: true });
  });
});

/* ==========================================================================
   11. 徽章與同步
   ========================================================================== */
function updateBadge() {
  const y = YR();
  const badge = $('#dataver');
  badge.textContent = dataOK
    ? `資料版本 ${TAX.version}．適用 ${S().year} 年度`
    : '資料版本 載入失敗';
  badge.title = dataOK
    ? [`綜所稅常數 ${TAX.version}（查證日 ${TAX.verifiedAt}）`,
      `二代健保常數 ${NHI.version}（查證日 ${NHI.verifiedAt}）`,
      `市場資料建置日 ${MARKET.builtAt}，可回溯下限 ${MARKET.dataFloor}`,
      `適用 ${y.label}`].join('\n')
    : 'assets/data 底下的常數檔載入失敗';
  $('#yearHint').textContent =
    '切換年度會同時換掉免稅額、扣除額、級距與累進差額，不是只換級距。'
    + `${y.label}：免稅額 ${int(y.exemption)}、標準扣除額 ${int(y.standardSingle)}／有配偶 ${int(y.standardMarried)}、`
    + `薪資特扣上限 ${int(y.salaryDeduction)}。`
    + (y.basicLivingExpense
      ? `每人基本生活費 ${int(y.basicLivingExpense)}。`
      : '每人基本生活費尚未公告，本年度不計入基本生活費差額。');
}

function syncInputs() {
  const s = S();
  const f = facts();
  segTaxChoice.set(s.taxChoice);
  segYear.set(s.year);

  // 股利可能大於滑桿預設上限，先把軌道撐開再寫值
  const range = $('#s-dividend input[type="range"]');
  const need = niceUp(Math.max(3000000, f.dividend * 1.25));
  if (Number(range.max) !== need) range.max = String(need);
  sDividend.set(f.dividend, { silent: true });

  renderTickerList();
  sYears.set(s.years, { silent: true });
  segEtfMode.set(s.etfMode);
  segDiv.set(s.divMode);
  $('#l-amount').textContent = s.etfMode === 'dca' ? '每月扣款金額' : '單筆金額';
  fAmount.set(s.etfMode === 'dca' ? s.monthly : s.amount, { silent: true });

  sFill.set(s.fill, { silent: true });
  sQual.set(s.qual, { silent: true });
  sBear.set(s.bear, { silent: true });
  sExYears.set(s.exYears, { silent: true });
  fPrice.set(s.price, { silent: true });
  fYield.set(s.divYield, { silent: true });
  fTrend.set(s.trend, { silent: true });
  fMkt.set(s.mkt, { silent: true });
  segExMode.set(s.exMode);
  sLots.set(exInput().lots, { silent: true });

  $('#etfTaxHint').textContent =
    `股利稅與手續費不在這裡問：課稅方式（${OUT?.taxMode === 'separate' ? '分開 28%' : '合併'}）`
    + '與邊際稅率由第一聯算出來，折數來自你的檔案，都在頁面最上方那條參數帶裡。';
  $('#exTaxHint').textContent =
    '配息頻率直接用你檔案裡的「一年配息筆數」，課稅方式與邊際稅率沿用第一聯的結論，'
    + '所以這一聯不會再問你一次。';
}

/* ==========================================================================
   12. 啟動
   ========================================================================== */
const grab = async (p) => {
  try { const r = await fetch(p); return r.ok ? await r.json() : null; } catch { return null; }
};

async function boot() {
  const actions = $('#sheetActions');
  // 分享時同時帶上財務檔案與這一次的情境，收到連結的人看到的是同一組數字
  mountShare(actions, {
    shareUrl() {
      const u = new URL(P.shareUrl(location.href));
      u.searchParams.set('s', new URL(store.shareUrl()).searchParams.get('s'));
      return u.toString();
    },
  }, '複製這張單子的連結');
  mountTheme(actions);

  const [tax, nhi, idx, ruleA, ruleB] = await Promise.all([
    grab('../../assets/data/tw-tax.json'),
    grab('../../assets/data/tw-nhi.json'),
    grab('../../assets/data/market/index.json'),
    grab('../etf-lottery/rules.json'),
    grab('../ex-dividend/rules.json'),
  ]);

  if (!tax || !nhi) {
    $('#verdict-h').textContent = '讀不到法規常數';
    $('#verdictBody').textContent =
      'assets/data/tw-tax.json 或 tw-nhi.json 載入失敗。本模組不在程式碼裡寫死稅率與費率，'
      + '所以拿不到常數檔就不算，也不給你一個看起來很像答案的數字。';
    $('#dataver').textContent = '資料版本 讀取失敗';
    return;
  }
  TAX = tax;
  NHI = nhi;
  FEE = buildFee(ruleA, ruleB);
  if (!store.cameFromLink && !$$('#seg-year .segmented__opt').some((b) => b.dataset.value === S().year)) {
    store.set({ year: String(TAX.defaultYear) }, { silent: true });
  }

  if (idx) {
    MARKET = idx;
    const files = await Promise.all(
      idx.tickers.map((m) => grab(`../../assets/data/market/${m.id}.json`)),
    );
    files.forEach((raw) => { if (raw) TICKERS.push(buildTicker(raw)); });
    const valid = TICKERS.filter((t) => !t.broken).map((t) => t.id);
    const picked = S().tickers.filter((id) => valid.includes(id));
    store.set({ tickers: picked.length ? picked : valid.slice(0, 2) }, { silent: true });
  } else {
    MARKET = { builtAt: '讀取失敗', dataFloor: '-', tickers: [] };
  }

  dataOK = true;
  computeTax();
  syncInputs();
  updateBadge();
  renderFeeCard();

  if (!TICKERS.length) {
    $('#etfLead').textContent = '讀不到離線建置的還原權息序列，這一聯沒有東西可以算。'
      + '請確認 assets/data/market/ 底下的檔案存在。';
    $('#distCard').hidden = true;
    $('#sampleCard').hidden = true;
    $('#tableCard').hidden = true;
    $('#costCard').hidden = true;
  }

  activate(TABS.some((b) => b.dataset.panel === S().tab) ? S().tab : 'p-map');
  recompute();

  // 使用者在任何一格填寫盒改了檔案，三聯一起跟著變
  P.subscribe(() => {
    moduleAsk.refresh();
    mapAsk.refresh();
    etfAsk.refresh();
    syncLots();
    recompute({ from: 'profile' });
  });

  // 進階減除項：同一份檔案的欄位，不是這一頁專屬的表單
  const fine = $('#fineHost');
  for (const k of FINE_KEYS) fine.appendChild(fieldControl(k, { compact: true }));

  // 首次進場：結果逐行推出，讓人感覺數字是被算出來的
  printRows($$('#readouts .readout'), { stagger: 0.05, delay: 0.1 });

  // Plot 與地圖只監聽系統色彩偏好，手動按夜間鈕（改 data-theme）不會重畫畫布上的顏色
  new MutationObserver(() => {
    map.render(); marginPlot.render(); distPlot.render();
    costPlot.render(); race.render(); sense.render(); drawStage();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  window.addEventListener('resize', () => {
    clearTimeout(window.__rz);
    window.__rz = setTimeout(() => { map.resize(); resizeStage(); }, 180);
  });

  if (store.cameFromLink) toast('已載入別人傳給你的情境');
  window.__ready = true;
}

boot();
