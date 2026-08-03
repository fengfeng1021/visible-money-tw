/* 自檢用：把執行期錯誤留一份給 probe 讀，使用者端完全無感。 */
window.addEventListener('error', (e) => { window.__err = String(e.message); });

import { printRows, stampIn, makeCounter, carbonTransfer, flagCross } from '../../assets/js/core/motion.js';
import { Plot } from '../../assets/js/core/plot.js';
import { progressiveTax, nhiSupplement } from '../../assets/js/core/fin.js';
import { createStore } from '../../assets/js/core/state.js';
import {
  $, $$, el, iconHTML, bindSlider, bindField, bindSegmented,
  mountTopbar, mountShare, mountTheme, toast, formulaBlock, createTip,
} from '../../assets/js/core/ui.js';
import { int, dec, pp, parseNum, clamp } from '../../assets/js/core/format.js';

/* ==========================================================================
   1. 法規常數
   一律外部化到 rules.json：級距、扣除額、費率都由主管機關公告調整，
   寫死等於慢性錯誤。載入失敗時用同一份數字的備援，並在徽章上說出來。
   ========================================================================== */
let RULES = {
  version: '未載入',
  years: {
    115: {
      label: '115 年度（116 年 5 月申報）',
      exemption: 101000, exemption70: 151500,
      standardSingle: 136000, standardCouple: 272000,
      salaryCap: 227000, disabledCap: 227000, savingsCap: 270000, mortgageCap: 300000,
      longTermCareCap: 180000, rentCap: 180000,
      basicLiving: null,
      brackets: [
        { upTo: 610000, rate: 0.05, quick: 0 },
        { upTo: 1380000, rate: 0.12, quick: 42700 },
        { upTo: 2770000, rate: 0.20, quick: 153100 },
        { upTo: 5190000, rate: 0.30, quick: 430100 },
        { upTo: null, rate: 0.40, quick: 949100 },
      ],
    },
  },
  dividend: {
    creditRate: 0.085, creditCap: 80000, separateRate: 0.28,
    separateForfeitsDeductions: ['longTermCare', 'rentDeduction'],
  },
  nhi: { rate: 0.0211, floor: 20000, singleCap: 10000000 },
  nhiAnnualSandbox: { rate: 0.0211, annualFloor: 20000, annualCap: 50000000, haltedOn: '2025-11-06' },
  official: { url: 'https://tax.nat.gov.tw/', label: '財政部電子申報繳稅服務網' },
};

/* 首屏就是論點：預設值必須讓分界線、折點與「你在這裡」同時進畫面，
   而且那一點要離分界線夠近，近到拖兩下就會換邊。 */
const DEFAULTS = {
  year: '115',
  dividend: 1000000,
  salaryA: 4800000,
  salaryB: 0,
  interest: 0,
  other: 0,
  spouse: false,
  attrib: 'a',
  coupleMethod: 'auto',
  people: 1,
  people70: 0,
  disabled: 0,
  itemized: false,
  itemMortgage: 0,
  itemInsurance: 0,
  itemMedical: 0,
  itemDonation: 0,
  ltcPeople: 0,
  rentPaid: 0,
  otherSpecial: 0,
  payout: '4',
  rows: [],
  sandbox: false,
  nhiLayer: true,
};

const store = createStore('vm:dividend-tax-map', { ...DEFAULTS });

/* ==========================================================================
   2. 版面掛載
   ========================================================================== */
mountTopbar({ title: '股利課稅交叉點地圖' });
const actions = $('#sheetActions');
mountShare(actions, store);
mountTheme(actions);

const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const S = () => store.get();
const YR = () => RULES.years[S().year] || RULES.years['115'] || Object.values(RULES.years)[0];
const DIV = () => RULES.dividend;

/* ==========================================================================
   3. 稅額引擎
   單位一律是「元／年」。全是純函式，地圖才敢逐格呼叫幾萬次。
   ========================================================================== */

/** 綜合所得稅速算。淨額 ≤ 0 時稅額為 0，不是負數。 */
function fTax(net) {
  if (!(net > 0)) return 0;
  return progressiveTax(net, YR().brackets).tax;
}

/** 下一塊錢適用的邊際稅率。淨額 ≤ 0 時，下一塊錢落在最低級距。 */
function marginalRate(net) {
  const bs = YR().brackets;
  if (!(net > 0)) return bs[0].rate;
  for (const b of bs) if (b.upTo == null || net <= b.upTo) return b.rate;
  return bs[bs.length - 1].rate;
}

/** 股利可抵減稅額：全戶股利 × 8.5%，每一申報戶上限 8 萬元 */
const credit = (d) => Math.min(Math.max(0, d) * DIV().creditRate, DIV().creditCap);
/** 抵減上限咬合點：8 萬 ÷ 8.5%。分界線那道折點就是它。 */
const kinkD = () => DIV().creditCap / DIV().creditRate;

/** 申報戶的減除項。每一項都會原樣送進公式抽屜，所以命名要能直接見人。 */
function deductions(s) {
  const R = YR();
  const salaryA = Math.max(0, s.salaryA);
  const salaryB = s.spouse ? Math.max(0, s.salaryB) : 0;
  const interest = Math.max(0, s.interest);
  const other = Math.max(0, s.other);

  // 利息與其他所得的歸屬：只有「各類所得分開計稅」會用到
  const shareA = !s.spouse ? 1 : s.attrib === 'b' ? 0 : s.attrib === 'half' ? 0.5 : 1;

  const nNormal = Math.max(1, Math.round(s.people));
  const n70 = Math.max(0, Math.round(s.people70));
  const headcount = nNormal + n70;

  const exemption = nNormal * R.exemption + n70 * R.exemption70;
  const standard = s.spouse ? R.standardCouple : R.standardSingle;
  const savings = Math.min(interest, R.savingsCap);

  // 房貸利息列舉：先減儲蓄投資特別扣除額，餘額才可列舉，且上限 30 萬。
  // 這條順序是同類工具最常算錯的地方，所以單獨留一行給公式抽屜。
  const mortgageRaw = s.itemized ? Math.max(0, s.itemMortgage) : 0;
  const mortgageNet = clamp(mortgageRaw - savings, 0, R.mortgageCap);
  const itemizedSum = s.itemized
    ? mortgageNet + Math.max(0, s.itemInsurance) + Math.max(0, s.itemMedical) + Math.max(0, s.itemDonation)
    : 0;
  const general = Math.max(standard, itemizedSum);
  const generalUsed = s.itemized && itemizedSum > standard ? 'itemized' : 'standard';

  const salarySpecialA = Math.min(salaryA, R.salaryCap);
  const salarySpecialB = Math.min(salaryB, R.salaryCap);
  const disabled = Math.max(0, Math.round(s.disabled)) * R.disabledCap;
  const otherSpecial = Math.max(0, s.otherSpecial);

  // 長照與房租特別扣除額：金額是法定固定額（不隨 CPI 調整），
  // 但它們是現行僅存的兩項「排富」特扣 —— 選 28% 分開計稅就整個喪失。
  // 所以它們必須跟其他扣除額分開存放，兩制才會算出不同的減除總額。
  const ltcPeople = Math.max(0, Math.round(s.ltcPeople));
  const ltc = ltcPeople * (R.longTermCareCap || 0);
  const rent = Math.min(Math.max(0, s.rentPaid), R.rentCap || 0);
  const forfeitable = ltc + rent;

  // 基本生活費差額（納稅者權利保護法第 4 條）。比較基礎依規定不含薪資所得特別扣除額。
  // 年度金額尚未公告時一律以 0 計並在畫面上說清楚，不拿舊年度的數字冒充。
  let basicTotal = null, basicDiff = 0;
  if (Number.isFinite(R.basicLiving) && R.basicLiving > 0) {
    basicTotal = R.basicLiving * headcount;
    basicDiff = Math.max(0, basicTotal - (exemption + general + savings + disabled + otherSpecial + forfeitable));
  }

  return {
    salaryA, salaryB, interest, other, shareA,
    interestA: interest * shareA, interestB: interest * (1 - shareA),
    otherA: other * shareA, otherB: other * (1 - shareA),
    nNormal, n70, headcount, exemption, standard, itemizedSum, general, generalUsed,
    mortgageRaw, mortgageNet, savings, salarySpecialA, salarySpecialB, disabled, otherSpecial,
    ltcPeople, ltc, rent, forfeitable,
    basicTotal, basicDiff,
    totalOther: salaryA + salaryB + interest + other,
  };
}

/**
 * 夫妻三種計稅方式，各自產生候選方案。
 * 模型約定（同時寫進公式抽屜）：股利一律歸入「合併申報那一方」，
 * 因為分開計稅那一方只把自己的所得抽出去單獨算。
 * 這個約定讓地圖的 Y 軸有唯一定義：合併申報部分的其他所得淨額。
 */
function candidates(s, A) {
  const R = YR();
  const salarySpecTotal = A.salarySpecialA + A.salarySpecialB;

  const all = {
    method: 'all',
    label: '全部合併計稅',
    netOther: A.totalOther - A.exemption - A.general - salarySpecTotal
      - A.savings - A.disabled - A.otherSpecial - A.forfeitable - A.basicDiff,
    sepTax: 0, sepNet: 0, who: null,
  };
  if (!s.spouse) return { all: [all], salary: [all], each: [all] };

  const salaryCands = [0, 1].map((k) => {
    const sal = k === 0 ? A.salaryA : A.salaryB;
    const spec = k === 0 ? A.salarySpecialA : A.salarySpecialB;
    // 薪資分開計稅：分開者之薪資減除本人免稅額與薪資所得特別扣除額後單獨計稅
    const sepNet = Math.max(0, sal - spec - R.exemption);
    return {
      method: 'salary',
      label: `薪資分開計稅（${k === 0 ? '本人' : '配偶'}分開）`,
      netOther: (A.totalOther - sal) - (A.exemption - R.exemption) - A.general
        - (salarySpecTotal - spec) - A.savings - A.disabled - A.otherSpecial - A.forfeitable - A.basicDiff,
      sepTax: fTax(sepNet), sepNet, who: k,
    };
  });

  const eachCands = [0, 1].map((k) => {
    const sal = k === 0 ? A.salaryA : A.salaryB;
    const spec = k === 0 ? A.salarySpecialA : A.salarySpecialB;
    const itr = k === 0 ? A.interestA : A.interestB;
    const oth = k === 0 ? A.otherA : A.otherB;
    // 儲蓄投資特別扣除額是每一申報戶 27 萬，分開計稅時按各自利息比例分攤
    const sav = A.interest > 0 ? A.savings * (itr / A.interest) : 0;
    const sepNet = Math.max(0, sal + itr + oth - R.exemption - spec - sav);
    return {
      method: 'each',
      label: `各類所得分開計稅（${k === 0 ? '本人' : '配偶'}分開）`,
      netOther: (A.totalOther - sal - itr - oth) - (A.exemption - R.exemption) - A.general
        - (salarySpecTotal - spec) - (A.savings - sav) - A.disabled - A.otherSpecial - A.forfeitable - A.basicDiff,
      sepTax: fTax(sepNet), sepNet, who: k,
    };
  });

  return { all: [all], salary: salaryCands, each: eachCands };
}

/**
 * 選 28% 分開計稅會被追加回來的所得額 —— 也就是長照＋房租特別扣除額。
 * 所得稅法第 17 條第 3 項：選 28% 分開計稅者不適用這兩項特扣。
 * 它對整張地圖是一個常數位移，所以放在模組層，由 compute() 每次更新。
 * 不把它算進去，就會系統性高估 28% 制的優勢 —— 這是本題最大的坑。
 */
let FORFEIT = 0;

/** 給定候選方案與全年股利，算出兩制稅額。合併計稅可能為負，那是退稅，不要夾成 0。 */
function evaluate(cand, d) {
  const cr = credit(d);
  const combined = cand.sepTax + fTax(cand.netOther + d) - cr;
  // 分開計稅：長照與房租特扣被追回，所以課稅級距要用 netOther + FORFEIT
  const separate = cand.sepTax + fTax(cand.netOther + FORFEIT) + d * DIV().separateRate;
  const baseline = cand.sepTax + fTax(cand.netOther); // 沒有股利時的稅
  return { combined, separate, credit: cr, baseline, best: Math.min(combined, separate) };
}

/**
 * 地圖的核心：g > 0 表示合併計稅較省。分開計稅那一方的稅在兩制中相同，會自己消掉，
 * 所以這個函式只需要 (股利, 其他所得淨額) 兩個參數 —— 地圖才畫得成二維。
 */
function gapValue(d, y) {
  // 分開計稅那一側要把長照＋房租特扣加回課稅所得（FORFEIT），否則整條分界線會偏向 28% 制
  return (fTax(y + FORFEIT) + d * DIV().separateRate) - (fTax(y + d) - credit(d));
}

/** 給定股利，回傳分界線上的其他所得淨額。g 對 Y 單調遞減，可以二分。 */
function boundaryY(d, lo = -2e7, hi = 1e8) {
  if (!(d > 0)) return Infinity;              // 股利 0：兩制同額，整張圖沒有分界
  if (gapValue(d, hi) > 0) return Infinity;   // 高到爆表都還是合併較省
  if (gapValue(d, lo) < 0) return -Infinity;  // 低到爆表都已經是分開較省
  let a = lo, b = hi;
  for (let i = 0; i < 44; i++) {
    const m = (a + b) / 2;
    if (gapValue(d, m) > 0) a = m; else b = m;
  }
  return (a + b) / 2;
}

/**
 * 給定其他所得淨額，回傳「股利加到多少會翻盤」。
 * g 對 D 是凹的且 g(0) = 0，所以正根至多一個：先撐出變號的上界再二分。
 */
function boundaryD(y, hiCap = 5e7) {
  const probe = 1000;
  if (gapValue(probe, y) <= 0) return 0; // 已經在分開較省那一側，翻轉點就在原點
  let lo = probe, hi = probe;
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

/* ==========================================================================
   4. 二代健保補充保費
   單筆給付達 2 萬元才起扣，未達完全不扣，單次費基上限 1,000 萬。
   只知道全年總額是答不出來的，所以筆數是必填的假設，不是可有可無的細節。
   ========================================================================== */
function payoutList(s) {
  if (s.payout === 'unknown') return null;
  if (s.payout === 'rows') {
    // 同一標的、同一入帳日的多筆視為同一筆給付合併計算
    const bag = new Map();
    for (const r of s.rows) {
      const amt = Math.max(0, parseNum(r.amount, 0));
      if (!amt) continue;
      const key = `${(r.name || '').trim()}|${r.date || ''}`;
      bag.set(key, (bag.get(key) || 0) + amt);
    }
    const out = [...bag.entries()].map(([key, amount], i) => ({
      label: key.split('|')[0] || `第 ${i + 1} 筆`,
      amount,
    }));
    return out.length ? out : null; // 選了逐筆卻一筆都沒填 → 一樣答不出來
  }
  const n = Math.max(1, Math.round(Number(s.payout) || 1));
  const each = Math.max(0, s.dividend) / n;
  return Array.from({ length: n }, (_, i) => ({ label: `第 ${i + 1} 次配息`, amount: each }));
}

function nhiOf(list) {
  if (!list) return null;
  const opt = { rate: RULES.nhi.rate, floor: RULES.nhi.floor, cap: RULES.nhi.singleCap };
  const rows = list.map((p) => {
    const fee = nhiSupplement(p.amount, opt);
    return { ...p, fee, hit: fee > 0 };
  });
  return {
    rows,
    total: rows.reduce((a, r) => a + r.fee, 0),
    hits: rows.filter((r) => r.hit).length,
    // 卡在門檻邊緣：差不到一成就要被扣，或剛過門檻不到一成
    edge: rows.filter((r) => Math.abs(r.amount - RULES.nhi.floor) < RULES.nhi.floor * 0.1).length,
  };
}

/* ==========================================================================
   5. 招牌視覺：二維決策地圖
   Plot 的 bars/points 畫不出區域，所以這張圖自己畫：逐欄二分求分界線，
   線以下填淡藍（合併較省）、線以上填淡黃（分開較省）。
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
    window.matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', () => this.render());
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
    // 窄螢幕收窄左側刻度區，否則圖面被萬元刻度吃掉
    this.pad = w < 420
      ? { left: 46, right: 12, top: 16, bottom: 28 }
      : { left: 58, right: 18, top: 18, bottom: 30 };
    this.render();
  }

  setModel(m) { this.model = m; this.render(); return this; }

  sx(v) {
    return this.pad.left + (v / (this.model.xMax || 1)) * (this.w - this.pad.left - this.pad.right);
  }
  sy(v) {
    const m = this.model;
    const span = (m.yMax - m.yMin) || 1;
    return this.h - this.pad.bottom - ((v - m.yMin) / span) * (this.h - this.pad.top - this.pad.bottom);
  }
  ix(px) {
    return ((px - this.pad.left) / (this.w - this.pad.left - this.pad.right)) * this.model.xMax;
  }
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
    // 超出範圍時只推出畫面外一點點就好：推到無窮遠會在左緣拉出一條莫名其妙的垂直線
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

    const L = this.pad.left, R = this.w - this.pad.right;
    const T = this.pad.top, B = this.h - this.pad.bottom;
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
        const x = this.sx(p.d), y = this.sy(p.y);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
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
    for (const v of ticks(m.yMin, m.yMax, 5)) {
      const y = Math.round(this.sy(v)) + 0.5;
      if (y < T - 1 || y > B + 1) continue;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke();
      ctx.fillText(wan(v), L - 6, y);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const v of ticks(0, m.xMax, this.w < 420 ? 4 : 6)) {
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
           健保完全不看其他所得，所以它的等高線一定是垂直的 ——
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
        // 標籤掛在上緣往下寫，把左下角讓給「合併計稅較省」那行字
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
        const x = this.sx(kd), y = this.sy(ky);
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

/** 萬元刻度。地圖上的數字全部用「萬」，六位數逐位念會讀不完。 */
function wan(v) {
  if (!Number.isFinite(v)) return '-';
  if (Math.abs(v) < 1) return '0';
  if (Math.abs(v) >= 1e8) return dec(v / 1e8, 1) + ' 億';
  return dec(v / 1e4, Math.abs(v) >= 1e6 ? 0 : 1).replace(/\.0$/, '') + ' 萬';
}

function ticks(min, max, n) {
  const span = max - min;
  if (!(span > 0)) return [min];
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

function niceUp(v) {
  if (!(v > 0)) return 1e6;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / (mag / 2)) * (mag / 2);
}
function niceDown(v) { return v >= 0 ? 0 : -niceUp(-v); }

/* ==========================================================================
   6. 圖表實體
   ========================================================================== */
const map = new DecisionMap($('#map'));
const mapTip = createTip($('#mapCard'));

const marginPlot = new Plot($('#margin'), {
  aspect: 0.42,
  yFormat: (v) => pp(v * 100, 0),
  xFormat: (v) => wan(v),
  padding: { left: 48, bottom: 28, top: 14, right: 14 },
  yTicks: 4,
});

// 手動切換日間／夜間時，兩張 canvas 的顏色是在 render 當下讀出來的，
// 不重畫就會留著上一個主題的墨色。共用層只監聽系統偏好，所以這裡自己補一次。
new MutationObserver(() => { map.render(); marginPlot.render(); })
  .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

/* ==========================================================================
   7. 輸入元件
   ========================================================================== */
function patch(p, opts = {}) {
  store.set(p);
  if (opts.recompute !== false) compute(opts);
}

const numField = (sel, key, { min = 0, max = 1e9, round = false, label: name } = {}) =>
  bindField($(sel), {
    pretty: int,
    validate: (v, raw) => {
      if (raw === '') return null;
      if (!Number.isFinite(v)) return `${name}請填數字`;
      if (v < min) return `${name}不能小於 ${int(min)}`;
      if (v > max) return `${name}超出試算範圍`;
      return null;
    },
    onChange: (v, { valid }) => {
      if (!valid) return;
      const n = Number.isFinite(v) ? (round ? Math.round(v) : v) : 0;
      patch({ [key]: clamp(n, min, max) });
    },
  });

const fInterest = numField('#f-interest', 'interest', { max: 1e8, label: '利息所得' });
const fOther = numField('#f-other', 'other', { max: 5e8, label: '其他各類所得' });
const fPeople = numField('#f-people', 'people', { min: 1, max: 20, round: true, label: '免稅額人數' });
const fPeople70 = numField('#f-people70', 'people70', { min: 0, max: 20, round: true, label: '年滿 70 歲人數' });
const fDisabled = numField('#f-disabled', 'disabled', { min: 0, max: 20, round: true, label: '身心障礙人數' });
const fMortgage = numField('#f-mortgage', 'itemMortgage', { max: 5e6, label: '購屋借款利息' });
const fInsurance = numField('#f-insurance', 'itemInsurance', { max: 5e6, label: '保險費' });
const fMedical = numField('#f-medical', 'itemMedical', { max: 1e8, label: '醫藥費' });
const fDonation = numField('#f-donation', 'itemDonation', { max: 1e8, label: '捐贈' });
const fLtc = numField('#f-ltc', 'ltcPeople', { min: 0, max: 20, round: true, label: '長照人數' });
const fRent = numField('#f-rent', 'rentPaid', { max: 5e6, label: '房屋租金' });
const fOtherSpecial = numField('#f-otherspecial', 'otherSpecial', { max: 5e6, label: '其他特別扣除額' });

function wanNum(v) { return dec(v / 1e4, v % 1e4 === 0 ? 0 : 1).replace(/\.0$/, ''); }

const sDividend = bindSlider($('#s-dividend'), {
  format: (v) => `${wanNum(v)}<small>萬</small>`,
  onInput: (v) => patch({ dividend: v }, { from: 'dividend' }),
});
const sSalary = bindSlider($('#s-salary'), {
  format: (v) => `${wanNum(v)}<small>萬</small>`,
  onInput: (v) => patch({ salaryA: v }, { from: 'salary' }),
});
const sSalary2 = bindSlider($('#s-salary2'), {
  format: (v) => `${wanNum(v)}<small>萬</small>`,
  onInput: (v) => patch({ salaryB: v }, { from: 'salary' }),
});

const segYear = bindSegmented($('#seg-year'), { onChange: (v) => patch({ year: v }, { from: 'year' }) });
const segAttrib = bindSegmented($('#seg-attrib'), { onChange: (v) => patch({ attrib: v }) });
const segCouple = bindSegmented($('#seg-couple'), { onChange: (v) => patch({ coupleMethod: v }) });
const segPayout = bindSegmented($('#seg-payout'), {
  onChange: (v) => {
    if (v === 'rows' && !S().rows.length) seedRows();
    store.set({ payout: v });
    syncVisibility();
    compute();
  },
});

$('#chk-spouse').addEventListener('change', (e) => {
  const on = e.target.checked;
  // 勾了有配偶，免稅額人數至少兩人，否則使用者會拿到一個莫名其妙偏高的稅額
  const people = on ? Math.max(2, S().people) : Math.max(1, S().people - 1);
  store.set({ spouse: on, people });
  fPeople.set(people, { silent: true });
  syncVisibility();
  compute();
});
$('#chk-itemized').addEventListener('change', (e) => {
  store.set({ itemized: e.target.checked }); syncVisibility(); compute();
});
$('#chk-sandbox').addEventListener('change', (e) => {
  store.set({ sandbox: e.target.checked }); syncVisibility(); compute();
});

/* ---------- 可重複列：逐筆配息 ---------- */
function seedRows() {
  const d = S().dividend;
  store.set({ rows: [1, 2, 3, 4].map((i) => ({ name: `第 ${i} 季配息`, date: '', amount: Math.round(d / 4) })) });
  renderPayoutRows();
}

function renderPayoutRows() {
  const host = $('#payoutRows');
  host.replaceChildren();
  const rows = S().rows;
  if (!rows.length) {
    host.appendChild(el('p', { class: 'field__hint', text: '一列一筆給付。同一標的、同一入帳日的多筆會被併成一筆判定。' }));
  }
  rows.forEach((r, i) => {
    host.appendChild(el('div', { class: 'row' }, [
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label', text: '標的' }),
        el('span', { class: 'field__control' }, [
          el('input', { type: 'text', value: r.name || '', onchange: (e) => updateRow(i, { name: e.target.value }) }),
        ]),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label', text: '入帳日' }),
        el('span', { class: 'field__control' }, [
          el('input', { type: 'date', value: r.date || '', onchange: (e) => updateRow(i, { date: e.target.value }) }),
        ]),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label', text: '金額' }),
        el('span', { class: 'field__control' }, [
          el('input', {
            type: 'text', inputmode: 'numeric', value: String(r.amount ?? 0),
            onchange: (e) => updateRow(i, { amount: Math.max(0, parseNum(e.target.value, 0)) }),
          }),
          el('span', { class: 'field__unit', text: '元' }),
        ]),
      ]),
      el('button', {
        type: 'button', class: 'row__del', 'aria-label': '刪除這一筆配息',
        html: iconHTML('close'),
        onclick: () => { store.set({ rows: S().rows.filter((_, k) => k !== i) }); renderPayoutRows(); compute(); },
      }),
    ]));
  });
}

function updateRow(i, p) {
  store.set({ rows: S().rows.map((x, k) => (k === i ? { ...x, ...p } : x)) });
  compute();
}

$('#addPayout').addEventListener('click', () => {
  store.set({ rows: [...S().rows, { name: `第 ${S().rows.length + 1} 筆`, date: '', amount: 0 }] });
  renderPayoutRows();
  const rows = $$('#payoutRows .row');
  printRows(rows[rows.length - 1]);
  compute();
});

$('#resetBtn').addEventListener('click', () => {
  store.replace({ ...DEFAULTS });
  location.replace(location.pathname);
});

/* ---------- 長照與房租：兩項排富特扣 ---------- */
/**
 * 金額是法定固定額，不隨 CPI 調整（115 年度與 114 年度同為 18 萬）。
 * 排富有三道：適用稅率 20% 以上、選 28% 分開計稅、基本所得額超過規定扣除額。
 * 本工具只自動處理第二道（它是本地圖的主題），第一道改成提醒 —— 因為它會讓
 * 分界線變成不連續，寧可講清楚也不要偷偷算一個使用者看不見的東西。
 */
function renderForfeit(A, active, d) {
  const R = YR();
  $('#ltcHint').textContent = `每人 ${int(R.longTermCareCap || 0)} 元（法定固定額，115 年度不隨 CPI 調整）`;
  $('#rentHint').textContent = `每一申報戶上限 ${int(R.rentCap || 0)} 元（法定固定額）`;

  const warn = $('#forfeitWarn');
  if (!(A.forfeitable > 0)) { warn.hidden = true; warn.innerHTML = ''; return; }

  const rateCombined = marginalRate(active.netOther + d);
  const parts = [
    `你填的長照 ${int(A.ltc)} 元＋房租 ${int(A.rent)} 元 = <b>${int(A.forfeitable)} 元</b>。`
    + `合併計稅時可以減除；<b>選 28% 分開計稅時整個不能減</b>，所以本工具在分開計稅那一側已經把它加回課稅所得。`,
  ];
  if (rateCombined >= 0.2) {
    parts.push(
      `<b>但請先確認你是不是根本用不到它。</b>所得稅法第 17 條第 3 項還有一道排富：`
      + `減除本特別扣除額後全年綜合所得稅適用稅率在 <b>20% 以上</b>者不適用。`
      + `你目前合併計稅的適用稅率是 <b>${dec(rateCombined * 100, 0)}%</b>，很可能已被排除；若是，這兩格請填 0。`
      + `本工具不自動判定這一道，因為它牽涉基本所得額，且會讓地圖上的分界線變成不連續。`
    );
  }
  warn.innerHTML = parts.map((p) => `<p>${p}</p>`).join('');
  warn.hidden = false;
}

/* ---------- 條件欄位的顯示 ---------- */
function syncVisibility() {
  const s = S();
  $('#spouseBox').hidden = !s.spouse;
  $('#itemBox').hidden = !s.itemized;
  $('#rowsBox').hidden = s.payout !== 'rows';
  $('#coupleCard').hidden = !s.spouse;
  $('#sandboxCard').hidden = !s.sandbox;
}

function syncInputs() {
  const s = S();
  segYear.set(s.year);
  sDividend.set(s.dividend, { silent: true });
  sSalary.set(s.salaryA, { silent: true });
  sSalary2.set(s.salaryB, { silent: true });
  fInterest.set(s.interest, { silent: true });
  fOther.set(s.other, { silent: true });
  fPeople.set(s.people, { silent: true });
  fPeople70.set(s.people70, { silent: true });
  fDisabled.set(s.disabled, { silent: true });
  fMortgage.set(s.itemMortgage, { silent: true });
  fInsurance.set(s.itemInsurance, { silent: true });
  fMedical.set(s.itemMedical, { silent: true });
  fDonation.set(s.itemDonation, { silent: true });
  fLtc.set(s.ltcPeople, { silent: true });
  fRent.set(s.rentPaid, { silent: true });
  fOtherSpecial.set(s.otherSpecial, { silent: true });
  segAttrib.set(s.attrib);
  segCouple.set(s.coupleMethod);
  segPayout.set(s.payout);
  $('#chk-spouse').checked = s.spouse;
  $('#chk-itemized').checked = s.itemized;
  $('#chk-sandbox').checked = s.sandbox;
  renderPayoutRows();
  syncVisibility();
}

/* ==========================================================================
   8. 計算與繪製
   ========================================================================== */
const fmtTax = (v) => (v < -0.5 ? '退 ' + int(-v) : int(Math.max(0, v)));
const cCombined = makeCounter($('#r-combined'), fmtTax);
const cSeparate = makeCounter($('#r-separate'), fmtTax);
const cSave = makeCounter($('#r-save'), (v) => int(Math.max(0, v)));
const cGap = makeCounter($('#r-gap'), (v) => dec(v / 1e4, 1) + '<small>萬</small>', { html: true });
const cNhi = makeCounter($('#r-nhi'), (v) => int(Math.max(0, v)));
const cTake = makeCounter($('#r-take'), (v) => int(Math.round(v)));
const cEff = makeCounter($('#r-eff'), (v) => dec(v * 100, 2) + '<small>%</small>', { html: true });

let lastSide = null;
let stampedFor = null;
let lastModel = null;

function compute({ from } = {}) {
  const s = S();
  const A = deductions(s);
  // 地圖上每一格都會呼叫 gapValue，所以排富金額先鎖在模組層，不逐格重算
  FORFEIT = A.forfeitable;
  const cands = candidates(s, A);

  /* ---- 選出目前採用的方案 ---- */
  const pool = s.spouse
    ? (s.coupleMethod === 'auto'
      ? [...cands.all, ...cands.salary, ...cands.each]
      : (cands[s.coupleMethod] || cands.all))
    : cands.all;
  let active = pool[0], ev = evaluate(active, s.dividend);
  for (const c of pool) {
    const e = evaluate(c, s.dividend);
    if (e.best < ev.best - 1e-6) { active = c; ev = e; }
  }

  const d = Math.max(0, s.dividend);
  const diff = ev.separate - ev.combined;
  const side = Math.abs(diff) < 1 ? 'tie' : diff > 0 ? 'combined' : 'separate';

  /* ---- 排富特扣的兩件事：金額提示，以及 20% 那道本工具不自動判定的門檻 ---- */
  renderForfeit(A, active, d);

  /* ---- 到分界線的距離 ---- */
  const flipD = boundaryD(active.netOther);
  const flipY = boundaryY(d);
  const gapD = Number.isFinite(flipD) ? flipD - d : Infinity;
  const gapY = Number.isFinite(flipY) ? flipY - active.netOther : Infinity;

  /* ---- 二代健保 ---- */
  const list = payoutList(s);
  const nhi = nhiOf(list);

  /* ---- 地圖：股利為 0 時整張圖退化，改走一般綜所稅的結果 ---- */
  const degenerate = d <= 0;
  $('#mapCard').dataset.empty = String(degenerate);
  $('#mapEmpty').hidden = !degenerate;
  $('#map').style.display = degenerate ? 'none' : '';

  if (!degenerate) {
    const xMax = niceUp(Math.max(2500000, d * 1.6));
    const yMax = niceUp(Math.max(6000000, active.netOther * 1.35,
      Number.isFinite(flipY) ? flipY * 1.15 : 0));
    const yMin = Math.min(0, niceDown(active.netOther * 1.25));
    // 第二層：二代健保。等高線刻意挑不會撞到 94.1 萬折點的級距，
    // 免得兩件不相干的事在圖上疊成同一條線。
    const nhiLines = [];
    if (s.nhiLayer && list && list.length) {
      const n = list.length;
      const floorAt = RULES.nhi.floor * n;
      if (floorAt > 0 && floorAt <= xMax) nhiLines.push({ d: floorAt, label: `起扣 ${wan(floorAt)}` });
      for (const lvl of [10000, 30000, 60000, 100000]) {
        const dv = lvl / RULES.nhi.rate;
        if (dv <= xMax && dv > floorAt * 1.15) nhiLines.push({ d: dv, label: `保費 ${wan(lvl)}` });
      }
    }
    lastModel = { xMax, yMin, yMax, point: { d, y: active.netOther }, flipD, flipY, nhi: nhiLines };
    map.setModel(lastModel);
    renderMapLegend(s, list);
  }

  /* ---- 邊際實質稅負率曲線 ---- */
  renderMargin(active, s, list);

  /* ---- 讀數 ---- */
  cCombined(ev.combined);
  cSeparate(ev.separate);
  cSave(Math.abs(diff));
  if (Number.isFinite(gapD)) cGap(Math.abs(gapD));
  else $('#r-gap').textContent = '不會翻盤';

  const saveNote = $('#r-saveNote');
  saveNote.textContent = side === 'tie' ? '兩案同額' : side === 'combined' ? '選合併' : '選分開';
  saveNote.dataset.dir = side === 'tie' ? 'flat' : 'down';

  const gapNote = $('#r-gapNote');
  gapNote.dataset.dir = 'flat';
  gapNote.textContent = !Number.isFinite(gapD) ? '股利再高也不換邊'
    : gapD >= 0 ? '再多這麼多股利就翻盤' : '少領這麼多才換回來';

  const dividendTax = ev.best - ev.baseline;
  if (nhi) {
    cNhi(nhi.total);
    $('#r-nhiNote').textContent = `${nhi.hits} / ${nhi.rows.length} 筆起扣`;
    cTake(d - dividendTax - nhi.total);
    cEff(d > 0 ? (dividendTax + nhi.total) / d : 0);
    $('#r-effNote').textContent = '含補充保費';
  } else {
    $('#r-nhi').textContent = '拒答';
    $('#r-nhiNote').textContent = '需要配息筆數';
    cTake(d - dividendTax);
    cEff(d > 0 ? dividendTax / d : 0);
    $('#r-effNote').textContent = '未含補充保費';
  }

  renderVerdict(s, active, ev, { side, gapD, gapY, flipD, nhi, degenerate });
  renderNhi(s, nhi);
  renderCouple(s, cands, active);
  renderSandbox(s, nhi);
  renderFormula(s, A, active, ev, { flipD });
  updateBadge();

  /* ---- 圖的結論同時給文字：不讓視覺是唯一的資訊通道 ---- */
  $('#mapDesc').textContent = degenerate
    ? '股利為 0，地圖退化成一個點，兩制稅額完全相同。'
    : '橫軸是全年股利所得，縱軸是其他所得淨額。淡藍區合併計稅較省，淡黃（斜線）區分開計稅較省，'
      + `分界線在股利 ${wan(kinkD())} 處有一道折點，成因是 8.5% 抵減撞到每戶 8 萬元的上限。`
      + `你在股利 ${wan(d)}、其他所得淨額 ${wan(active.netOther)} 的位置，落在`
      + `${side === 'separate' ? '分開較省' : '合併較省'}那一區`
      + (Number.isFinite(gapD)
        ? `，${gapD >= 0 ? '再多領' : '要少領'} ${wan(Math.abs(gapD))}股利就會換邊。`
        : '，在這個其他所得水準下，股利再高也不會換邊。');

  if (from) carbonTransfer($$('[data-live]'));
  lastSide = side;
}

/* ---------- 結論 ---------- */
function renderVerdict(s, active, ev, ctx) {
  const h = $('#verdict-h');
  const body = $('#verdictBody');
  const stamp = $('#verdictStamp');
  const { side, gapD, gapY, nhi, degenerate } = ctx;

  if (degenerate) {
    h.textContent = '沒有股利，就沒有兩制可選。';
    body.textContent = `這一戶的其他所得淨額是 ${int(Math.round(active.netOther))} 元，`
      + `應納稅額 ${int(Math.round(ev.baseline))} 元。把股利拉起來，這張地圖才會長出來。`;
    stamp.hidden = false;
    if (stampedFor !== 'zero') {
      stamp.innerHTML = '<span class="stamp stamp--void">無股利</span>';
      stampIn(stamp.firstElementChild);
      stampedFor = 'zero';
    }
    return;
  }

  const better = side === 'separate' ? '分開計稅' : '合併計稅';
  const saved = Math.abs(ev.separate - ev.combined);
  h.innerHTML = side === 'tie'
    ? '兩制算出來一模一樣，勾哪一個都可以。'
    : `勾「<em>${better}</em>」，一年少繳 <em>${int(Math.round(saved))}</em> 元。`;

  const parts = [];
  if (Number.isFinite(gapD) && gapD > 0) {
    parts.push(`你離翻轉點還有 ${wan(gapD)}股利：全年股利加到 ${wan(ctx.flipD)} 就會換邊。`);
  } else if (Number.isFinite(gapD) && gapD < 0) {
    parts.push(`股利要降到 ${wan(ctx.flipD)} 以下才會換回合併計稅，也就是少領 ${wan(-gapD)}。`);
  } else {
    parts.push('在這個其他所得水準下，股利再怎麼加都不會換邊。');
  }
  if (Number.isFinite(gapY)) {
    parts.push(`換個方向看：其他所得淨額${gapY >= 0 ? '再增加' : '要減少'} ${wan(Math.abs(gapY))} 也會換邊。`);
  }
  if (ev.combined < -0.5 && side === 'combined') {
    parts.push(`可抵減稅額已經大於應納稅額，這一戶會退稅 ${int(Math.round(-ev.combined))} 元。`);
  }
  if (s.dividend > kinkD()) {
    parts.push(`你的股利超過 ${wan(kinkD())}，8.5% 抵減卡在 8 萬元不再增加，多領的部分抵減率等於 0。`);
  }
  if (active.netOther < 0) {
    parts.push(`注意：扣除額大於其他所得，其他所得淨額是負的 ${int(Math.round(-active.netOther))} 元。`
      + '選分開計稅會讓這段用不完的扣除額直接浪費掉，選合併計稅則可以吃掉一部分股利。');
  }
  if (nhi && nhi.edge > 0) {
    parts.push(`另外有 ${nhi.edge} 筆配息就卡在 2 萬元門檻附近，差一點點就決定要不要被扣 2.11%。`);
  }
  if (active.method !== 'all') {
    parts.push(`目前採用的夫妻計稅方式是「${active.label}」。`);
  }
  body.textContent = parts.join('');

  stamp.hidden = false;
  const key = `${side}:${s.year}`;
  if (stampedFor !== key) {
    stamp.innerHTML = `<span class="${side === 'tie' ? 'stamp stamp--void' : 'stamp'}">${side === 'tie' ? '兩案同額' : better}</span>`;
    stampIn(stamp.firstElementChild);
    stampedFor = key;
    // 招牌動效：真的換邊了才播一次，其他時候保持安靜
    if (lastSide && lastSide !== side) {
      const card = $('#verdict');
      if (flagCross(card)) {
        // flagCross 收在 transparent，會蓋掉單據的紙色，所以動完把行內樣式清掉
        clearTimeout(window.__crossT);
        window.__crossT = setTimeout(() => { card.style.backgroundColor = ''; }, 1000);
      }
      toast(side === 'separate' ? '你剛剛換邊了：現在分開計稅比較省' : '你剛剛換邊了：現在合併計稅比較省');
    }
  }
}

/* ---------- 邊際實質稅負率 ---------- */
function renderMargin(active, s, list) {
  const xMax = niceUp(Math.max(2500000, s.dividend * 1.6));
  const N = 160;
  const combined = [], separate = [], mixed = [];
  const perPayout = list && list.length ? s.dividend / list.length : 0;
  const nhiRate = perPayout >= RULES.nhi.floor ? RULES.nhi.rate : 0;
  for (let i = 0; i <= N; i++) {
    const d = (i / N) * xMax;
    const mc = marginalRate(active.netOther + d) - (d < kinkD() ? DIV().creditRate : 0);
    const ms = DIV().separateRate;
    combined.push({ x: d, y: mc });
    separate.push({ x: d, y: ms });
    mixed.push({ x: d, y: Math.min(mc, ms) + nhiRate });
  }
  marginPlot.setSeries([
    { type: 'step', data: combined, color: cssv('--series-1'), width: 2.5 },
    { type: 'line', data: separate, color: cssv('--series-2'), width: 2 },
    { type: 'step', data: mixed, color: cssv('--series-4'), width: 1.5, dash: [4, 3], noCursor: true },
  ], { animate: false });
  marginPlot.setMarks([
    { axis: 'x', value: kinkD(), label: `${wan(kinkD())} 抵減上限`, color: cssv('--ink-3'), dash: [3, 3] },
    { axis: 'x', value: s.dividend, color: cssv('--stamp'), dash: [2, 2] },
  ]);

  $('#marginLegend').replaceChildren(
    legendItem('合併計稅（含 8.5% 抵減）', cssv('--series-1')),
    legendItem('分開計稅 28%', cssv('--series-2')),
    legendItem('取低者＋補充保費', cssv('--series-4'), true),
  );
  $('#marginDesc').textContent =
    '橫軸是全年股利所得，縱軸是「再多領 1 元股利，實際被拿走多少」。'
    + `合併計稅那條線在股利 ${wan(kinkD())} 處往上跳 8.5 個百分點，因為抵減從那裡開始不再增加；`
    + '分開計稅永遠是 28% 的水平線，兩線交叉的位置就是翻轉點。'
    + (nhiRate ? '虛線再疊上 2.11% 的二代健保補充保費。' : '目前每筆配息未達 2 萬元，虛線不含補充保費。');
}

/* ---------- 地圖圖例：兩區色塊、分界線，以及第二層的開關 ---------- */
function renderMapLegend(s, list) {
  const host = $('#mapLegend');
  const swatch = (bg, text, extra = '') => el('span', { class: 'legend__item' }, [
    // 用 background-color 而不是 background 簡寫：簡寫會把斜線那層 background-image 清掉
    el('span', { class: `legend__key legend__key--area ${extra}`, style: `background-color:${bg}` }),
    el('span', { text }),
  ]);
  const toggle = el('button', {
    class: 'legend__item',
    type: 'button',
    'aria-pressed': String(!!s.nhiLayer),
    title: '二代健保補充保費的等高線只跟股利有關，所以一定是垂直的',
    onclick: () => { store.set({ nhiLayer: !S().nhiLayer }); compute(); },
  }, [
    el('span', { class: 'legend__key legend__key--dash', style: `color:${cssv('--series-4')}` }),
    el('span', { text: '二代健保層' }),
  ]);
  host.replaceChildren(
    swatch(cssv('--ply-4'), '合併較省'),
    swatch(cssv('--ply-2'), '分開較省', 'legend__key--hatch'),
    el('span', { class: 'legend__item' }, [
      el('span', { class: 'legend__key', style: `background-color:${cssv('--ink')}` }),
      el('span', { text: '分界線' }),
    ]),
  );
  if (list && list.length) host.appendChild(toggle);
}

function legendItem(text, color, dash = false) {
  return el('span', { class: 'legend__item' }, [
    el('span', {
      class: `legend__key${dash ? ' legend__key--dash' : ''}`,
      style: dash ? `color:${color}` : `background-color:${color}`,
    }),
    el('span', { text }),
  ]);
}

/* ---------- 補充保費逐筆判定 ---------- */
function renderNhi(s, nhi) {
  const refuse = $('#nhiRefuse');
  const wrap = $('#nhiWrap');
  const chip = $('#nhiChip');
  if (!nhi) {
    refuse.hidden = false;
    wrap.hidden = true;
    chip.textContent = '拒答';
    chip.classList.remove('chip--on');
    $('#nhiFoot').textContent = '';
    return;
  }
  refuse.hidden = true;
  wrap.hidden = false;
  chip.textContent = `${nhi.hits} / ${nhi.rows.length} 筆起扣`;
  chip.classList.toggle('chip--on', nhi.hits > 0);

  const tb = $('#nhiBody');
  tb.replaceChildren();
  nhi.rows.forEach((r, i) => {
    const tr = el('tr', r.hit ? {} : { 'data-off': '1' });
    tr.appendChild(el('td', { text: r.label || `第 ${i + 1} 筆` }));
    tr.appendChild(el('td', { text: int(Math.round(r.amount)) }));
    tr.appendChild(el('td', { text: r.hit ? '起扣' : '未達 2 萬' }));
    tr.appendChild(el('td', { class: r.hit ? 'is-up' : '', text: r.hit ? int(Math.round(r.fee)) : '-' }));
    tb.appendChild(tr);
  });
  $('#nhiFootRow').replaceChildren(
    el('td', { text: '合計' }),
    el('td', { text: int(Math.round(nhi.rows.reduce((a, r) => a + r.amount, 0))) }),
    el('td', { text: `${nhi.hits} 筆` }),
    el('td', { text: int(Math.round(nhi.total)) }),
  );

  const n = nhi.rows.length;
  $('#nhiFoot').textContent =
    `單筆達 ${int(RULES.nhi.floor)} 元起扣，費率 ${pp(RULES.nhi.rate * 100, 2)}，單次費基上限 ${int(RULES.nhi.singleCap)} 元。`
    + (s.payout === 'rows'
      ? '以上為你逐筆輸入的金額；同一標的同一入帳日的多筆已併成一筆判定。'
      : `以 ${n} 筆平均分配計算，全年股利低於 ${int(RULES.nhi.floor * n)} 元時每一筆都不到門檻，補充保費為 0。`
        + '這是假設不是事實，各次配息金額差很多時請改用「逐筆輸入」。');
}

/* ---------- 夫妻三種計稅方式各跑一次 ---------- */
function renderCouple(s, cands, active) {
  if (!s.spouse) return;
  const tb = $('#coupleBody');
  tb.replaceChildren();
  const names = { all: '全部合併', salary: '薪資分開', each: '各類所得分開' };
  const rows = ['all', 'salary', 'each'].map((k) => {
    let best = null;
    for (const c of cands[k]) {
      const e = evaluate(c, s.dividend);
      if (!best || e.best < best.e.best) best = { c, e };
    }
    return { k, ...best };
  }).sort((a, b) => a.e.best - b.e.best);

  rows.forEach((r) => {
    const tr = el('tr', r.c === active ? { 'data-mark': 'pick' } : {});
    tr.appendChild(el('td', {
      text: names[r.k] + (r.k !== 'all' && r.c.who != null ? `（${r.c.who === 0 ? '本人' : '配偶'}）` : ''),
    }));
    tr.appendChild(el('td', { text: fmtTax(r.e.combined) }));
    tr.appendChild(el('td', { text: fmtTax(r.e.separate) }));
    tr.appendChild(el('td', { text: fmtTax(r.e.best) }));
    tb.appendChild(tr);
  });
  $('#coupleFoot').textContent =
    `三種方式各跑一次，最省的是「${names[rows[0].k]}」，`
    + `比最貴的一種少繳 ${int(Math.round(rows[rows.length - 1].e.best - rows[0].e.best))} 元。`
    + '本工具把全戶股利歸在合併申報那一方，因為分開計稅那一方抽出去的只有自己的所得。';
}

/* ---------- 沙盒：尚未上路的年度累計制 ---------- */
function renderSandbox(s, nhi) {
  if (!s.sandbox) return;
  const sb = RULES.nhiAnnualSandbox;
  const d = Math.max(0, s.dividend);
  const base = Math.min(d, sb.annualCap);
  const full = d >= sb.annualFloor ? base * sb.rate : 0;
  const excess = d > sb.annualFloor ? (base - sb.annualFloor) * sb.rate : 0;
  const now = nhi ? nhi.total : null;

  $('#sandboxBody').replaceChildren(
    el('p', {
      class: 'state__body',
      text: `衛福部曾研議把股利、利息、租金改採年度累計制：一年累計逾 ${int(sb.annualFloor)} 元即計收 ${pp(sb.rate * 100, 2)}，`
        + `扣繳上限自 1,000 萬元提高為 ${int(sb.annualCap)} 元。行政院已於 ${sb.haltedOn} 指示暫緩，法條並未修正。`
        + '以下把兩種可能的算法都攤出來，它們不是預測，也不是現行規定。',
    }),
    el('div', { class: 'sandbox__row' }, [
      el('span', { text: '若「全額計收」' }),
      el('span', { class: 'sandbox__num', text: int(Math.round(full)) + ' 元' }),
    ]),
    el('div', { class: 'sandbox__row' }, [
      el('span', { text: '若「僅就超過 2 萬元部分計收」' }),
      el('span', { class: 'sandbox__num', text: int(Math.round(excess)) + ' 元' }),
    ]),
    el('div', { class: 'sandbox__row' }, [
      el('span', { text: '現行單筆起扣制（正式結果）' }),
      el('span', { class: 'sandbox__num', text: now == null ? '拒答' : int(Math.round(now)) + ' 元' }),
    ]),
    el('div', { class: 'state state--refuse' }, [
      el('h3', { class: 'state__title', text: '這一格的細節現在回答不了' }),
      el('p', {
        class: 'state__body',
        text: '全額計收還是只就超過 2 萬元的部分計收、施行日、有沒有過渡期，草案都沒有定案，'
          + '而且整案已經暫緩。所以這裡不挑一個算法當答案，兩個都列出來，讓你知道區間有多大。',
      }),
    ]),
  );
}

/* ---------- 公式抽屜：每個數字都能攤開看代入值與法源 ---------- */
function renderFormula(s, A, active, ev, ctx) {
  const R = YR();
  const host = $('#formulaHost');
  // 使用者可能正開著某一格在核對，拖滑桿不該把它關起來
  const open = $$('details', host).map((d) => d.open);
  host.replaceChildren();
  const src = (basis, url) => `${basis || ''}${url ? ` <a href="${url}" rel="noopener noreferrer" target="_blank">查看出處</a>` : ''}`;

  const lines1 = [
    `<b>所得總額（不含股利）</b> = 薪資 ${int(A.salaryA + A.salaryB)} ＋ 利息 ${int(A.interest)} ＋ 其他 ${int(A.other)} = <b>${int(A.totalOther)}</b>`,
    `− 免稅額 = ${A.nNormal} 人 × ${int(R.exemption)} ＋ ${A.n70} 人 × ${int(R.exemption70)} = <b>${int(A.exemption)}</b>`,
    `− 一般扣除額（${A.generalUsed === 'itemized' ? '列舉' : '標準'}）= <b>${int(A.general)}</b>`
      + (s.itemized ? `　列舉合計 ${int(A.itemizedSum)}、標準 ${int(A.standard)}，取大者` : ''),
  ];
  if (s.itemized) {
    lines1.push(`　房貸利息可列舉 = clamp(${int(A.mortgageRaw)} − 儲蓄投資特扣 ${int(A.savings)}, 0, ${int(R.mortgageCap)}) = <b>${int(A.mortgageNet)}</b>`);
  }
  lines1.push(
    `− 薪資所得特別扣除額 = ${int(A.salarySpecialA)}${s.spouse ? ` ＋ ${int(A.salarySpecialB)}` : ''}（每人上限 ${int(R.salaryCap)}）`,
    `− 儲蓄投資特別扣除額 = min(利息 ${int(A.interest)}, ${int(R.savingsCap)}) = <b>${int(A.savings)}</b>`,
    `− 身心障礙特別扣除額 ${int(A.disabled)}　− 其他特別扣除額 ${int(A.otherSpecial)}`,
    `− 長照特別扣除額 ${A.ltcPeople} 人 × ${int(R.longTermCareCap || 0)} = ${int(A.ltc)}`
      + `　− 房租特別扣除額 min(${int(s.rentPaid)}, ${int(R.rentCap || 0)}) = ${int(A.rent)}`,
    `　這兩項合計 <b>${int(A.forfeitable)}</b> 元<b>只在合併計稅時能減</b>；選 28% 分開計稅時要加回去（所得稅法第 17 條第 3 項）`,
    A.basicTotal == null
      ? `− 基本生活費差額 = <b>未計入</b>：${R.label} 之每人基本生活費尚未查得公告值，寧可不算也不用舊年度的數字冒充`
      : `− 基本生活費差額 = max(0, ${int(R.basicLiving)} × ${A.headcount} 人 − 比較基礎) = <b>${int(A.basicDiff)}</b>`,
    `<b>其他所得淨額（地圖的縱軸）= ${int(Math.round(active.netOther))}</b>`,
  );
  if (active.method !== 'all') {
    lines1.push(`分開計稅那一方的淨額 ${int(Math.round(active.sepNet))}，單獨稅額 ${int(Math.round(active.sepTax))}（已含在下面兩制的結果裡）`);
  }
  host.appendChild(formulaBlock('攤開看：其他所得淨額是怎麼算出來的', lines1,
    src(R.legalBasis, R.sourceUrl)));

  const cr = credit(s.dividend);
  host.appendChild(formulaBlock('攤開看：兩制稅額並排', [
    `<b>合併計稅</b> = f(其他所得淨額 ＋ 股利) − min(股利 × ${pp(DIV().creditRate * 100, 1)}, ${int(DIV().creditCap)})`,
    `= f(${int(Math.round(active.netOther))} ＋ ${int(s.dividend)}) − ${int(Math.round(cr))}`
      + `${active.sepTax ? ` ＋ 分開方 ${int(Math.round(active.sepTax))}` : ''} = <b>${fmtTax(ev.combined)}</b>`,
    `<b>分開計稅</b> = f(其他所得淨額 ＋ 被追回的長照與房租特扣) ＋ 股利 × ${pp(DIV().separateRate * 100, 0)}`,
    `= f(${int(Math.round(active.netOther))}${A.forfeitable > 0 ? ` ＋ ${int(A.forfeitable)}` : ' ＋ 0'}) ＋ ${int(s.dividend)} × 0.28`
      + `${active.sepTax ? ` ＋ 分開方 ${int(Math.round(active.sepTax))}` : ''} = <b>${fmtTax(ev.separate)}</b>`,
    A.forfeitable > 0
      ? `　那個 ＋${int(A.forfeitable)} 就是 28% 制的隱藏成本：長照與房租特扣被整個取消。不加回去會系統性高估 28% 制。`
      : `　你目前沒有填長照與房租特扣，所以這一項是 0；有填的話，28% 制那一側會多出等額的課稅所得。`,
    `<b>兩制都必須就整個申報戶的全部股利擇一</b>，不能一部分合併、一部分分開。`,
    `f( ) 是 ${R.label} 的速算式：淨額 × 稅率 − 累進差額`,
    ...R.brackets.map((b, i) => {
      const lo = i === 0 ? 0 : R.brackets[i - 1].upTo;
      return `　${int(lo)} ～ ${b.upTo == null ? '以上' : int(b.upTo)}：× ${pp(b.rate * 100, 0)} − ${int(b.quick)}`;
    }),
  ], src(RULES.dividend.legalBasis, RULES.dividend.sourceUrl)
    + (RULES.dividend.forfeitLegalBasis
      ? `<br>${src(RULES.dividend.forfeitLegalBasis, RULES.dividend.forfeitSourceUrl)}`
      : '')));

  host.appendChild(formulaBlock(`攤開看：折點為什麼落在 ${wan(kinkD())}`, [
    `可抵減稅額 = 股利 × ${pp(DIV().creditRate * 100, 1)}，但每一申報戶上限 ${int(DIV().creditCap)} 元`,
    `${int(DIV().creditCap)} ÷ ${DIV().creditRate} = <b>${int(kinkD())}</b> 元`,
    `低於這個數：多領 1 元股利，抵減多 ${dec(DIV().creditRate * 100, 1)} 分，合併計稅的邊際負擔 = 邊際稅率 − ${pp(DIV().creditRate * 100, 1)}`,
    `高於這個數：抵減不再增加，合併計稅的邊際負擔 = 邊際稅率本身`,
    `所以分界線在這裡往下折一次。你的股利是 ${int(s.dividend)}，`
      + `${s.dividend > kinkD() ? '<b>已經越過折點</b>' : '還在折點左邊'}`,
    Number.isFinite(ctx.flipD)
      ? `你的翻轉點：股利 = <b>${int(Math.round(ctx.flipD))}</b> 元`
      : '在目前的其他所得淨額之下，股利再高也不會翻轉',
  ], src(RULES.dividend.legalBasis, RULES.dividend.sourceUrl)));

  host.appendChild(formulaBlock('攤開看：二代健保補充保費', [
    `逐筆判定：單次給付 ≥ ${int(RULES.nhi.floor)} 元才起扣，未達完全不扣`,
    `補充保費 = min(單次給付, ${int(RULES.nhi.singleCap)}) × ${pp(RULES.nhi.rate * 100, 2)}`,
    '它不看你的其他所得，也不看你選哪一種計稅方式，所以在地圖上它的等高線是垂直的',
    '這也表示：兩制之爭與補充保費之爭是兩件事，計稅方式選錯不會讓補充保費變多或變少',
  ], src(RULES.nhi.legalBasis, RULES.nhi.sourceUrl)));

  $$('details', host).forEach((dEl, i) => { if (open[i]) dEl.open = true; });
}

/* ---------- 資料版本徽章：法規會變，版本必須永遠在畫面上 ---------- */
let rulesLoaded = false;
function updateBadge() {
  const y = YR();
  const badge = $('#dataver');
  badge.textContent = rulesLoaded
    ? `資料版本 ${RULES.version}．適用 ${y.label}`
    : `資料版本 載入失敗（用內建備援）．適用 ${y.label}`;
  badge.title = rulesLoaded ? (RULES.note || '') : 'rules.json 載入失敗';
  $('#yearHint').textContent =
    '切換年度會同時換掉免稅額、扣除額、級距與累進差額，不是只換級距。'
    + `${y.label}：免稅額 ${int(y.exemption)}、標準扣除額 ${int(y.standardSingle)}／有配偶 ${int(y.standardCouple)}、`
    + `薪資特扣上限 ${int(y.salaryCap)}。`
    + (y.basicLiving
      ? `每人基本生活費 ${int(y.basicLiving)}。`
      : '每人基本生活費尚未公告，本年度不計入基本生活費差額。')
    // 只有 6 類項目隨 CPI 調整；把所有數字一律按 CPI 調整是本題最常見的實作錯誤
    + (y.cpiIndexedNote ? ` ${y.cpiIndexedNote}` : '');
}

/* ==========================================================================
   9. 地圖游標
   ========================================================================== */
map.onHover = (h) => {
  if (!h || !lastModel) { mapTip.hide(); return; }
  const g = gapValue(h.d, h.y);
  const winner = Math.abs(g) < 1 ? '兩案同額' : g > 0 ? '合併較省' : '分開較省';
  mapTip.show(
    `<b>股利 ${wan(h.d)}／淨額 ${wan(h.y)}</b><br>${winner}　差 ${int(Math.abs(Math.round(g)))} 元`,
    h.px, h.py + $('#map').offsetTop,
  );
};

/* ==========================================================================
   10. 啟動
   ========================================================================== */
async function boot() {
  try {
    const res = await fetch('./rules.json');
    if (res.ok) { RULES = { ...RULES, ...(await res.json()) }; rulesLoaded = true; }
  } catch { /* 離線或以 file:// 開啟：用內建備援，徽章上會說出來 */ }

  if (RULES.official?.url) $('#officialLink').href = RULES.official.url;
  $('#payoutHint').textContent =
    '預設以季配 4 筆平均分配計算，這是假設不是事實；各次金額差很多時請改用逐筆輸入。';

  syncInputs();
  compute();

  // 首次進場：結果逐行推出，讓人感覺數字是被算出來的
  printRows($$('#readouts .readout, #readouts2 .readout'), { stagger: 0.05, delay: 0.1 });

  window.addEventListener('resize', () => {
    clearTimeout(window.__rz);
    window.__rz = setTimeout(() => map.render(), 180);
  });

  if (store.cameFromLink) toast('已載入別人傳給你的情境');
  window.__ready = true;
}

boot();
