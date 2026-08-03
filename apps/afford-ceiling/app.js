window.addEventListener('error', (e) => { window.__err = String(e.message); });

import { gsap, printRows, stampIn, makeCounter, carbonTransfer, still } from '../../assets/js/core/motion.js';
import { Plot, niceTicks } from '../../assets/js/core/plot.js';
import { pmt, principalFromPmt } from '../../assets/js/core/fin.js';
import { createStore } from '../../assets/js/core/state.js';
import {
  $, $$, el, bindSlider, bindField, bindSegmented,
  mountTopbar, mountShare, mountTheme, toast, formulaBlock,
} from '../../assets/js/core/ui.js';
import { int, dec, pct, pp, months as fmtMonths, clamp } from '../../assets/js/core/format.js';

/* ==========================================================================
   1. 法規常數
   查不到官方全文的一律 status:"unverified"，畫面上會標「未查證」。
   這裡的預設值只是離線時的保底，rules.json 才是唯一真相。
   ========================================================================== */
let R = {
  version: '未載入',
  dbrCap: { value: 22, status: 'verified' },
  ltvFirstHomeNoProperty: { value: 0.8, status: 'unverified' },
  ltvSecondHome: { value: 0.6, status: 'verified' },
  ltvThirdPlus: { value: 0.3, status: 'verified' },
  ltvHighValueHousing: { value: 0.3, status: 'verified', thresholdStatus: 'unverified' },
  deedTaxRate: { value: 0.06, status: 'verified' },
  assessedValueRatioOfPrice: { value: 0.12, status: 'unverified' },
  stampTaxRate: { value: 0.001, status: 'verified' },
  publicContractRatioOfPrice: { value: 0.3, status: 'unverified' },
  agencyFeeBuyer: { value: 0.02, status: 'unverified' },
  scrivenerAndRegistryFee: { value: 25000, status: 'unverified' },
  settlingReserveRate: { value: 0.03, status: 'unverified' },
  rateShockCode: { value: 0.25, status: 'verified' },
  affordability: {
    quarter: '-', countyQuarter: '-', nationalMedianPrice: NaN, fiveBankMortgageRate: 2.318,
    counties: [], countyMedianPriceAvailable: false, countyMedianPriceNote: '',
  },
};

const V = (k) => R[k]?.value;
/** 未查證的項目在畫面上一律標出來，不藏 */
const EST = (k) => (R[k]?.status === 'verified' ? '' : '（未查證）');

const TIER = {
  first: { label: '名下無房', ltvKey: 'ltvFirstHomeNoProperty', grace: true },
  second: { label: '第 2 戶', ltvKey: 'ltvSecondHome', grace: false },
  third: { label: '第 3 戶以上', ltvKey: 'ltvThirdPlus', grace: false },
};

/* ==========================================================================
   2. 狀態
   ========================================================================== */
const DEFAULTS = {
  income1: 65000,
  income2: 45000,
  bonus: false,
  bonusMonths: 2,
  living: 45000,
  savings: 4000000,
  debtPmt: 8000,
  debtBal: 400000,
  tier: 'first',
  years: 30,
  rate: 2.318,
  dsr: 40,
  keep: 10000,
  reno: 600000,
  grace: false,
  childCost: 15000,
  sRate: false,
  sJobless: false,
  sChild: false,
};

const store = createStore('vm:afford-ceiling', { ...DEFAULTS });

/* ==========================================================================
   3. 版面掛載
   ========================================================================== */
mountTopbar({ title: '買房預算天花板壓力測試' });
const actions = $('#sheetActions');
mountShare(actions, store);
mountTheme(actions);

const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// 寬限期提示：不動上限，只揭露它真正做了什麼
const graceNote = el('div', { class: 'note note--warn', id: 'graceNote', hidden: true, style: 'margin-top:var(--s-4)' });
$('#readouts').after(graceNote);

/* ==========================================================================
   4. 招牌視覺：月現金流瀑布
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
    this._onTheme = () => this.render();
    this._mq.addEventListener('change', this._onTheme);
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

const fall = new Waterfall($('#fall'));

/* 自備款曲線：兩條限制線的轉折點，就是「再存下去也沒用了」的位置 */
const plot2 = new Plot($('#chart2'), {
  aspect: 0.42,
  minHeight: 180,
  yFormat: (v) => (v >= 10000 ? Math.round(v / 10000) + '萬' : String(Math.round(v))),
  xFormat: (v) => (v >= 10000 ? Math.round(v / 10000) + '萬' : String(Math.round(v))),
  padding: { left: 54, bottom: 28, top: 14, right: 14 },
});

/* ==========================================================================
   5. 計算
   關鍵法規修正：DBR 22 倍規範的是無擔保債務，房貸是有擔保債務，
   因此 debtBal 永遠不會出現在任何一條推算房價上限的算式裡。
   ========================================================================== */
const VAR_RATE = () =>
  V('deedTaxRate') * V('assessedValueRatioOfPrice')      // 契稅（稅基是房屋評定現值）
  + V('stampTaxRate') * V('publicContractRatioOfPrice')  // 印花稅（稅基是公契金額）
  + V('agencyFeeBuyer')                                  // 買方仲介報酬
  + V('settlingReserveRate');                            // 交屋後週轉金

const FIXED_FEE = () => V('scrivenerAndRegistryFee');

/** 家庭認列月收入。年終預設不攤，因為銀行多以固定薪資認列。 */
function grossIncome(s) {
  const base = Math.max(0, s.income1) + Math.max(0, s.income2);
  return s.bonus ? base * (1 + Math.max(0, s.bonusMonths) / 12) : base;
}

/**
 * 由「可承受月付」反解房價上限。
 * @param {object} s 使用者輸入
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

/* ==========================================================================
   6. 輸入元件
   ========================================================================== */
const S = () => store.get();
function patch(p, opts = {}) { store.set(p); compute(opts); }

const sIncome1 = bindSlider($('#s-income1'), {
  format: (v) => `${int(v)}<small>元</small>`,
  onInput: (v) => patch({ income1: v }, { from: 'slide' }),
});
const sLiving = bindSlider($('#s-living'), {
  format: (v) => `${int(v)}<small>元</small>`,
  onInput: (v) => patch({ living: v }, { from: 'slide' }),
});
const sSavings = bindSlider($('#s-savings'), {
  format: (v) => `${dec(v / 10000, 0)}<small>萬</small>`,
  onInput: (v) => patch({ savings: v }, { from: 'slide' }),
});
const sDsr = bindSlider($('#s-dsr'), {
  format: (v) => `${v}<small>%</small>`,
  onInput: (v) => patch({ dsr: v }, { from: 'slide' }),
});

const fIncome2 = bindField($('#f-income2'), {
  pretty: int,
  validate: (v) => (Number.isFinite(v) && v >= 0 ? null : '請填 0 或正數'),
  onChange: (v, { valid }) => { if (valid) patch({ income2: v }); },
});
const fDebtPmt = bindField($('#f-debtPmt'), {
  pretty: int,
  validate: (v) => (Number.isFinite(v) && v >= 0 ? null : '請填 0 或正數'),
  onChange: (v, { valid }) => { if (valid) patch({ debtPmt: v }); },
});
const fDebtBal = bindField($('#f-debtBal'), {
  pretty: int,
  validate: (v) => (Number.isFinite(v) && v >= 0 ? null : '請填 0 或正數'),
  onChange: (v, { valid }) => { if (valid) patch({ debtBal: v }); },
});
const fYears = bindField($('#f-years'), {
  validate: (v) => {
    if (!Number.isFinite(v) || v < 1) return '年限至少 1 年';
    if (v > 40) return '房貸年限最長 40 年';
    return null;
  },
  onChange: (v, { valid }) => { if (valid) patch({ years: Math.round(v) }); },
});
const fRate = bindField($('#f-rate'), {
  validate: (v) => {
    if (!Number.isFinite(v) || v < 0) return '請填 0 或正數';
    if (v > 20) return '這個利率超出試算範圍';
    return null;
  },
  onChange: (v, { valid }) => { if (valid) patch({ rate: v }); },
});
const fKeep = bindField($('#f-keep'), {
  pretty: int,
  validate: (v) => (Number.isFinite(v) && v >= 0 ? null : '請填 0 或正數'),
  onChange: (v, { valid }) => { if (valid) patch({ keep: v }); },
});
const fReno = bindField($('#f-reno'), {
  pretty: int,
  validate: (v) => (Number.isFinite(v) && v >= 0 ? null : '請填 0 或正數'),
  onChange: (v, { valid }) => { if (valid) patch({ reno: v }); },
});

const segTier = bindSegmented($('#seg-tier'), {
  onChange: (v) => { patch({ tier: v }); },
});

$('#ck-bonus').addEventListener('change', (e) => patch({ bonus: e.target.checked }));
$('#ck-grace').addEventListener('change', (e) => patch({ grace: e.target.checked }));

$$('.stress').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = { rate: 'sRate', jobless: 'sJobless', child: 'sChild' }[btn.dataset.stress];
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    patch({ [key]: on }, { from: 'stress' });
  });
});

$('#resetBtn').addEventListener('click', () => {
  store.replace({ ...DEFAULTS });
  location.replace(location.pathname);
});

function syncInputs() {
  const s = S();
  sIncome1.set(s.income1, { silent: true });
  sLiving.set(s.living, { silent: true });
  sSavings.set(s.savings, { silent: true });
  sDsr.set(s.dsr, { silent: true });
  fIncome2.set(s.income2, { silent: true });
  fDebtPmt.set(s.debtPmt, { silent: true });
  fDebtBal.set(s.debtBal, { silent: true });
  fYears.set(s.years, { silent: true });
  fRate.set(s.rate, { silent: true });
  fKeep.set(s.keep, { silent: true });
  fReno.set(s.reno, { silent: true });
  segTier.set(s.tier);
  $('#ck-bonus').checked = !!s.bonus;
  $('#bonusM').textContent = String(s.bonusMonths);
  $('#ck-grace').checked = !!s.grace;
  $$('.stress').forEach((b) => {
    const key = { rate: 'sRate', jobless: 'sJobless', child: 'sChild' }[b.dataset.stress];
    b.setAttribute('aria-pressed', String(!!s[key]));
  });
}

/* ==========================================================================
   7. 讀數
   ========================================================================== */
const cPrice = makeCounter($('#r-price'), (v) => (v > 0 ? dec(v / 10000, 0) + '<small>萬</small>' : '-'), { html: true });
const cLoan = makeCounter($('#r-loan'), (v) => (v > 0 ? dec(v / 10000, 0) + '<small>萬</small>' : '-'), { html: true });
const cDsr = makeCounter($('#r-dsr'), (v) => (Number.isFinite(v) ? dec(v, 1) + '<small>%</small>' : '-'), { html: true });
const cGauge = makeCounter($('#gaugeValue'), (v) => (v > 0 ? dec(v / 10000, 0) + '<small>萬</small>' : '-'), { html: true });
const cDbr = makeCounter($('#r-dbr'), (v) => (Number.isFinite(v) ? dec(v, 1) + '<small>倍</small>' : '-'), { html: true });

/* ==========================================================================
   8. 主流程
   ========================================================================== */
let stampedFor = null;

function compute({ from } = {}) {
  const s = S();

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
    renderRefuse(s, base.refuse ? base : shown);
    return;
  }
  $('#refuse').hidden = true;
  $('#verdict').hidden = false;

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
  $('#fall').setAttribute('aria-label',
    `月現金流瀑布：收入 ${int(Math.round(incomeNow))} 元，扣掉房貸 ${int(Math.round(pmtNow))} 元、`
    + `既有負債 ${int(base.debtPmt)} 元、生活支出 ${int(s.living)} 元`
    + (child ? `、育兒 ${int(child)} 元` : '') + `，${restTxt}。`);
  $('#fallDesc').innerHTML =
    `第一段是收入（流入為紅），中間每一段是被扣掉的錢（流出為綠），最後一段是剩餘。`
    + `這張圖固定畫在「沒有壓力時的上限房價 ${dec(base.price / 10000, 0)} 萬」上，你照那個上限出價之後，`
    + `壓力才發生。目前<b>${restTxt}</b>。`;

  /* ---- 量表：長度＝上限，顏色＝剩餘率（連續過渡，不跳段） ---- */
  renderGauge(shown.price);

  /* ---- 讀數 ---- */
  cPrice(shown.price);
  cLoan(shown.loan);
  cDsr((pmtNow / (base.M || 1)) * 100);
  cGauge(shown.price);

  const dsrRatio = pmtNow / (base.M || 1);
  const line = $('#r-dsrline');
  line.textContent = dsrRatio >= 0.6 ? '已越過 60%'
    : dsrRatio >= 0.4 ? '已越過 40%'
      : dsrRatio >= 0.33 ? '在 33%-40% 之間' : '在 33% 以下';
  line.dataset.dir = dsrRatio >= 0.4 ? 'up' : dsrRatio >= 0.33 ? 'flat' : 'down';

  const cashLeft = s.savings - (base.price * (1 - base.ltv) + base.price * base.varRate + base.fixedFee + s.reno);
  const monthlyOut = pmtNow + base.debtPmt + s.living + child;
  const runway = monthlyOut > 0 ? Math.max(0, cashLeft) / monthlyOut : 0;
  $('#r-runway').innerHTML = cashLeft <= 0
    ? '0<small>個月</small>'
    : `${dec(runway, 1)}<small>個月</small>`;

  /* ---- DBR：獨立檢核，永遠不進上限算式 ---- */
  renderDbr(s);

  /* ---- 結論 ---- */
  renderVerdict(s, base, stressed, shown, rest, anyStress, k);

  /* ---- 寬限期：不動上限 ---- */
  renderGrace(s, base);

  /* ---- 三檔對照 ---- */
  renderLevels(s);

  /* ---- 自備款曲線與拆解 ---- */
  renderSavingsCurve(s, base);
  renderCosts(s, base);

  /* ---- 房價所得比對照 ---- */
  renderPir(s, base, shown);

  /* ---- 公式 ---- */
  renderFormula(s, base, stressed);

  if (from) carbonTransfer($$('[data-live]'));
}

/* ---------- 拒答 ---------- */
function renderRefuse(s, res) {
  $('#verdict').hidden = true;
  $('#refuse').hidden = false;
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
  $('#refuseBody').textContent = body;

  cPrice(0); cLoan(0); cGauge(0);
  $('#r-dsr').textContent = '-';
  $('#r-dsrline').textContent = '';
  $('#r-runway').textContent = '-';
  renderGauge(0);
  fall.setBars([]);
  renderDbr(s);
}

/* ---------- 量表 ---------- */
function renderGauge(price) {
  const median = R.affordability.nationalMedianPrice;
  const candidates = [5e6, 1e7, 1.5e7, 2e7, 3e7, 5e7, 8e7, 1.2e8, 2e8];
  const want = Math.max(price, Number.isFinite(median) ? median : 0) * 1.25 || 1e7;
  const max = candidates.find((c) => c >= want) || 2e8;

  $('#gaugeFill').style.width = clamp((price / max) * 100, 0, 100) + '%';
  const med = $('#gaugeMedian');
  if (Number.isFinite(median) && median > 0 && median <= max) {
    const at = median / max;
    med.hidden = false;
    med.style.left = (at * 100) + '%';
    // 標記靠右時把標籤翻到左邊，否則會頂破單據右緣
    med.classList.toggle('gauge__median--flip', at > 0.55);
    med.querySelector('.gauge__medianLabel').textContent = `全國中位數 ${dec(median / 10000, 0)} 萬`;
  } else { med.hidden = true; }

  $('#gaugeScale').innerHTML =
    `<span>0</span><span>${dec(max / 2 / 10000, 0)} 萬</span><span>${dec(max / 10000, 0)} 萬</span>`;

  // 量表只畫「上限有多高」，顏色一律是強調色。
  // 這裡本來是一條綠→黃→紅的紅綠燈，但它跟正下方的瀑布互相矛盾：
  // 瀑布用台灣制的漲紅跌綠（紅＝流入、綠＝流出），紅綠燈卻是紅＝危險、綠＝安全，
  // 同一張卡上兩種相反的解讀。安不安全已經由硃砂章（撐得住／很勉強／撐不住）、
  // 結論文字，以及瀑布裡沉到零線以下的「剩餘」那一段講清楚了，不需要再用色相講第三次。
}

/* ---------- DBR ---------- */
function renderDbr(s) {
  const inc = Math.max(0, s.income1);
  const cap = V('dbrCap');
  if (!(inc > 0)) {
    cDbr(NaN);
    $('#r-dbrgap').textContent = '-';
    $('#dbrVerdict').textContent = 'DBR 以「申貸人本人」的平均月收入計算，本人月薪填 0 就算不出來。';
    return;
  }
  const dbr = Math.max(0, s.debtBal) / inc;
  cDbr(dbr);
  const room = (cap - dbr) * inc;
  $('#r-dbrgap').innerHTML = dbr >= cap
    ? '<span class="is-up">已超過</span>'
    : `${dec(room / 10000, 0)}<small>萬</small>`;
  $('#dbrVerdict').innerHTML = dbr >= cap
    ? `<b>你的無擔保負債 ${int(s.debtBal)} 元 ÷ 本人月薪 ${int(inc)} 元 = ${dec(dbr, 1)} 倍，已經觸及 22 倍。</b>`
      + '這會卡住你再申辦信貸或信用卡的空間，銀行核房貸時也會看到這筆紀錄，'
      + '但它<b>不是</b>房貸額度的計算基礎。'
    : `你的無擔保負債 ${int(s.debtBal)} 元 ÷ 本人月薪 ${int(inc)} 元 = <b>${dec(dbr, 1)} 倍</b>，`
      + `距離 22 倍還有約 ${int(Math.round(room))} 元的無擔保空間。`
      + '再強調一次：這個空間<b>不能</b>拿來加大房貸額度，它們是兩套規範。';
}

/* ---------- 結論 ---------- */
function renderVerdict(s, base, stressed, shown, rest, anyStress, k) {
  const h = $('#verdict-h');
  const body = $('#verdictBody');
  const stamp = $('#verdictStamp');
  const median = R.affordability.nationalMedianPrice;

  const boundTxt = shown.bound === 'income'
    ? '卡住你的是收入：月付佔所得的上限先到頂，再多的自備款也推不上去。'
    : '卡住你的是自備款：收入還撐得住更貴的房子，但頭期與過戶成本先把錢用完了。';

  h.innerHTML = anyStress
    ? `壓力之下，上限從 ${dec(base.price / 10000, 0)} 萬掉到 <em>${dec(shown.price / 10000, 0)} 萬</em>元。`
    : `以你現在的條件，安全的房價上限是 <em>${dec(base.price / 10000, 0)} 萬</em>元。`;

  const parts = [];
  parts.push(boundTxt);
  if (Number.isFinite(median) && median > 0) {
    const gap = Math.abs(median - shown.price);
    const gapTxt = dec(gap / 10000, gap < 1000000 ? 1 : 0);
    parts.push(shown.price >= median
      ? `這個上限高於全國中位數住宅價格 ${dec(median / 10000, 0)} 萬元（${R.affordability.quarter}），高出 ${gapTxt} 萬。`
      : `這個上限低於全國中位數住宅價格 ${dec(median / 10000, 0)} 萬元（${R.affordability.quarter}），差 ${gapTxt} 萬。`);
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
  const actions = [];
  const step = 1000000;
  const bump = ceiling({ ...s, savings: s.savings + step }, k);
  if (bump.price > shown.price + 1000) {
    actions.push(`自備款每多 ${dec(step / 10000, 0)} 萬，上限往上 ${dec((bump.price - shown.price) / 10000, 1)} 萬`);
  } else {
    actions.push('自備款再加也沒用了，上限已經被收入鎖死');
  }
  if (s.debtPmt > 0) {
    const clear = ceiling({ ...s, debtPmt: 0 }, k);
    actions.push(`清掉那筆每月 ${int(s.debtPmt)} 元的無擔保負債，上限往上 ${dec(Math.max(0, clear.price - shown.price) / 10000, 1)} 萬`);
  }
  parts.push('可以動的地方：' + actions.join('；') + '。');

  // 每一句都是獨立的因果陳述，用 span 隔開才不會黏成一團
  body.innerHTML = parts.map((p) => `<span>${p}</span>`).join(' ');

  const key = `${Math.round(shown.price / 10000)}:${rest < 0}:${anyStress}`;
  stamp.hidden = false;
  if (stampedFor !== key) {
    const cls = rest < 0 ? 'stamp' : rest < base.M * 0.08 ? 'stamp' : 'stamp stamp--ok';
    const txt = rest < 0 ? '撐不住' : rest < base.M * 0.08 ? '很勉強' : '撐得住';
    stamp.innerHTML = `<span class="${cls}">${txt}</span>`;
    stampIn(stamp.firstElementChild);
    stampedFor = key;
  }
}

/* ---------- 寬限期：絕不用來撐高上限 ---------- */
function renderGrace(s, base) {
  const note = $('#graceNote');
  if (!s.grace) { note.hidden = true; return; }
  note.hidden = false;
  const allowed = TIER[s.tier].grace;
  const i = base.i;
  const graceMonths = 36;
  const interestOnly = base.loan * i;
  const after = pmt(base.loan, i, base.n - graceMonths);
  note.innerHTML =
    `<p><b>寬限期沒有讓上面那個上限多出一塊錢，這是刻意的。</b></p>`
    + `<p>寬限期是現金流的時間平移，不是還款能力。前 3 年只繳息 `
    + `<b>${int(Math.round(interestOnly))}</b> 元／月，期滿後要用剩下的 ${fmtMonths(base.n - graceMonths)} 還完全部本金，`
    + `月付變成 <b>${int(Math.round(after))}</b> 元，比本息攤還的 ${int(Math.round(base.pmt))} 元還高 `
    + `${int(Math.round(after - base.pmt))} 元。用寬限期換來的額度，是把跳升往後推，不是把負擔變小。</p>`
    + (allowed
      ? `<p>提醒：名下已有房屋者的第 1 戶購屋貸款依央行規定<b>不得有寬限期</b>${EST('noGraceFirstHomeWithProperty')}。`
        + `你選的是「名下無房」，才有這個選項。</p>`
      : `<p><b>而且你選的是「${TIER[s.tier].label}」，依央行選擇性信用管制根本不得有寬限期${EST('noGraceSecondHome')}。</b>`
        + `這一段只是讓你看見它的代價，不是可行方案。</p>`);
}

/* ---------- 三檔對照 ---------- */
function renderLevels(s) {
  const host = $('#levelBody');
  host.replaceChildren();
  const levels = [
    { at: 0.33, label: '33% 保守' },
    { at: 0.40, label: '40% 一般' },
    { at: 0.60, label: '60% 銀行極限' },
  ];
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
  // x 軸取轉折點的 1.5 倍，讓那個轉角落在畫面中段而不是被推到角落。
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
  plot2.setSeries([
    { type: 'line', data: byIncome, color: cssv('--series-1'), width: 1.5, dash: [5, 4], noCursor: true },
    { type: 'line', data: bySavings, color: cssv('--series-4'), width: 1.5, dash: [5, 4], noCursor: true },
    { type: 'line', data: actual, color: cssv('--accent'), width: 3 },
  ], { animate: false });
  plot2.setMarks([{ axis: 'x', value: s.savings, label: '你現在', color: cssv('--stamp'), dash: [3, 3] }]);

  $('#legend2').innerHTML =
    `<span class="legend__item"><span class="legend__key legend__key--dash" style="color:${cssv('--series-1')}"></span>收入撐得起的上限</span>`
    + `<span class="legend__item"><span class="legend__key legend__key--dash" style="color:${cssv('--series-4')}"></span>自備款撐得起的上限</span>`
    + `<span class="legend__item"><span class="legend__key" style="background:${cssv('--accent')}"></span>兩者取小＝真正的上限</span>`;

  $('#chart2Desc').innerHTML = base.bound === 'savings'
    ? `橫軸是自備款，縱軸是房價上限。你現在在轉折點左邊：自備款存到 <b>${dec(kink / 10000, 0)} 萬</b>，`
      + `上限會頂到收入撐得起的 ${dec(base.priceByIncome / 10000, 0)} 萬；再多存就不會再往上了。`
    : `橫軸是自備款，縱軸是房價上限。你已經在轉折點右邊（自備款 ${dec(kink / 10000, 0)} 萬以上），`
      + `上限被收入鎖在 ${dec(base.priceByIncome / 10000, 0)} 萬，再存也不會往上。要動的是收入或既有負債。`;
  $('#chart2').setAttribute('aria-label', $('#chart2Desc').textContent);
}

/* ---------- 自備款拆解 ---------- */
function renderCosts(s, base) {
  const host = $('#costBody');
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
  $('#costTotal').textContent = int(Math.round(total));
  // 這張表跟瀑布圖用同一個房價，否則兩張圖會講不同的故事
  $('#costFoot').innerHTML =
    `以「沒有壓力時的上限房價 <b>${dec(base.price / 10000, 0)} 萬</b>」計算，跟上面的現金流瀑布是同一個價位。`
    + `合計 ${int(Math.round(total))} 元，你填的自備款是 ${int(s.savings)} 元。`
    + `契稅與印花稅的稅基是<b>房屋評定現值與公契金額</b>，不是成交價；本表以估計比例換算，`
    + `標「估」的項目請當成量級而不是報價。`;
}

/* ---------- 房價所得比對照 ---------- */
function renderPir(s, base, shown) {
  const a = R.affordability;
  // 各縣市分表與全國數是不同季別，標題只能標分表那一季，不能借用全國那一季
  const cq = a.countyQuarter || a.quarter;
  $('#pirQuarter').textContent = (cq && cq.length > 1) ? `各縣市分表 ${cq}` : '統計季別 未載入';
  const yearIncome = base.M * 12;
  const yourPir = yearIncome > 0 ? shown.price / yearIncome : NaN;

  $('#pirLede').innerHTML = Number.isFinite(yourPir)
    ? `你的上限 ${dec(shown.price / 10000, 0)} 萬 ÷ 家庭年收入 ${dec(yearIncome / 10000, 0)} 萬 = <b>${dec(yourPir, 2)} 倍</b>。`
      + `下表是各縣市的中位數家庭買中位數住宅，要花掉幾倍的年所得。你的倍數比某個縣市大，就表示以你的所得比例，那裡的中位數住宅買得起。`
    : '填入收入後，這裡會把你的上限換算成房價所得比。';

  const host = $('#pirBody');
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
  $('#pirFoot').innerHTML =
    `${a.method || ''}<br>${a.countyMedianPriceNote || ''}`
    + (a.countyNote ? `<br>${a.countyNote}` : '')
    + `<br>來源：內政部不動產資訊平台 房價負擔能力指標統計成果（各縣市分表 ${cq}；全國數 ${a.quarter}）。`;
}

/* ---------- 公式抽屜 ---------- */
function renderFormula(s, base, stressed) {
  const host = $('#formulaHost');
  host.replaceChildren();

  host.appendChild(formulaBlock('攤開看：房價上限是怎麼反解出來的', [
    `<b>第一步</b> 可承受月付＝min(收入×比率上限 − 既有負債月付, 收入 − 既有負債 − 生活支出 − 每月至少留下)`,
    `= min(${int(Math.round(base.M))}×${pct(base.dsrCap, 0)} − ${int(base.debtPmt)},　${int(Math.round(base.M))} − ${int(base.debtPmt)} − ${int(base.living)} − ${int(s.keep)})`,
    `= min(${int(Math.round(base.capByDsr))},　${int(Math.round(base.capByFlow))}) = <b>${int(Math.round(base.pmtCap))}</b> 元`,
    `<b>第二步</b> 由月付反解本金　P = PMT × (1 − (1+i)<sup>−n</sup>) ÷ i`,
    `i = ${pp(base.rate, 3)} ÷ 12 = ${base.i.toFixed(8)}　n = ${base.n}`,
    `P = <b>${int(Math.round(base.loanByIncome))}</b> 元`,
    `<b>第三步</b> 房價上限 = min(可貸金額 ÷ 成數上限,　可用自備款 ÷ (1 − 成數上限 + 交易成本率))`,
    `成數上限 = ${pct(base.ltv, 0)}${EST(TIER[s.tier].ltvKey)}　交易成本率 = ${pct(base.varRate, 2)}（含契稅估、印花稅估、仲介、週轉金）`,
    `= min(${int(Math.round(base.priceByIncome))},　${int(Math.round(base.priceBySavings))}) = <b>${int(Math.round(base.price))}</b> 元`,
  ], `成數上限依央行選擇性信用管制；${R.ltvSecondHome?.legalBasis || ''}　交易成本率中的契稅與印花稅稅基是評定現值與公契金額，本工具以估計比例換算，標「未查證」者請自行確認。`));

  host.appendChild(formulaBlock('攤開看：DBR 22 倍為什麼不能拿來算房貸', [
    `DBR = 全體金融機構<b>無擔保</b>債務歸戶總餘額 ÷ 平均月收入`,
    `= ${int(s.debtBal)} ÷ ${int(Math.max(0, s.income1))} = <b>${s.income1 > 0 ? dec(s.debtBal / s.income1, 2) : '-'}</b> 倍　（上限 ${V('dbrCap')} 倍）`,
    `無擔保債務 = 信用卡 + 現金卡 + 信用貸款。<b>房貸不在其中</b>，因為它有房子當抵押品。`,
    `所以「月收入 × 22 = 我的房貸額度」這個算法沒有法源依據，本工具任何一條算式都沒有用到它。`,
    `房貸端真正的限制：月付／所得比、貸款成數上限、央行選擇性信用管制（第幾戶、能否寬限）。`,
    Array.isArray(R.dbrCap?.practiceRange)
      ? `而且 ${V('dbrCap')} 倍的用語是「<b>不宜</b>超過」，是監理指導不是硬性上限；`
        + `銀行實務常見的內部控管帶約 <b>${R.dbrCap.practiceRange[0]}～${R.dbrCap.practiceRange[1]} 倍</b>，沒到 ${V('dbrCap')} 倍就可能被婉拒。`
      : '',
  ].filter(Boolean), `${R.dbrCap?.legalBasis || ''}　出處：<a href="${R.dbrCap?.sourceUrl || '#'}" target="_blank" rel="noopener">金管會主管法規共用系統</a>`));

  const drop = base.price - stressed.price;
  host.appendChild(formulaBlock('攤開看：三個壓力情境各自做了什麼', [
    `<b>升息 2 碼</b>　利率 +${pp(V('rateShockCode') * 2, 2)} 後重算月付與可貸本金`,
    `<b>失業 6 個月</b>　要求保留 6 × 月支出的緊急預備金，自自備款扣除後重算上限`,
    `　目前要求保留 <b>${int(Math.round(stressed.fund))}</b> 元`,
    `<b>多一個小孩</b>　每月支出 +${int(s.childCost)} 元，壓縮「收入 − 支出」那一條上限`,
    `目前開啟的壓力讓上限變動 <b>${drop === 0 ? '0' : int(Math.round(-drop))}</b> 元`,
  ], '緊急預備金的月支出包含房貸月付、既有負債月付與生活支出；因為月付本身取決於房價，這裡用不動點迭代收斂。'));

  const unverified = Object.entries(R)
    .filter(([, v]) => v && typeof v === 'object' && v.status === 'unverified')
    .map(([k, v]) => `<b>${v.label || k}</b>：${v.legalBasis || '無法源'}`);
  host.appendChild(formulaBlock(`攤開看：哪些數字是查證過的、哪些不是（${unverified.length} 項未查證）`, [
    `<b>已查證</b>　DBR ${V('dbrCap')} 倍（金管會函釋）、第 2 戶成數 ${pct(V('ltvSecondHome'), 0)}、`
      + `第 3 戶以上成數 ${pct(V('ltvThirdPlus'), 0)}、高價住宅成數 ${pct(V('ltvHighValueHousing'), 0)}（央行規定，115.3.20 生效）、`,
    `　契稅 6%（契稅條例第 3 條）、印花稅 0.1%（印花稅法第 7 條）、房價負擔能力統計（內政部 ${R.affordability.quarter}）`,
    `　「特定地區」差別成數制度已於 113.9.20 廢除，改為全國一體適用，所以本工具沒有、也不該有「是否為特定地區」這個選項。`,
    `<b>成數已查證、門檻仍未查證</b>　${R.ltvHighValueHousing?.thresholdNote || '高價住宅的認定金額門檻未取得官方明文。'}`,
    `<b>未查證</b>`,
    ...unverified,
  ], '未查證＝本工具查不到官方全文或該項本來就不是法規數字（市場慣例、銀行內部政策）。這些項目請以承貸銀行與主管機關公告為準。'));
}

/* ==========================================================================
   9. 啟動
   ========================================================================== */
async function boot() {
  try {
    const res = await fetch('./rules.json');
    if (res.ok) {
      R = { ...R, ...(await res.json()) };
      const bad = Object.values(R).filter((v) => v && typeof v === 'object' && v.status === 'unverified').length;
      $('#dataver').textContent = `資料版本 ${R.version}．未查證 ${bad} 項`;
      $('#dataver').title = R.note || '';
      // 利率預設值跟著內政部採用的五大銀行新承做購屋貸款利率走
      const fb = R.affordability?.fiveBankMortgageRate;
      if (Number.isFinite(fb) && !store.cameFromLink && S().rate === DEFAULTS.rate) {
        store.set({ rate: fb }, { silent: true });
      }
    }
  } catch { $('#dataver').textContent = '資料版本 離線'; }

  $('#tierHint').innerHTML = [
    `名下無房：不受央行成數管制，本工具以 ${pct(V('ltvFirstHomeNoProperty'), 0)} 估算${EST('ltvFirstHomeNoProperty')}。`,
    `第 2 戶：成數上限 ${pct(V('ltvSecondHome'), 0)}、不得有寬限期${EST('ltvSecondHome')}。`,
    `第 3 戶以上：成數上限 ${pct(V('ltvThirdPlus'), 0)}、不得有寬限期${EST('ltvThirdPlus')}。`,
  ].join('<br>');

  $('#legend').innerHTML =
    `<span class="legend__item"><span class="legend__key" style="background:${cssv('--up')}"></span>流入</span>`
    + `<span class="legend__item"><span class="legend__key" style="background:${cssv('--down')}"></span>流出</span>`
    + `<span class="legend__item"><span class="legend__key" style="background:${cssv('--accent')}"></span>剩餘</span>`;

  syncInputs();
  compute();

  printRows($$('#readouts .readout'), { stagger: 0.06, delay: 0.1 });

  if (store.cameFromLink) toast('已載入別人傳給你的情境');
}

boot();
