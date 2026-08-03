window.addEventListener('error', (e) => {
  // Chrome 對「在 ResizeObserver 回呼裡改到版面」發出的良性通知，不是錯誤，也不影響繪製
  if (/ResizeObserver loop/.test(e.message || '')) return;
  window.__err = String(e.message);
});

import { gsap, EASE, printRows, stampIn, makeCounter, carbonTransfer, flagCross, still } from '../../assets/js/core/motion.js';
import { Plot, niceTicks } from '../../assets/js/core/plot.js';
import { nhiSupplement, twTradeCost } from '../../assets/js/core/fin.js';
import { createStore } from '../../assets/js/core/state.js';
import {
  $, $$, el, bindSlider, bindField, bindSegmented,
  mountTopbar, mountShare, mountTheme, toast, virtualTable, formulaBlock,
} from '../../assets/js/core/ui.js';
import { int, dec, money, pct, pp, parseNum, clamp } from '../../assets/js/core/format.js';

/* ==========================================================================
   1. 法規常數
   查不到法源的一律標 unverified，並在畫面上講清楚（見 rules.json 與填寫區提示）。
   ========================================================================== */
let RULES = {
  version: '未載入',
  incomeTax: {
    dividendCreditRate: { value: 0.085 },
    dividendCreditCap: { value: 80000 },
    dividendSeparateRate: { value: 0.28 },
    brackets114: { value: [
      { rate: 0.05, min: 0, max: 590000 },
      { rate: 0.12, min: 590001, max: 1330000 },
      { rate: 0.20, min: 1330001, max: 2660000 },
      { rate: 0.30, min: 2660001, max: 4980000 },
      { rate: 0.40, min: 4980001, max: null },
    ] },
  },
  nhi: {
    supplementRate: { value: 0.0211 },
    threshold: { value: 20000 },
    singlePaymentCap: { value: 10000000 },
  },
  market: {
    lotSize: { value: 1000 },
    parValue: { value: 10 },
    brokerFeeRate: { value: 0.001425 },
    brokerFeeMin: { value: 20 },
    brokerFeeDiscount: { value: 0.6 },
  },
};

/* 首屏就是論點：預設 15 張 × 20 元 × 7% 年配，單筆股利剛好跨過 2 萬元門檻，
   填息 70% 讓柱子上一定留著一片看得見的缺口陰影。 */
const DEFAULTS = () => ({
  price: 20,
  lots: 15,
  years: 10,
  divYield: 7,
  freq: 1,
  stockDiv: 0,
  qual: 100,
  drift: 15,
  fill: 70,
  trend: 1.5,
  mkt: 8.5,
  bear: 30,
  bracket: 0.12,
  taxMode: 'merge',
  fee: true,
  mode: 'reinvest',
});

const store = createStore('vm:ex-dividend', DEFAULTS());

/* ==========================================================================
   2. 版面掛載
   ========================================================================== */
mountTopbar({ title: '除息填息機' });
const actions = $('#sheetActions');
mountShare(actions, store);
mountTheme(actions);

const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
/** 大額一律換成萬／億再接「元」，因為台灣人講「二十八萬七千」不講「287,000」 */
const wan = (v) => money(Math.round(v), { compact: true }) + '元';

/* ==========================================================================
   3. 模型
   每一期：價格趨勢 → 除權息 → 填息。稅費在配息當下扣除。
   ========================================================================== */

/**
 * @param {object} s  使用者輸入（已正規化為小數比率）
 * @param {number} dScale 配息漂移倍率（1 = 照填的配息率）
 */
function project(s, dScale = 1) {
  const lotSize = RULES.market.lotSize.value;
  const par = RULES.market.parValue.value;
  const creditRate = RULES.incomeTax.dividendCreditRate.value;
  const creditCap = RULES.incomeTax.dividendCreditCap.value;
  const sepRate = RULES.incomeTax.dividendSeparateRate.value;
  const nhiOpt = {
    rate: RULES.nhi.supplementRate.value,
    floor: RULES.nhi.threshold.value,
    cap: RULES.nhi.singlePaymentCap.value,
  };

  const k = s.freq;
  const steps = Math.round(s.years * k);
  const shares0 = s.lots * lotSize;
  const invested = shares0 * s.price;
  const gPer = Math.pow(1 + s.trend, 1 / k) - 1;   // 幾何分攤，不是除以 k
  const bonusRate = s.stockDiv / par;              // 無償配股率
  const d = s.divYield * dScale;

  let price = s.price;
  let sharesA = shares0;   // 配息再投入
  let sharesB = shares0;   // 配息領現金
  let cashB = 0;           // 已領到手的淨現金（累計）
  let year = 0;
  // 8.5% 可抵減稅額是「每一申報戶每年」上限，所以要逐年重置、且兩個組合各自累計
  let creditUsedA = 0, creditUsedB = 0;

  /** 這一次配息的稅。合併計稅在低級距時會是負數，那就是真的可以退稅。 */
  const taxOf = (divIncome, used) => {
    if (s.taxMode === 'separate') return { tax: divIncome * sepRate, credit: 0 };
    const credit = Math.min(divIncome * creditRate, Math.max(0, creditCap - used));
    return { tax: divIncome * s.bracket - credit, credit };
  };

  let grossTotal = 0, taxTotal = 0, nhiTotal = 0, feeTotal = 0, netTotal = 0;

  const rows = [];
  const pathA = [{ x: 0, y: invested }];
  const pathB = [{ x: 0, y: invested }];
  const own = s.mode === 'reinvest' ? 'A' : 'B';

  for (let i = 1; i <= steps; i++) {
    const yNow = Math.ceil(i / k);
    if (yNow !== year) { year = yNow; creditUsedA = 0; creditUsedB = 0; }

    const before = price * (1 + gPer);                    // 除息前收盤價
    const D = before * (d / k);                           // 每股現金股利
    const ex = (before - D) / (1 + bonusRate);            // 除權息參考價
    const after = ex + s.fill * D;                        // 填息後價位

    // 除息當下（尚未配股、尚未再投入）的持股，公式與門檻提示都要用這個數字
    const heldA = sharesA, heldB = sharesB;

    // ---- 再投入組：先領股票股利，再用淨現金於除權息參考價買進 ----
    const grossA = sharesA * D;
    const incA = grossA * s.qual;                         // 只有股利所得那部分課稅費
    const nhiA = nhiSupplement(incA, nhiOpt);
    const tA = taxOf(incA, creditUsedA); creditUsedA += tA.credit;
    const netA = grossA - nhiA - tA.tax;
    const feeA = s.fee && netA > 0 ? twTradeCost(netA, {
      side: 'buy',
      discount: RULES.market.brokerFeeDiscount.value,
      minFee: RULES.market.brokerFeeMin.value,
      feeRate: RULES.market.brokerFeeRate.value,
    }) : 0;
    sharesA *= (1 + bonusRate);
    if (ex > 0.01) sharesA += Math.max(0, netA - feeA) / ex;

    // ---- 領現金組：股票股利照領，現金留在手上 ----
    const grossB = sharesB * D;
    const incB = grossB * s.qual;
    const nhiB = nhiSupplement(incB, nhiOpt);
    const tB = taxOf(incB, creditUsedB); creditUsedB += tB.credit;
    const netB = grossB - nhiB - tB.tax;
    sharesB *= (1 + bonusRate);
    cashB += netB;

    price = after;

    // 「你這一聯」：招牌視覺、門檻提示與明細表都跟著使用者選的做法走
    const gross = own === 'A' ? grossA : grossB;
    const nhi = own === 'A' ? nhiA : nhiB;
    const tax = own === 'A' ? tA.tax : tB.tax;
    const fee = own === 'A' ? feeA : 0;
    const net = (own === 'A' ? netA : netB) - fee;

    grossTotal += gross; taxTotal += tax; nhiTotal += nhi; feeTotal += fee; netTotal += net;

    rows.push({
      i, year: yNow, before, D, ex, after, gross, nhi, tax, fee, net,
      held: own === 'A' ? heldA : heldB,
      sharesA, sharesB,
    });
    pathA.push({ x: i / k, y: sharesA * price });
    pathB.push({ x: i / k, y: sharesB * price + cashB });
  }

  const endPrice = price;
  const valueA = sharesA * endPrice;
  const valueB = sharesB * endPrice + cashB;
  const valueC = invested * Math.pow(1 + s.mkt, s.years);
  const pathC = [];
  for (let i = 0; i <= steps; i++) {
    pathC.push({ x: i / k, y: invested * Math.pow(1 + s.mkt, i / k) });
  }

  const cagr = (v) => (invested > 0 && s.years > 0 ? Math.pow(v / invested, 1 / s.years) - 1 : NaN);

  return {
    steps, invested, shares0, endPrice, rows,
    pathA, pathB, pathC,
    valueA, valueB, valueC, cashB, sharesA, sharesB,
    cagrA: cagr(valueA), cagrB: cagr(valueB), cagrC: cagr(valueC),
    grossTotal, taxTotal, nhiTotal, feeTotal, netTotal,
    valueOwn: s.mode === 'reinvest' ? valueA : valueB,
    cagrOwn: s.mode === 'reinvest' ? cagr(valueA) : cagr(valueB),
  };
}

/** 讀出目前輸入並正規化成模型要的單位（比率一律小數） */
function input() {
  const v = store.get();
  return {
    price: v.price,
    lots: Math.round(v.lots),
    years: Math.round(v.years),
    divYield: v.divYield / 100,
    freq: Number(v.freq),
    stockDiv: v.stockDiv,
    qual: v.qual / 100,
    drift: v.drift / 100,
    fill: v.fill / 100,
    trend: v.trend / 100,
    mkt: v.mkt / 100,
    bear: v.bear / 100,
    bracket: Number(v.bracket),
    taxMode: v.taxMode,
    fee: !!v.fee,
    mode: v.mode,
  };
}

/* ==========================================================================
   4. 招牌視覺：股價柱 → 切下來的那一塊 → 錢包 → 兩滴水
   一頁只花這一個動效，其他地方保持安靜。
   ========================================================================== */
const stageCv = $('#stage');
const sctx = stageCv.getContext('2d');

const STAGE = {
  // target = 除權息參考價 + 全部現金股利 = 「完全填息」的價位。
  // 同時配股時它會低於除息前收盤價，因為那一段是換成股數，本來就不該算成缺口。
  before: 20, D: 0, ex: 20, after: 20, target: 20, fill: 0.7,
  gross: 0, nhi: 0, tax: 0, net: 0,
  cumNet: 0, cumTax: 0, cumNhi: 0,
  idx: 0, total: 1, armed: false,
};
const A = { cut: 0, fly: 0, drip: 0, fill: 0 };

let SW = 320, SH = 240, SDPR = 1;

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

  const ink = cssv('--ink'), ink2 = cssv('--ink-2'), ink3 = cssv('--ink-3');
  const rule = cssv('--rule'), ruleF = cssv('--rule-faint'), ruleS = cssv('--rule-strong');
  const accent = cssv('--accent'), accentWash = cssv('--accent-wash');
  const up = cssv('--up'), down = cssv('--down'), ghost = cssv('--ghost');
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

  /* ---- 價格刻度：髮絲格線 ---- */
  ctx.save();
  ctx.font = `500 ${fs}px ${mono}`;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const tickDigits = pMax >= 20 ? 0 : pMax >= 2 ? 1 : 2;
  for (const p of niceTicks(0, pMax, 4)) {
    const y = Math.round(yOf(p)) + 0.5;
    if (y < top - 1 || y > base + 1) continue;
    ctx.strokeStyle = ruleF;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(SW - 8, y); ctx.stroke();
    ctx.fillStyle = ink3;
    ctx.fillText(dec(p, tickDigits), padL - 4, y);
  }
  ctx.strokeStyle = rule;
  ctx.beginPath(); ctx.moveTo(padL + 0.5, top); ctx.lineTo(padL + 0.5, base + 0.5); ctx.lineTo(SW - 8, base + 0.5); ctx.stroke();
  ctx.restore();

  const yBefore = yOf(STAGE.before);
  const yEx = yOf(STAGE.ex);
  const yAfter = yOf(STAGE.after);
  const yTarget = yOf(STAGE.target);
  const hasBonus = STAGE.target < STAGE.before - 0.005;

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

  /* ---- 同時配股時：完全填息的目標價低於除息前，因為那一段換成了股數 ---- */
  if (hasBonus && A.fly > 0) {
    ctx.save();
    ctx.strokeStyle = ink3;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();
    ctx.moveTo(barCx - barW / 2 - 6, Math.round(yTarget) + 0.5);
    ctx.lineTo(lineR, Math.round(yTarget) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.font = `700 ${fs}px ${cjk}`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = ink3;
    ctx.fillText(`填息目標 ${dec(STAGE.target, 2)}`, lineR, yTarget - 3);
    ctx.restore();
  }

  /* ---- 除權息參考價：那一刀落在這裡 ---- */
  if (STAGE.D > 0 && A.fly > 0) {
    ctx.save();
    ctx.strokeStyle = ink2;
    ctx.lineWidth = 1;
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
  const barTopP = A.fly > 0 ? lerp(STAGE.ex, STAGE.after, A.fill) : STAGE.before;
  const barTopY = yOf(barTopP);
  ctx.save();
  ctx.fillStyle = accentWash;
  ctx.fillRect(Math.round(barCx - barW / 2), Math.round(barTopY), Math.round(barW), Math.round(base - barTopY));
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(Math.round(barCx - barW / 2) + 0.5, Math.round(barTopY) + 0.5, Math.round(barW) - 1, Math.round(base - barTopY) - 1);
  ctx.restore();

  /* ---- 沒填回來的那一段：陰影就是「沒填息」的具體形狀 ---- */
  if (A.fill > 0.45 && STAGE.after < STAGE.target - 1e-9) {
    const alpha = clamp((A.fill - 0.45) / 0.45, 0, 1);
    const gy = Math.round(yTarget);
    const gh = Math.max(3, Math.round(yAfter - yTarget));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.rect(Math.round(barCx - barW / 2), gy, Math.round(barW), gh);
    ctx.clip();
    ctx.strokeStyle = ghost;
    ctx.lineWidth = 1;
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
  if (A.cut > 0 && A.fly < 1) {
    ctx.save();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.5;
    const x0 = barCx - barW / 2 - 8;
    const x1 = x0 + (barW + 16) * A.cut;
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(yEx) + 0.5);
    ctx.lineTo(x1, Math.round(yEx) + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  /* ---- 飛行路徑：靜止時也要看得出「那一塊等一下會飛去哪裡」 ---- */
  const slabH0 = Math.max(4, yEx - yBefore);
  if (A.fly >= 1 && STAGE.D > 0) {
    const x0 = barCx + barW / 2 + 2, x1 = walletCx - walletW / 2 - 2;
    const y0 = yBefore + slabH0 / 2, y1 = walletTop + walletH / 2;
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
    // 窄螢幕上這行字會撞到價位標籤，金額在錢包與說明文字裡都有，這裡就讓路
    if (!small) {
      ctx.font = `700 ${fs}px ${cjk}`;
      ctx.fillStyle = ink3;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(`配息 ${int(STAGE.gross)}`, (x0 + x1) / 2, (y0 + y1) / 2 - 26);
    }
    ctx.restore();
  }

  /* ---- 切下來的那一塊：從綠（股價跌）飛成紅（現金流入） ---- */
  if (A.fly > 0 && A.fly < 1) {
    const t = A.fly;
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
  const ww = Math.round(walletW), wh = walletH;
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
  ctx.fillText(int(STAGE.cumNet + STAGE.net * A.fly), wx + ww / 2, wy + 28);
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
    const dy = wy + wh + 4 + A.drip * 20;
    if (A.drip > 0 && Math.abs(dp.v) > 0.5) {
      ctx.globalAlpha = 1 - A.drip * 0.35;
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
    ctx.fillText((outflow ? '−' : '+') + int(Math.abs(dp.cum + dp.v * A.drip)), cx, wy + wh + 48);
  });
  ctx.restore();

  /* ---- 底線：等號兩邊 ---- */
  ctx.save();
  ctx.font = `700 ${fs}px ${cjk}`;
  ctx.fillStyle = ink2;
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText('股價', barCx, base + 18);
  ctx.fillText('錢包', walletCx, base + 18);
  ctx.restore();
}

/* ---- 一次除息的時間軸：切 → 飛 → 滴 → 填 ---- */
const tl = gsap.timeline({ paused: true, onUpdate: drawStage, onComplete: onStepDone });
/* 這一段刻意不用 EASE：'paper' 是紙落定用的前重尾長曲線，套在飛行上會一瞬間就到位，
   使用者根本看不見「錢從左手到右手」這件事。飛行要等速一點才讀得出來。 */
tl.fromTo(A, { cut: 0 }, { cut: 1, duration: 0.30, ease: 'none' }, 0)
  .fromTo(A, { fly: 0 }, { fly: 1, duration: 0.70, ease: 'power1.inOut' }, 0.28)
  .fromTo(A, { drip: 0 }, { drip: 1, duration: 0.55, ease: 'power1.in' }, 0.86)
  .fromTo(A, { fill: 0 }, { fill: 1, duration: 0.66, ease: EASE }, 1.02);

let cursor = 0;      // 已完成的除息次數
let playing = false;
let RES = null;
let pendingTimer = 0;

function loadStep(n) {
  if (!RES || !RES.rows.length) return;
  const r = RES.rows[clamp(n, 1, RES.rows.length) - 1];
  let cumNet = 0, cumTax = 0, cumNhi = 0;
  for (let i = 0; i < n - 1; i++) {
    cumNet += RES.rows[i].net; cumTax += RES.rows[i].tax; cumNhi += RES.rows[i].nhi;
  }
  Object.assign(STAGE, {
    before: r.before, D: r.D, ex: r.ex, after: r.after, target: r.ex + r.D,
    gross: r.gross, nhi: r.nhi, tax: r.tax, net: r.net,
    cumNet, cumTax, cumNhi, idx: n, total: RES.rows.length,
  });
}

function setRest() {
  // 停在「已完成」的狀態：柱子已填息、缺口陰影留著、錢包已入帳
  A.cut = 1; A.fly = 1; A.drip = 1; A.fill = 1;
}

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
    A.cut = 0; A.fly = 0; A.drip = 0; A.fill = 0;
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
  $('#stageCounter').textContent = `第 ${STAGE.idx}／${STAGE.total} 次`;
  const g = STAGE.idx === 0
    ? '目前停在起點，還沒除息。'
    : `第 ${STAGE.idx} 次除息：除息前 ${dec(STAGE.before, 2)} 元，每股配 ${dec(STAGE.D, 3)} 元，`
      + `除權息參考價 ${dec(STAGE.ex, 2)} 元；填息 ${pct(input().fill, 0)} 後回到 ${dec(STAGE.after, 2)} 元，`
      + `離完全填息的 ${dec(STAGE.target, 2)} 元還差 ${dec(STAGE.target - STAGE.after, 2)} 元`
      + (STAGE.target < STAGE.before - 0.005
        ? `（同時配股，所以完全填息的目標低於除息前收盤價，那一段是換成了股數）。`
        : '。')
      + `這一次毛配息 ${int(STAGE.gross)} 元，扣掉綜所稅 ${int(Math.round(STAGE.tax))} 元`
      + `與補充保費 ${int(Math.round(STAGE.nhi))} 元，淨入帳 ${int(Math.round(STAGE.net))} 元。`;
  const foot = $('#stageDesc');
  foot.textContent = g + '（配息很小時，切下來的那一塊會以最小可見厚度繪製，數字以文字為準。）';
  stageCv.setAttribute('aria-label', g);
}

/* ==========================================================================
   5. 賽跑圖與敏感曲線
   ========================================================================== */
const yFmt = (v) => (Math.abs(v) >= 1e8 ? (v / 1e8).toFixed(2) + '億'
  : Math.abs(v) >= 1e4 ? (v / 1e4).toFixed(Math.abs(v) >= 1e5 ? 0 : 1) + '萬'
  : String(Math.round(v)));

const race = new Plot($('#race'), {
  aspect: 0.52,
  yFormat: yFmt,
  xFormat: (v) => Math.round(v) + '年',
  padding: { left: 54, bottom: 28, top: 16, right: 14 },
});

const sense = new Plot($('#sense'), {
  aspect: 0.38,
  yFormat: yFmt,
  xFormat: (v) => Math.round(v * 100) + '%',
  padding: { left: 54, bottom: 28, top: 14, right: 14 },
});

const SERIES = [
  { key: 'A', token: '--series-1', label: '配息再投入' },
  { key: 'B', token: '--series-4', label: '配息領現金（含已領現金）' },
  { key: 'C', token: '--series-5', label: '市值型不配息' },
];

function paintRace() {
  if (!RES) return;
  const s = input();
  const cutX = cursor / s.freq;
  const paths = { A: RES.pathA, B: RES.pathB, C: RES.pathC };
  const series = [];
  for (const def of SERIES) {
    const color = cssv(def.token);
    const all = paths[def.key];
    series.push({ type: 'line', data: all, color, width: 1.2, dash: [4, 3], alpha: 0.4, noCursor: true });
    series.push({
      type: 'line',
      data: all.filter((p) => p.x <= cutX + 1e-9),
      color, width: 2.4, label: def.label,
    });
  }
  race.setSeries(series, { animate: false });
  race.setMarks(cursor > 0 && cursor < RES.rows.length
    ? [{ axis: 'x', value: cutX, color: cssv('--ink-3'), dash: [2, 3] }]
    : []);

  // 圖表的結論同時用文字說一次，不讓視覺是唯一的資訊通道
  const desc = `橫軸是年，縱軸是總價值（市值＋已領現金）。實線畫到目前的播放位置，虛線是後面還沒跑到的部分。`
    + `${s.years} 年後：配息再投入 ${wan(RES.valueA)}（年化 ${pct(RES.cagrA, 2)}）、`
    + `配息領現金 ${wan(RES.valueB)}（年化 ${pct(RES.cagrB, 2)}）、`
    + `市值型不配息 ${wan(RES.valueC)}（年化 ${pct(RES.cagrC, 2)}）。`;
  $('#raceDesc').textContent = desc;
  $('#race').setAttribute('aria-label', desc);
}

let senseKey = '';
let sensePts = [];
function paintSense(s) {
  const key = JSON.stringify([s.price, s.lots, s.years, s.divYield, s.freq, s.stockDiv,
    s.qual, s.trend, s.bracket, s.taxMode, s.fee, s.mode]);
  const marks = [{ axis: 'x', value: s.fill, color: cssv('--accent'), dash: [4, 3], label: '你現在的填息率' }];
  if (senseKey !== key) {
    senseKey = key;
    sensePts = [];
    for (let f = 0; f <= 100; f += 2) {
      const r = project({ ...s, fill: f / 100 });
      sensePts.push({ x: f / 100, y: s.mode === 'reinvest' ? r.valueA : r.valueB });
    }
    sense.setSeries([{ type: 'area', data: sensePts, color: cssv('--series-1'), width: 2.2, fillAlpha: 0.12 }], { animate: false });
  }
  sense.setMarks(marks);

  const v0 = sensePts[0]?.y, v70 = sensePts[35]?.y, v100 = sensePts[sensePts.length - 1]?.y;
  const desc = `橫軸是填息率 0 到 100%，縱軸是${s.mode === 'reinvest' ? '配息再投入' : '配息領現金'}組合的期末總價值。`
    + `完全不填息 ${wan(v0)}、填息 70% ${wan(v70)}、完全填息 ${wan(v100)}，`
    + `每多填 10 個百分點，平均多 ${wan((v100 - v0) / 10)}。`
    + `你現在填的是 ${Math.round(s.fill * 100)}%。`;
  $('#senseDesc').textContent = desc;
  $('#sense').setAttribute('aria-label', desc);
}

/* ==========================================================================
   6. 輸入元件
   ========================================================================== */
function patch(p, opts = {}) {
  store.set(p);
  compute(opts);
}

const fPrice = bindField($('#f-price'), {
  validate: (v) => (!Number.isFinite(v) || v <= 0 ? '請填入大於 0 的股價' : v > 10000 ? '超出試算範圍' : null),
  onChange: (v, { valid }) => { if (valid) patch({ price: v }); },
});

const fYield = bindField($('#f-yield'), {
  validate: (v) => (!Number.isFinite(v) || v < 0 ? '請填入 0 以上的數字' : v > 40 ? '年化配息率超過 40% 已不是可持續的假設' : null),
  onChange: (v, { valid }) => { if (valid) patch({ divYield: v }); },
});

const fStockDiv = bindField($('#f-stockdiv'), {
  validate: (v) => (!Number.isFinite(v) || v < 0 ? '請填入 0 以上的數字' : v > 10 ? '股票股利以每股 10 元為上限試算' : null),
  onChange: (v, { valid }) => { if (valid) patch({ stockDiv: v }); },
});

const fTrend = bindField($('#f-trend'), {
  validate: (v) => (!Number.isFinite(v) ? '請填入數字' : v < -30 || v > 30 ? '請填 −30% 到 30% 之間' : null),
  onChange: (v, { valid }) => { if (valid) patch({ trend: v }); },
});

const fMkt = bindField($('#f-mkt'), {
  validate: (v) => (!Number.isFinite(v) ? '請填入數字' : v < -30 || v > 30 ? '請填 −30% 到 30% 之間' : null),
  onChange: (v, { valid }) => { if (valid) patch({ mkt: v }); },
});

const fBracket = bindField($('#f-bracket'), {
  onChange: (v) => patch({ bracket: Number(v) }),
});

/* 拖曳中每幀都重算數字，但「複寫壓力傳遞」只在放手時播一次，否則變成閃爍 */
const onSlide = (key) => (v, source) => patch({ [key]: v }, { live: source !== 'drag' });

const sLots = bindSlider($('#s-lots'), { format: (v) => `${v}<small>張</small>`, onInput: onSlide('lots') });
const sYears = bindSlider($('#s-years'), { format: (v) => `${v}<small>年</small>`, onInput: onSlide('years') });
const sQual = bindSlider($('#s-qual'), { format: (v) => `${v}<small>%</small>`, onInput: onSlide('qual') });
const sDrift = bindSlider($('#s-drift'), { format: (v) => `±${v}<small>%</small>`, onInput: onSlide('drift') });
const sFill = bindSlider($('#s-fill'), { format: (v) => `${v}<small>%</small>`, onInput: onSlide('fill') });
const sBear = bindSlider($('#s-bear'), { format: (v) => `${v}<small>%</small>`, onInput: onSlide('bear') });

const segFreq = bindSegmented($('#seg-freq'), { onChange: (v) => patch({ freq: Number(v) }, { live: true }) });
const segTax = bindSegmented($('#seg-taxmode'), { onChange: (v) => patch({ taxMode: v }, { live: true }) });
const segMode = bindSegmented($('#seg-mode'), { onChange: (v) => patch({ mode: v }, { live: true }) });

$('#sw-fee').addEventListener('change', (e) => patch({ fee: e.target.checked }, { live: true }));

$('#resetBtn').addEventListener('click', () => {
  store.replace(DEFAULTS());
  location.replace(location.pathname);
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
   7. 輸出
   ========================================================================== */
const cFinal = makeCounter($('#r-final'), (v) => money(Math.round(v), { compact: true }));
const cCumDiv = makeCounter($('#r-cumdiv'), (v) => money(Math.round(v), { compact: true }));
const cGain = makeCounter($('#r-gain'), (v) => money(Math.round(v), { compact: true }));
const cLeak = makeCounter($('#r-leak'), (v) => money(Math.round(v), { compact: true }));

let vtable = null;
let tableRows = [];
let curFreq = 1;
let curMode = 'reinvest';
let lastThresholdOver = null;
let stampedFor = null;

function compute({ live = false } = {}) {
  const s = input();
  RES = project(s);
  tableRows = RES.rows;
  curFreq = s.freq;
  curMode = s.mode;
  if (playing) setPlaying(false);   // 改了輸入就停下來，不要一邊播一邊換數字

  /* ---- 拒答：股價被配到近乎歸零，這個模型不適用 ---- */
  const collapsed = RES.endPrice < s.price * 0.05;
  $('#refuse').hidden = !collapsed;
  $('#raceCard').hidden = collapsed;
  $('#senseCard').hidden = collapsed;
  $('#compareCard').hidden = collapsed;
  if (collapsed) {
    $('#refuseBody').textContent =
      `你填的配息率 ${pp(s.divYield * 100, 1)}、填息率 ${pct(s.fill, 0)}、價格趨勢 ${pp(s.trend * 100, 1)}，`
      + `${s.years} 年後股價會掉到 ${dec(RES.endPrice, 2)} 元，只剩起始的 ${pct(RES.endPrice / s.price, 1)}。`
      + '現實中公司或 ETF 會先減配、清算或下市，這個模型不能回答這種情境，'
      + '把填息率往上拉，或把配息率調低，數字才有意義。';
  }

  /* ---- 播放游標 ---- */
  cursor = clamp(cursor, 0, RES.rows.length);

  /* ---- 讀數 ---- */
  const gain = RES.valueOwn - RES.invested;
  const leak = RES.taxTotal + RES.nhiTotal + RES.feeTotal;
  cFinal(RES.valueOwn);
  cCumDiv(RES.grossTotal);
  cGain(gain);
  cLeak(leak);

  const lo = project(s, 1 - s.drift);
  const hi = project(s, 1 + s.drift);
  const loV = s.mode === 'reinvest' ? lo.valueA : lo.valueB;
  const hiV = s.mode === 'reinvest' ? hi.valueA : hi.valueB;
  $('#r-finalRange').textContent = s.drift > 0
    ? `配息漂移 ±${Math.round(s.drift * 100)}%：${money(Math.round(loV), { compact: true })} ~ ${wan(hiV)}`
    : '';
  $('#r-finalRange').dataset.dir = 'flat';

  const cg = $('#r-cagr');
  cg.textContent = Number.isFinite(RES.cagrOwn) ? `年化 ${pct(RES.cagrOwn, 2, { sign: true })}` : '';
  cg.dataset.dir = RES.cagrOwn > 0 ? 'up' : RES.cagrOwn < 0 ? 'down' : 'flat';

  const lp = $('#r-leakpct');
  lp.textContent = RES.grossTotal > 0 ? `佔毛配息 ${pct(leak / RES.grossTotal, 1)}` : '';
  lp.dataset.dir = leak > 0 ? 'down' : 'flat';

  /* ---- 圖 ---- */
  if (!collapsed) {
    paintRace();
    paintSense(s);
    renderCompare(s);
  }

  /* ---- 招牌視覺 ---- */
  gotoCursor(cursor);

  /* ---- 其餘面板 ---- */
  renderVerdict(s);
  renderThreshold(s);
  renderOtherSide(s);
  renderTable(s);
  renderFormula(s);
  renderMktHint(s);

  if (live) carbonTransfer($$('[data-live]'));
}

function renderMktHint(s) {
  const fair = (s.trend + s.divYield) * 100;
  $('#mktHint').innerHTML =
    `「同樣的獲利能力，一個配出來、一個留在股價裡」對應的市值型報酬是 <b>${dec(fair, 2)}%</b>`
    + `（趨勢 ${dec(s.trend * 100, 2)}% ＋ 配息率 ${dec(s.divYield * 100, 2)}%）。`
    + '這只是一個假設，不是事實：兩個標的本來就可能有不同的報酬。改成你自己相信的數字。';
}

function renderCompare(s) {
  const host = $('#compare');
  host.replaceChildren();
  const rows = [
    { def: SERIES[0], v: RES.valueA, c: RES.cagrA },
    { def: SERIES[1], v: RES.valueB, c: RES.cagrB },
    { def: SERIES[2], v: RES.valueC, c: RES.cagrC },
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
      + `剩下的差距來自兩股相反的力量：稅與補充保費 ${wan(RES.taxTotal + RES.nhiTotal + RES.feeTotal)}把它往下拉；`
      + '而「在除權息參考價買進、之後價格又完全填回去」等於用折價買到，把它往上推。'
      + '真正決定結果的是填息，而填息是市場給的。';
  } else {
    note.innerHTML = `把填息率拉到 100% 再看一次這三個數字。現在少掉的那 ${pct(1 - s.fill, 0)} 缺口，`
      + `${s.years} 年累積下來讓配息再投入${gapAC >= 0 ? '仍比市值型多了 ' : '比市值型少了 '}`
      + `${wan(Math.abs(gapAC))}。`
      + '這個差距是<b>你填的假設</b>造出來的，不是任何標的的實際表現。';
  }
}

function renderVerdict(s) {
  const h = $('#verdict-h');
  const body = $('#verdictBody');
  const stamp = $('#verdictStamp');
  const gain = RES.valueOwn - RES.invested;

  h.innerHTML = `${s.years} 年下來你收到 <em>${wan(RES.grossTotal)}</em>配息，`
    + `但總價值只增加了 <em>${wan(gain)}</em>。`;

  const diff = RES.grossTotal - gain;
  body.textContent = diff > 0
    ? `差的那 ${int(Math.round(diff))} 元，一部分是稅與補充保費（${int(Math.round(RES.taxTotal + RES.nhiTotal))} 元），`
      + `其餘是沒有填回來的價格缺口。除息當天你的總資產一塊都沒變，真正決定結果的是填息與含息總報酬，不是配息金額。`
    : `這一組假設下，總價值增加得比配息還多，因為除息以外的價格趨勢（${pp(s.trend * 100, 2)}）也在貢獻。`
      + `配息與報酬本來就是兩件事，這裡剛好是往上的那一面。`;

  const key = `${Math.round(s.fill * 100)}`;
  stamp.hidden = false;
  if (stampedFor !== key) {
    const cls = s.fill >= 0.999 ? 'stamp stamp--ok' : s.fill <= 0.001 ? 'stamp stamp--void' : 'stamp';
    const txt = s.fill >= 0.999 ? '完全填息' : s.fill <= 0.001 ? '完全沒填息' : `填息 ${Math.round(s.fill * 100)}%`;
    stamp.innerHTML = `<span class="${cls}">${txt}</span>`;
    stampIn(stamp.firstElementChild);
    stampedFor = key;
  }
}

function renderThreshold(s) {
  const host = $('#thresholdNote');
  const floor = RULES.nhi.threshold.value;
  const rate = RULES.nhi.supplementRate.value;
  const r = RES.rows[Math.max(0, Math.min(RES.rows.length - 1, cursor - 1))] || RES.rows[0];
  if (!r) { host.textContent = ''; return; }
  const divIncome = r.gross * s.qual;
  const over = divIncome >= floor;

  const lotSize = RULES.market.lotSize.value;
  const heldLots = r.held / lotSize;
  const perLot = r.D * lotSize * s.qual;                   // 每一張帶來的股利所得
  const needLots = perLot > 0 ? Math.ceil(floor / perLot) : Infinity;
  const nhiAt = (lots) => nhiSupplement(lots * perLot, { rate, floor, cap: RULES.nhi.singlePaymentCap.value });

  host.dataset.over = String(over);
  host.innerHTML =
    `<span class="threshold__big">${int(Math.round(divIncome))} 元</span>`
    + `這一次配息中屬股利所得的部分（持股 ${dec(heldLots, 1)} 張）。門檻是 <b>${int(floor)} 元</b>，`
    + (over
      ? `已經跨過，所以<b>全額</b>乘上 ${pp(rate * 100, 2)} ＝ ${int(Math.round(r.nhi))} 元補充保費。`
        + `達門檻就是全額計費，不是只算超過的那一段，這就是門檻旁邊會出現階梯的原因。`
        + (Number.isFinite(needLots) && needLots > 1
          ? ` 這一次若只持有 <b>${needLots - 1} 張</b>就不用扣，`
            + `所以第 ${needLots - 1} 張到第 ${needLots} 張之間，補充保費從 0 元直接跳到 ${int(Math.round(nhiAt(needLots)))} 元。`
          : '')
      : `還沒跨過，這一次不用扣補充保費。`
        + (Number.isFinite(needLots)
          ? ` 加到 <b>${needLots} 張</b>就會跨過，一跨過就是全額 ${int(Math.round(nhiAt(needLots)))} 元，`
            + `多配那一點點息，代價是整筆都要扣。`
          : ''));

  if (lastThresholdOver !== null && lastThresholdOver !== over) flagCross(host);
  lastThresholdOver = over;

  const qp = Math.round(s.qual * 100);
  $('#segQual').style.width = qp + '%';
  $('#segOther').style.width = (100 - qp) + '%';
  $('#composeNote').textContent =
    `配息組成假設：${qp}% 是股利所得（要課綜所稅與補充保費）、${100 - qp}% 來自收益平準金或已實現資本利得（不課）。`
    + 'ETF 的配息組成每次公告都不一樣，這裡是你自己填的假設。';
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

function renderTable(s) {
  const wrap = $('#ledgerWrap');
  if (!vtable) {
    vtable = virtualTable(wrap, {
      rowHeight: 36,
      total: tableRows.length,
      render: (i) => {
        const r = tableRows[i];
        if (!r) return null;
        const tr = el('tr', i + 1 === cursor ? { 'data-mark': 'cursor' } : {});
        const seq = curFreq === 1 ? `${r.year} 年` : `${r.year}-${((r.i - 1) % curFreq) + 1}`;
        tr.appendChild(el('td', { text: seq }));
        tr.appendChild(el('td', { text: dec(r.before, 2) }));
        tr.appendChild(el('td', { text: dec(r.D, 3) }));
        tr.appendChild(el('td', { text: dec(r.ex, 2) }));
        tr.appendChild(el('td', { text: dec(r.after, 2) }));
        tr.appendChild(el('td', { class: 'is-up', text: int(Math.round(r.gross)) }));
        tr.appendChild(el('td', { class: r.tax + r.nhi + r.fee >= 0 ? 'is-down' : 'is-up', text: int(Math.round(r.tax + r.nhi + r.fee)) }));
        tr.appendChild(el('td', { text: int(Math.round(r.net)) }));
        return tr;
      },
    });
  }
  vtable.setTotal(tableRows.length);
  $('#tableFoot').innerHTML =
    `共 ${tableRows.length} 次配息．毛配息合計 ${int(Math.round(RES.grossTotal))} 元．`
    + `綜所稅 ${int(Math.round(RES.taxTotal))} 元、補充保費 ${int(Math.round(RES.nhiTotal))} 元`
    + (curMode === 'reinvest' ? `、再投入手續費 ${int(Math.round(RES.feeTotal))} 元` : '')
    + `．期末股價 ${dec(RES.endPrice, 2)} 元（起始 ${dec(s.price, 2)} 元）`;
}

$('#jumpCursor').addEventListener('click', () => {
  if (!cursor) { toast('還在起點，先按一次「單步除息」'); return; }
  $('#tableCard').scrollIntoView({ behavior: still() ? 'auto' : 'smooth', block: 'center' });
  vtable?.scrollToRow(cursor - 1);
});

/* ==========================================================================
   8. 公式與法源
   ========================================================================== */
const src = (o) => `${o.legalBasis || ''}${o.sourceUrl ? `　<a href="${o.sourceUrl}" target="_blank" rel="noopener">法源連結</a>` : ''}`;

function renderFormula(s) {
  const host = $('#formulaHost');
  host.replaceChildren();
  const r = RES.rows[Math.max(0, Math.min(RES.rows.length - 1, cursor - 1))] || RES.rows[0];
  if (!r) return;
  const M = RULES.market, T = RULES.incomeTax, N = RULES.nhi;
  const bonus = s.stockDiv / M.parValue.value;

  host.appendChild(formulaBlock('攤開看：除權息參考價怎麼算', [
    `<b>只有現金股利</b>　除息參考價 = 前一營業日收盤價 − 每股現金股利`,
    `= ${dec(r.before, 4)} − ${dec(r.D, 4)} = <b>${dec(r.before - r.D, 4)}</b> 元`,
    `<b>同時配股</b>　除權息參考價 = (前收盤價 − 現金股利) ÷ (1 + 無償配股率)`,
    `無償配股率 = 股票股利 ${dec(s.stockDiv, 2)} 元 ÷ 面額 ${M.parValue.value} 元 = ${dec(bonus, 4)}`,
    `= (${dec(r.before, 4)} − ${dec(r.D, 4)}) ÷ (1 + ${dec(bonus, 4)}) = <b>${dec(r.ex, 4)}</b> 元`,
    `<b>填息</b>　除息後股價 = 除權息參考價 + 填息率 × 每股現金股利`,
    `= ${dec(r.ex, 4)} + ${dec(s.fill, 2)} × ${dec(r.D, 4)} = <b>${dec(r.after, 4)}</b> 元`,
  ], src(M.exRightRefPrice || {})));

  const divIncome = r.gross * s.qual;
  const creditRaw = divIncome * T.dividendCreditRate.value;
  host.appendChild(formulaBlock('攤開看：這一次配息被課走多少', [
    `毛配息 = 除息當下持股 ${int(Math.round(r.held))} 股 × ${dec(r.D, 4)} 元 = <b>${int(Math.round(r.gross))}</b> 元`,
    `其中股利所得 = ${int(Math.round(r.gross))} × ${Math.round(s.qual * 100)}% = <b>${int(Math.round(divIncome))}</b> 元`,
    s.taxMode === 'separate'
      ? `<b>分開計稅</b>　稅額 = 股利所得 × ${pp(T.dividendSeparateRate.value * 100, 0)} = <b>${int(Math.round(r.tax))}</b> 元`
      : `<b>合併計稅</b>　稅額 = 股利所得 × 邊際稅率 ${pp(s.bracket * 100, 0)} − 可抵減稅額`,
    s.taxMode === 'separate'
      ? `　選 28% 分開計稅還會連帶喪失長期照顧與房屋租金兩項特別扣除額（所得稅法第 17 條第 3 項，各 18 萬元）。`
        + `本工具只算這一次配息的稅，那筆代價不在上面的數字裡，所以 28% 制在這裡是被<b>低估</b>的。`
      : '',
    s.taxMode === 'separate' ? '' :
      `可抵減稅額 = ${int(Math.round(divIncome))} × ${pp(T.dividendCreditRate.value * 100, 1)} = ${int(Math.round(creditRaw))} 元（每戶每年上限 ${int(T.dividendCreditCap.value)} 元）`,
    s.taxMode === 'separate' ? '' :
      `= ${int(Math.round(divIncome * s.bracket))} − ${int(Math.round(divIncome * s.bracket - r.tax))} = <b>${int(Math.round(r.tax))}</b> 元${r.tax < 0 ? '（負值＝可退稅）' : ''}`,
    `<b>補充保費</b>　股利所得 ${int(Math.round(divIncome))} ${divIncome >= N.threshold.value ? '≥' : '<'} ${int(N.threshold.value)} 元`,
    divIncome >= N.threshold.value
      ? `→ 全額 × ${pp(N.supplementRate.value * 100, 2)} = <b>${int(Math.round(r.nhi))}</b> 元（單次費基上限 ${int(N.singlePaymentCap.value)} 元）`
      : `→ 未達門檻，<b>不扣</b>`,
  ].filter(Boolean), `${src(T.dividendCreditRate)}<br>${src(N.threshold)}<br>${src(N.supplementRate)}<br>規則版本：${RULES.ruleRegime?.nhiSupplementNote || ''}`));

  host.appendChild(formulaBlock('攤開看：總報酬與那個關鍵不等式', [
    `總報酬 = (期末市值 + 累計配息或再投入後的市值) ÷ 期初投入 − 1`,
    `期初投入 = ${int(s.lots)} 張 × ${int(M.lotSize.value)} 股 × ${dec(s.price, 2)} 元 = <b>${int(RES.invested)}</b> 元`,
    `配息再投入：期末 ${int(Math.round(RES.valueA))} 元　總報酬 ${pct(RES.valueA / RES.invested - 1, 2)}　年化 ${pct(RES.cagrA, 2)}`,
    `配息領現金：期末 ${int(Math.round(RES.valueB))} 元（含已領現金 ${int(Math.round(RES.cashB))} 元）　年化 ${pct(RES.cagrB, 2)}`,
    `市值型不配息：期末 ${int(Math.round(RES.valueC))} 元　年化 ${pct(RES.cagrC, 2)}`,
    `<b>配息本身不創造價值</b>：除息當日 (股價 − 股利) × 股數 + 股利 × 股數 = 股價 × 股數，總資產不變。`,
    `<b>決定結果的是</b>填息（缺口補回多少）與含息總報酬，不是配息金額。`,
  ], '再投入以除權息參考價買進、允許小數股；稅款於各次配息按比例預扣（實際為隔年 5 月結算）；未計入 ETF 內扣費用與賣出成本。'));

  if (s.fee) {
    host.appendChild(formulaBlock('攤開看：再投入的手續費', [
      `手續費 = max(${int(M.brokerFeeMin.value)}, 成交金額 × ${dec(M.brokerFeeRate.value * 100, 4)}% × 折讓 ${dec(M.brokerFeeDiscount.value, 2)})`,
      `這一次：${int(Math.round(r.fee))} 元；${s.years} 年累計 <b>${int(Math.round(RES.feeTotal))}</b> 元`,
      `買進不課證交稅；本工具未模擬賣出，故未計證交稅與賣出手續費。`,
    ], `${src(M.brokerFeeRate)}<br><b>折讓 ${dec(M.brokerFeeDiscount.value, 2)} 為未查證假設值</b>：${M.brokerFeeDiscount.legalBasis || '各券商折讓不一，無公定值。'}`));
  }
}

/* ==========================================================================
   9. 啟動
   ========================================================================== */
function buildBracketOptions() {
  const sel = $('#f-bracket select');
  sel.replaceChildren();
  const bs = RULES.incomeTax.brackets114.value;
  bs.forEach((b) => {
    const range = b.max == null
      ? `${int(b.min)} 元以上`
      : `${int(b.min)}-${int(b.max)} 元`;
    sel.appendChild(el('option', {
      value: String(b.rate),
      text: `${Math.round(b.rate * 100)}%（綜所淨額 ${range}）`,
    }));
  });
}

function syncInputs() {
  const v = store.get();
  fPrice.set(v.price, { silent: true });
  fYield.set(v.divYield, { silent: true });
  fStockDiv.set(v.stockDiv, { silent: true });
  fTrend.set(v.trend, { silent: true });
  fMkt.set(v.mkt, { silent: true });
  fBracket.set(String(v.bracket), { silent: true });
  sLots.set(v.lots, { silent: true });
  sYears.set(v.years, { silent: true });
  sQual.set(v.qual, { silent: true });
  sDrift.set(v.drift, { silent: true });
  sFill.set(v.fill, { silent: true });
  sBear.set(v.bear, { silent: true });
  segFreq.set(String(v.freq));
  segTax.set(v.taxMode);
  segMode.set(v.mode);
  $('#sw-fee').checked = !!v.fee;
}

function renderLegend() {
  const host = $('#legend');
  host.replaceChildren();
  SERIES.forEach((d) => {
    host.appendChild(el('span', { class: 'legend__item' }, [
      el('span', { class: 'legend__key', style: `background:${cssv(d.token)}` }),
      el('span', { text: d.label }),
    ]));
  });
}

async function boot() {
  try {
    const res = await fetch('./rules.json');
    if (res.ok) {
      const j = await res.json();
      RULES = { ...RULES, ...j };
      $('#dataver').textContent = `資料版本 ${j.version}`;
      $('#dataver').title = j.note || '';
      $('#regimeChip').textContent = `補充保費：${j.ruleRegime?.nhiSupplement || '單筆起扣制'}`;
      $('#regimeChip').title = j.ruleRegime?.nhiSupplementNote || '';
    }
  } catch { $('#dataver').textContent = '資料版本 離線'; }

  buildBracketOptions();
  renderLegend();
  syncInputs();
  resizeStage();
  compute();

  // 首屏就是論點：載入即自動演一次除息，缺口陰影留在柱子上
  gotoCursor(1, { animate: true });
  printRows($$('#readouts .readout'), { stagger: 0.06, delay: 0.1 });

  if (store.cameFromLink) toast('已載入別人傳給你的情境');
}

boot();
