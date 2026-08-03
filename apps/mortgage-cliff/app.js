import { gsap, printRows, stampIn, makeCounter, carbonTransfer, still } from '../../assets/js/core/motion.js';
import { Plot } from '../../assets/js/core/plot.js';
import { amortize } from '../../assets/js/core/fin.js';
import { createStore } from '../../assets/js/core/state.js';
import {
  $, $$, el, icon, iconHTML, bindSlider, bindField, bindSegmented, createPlies,
  mountTopbar, mountShare, mountTheme, toast, virtualTable, formulaBlock, createTip,
} from '../../assets/js/core/ui.js';
import { int, dec, money, pct, pp, codes, months as fmtMonths, parseNum, clamp } from '../../assets/js/core/format.js';

/* ==========================================================================
   資料
   ========================================================================== */
let RULES = {
  version: '未載入',
  loanCapNewYouth: 10000000,
  maxYearsNewYouth: 40,
  maxGraceYears: 5,
  burdenLines: [
    { at: 0.33, label: '月付佔所得 33%' },
    { at: 0.40, label: '40%' },
  ],
  // 五大銀行新承做房貸平均利率（115 年第 1 季），與 assets/data/tw-mortgage.json 同值
  defaultRate: 2.318,
  rateCodeStep: 0.25,
};

/* 預設就是青安 3.0：它 2026-08-01 才上路，寬限期 5 年，
   所以一載入畫面就是一道真實的、當下最多人會遇到的斷崖。
   首屏必須在示範機制，不是給一張空白表格。 */
const SCENARIO_DEFAULT = () => ({
  amount: 10000000,
  years: 40,
  income: 100000,
  grace: 5,
  method: 'annuity',
  rates: [{ from: 1, rate: 1.775 }, { from: 37, rate: 1.9 }, { from: 49, rate: 2.025 }],
  extras: [],
  shock: 0,
  preset: 'qingan3',
});

const store = createStore('vm:mortgage-cliff', {
  scenarios: { 1: SCENARIO_DEFAULT() },
  active: 1,
});

/* ==========================================================================
   版面掛載
   ========================================================================== */
mountTopbar({ title: '房貸懸崖模擬器' });
const actions = $('#sheetActions');
mountShare(actions, store);
mountTheme(actions);

const plotHost = $('#plotCard');
const tip = createTip(plotHost);
const cliffTag = el('div', { class: 'cliff-tag', hidden: true });
plotHost.appendChild(cliffTag);

/* ==========================================================================
   圖表
   ========================================================================== */
/** 期數的刻度要落在整年上，不然會出現「13年」這種讀不出意義的刻度 */
function yearTicks(totalMonths) {
  const years = Math.max(1, Math.round(totalMonths / 12));
  const step = years <= 10 ? 2 : years <= 25 ? 5 : 10;
  const out = [];
  for (let y = 0; y <= years; y += step) out.push(y * 12 || 1);
  return out;
}

const plot = new Plot($('#chart'), {
  aspect: 0.52,
  yFormat: (v) => (v >= 10000 ? (v / 10000).toFixed(v >= 100000 ? 0 : 1) + '萬' : String(Math.round(v))),
  xFormat: (v) => (v <= 1 ? '0年' : Math.round(v / 12) + '年'),
  padding: { left: 52, bottom: 28, top: 18, right: 14 },
});

const plot2 = new Plot($('#chart2'), {
  aspect: 0.38,
  yFormat: (v) => (v >= 10000 ? (v / 10000).toFixed(1) + '萬' : String(Math.round(v))),
  xFormat: (v) => (v <= 1 ? '0年' : Math.round(v / 12) + '年'),
  padding: { left: 52, bottom: 28, top: 12, right: 14 },
});

/* ==========================================================================
   輸入元件
   ========================================================================== */
const cur = () => store.at('scenarios')[store.at('active')] || SCENARIO_DEFAULT();

function patch(p, { recompute = true } = {}) {
  const scenarios = { ...store.at('scenarios') };
  // 使用者一旦動了任何欄位，就不再宣稱這是某個官方方案
  const leavesPreset = !('preset' in p) && Object.keys(p).some((k) => k !== 'shock');
  scenarios[store.at('active')] = { ...cur(), ...p, ...(leavesPreset ? { preset: null } : {}) };
  store.set({ scenarios });
  if (recompute) compute();
}

const fAmount = bindField($('#f-amount'), {
  pretty: int,
  validate: (v) => {
    if (!Number.isFinite(v) || v <= 0) return '請填入大於 0 的金額';
    if (v > 200000000) return '這個金額超出試算範圍';
    return null;
  },
  onChange: (v, { valid }) => { if (valid) patch({ amount: v }); },
});

const fYears = bindField($('#f-years'), {
  validate: (v) => {
    if (!Number.isFinite(v) || v < 1) return '年限至少 1 年';
    if (v > 40) return '房貸年限最長 40 年';
    return null;
  },
  onChange: (v, { valid }) => { if (valid) patch({ years: Math.round(v) }); },
});

const fIncome = bindField($('#f-income'), {
  pretty: int,
  validate: (v, raw) => {
    if (raw === '' ) return null;
    if (!Number.isFinite(v) || v < 0) return '請填入正確的金額，或留白';
    return null;
  },
  onChange: (v) => patch({ income: Number.isFinite(v) ? v : 0 }),
});

const sGrace = bindSlider($('#s-grace'), {
  format: (v) => `${v}<small>年</small>`,
  onInput: (v) => {
    patch({ grace: v }, { recompute: false });
    compute({ from: 'grace' });
  },
});

const sShock = bindSlider($('#s-shock'), {
  format: (v) => (v === 0 ? '不變' : codes(v)),
  onInput: (v) => { patch({ shock: v }, { recompute: false }); compute({ from: 'shock' }); },
});

const segMethod = bindSegmented($('#seg-method'), {
  onChange: (v) => patch({ method: v }),
});

/* ---------- 方案預設：把當下真實存在的貸款方案一鍵載入 ---------- */
function renderPresets() {
  const host = $('#seg-preset');
  host.replaceChildren();
  const active = cur().preset;
  (RULES.presets || []).forEach((p) => {
    host.appendChild(el('button', {
      type: 'button',
      class: 'segmented__opt',
      'data-value': p.id,
      'aria-pressed': String(p.id === active),
      text: p.label,
      onclick: () => applyPreset(p.id),
    }));
  });
  const p = (RULES.presets || []).find((x) => x.id === active);
  $('#presetHint').textContent = p ? p.hint : '';
}

function applyPreset(id) {
  const p = (RULES.presets || []).find((x) => x.id === id);
  if (!p) return;
  patch({
    preset: p.id,
    amount: p.amount,
    years: p.years,
    grace: p.grace,
    rates: p.rates.map((r) => ({ ...r })),
    extras: [],
    shock: 0,
  }, { recompute: false });
  syncInputs();
  compute({ from: 'preset' });
  renderPresets();
}

/* ---------- 可重複列：利率分段 ---------- */
function renderRateRows() {
  const host = $('#rateRows');
  host.replaceChildren();
  const s = cur();
  s.rates.forEach((seg, i) => {
    const row = el('div', { class: 'row' }, [
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label', text: '自第幾期起' }),
        el('span', { class: 'field__control' }, [
          el('input', {
            type: 'text', inputmode: 'numeric', value: String(seg.from),
            disabled: i === 0,
            onchange: (e) => {
              const v = clamp(Math.round(parseNum(e.target.value, seg.from)), 2, s.years * 12);
              const rates = s.rates.map((r, k) => (k === i ? { ...r, from: v } : r));
              patch({ rates: rates.sort((a, b) => a.from - b.from) });
              renderRateRows();
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
              patch({ rates: s.rates.map((r, k) => (k === i ? { ...r, rate: v } : r)) });
            },
          }),
          el('span', { class: 'field__unit', text: '%' }),
        ]),
      ]),
      s.rates.length > 1 && i > 0
        ? el('button', {
            type: 'button', class: 'row__del', 'aria-label': '刪除這段利率',
            html: iconHTML('close'),
            onclick: () => { patch({ rates: s.rates.filter((_, k) => k !== i) }); renderRateRows(); },
          })
        : el('span'),
    ]);
    host.appendChild(row);
  });
}

$('#addRate').addEventListener('click', () => {
  const s = cur();
  const last = s.rates[s.rates.length - 1];
  const nextFrom = Math.min(s.years * 12, Math.max(last.from + 12, (s.grace * 12) + 1));
  patch({ rates: [...s.rates, { from: nextFrom, rate: Number((last.rate + 0.5).toFixed(3)) }] });
  renderRateRows();
  const rows = $$('#rateRows .row');
  printRows(rows[rows.length - 1]);
});

/* ---------- 可重複列：額外還本 ---------- */
function renderExtraRows() {
  const host = $('#extraRows');
  host.replaceChildren();
  const s = cur();
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
              const v = clamp(Math.round(parseNum(e.target.value, ex.month)), 1, s.years * 12);
              patch({ extras: s.extras.map((x, k) => (k === i ? { ...x, month: v } : x)) });
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
              patch({ extras: s.extras.map((x, k) => (k === i ? { ...x, amount: v } : x)) });
            },
          }),
          el('span', { class: 'field__unit', text: '元' }),
        ]),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label', text: '處理' }),
        el('span', { class: 'field__control' }, [
          el('select', {
            onchange: (e) => patch({ extras: s.extras.map((x, k) => (k === i ? { ...x, mode: e.target.value } : x)) }),
          }, [
            el('option', { value: 'shorten', text: '縮短年限', selected: ex.mode !== 'lower' }),
            el('option', { value: 'lower', text: '降低月付', selected: ex.mode === 'lower' }),
          ]),
        ]),
      ]),
      el('button', {
        type: 'button', class: 'row__del', 'aria-label': '刪除這筆還本',
        html: iconHTML('close'),
        onclick: () => { patch({ extras: s.extras.filter((_, k) => k !== i) }); renderExtraRows(); },
      }),
    ]);
    // 每年重複
    const rep = el('label', { class: 'switch', style: 'grid-column:1/-1;margin-top:4px' }, [
      el('input', {
        type: 'checkbox', checked: !!ex.repeatYearly,
        onchange: (e) => patch({ extras: s.extras.map((x, k) => (k === i ? { ...x, repeatYearly: e.target.checked } : x)) }),
      }),
      el('span', { class: 'switch__box' }),
      el('span', { text: '之後每年同月都還一次' }),
    ]);
    row.appendChild(rep);
    host.appendChild(row);
  });
}

$('#addExtra').addEventListener('click', () => {
  const s = cur();
  patch({ extras: [...s.extras, { month: Math.max(1, s.grace * 12 + 12), amount: 200000, mode: 'shorten', repeatYearly: false }] });
  renderExtraRows();
  const rows = $$('#extraRows .row');
  printRows(rows[rows.length - 1]);
});

$('#resetBtn').addEventListener('click', () => {
  store.replace({ scenarios: { 1: SCENARIO_DEFAULT() }, active: 1 });
  location.replace(location.pathname);
});

/* ==========================================================================
   情境（四聯）
   ========================================================================== */
const plies = createPlies($('#plies'), {
  max: 3,
  labels: ['第一聯', '第二聯', '第三聯'],
  onSwitch: (id) => { store.set({ active: id }); syncInputs(); compute(); },
  onAdd: (id) => {
    const scenarios = { ...store.at('scenarios') };
    scenarios[id] = { ...cur() };            // 複寫：從目前這張抄一份
    store.set({ scenarios, active: id });
    syncInputs(); compute();
    toast('已複寫一份。改動這一聯，前一聯會留在圖上當鬼影。');
  },
  onRemove: (removed, nextActive) => {
    const scenarios = { ...store.at('scenarios') };
    delete scenarios[removed];
    store.set({ scenarios, active: nextActive });
    syncInputs(); compute();
  },
});

function syncInputs() {
  const s = cur();
  fAmount.set(s.amount, { silent: true });
  fYears.set(s.years, { silent: true });
  fIncome.set(s.income || '', { silent: true });
  sGrace.set(s.grace, { silent: true });
  sShock.set(s.shock, { silent: true });
  segMethod.set(s.method);
  renderRateRows();
  renderExtraRows();
  renderPresets();
}

/* ==========================================================================
   計算與繪製
   ========================================================================== */
const SERIES_COLORS = ['--series-1', '--series-2', '--series-3'];
const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

const cGrace = makeCounter($('#r-grace'), (v) => money(Math.round(v)));
const cAfter = makeCounter($('#r-after'), (v) => money(Math.round(v)));
const cJump = makeCounter($('#r-jump'), (v) => (Math.abs(v) < 1 ? '無' : (v > 0 ? '+' : '') + money(Math.round(v))));
const cInterest = makeCounter($('#r-interest'), (v) => dec(v / 10000, 1) + '<small>萬</small>', { html: true });

let vtable = null;
let lastCliffMonth = null;

function runScenario(s) {
  const shockPP = (s.shock || 0) * 0.25;
  const rateSegments = s.rates
    .map((r) => ({ from: Math.max(1, Math.round(r.from)), rate: Math.max(0, (r.rate + shockPP)) / 100 }))
    .sort((a, b) => a.from - b.from);
  return amortize({
    principal: s.amount,
    totalMonths: Math.round(s.years * 12),
    graceMonths: Math.round(s.grace * 12),
    rateSegments,
    extras: s.extras,
    method: s.method,
  });
}

function validateRates(s) {
  const sorted = [...s.rates].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].from === sorted[i - 1].from) return '有兩段利率從同一期開始，請改掉其中一段。';
    if (sorted[i].from > s.years * 12) return `第 ${sorted[i].from} 期已超過貸款總期數（${s.years * 12} 期）。`;
  }
  return null;
}

function compute({ from } = {}) {
  const s = cur();
  const err = validateRates(s);
  $('#rateError').textContent = err || '';
  if (err) return;

  const active = runScenario(s);
  const scenarios = store.at('scenarios');
  const ids = Object.keys(scenarios).map(Number).sort((a, b) => a - b);
  const activeId = store.at('active');

  /* ---- 月付金時間軸：目前這一聯為實線，其餘為鬼影 ---- */
  const series = [];
  const legend = [];
  ids.forEach((id, idx) => {
    const isActive = id === activeId;
    const res = isActive ? active : runScenario(scenarios[id]);
    const color = isActive ? cssv(SERIES_COLORS[idx % 3]) : cssv('--ghost');
    series.push({
      type: 'step',
      data: res.rows.map((r) => ({ x: r.m, y: r.payment })),
      color,
      width: isActive ? 2.5 : 1.5,
      dash: isActive ? null : [4, 3],
      noCursor: !isActive,
      label: plies.items().find((p) => p.id === id)?.label || `情境 ${id}`,
    });
    legend.push({ label: plies.items().find((p) => p.id === id)?.label || `情境 ${id}`, color, dash: !isActive });
  });
  plot.opts.xTickValues = yearTicks(s.years * 12);
  plot2.opts.xTickValues = plot.opts.xTickValues;
  plot.setSeries(series, { animate: from === 'grace' || from === 'shock' });

  /* ---- 警戒線 ---- */
  const marks = [];
  if (s.income > 0) {
    for (const b of RULES.burdenLines) {
      marks.push({ axis: 'y', value: s.income * b.at, label: b.label, color: cssv('--warn'), dash: [6, 4] });
    }
  }
  if (active.cliff) marks.push({ axis: 'x', value: active.cliff.month, color: cssv('--up'), dash: [3, 3] });
  plot.setMarks(marks);

  /* ---- 本金／利息堆疊 ---- */
  const step = Math.max(1, Math.round(active.rows.length / 220));
  const sampled = active.rows.filter((_, i) => i % step === 0);
  plot2.setSeries([
    { type: 'stack', data: sampled.map((r) => ({ x: r.m, y: 0, y1: r.principal, color: cssv('--series-1') })), barRatio: 1 },
    { type: 'stack', data: sampled.map((r) => ({ x: r.m, y: r.principal, y1: r.principal + r.interest, color: cssv('--up') })), barRatio: 1 },
  ], { animate: false });

  /* ---- 讀數 ---- */
  const graceRow = active.rows.find((r) => r.grace);
  const afterRow = active.cliff ? active.rows[active.cliff.month - 1] : active.rows.find((r) => !r.grace);
  cGrace(graceRow ? graceRow.payment : (active.rows[0]?.payment ?? 0));
  cAfter(afterRow ? afterRow.payment : (active.rows[0]?.payment ?? 0));
  cJump(active.cliff ? active.cliff.delta : 0);
  cInterest(active.totalInterest);

  const jx = $('#r-jumpx');
  if (active.cliff) {
    jx.textContent = `${active.cliff.ratio.toFixed(2)} 倍`;
    jx.dataset.dir = 'up';
  } else { jx.textContent = ''; jx.dataset.dir = 'flat'; }

  /* ---- 結論 ---- */
  renderVerdict(s, active);

  /* ---- 斷崖標籤 ---- */
  lastCliffMonth = active.cliff ? active.cliff.month : null;
  positionCliffTag(active);

  /* ---- 表格 ---- */
  renderTable(active);

  /* ---- 公式 ---- */
  renderFormula(s, active);

  /* ---- 相依數字一起浮出來，讓因果被看見 ---- */
  if (from) carbonTransfer($$('[data-live]'));
}

function positionCliffTag(res) {
  if (!res.cliff) { cliffTag.hidden = true; return; }
  const x = plot.sx(res.cliff.month);
  const y = plot.sy(res.cliff.after);
  cliffTag.hidden = false;
  cliffTag.textContent = `+${int(res.cliff.delta)} 元／${res.cliff.ratio.toFixed(2)} 倍`;
  const canvasTop = $('#chart').offsetTop;
  const flip = x > plot.w * 0.62;
  cliffTag.style.left = Math.max(4, Math.min(plot.w - 8, x + (flip ? -8 : 8))) + 'px';
  cliffTag.style.top = (canvasTop + Math.max(4, y - 30)) + 'px';
  cliffTag.style.transform = flip ? 'translateX(-100%)' : 'none';
}

let stampedFor = null;
function renderVerdict(s, res) {
  const h = $('#verdict-h');
  const body = $('#verdictBody');
  const stamp = $('#verdictStamp');

  if (!res.cliff) {
    h.textContent = s.grace > 0
      ? '這組條件下沒有斷崖'
      : '沒有寬限期，所以沒有斷崖';
    body.textContent = s.method === 'equalPrincipal'
      ? '本金平均攤還的月付金本來就逐月遞減，「斷崖」這個說法在這裡不成立。要看的是第一期的負擔，不是後面的跳升。'
      : `月付金從第一期到最後一期沒有出現超過 5% 的跳升。總利息 ${money(res.totalInterest, { compact: true })} 元。`;
    stamp.hidden = true;
    stampedFor = null;
    return;
  }

  const c = res.cliff;
  const y = Math.floor((c.month - 1) / 12) + 1;
  const m = ((c.month - 1) % 12) + 1;
  h.innerHTML = `第 <em>${y}</em> 年第 <em>${m}</em> 個月，月付金從 ${int(Math.round(c.before))} 跳到 <em>${int(Math.round(c.after))}</em> 元。`;

  const ratioBurden = s.income > 0 ? c.after / s.income : null;
  let tail = '';
  if (ratioBurden != null) {
    tail = ratioBurden >= 0.4
      ? `那一個月起，房貸會吃掉你 ${pct(ratioBurden, 0)} 的月收入，已經越過 40% 這條線。`
      : ratioBurden >= 0.33
        ? `那一個月起，房貸占月收入 ${pct(ratioBurden, 0)}，剛好落在 33% 到 40% 之間。`
        : `那一個月起，房貸占月收入 ${pct(ratioBurden, 0)}。`;
  }
  body.textContent = `寬限期讓你前 ${fmtMonths(s.grace * 12)}只繳利息，本金一塊都沒少，所以期滿後要用剩下的年數還完全部本金。${tail}`;

  stamp.hidden = false;
  const key = `${c.month}:${Math.round(c.after)}`;
  if (stampedFor !== key) {
    stamp.innerHTML = `<span class="stamp">斷崖 ${c.ratio.toFixed(2)} 倍</span>`;
    stampIn(stamp.firstElementChild);
    stampedFor = key;
  }
}

function renderTable(res) {
  const wrap = $('#ledgerWrap');
  if (!vtable) {
    vtable = virtualTable(wrap, {
      rowHeight: 36,
      total: res.rows.length,
      render: (i) => {
        const r = window.__rows[i];
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
  window.__rows = res.rows;
  vtable.setTotal(res.rows.length);
  $('#tableFoot').innerHTML =
    `共 ${res.rows.length} 期${res.clearedEarly ? '（因額外還本提前結清）' : ''}．` +
    `總支出 ${int(Math.round(res.totalPaid))} 元．其中利息 ${int(Math.round(res.totalInterest))} 元` +
    `（占本金的 ${pct(res.totalInterest / cur().amount, 1)}）`;
}

$('#jumpCliff').addEventListener('click', () => {
  if (lastCliffMonth == null) { toast('這組條件沒有斷崖'); return; }
  $('#tableCard').scrollIntoView({ behavior: still() ? 'auto' : 'smooth', block: 'center' });
  vtable?.scrollToRow(lastCliffMonth - 1);
});

function renderFormula(s, res) {
  const host = $('#formulaHost');
  host.replaceChildren();
  const shockPP = (s.shock || 0) * 0.25;
  const firstRate = (s.rates[0].rate + shockPP) / 100 / 12;
  const n = s.years * 12 - s.grace * 12;
  const bal = s.amount;

  host.appendChild(formulaBlock('攤開看：月付金是怎麼算出來的', [
    `<b>寬限期內</b> 每期只繳息 = 本金 × 月利率`,
    `= ${int(s.amount)} × ${(firstRate).toFixed(8)} = <b>${int(Math.round(s.amount * firstRate))}</b> 元`,
    `<b>期滿後</b> 以剩餘期數重算本息平均攤還月付金`,
    `PMT = P·i ÷ (1 − (1+i)<sup>−n</sup>)`,
    `P = ${int(bal)}　i = ${(firstRate).toFixed(8)}（年利率 ${pp(s.rates[0].rate + shockPP, 3)} ÷ 12）　n = ${n}`,
    `= <b>${int(Math.round(res.rows.find((r) => !r.grace)?.payment || 0))}</b> 元`,
    `<b>升息換算</b> 1 碼 = 0.25 個百分點；目前套用 ${codes(s.shock)}（${pp(shockPP, 2, { sign: true })}）`,
  ], '寬限期只繳息、期滿以剩餘期數重算，是台灣房貸契約的通用作法。實際計息方式（每日／每月）與利率重訂頻率依各行庫契約而定。'));

  host.appendChild(formulaBlock('攤開看：額外還本的隱含報酬', [
    `提前還本省下的利息，等於把那筆錢用「貸款利率」無風險投資`,
    `目前適用利率 = <b>${pp(s.rates[0].rate + shockPP, 3)}</b>`,
    `所以：只有當你能穩定拿到高於 ${pp(s.rates[0].rate + shockPP, 3)} 的稅後報酬，`,
    `不提前還本才划算。這不是投資建議，是一條算術上的等號。`,
  ], null));
}

/* ==========================================================================
   圖表游標
   ========================================================================== */
plot.onCursor = (x, px) => {
  if (x == null) { tip.hide(); return; }
  const rows = window.__rows || [];
  const m = clamp(Math.round(x), 1, rows.length);
  const r = rows[m - 1];
  if (!r) { tip.hide(); return; }
  const y = Math.floor((m - 1) / 12) + 1;
  const mm = ((m - 1) % 12) + 1;
  tip.show(
    `<b>第 ${y} 年 ${mm} 月</b><br>月付 ${int(Math.round(r.payment))}<br>` +
    `本金 ${int(Math.round(r.principal))}／利息 ${int(Math.round(r.interest))}<br>` +
    `剩餘 ${int(Math.round(r.balance))}`,
    px, plot.sy(r.payment) + $('#chart').offsetTop
  );
};

/* ==========================================================================
   啟動
   ========================================================================== */
async function boot() {
  try {
    const res = await fetch('../../assets/data/tw-mortgage.json');
    if (res.ok) {
      const j = await res.json();
      RULES = { ...RULES, ...j };
      $('#dataver').textContent = `資料版本 ${j.version}`;
      $('#dataver').title = j.note || '';
    }
  } catch { $('#dataver').textContent = '資料版本 離線'; }

  syncInputs();
  compute();

  window.addEventListener('resize', () => {
    clearTimeout(window.__rz);
    window.__rz = setTimeout(() => positionCliffTag({ cliff: lastCliffMonth ? { month: lastCliffMonth, after: (window.__rows?.[lastCliffMonth - 1]?.payment) || 0, delta: 0, ratio: 1 } : null }), 200);
  });

  // 首次進場：結果逐行推出，讓人感覺數字是被算出來的
  printRows($$('#readouts .readout'), { stagger: 0.06, delay: 0.1 });

  if (store.cameFromLink) toast('已載入別人傳給你的情境');
}

boot();
