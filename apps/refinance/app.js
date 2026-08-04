/* 房貸轉貸試算。
 *
 * 市面上的轉貸文章與試算器都在比利率差，但利率差只是分子。
 * 真正決定值不值得的是「一次性成本要幾個月的月付差才賺得回來」，
 * 而那筆成本裡最大的一項——提前清償違約金——只有使用者自己的契約知道。
 * 所以這一頁做三件別人不做的事：
 *
 *   1. **違約金與代書費不預填、必填、空白就不給判決。**
 *      預填一個「大約 3 萬」的區間值，一定看起來比真實合約便宜，
 *      那等於替使用者做了一個他沒同意過的樂觀假設。
 *   2. **一定有第三條路：回原行議價。**
 *      原行降碼不用重設抵押權、不用代書、沒有違約金，成本結構上就贏轉貸一大段。
 *      導流型網站不會告訴你這一條，因為它沒有佣金。這一頁把它擺在中間那一欄。
 *   3. **月付金差與總利息差分開講。**
 *      轉貸拉長年限會讓月付變小、總利息變大。把兩者混成一個「省 X 萬」是最常見的謊。
 *
 * 法定費用只寫查得到條號的：
 *   抵押權設定登記費 = 權利價值 × 1/1000（土地法第 76 條）
 *   塗銷登記免納登記費（土地法第 78 條第 4 款）
 * 書狀費、代書費、鑑價費一律不寫死，折進使用者自己填的「其他規費與雜支」。
 *
 * 計算檔案不 import partners.js。分潤設定與試算結果在程式碼層級就不相通。
 */

import { printRows, stampIn, makeCounter, revealOnScroll, still } from '../../assets/js/core/motion.js';
import { Plot } from '../../assets/js/core/plot.js';
import { amortize } from '../../assets/js/core/fin.js';
import {
  $, el, bindField, createPlies,
  mountTopbar, mountTheme, mountShare, formulaBlock,
} from '../../assets/js/core/ui.js';
import { int, dec, pp, parseNum } from '../../assets/js/core/format.js';
import { createStore } from '../../assets/js/core/state.js';
import * as P from '../../assets/js/core/profile.js';
import { mountDisclosure, loadPartners } from '../../assets/js/core/partners.js';

const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const clone = (x) => JSON.parse(JSON.stringify(x));

/* 土地法第 76 條：聲請為土地權利變更登記，應由權利人按申報地價或權利價值千分之一繳納登記費。 */
const SETUP_FEE_RATE = 0.001;

/* ==========================================================================
   狀態
   ========================================================================== */
const DEFAULTS = {
  balance: 6000000,
  months: 240,
  rate: 2.35,
  grace: 0,

  rateB: 2.20,
  costB: 0,

  rateC: 2.06,
  monthsC: 240,
  graceC: 0,
  align: true,

  penalty: null,     // 必填，刻意留空
  agent: null,       // 必填，刻意留空
  multiple: 1.2,
  misc: 0,
};

const store = createStore('vm:refinance', DEFAULTS);
const S = () => store.get();

const SCEN = {};
let curPly = 1;

/* ==========================================================================
   核心計算
   ========================================================================== */

/** 一個方案的攤還結果。利率用「年利率的百分比」進來，內部轉成小數。 */
function run({ principal, months, rate, grace }) {
  const n = Math.max(1, Math.round(months) || 1);
  return amortize({
    principal: Math.max(0, principal),
    totalMonths: n,
    graceMonths: Math.max(0, Math.min(n - 1, Math.round(grace) || 0)),
    rateSegments: [{ from: 1, rate: (Number(rate) || 0) / 100 }],
    method: 'annuity',
  });
}

/** 寬限期結束後的那一期月付金。沒有寬限期就是第一期。 */
function repPayment(plan) {
  const row = plan.rows.find((r) => !r.grace);
  return row ? row.payment : (plan.rows[0]?.payment ?? 0);
}

/** 補到等長的月付金序列，方案結束之後補 0——那幾個月他真的不用再付錢了。 */
function paySeries(plan, n) {
  const out = new Array(n).fill(0);
  for (const r of plan.rows) if (r.m <= n) out[r.m - 1] = r.payment + (r.extra || 0);
  return out;
}

/**
 * 累計淨省曲線：到第 m 期為止，比「不動」總共少付了多少錢。
 * 從 −一次性成本 出發，所以穿過零線那一刻才是真的開始賺。
 */
function cumulative(base, alt, cost, n) {
  const a = paySeries(base, n);
  const b = paySeries(alt, n);
  const pts = [{ x: 0, y: -cost }];
  let acc = -cost;
  let payback = null;
  for (let m = 1; m <= n; m++) {
    acc += a[m - 1] - b[m - 1];
    if (payback === null && acc >= 0) payback = m;
    pts.push({ x: m, y: acc });
  }
  return { pts, final: acc, payback };
}

function compute(s = S()) {
  const bal = Math.max(0, Number(s.balance) || 0);
  const months = Math.max(1, Math.round(Number(s.months) || 1));
  const grace = Math.max(0, Math.round(Number(s.grace) || 0));

  // 對齊比較：把丙案的期數與寬限期鎖成跟甲案一樣，
  // 三欄的「全期利息」才可以直接比大小。關掉之後就要自己讀回本圖。
  const aligned = s.align !== false;
  const monthsC = aligned ? months : Math.max(1, Math.round(Number(s.monthsC) || months));
  const graceC = aligned ? grace : Math.max(0, Math.round(Number(s.graceC) || 0));

  const A = run({ principal: bal, months, rate: s.rate, grace });
  const B = run({ principal: bal, months, rate: s.rateB, grace });
  const C = run({ principal: bal, months: monthsC, rate: s.rateC, grace: graceC });

  // 成本
  const multiple = Math.max(1, Number(s.multiple) || 1.2);
  const claim = bal * multiple;                       // 擔保債權總金額
  const setupFee = Math.ceil(claim * SETUP_FEE_RATE); // 土地法第 76 條
  const cancelFee = 0;                                // 土地法第 78 條第 4 款

  const penalty = s.penalty;
  const agent = s.agent;
  const misc = Math.max(0, Number(s.misc) || 0);
  const ready = Number.isFinite(penalty) && penalty >= 0 && Number.isFinite(agent) && agent >= 0;
  const costC = ready ? penalty + agent + setupFee + cancelFee + misc : NaN;
  const costB = Math.max(0, Number(s.costB) || 0);

  const n = Math.max(A.months, B.months, C.months);
  const curveB = cumulative(A, B, costB, n);
  const curveC = ready ? cumulative(A, C, costC, n) : null;

  const pA = repPayment(A), pB = repPayment(B), pC = repPayment(C);

  return {
    bal, months, grace, monthsC, graceC, aligned, n,
    rate: Number(s.rate) || 0, rateB: Number(s.rateB) || 0, rateC: Number(s.rateC) || 0,
    A, B, C, pA, pB, pC,
    multiple, claim, setupFee, cancelFee, penalty, agent, misc,
    costB, costC, ready,
    curveB, curveC,
    longer: monthsC - months,
  };
}

/* ==========================================================================
   版面
   ========================================================================== */
mountTopbar({ title: '房貸轉貸試算' });
mountTheme($('#sheetActions'));
mountShare($('#sheetActions'), store);

const plot = new Plot($('#payback'), {
  aspect: 0.5,
  minHeight: 210,
  maxHeight: 340,
  xFormat: (v) => (v <= 0 ? '簽約' : `${Math.round(v / 12)} 年`),
  yFormat: (v) => (Math.abs(v) >= 10000 ? `${dec(v / 10000, 0)}萬` : int(v)),
  padding: { left: 58, bottom: 28, top: 16, right: 14 },
});

/* 兩格必填還沒填完時，這兩個讀數必須是「—」而不是 0。
   把 ready 放進 format 的閉包裡，連還在跑的補間也會寫出「—」，不會閃出一個假的數字。 */
let ready = false;
/** 負號一律用排版用的減號，跟三聯表裡的寫法一致 */
const signed = (v) => (v < 0 ? '−' + int(-v) : int(v)) + ' 元';
const cCost = makeCounter($('#r-cost'), (v) => (ready ? signed(v) : '—'));
const cNet = makeCounter($('#r-net'), (v) => (ready ? signed(v) : '—'));

let stamped = null;

/* ---- 輸入綁定 ---------------------------------------------------------- */
const posMoney = (v) => (!Number.isFinite(v) || v < 0 ? '請填一個不是負數的金額' : null);
const rateOK = (v) => (!Number.isFinite(v) || v < 0 || v > 30 ? '年利率請填 0 到 30 之間' : null);
const termOK = (v) => (!Number.isFinite(v) || v < 1 || v > 600 ? '期數請填 1 到 600 之間' : null);

const F = {};

function money(id, key, { validate = posMoney, profile } = {}) {
  F[key] = bindField($(id), {
    pretty: int,
    validate,
    onChange: (v, { valid, source }) => {
      if (!valid) return;
      store.set({ [key]: v });
      if (profile) P.set({ [profile]: v });
      if (source !== 'set') render();
    },
  });
}

function plain(id, key, { validate, profile, decimals = false } = {}) {
  F[key] = bindField($(id), {
    pretty: decimals ? null : int,
    validate,
    onChange: (v, { valid, source }) => {
      if (!valid) return;
      store.set({ [key]: v });
      if (profile) P.set({ [profile]: v });
      if (source !== 'set') render();
    },
  });
}

money('#f-balance', 'balance', { profile: 'mortgageBalance' });
plain('#f-months', 'months', { validate: termOK, profile: 'mortgageMonthsLeft' });
plain('#f-rate', 'rate', { validate: rateOK, decimals: true, profile: 'mortgageRate' });
plain('#f-grace', 'grace', {
  validate: (v) => (!Number.isFinite(v) || v < 0 ? '沒有就填 0' : null),
  profile: 'mortgageGraceLeft',
});

plain('#f-rateB', 'rateB', { validate: rateOK, decimals: true });
money('#f-costB', 'costB');

plain('#f-rateC', 'rateC', { validate: rateOK, decimals: true });
plain('#f-monthsC', 'monthsC', { validate: termOK });
plain('#f-graceC', 'graceC', { validate: (v) => (!Number.isFinite(v) || v < 0 ? '沒有就填 0' : null) });

money('#f-misc', 'misc');
plain('#f-multiple', 'multiple', {
  decimals: true,
  validate: (v) => (!Number.isFinite(v) || v < 1 || v > 3 ? '擔保債權倍數通常在 1 到 1.5 之間' : null),
});

/* 必填的兩格：空字串要留成 null，不能悄悄變成 0。
   變成 0 就等於替使用者假設「沒有違約金」，那正是這一頁在反對的事。 */
function required(id, key) {
  F[key] = bindField($(id), {
    pretty: int,
    parse: (raw) => (String(raw ?? '').trim() === '' ? null : parseNum(raw, NaN)),
    validate: (v) => (v === null ? null : (!Number.isFinite(v) || v < 0 ? '請填一個不是負數的金額' : null)),
    onChange: (v, { valid, source }) => {
      if (!valid) return;
      store.set({ [key]: v });
      if (source !== 'set') render();
    },
  });
}
required('#f-penalty', 'penalty');
required('#f-agent', 'agent');

$('#ck-align').addEventListener('change', (e) => {
  store.set({ align: e.target.checked });
  syncInputs();
  render();
});

$('#resetBtn').addEventListener('click', () => {
  store.reset();
  syncInputs();
  render();
});

createPlies($('#plies'), {
  labels: ['第一聯', '第二聯', '第三聯', '第四聯'],
  onAdd: (id) => { SCEN[curPly] = clone(S()); SCEN[id] = clone(S()); curPly = id; },
  onSwitch: (id) => {
    SCEN[curPly] = clone(S());
    curPly = id;
    store.replace(clone(SCEN[id] || DEFAULTS));
    syncInputs(); render();
  },
  onRemove: (id, active) => {
    delete SCEN[id];
    curPly = active;
    if (SCEN[active]) store.replace(clone(SCEN[active]));
    syncInputs(); render();
  },
});

function syncInputs() {
  const s = S();
  F.balance.set(s.balance, { silent: true });
  F.months.set(s.months, { silent: true });
  F.rate.set(s.rate, { silent: true });
  F.grace.set(s.grace, { silent: true });
  F.rateB.set(s.rateB, { silent: true });
  F.costB.set(s.costB, { silent: true });
  F.rateC.set(s.rateC, { silent: true });
  F.multiple.set(s.multiple, { silent: true });
  F.misc.set(s.misc, { silent: true });
  F.penalty.set(s.penalty == null ? '' : s.penalty, { silent: true });
  F.agent.set(s.agent == null ? '' : s.agent, { silent: true });

  const aligned = s.align !== false;
  $('#ck-align').checked = aligned;
  // 對齊時把丙案的期數欄位鎖成甲案的值：不是隱藏，是讓他看見「現在比的是什麼」
  F.monthsC.set(aligned ? s.months : s.monthsC, { silent: true });
  F.graceC.set(aligned ? s.grace : s.graceC, { silent: true });
  [['#f-monthsC', F.monthsC], ['#f-graceC', F.graceC]].forEach(([sel, f]) => {
    const root = $(sel);
    if (aligned) root.dataset.disabled = 'true'; else delete root.dataset.disabled;
    f.el.disabled = aligned;
  });
}

/* ==========================================================================
   繪製
   ========================================================================== */
function render() {
  const c = compute();

  markRequired(c);
  renderVerdict(c);
  renderReadouts(c);
  renderPayback(c);
  renderThree(c);
  renderCost(c);
  renderTraps(c);
  renderFormula(c);
}

function markRequired(c) {
  $('#f-penalty').dataset.empty = String(!Number.isFinite(c.penalty));
  $('#f-agent').dataset.empty = String(!Number.isFinite(c.agent));

  // 對齊模式下，甲案改期數時丙案的鏡像欄位要跟著動，否則畫面說的跟算的不是同一件事
  if (c.aligned) {
    F.monthsC.set(c.months, { silent: true });
    F.graceC.set(c.grace, { silent: true });
  }

  $('#alignHint').textContent = c.aligned
    ? '丙案的期數與寬限期已鎖成跟甲案一樣，這樣三欄的「全期利息」才可以直接比大小。'
      + '想看「拉長年限換低月付」的效果，就把它關掉。'
    : '期數不同時，總利息不能直接比：拉長年限一定讓月付變小、總利息變大。'
      + '這時候要看的是回本圖與月付金差，不是那個看起來很大的省息數字。';

  const from = [];
  if (P.has('mortgageBalance')) from.push('餘額');
  if (P.has('mortgageMonthsLeft')) from.push('剩餘期數');
  if (P.has('mortgageRate')) from.push('目前利率');
  $('#fromLine').textContent = from.length
    ? `${from.join('、')}已從你在其他頁面填過的資料帶入，可以直接改。`
    : '這幾格填你的房貸對帳單上的數字，或打去問承貸行。';
}

function renderReadouts(c) {
  const payback = $('#r-payback');
  const pmt = $('#r-pmt');
  const note = $('#r-netNote');

  ready = c.ready;

  if (!c.ready) {
    payback.textContent = '—';
    cCost(0);
    cNet(0);
    note.textContent = '違約金與代書費還沒填';
    note.dataset.dir = 'flat';
    pmt.textContent = '—';
    return;
  }

  const pb = c.curveC.payback;
  payback.innerHTML = pb == null
    ? '<span style="font-size:var(--t-lg)">回不了本</span>'
    : `${pb}<small> 期（${dec(pb / 12, 1)} 年）</small>`;

  cCost(c.costC);
  cNet(c.curveC.final);

  const d = c.pC - c.pA;
  pmt.innerHTML = d === 0 ? '不變'
    : `${d < 0 ? '−' : '＋'}${int(Math.abs(d))}<small> 元／月</small>`;

  note.textContent = c.curveC.final >= 0
    ? (c.longer > 0 ? `丙案的期數比甲案多 ${c.longer} 期` : '扣掉全部一次性成本之後')
    : '扣掉一次性成本之後反而虧';
  note.dataset.dir = c.curveC.final > 0 ? 'down' : (c.curveC.final < 0 ? 'up' : 'flat');
}

function renderVerdict(c) {
  const lead = $('#verdict-h');
  const body = $('#verdictBody');
  const stamp = $('#verdictStamp');

  if (!c.ready) {
    lead.innerHTML = '先把<em>違約金</em>跟<em>代書費</em>填了';
    body.innerHTML =
      `這兩格空著的話，任何「轉貸省 X 萬」的數字都是假的。`
      + `本站刻意不預填——網路上那些「違約金大約幾萬」的區間值一定看起來比你的合約便宜，`
      + `填上去等於替你做了一個你沒同意過的樂觀假設。`
      + `<br><br>不過乙案（回原行議價）現在就可以看：它不需要這兩個數字，`
      + `因為原行降碼不用重設抵押權、沒有違約金。`
      + `以你填的 ${pp(c.rateB, 3)} 算，全期比不動少付 <b>${int(c.curveB.final)}</b> 元。`;
    stamp.hidden = true; stamped = null;
    return;
  }

  const netC = c.curveC.final;
  const netB = c.curveB.final;
  const pb = c.curveC.payback;
  let mark;

  if (netB >= netC) {
    mark = '先去議價';
    lead.innerHTML = `別轉了，<em>回原行議價</em>就贏。`;
  } else if (netC > 0 && pb != null) {
    mark = '值得轉';
    lead.innerHTML = `轉貸划算，第 <em>${pb}</em> 期回本。`;
  } else if (netC > 0) {
    mark = '勉強';
    lead.innerHTML = `全期算下來是省的，但<em>中途從來沒有真正回本過</em>。`;
  } else {
    mark = '不值得';
    lead.innerHTML = `不值得轉，一次性成本<em>賺不回來</em>。`;
  }

  const parts = [];

  parts.push(
    `利率從 ${pp(c.rate, 3)} 降到 ${pp(c.rateC, 3)}，全期利息少 `
    + `${int(c.A.totalInterest - c.C.totalInterest)} 元；`
    + `但要先付 ${int(c.costC)} 元（違約金 ${int(c.penalty)}＋代書 ${int(c.agent)}`
    + `＋設定登記 ${int(c.setupFee)}＋其他 ${int(c.misc)}）。`
    + `兩邊相抵，${netC >= 0 ? `淨省 ${int(netC)} 元` : `淨虧 ${int(-netC)} 元`}。`
  );

  if (pb != null) {
    parts.push(
      `月付金${c.pC < c.pA ? `少 ${int(c.pA - c.pC)} 元` : `多 ${int(c.pC - c.pA)} 元`}，`
      + `累計到第 ${pb} 期（${dec(pb / 12, 1)} 年）才把成本賺回來——`
      + `這中間如果又轉走或提前清償，這筆成本就是白付的。`
    );
  } else if (netC > 0) {
    parts.push(
      `注意這個「省」是把全期加總才成立的：中途的累計淨省從來沒有回到零以上，`
      + `因為丙案的期數比甲案長，前面省下來的月付差在後段又被多出來的那幾期吃回去。`
    );
  } else {
    parts.push(
      `月付金${c.pC < c.pA ? `確實少了 ${int(c.pA - c.pC)} 元` : `還變多了`}，`
      + `但整個剩餘期間累積下來的月付差 ${int(c.costC + netC)} 元，`
      + `補不上 ${int(c.costC)} 元的一次性成本。`
    );
  }

  if (netB >= netC) {
    parts.push(
      `而且你填的原行議價利率 ${pp(c.rateB, 3)} 只要付 ${int(c.costB)} 元成本，`
      + `全期淨省 ${int(netB)} 元，已經${netB > netC ? '贏過' : '追平'}轉貸。`
      + `拿別家的核准條件回去談，是成本最低的那一步。`
    );
  } else {
    parts.push(
      `原行議價到 ${pp(c.rateB, 3)} 的話全期淨省 ${int(netB)} 元，還是輸給轉貸 `
      + `${int(netC - netB)} 元——但議價幾乎沒有成本也沒有新綁約期，先談再說不吃虧。`
    );
  }

  body.innerHTML = parts.join('');

  stamp.hidden = false;
  const key = `${mark}:${Math.round(netC)}:${pb}`;
  if (stamped !== key) {
    const bad = mark === '不值得' || mark === '勉強';
    stamp.innerHTML = `<span class="stamp${bad ? ' stamp--void' : ''}">${mark}</span>`;
    stampIn(stamp.firstElementChild);
    stamped = key;
  }
}

function renderPayback(c) {
  const series = [];
  const legend = $('#legend');
  legend.replaceChildren();

  const add = (data, color, label, dash) => {
    series.push({ type: 'line', data, color, width: dash ? 2 : 2.5, dash, noCursor: true });
    legend.appendChild(el('span', { class: 'legend__item' }, [
      el('span', { class: `legend__key${dash ? ' legend__key--dash' : ''}`, style: `background:${color};color:${color}` }),
      el('span', { text: label }),
    ]));
  };

  add(c.curveB.pts, cssv('--series-2'), `乙：原行議價 ${pp(c.rateB, 2)}`);
  if (c.ready) add(c.curveC.pts, cssv('--accent'), `丙：轉貸 ${pp(c.rateC, 2)}`);

  // 其他聯的鬼影：複寫單據的意義就是並排比較
  for (const [id, snap] of Object.entries(SCEN)) {
    if (Number(id) === curPly || !snap) continue;
    const g = compute(snap);
    if (g.ready) {
      series.push({ type: 'line', data: g.curveC.pts, color: cssv('--ghost'), width: 1, dash: [4, 3], noCursor: true });
    }
  }

  plot.setSeries(series, { animate: false });

  const ys = series.flatMap((s) => s.data.map((p) => p.y));
  const lo = Math.min(0, ...ys), hi = Math.max(0, ...ys);
  const pad = Math.max(1000, (hi - lo) * 0.12);
  plot.setDomain({ x0: 0, x1: c.n, y0: lo - pad, y1: hi + pad });

  const marks = [{ axis: 'y', value: 0, color: cssv('--ink-3'), dash: [3, 3], label: '打平' }];
  if (c.ready && c.curveC.payback != null) {
    marks.push({
      axis: 'x', value: c.curveC.payback, color: cssv('--accent'), dash: [4, 3],
      label: `第 ${c.curveC.payback} 期回本`,
    });
  }
  if (c.aligned === false && c.longer > 0) {
    marks.push({ axis: 'x', value: c.months, color: cssv('--up'), dash: [2, 3], label: '甲案在這裡還完' });
  }
  plot.setMarks(marks);

  $('#paybackDesc').innerHTML =
    `縱軸是「到這個月為止，比不動總共少付了多少錢」。曲線從 <b>負的一次性成本</b> 出發，`
    + `穿過那條「打平」虛線的那一刻，才是真的開始賺。`
    + (c.ready
      ? (c.curveC.payback != null
        ? `丙案在第 ${c.curveC.payback} 期穿過。`
        : `丙案的曲線從頭到尾沒有穿過零線。`)
      : `丙案要等你填完違約金與代書費才畫得出來。`)
    + (c.longer > 0
      ? `<b>注意後段：</b>甲案在第 ${c.months} 期就還完了，丙案還要再付 ${c.longer} 期，`
        + `所以曲線在那之後會一路往下掉——這就是拉長年限的真實代價。`
      : '');
}

function renderThree(c) {
  const tb = $('#threeRows');
  tb.replaceChildren();

  const plans = [
    { k: 'A', name: '甲：不動', rate: c.rate, months: c.months, grace: c.grace, plan: c.A, pmt: c.pA, cost: 0, net: 0 },
    { k: 'B', name: '乙：原行議價', rate: c.rateB, months: c.months, grace: c.grace, plan: c.B, pmt: c.pB, cost: c.costB, net: c.curveB.final },
    { k: 'C', name: '丙：轉去別家', rate: c.rateC, months: c.monthsC, grace: c.graceC, plan: c.C, pmt: c.pC, cost: c.costC, net: c.ready ? c.curveC.final : NaN },
  ];

  // 表頭的欄位標色：跟圖上的線同一組色票，讀者不用再對照一次
  const ths = $('#threeCard').querySelectorAll('thead th');
  ['', 'A', 'B', 'C'].forEach((k, i) => { if (k) ths[i].dataset.plan = k; });

  const bestNet = Math.max(...plans.map((p) => (Number.isFinite(p.net) ? p.net : -Infinity)));

  const row = (label, pick, { sep = false, best = false } = {}) => {
    const tr = el('tr', sep ? { dataset: { sep: 'true' } } : {});
    tr.appendChild(el('td', { text: label }));
    plans.forEach((p) => {
      const v = pick(p);
      const isBest = best && Number.isFinite(p.net) && p.net >= bestNet - 0.5;
      tr.appendChild(el('td', {
        class: 'num',
        dataset: isBest ? { best: 'true' } : {},
        html: typeof v === 'string' ? v : String(v),
      }));
    });
    tb.appendChild(tr);
  };

  row('年利率', (p) => pp(p.rate, 3));
  row('期數', (p) => `${p.months} 期<small>${dec(p.months / 12, 1)} 年${p.grace > 0 ? `．寬限 ${p.grace}` : ''}</small>`);
  row('月付金', (p) => `${int(p.pmt)}<small>${p.grace > 0 ? '寬限期滿後' : '每月'}</small>`);
  row('全期利息', (p) => int(p.plan.totalInterest));
  row('一次性成本', (p) => (Number.isFinite(p.cost) ? (p.cost > 0 ? int(p.cost) : '0') : '<span style="color:var(--up)">待填</span>'));
  row('總支出', (p) => (Number.isFinite(p.cost) ? int(p.plan.totalPaid + p.cost) : '<span style="color:var(--up)">待填</span>'), { sep: true });
  row('比不動淨省', (p) => (p.k === 'A' ? '<b>0</b><small>它就是基準</small>'
    : Number.isFinite(p.net) ? `<b>${p.net >= 0 ? int(p.net) : `−${int(-p.net)}`}</b>` : '<span style="color:var(--up)">待填</span>'), { best: true });
  row('幾期回本', (p) => {
    if (p.k === 'A') return '—';
    const cv = p.k === 'B' ? c.curveB : c.curveC;
    if (!cv) return '<span style="color:var(--up)">待填</span>';
    // 成本 0 的時候講「第 1 期回本」是誤導：它從頭到尾就沒有本要回
    if (Number.isFinite(p.cost) && p.cost <= 0) return '不用回本<small>沒有一次性成本</small>';
    return cv.payback == null ? '回不了本' : `${cv.payback} 期<small>${dec(cv.payback / 12, 1)} 年</small>`;
  });

  const foot = $('#threeFoot');
  foot.replaceChildren();
  foot.appendChild(el('p', { class: 'field__hint', style: 'margin:0', html:
    (c.aligned
      ? `三欄用的是<b>同樣的期數與寬限期</b>，只有利率跟成本不同，所以「全期利息」可以直接比大小。`
      : `<b>三欄的期數不一樣</b>（甲乙 ${c.months} 期、丙 ${c.monthsC} 期），`
        + `這時候「全期利息」不是可比的數字——期數長的一定利息多。要比就比「比不動淨省」跟回本期數。`)
    + `「總支出」是整個剩餘期間實際付出去的現金總和（本金＋利息＋一次性成本），沒有折現。`
    + `這一頁不做現值折算，因為房貸的剩餘期間動輒二十年，折現率選多少會直接決定結論，`
    + `而那個數字沒有人有把握——把它攤成名目現金流，至少每一塊錢都是查得到的。` }));

  $('#alignNote').textContent = c.aligned ? '期數已對齊' : '期數不同，不可直接比利息';
}

function renderCost(c) {
  const host = $('#costBody');
  host.replaceChildren();

  const line = (label, value, { src, mod = '' } = {}) => el('div', { class: `costline ${mod}` }, [
    el('span', { class: 'costline__label' }, [
      el('span', { html: label }),
      src ? el('span', { class: 'costline__src', html: src }) : null,
    ]),
    el('span', { class: 'costline__value num', html: value }),
  ]);

  host.appendChild(line(
    '<b>提前清償違約金</b>',
    Number.isFinite(c.penalty) ? int(c.penalty) + ' 元' : '待填',
    {
      src: '由你的貸款契約約定，各家算法都不同（有的按清償金額百分比、有的按原貸金額、有的分年遞減）。本站不提供任何預設值。',
      mod: Number.isFinite(c.penalty) ? '' : 'costline--miss',
    }
  ));

  host.appendChild(line(
    '<b>代書／地政士費</b>',
    Number.isFinite(c.agent) ? int(c.agent) + ' 元' : '待填',
    {
      src: '非法定費用，由當事人約定，各家報價不同。有些銀行的專案會吸收。',
      mod: Number.isFinite(c.agent) ? '' : 'costline--miss',
    }
  ));

  host.appendChild(line(
    '抵押權設定登記費',
    int(c.setupFee) + ' 元',
    {
      src: `擔保債權總金額 ${int(c.bal)} × ${dec(c.multiple, 2)} ＝ ${int(c.claim)}，`
        + `按千分之一計收（土地法第 76 條）。倍數是<b>銀行慣例不是法律</b>，`
        + `以你的抵押權設定契約書為準，所以那一格可以改。`,
    }
  ));

  host.appendChild(line(
    '原抵押權塗銷登記費',
    '0 元',
    { src: '塗銷登記免納登記費（土地法第 78 條第 4 款）。', mod: 'costline--free' }
  ));

  host.appendChild(line(
    '其他規費與雜支',
    int(c.misc) + ' 元',
    {
      src: '開辦費、鑑價費、書狀費、火險與地震險的差額都放這裡。'
        + '書狀費是各地政事務所依規定收取的固定金額，本站沒有查證到可引用的現行公告，'
        + '所以不寫死一個數字給你，請把實際金額加進這一格。',
    }
  ));

  host.appendChild(line(
    '<b>轉貸一次性成本合計</b>',
    Number.isFinite(c.costC) ? int(c.costC) + ' 元' : '待填',
    { mod: 'costline--total' }
  ));
}

function renderTraps(c) {
  const host = $('#trapBody');
  host.replaceChildren();
  const ul = el('ul', { class: 'traps' });
  const add = (html, tone = 'warn') => ul.appendChild(el('li', { dataset: { tone }, html }));

  add(
    `<b>新的綁約期會重新開始。</b>轉過去通常會再綁一段期間，這期間內再轉、或提前清償，`
    + `又要付一次違約金。本站不知道你的新約條件——簽之前把「綁約幾年、違約金怎麼算」`
    + `寫進你自己的筆記，那比利率差 0.05% 重要得多。`
  );

  if (c.longer > 0) {
    const extraInt = c.C.totalInterest - run({ principal: c.bal, months: c.months, rate: c.rateC, grace: c.graceC }).totalInterest;
    add(
      `<b>你把年限拉長了 ${c.longer} 期。</b>月付金因此變小，但同樣利率下總利息多了約 `
      + `${int(extraInt)} 元。「月付變少」跟「總共省錢」是兩件事，`
      + `很多轉貸文案把前者講成後者。`
    );
  }

  if (c.graceC > 0) {
    add(
      `<b>新的寬限期有 ${c.graceC} 期。</b>寬限期內一毛本金都沒還，期滿之後月付會往上跳，`
      + `而且整段期間的利息都是照原本金算的。跳多高可以到`
      + `<a href="../mortgage-cliff/">房貸懸崖模擬器</a>看。`,
      'warn'
    );
  }

  add(
    `<b>本頁把你填的利率當成整個期間都適用。</b>如果你拿到的是「前兩年 X%、之後 Y%」的分段方案，`
    + `這裡會低估後段的利息。分段利率的完整攤還表在`
    + `<a href="../mortgage-cliff/">房貸懸崖模擬器</a>那一頁。`
  );

  add(
    `<b>轉貸額度不一定等於現有餘額。</b>新的銀行會重新鑑價，成數也受主管機關的規範限制。`
    + `鑑價不足時你得自己補差額，那筆錢沒有出現在這張表上。`
  );

  add(
    `<b>如果這一筆是政策性優惠貸款，先問清楚再動。</b>例如青年安心成家購屋優惠貸款，`
    + `轉出去之後利息補貼會不會中斷、還能不能轉回來，請直接問承貸行與主管機關——`
    + `本站對這一點不做任何陳述。`,
    'info'
  );

  if (Number.isFinite(c.penalty) && c.penalty === 0) {
    add(
      `<b>違約金你填了 0。</b>那表示你確認過已經過了綁約期。如果只是「應該過了吧」，`
      + `打去問一通電話的成本，遠低於算錯的成本。`,
      'info'
    );
  }

  if (c.curveB.final >= (Number.isFinite(c.costC) ? c.curveC.final : -Infinity)) {
    add(
      `<b>先去原行議價。</b>以你填的數字，原行降碼的淨效果已經不輸轉貸，`
      + `而且不用重設抵押權、不用代書、沒有新的綁約期。`
      + `拿別家的核准條件回去談，談不成再轉也來得及。`,
      'ok'
    );
  }

  add(
    `<b>本頁不媒合、不代辦、不轉介。</b>金管會於 2025-06-12 已要求金融機構不得受理經代辦業者轉介的案件。`
    + `你自己走進分行或線上申請，是唯一不會多付一筆錢的路。`,
    'ok'
  );

  host.appendChild(ul);
}

function renderFormula(c) {
  const host = $('#formulaHost');
  host.replaceChildren();

  host.appendChild(formulaBlock('攤開看：這幾個數字怎麼算出來的', [
    `<b>月付金</b>（本息平均攤還）= 本金 × i ÷ (1 − (1+i)<sup>−n</sup>)，i 是月利率 ＝ 年利率 ÷ 12，n 是剩餘期數。`,
    `甲案：${int(c.bal)} × ${dec(c.rate / 12 / 100, 6)} ÷ (1 − (1+${dec(c.rate / 12 / 100, 6)})<sup>−${c.months}</sup>) = <b>${int(c.pA)}</b> 元`,
    `丙案：${int(c.bal)} × ${dec(c.rateC / 12 / 100, 6)} ÷ (1 − (1+${dec(c.rateC / 12 / 100, 6)})<sup>−${c.monthsC}</sup>) = <b>${int(c.pC)}</b> 元`,
    `<b>抵押權設定登記費</b> = 擔保債權總金額 × 1/1000`
      + ` = ${int(c.bal)} × ${dec(c.multiple, 2)} × 0.001 = <b>${int(c.setupFee)}</b> 元`,
    `<b>塗銷登記費</b> = <b>0</b>（法定免納，不是本站幫你省的）`,
    `<b>一次性成本合計</b> = 違約金 ＋ 代書費 ＋ 設定登記費 ＋ 塗銷登記費 ＋ 其他規費`
      + (c.ready
        ? ` = ${int(c.penalty)} ＋ ${int(c.agent)} ＋ ${int(c.setupFee)} ＋ 0 ＋ ${int(c.misc)} = <b>${int(c.costC)}</b> 元`
        : `（違約金與代書費還沒填）`),
    `<b>累計淨省(m)</b> = −一次性成本 ＋ Σ<sub>k=1..m</sub>（甲案第 k 期月付 − 丙案第 k 期月付）`,
    `方案還完之後那幾期補 0——他真的不用再付錢了，這一段是丙案拉長年限時曲線往下掉的原因。`,
    `<b>回本期數</b> = 讓累計淨省首次 ≥ 0 的最小 m`
      + (c.ready ? ` = <b>${c.curveC.payback == null ? '不存在' : c.curveC.payback}</b>` : ''),
    `<b>全期淨省</b> = 累計淨省(最後一期) = 甲案總支出 − 丙案總支出 − 一次性成本`
      + (c.ready ? ` = <b>${int(c.curveC.final)}</b> 元` : ''),
  ], `登記費依<b>土地法第 76 條</b>「按申報地價或權利價值千分之一繳納登記費」；`
    + `塗銷登記免納登記費依<b>土地法第 78 條第 4 款</b>。`
    + `擔保債權總金額的倍數（預設 1.2）是<b>銀行實務慣例，不是法律規定</b>，以你的抵押權設定契約書為準。`
    + `違約金、代書費、鑑價費、開辦費一律由契約或當事人約定，本站不提供任何預設值。`));

  host.appendChild(formulaBlock('這一頁刻意沒有做的事、以及它算得不夠準的地方', [
    `<b>不內建任何一家銀行的房貸利率或方案。</b>利率天天在變、加碼因人而異，`
      + `內建的那一刻就開始過期；拿過期的利率排名次，在公平交易法第 21 條底下是引人錯誤之表示。`,
    `<b>不預填違約金與代書費。</b>這是這一頁最重要的設計決定。`
      + `一個「大約 3 萬」的預設值一定看起來比真實合約便宜，而使用者不會去改它。`,
    `<b>不做現值折算。</b>剩餘期間動輒二十年，折現率選 1% 還是 3% 會直接翻轉結論，`
      + `而那個數字沒有人有把握。這裡一律用名目現金流，每一塊錢都是查得到的。`,
    `<b>沒有把「省下來的月付差拿去投資」算進來。</b>那需要一個報酬率假設，`
      + `而任何報酬率假設都會讓結論變成「假設出來的」。`,
    `<b>沒有算你的時間與麻煩。</b>轉貸要重新對保、重新鑑價、跑地政事務所，`
      + `如果算出來只省一兩萬，那多半不值得。`,
    `<b>沒有算火險與地震險的重新投保。</b>轉貸通常要重新投保，`
      + `保費差額請自己加進「其他規費與雜支」。`
      + `本站不列任何保險項目的比較或推薦（保險法第 167 條之 1 有明文的罰則）。`,
    `<b>假設利率整段期間不變。</b>台灣的房貸幾乎都是機動利率，`
      + `央行升降息時三案會一起動——但如果你的加碼幅度不同，差距會被放大或縮小。`,
    `<b>假設本息平均攤還、按月計息。</b>本金平均攤還或其他計息基礎的結果會不一樣。`,
  ], null));
}

/* ==========================================================================
   啟動
   ========================================================================== */
function boot() {
  $('#dataver').textContent = '法源 土地法 76／78 條';

  // 共用檔案裡已經有的就直接用，不要再問一次
  if (!store.cameFromLink) {
    const pull = {};
    if (P.has('mortgageBalance')) pull.balance = P.get('mortgageBalance');
    if (P.has('mortgageMonthsLeft')) pull.months = P.get('mortgageMonthsLeft');
    if (P.has('mortgageRate')) pull.rate = P.get('mortgageRate');
    if (P.has('mortgageGraceLeft')) pull.grace = P.get('mortgageGraceLeft');
    if (Object.keys(pull).length) store.set(pull, { silent: true });
  }

  SCEN[curPly] = clone(S());

  loadPartners('../../assets/data/partners.json').then(() => mountDisclosure($('#discloseHost')));

  syncInputs();
  render();

  // 換主題要重畫：畫布上的顏色是當下讀出來的色票，不會跟著 CSS 一起變
  window.addEventListener('vm:theme', render);

  if (!still()) {
    printRows(['.app-head', '#inputs', '#verdict'], { stagger: 0.07, delay: 0.04 });
    revealOnScroll(['#paybackCard', '#threeCard', '#costCard', '#trapCard']);
  }
}

boot();
