/* 借款：房貸懸崖模擬器 + 買房預算天花板壓力測試，合併成一頁兩段。

   合併的判準不是把兩頁接在一起，而是：
   1. 收入、生活支出、自備款、無擔保負債、名下房屋數、房貸利率只存在一個地方
      （assets/js/core/profile.js），兩段都從那裡拿，使用者不會被問第二次。
   2. 缺什麼才問什麼：模組層只問兩段都要用的那一格，各段只問自己缺的那幾格。
   3. 兩個招牌視覺都留著：月現金流瀑布（含三個壓力鈕與量表）、月付金時間軸上的斷崖。
   4. 誠信核心留著：DBR 22 倍規範的是無擔保債務，房貸不在其中。
*/

window.addEventListener('error', (e) => { window.__err = String(e.message); });

import { printRows, stampIn, makeCounter, carbonTransfer, still, gsap } from '../../assets/js/core/motion.js';
import { Plot, niceTicks } from '../../assets/js/core/plot.js';
import { amortize, pmt, principalFromPmt } from '../../assets/js/core/fin.js';
import { createStore } from '../../assets/js/core/state.js';
import {
  $, $$, el, iconHTML, bindSlider, bindField, bindSegmented, createPlies,
  mountTopbar, mountTheme, toast, virtualTable, formulaBlock, createTip,
} from '../../assets/js/core/ui.js';
import { int, dec, money, pct, pp, codes, months as fmtMonths, parseNum, clamp } from '../../assets/js/core/format.js';
import * as P from '../../assets/js/core/profile.js';
import { askBox, fieldControl } from '../../assets/js/core/profile-ui.js';

/* ==========================================================================
   0. 法規常數
   一律讀 assets/data/*.json。買房那一段還需要交易成本與各縣市房價所得比，
   目前只存在 apps/afford-ceiling/rules.json，尚未搬進共用資料層（見 NEEDS.md）。
   讀不到就拒答，不在程式碼裡放一份寫死的備份 —— 寫死的法規常數等同慢性錯誤。
   ========================================================================== */
let RC = null;   // 交易成本、各縣市統計、DSR 三檔（暫時來源）
let RL = null;   // assets/data/tw-lending.json：央行成數、DBR、房價負擔能力
let RM = null;   // assets/data/tw-mortgage.json：預設利率、警戒線、官方方案

const V = (k) => RC?.[k]?.value;
/** 未查證的項目在畫面上一律標出來，不藏 */
const EST = (k) => (RC?.[k]?.status === 'verified' ? '' : '（未查證）');

const TIER = {
  first: { label: '名下無房', ltvKey: 'ltvFirstHomeNoProperty', grace: true },
  second: { label: '第 2 戶', ltvKey: 'ltvSecondHome', grace: false },
  third: { label: '第 3 戶以上', ltvKey: 'ltvThirdPlus', grace: false },
};

/* ==========================================================================
   1. 這一頁用到共用檔案的哪幾格
   ========================================================================== */
const SHARED_KEYS = [
  'salary', 'spouseSalary', 'monthlyLiving', 'savings',
  'debtMonthly', 'debtBalance', 'homeCount', 'hasMortgage',
];
const NEED_SHARED = ['salary'];
const NEED_CEILING = ['salary', 'monthlyLiving', 'savings', 'homeCount'];
const NEED_CLIFF = ['mortgageBalance', 'mortgageMonthsLeft', 'mortgageRate', 'mortgageGraceLeft'];
// 模組層已經問過的那一格不在段落裡再問一次
const ASK_CEILING = NEED_CEILING.filter((k) => !NEED_SHARED.includes(k));
const ASK_CLIFF = NEED_CLIFF.filter((k) => !NEED_SHARED.includes(k));
const CLIFF_FILE_KEYS = ['mortgageBalance', 'mortgageMonthsLeft', 'mortgageRate'];

/* 沒有檔案的人也必須在載入時看到一個結論，所以給一組明確標示為範例的數字。
   這不是法規常數，是一個示範用的家庭，因此可以寫在這裡。 */
const EXAMPLE = {
  salary: 65000,
  spouseSalary: 45000,
  monthlyLiving: 45000,
  savings: 4000000,
  debtMonthly: 8000,
  debtBalance: 400000,
  homeCount: 0,
  mortgageBalance: 10000000,
  mortgageMonthsLeft: 360,
  mortgageGraceLeft: 36,
};

const demoCeiling = () => P.missing(NEED_CEILING).length > 0;
const demoCliff = () => P.missing(NEED_CLIFF).length > 0;

/** 取共用檔案的值。沒填過時：範例模式給範例數字，否則退回欄位預設（多半是 0）。 */
function g(key, demo) {
  if (P.has(key)) return P.get(key);
  if (demo && EXAMPLE[key] !== undefined) return EXAMPLE[key];
  return P.getOr(key, 0);
}

const tierOf = (homes) => (homes >= 2 ? 'third' : homes === 1 ? 'second' : 'first');

/* ==========================================================================
   2. 只屬於這一頁的狀態（不進共用檔案）
   ========================================================================== */
const DEFAULTS = {
  tab: '',
  // 買房那一段自己的假設
  years: 30, rate: null, dsr: 40, keep: 10000, reno: 600000,
  bonus: false, bonusMonths: 2, childCost: 15000, graceTest: false,
  sRate: false, sJobless: false, sChild: false,
  // 房貸那一段：三聯情境。null 代表「跟著你的檔案走」。
  scenarios: { 1: { grace: null, shock: 0, method: 'annuity', rates: null, extras: [], amount: null, months: null, preset: null, label: null } },
  active: 1,
};
const SCEN = () => ({ grace: null, shock: 0, method: 'annuity', rates: null, extras: [], amount: null, months: null, preset: null, label: null });

const store = createStore('vm:borrow', structuredClone(DEFAULTS));

// createPlies 每次載入都從一聯開始，所以保存多聯會讓分頁與資料對不起來。
// 情境比較是同一次造訪之內的動作，載入時只留使用中的那一聯。
{
  const sc = store.at('scenarios')?.[store.at('active')] || SCEN();
  store.set({ scenarios: { 1: { ...SCEN(), ...sc } }, active: 1 }, { silent: true });
}

const cur = () => store.at('scenarios')[store.at('active')] || SCEN();
function patchScenario(p) {
  const scenarios = { ...store.at('scenarios') };
  scenarios[store.at('active')] = { ...cur(), ...p };
  store.set({ scenarios });
}

/* ==========================================================================
   3. 版面掛載
   ========================================================================== */
mountTopbar({ title: '借款' });
const actions = $('#sheetActions');
const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* 分享：沒有帳號，網址就是儲存體。這一頁的情境在 s，你的財務檔案在 p，
   兩個都放進去，對方打開才看得到同一組數字。 */
actions.appendChild(el('button', {
  class: 'btn btn--ghost btn--sm', type: 'button',
  html: iconHTML('share') + '<span>複製情境連結</span>',
  onclick: async () => {
    const u = new URL(store.shareUrl());
    const p = new URL(P.shareUrl()).searchParams.get('p');
    if (p) u.searchParams.set('p', p);
    const url = u.toString();
    try {
      await navigator.clipboard.writeText(url);
      toast('連結已複製。它帶著你填的數字，只傳給你信任的人。');
    } catch {
      const box = el('input', { class: 'num', value: url, style: 'position:fixed;left:-9999px' });
      document.body.appendChild(box); box.select();
      try { document.execCommand('copy'); toast('連結已複製'); }
      catch { prompt('複製這段網址：', url); }
      box.remove();
    }
  },
}));
mountTheme(actions);

/* ==========================================================================
   4. 兩段的切換
   ========================================================================== */
let activeTab = 'ceiling';
function showTab(id, { animate = true, remember = false } = {}) {
  activeTab = id === 'cliff' ? 'cliff' : 'ceiling';
  $$('#tabs .segmented__opt').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === activeTab)));
  $('#sec-ceiling').hidden = activeTab !== 'ceiling';
  $('#sec-cliff').hidden = activeTab !== 'cliff';
  // 只記使用者自己按過的那一段。自動挑的那一次不記，
  // 否則第一次造訪就把選擇鎖死，之後填了房貸資料也不會再自動帶到斷崖那一段。
  if (remember) store.set({ tab: activeTab });
  if (!RC) return;
  // 面板剛顯示時畫布寬度才量得到，兩張圖都要重畫一次
  if (activeTab === 'ceiling') { computeCeiling(); }
  else { computeCliff(); }
  if (animate) printRows($$(`#sec-${activeTab === 'ceiling' ? 'ceiling' : 'cliff'} .readout`), { stagger: 0.05 });
}
$$('#tabs .segmented__opt').forEach((b) => {
  b.addEventListener('click', () => showTab(b.dataset.value, { remember: true }));
});

/* ==========================================================================
   5. 招牌視覺（買房）：月現金流瀑布
   為什麼自己畫：共用的 Plot 是 x/y 座標系，瀑布要的是「六個並排的段落 +
   段落之間的接續虛線 + 會沉到零線以下的最後一段」，用類別軸重寫比繞路短。
   格線、字級、色彩一律沿用共用代幣。
   ========================================================================== */
class Waterfall {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.bars = [];
    this.dom = { y0: 0, y1: 1 };
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement || canvas);
    this._mq = window.matchMedia('(prefers-color-scheme: dark)');
    this._mq.addEventListener('change', () => this.render());
    this.resize();
  }

  resize() {
    const host = this.c.parentElement || this.c;
    const w = Math.max(260, host.clientWidth);
    const h = Math.round(Math.min(360, Math.max(230, w * 0.6)));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.c.style.width = '100%';
    this.c.style.height = h + 'px';
    this.c.width = Math.round(w * this.dpr);
    this.c.height = Math.round(h * this.dpr);
    this.w = w; this.h = h;
    this.pad = { left: w < 420 ? 42 : 54, right: 10, top: 20, bottom: 36 };
    this.render();
  }

  autoDomain() {
    let lo = 0, hi = 0;
    for (const b of this.bars) { lo = Math.min(lo, b.y0); hi = Math.max(hi, b.y1); }
    const span = hi - lo || 1;
    this.dom = { y0: lo - span * 0.1, y1: hi + span * 0.1 };
  }

  sy(v) {
    const { y0, y1 } = this.dom;
    return this.h - this.pad.bottom - ((v - y0) / (y1 - y0)) * (this.h - this.pad.top - this.pad.bottom);
  }

  /** 壓力鈕按下時，各段被推擠到新位置；高度用補間，顏色直接換。 */
  setBars(next) {
    if (still() || this.bars.length !== next.length) {
      this.bars = next.map((b) => ({ ...b }));
      this.autoDomain(); this.render();
      return;
    }
    const from = this.bars.map((b) => ({ y0: b.y0, y1: b.y1 }));
    this.bars = next.map((b, i) => ({ ...b, y0: from[i].y0, y1: from[i].y1 }));
    const o = { t: 0 };
    gsap.killTweensOf(o);
    gsap.to(o, {
      t: 1, duration: 0.55, ease: 'power2.out',
      onUpdate: () => {
        this.bars.forEach((b, i) => {
          b.y0 = from[i].y0 + (next[i].y0 - from[i].y0) * o.t;
          b.y1 = from[i].y1 + (next[i].y1 - from[i].y1) * o.t;
        });
        this.autoDomain(); this.render();
      },
      onComplete: () => { this.bars = next.map((b) => ({ ...b })); this.autoDomain(); this.render(); },
    });
  }

  render() {
    const { ctx, dpr } = this;
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.bars.length) return;

    const L = this.pad.left, Rt = this.w - this.pad.right;
    const T = this.pad.top, B = this.h - this.pad.bottom;
    const faint = cssv('--rule-faint') || '#E0E0D8';
    const rule = cssv('--rule') || '#C6C6BE';
    const strong = cssv('--rule-strong') || '#9B9B92';
    const ink3 = cssv('--ink-3') || '#5F656C';
    const ink = cssv('--ink') || '#15181B';
    const monoF = cssv('--font-mono') || 'monospace';
    const cjkF = cssv('--font-cjk') || 'sans-serif';

    // 髮絲格線
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = faint;
    ctx.font = `500 10px ${monoF}`;
    ctx.fillStyle = ink3;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of niceTicks(this.dom.y0, this.dom.y1, 5)) {
      const y = Math.round(this.sy(v)) + 0.5;
      if (y < T - 1 || y > B + 1) continue;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(Rt, y); ctx.stroke();
      ctx.fillText(Math.abs(v) >= 10000 ? (v / 10000).toFixed(1) + '萬' : String(Math.round(v)), L - 6, y);
    }
    ctx.strokeStyle = rule;
    ctx.beginPath();
    ctx.moveTo(L + 0.5, T); ctx.lineTo(L + 0.5, B + 0.5); ctx.lineTo(Rt, B + 0.5);
    ctx.stroke();
    ctx.restore();

    // 零線：剩餘那一段沉到這條線以下，就是這張圖存在的理由
    const zeroY = Math.round(this.sy(0)) + 0.5;
    ctx.save();
    ctx.strokeStyle = strong;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(L, zeroY); ctx.lineTo(Rt, zeroY); ctx.stroke();
    ctx.restore();

    const n = this.bars.length;
    const slot = (Rt - L) / n;
    const bw = Math.min(64, slot * 0.62);

    // 段落之間的接續虛線：騎縫線的語彙，說明「錢從這裡接到那裡」
    ctx.save();
    ctx.strokeStyle = ink3;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    for (let i = 0; i < n - 1; i++) {
      const carry = i === 0 ? this.bars[0].y1 : this.bars[i].y0;
      const y = Math.round(this.sy(carry)) + 0.5;
      const x1 = L + slot * (i + 0.5) + bw / 2;
      const x2 = L + slot * (i + 1.5) - bw / 2;
      ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();

    // 段落與標籤
    ctx.save();
    for (let i = 0; i < n; i++) {
      const b = this.bars[i];
      const cx = L + slot * (i + 0.5);
      const top = Math.min(this.sy(b.y0), this.sy(b.y1));
      const hh = Math.max(1, Math.abs(this.sy(b.y1) - this.sy(b.y0)));
      ctx.fillStyle = b.color;
      ctx.fillRect(Math.round(cx - bw / 2), Math.round(top), Math.round(bw), Math.round(hh));

      // 數值：正的標在上、負的標在下，永遠不壓在色塊上
      const val = b.value;
      ctx.font = `600 10px ${monoF}`;
      ctx.fillStyle = ink;
      ctx.textAlign = 'center';
      if (val === 0) {
        ctx.fillStyle = ink3;
        ctx.textBaseline = 'bottom';
        ctx.fillText('-', cx, Math.max(T + 10, top - 4));
      } else {
        const txt = Math.abs(val) >= 10000 ? (val / 10000).toFixed(1) + '萬' : int(val);
        if (b.y1 <= 0.0001 && b.y0 < 0) {
          ctx.textBaseline = 'top';
          ctx.fillText(txt, cx, Math.min(B - 12, top + hh + 4));
        } else {
          ctx.textBaseline = 'bottom';
          ctx.fillText(txt, cx, Math.max(T + 10, top - 4));
        }
      }

      ctx.font = `600 11px ${cjkF}`;
      ctx.fillStyle = ink3;
      ctx.textBaseline = 'top';
      ctx.fillText(b.label, cx, B + 8);
    }
    ctx.restore();
  }
}

const fall = new Waterfall($('#c-fall'));

/* 自備款曲線：兩條限制線的轉折點，就是「再存下去也沒用了」的位置 */
const plotSavings = new Plot($('#c-chart2'), {
  aspect: 0.42,
  minHeight: 180,
  yFormat: (v) => (v >= 10000 ? Math.round(v / 10000) + '萬' : String(Math.round(v))),
  xFormat: (v) => (v >= 10000 ? Math.round(v / 10000) + '萬' : String(Math.round(v))),
  padding: { left: 54, bottom: 28, top: 14, right: 14 },
});

/* ==========================================================================
   6. 招牌視覺（房貸）：月付金時間軸與那道斷崖
   ========================================================================== */
const cliffPlotHost = $('#m-plotCard');
const tip = createTip(cliffPlotHost);
const cliffTag = el('div', { class: 'cliff-tag', hidden: true });
cliffPlotHost.appendChild(cliffTag);

/** 期數的刻度要落在整年上，不然會出現「13年」這種讀不出意義的刻度 */
function yearTicks(totalMonths) {
  const years = Math.max(1, Math.round(totalMonths / 12));
  const step = years <= 10 ? 2 : years <= 25 ? 5 : 10;
  const out = [];
  for (let y = 0; y <= years; y += step) out.push(y * 12 || 1);
  return out;
}

const plotPay = new Plot($('#m-chart'), {
  aspect: 0.52,
  yFormat: (v) => (v >= 10000 ? (v / 10000).toFixed(v >= 100000 ? 0 : 1) + '萬' : String(Math.round(v))),
  xFormat: (v) => (v <= 1 ? '0年' : Math.round(v / 12) + '年'),
  padding: { left: 52, bottom: 28, top: 18, right: 14 },
});

const plotSplit = new Plot($('#m-chart2'), {
  aspect: 0.38,
  yFormat: (v) => (v >= 10000 ? (v / 10000).toFixed(1) + '萬' : String(Math.round(v))),
  xFormat: (v) => (v <= 1 ? '0年' : Math.round(v / 12) + '年'),
  padding: { left: 52, bottom: 28, top: 12, right: 14 },
});

/* ==========================================================================
   7. 共用檔案的介面：缺什麼問什麼，填過的可以就地改
   ========================================================================== */
let askShared, askCeil, askCliffBox;

function renderFileDrawer() {
  const host = $('#fileGrid');
  host.replaceChildren();
  const filled = SHARED_KEYS.filter((k) => P.has(k));
  if (!filled.length) {
    host.appendChild(el('p', {
      class: 'field__hint',
      text: '你還沒填過任何一格。上面問你的那幾格填完之後，它們會出現在這裡讓你隨時改。',
    }));
    return;
  }
  for (const k of filled) host.appendChild(fieldControl(k, { compact: true }));
}

function renderCliffFileGrid() {
  const host = $('#m-loanGrid');
  host.replaceChildren();
  const filled = CLIFF_FILE_KEYS.filter((k) => P.has(k));
  for (const k of filled) host.appendChild(fieldControl(k, { compact: true }));
  $('#m-loanHint').textContent = filled.length
    ? '這幾格來自你的財務檔案。在這裡改，檔案就跟著改，其他工具也會用同一份。'
    : '';
}

function renderFromLine() {
  const host = $('#fromLine');
  host.replaceChildren();
  host.appendChild(el('a', { href: '../../index.html#timeline', text: '回法規變動時間軸' }));
  const c = P.completeness();
  if (c.filled) {
    host.appendChild(el('span', {
      class: 'app-from__own',
      text: `這些數字用的是你在首頁填過的資料（已填 ${c.filled} 格）`,
    }));
  } else {
    host.appendChild(el('span', {
      class: 'app-from__demo',
      text: '你還沒有財務檔案，下面兩段先用一組範例數字示範',
    }));
  }
}

/* ==========================================================================
   8. 買房那一段
   關鍵法規修正：DBR 22 倍規範的是無擔保債務，房貸是有擔保債務，
   因此 debtBal 永遠不會出現在任何一條推算房價上限的算式裡。
   ========================================================================== */
const VAR_RATE = () =>
  V('deedTaxRate') * V('assessedValueRatioOfPrice')      // 契稅（稅基是房屋評定現值）
  + V('stampTaxRate') * V('publicContractRatioOfPrice')  // 印花稅（稅基是公契金額）
  + V('agencyFeeBuyer')                                  // 買方仲介報酬
  + V('settlingReserveRate');                            // 交屋後週轉金

const FIXED_FEE = () => V('scrivenerAndRegistryFee');

/** 這一段的預估利率：使用者改過就用他的；沒改過就用檔案裡的房貸利率，再退回五大銀行平均。 */
function ceilRate() {
  const own = store.at('rate');
  if (Number.isFinite(own)) return own;
  if (P.has('mortgageRate')) return P.get('mortgageRate');
  return RC?.affordability?.fiveBankMortgageRate ?? P.getOr('mortgageRate');
}

function ceilState() {
  const st = store.get();
  const demo = demoCeiling();
  return {
    income1: g('salary', demo),
    income2: g('spouseSalary', demo),
    living: g('monthlyLiving', demo),
    savings: g('savings', demo),
    debtPmt: g('debtMonthly', demo),
    debtBal: g('debtBalance', demo),
    tier: tierOf(g('homeCount', demo)),
    bonus: st.bonus, bonusMonths: st.bonusMonths,
    years: st.years, rate: ceilRate(), dsr: st.dsr,
    keep: st.keep, reno: st.reno, grace: st.graceTest,
    childCost: st.childCost,
    sRate: st.sRate, sJobless: st.sJobless, sChild: st.sChild,
  };
}

/** 家庭認列月收入。年終預設不攤，因為銀行多以固定薪資認列。 */
function grossIncome(s) {
  const base = Math.max(0, s.income1) + Math.max(0, s.income2);
  return s.bonus ? base * (1 + Math.max(0, s.bonusMonths) / 12) : base;
}

/**
 * 由「可承受月付」反解房價上限。
 * @param {object} k { rateBump: 百分點, extraLiving: 元, joblessFund: bool, dsr: 0~1 }
 */
function ceiling(s, k = {}) {
  const M = grossIncome(s);
  const dsrCap = k.dsr ?? (s.dsr / 100);
  const rate = Math.max(0, s.rate + (k.rateBump || 0));
  const i = rate / 100 / 12;
  const n = Math.round(s.years * 12);
  const living = Math.max(0, s.living) + (k.extraLiving || 0);
  const debtPmt = Math.max(0, s.debtPmt);
  const ltv = V(TIER[s.tier].ltvKey);

  const capByDsr = M * dsrCap - debtPmt;
  const capByFlow = M - debtPmt - living - Math.max(0, s.keep);
  const pmtCap = Math.min(capByDsr, capByFlow);

  const out = {
    M, rate, i, n, ltv, living, debtPmt, dsrCap,
    capByDsr, capByFlow, pmtCap,
    varRate: VAR_RATE(), fixedFee: FIXED_FEE(),
    refuse: null, fund: 0,
  };

  if (!(M > 0)) { out.refuse = 'noIncome'; return out; }
  if (!(pmtCap > 0)) { out.refuse = 'noRoom'; return out; }

  out.loanByIncome = principalFromPmt(pmtCap, i, n);
  out.priceByIncome = out.loanByIncome / ltv;

  // 自備款側：失業情境要先扣掉緊急預備金，而預備金又取決於月付，
  // 所以用不動點迭代收斂（房價↑→月付↑→預備金↑→可用自備款↓）。
  let fund = 0;
  let priceBySavings = 0;
  let price = 0;
  for (let it = 0; it < 8; it++) {
    const avail = s.savings - fund - Math.max(0, s.reno) - out.fixedFee;
    priceBySavings = Math.max(0, avail) / (1 - ltv + out.varRate);
    price = Math.min(out.priceByIncome, priceBySavings);
    if (!k.joblessFund) break;
    const monthly = pmt(price * ltv, i, n) + debtPmt + living;
    const nextFund = 6 * monthly;
    if (Math.abs(nextFund - fund) < 100) { fund = nextFund; break; }
    fund = nextFund;
  }
  out.fund = fund;
  out.priceBySavings = priceBySavings;
  out.price = price;
  out.loan = price * ltv;
  out.pmt = pmt(out.loan, i, n);
  out.bound = out.priceByIncome <= priceBySavings ? 'income' : 'savings';
  if (!(price > 0)) out.refuse = 'noSavings';
  return out;
}

/** 交屋時自備款被吃掉的每一項 */
function costBreakdown(price, s, ltv) {
  return [
    { label: '頭期款', v: price * (1 - ltv), src: `成數上限 ${pct(ltv, 0)}${EST(TIER[s.tier].ltvKey)}` },
    { label: '契稅', v: price * V('assessedValueRatioOfPrice') * V('deedTaxRate'), est: true, src: `契稅條例第 3 條 6%；稅基以評定現值估${EST('assessedValueRatioOfPrice')}` },
    { label: '印花稅', v: price * V('publicContractRatioOfPrice') * V('stampTaxRate'), est: true, src: `印花稅法第 7 條 0.1%；稅基以公契金額估${EST('publicContractRatioOfPrice')}` },
    { label: '代書費與登記規費', v: V('scrivenerAndRegistryFee'), est: true, src: `市場行情估計${EST('scrivenerAndRegistryFee')}` },
    { label: '仲介服務報酬', v: price * V('agencyFeeBuyer'), est: true, src: `買方 ${pct(V('agencyFeeBuyer'), 0)} 慣例${EST('agencyFeeBuyer')}` },
    { label: '裝潢與家具預留', v: Math.max(0, s.reno), src: '你自己填的' },
    { label: '交屋後週轉金', v: price * V('settlingReserveRate'), est: true, src: `建議另備 ${pct(V('settlingReserveRate'), 0)}${EST('settlingReserveRate')}` },
  ];
}

/* ---------- 這一段自己的輸入 ---------- */
function patchCeil(p, opts = {}) { store.set(p); computeCeiling(opts); }

const cSliderDsr = bindSlider($('#c-s-dsr'), {
  format: (v) => `${v}<small>%</small>`,
  onInput: (v) => patchCeil({ dsr: v }, { from: 'slide' }),
});
const cFieldYears = bindField($('#c-f-years'), {
  validate: (v) => {
    if (!Number.isFinite(v) || v < 1) return '年限至少 1 年';
    if (v > 40) return '房貸年限最長 40 年';
    return null;
  },
  onChange: (v, { valid }) => { if (valid) patchCeil({ years: Math.round(v) }); },
});
const cFieldRate = bindField($('#c-f-rate'), {
  validate: (v) => {
    if (!Number.isFinite(v) || v < 0) return '請填 0 或正數';
    if (v > 20) return '這個利率超出試算範圍';
    return null;
  },
  onChange: (v, { valid }) => { if (valid) patchCeil({ rate: v }); },
});
const cFieldKeep = bindField($('#c-f-keep'), {
  pretty: int,
  validate: (v) => (Number.isFinite(v) && v >= 0 ? null : '請填 0 或正數'),
  onChange: (v, { valid }) => { if (valid) patchCeil({ keep: v }); },
});
const cFieldReno = bindField($('#c-f-reno'), {
  pretty: int,
  validate: (v) => (Number.isFinite(v) && v >= 0 ? null : '請填 0 或正數'),
  onChange: (v, { valid }) => { if (valid) patchCeil({ reno: v }); },
});

$('#c-ck-bonus').addEventListener('change', (e) => patchCeil({ bonus: e.target.checked }));
$('#c-ck-grace').addEventListener('change', (e) => patchCeil({ graceTest: e.target.checked }));

$$('#sec-ceiling .stress').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = { rate: 'sRate', jobless: 'sJobless', child: 'sChild' }[btn.dataset.stress];
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    patchCeil({ [key]: on }, { from: 'stress' });
  });
});

$('#c-resetBtn').addEventListener('click', () => {
  store.set({
    years: 30, rate: null, dsr: 40, keep: 10000, reno: 600000,
    bonus: false, graceTest: false, sRate: false, sJobless: false, sChild: false,
  });
  syncCeilInputs();
  computeCeiling();
  toast('這一段的假設回到預設。你的財務檔案沒有被動到。');
});

function syncCeilInputs() {
  const st = store.get();
  cSliderDsr.set(st.dsr, { silent: true });
  cFieldYears.set(st.years, { silent: true });
  cFieldRate.set(ceilRate(), { silent: true });
  cFieldKeep.set(st.keep, { silent: true });
  cFieldReno.set(st.reno, { silent: true });
  $('#c-ck-bonus').checked = !!st.bonus;
  $('#c-bonusM').textContent = String(st.bonusMonths);
  $('#c-ck-grace').checked = !!st.graceTest;
  $$('#sec-ceiling .stress').forEach((b) => {
    const key = { rate: 'sRate', jobless: 'sJobless', child: 'sChild' }[b.dataset.stress];
    b.setAttribute('aria-pressed', String(!!st[key]));
  });
  $('#c-rateHint').textContent = Number.isFinite(st.rate)
    ? '你自己填的。'
    : P.has('mortgageRate')
      ? '來自你檔案裡的房貸利率。'
      : `五大銀行新承做房貸平均利率（${RC?.affordability?.quarter || ''}）。`;
  const demo = demoCeiling();
  $('#c-sharedHint').textContent = demo
    ? '收入、生活支出、自備款與名下房屋數來自你的財務檔案；還沒填的先用範例數字。下面這幾格只屬於這一段。'
    : '收入、生活支出、自備款與名下房屋數來自你的財務檔案，改一次全站都跟著改。下面這幾格只屬於這一段。';
}

/* ---------- 讀數 ---------- */
const cPrice = makeCounter($('#c-r-price'), (v) => (v > 0 ? dec(v / 10000, 0) + '<small>萬</small>' : '-'), { html: true });
const cLoan = makeCounter($('#c-r-loan'), (v) => (v > 0 ? dec(v / 10000, 0) + '<small>萬</small>' : '-'), { html: true });
const cDsrOut = makeCounter($('#c-r-dsr'), (v) => (Number.isFinite(v) ? dec(v, 1) + '<small>%</small>' : '-'), { html: true });
const cGauge = makeCounter($('#c-gaugeValue'), (v) => (v > 0 ? dec(v / 10000, 0) + '<small>萬</small>' : '-'), { html: true });
const cDbr = makeCounter($('#c-r-dbr'), (v) => (Number.isFinite(v) ? dec(v, 1) + '<small>倍</small>' : '-'), { html: true });

// 寬限期提示：不動上限，只揭露它真正做了什麼
const graceNote = el('div', { class: 'note note--warn', id: 'c-graceNote', hidden: true, style: 'margin-top:var(--s-4)' });
$('#c-readouts').after(graceNote);

let cStampedFor = null;

function computeCeiling({ from } = {}) {
  if (!RC) return;
  const s = ceilState();

  // 基準：沒有任何壓力時的上限。瀑布永遠畫在這個房價上，
  // 因為「你照沒有壓力時的上限買了，然後壞事發生」才是這個工具的問題。
  const k = {
    rateBump: s.sRate ? V('rateShockCode') * 2 : 0,
    extraLiving: s.sChild ? s.childCost : 0,
    joblessFund: s.sJobless,
  };
  const base = ceiling(s);
  const stressed = ceiling(s, k);

  const anyStress = s.sRate || s.sJobless || s.sChild;
  const shown = anyStress ? stressed : base;

  if (base.refuse || shown.refuse) {
    renderCeilRefuse(s, base.refuse ? base : shown);
    return;
  }
  $('#c-refuse').hidden = true;
  $('#c-verdict').hidden = false;

  /* ---- 瀑布：段落被壓縮的那一刻 ---- */
  const iNow = (s.rate + (s.sRate ? V('rateShockCode') * 2 : 0)) / 100 / 12;
  const pmtNow = pmt(base.loan, iNow, base.n);
  const child = s.sChild ? s.childCost : 0;
  // 失業 6 個月：那半年家裡只剩配偶的收入。收入那一段被壓扁。
  const ownIncome = Math.max(0, s.income1) * (s.bonus ? 1 + s.bonusMonths / 12 : 1);
  const incomeNow = s.sJobless ? Math.max(0, base.M - ownIncome) : base.M;
  const rest = incomeNow - pmtNow - base.debtPmt - s.living - child;

  const cIn = cssv('--up');        // 流入＝漲＝紅（台灣制）
  const cOut = cssv('--down');     // 流出＝跌＝綠
  const cRest = rest < 0 ? cssv('--up')
    : rest < base.M * 0.08 ? cssv('--warn')
      : cssv('--accent');

  let run = incomeNow;
  const bars = [{ label: '收入', y0: 0, y1: incomeNow, value: incomeNow, color: cIn }];
  const steps = [
    { label: '房貸', v: pmtNow },
    { label: '負債', v: base.debtPmt },
    { label: '生活', v: s.living },
    { label: '育兒', v: child },
  ];
  for (const st of steps) {
    bars.push({ label: st.label, y0: run - st.v, y1: run, value: st.v, color: cOut });
    run -= st.v;
  }
  bars.push({ label: '剩餘', y0: Math.min(0, rest), y1: Math.max(0, rest), value: rest, color: cRest });
  fall.setBars(bars);

  const restTxt = rest < 0
    ? `每個月短少 ${int(Math.round(-rest))} 元`
    : `每個月剩下 ${int(Math.round(rest))} 元`;
  $('#c-fall').setAttribute('aria-label',
    `月現金流瀑布：收入 ${int(Math.round(incomeNow))} 元，扣掉房貸 ${int(Math.round(pmtNow))} 元、`
    + `既有負債 ${int(base.debtPmt)} 元、生活支出 ${int(s.living)} 元`
    + (child ? `、育兒 ${int(child)} 元` : '') + `，${restTxt}。`);
  $('#c-fallDesc').innerHTML =
    '第一段是收入（流入為紅），中間每一段是被扣掉的錢（流出為綠），最後一段是剩餘。'
    + `這張圖固定畫在「沒有壓力時的上限房價 ${dec(base.price / 10000, 0)} 萬」上，你照那個上限出價之後，`
    + `壓力才發生。目前<b>${restTxt}</b>。`;

  /* ---- 量表 ---- */
  renderGauge(shown.price);

  /* ---- 讀數 ---- */
  cPrice(shown.price);
  cLoan(shown.loan);
  cDsrOut((pmtNow / (base.M || 1)) * 100);
  cGauge(shown.price);

  const dsrRatio = pmtNow / (base.M || 1);
  const line = $('#c-r-dsrline');
  line.textContent = dsrRatio >= 0.6 ? '已越過 60%'
    : dsrRatio >= 0.4 ? '已越過 40%'
      : dsrRatio >= 0.33 ? '在 33%-40% 之間' : '在 33% 以下';
  line.dataset.dir = dsrRatio >= 0.4 ? 'up' : dsrRatio >= 0.33 ? 'flat' : 'down';

  const cashLeft = s.savings - (base.price * (1 - base.ltv) + base.price * base.varRate + base.fixedFee + s.reno);
  const monthlyOut = pmtNow + base.debtPmt + s.living + child;
  const runway = monthlyOut > 0 ? Math.max(0, cashLeft) / monthlyOut : 0;
  $('#c-r-runway').innerHTML = cashLeft <= 0 ? '0<small>個月</small>' : `${dec(runway, 1)}<small>個月</small>`;

  renderDbr(s);
  renderCeilVerdict(s, base, stressed, shown, rest, anyStress, k);
  renderGraceNote(s, base);
  renderLevels(s);
  renderSavingsCurve(s, base);
  renderCosts(s, base);
  renderPir(s, base, shown);
  renderCeilFormula(s, base, stressed);

  if (from) carbonTransfer($$('#sec-ceiling [data-live]'));
}

/* ---------- 拒答 ---------- */
function renderCeilRefuse(s, res) {
  $('#c-verdict').hidden = true;
  $('#c-refuse').hidden = false;
  const M = grossIncome(s);
  const need = Math.max(0, s.debtPmt + s.living + s.keep - M);
  const body = {
    noIncome: '你還沒有填入任何收入。沒有收入就沒有「可承受月付」，這個模型算不出上限；它不是一個可以用自備款單獨決定的數字。',
    noRoom: `你填的固定支出（既有負債 ${int(s.debtPmt)} 元＋生活支出 ${int(s.living)} 元＋每月至少留下 ${int(s.keep)} 元）`
      + `已經把月收入 ${int(Math.round(M))} 元用完，房貸沒有可分配的空間。`
      + `在這個狀態下畫一個房價上限是假的。可以回答的範圍是：先讓月收入增加約 ${int(Math.round(need + 1000))} 元，`
      + `或把生活支出／既有負債月付合計壓低同樣的金額，這個模型才會有正的答案。`,
    noSavings: `你的自備款 ${int(s.savings)} 元，扣掉裝潢預留 ${int(s.reno)} 元與代書費等固定費用 ${int(res.fixedFee)} 元`
      + (res.fund > 0 ? `、以及失業情境要求保留的 ${int(Math.round(res.fund))} 元緊急預備金` : '')
      + '之後已經沒有剩，付不出任何一間房的頭期款與過戶成本。這個問題要先解決自備款，才輪到談上限。',
  }[res.refuse] || '輸入不足以回答這個問題。';
  $('#c-refuseBody').textContent = body;

  cPrice(0); cLoan(0); cGauge(0);
  $('#c-r-dsr').textContent = '-';
  $('#c-r-dsrline').textContent = '';
  $('#c-r-runway').textContent = '-';
  renderGauge(0);
  fall.setBars([]);
  renderDbr(s);
}

/* ---------- 量表 ---------- */
function renderGauge(price) {
  const median = RC.affordability.nationalMedianPrice;
  const candidates = [5e6, 1e7, 1.5e7, 2e7, 3e7, 5e7, 8e7, 1.2e8, 2e8];
  const want = Math.max(price, Number.isFinite(median) ? median : 0) * 1.25 || 1e7;
  const max = candidates.find((c) => c >= want) || 2e8;

  $('#c-gaugeFill').style.width = clamp((price / max) * 100, 0, 100) + '%';
  const med = $('#c-gaugeMedian');
  if (Number.isFinite(median) && median > 0 && median <= max) {
    const at = median / max;
    med.hidden = false;
    med.style.left = (at * 100) + '%';
    // 標記靠右時把標籤翻到左邊，否則會頂破單據右緣
    med.classList.toggle('gauge__median--flip', at > 0.55);
    med.querySelector('.gauge__medianLabel').textContent = `全國中位數 ${dec(median / 10000, 0)} 萬`;
  } else { med.hidden = true; }

  $('#c-gaugeScale').innerHTML =
    `<span>0</span><span>${dec(max / 2 / 10000, 0)} 萬</span><span>${dec(max / 10000, 0)} 萬</span>`;

  // 量表只畫「上限有多高」，顏色一律是強調色。
  // 紅綠燈會跟正下方的瀑布互相矛盾：瀑布用台灣制的漲紅跌綠（紅＝流入、綠＝流出），
  // 紅綠燈卻是紅＝危險、綠＝安全，同一張卡上兩種相反的解讀。
  // 安不安全已經由硃砂章、結論文字，以及瀑布裡沉到零線以下的那一段講清楚了。
}

/* ---------- DBR：獨立檢核，永遠不進上限算式 ---------- */
function renderDbr(s) {
  const inc = Math.max(0, s.income1);
  const cap = V('dbrCap');
  if (!(inc > 0)) {
    cDbr(NaN);
    $('#c-r-dbrgap').textContent = '-';
    $('#c-dbrVerdict').textContent = 'DBR 以「申貸人本人」的平均月收入計算，本人月薪填 0 就算不出來。';
    return;
  }
  const dbr = Math.max(0, s.debtBal) / inc;
  cDbr(dbr);
  const room = (cap - dbr) * inc;
  $('#c-r-dbrgap').innerHTML = dbr >= cap
    ? '<span class="is-up">已超過</span>'
    : `${dec(room / 10000, 0)}<small>萬</small>`;
  $('#c-dbrVerdict').innerHTML = dbr >= cap
    ? `<b>你的無擔保負債 ${int(s.debtBal)} 元 ÷ 本人月薪 ${int(inc)} 元 = ${dec(dbr, 1)} 倍，已經觸及 22 倍。</b>`
      + '這會卡住你再申辦信貸或信用卡的空間，銀行核房貸時也會看到這筆紀錄，'
      + '但它<b>不是</b>房貸額度的計算基礎。'
    : `你的無擔保負債 ${int(s.debtBal)} 元 ÷ 本人月薪 ${int(inc)} 元 = <b>${dec(dbr, 1)} 倍</b>，`
      + `距離 22 倍還有約 ${int(Math.round(room))} 元的無擔保空間。`
      + '再強調一次：這個空間<b>不能</b>拿來加大房貸額度，它們是兩套規範。';
}

/* ---------- 結論 ---------- */
function renderCeilVerdict(s, base, stressed, shown, rest, anyStress, k) {
  const h = $('#c-verdict-h');
  const body = $('#c-verdictBody');
  const stamp = $('#c-stamp');
  const median = RC.affordability.nationalMedianPrice;
  const demo = demoCeiling();

  const boundTxt = shown.bound === 'income'
    ? '卡住你的是收入：月付佔所得的上限先到頂，再多的自備款也推不上去。'
    : '卡住你的是自備款：收入還撐得住更貴的房子，但頭期與過戶成本先把錢用完了。';

  h.innerHTML = (anyStress
    ? `壓力之下，上限從 ${dec(base.price / 10000, 0)} 萬掉到 <em>${dec(shown.price / 10000, 0)} 萬</em>元。`
    : `以${demo ? '這組範例' : '你現在'}的條件，安全的房價上限是 <em>${dec(base.price / 10000, 0)} 萬</em>元。`)
    + (demo ? '<span class="demo-badge">範例數字</span>' : '');

  const parts = [];
  if (demo) parts.push('這是一組示範用的家庭，不是你。把上面問你的那幾格填掉，整段會換成你自己的數字。');
  parts.push(boundTxt);
  if (Number.isFinite(median) && median > 0) {
    const gap = Math.abs(median - shown.price);
    const gapTxt = dec(gap / 10000, gap < 1000000 ? 1 : 0);
    parts.push(shown.price >= median
      ? `這個上限高於全國中位數住宅價格 ${dec(median / 10000, 0)} 萬元（${RC.affordability.quarter}），高出 ${gapTxt} 萬。`
      : `這個上限低於全國中位數住宅價格 ${dec(median / 10000, 0)} 萬元（${RC.affordability.quarter}），差 ${gapTxt} 萬。`);
  }

  if (anyStress) {
    const drop = base.price - shown.price;
    const on = [s.sRate && '升息 2 碼', s.sJobless && '失業 6 個月', s.sChild && '多一個小孩'].filter(Boolean).join('、');
    parts.push(`打開「${on}」之後，安全上限下修 ${dec(drop / 10000, 0)} 萬元。`);
    parts.push(rest < 0
      ? `而且如果你已經照 ${dec(base.price / 10000, 0)} 萬買下去，這個月會短少 ${int(Math.round(-rest))} 元，那一段沉到零線以下就是答案。`
      : `如果你已經照 ${dec(base.price / 10000, 0)} 萬買下去，每個月還剩 ${int(Math.round(rest))} 元。`);
  }

  // 買不起時給具體路徑，而不是只丟一個否定。比較基準跟著目前的壓力狀態走。
  const acts = [];
  const step = 1000000;
  const bump = ceiling({ ...s, savings: s.savings + step }, k);
  if (bump.price > shown.price + 1000) {
    acts.push(`自備款每多 ${dec(step / 10000, 0)} 萬，上限往上 ${dec((bump.price - shown.price) / 10000, 1)} 萬`);
  } else {
    acts.push('自備款再加也沒用了，上限已經被收入鎖死');
  }
  if (s.debtPmt > 0) {
    const clear = ceiling({ ...s, debtPmt: 0 }, k);
    acts.push(`清掉那筆每月 ${int(s.debtPmt)} 元的無擔保負債，上限往上 ${dec(Math.max(0, clear.price - shown.price) / 10000, 1)} 萬`);
  }
  parts.push('可以動的地方：' + acts.join('；') + '。');

  // 每一句都是獨立的因果陳述，用 span 隔開才不會黏成一團
  body.innerHTML = parts.map((p) => `<span>${p}</span>`).join(' ');

  const key = `${Math.round(shown.price / 10000)}:${rest < 0}:${anyStress}`;
  stamp.hidden = false;
  if (cStampedFor !== key) {
    const cls = rest < 0 || rest < base.M * 0.08 ? 'stamp' : 'stamp stamp--ok';
    const txt = rest < 0 ? '撐不住' : rest < base.M * 0.08 ? '很勉強' : '撐得住';
    stamp.innerHTML = `<span class="${cls}">${txt}</span>`;
    stampIn(stamp.firstElementChild);
    cStampedFor = key;
  }
}

/* ---------- 寬限期：絕不用來撐高上限 ---------- */
function renderGraceNote(s, base) {
  const note = $('#c-graceNote');
  if (!s.grace) { note.hidden = true; return; }
  note.hidden = false;
  const allowed = TIER[s.tier].grace;
  const i = base.i;
  const graceMonths = 36;
  const interestOnly = base.loan * i;
  const after = pmt(base.loan, i, base.n - graceMonths);
  note.innerHTML =
    '<p><b>寬限期沒有讓上面那個上限多出一塊錢，這是刻意的。</b></p>'
    + '<p>寬限期是現金流的時間平移，不是還款能力。前 3 年只繳息 '
    + `<b>${int(Math.round(interestOnly))}</b> 元／月，期滿後要用剩下的 ${fmtMonths(base.n - graceMonths)} 還完全部本金，`
    + `月付變成 <b>${int(Math.round(after))}</b> 元，比本息攤還的 ${int(Math.round(base.pmt))} 元還高 `
    + `${int(Math.round(after - base.pmt))} 元。用寬限期換來的額度，是把跳升往後推，不是把負擔變小。`
    + '想看那道跳升長什麼樣子，切到上面的「我已經背著：會不會爆」。</p>'
    + (allowed
      ? `<p>提醒：名下已有房屋者的第 1 戶購屋貸款依央行規定<b>不得有寬限期</b>${EST('noGraceFirstHomeWithProperty')}。`
        + '你的檔案是「名下無房」，才有這個選項。</p>'
      : `<p><b>而且你的檔案是「${TIER[s.tier].label}」，依央行選擇性信用管制根本不得有寬限期${EST('noGraceSecondHome')}。</b>`
        + '這一段只是讓你看見它的代價，不是可行方案。</p>');
}

/* ---------- 三檔對照 ---------- */
function renderLevels(s) {
  const host = $('#c-levelBody');
  host.replaceChildren();
  const levels = (RC.dsrLevels?.levels || []).map((lv) => ({
    at: lv.at,
    label: `${Math.round(lv.at * 100)}% ${lv.label}`,
  }));
  for (const lv of levels) {
    const r = ceiling(s, { dsr: lv.at });
    const tr = el('tr', Math.abs(lv.at - s.dsr / 100) < 0.005 ? { 'data-you': '1' } : {});
    tr.appendChild(el('td', { text: lv.label }));
    tr.appendChild(el('td', { text: r.refuse ? '-' : dec(r.price / 10000, 0) + ' 萬' }));
    tr.appendChild(el('td', { text: r.refuse ? '-' : dec(r.loan / 10000, 0) + ' 萬' }));
    tr.appendChild(el('td', { text: r.refuse ? '-' : int(Math.round(r.pmt)) }));
    tr.appendChild(el('td', {
      class: 'cell-note',
      text: r.refuse ? '算不出來' : (r.bound === 'income' ? '收入（月付上限）' : '自備款（頭期＋過戶成本）'),
    }));
    host.appendChild(tr);
  }
}

/* ---------- 自備款曲線 ---------- */
function renderSavingsCurve(s, base) {
  // 轉折點：自備款存到這裡，上限就頂到收入撐得起的天花板，再存無效。
  const kink = base.priceByIncome * (1 - base.ltv + base.varRate) + s.reno + base.fixedFee;
  const maxX = Math.max(s.savings * 1.5, kink * 1.5, 2000000);
  const N = 60;
  const byIncome = [];
  const bySavings = [];
  const actual = [];
  for (let k = 0; k <= N; k++) {
    const x = (maxX / N) * k;
    const avail = Math.max(0, x - s.reno - base.fixedFee);
    const ps = avail / (1 - base.ltv + base.varRate);
    byIncome.push({ x, y: base.priceByIncome });
    bySavings.push({ x, y: ps });
    actual.push({ x, y: Math.min(base.priceByIncome, ps) });
  }
  plotSavings.setSeries([
    { type: 'line', data: byIncome, color: cssv('--series-1'), width: 1.5, dash: [5, 4], noCursor: true },
    { type: 'line', data: bySavings, color: cssv('--series-4'), width: 1.5, dash: [5, 4], noCursor: true },
    { type: 'line', data: actual, color: cssv('--accent'), width: 3 },
  ], { animate: false });
  plotSavings.setMarks([{ axis: 'x', value: s.savings, label: '你現在', color: cssv('--stamp'), dash: [3, 3] }]);

  $('#c-legend2').innerHTML =
    `<span class="legend__item"><span class="legend__key legend__key--dash" style="color:${cssv('--series-1')}"></span>收入撐得起的上限</span>`
    + `<span class="legend__item"><span class="legend__key legend__key--dash" style="color:${cssv('--series-4')}"></span>自備款撐得起的上限</span>`
    + `<span class="legend__item"><span class="legend__key" style="background:${cssv('--accent')}"></span>兩者取小＝真正的上限</span>`;

  $('#c-chart2Desc').innerHTML = base.bound === 'savings'
    ? `橫軸是自備款，縱軸是房價上限。你現在在轉折點左邊：自備款存到 <b>${dec(kink / 10000, 0)} 萬</b>，`
      + `上限會頂到收入撐得起的 ${dec(base.priceByIncome / 10000, 0)} 萬；再多存就不會再往上了。`
    : `橫軸是自備款，縱軸是房價上限。你已經在轉折點右邊（自備款 ${dec(kink / 10000, 0)} 萬以上），`
      + `上限被收入鎖在 ${dec(base.priceByIncome / 10000, 0)} 萬，再存也不會往上。要動的是收入或既有負債。`;
  $('#c-chart2').setAttribute('aria-label', $('#c-chart2Desc').textContent);
}

/* ---------- 自備款拆解 ---------- */
function renderCosts(s, base) {
  const host = $('#c-costBody');
  host.replaceChildren();
  const items = costBreakdown(base.price, s, base.ltv);
  let total = 0;
  for (const it of items) {
    total += it.v;
    const tr = el('tr');
    tr.appendChild(el('td', { text: it.label + (it.est ? '（估）' : '') }));
    tr.appendChild(el('td', { class: it.est ? 'is-est' : '', text: int(Math.round(it.v)) }));
    tr.appendChild(el('td', { class: 'cell-note', text: it.src }));
    host.appendChild(tr);
  }
  $('#c-costTotal').textContent = int(Math.round(total));
  // 這張表跟瀑布圖用同一個房價，否則兩張圖會講不同的故事
  $('#c-costFoot').innerHTML =
    `以「沒有壓力時的上限房價 <b>${dec(base.price / 10000, 0)} 萬</b>」計算，跟上面的現金流瀑布是同一個價位。`
    + `合計 ${int(Math.round(total))} 元，你的檔案裡的自備款是 ${int(s.savings)} 元。`
    + '契稅與印花稅的稅基是<b>房屋評定現值與公契金額</b>，不是成交價；本表以估計比例換算，'
    + '標「估」的項目請當成量級而不是報價。';
}

/* ---------- 房價所得比對照 ---------- */
function renderPir(s, base, shown) {
  const a = RC.affordability;
  // 各縣市分表與全國數是不同季別，標題只能標分表那一季，不能借用全國那一季
  const cq = a.countyQuarter || a.quarter;
  $('#c-pirQuarter').textContent = (cq && cq.length > 1) ? `各縣市分表 ${cq}` : '統計季別 未載入';
  const yearIncome = base.M * 12;
  const yourPir = yearIncome > 0 ? shown.price / yearIncome : NaN;

  $('#c-pirLede').innerHTML = Number.isFinite(yourPir)
    ? `你的上限 ${dec(shown.price / 10000, 0)} 萬 ÷ 家庭年收入 ${dec(yearIncome / 10000, 0)} 萬 = <b>${dec(yourPir, 2)} 倍</b>。`
      + '下表是各縣市的中位數家庭買中位數住宅，要花掉幾倍的年所得。你的倍數比某個縣市大，就表示以你的所得比例，那裡的中位數住宅買得起。'
    : '填入收入後，這裡會把你的上限換算成房價所得比。';

  const host = $('#c-pirBody');
  host.replaceChildren();
  if (!a.counties.length) {
    host.appendChild(el('tr', {}, [el('td', { colspan: '4', class: 'cell-note', text: '統計資料未載入。' })]));
  }
  for (const c of a.counties) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: c.name }));
    tr.appendChild(el('td', { text: dec(c.pir, 2) }));
    tr.appendChild(el('td', { text: dec(c.burden, 2) + '%' }));
    const reach = Number.isFinite(yourPir) && yourPir >= c.pir;
    tr.appendChild(el('td', {
      class: reach ? 'is-reach' : 'is-est',
      text: !Number.isFinite(yourPir) ? '-' : reach ? '到得了' : '差 ' + dec(c.pir - yourPir, 2) + ' 倍',
    }));
    host.appendChild(tr);
  }
  $('#c-pirFoot').innerHTML =
    `${a.method || ''}<br>${a.countyMedianPriceNote || ''}`
    + (a.countyNote ? `<br>${a.countyNote}` : '')
    + `<br>來源：內政部不動產資訊平台 房價負擔能力指標統計成果（各縣市分表 ${cq}；全國數 ${a.quarter}）。`;
}

/* ---------- 公式抽屜 ---------- */
function renderCeilFormula(s, base, stressed) {
  const host = $('#c-formulaHost');
  host.replaceChildren();

  host.appendChild(formulaBlock('攤開看：房價上限是怎麼反解出來的', [
    '<b>第一步</b> 可承受月付＝min(收入×比率上限 − 既有負債月付, 收入 − 既有負債 − 生活支出 − 每月至少留下)',
    `= min(${int(Math.round(base.M))}×${pct(base.dsrCap, 0)} − ${int(base.debtPmt)},　${int(Math.round(base.M))} − ${int(base.debtPmt)} − ${int(base.living)} − ${int(s.keep)})`,
    `= min(${int(Math.round(base.capByDsr))},　${int(Math.round(base.capByFlow))}) = <b>${int(Math.round(base.pmtCap))}</b> 元`,
    '<b>第二步</b> 由月付反解本金　P = PMT × (1 − (1+i)<sup>−n</sup>) ÷ i',
    `i = ${pp(base.rate, 3)} ÷ 12 = ${base.i.toFixed(8)}　n = ${base.n}`,
    `P = <b>${int(Math.round(base.loanByIncome))}</b> 元`,
    '<b>第三步</b> 房價上限 = min(可貸金額 ÷ 成數上限,　可用自備款 ÷ (1 − 成數上限 + 交易成本率))',
    `成數上限 = ${pct(base.ltv, 0)}${EST(TIER[s.tier].ltvKey)}（你的檔案：名下 ${g('homeCount', demoCeiling())} 間房，所以買的是${TIER[s.tier].label === '名下無房' ? '第 1 戶' : TIER[s.tier].label}）`,
    `交易成本率 = ${pct(base.varRate, 2)}（含契稅估、印花稅估、仲介、週轉金）`,
    `= min(${int(Math.round(base.priceByIncome))},　${int(Math.round(base.priceBySavings))}) = <b>${int(Math.round(base.price))}</b> 元`,
  ], `成數上限依央行選擇性信用管制；${RC.ltvSecondHome?.legalBasis || ''}　交易成本率中的契稅與印花稅稅基是評定現值與公契金額，本工具以估計比例換算，標「未查證」者請自行確認。`));

  host.appendChild(formulaBlock('攤開看：DBR 22 倍為什麼不能拿來算房貸', [
    'DBR = 全體金融機構<b>無擔保</b>債務歸戶總餘額 ÷ 平均月收入',
    `= ${int(s.debtBal)} ÷ ${int(Math.max(0, s.income1))} = <b>${s.income1 > 0 ? dec(s.debtBal / s.income1, 2) : '-'}</b> 倍　（上限 ${V('dbrCap')} 倍）`,
    '無擔保債務 = 信用卡 + 現金卡 + 信用貸款。<b>房貸不在其中</b>，因為它有房子當抵押品。',
    '所以「月收入 × 22 = 我的房貸額度」這個算法沒有法源依據，本頁任何一條算式都沒有用到它。',
    '房貸端真正的限制：月付／所得比、貸款成數上限、央行選擇性信用管制（第幾戶、能否寬限）。',
    Array.isArray(RC.dbrCap?.practiceRange)
      ? `而且 ${V('dbrCap')} 倍的用語是「<b>不宜</b>超過」，是監理指導不是硬性上限；`
        + `銀行實務常見的內部控管帶約 <b>${RC.dbrCap.practiceRange[0]}～${RC.dbrCap.practiceRange[1]} 倍</b>，沒到 ${V('dbrCap')} 倍就可能被婉拒。`
      : '',
  ].filter(Boolean), `${RC.dbrCap?.legalBasis || ''}　出處：<a href="${RC.dbrCap?.sourceUrl || '#'}" target="_blank" rel="noopener">金管會主管法規共用系統</a>`));

  const drop = base.price - stressed.price;
  host.appendChild(formulaBlock('攤開看：三個壓力情境各自做了什麼', [
    `<b>升息 2 碼</b>　利率 +${pp(V('rateShockCode') * 2, 2)} 後重算月付與可貸本金`,
    '<b>失業 6 個月</b>　要求保留 6 × 月支出的緊急預備金，自自備款扣除後重算上限',
    `　目前要求保留 <b>${int(Math.round(stressed.fund))}</b> 元`,
    `<b>多一個小孩</b>　每月支出 +${int(s.childCost)} 元，壓縮「收入 − 支出」那一條上限`,
    `目前開啟的壓力讓上限變動 <b>${drop === 0 ? '0' : int(Math.round(-drop))}</b> 元`,
  ], '緊急預備金的月支出包含房貸月付、既有負債月付與生活支出；因為月付本身取決於房價，這裡用不動點迭代收斂。'));

  const unverified = Object.entries(RC)
    .filter(([, v]) => v && typeof v === 'object' && v.status === 'unverified')
    .map(([k, v]) => `<b>${v.label || k}</b>：${v.legalBasis || '無法源'}`);
  host.appendChild(formulaBlock(`攤開看：哪些數字是查證過的、哪些不是（${unverified.length} 項未查證）`, [
    `<b>已查證</b>　DBR ${V('dbrCap')} 倍（金管會函釋）、第 2 戶成數 ${pct(V('ltvSecondHome'), 0)}、`
      + `第 3 戶以上成數 ${pct(V('ltvThirdPlus'), 0)}、高價住宅成數 ${pct(V('ltvHighValueHousing'), 0)}（央行規定，115.3.20 生效）、`,
    `　契稅 6%（契稅條例第 3 條）、印花稅 0.1%（印花稅法第 7 條）、房價負擔能力統計（內政部 ${RC.affordability.quarter}）`,
    '　「特定地區」差別成數制度已於 113.9.20 廢除，改為全國一體適用，所以本工具沒有、也不該有「是否為特定地區」這個選項。',
    `<b>成數已查證、門檻仍未查證</b>　${RC.ltvHighValueHousing?.thresholdNote || '高價住宅的認定金額門檻未取得官方明文。'}`,
    '<b>未查證</b>',
    ...unverified,
  ], '未查證＝本工具查不到官方全文或該項本來就不是法規數字（市場慣例、銀行內部政策）。這些項目請以承貸銀行與主管機關公告為準。'));
}

/* ==========================================================================
   9. 房貸那一段
   ========================================================================== */
function baseRate() {
  const demo = demoCliff();
  const r = g('mortgageRate', demo);
  return Number.isFinite(r) && r > 0 ? r : (RC?.affordability?.fiveBankMortgageRate ?? 2.318);
}

function cliffState() {
  const sc = cur();
  const demo = demoCliff();
  const amount = Number.isFinite(sc.amount) ? sc.amount : g('mortgageBalance', demo);
  const monthsAll = Number.isFinite(sc.months) ? sc.months : g('mortgageMonthsLeft', demo);
  const months = Math.max(1, Math.round(monthsAll));
  const graceRaw = Number.isFinite(sc.grace) ? sc.grace : g('mortgageGraceLeft', demo);
  return {
    amount,
    months,
    grace: clamp(Math.round(graceRaw), 0, Math.min(60, months)),
    rates: sc.rates || [{ from: 1, rate: baseRate() }],
    method: sc.method || 'annuity',
    extras: sc.extras || [],
    shock: sc.shock || 0,
    income: g('salary', demoCeiling()) + g('spouseSalary', demoCeiling()),
    preset: sc.preset,
  };
}

const mSliderGrace = bindSlider($('#m-s-grace'), {
  format: (v) => `${v}<small>期</small>`,
  onInput: (v, source) => {
    patchScenario({ grace: v, preset: null });
    // 第一聯就是你的檔案：放開滑桿時存回去。拖曳中不寫，免得每一幀都動到檔案。
    if (store.at('active') === 1 && (source === 'commit' || source === 'type') && P.has('mortgageGraceLeft')) {
      P.set({ mortgageGraceLeft: v });
    }
    computeCliff({ from: 'grace' });
  },
});

const mSliderShock = bindSlider($('#m-s-shock'), {
  format: (v) => (v === 0 ? '不變' : codes(v)),
  onInput: (v) => { patchScenario({ shock: v }); computeCliff({ from: 'shock' }); },
});

const mSegMethod = bindSegmented($('#m-seg-method'), {
  onChange: (v) => { patchScenario({ method: v, preset: null }); computeCliff(); },
});

/* ---------- 官方方案：拿來跟自己的貸款比 ---------- */
function renderPresets() {
  const host = $('#m-seg-preset');
  host.replaceChildren();
  const active = cur().preset;
  (RM?.presets || []).forEach((p) => {
    host.appendChild(el('button', {
      type: 'button',
      class: 'segmented__opt',
      'data-value': p.id,
      'aria-pressed': String(p.id === active),
      text: p.label,
      onclick: () => applyPreset(p.id),
    }));
  });
  const p = (RM?.presets || []).find((x) => x.id === active);
  $('#m-presetHint').textContent = p
    ? p.hint
    : '套用會把目前這一聯換成該方案的金額、期數與利率，你檔案裡的房貸不受影響。';
}

function applyPreset(id) {
  const p = (RM?.presets || []).find((x) => x.id === id);
  if (!p) return;
  patchScenario({
    preset: p.id,
    amount: p.amount,
    months: Math.round(p.years * 12),
    grace: Math.round(p.grace * 12),
    rates: p.rates.map((r) => ({ ...r })),
    extras: [],
    shock: 0,
  });
  plies.rename(store.at('active'), p.label);
  patchScenario({ label: p.label });
  syncCliffInputs();
  computeCliff({ from: 'preset' });
}

/* ---------- 可重複列：利率分段 ---------- */
function renderRateRows() {
  const host = $('#m-rateRows');
  host.replaceChildren();
  const s = cliffState();
  s.rates.forEach((seg, i) => {
    const row = el('div', { class: 'row' }, [
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label', text: '自第幾期起' }),
        el('span', { class: 'field__control' }, [
          el('input', {
            type: 'text', inputmode: 'numeric', value: String(seg.from),
            disabled: i === 0,
            onchange: (e) => {
              const v = clamp(Math.round(parseNum(e.target.value, seg.from)), 2, s.months);
              const rates = s.rates.map((r, k) => (k === i ? { ...r, from: v } : r));
              patchScenario({ rates: rates.sort((a, b) => a.from - b.from), preset: null });
              renderRateRows();
              computeCliff();
            },
          }),
          el('span', { class: 'field__unit', text: '期' }),
        ]),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label', text: '年利率' }),
        el('span', { class: 'field__control' }, [
          el('input', {
            type: 'text', inputmode: 'decimal', value: String(seg.rate),
            onchange: (e) => {
              const v = clamp(parseNum(e.target.value, seg.rate), 0, 30);
              patchScenario({ rates: s.rates.map((r, k) => (k === i ? { ...r, rate: v } : r)), preset: null });
              computeCliff();
            },
          }),
          el('span', { class: 'field__unit', text: '%' }),
        ]),
      ]),
      s.rates.length > 1 && i > 0
        ? el('button', {
            type: 'button', class: 'row__del', 'aria-label': '刪除這段利率',
            html: iconHTML('close'),
            onclick: () => {
              patchScenario({ rates: s.rates.filter((_, k) => k !== i), preset: null });
              renderRateRows(); computeCliff();
            },
          })
        : el('span'),
    ]);
    host.appendChild(row);
  });
}

$('#m-addRate').addEventListener('click', () => {
  const s = cliffState();
  const last = s.rates[s.rates.length - 1];
  const nextFrom = Math.min(s.months, Math.max(last.from + 12, s.grace + 1));
  patchScenario({ rates: [...s.rates, { from: nextFrom, rate: Number((last.rate + 0.5).toFixed(3)) }], preset: null });
  renderRateRows();
  computeCliff();
  const rows = $$('#m-rateRows .row');
  printRows(rows[rows.length - 1]);
});

/* ---------- 可重複列：額外還本 ---------- */
function renderExtraRows() {
  const host = $('#m-extraRows');
  host.replaceChildren();
  const s = cliffState();
  if (!s.extras.length) {
    host.appendChild(el('p', {
      class: 'field__hint',
      text: '例如年終獎金多還一筆。加進來就會看到它把哪一段時間削掉。',
    }));
  }
  s.extras.forEach((ex, i) => {
    const row = el('div', { class: 'row row--wide' }, [
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label', text: '第幾期' }),
        el('span', { class: 'field__control' }, [
          el('input', {
            type: 'text', inputmode: 'numeric', value: String(ex.month),
            onchange: (e) => {
              const v = clamp(Math.round(parseNum(e.target.value, ex.month)), 1, s.months);
              patchScenario({ extras: s.extras.map((x, k) => (k === i ? { ...x, month: v } : x)) });
              computeCliff();
            },
          }),
          el('span', { class: 'field__unit', text: '期' }),
        ]),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label', text: '金額' }),
        el('span', { class: 'field__control' }, [
          el('input', {
            type: 'text', inputmode: 'numeric', value: String(ex.amount),
            onchange: (e) => {
              const v = Math.max(0, parseNum(e.target.value, ex.amount));
              patchScenario({ extras: s.extras.map((x, k) => (k === i ? { ...x, amount: v } : x)) });
              computeCliff();
            },
          }),
          el('span', { class: 'field__unit', text: '元' }),
        ]),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label', text: '處理' }),
        el('span', { class: 'field__control' }, [
          el('select', {
            onchange: (e) => {
              patchScenario({ extras: s.extras.map((x, k) => (k === i ? { ...x, mode: e.target.value } : x)) });
              computeCliff();
            },
          }, [
            el('option', { value: 'shorten', text: '縮短年限', selected: ex.mode !== 'lower' }),
            el('option', { value: 'lower', text: '降低月付', selected: ex.mode === 'lower' }),
          ]),
        ]),
      ]),
      el('button', {
        type: 'button', class: 'row__del', 'aria-label': '刪除這筆還本',
        html: iconHTML('close'),
        onclick: () => {
          patchScenario({ extras: s.extras.filter((_, k) => k !== i) });
          renderExtraRows(); computeCliff();
        },
      }),
    ]);
    const rep = el('label', { class: 'switch', style: 'grid-column:1/-1;margin-top:4px' }, [
      el('input', {
        type: 'checkbox', checked: !!ex.repeatYearly,
        onchange: (e) => {
          patchScenario({ extras: s.extras.map((x, k) => (k === i ? { ...x, repeatYearly: e.target.checked } : x)) });
          computeCliff();
        },
      }),
      el('span', { class: 'switch__box' }),
      el('span', { text: '之後每年同月都還一次' }),
    ]);
    row.appendChild(rep);
    host.appendChild(row);
  });
}

$('#m-addExtra').addEventListener('click', () => {
  const s = cliffState();
  patchScenario({ extras: [...s.extras, { month: Math.max(1, s.grace + 12), amount: 200000, mode: 'shorten', repeatYearly: false }] });
  renderExtraRows();
  computeCliff();
  const rows = $$('#m-extraRows .row');
  printRows(rows[rows.length - 1]);
});

const PLY_LABELS = ['第一聯', '第二聯', '第三聯'];
$('#m-resetBtn').addEventListener('click', () => {
  const id = store.at('active');
  const scenarios = { ...store.at('scenarios') };
  scenarios[id] = SCEN();
  store.set({ scenarios });
  const idx = plies.items().findIndex((p) => p.id === id);
  plies.rename(id, PLY_LABELS[idx] || `第 ${idx + 1} 聯`);
  syncCliffInputs();
  computeCliff();
  toast('這一聯回到你檔案裡的那一筆房貸。');
});

/* ---------- 情境（四聯） ---------- */
const plies = createPlies($('#m-plies'), {
  max: 3,
  labels: ['第一聯', '第二聯', '第三聯'],
  onSwitch: (id) => { store.set({ active: id }); syncCliffInputs(); computeCliff(); },
  onAdd: (id) => {
    const scenarios = { ...store.at('scenarios') };
    scenarios[id] = { ...cur() };            // 複寫：從目前這張抄一份
    store.set({ scenarios, active: id });
    syncCliffInputs(); computeCliff();
    toast('已複寫一份。改動這一聯，前一聯會留在圖上當鬼影。');
  },
  onRemove: (removed, nextActive) => {
    const scenarios = { ...store.at('scenarios') };
    delete scenarios[removed];
    store.set({ scenarios, active: nextActive });
    syncCliffInputs(); computeCliff();
  },
});

function syncCliffInputs() {
  const s = cliffState();
  const graceRange = $('#m-s-grace input[type="range"]');
  graceRange.max = String(Math.min(60, s.months));
  mSliderGrace.set(s.grace, { silent: true });
  mSliderShock.set(s.shock, { silent: true });
  mSegMethod.set(s.method);
  renderRateRows();
  renderExtraRows();
  renderPresets();
  renderCliffFileGrid();

  const demo = demoCliff();
  $('#m-graceHint').textContent = store.at('active') === 1
    ? (P.has('mortgageGraceLeft')
      ? '第一聯就是你檔案裡的那一筆。放開滑桿會把新的期數存回檔案；想比較不同寬限期就先「另存情境」。'
      : '拖動它，斷崖就會自己長出來。')
    : '這一聯是假設，拖動不會動到你的檔案。';
  if (demo && P.has('hasMortgage') && !P.get('hasMortgage')) {
    $('#m-loanHint').textContent = '你的檔案說目前沒有房貸，所以這一段用一筆假想的貸款示範。';
  }
}

/* ---------- 讀數 ---------- */
const mGrace = makeCounter($('#m-r-grace'), (v) => money(Math.round(v)));
const mAfter = makeCounter($('#m-r-after'), (v) => money(Math.round(v)));
const mJump = makeCounter($('#m-r-jump'), (v) => (Math.abs(v) < 1 ? '無' : (v > 0 ? '+' : '') + money(Math.round(v))));
const mInterest = makeCounter($('#m-r-interest'), (v) => dec(v / 10000, 1) + '<small>萬</small>', { html: true });

const SERIES_COLORS = ['--series-1', '--series-2', '--series-3'];
let vtable = null;
let lastCliffMonth = null;
let mStampedFor = null;
let cliffRows = [];

function runScenario(sc) {
  const shockPP = (sc.shock || 0) * 0.25;
  const rateSegments = sc.rates
    .map((r) => ({ from: Math.max(1, Math.round(r.from)), rate: Math.max(0, r.rate + shockPP) / 100 }))
    .sort((a, b) => a.from - b.from);
  return amortize({
    principal: sc.amount,
    totalMonths: sc.months,
    graceMonths: sc.grace,
    rateSegments,
    extras: sc.extras,
    method: sc.method,
  });
}

/** 把某一聯（可能只存了差異）還原成完整的試算條件 */
function scenarioState(id) {
  const saved = store.at('scenarios')[id] || SCEN();
  const demo = demoCliff();
  const months = Math.max(1, Math.round(Number.isFinite(saved.months) ? saved.months : g('mortgageMonthsLeft', demo)));
  return {
    amount: Number.isFinite(saved.amount) ? saved.amount : g('mortgageBalance', demo),
    months,
    grace: clamp(Math.round(Number.isFinite(saved.grace) ? saved.grace : g('mortgageGraceLeft', demo)), 0, Math.min(60, months)),
    rates: saved.rates || [{ from: 1, rate: baseRate() }],
    method: saved.method || 'annuity',
    extras: saved.extras || [],
    shock: saved.shock || 0,
  };
}

function validateRates(s) {
  const sorted = [...s.rates].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].from === sorted[i - 1].from) return '有兩段利率從同一期開始，請改掉其中一段。';
    if (sorted[i].from > s.months) return `第 ${sorted[i].from} 期已超過剩餘總期數（${s.months} 期）。`;
  }
  return null;
}

function computeCliff({ from } = {}) {
  if (!RC) return;
  const s = cliffState();

  if (!(s.amount > 0) || !(s.months > 0)) {
    $('#m-verdict').hidden = true;
    $('#m-refuse').hidden = false;
    $('#m-refuseBody').textContent =
      '沒有貸款餘額或剩餘期數就畫不出月付金時間軸。把上面問你的那兩格填好，這一段馬上會有答案。';
    return;
  }
  $('#m-refuse').hidden = true;
  $('#m-verdict').hidden = false;

  const err = validateRates(s);
  $('#m-rateError').textContent = err || '';
  if (err) return;

  const active = runScenario(s);
  const ids = Object.keys(store.at('scenarios')).map(Number).sort((a, b) => a - b);
  const activeId = store.at('active');

  /* ---- 月付金時間軸：目前這一聯為實線，其餘為鬼影 ---- */
  const series = [];
  ids.forEach((id, idx) => {
    const isActive = id === activeId;
    const res = isActive ? active : runScenario(scenarioState(id));
    const color = isActive ? cssv(SERIES_COLORS[idx % 3]) : cssv('--ghost');
    const label = plies.items().find((p) => p.id === id)?.label || `情境 ${id}`;
    series.push({
      type: 'step',
      data: res.rows.map((r) => ({ x: r.m, y: r.payment })),
      color,
      width: isActive ? 2.5 : 1.5,
      dash: isActive ? null : [4, 3],
      noCursor: !isActive,
      label,
    });
  });
  $('#m-legend').innerHTML = ids.map((id, idx) => {
    const isActive = id === activeId;
    const color = isActive ? cssv(SERIES_COLORS[idx % 3]) : cssv('--ghost');
    const label = plies.items().find((p) => p.id === id)?.label || `情境 ${id}`;
    return `<span class="legend__item"><span class="legend__key${isActive ? '' : ' legend__key--dash'}" style="${isActive ? `background:${color}` : `color:${color}`}"></span>${label}</span>`;
  }).join('');

  plotPay.opts.xTickValues = yearTicks(s.months);
  plotSplit.opts.xTickValues = plotPay.opts.xTickValues;
  plotPay.setSeries(series, { animate: from === 'grace' || from === 'shock' });

  /* ---- 警戒線 ---- */
  const marks = [];
  if (s.income > 0) {
    for (const b of (RM?.burdenLines || [])) {
      marks.push({ axis: 'y', value: s.income * b.at, label: b.label, color: cssv('--warn'), dash: [6, 4] });
    }
  }
  if (active.cliff) marks.push({ axis: 'x', value: active.cliff.month, color: cssv('--up'), dash: [3, 3] });
  plotPay.setMarks(marks);

  /* ---- 本金／利息堆疊 ---- */
  const step = Math.max(1, Math.round(active.rows.length / 220));
  const sampled = active.rows.filter((_, i) => i % step === 0);
  plotSplit.setSeries([
    { type: 'stack', data: sampled.map((r) => ({ x: r.m, y: 0, y1: r.principal, color: cssv('--series-1') })), barRatio: 1 },
    { type: 'stack', data: sampled.map((r) => ({ x: r.m, y: r.principal, y1: r.principal + r.interest, color: cssv('--up') })), barRatio: 1 },
  ], { animate: false });

  /* ---- 讀數 ---- */
  const graceRow = active.rows.find((r) => r.grace);
  const afterRow = active.cliff ? active.rows[active.cliff.month - 1] : active.rows.find((r) => !r.grace);
  mGrace(graceRow ? graceRow.payment : (active.rows[0]?.payment ?? 0));
  mAfter(afterRow ? afterRow.payment : (active.rows[0]?.payment ?? 0));
  mJump(active.cliff ? active.cliff.delta : 0);
  mInterest(active.totalInterest);

  const jx = $('#m-r-jumpx');
  if (active.cliff) {
    jx.textContent = `${active.cliff.ratio.toFixed(2)} 倍`;
    jx.dataset.dir = 'up';
  } else { jx.textContent = ''; jx.dataset.dir = 'flat'; }

  renderCliffVerdict(s, active);

  lastCliffMonth = active.cliff ? active.cliff.month : null;
  positionCliffTag(active);

  cliffRows = active.rows;
  renderTable(s, active);
  renderCliffFormula(s, active);

  if (from) carbonTransfer($$('#sec-cliff [data-live]'));
}

function positionCliffTag(res) {
  if (!res || !res.cliff || $('#sec-cliff').hidden) { cliffTag.hidden = true; return; }
  const x = plotPay.sx(res.cliff.month);
  const y = plotPay.sy(res.cliff.after);
  cliffTag.hidden = false;
  cliffTag.textContent = `+${int(res.cliff.delta)} 元／${res.cliff.ratio.toFixed(2)} 倍`;
  const canvasTop = $('#m-chart').offsetTop;
  const flip = x > plotPay.w * 0.62;
  cliffTag.style.left = Math.max(4, Math.min(plotPay.w - 8, x + (flip ? -8 : 8))) + 'px';
  cliffTag.style.top = (canvasTop + Math.max(4, y - 30)) + 'px';
  cliffTag.style.transform = flip ? 'translateX(-100%)' : 'none';
}

function renderCliffVerdict(s, res) {
  const h = $('#m-verdict-h');
  const body = $('#m-verdictBody');
  const stamp = $('#m-stamp');
  const demo = demoCliff();
  const badge = demo ? '<span class="demo-badge">範例數字</span>' : '';

  if (!res.cliff) {
    h.innerHTML = (s.grace > 0 ? '這組條件下沒有斷崖' : '沒有寬限期，所以沒有斷崖') + badge;
    body.textContent = (demo ? '這是一組示範用的貸款，不是你的。把上面那幾格填掉就會換成你的。' : '')
      + (s.method === 'equalPrincipal'
        ? '本金平均攤還的月付金本來就逐月遞減，「斷崖」這個說法在這裡不成立。要看的是第一期的負擔，不是後面的跳升。'
        : `月付金從這一期到最後一期沒有出現超過 5% 的跳升。總利息 ${money(res.totalInterest, { compact: true })} 元。`);
    stamp.hidden = true;
    mStampedFor = null;
    return;
  }

  const c = res.cliff;
  const y = Math.floor((c.month - 1) / 12) + 1;
  const m = ((c.month - 1) % 12) + 1;
  h.innerHTML = `再過 <em>${y - 1}</em> 年 <em>${m}</em> 個月，月付金會從 ${int(Math.round(c.before))} 跳到 <em>${int(Math.round(c.after))}</em> 元。` + badge;

  const ratioBurden = s.income > 0 ? c.after / s.income : null;
  let tail = '';
  if (ratioBurden != null) {
    tail = ratioBurden >= 0.4
      ? `那一個月起，房貸會吃掉你 ${pct(ratioBurden, 0)} 的月收入，已經越過 40% 這條線。`
      : ratioBurden >= 0.33
        ? `那一個月起，房貸占月收入 ${pct(ratioBurden, 0)}，剛好落在 33% 到 40% 之間。`
        : `那一個月起，房貸占月收入 ${pct(ratioBurden, 0)}。`;
  }
  body.textContent = (demo ? '這是一組示範用的貸款，不是你的。把上面那幾格填掉就會換成你的。' : '')
    + `寬限期讓你接下來 ${fmtMonths(s.grace)}只繳利息，本金一塊都沒少，`
    + `所以期滿後要用剩下的期數還完全部本金。${tail}`;

  stamp.hidden = false;
  const key = `${c.month}:${Math.round(c.after)}`;
  if (mStampedFor !== key) {
    stamp.innerHTML = `<span class="stamp">斷崖 ${c.ratio.toFixed(2)} 倍</span>`;
    stampIn(stamp.firstElementChild);
    mStampedFor = key;
  }
}

function renderTable(s, res) {
  const wrap = $('#m-ledgerWrap');
  if (!vtable) {
    vtable = virtualTable(wrap, {
      rowHeight: 36,
      total: res.rows.length,
      render: (i) => {
        const r = cliffRows[i];
        if (!r) return null;
        const tr = el('tr', r.grace ? { 'data-mark': 'grace' } : {});
        tr.appendChild(el('td', { text: `${Math.floor((r.m - 1) / 12) + 1}-${String(((r.m - 1) % 12) + 1).padStart(2, '0')}` }));
        tr.appendChild(el('td', { text: int(Math.round(r.payment)) }));
        tr.appendChild(el('td', { text: int(Math.round(r.principal)) }));
        tr.appendChild(el('td', { class: 'is-down', text: int(Math.round(r.interest)) }));
        tr.appendChild(el('td', { text: r.extra ? int(Math.round(r.extra)) : '-' }));
        tr.appendChild(el('td', { text: int(Math.round(r.balance)) }));
        return tr;
      },
    });
  }
  cliffRows = res.rows;
  vtable.setTotal(res.rows.length);
  $('#m-tableFoot').innerHTML =
    `共 ${res.rows.length} 期${res.clearedEarly ? '（因額外還本提前結清）' : ''}．`
    + `總支出 ${int(Math.round(res.totalPaid))} 元．其中利息 ${int(Math.round(res.totalInterest))} 元`
    + `（占本金的 ${pct(res.totalInterest / s.amount, 1)}）．期別是「從現在起算的第幾年-第幾月」，不是原始貸款的第幾期。`;
}

$('#m-jumpCliff').addEventListener('click', () => {
  if (lastCliffMonth == null) { toast('這組條件沒有斷崖'); return; }
  $('#m-tableCard').scrollIntoView({ behavior: still() ? 'auto' : 'smooth', block: 'center' });
  vtable?.scrollToRow(lastCliffMonth - 1);
});

function renderCliffFormula(s, res) {
  const host = $('#m-formulaHost');
  host.replaceChildren();
  const shockPP = (s.shock || 0) * 0.25;
  const firstRate = (s.rates[0].rate + shockPP) / 100 / 12;
  const n = s.months - s.grace;

  host.appendChild(formulaBlock('攤開看：月付金是怎麼算出來的', [
    '<b>寬限期內</b> 每期只繳息 = 本金 × 月利率',
    `= ${int(s.amount)} × ${firstRate.toFixed(8)} = <b>${int(Math.round(s.amount * firstRate))}</b> 元`,
    '<b>期滿後</b> 以剩餘期數重算本息平均攤還月付金',
    'PMT = P·i ÷ (1 − (1+i)<sup>−n</sup>)',
    `P = ${int(s.amount)}　i = ${firstRate.toFixed(8)}（年利率 ${pp(s.rates[0].rate + shockPP, 3)} ÷ 12）　n = ${n}`,
    `= <b>${int(Math.round(res.rows.find((r) => !r.grace)?.payment || 0))}</b> 元`,
    `<b>升息換算</b> 1 碼 = ${pp(V('rateShockCode'), 2)}；目前套用 ${codes(s.shock)}（${pp(shockPP, 2, { sign: true })}）`,
  ], '寬限期只繳息、期滿以剩餘期數重算，是台灣房貸契約的通用作法。實際計息方式（每日／每月）與利率重訂頻率依各行庫契約而定。本頁以你檔案裡的「未償餘額」與「剩餘期數」起算，不是從原始撥款那一期起算。'));

  host.appendChild(formulaBlock('攤開看：額外還本的隱含報酬', [
    '提前還本省下的利息，等於把那筆錢用「貸款利率」無風險投資',
    `目前適用利率 = <b>${pp(s.rates[0].rate + shockPP, 3)}</b>`,
    `所以：只有當你能穩定拿到高於 ${pp(s.rates[0].rate + shockPP, 3)} 的稅後報酬，`,
    '不提前還本才划算。這不是投資建議，是一條算術上的等號。',
  ], null));
}

/* ---------- 圖表游標 ---------- */
plotPay.onCursor = (x, px) => {
  if (x == null) { tip.hide(); return; }
  const rows = cliffRows;
  if (!rows.length) { tip.hide(); return; }
  const m = clamp(Math.round(x), 1, rows.length);
  const r = rows[m - 1];
  if (!r) { tip.hide(); return; }
  const y = Math.floor((m - 1) / 12) + 1;
  const mm = ((m - 1) % 12) + 1;
  tip.show(
    `<b>第 ${y} 年 ${mm} 月</b><br>月付 ${int(Math.round(r.payment))}<br>`
    + `本金 ${int(Math.round(r.principal))}／利息 ${int(Math.round(r.interest))}<br>`
    + `剩餘 ${int(Math.round(r.balance))}`,
    px, plotPay.sy(r.payment) + $('#m-chart').offsetTop
  );
};

/* ==========================================================================
   10. 缺什麼問什麼
   ========================================================================== */
function mountAskBoxes() {
  askShared = askBox(NEED_SHARED, {
    title: '這一頁的兩段都要用到這一格',
    onReady: () => {},
  });
  $('#askShared').appendChild(askShared.el);

  askCeil = askBox(ASK_CEILING, {
    title: '再告訴我這幾件事，上面那個上限就換成你的',
  });
  $('#askCeiling').appendChild(askCeil.el);

  askCliffBox = askBox(ASK_CLIFF, {
    title: '再告訴我你這筆房貸的這幾格，斷崖就換成你的',
  });
  $('#askCliff').appendChild(askCliffBox.el);
}

function refreshAll() {
  askShared?.refresh();
  askCeil?.refresh();
  askCliffBox?.refresh();
  renderFileDrawer();
  renderFromLine();
  syncCeilInputs();
  syncCliffInputs();
  if (activeTab === 'ceiling') computeCeiling({ from: 'profile' });
  else computeCliff({ from: 'profile' });
}

/* ==========================================================================
   11. 啟動
   ========================================================================== */
function refuseNoRules(msg) {
  for (const id of ['c-verdict', 'm-verdict']) $('#' + id).hidden = true;
  for (const id of ['c-refuse', 'm-refuse']) $('#' + id).hidden = false;
  $('#c-refuseBody').textContent = msg;
  $('#m-refuseBody').textContent = msg;
  $('#dataver').textContent = '資料版本 載入失敗';
}

async function boot() {
  const grab = async (p) => { try { const r = await fetch(p); return r.ok ? await r.json() : null; } catch { return null; } };
  const [lending, mortgage, extra] = await Promise.all([
    grab('../../assets/data/tw-lending.json'),
    grab('../../assets/data/tw-mortgage.json'),
    grab('../afford-ceiling/rules.json'),
  ]);

  if (!lending || !mortgage || !extra) {
    refuseNoRules('法規常數檔載不進來，所以這一頁現在算不了。'
      + '這些數字（央行成數上限、DBR 倍數、契稅與印花稅稅率、房價負擔能力統計）不能用預設值猜，'
      + '猜出來的答案比沒有答案更糟。請重新整理，或確認你在連線狀態。');
    return;
  }

  RL = lending; RM = mortgage; RC = extra;

  // 共用資料層是唯一真相：assets/data 有的一律覆蓋過去，
  // rules.json 只補共用層還沒收錄的交易成本與各縣市統計（見 NEEDS.md）。
  RC.ltvSecondHome.value = RL.cbc.ltvCap2ndHome;
  RC.ltvThirdPlus.value = RL.cbc.ltvCap3rdHomeAndAbove;
  RC.ltvHighValueHousing.value = RL.cbc.ltvCapHighValueHousing;
  RC.dbrCap.value = RL.dbr.cap;
  RC.dbrCap.practiceRange = RL.dbr.practiceRange;
  RC.rateShockCode.value = RM.rateCodeStep;
  RC.affordability.quarter = RL.market115q1.quarter;
  RC.affordability.nationalMedianPrice = RL.market115q1.medianHousePriceNational;
  RC.affordability.fiveBankMortgageRate = RL.market115q1.big5BankNewMortgageRate;

  const bad = Object.values(RC).filter((v) => v && typeof v === 'object' && v.status === 'unverified').length;
  $('#dataver').textContent = `資料版本 ${RL.version}．未查證 ${bad} 項`;
  $('#dataver').title = RL.note || '';

  $('#c-legend').innerHTML =
    `<span class="legend__item"><span class="legend__key" style="background:${cssv('--up')}"></span>流入</span>`
    + `<span class="legend__item"><span class="legend__key" style="background:${cssv('--down')}"></span>流出</span>`
    + `<span class="legend__item"><span class="legend__key" style="background:${cssv('--accent')}"></span>剩餘</span>`;

  mountAskBoxes();
  renderFileDrawer();
  renderFromLine();
  syncCeilInputs();
  syncCliffInputs();

  // 兩段都先算一次，切過去才不會是空的
  computeCeiling();
  computeCliff();

  // 沒指定過就依他的處境挑一段：有房貸的人先看斷崖，其他人先看上限
  const first = store.at('tab') || (P.get('hasMortgage') === true ? 'cliff' : 'ceiling');
  showTab(first, { animate: false });

  P.subscribe(() => { refreshAll(); });

  printRows($$(`#sec-${activeTab} .readout`), { stagger: 0.06, delay: 0.1 });

  window.addEventListener('resize', () => {
    clearTimeout(window.__rz);
    window.__rz = setTimeout(() => {
      if (activeTab === 'cliff') computeCliff();
    }, 200);
  });

  if (store.cameFromLink) toast('已載入別人傳給你的情境');
}

boot();
