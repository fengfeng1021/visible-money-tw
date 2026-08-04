/* 勞退自提：一格輸入、一根滑桿、一個結論。

   為什麼要有這一頁：站上其他頁面都是專業級儀器，而人資系統裡那個自提欄位是
   每個受僱勞工都要面對的決定，多數人放棄思考它的原因就是「看起來很麻煩」。
   所以這一頁的設計目標只有一個：手機上不捲動就看完核心答案。

   關鍵洞察（也是整頁的招牌視覺）：自提金額不計入當年度綜合所得，
   所以你實際少領的錢比「月薪 × 自提率」少很多，少掉的那一塊就是你的邊際稅率。
   多數人不知道這件事，而它常常就是決定的分水嶺。
*/

import { gsap, printRows, stampIn, makeCounter, still } from '../../assets/js/core/motion.js';
import { Plot } from '../../assets/js/core/plot.js';
import { progressiveTax } from '../../assets/js/core/fin.js';
import {
  $, $$, el, bindSlider, bindField, mountTopbar, mountTheme, formulaBlock, toast, iconHTML,
} from '../../assets/js/core/ui.js';
import { int, dec, pct, pp, parseNum, clamp } from '../../assets/js/core/format.js';
import * as P from '../../assets/js/core/profile.js';

/* ==========================================================================
   常數。全部來自 assets/data，載不到就拒答，不用寫死的備份值。
   ========================================================================== */
let RULES = null;
let TAX = null;

const CONTRIB_MAX_PCT = 6;   // 勞工自願提繳上限，法定
const EMPLOYER_PCT = 6;      // 雇主強制提繳

/* 勞退月提繳工資分級表的上限。注意這跟勞保投保薪資分級表是兩張不同的表。
   查證中，值放在資料檔裡，這裡只留一個明確的預設與標記。 */
let CONTRIB_CAP = { value: 150000, confidence: 'unverified' };

/* ==========================================================================
   計算
   ========================================================================== */
function marginalRate(annualSalary) {
  if (!TAX) return 0.05;
  const y = TAX.years?.[String(TAX.defaultYear)] || TAX.years?.['114'];
  if (!y) return 0.05;
  // 單身、標準扣除額、薪資特扣。這一頁刻意不問家庭狀況，
  // 所以邊際稅率是「單身上班族」的估計值，畫面上要講清楚。
  const net = Math.max(0, annualSalary - y.exemption - y.standardSingle
    - Math.min(annualSalary, y.salaryDeduction));
  const r = progressiveTax(net, y.brackets);
  return r.rate;
}

function compute(monthly, ratePct) {
  const capped = Math.min(monthly, CONTRIB_CAP.value);
  const contrib = Math.round(capped * ratePct / 100);
  const annualSalary = monthly * 12;
  const mRate = marginalRate(annualSalary);

  // 自提不計入當年度綜合所得，所以少繳的稅就是你「賺回來」的那一塊
  const taxSaved = Math.round(contrib * 12 * mRate);
  const netCost = Math.round(contrib - taxSaved / 12);

  return {
    capped, contrib, mRate, taxSaved,
    netCost,                                  // 這個月實際少領的
    naiveCost: contrib,                       // 大家以為會少的
    employer: Math.round(capped * EMPLOYER_PCT / 100),
    // 一次性的稅務槓桿：付出 netCost，帳戶裡多了 contrib
    leverage: netCost > 0 ? contrib / netCost : 1,
    cappedBySalary: monthly > CONTRIB_CAP.value,
  };
}

/**
 * 損益兩平的自行投資報酬率。
 *
 * 這裡很容易寫錯，而且錯得很難被發現：稅務優勢是「一次性」的
 * （你付 netCost 就在帳戶裡拿到 contrib），不是每年重複發生。
 * 把那個一次性的 5.26% 講成「你自己投資要每年賺超過 5.26%」是嚴重高估——
 * 攤到 25 年只等於年化 0.2 個百分點。
 *
 * 正確的比較是把兩條路都推到 60 歲：
 *   自提   ：contrib   × (1 + rFund)^n × (1 − 提領時稅率)
 *   自己投資：netCost  × (1 + rSelf)^n
 * 令兩者相等解 rSelf。
 */
function breakevenSelfReturn(c, years, fundReturnPct, exitTaxRate = 0) {
  if (years <= 0 || c.netCost <= 0) return NaN;
  const rFund = fundReturnPct / 100;
  const target = c.leverage * Math.pow(1 + rFund, years) * (1 - exitTaxRate);
  return Math.pow(target, 1 / years) - 1;
}

/** 到 60 歲時這筆自提會累積成多少 */
function project(monthlyContrib, ageNow, annualReturn) {
  const months = Math.max(0, (60 - ageNow) * 12);
  const r = annualReturn / 100 / 12;
  const pts = [];
  let bal = 0, put = 0;
  for (let m = 0; m <= months; m++) {
    if (m > 0) { bal = bal * (1 + r) + monthlyContrib; put += monthlyContrib; }
    if (m % 6 === 0 || m === months) {
      pts.push({ x: ageNow + m / 12, bal, put });
    }
  }
  return { pts, months, final: bal, put };
}

/* ==========================================================================
   版面
   ========================================================================== */
mountTopbar({ title: '勞退自提划不划算' });
mountTheme($('#acts'));

const plot = new Plot($('#chart'), {
  aspect: 0.42,
  minHeight: 160,
  maxHeight: 260,
  yFormat: (v) => (v >= 10000 ? Math.round(v / 10000) + '萬' : String(Math.round(v))),
  xFormat: (v) => Math.round(v) + '歲',
  padding: { left: 46, bottom: 26, top: 14, right: 12 },
});

const cCost = makeCounter($('#r-cost'), (v) => int(v) + ' 元');
const cGain = makeCounter($('#r-gain'), (v) => int(v) + ' 元');

let salary = P.getOr('salary', 50000) || 50000;
let ratePct = 6;
let ageNow = 35;
let annualReturn = 3;
let stamped = null;

const fSalary = bindField($('#f-salary'), {
  pretty: int,
  validate: (v) => (!Number.isFinite(v) || v <= 0 ? '請填入你的月薪' : null),
  onChange: (v, { valid }) => {
    if (!valid) return;
    salary = v;
    P.set({ salary: v });          // 寫回共用檔案，其他工具就不用再問一次
    render();
  },
});

const sRate = bindSlider($('#s-rate'), {
  format: (v) => `${v}<small>%</small>`,
  onInput: (v) => { ratePct = v; render(); },
});

const fAge = bindField($('#f-age'), {
  validate: (v) => (!Number.isFinite(v) || v < 15 || v > 65 ? '請填 15 到 65 之間' : null),
  onChange: (v, { valid }) => { if (valid) { ageNow = v; render(); } },
});

const fReturn = bindField($('#f-return'), {
  validate: (v) => (!Number.isFinite(v) || v < 0 || v > 15 ? '請填 0 到 15 之間' : null),
  onChange: (v, { valid }) => { if (valid) { annualReturn = v; render(); } },
});

/* ==========================================================================
   繪製
   ========================================================================== */
function render() {
  const c = compute(salary, ratePct);

  cCost(c.netCost);
  cGain(c.contrib);

  $('#r-costSub').innerHTML = ratePct === 0
    ? '沒有自提'
    : `你以為會少 <s>${int(c.naiveCost)}</s>，但自提免稅，`
      + `所以實際只少 <b>${int(c.netCost)}</b>`;
  $('#r-gainSub').innerHTML = ratePct === 0
    ? `雇主每月仍會提繳 ${int(c.employer)} 元`
    : `雇主另外提繳 ${int(c.employer)} 元，合計每月進帳 <b>${int(c.contrib + c.employer)}</b>`;

  renderVerdict(c);
  renderProjection(c);
  renderLiquidity();
  renderFormula(c);
}

function renderVerdict(c) {
  const lead = $('#lead');
  const body = $('#body');
  const stamp = $('#stamp');

  if (ratePct === 0) {
    lead.textContent = '目前沒有自提';
    body.textContent = '拉一下滑桿，看看每多提一個百分點，你這個月實際少領多少、退休帳戶多多少。';
    stamp.hidden = true; stamped = null;
    return;
  }

  const years = Math.max(0, 60 - ageNow);
  const be = breakevenSelfReturn(c, years, annualReturn);
  const mr = (c.mRate * 100).toFixed(0);

  lead.innerHTML = `每月少領 <em>${int(c.netCost)}</em> 元，`
    + `帳戶多 <em>${int(c.contrib)}</em> 元。`;

  body.textContent =
    `自提不計入當年度綜合所得，所以你少領的比帳戶多的還少 ${int(c.contrib - c.netCost)} 元，`
    + `那一塊就是省下的稅（邊際稅率 ${mr}%）。`
    + (years > 0 && Number.isFinite(be)
      ? `把兩條路都推到 60 歲：這筆錢自己拿去投資，要每年穩定賺超過 ${pct(be, 2)} 才追得上自提。`
        + `注意這個門檻只比勞退基金假設報酬 ${annualReturn}% 高一點點，`
        + `因為稅務優勢是一次性的，攤到 ${years} 年之後每年只值 ${pct(be - annualReturn / 100, 2)}。`
      : '')
    + (c.cappedBySalary ? `你的月薪超過提繳上限 ${int(CONTRIB_CAP.value)} 元，超出的部分不能提繳。` : '');

  stamp.hidden = false;
  const key = `${ratePct}:${Math.round(c.netCost)}:${ageNow}:${annualReturn}`;
  if (stamped !== key) {
    // 判準不是稅率高低，是「這個門檻你自己打不打得贏」。
    // 低級距的人門檻低但省得少，高級距的人省得多門檻也高，兩件事要分開講。
    const hard = Number.isFinite(be) && be >= 0.06;
    stamp.innerHTML = `<span class="stamp${hard ? ' stamp--void' : ''}">`
      + `${hard ? '門檻偏高' : '門檻不高'}</span>`;
    stampIn(stamp.firstElementChild);
    stamped = key;
  }
}

function renderProjection(c) {
  const p = project(c.contrib, ageNow, annualReturn);
  const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  plot.setSeries([
    { type: 'area', data: p.pts.map((x) => ({ x: x.x, y: x.bal })), color: cssv('--series-1'), width: 2.5 },
    { type: 'line', data: p.pts.map((x) => ({ x: x.x, y: x.put })), color: cssv('--ghost'), width: 1.5, dash: [4, 3], noCursor: true },
  ], { animate: true });

  $('#chartDesc').textContent = p.months
    ? `從 ${ageNow} 歲每月自提 ${int(c.contrib)} 元到 60 歲，`
      + `本金投入 ${int(p.put)} 元（虛線），以年化 ${annualReturn}% 計算會變成 ${int(p.final)} 元（實線）。`
      + `這只算自提的部分，雇主提繳的另外還有。勞退基金的收益由政府保證不低於兩年期定存利率。`
    : '你已經滿 60 歲，可以直接請領了。';
}

function renderLiquidity() {
  const host = $('#liquidity');
  host.replaceChildren();
  const lockedYears = Math.max(0, 60 - ageNow);
  const bar = el('div', { class: 'lock' }, [
    el('span', { class: 'lock__locked', style: `flex-basis:${Math.min(96, lockedYears / 45 * 100)}%` }),
    el('span', { class: 'lock__free' }),
  ]);
  host.appendChild(bar);
  host.appendChild(el('div', { class: 'lock__labels' }, [
    el('span', { text: `${ageNow} 歲` }),
    el('span', { text: `鎖住 ${lockedYears} 年` }),
    el('span', { text: '60 歲可領' }),
  ]));
}

function renderFormula(c) {
  const host = $('#formulaHost');
  host.replaceChildren();
  const mr = c.mRate;

  host.appendChild(formulaBlock('攤開看：這幾個數字怎麼算出來的', [
    `<b>提繳工資</b> = min(月薪, 提繳上限) = min(${int(salary)}, ${int(CONTRIB_CAP.value)}) = <b>${int(c.capped)}</b>`,
    `<b>每月自提</b> = 提繳工資 × 自提率 = ${int(c.capped)} × ${ratePct}% = <b>${int(c.contrib)}</b>`,
    `<b>邊際稅率</b> = ${pp(mr * 100, 0)}（以單身、標準扣除額、薪資特別扣除額估算）`,
    `<b>全年省稅</b> = 每月自提 × 12 × 邊際稅率 = ${int(c.contrib)} × 12 × ${pp(mr * 100, 0)} = <b>${int(c.taxSaved)}</b>`,
    `<b>實際少領</b> = 每月自提 − 全年省稅 ÷ 12 = ${int(c.contrib)} − ${int(Math.round(c.taxSaved / 12))} = <b>${int(c.netCost)}</b>`,
    `<b>一次性稅務槓桿</b> = 每月自提 ÷ 實際少領 = ${int(c.contrib)} ÷ ${int(c.netCost)} = <b>${dec(c.leverage, 4)}</b> 倍`,
    `<b>損益兩平</b>：兩條路都推到 60 歲，自行投資要多少年化報酬才追得上`,
    `(槓桿 × (1 + 勞退報酬)<sup>年數</sup>)<sup>1÷年數</sup> − 1`,
    `= (${dec(c.leverage, 4)} × (1 + ${dec(annualReturn / 100, 4)})<sup>${Math.max(0, 60 - ageNow)}</sup>)<sup>1÷${Math.max(1, 60 - ageNow)}</sup> − 1 = <b>${pct(breakevenSelfReturn(c, Math.max(0, 60 - ageNow), annualReturn), 2)}</b>`,
    `稅務優勢是<b>一次性</b>的，不是每年重複發生。把 ${dec((c.leverage - 1) * 100, 1)}% 當成年化報酬會嚴重高估自提的好處。`,
  ], '自願提繳不計入當年度綜合所得課稅，法源為勞工退休金條例第 14 條。'
    + '邊際稅率以單身、採標準扣除額估算，有配偶或扶養親屬時會不同，'
    + `完整試算請到<a href="../invest-tax/">投資與稅</a>那一頁。`));

  host.appendChild(formulaBlock('這一頁刻意沒有算進去的東西', [
    `自提會讓你的<b>可支配現金變少</b>，如果你有高利率的卡循或信貸，先還債幾乎一定比自提划算`,
    `這筆錢<b>60 歲以前領不出來</b>，緊急預備金不足的人不該先衝自提`,
    `勞退基金的<b>實際收益率逐年不同</b>，本頁的年化報酬是你自己填的假設，不是預測`,
    `自提<b>不影響</b>勞保年金、資遣費與其他給付的計算基礎`,
    `月薪超過提繳上限的部分不能提繳，高薪者的自提空間有天花板`,
  ], null));
}

/* ==========================================================================
   啟動
   ========================================================================== */
async function boot() {
  const grab = async (p) => { try { const r = await fetch(p); return r.ok ? await r.json() : null; } catch { return null; } };
  const [pension, tax] = await Promise.all([
    grab('../../assets/data/tw-labor-pension.json'),
    grab('../../assets/data/tw-tax.json'),
  ]);
  RULES = pension; TAX = tax;

  if (!TAX) {
    $('#lead').textContent = '常數檔載不進來，這一頁不會用寫死的備份值算給你看';
    $('#body').textContent = '請重新整理，或確認網路連線。';
    return;
  }

  const cap = RULES?.contribution?.monthlyWageCap;
  if (cap) CONTRIB_CAP = { value: cap.value ?? cap, confidence: cap.confidence || 'verified' };

  $('#dataver').textContent = `資料版本 ${TAX.version || '—'}`
    + (CONTRIB_CAP.confidence !== 'verified' ? '．提繳上限未查證' : '');

  // 共用檔案裡已經有月薪就直接用，不要再問一次
  if (P.has('salary')) {
    salary = P.get('salary');
    fSalary.set(salary, { silent: true });
  }

  render();
  printRows(['.scale__side', '.solo__verdict'], { stagger: 0.08, delay: 0.05 });
}

boot();
