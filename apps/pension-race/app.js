window.addEventListener('error', (e) => { window.__err = String(e.message); });

import { gsap, printRows, stampIn, makeCounter, carbonTransfer, still } from '../../assets/js/core/motion.js';
import { Plot } from '../../assets/js/core/plot.js';
import { createStore } from '../../assets/js/core/state.js';
import {
  $, $$, el, iconHTML, bindSlider, bindField, bindSegmented,
  mountTopbar, mountShare, mountTheme, toast, formulaBlock,
} from '../../assets/js/core/ui.js';
import { int, dec, money, pct, pp, ageLabel, parseNum, clamp } from '../../assets/js/core/format.js';

/* ==========================================================================
   資料：法規常數一律外部化。查不到的標 unverified，不參與計算。
   ========================================================================== */
const FALLBACK = {
  version: '未載入',
  items: [],
  claimAgeByBirthYear: [
    { birthYearROCFrom: null, birthYearROCTo: 46, legalAge: 60, earliestAge: 55, label: '46 年次（含）以前' },
    { birthYearROCFrom: 51, birthYearROCTo: null, legalAge: 65, earliestAge: 60, label: '51 年次（含）以後' },
  ],
  insuredSalaryGrades: { value: [29500, 45800] },
  sources: [],
};

let RULES = FALLBACK;
/** items[] 攤平成可直接取值的常數表 */
let K = {
  formulaARatePct: 0.775, formulaAAddon: 3000, formulaBRatePct: 1.55,
  deferPerYearPct: 4, deferMaxPct: 20, earlyPerYearPct: 4, earlyMaxPct: 20,
  maxShiftYears: 5, minInsuredYears: 15,
  insuredSalaryMax: 45800, insuredSalaryMin: 29500,
  lumpsumMonthsPerYear: 1, legacyMonthsFirst15: 1, legacyMonthsAfter15: 2, legacyMonthsCap: 45,
  cpiThresholdPct: 5,
  lifeExpectancyAtBirth113All: 80.77,
  lifeExpectancyAt65Male: 18.35, lifeExpectancyAt65Female: 22.41,
};

const ROC_NOW = new Date().getFullYear() - 1911;

const DEFAULTS = {
  salary: 45800,   // 平均月投保薪資（已頂到 115 年天花板）
  years: 30,       // 勞保年資（年）
  months: 0,       // 勞保年資（月）
  birth: 55,       // 出生年次（民國）→ 法定請領年齡 65 歲
  life: 84,        // 預期壽命游標。首屏就落在「提前領勝出」那一側，機制一眼可見。
  system: 'legacy',
  salary36: 45800,
  cpiOn: false,
  cpi: 2,
  cut: 100,
};

const store = createStore('vm:pension-race', { ...DEFAULTS });

/* ==========================================================================
   版面掛載
   ========================================================================== */
mountTopbar({ title: '勞保年金請領年齡賽跑' });
const actions = $('#sheetActions');
mountShare(actions, store);
mountTheme(actions);

const plotHost = $('#plotCard');
const crossTags = [];           // 交叉點浮動標籤，最多三個（三條線兩兩相比）
for (let i = 0; i < 3; i++) {
  const t = el('div', { class: 'cross-tag', 'aria-hidden': 'true' });
  plotHost.appendChild(t);
  crossTags.push(t);
}
const lifeTag = el('div', { class: 'life-tag', 'aria-hidden': 'true' });
plotHost.appendChild(lifeTag);

const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* ==========================================================================
   圖表：60→95 歲的人生軸，縱軸是累積已領總額
   ========================================================================== */
const plot = new Plot($('#chart'), {
  aspect: 0.58,
  minHeight: 240,
  yFormat: (v) => (v >= 10000 ? Math.round(v / 10000) + '萬' : String(Math.round(v))),
  xFormat: (v) => String(Math.round(v)),
  padding: { left: 50, bottom: 28, top: 20, right: 14 },
});
plot.onCursor = null;

/* ==========================================================================
   法規查表
   ========================================================================== */
function claimAgeRow(birthROC) {
  const rows = RULES.claimAgeByBirthYear || FALLBACK.claimAgeByBirthYear;
  for (const r of rows) {
    const lo = r.birthYearROCFrom == null ? -Infinity : r.birthYearROCFrom;
    const hi = r.birthYearROCTo == null ? Infinity : r.birthYearROCTo;
    if (birthROC >= lo && birthROC <= hi) return r;
  }
  return rows[rows.length - 1];
}

/** 月薪 → 投保薪資級距（落在哪一級就以該級上限投保，超過天花板一律天花板） */
function gradeFor(wage) {
  const grades = (RULES.insuredSalaryGrades?.value) || FALLBACK.insuredSalaryGrades.value;
  for (const g of grades) if (wage <= g) return g;
  return grades[grades.length - 1];
}

/* ==========================================================================
   核心數學
   A 式 = 平均月投保薪資 × 年資 × 0.775% + 3,000
   B 式 = 平均月投保薪資 × 年資 × 1.55%
   展延／減給：每 1 年 ±4%，最多 5 年（±20%）
   ========================================================================== */
function baseMonthly(S, Y) {
  const a = S * Y * (K.formulaARatePct / 100) + K.formulaAAddon;
  const b = S * Y * (K.formulaBRatePct / 100);
  return { a, b, best: Math.max(a, b), which: a >= b ? 'A' : 'B' };
}

function shiftFactor(claimAge, legalAge) {
  const d = claimAge - legalAge;
  const cap = K.maxShiftYears;
  if (d >= 0) return 1 + Math.min(d, cap) * (K.deferPerYearPct / 100);
  return 1 - Math.min(-d, cap) * (K.earlyPerYearPct / 100);
}

/**
 * 累積領取金額（以「月」為單位）。
 * 物價調整依第 65 條之 4：以請領當年度為基期，累計成長率達 5% 才依該成長率調整，
 * 調整後基期跟著移動 —— 這不是每年按通膨外推，兩者差很多。
 * @returns Float64Array，out[k] = 領了 k 個月之後手上總共有多少
 */
function cumArray(monthly0, maxMonths, opt) {
  const out = new Float64Array(maxMonths + 1);
  let cum = 0, m = monthly0, priceIdx = 1, baseIdx = 1;
  const thr = K.cpiThresholdPct / 100;
  for (let k = 0; k <= maxMonths; k++) {
    if (k > 0 && k % 12 === 0 && opt.cpiOn) {
      priceIdx *= 1 + opt.cpi;
      if (priceIdx / baseIdx - 1 >= thr) { m *= priceIdx / baseIdx; baseIdx = priceIdx; }
    }
    out[k] = cum;
    cum += m;
  }
  return out;
}

/** 一次請領老年給付（僅 98 年前已有年資者可選）：前 15 年 1 個月、超過部分 2 個月，上限 45 個月 */
function legacyLumpMonths(Y) {
  const first = Math.min(Y, 15) * K.legacyMonthsFirst15;
  const rest = Math.max(0, Y - 15) * K.legacyMonthsAfter15;
  return Math.min(first + rest, K.legacyMonthsCap);
}

/* ==========================================================================
   模型：把一組輸入變成三條曲線 + 交叉點
   ========================================================================== */
const LINE_KEYS = ['early', 'legal', 'defer'];
const LINE_COLORS = { early: '--series-4', legal: '--series-1', defer: '--series-5' };

function buildModel(s) {
  const S = Math.min(Math.max(0, s.salary), K.insuredSalaryMax);
  const Y = Math.max(0, s.years) + clamp(Math.max(0, s.months), 0, 11) / 12;
  const row = claimAgeRow(s.birth);
  const legalAge = row.legalAge;
  const earliest = row.earliestAge;
  const cut = clamp(s.cut, 1, 100) / 100;
  const opt = { cpiOn: !!s.cpiOn, cpi: clamp(s.cpi, -5, 20) / 100 };

  const base = baseMonthly(S, Y);
  const eligible = Y >= K.minInsuredYears;

  const axisStart = earliest;
  const axisEnd = Math.max(95, Math.ceil(s.life) + 1);
  const grid = [];
  for (let x = axisStart; x <= axisEnd + 1e-9; x += 1 / 12) grid.push(Number(x.toFixed(6)));

  const ages = { early: legalAge - K.maxShiftYears, legal: legalAge, defer: legalAge + K.maxShiftYears };
  const lines = LINE_KEYS.map((key) => {
    const claimAge = ages[key];
    const monthly = base.best * shiftFactor(claimAge, legalAge) * cut;
    const maxK = Math.round((axisEnd - claimAge) * 12);
    const cum = cumArray(monthly, Math.max(0, maxK), opt);
    const data = grid.map((x) => {
      const k = Math.round((x - claimAge) * 12);
      return { x, y: k < 0 ? 0 : cum[Math.min(k, cum.length - 1)] };
    });
    return { key, claimAge, monthly, cum, data };
  });

  /* ---- 交叉點：兩兩相比，找累積總額互換名次的那一格 ---- */
  const crossings = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const A = lines[i], B = lines[j];
      for (let n = 1; n < grid.length; n++) {
        const d0 = A.data[n - 1].y - B.data[n - 1].y;
        const d1 = A.data[n].y - B.data[n].y;
        if (d0 === 0 || d1 === 0 || (d0 > 0) === (d1 > 0)) continue;
        if (A.data[n].y <= 0 || B.data[n].y <= 0) continue;
        const t = d0 / (d0 - d1);
        const x = grid[n - 1] + t * (grid[n] - grid[n - 1]);
        const winner = d1 > 0 ? A : B;
        const loser = d1 > 0 ? B : A;
        crossings.push({ x, y: A.data[n].y, winner: winner.key, loser: loser.key });
      }
    }
  }
  crossings.sort((p, q) => p.x - q.x);

  /* ---- 到設定壽命為止，各方案總共領到多少 ---- */
  const totalAt = (line, age) => {
    const k = Math.round((age - line.claimAge) * 12);
    if (k <= 0) return 0;
    return line.cum[Math.min(k, line.cum.length - 1)];
  };

  /* ---- 法定 −5 到 +5 每一格 ---- */
  const table = [];
  for (let d = -K.maxShiftYears; d <= K.maxShiftYears; d++) {
    const age = legalAge + d;
    const monthly = base.best * shiftFactor(age, legalAge) * cut;
    const maxK = Math.max(0, Math.round((Math.ceil(s.life) + 1 - age) * 12));
    const cum = cumArray(monthly, maxK, opt);
    const k = Math.round((s.life - age) * 12);
    const total = k <= 0 ? 0 : cum[Math.min(k, cum.length - 1)];
    table.push({ age, d, monthly, total, factor: shiftFactor(age, legalAge) });
  }
  const bestTotal = Math.max(...table.map((r) => r.total));
  table.forEach((r) => { r.gap = r.total - bestTotal; });

  /* ---- 一次金 ---- */
  const lumpAnnuity = S * Y * K.lumpsumMonthsPerYear;                       // 老年一次金（年資 < 15 才有）
  const S36 = Math.min(Math.max(0, s.salary36 || S), K.insuredSalaryMax);
  const legacyMonths = legacyLumpMonths(Y);
  const lumpLegacy = S36 * legacyMonths;                                    // 一次請領老年給付（98 年前有年資者）

  return {
    S, Y, row, legalAge, earliest, base, eligible, cut, opt,
    axisStart, axisEnd, grid, lines, crossings, totalAt, table, bestTotal,
    lumpAnnuity, lumpLegacy, legacyMonths, S36,
    currentAge: ROC_NOW - s.birth,
  };
}

/* ==========================================================================
   輸入元件
   ========================================================================== */
function patch(p, { recompute = true, from } = {}) {
  store.set(p);
  if (recompute) render({ from });
}

const fSalary = bindField($('#f-salary'), {
  pretty: int,
  validate: (v) => {
    if (!Number.isFinite(v) || v <= 0) return '請填入大於 0 的金額';
    if (v > 500000) return '這個金額超出試算範圍';
    return null;
  },
  onChange: (v, { valid }) => { if (valid) patch({ salary: v }); },
});

const fYears = bindField($('#f-years'), {
  validate: (v) => {
    if (!Number.isFinite(v) || v < 0) return '年資不能是負的';
    if (v > 60) return '年資超過 60 年，請確認';
    return null;
  },
  onChange: (v, { valid }) => { if (valid) patch({ years: Math.floor(v) }); },
});

const fMonths = bindField($('#f-months'), {
  validate: (v) => {
    if (!Number.isFinite(v) || v < 0 || v > 11) return '請填 0 到 11';
    return null;
  },
  onChange: (v, { valid }) => { if (valid) patch({ months: Math.round(v) }); },
});

const fBirth = bindField($('#f-birth'), {
  validate: (v) => {
    if (!Number.isFinite(v) || v < 1) return '請填民國年次，例如 55';
    if (v > ROC_NOW) return `民國 ${ROC_NOW} 年次以後還沒出生`;
    return null;
  },
  onChange: (v, { valid }) => { if (valid) patch({ birth: Math.round(v) }); },
});

const fWage = bindField($('#f-wage'), { pretty: int });

$('#wageApply').addEventListener('click', () => {
  const w = fWage.value();
  if (!Number.isFinite(w) || w <= 0) { toast('先填一個月薪金額'); return; }
  const g = gradeFor(w);
  fSalary.set(g, { silent: true });
  patch({ salary: g });
  toast(w > K.insuredSalaryMax
    ? `月薪 ${int(w)} 已超過天花板，投保薪資以 ${int(g)} 計`
    : `月薪 ${int(w)} 對應投保薪資 ${int(g)} 元`);
});

const sLife = bindSlider($('#s-life'), {
  format: (v) => `${v}<small>歲</small>`,
  onInput: (v) => { store.set({ life: v }); render({ from: 'life' }); },
});

const segSystem = bindSegmented($('#seg-system'), { onChange: (v) => patch({ system: v }) });
const segCut = bindSegmented($('#seg-cut'), { onChange: (v) => patch({ cut: Number(v) }) });

const fSalary36 = bindField($('#f-salary36'), {
  pretty: int,
  onChange: (v) => { if (Number.isFinite(v) && v > 0) patch({ salary36: v }); },
});

const fCpi = bindField($('#f-cpi'), {
  validate: (v) => (Number.isFinite(v) && v >= -5 && v <= 20 ? null : '請填 -5 到 20 之間'),
  onChange: (v, { valid }) => { if (valid) patch({ cpi: v }); },
});

$('#sw-cpi').querySelector('input').addEventListener('change', (e) => {
  patch({ cpiOn: e.target.checked });
});

$('#resetBtn').addEventListener('click', () => {
  store.replace({ ...DEFAULTS });
  location.replace(location.pathname);
});

function syncInputs() {
  const s = store.get();
  fSalary.set(s.salary, { silent: true });
  fYears.set(s.years, { silent: true });
  fMonths.set(s.months, { silent: true });
  fBirth.set(s.birth, { silent: true });
  fSalary36.set(s.salary36, { silent: true });
  fCpi.set(s.cpi, { silent: true });
  sLife.set(s.life, { silent: true });
  segSystem.set(s.system);
  segCut.set(String(s.cut));
  $('#sw-cpi').querySelector('input').checked = !!s.cpiOn;
}

/* ==========================================================================
   壽命游標：圖面本身就是可拖曳區，滑桿是它的鍵盤等效路徑
   ========================================================================== */
let lastModel = null;
const canvas = $('#chart');

function ageFromPointer(e) {
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const age = plot.ix(px);
  const range = sLife.el;
  return clamp(Math.round(age), Number(range.min), Number(range.max));
}

let dragging = false;
canvas.addEventListener('pointerdown', (e) => {
  if (!lastModel || !lastModel.eligible) return;
  dragging = true;
  canvas.setPointerCapture(e.pointerId);
  const v = ageFromPointer(e);
  sLife.set(v, { silent: true });
  store.set({ life: v });
  render({ from: 'life' });
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const v = ageFromPointer(e);
  if (v === store.at('life')) return;
  sLife.set(v, { silent: true });
  store.set({ life: v });
  render({ from: 'life' });
});
const endDrag = (e) => {
  if (!dragging) return;
  dragging = false;
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

/* ==========================================================================
   繪製
   ========================================================================== */
const cEarly = makeCounter($('#r-early'), (v) => money(Math.round(v)));
const cLegal = makeCounter($('#r-legal'), (v) => money(Math.round(v)));
const cDefer = makeCounter($('#r-defer'), (v) => money(Math.round(v)));
const cBest = makeCounter($('#r-best'), (v) => dec(v / 10000, 1) + '<small>萬</small>', { html: true });

const LABELS = (m) => ({
  early: `提前 ${K.maxShiftYears} 年（${m.legalAge - K.maxShiftYears} 歲）`,
  legal: `法定年齡（${m.legalAge} 歲）`,
  defer: `展延 ${K.maxShiftYears} 年（${m.legalAge + K.maxShiftYears} 歲）`,
});

function seriesFor(m, { upto = Infinity, emphasise = null } = {}) {
  const idx = Number.isFinite(upto)
    ? clamp(Math.round((upto - m.axisStart) * 12) + 1, 1, m.grid.length)
    : m.grid.length;
  return m.lines
    .filter((L) => !hidden.has(L.key))
    .map((L) => ({
      type: 'line',
      data: L.data.slice(0, idx),
      color: cssv(LINE_COLORS[L.key]),
      width: emphasise ? (L.key === emphasise ? 3.4 : 1.6) : 2.2,
      alpha: emphasise && L.key !== emphasise ? 0.45 : 1,
      noCursor: true,
    }));
}

/* 標記線：壽命游標的字樣改用 DOM 標籤（見 layoutLifeTag），
   因為 plot.js 的 x 軸標記一律把字寫在圖頂，會跟交叉點標籤疊在一起。 */
function marksFor(m, s) {
  const marks = [
    { axis: 'x', value: clamp(s.life, m.axisStart, m.axisEnd), color: cssv('--accent'), dash: [6, 3] },
    { axis: 'x', value: K.lifeExpectancyAtBirth113All, color: cssv('--ink-3'), dash: [2, 3] },
  ];
  // 65 歲平均餘命才是這張圖真正該對照的終點：已經活到 65 歲的人不再承擔 65 歲前的死亡風險。
  // 本頁沒有性別欄位，所以兩條都畫，不合成一個平均值。
  if (Number.isFinite(K.lifeExpectancyAt65Male)) {
    marks.push({ axis: 'x', value: 65 + K.lifeExpectancyAt65Male, color: cssv('--ink-3'), dash: [1, 4] });
  }
  if (Number.isFinite(K.lifeExpectancyAt65Female)) {
    marks.push({ axis: 'x', value: 65 + K.lifeExpectancyAt65Female, color: cssv('--ink-3'), dash: [1, 4] });
  }
  if (s.system === 'legacy' && m.eligible && m.lumpLegacy > 0) {
    marks.push({
      axis: 'y', value: m.lumpLegacy, color: cssv('--ink-2'), dash: [8, 4],
      label: `一次請領 ${dec(m.lumpLegacy / 10000, 1)} 萬（領完就不再增加）`,
    });
  }
  return marks;
}

/** 壽命游標的把手：貼著 X 軸放，同時是「這條線可以拖」的視覺提示 */
function layoutLifeTag(m, s) {
  const x = plot.sx(clamp(s.life, m.axisStart, m.axisEnd));
  lifeTag.textContent = `${s.life} 歲`;
  lifeTag.style.left = clamp(x, plot.pad.left + 14, plot.w - 14) + 'px';
  lifeTag.style.top = (canvas.offsetTop + plot.h - plot.pad.bottom - 20) + 'px';
  lifeTag.style.opacity = '1';
}

function domainFor(m) {
  let y1 = 0;
  for (const L of m.lines) if (!hidden.has(L.key)) y1 = Math.max(y1, L.data[L.data.length - 1].y);
  if (!(y1 > 0)) y1 = 1;
  return { x0: m.axisStart, x1: m.axisEnd, y0: 0, y1: y1 * 1.08 };
}

/** 直接寫 series/domain 再 render：賽跑時每一格都要用同一個座標系，不能讓軸自己跳 */
function paint(series, marks, domain) {
  plot.series = series;
  plot.marks = marks;
  plot.domain = domain;
  plot.render();
}

const hidden = new Set();

function renderLegend(m) {
  const host = $('#legend');
  host.replaceChildren();
  const labels = LABELS(m);
  for (const key of LINE_KEYS) {
    const b = el('button', {
      class: 'legend__item', type: 'button',
      'aria-pressed': String(!hidden.has(key)),
      onclick: () => {
        if (hidden.has(key)) hidden.delete(key); else hidden.add(key);
        if (hidden.size === LINE_KEYS.length) hidden.delete(key);
        render({ from: 'legend' });
      },
    }, [
      el('span', { class: 'legend__key', style: `background:${cssv(LINE_COLORS[key])}` }),
      el('span', { text: labels[key] }),
    ]);
    host.appendChild(b);
  }
}

/* ---------- 交叉點標籤 ---------- */
function layoutCrossTags(m, revealCount = Infinity) {
  const labels = LABELS(m);
  const canvasTop = canvas.offsetTop;
  crossTags.forEach((t, i) => {
    const c = m.crossings[i];
    if (!c || i >= revealCount || c.x > m.axisEnd) { t.style.opacity = '0'; return; }
    const x = plot.sx(c.x);
    const y = plot.sy(c.y);
    const flip = x > plot.w * 0.55;
    t.innerHTML = `${ageLabel(c.x)}<br>${labels[c.winner].split('（')[0]}反超${labels[c.loser].split('（')[0]}`;
    t.dataset.lead = String(c.winner === 'legal');
    t.style.left = clamp(x + (flip ? -6 : 6), 4, Math.max(4, plot.w - 8)) + 'px';
    t.style.top = (canvasTop + clamp(y - 34 - i * 4, 4, plot.h - 40)) + 'px';
    t.style.transform = flip ? 'translateX(-100%)' : 'none';
    if (still()) t.style.opacity = '1';
  });
}

function revealTag(i) {
  const t = crossTags[i];
  if (!t) return;
  if (still()) { t.style.opacity = '1'; return; }
  gsap.fromTo(t, { opacity: 0, y: 6, scale: 0.9 }, { opacity: 1, y: 0, scale: 1, duration: 0.28, ease: 'back.out(2)' });
}

/* ---------- 招牌動效：三條線一起向右賽跑，在交叉那一格停一下 ---------- */
let raceTl = null;
function runRace(m, s) {
  raceTl?.kill();
  const domain = domainFor(m);
  const emphasise = winnerKey(m, s.life);
  if (still()) {
    paint(seriesFor(m, { emphasise }), marksFor(m, s), domain);
    layoutCrossTags(m);
    layoutLifeTag(m, s);
    return;
  }
  crossTags.forEach((t) => { t.style.opacity = '0'; });
  const stops = m.crossings.map((c) => c.x).filter((x) => x <= m.axisEnd);
  const span = m.axisEnd - m.axisStart;
  const TOTAL = 1.7;
  const o = { x: m.axisStart };
  const draw = () => { paint(seriesFor(m, { upto: o.x }), marksFor(m, s), domain); layoutLifeTag(m, s); };

  raceTl = gsap.timeline({
    onComplete: () => {
      paint(seriesFor(m, { emphasise }), marksFor(m, s), domain);
      layoutCrossTags(m);
      layoutLifeTag(m, s);
    },
  });
  let prev = m.axisStart;
  stops.forEach((sx, i) => {
    raceTl.to(o, { x: sx, duration: TOTAL * ((sx - prev) / span), ease: 'none', onUpdate: draw });
    raceTl.add(() => { layoutCrossTags(m, i + 1); revealTag(i); });
    raceTl.to({}, { duration: 0.34 });
    prev = sx;
  });
  raceTl.to(o, { x: m.axisEnd, duration: Math.max(0.2, TOTAL * ((m.axisEnd - prev) / span)), ease: 'none', onUpdate: draw });
}

function winnerKey(m, life) {
  let best = null, bv = -Infinity;
  for (const L of m.lines) {
    const v = m.totalAt(L, life);
    if (v > bv) { bv = v; best = L.key; }
  }
  return best;
}

/* ==========================================================================
   結論、讀數、表格、公式
   ========================================================================== */
let stampedFor = null;

function renderVerdict(m, s) {
  const h = $('#verdict-h');
  const body = $('#verdictBody');
  const stamp = $('#verdictStamp');
  const labels = LABELS(m);

  if (!m.eligible) {
    h.innerHTML = `年資 <em>${dec(m.Y, 2)}</em> 年，未滿 ${K.minInsuredYears} 年，依法不能請領老年年金。`;
    body.textContent = '所以這裡不會給你一個月領金額，那個數字不存在。你的路徑是老年一次金，往下看。';
    stamp.hidden = false;
    if (stampedFor !== 'refuse') {
      stamp.innerHTML = '<span class="stamp stamp--void">不適用年金</span>';
      stampIn(stamp.firstElementChild);
      stampedFor = 'refuse';
    }
    return;
  }

  const win = winnerKey(m, s.life);
  const totals = m.lines.map((L) => ({ key: L.key, v: m.totalAt(L, s.life) })).sort((a, b) => b.v - a.v);
  const gap = totals[0].v - totals[1].v;
  const nextCross = m.crossings.find((c) => c.x > s.life && c.x <= m.axisEnd);

  h.innerHTML = `活到 <em>${s.life}</em> 歲，<em>${labels[win]}</em>領最多，`
    + `比第二名多 <em>${int(Math.round(gap))}</em> 元。`;

  const tail = nextCross
    ? `再撐到 ${ageLabel(nextCross.x)}，${labels[nextCross.winner].split('（')[0]}就會反超${labels[nextCross.loser].split('（')[0]}。`
    : '在你設定的壽命之後，這條線不會再被超過，三條線的名次已經定了。';

  // 三條線只是 −5／法定／+5 三格；中間那幾格有可能更好，不講就是漏掉答案
  const bestRow = m.table.find((r) => r.total === m.bestTotal);
  const winAge = m.lines.find((L) => L.key === win).claimAge;
  const mid = bestRow && bestRow.age !== winAge
    ? `不過中間那幾格更好：${bestRow.age} 歲開始領可以再多 ${int(Math.round(m.bestTotal - totals[0].v))} 元，往下的表格逐格列出來了。`
    : '';
  body.textContent = `早領的線先起跑、月領較少；晚領的線後起跑、斜率較陡。誰贏完全取決於你活多久。${tail}${mid}`;

  stamp.hidden = false;
  const key = `${win}:${s.life}`;
  if (stampedFor !== key) {
    const winAge = m.lines.find((L) => L.key === win).claimAge;
    stamp.innerHTML = `<span class="stamp">${winAge} 歲開始領</span>`;
    stampIn(stamp.firstElementChild);
    stampedFor = key;
  }
}

function renderReadouts(m, s) {
  const [early, legal, defer] = m.lines;
  cEarly(early.monthly);
  cLegal(legal.monthly);
  cDefer(defer.monthly);
  cBest(Math.max(...m.lines.map((L) => m.totalAt(L, s.life))));

  $('#lb-early').textContent = `${early.claimAge} 歲開始領`;
  $('#lb-legal').textContent = `${legal.claimAge} 歲開始領（法定）`;
  $('#lb-defer').textContent = `${defer.claimAge} 歲開始領`;
  $('#lb-best').textContent = `到 ${s.life} 歲為止最高總額`;

  $('#r-earlyd').textContent = pp(-K.earlyMaxPct, 0);
  $('#r-legald').textContent = '基準';
  $('#r-deferd').textContent = pp(K.deferMaxPct, 0, { sign: true });
  const win = winnerKey(m, s.life);
  $('#r-bestd').textContent = `${LABELS(m)[win].split('（')[0]}勝出`;
}

function renderTable(m, s) {
  const body = $('#ageBody');
  body.replaceChildren();
  const passed = m.currentAge;
  m.table.forEach((r) => {
    const tr = el('tr', {});
    if (r.total === m.bestTotal && m.bestTotal > 0) tr.dataset.best = '1';
    if (r.d === 0) tr.dataset.legal = '1';
    const gone = r.age < passed;
    tr.appendChild(el('td', { text: `${r.age} 歲${gone ? '（已過）' : ''}` }));
    tr.appendChild(el('td', { text: r.d === 0 ? '-' : pp((r.factor - 1) * 100, 0, { sign: true }) }));
    tr.appendChild(el('td', { text: int(Math.round(r.monthly)) }));
    tr.appendChild(el('td', { text: int(Math.round(r.total)) }));
    tr.appendChild(el('td', {
      class: r.gap < 0 ? 'is-down' : '',
      text: r.gap === 0 ? '最佳' : int(Math.round(r.gap)),
    }));
    body.appendChild(tr);
  });

  const best = m.table.find((r) => r.total === m.bestTotal);
  const notes = [
    `以 ${s.life} 歲為終點，${best ? `${best.age} 歲開始領` : '-'}總額最高。`,
    m.currentAge > m.earliest
      ? `你今年約 ${m.currentAge} 歲，${m.earliest} 到 ${Math.min(m.currentAge - 1, m.legalAge + K.maxShiftYears)} 歲那幾格已經過去，只是拿來對照。`
      : `你今年約 ${m.currentAge} 歲，最早可以從 ${m.earliest} 歲開始減額請領（前提是年資已滿 ${K.minInsuredYears} 年）。`,
    m.cut < 1 ? `已套用 ${Math.round(m.cut * 100)}% 給付折減假設（使用者自選，非官方預測）。` : '',
    m.opt.cpiOn ? `已套用物價調整假設：年通膨 ${pp(m.opt.cpi * 100, 1)}，累計達 ${K.cpiThresholdPct}% 才調整一次。` : '',
  ].filter(Boolean);
  $('#tableFoot').textContent = notes.join('');
}

function renderLump(m, s) {
  const card = $('#lumpCard');
  const showRefuse = !m.eligible;
  card.hidden = !showRefuse;
  $('#plotCard').hidden = showRefuse;
  $('#tableCard').hidden = showRefuse;
  $('#readouts').hidden = showRefuse;
  if (!showRefuse) return;

  $('#r-lump').textContent = int(Math.round(m.lumpAnnuity));
  $('#r-lumpm').textContent = dec(m.Y, 2);
  $('#r-lumpage').textContent = `${m.legalAge} 歲`;
  $('#refuseBody').textContent =
    `勞保年資 ${dec(m.Y, 2)} 年，未滿 ${K.minInsuredYears} 年，依勞工保險條例第 58 條第 1 項第 1 款不能請領老年年金，`
    + '只能請領老年一次金。沒有月領金額可以跟別的年齡賽跑，所以那張圖不畫；畫出來會是一個不存在的東西。';

  const parts = [
    `<b>老年一次金</b>＝平均月投保薪資 ${int(m.S)} × 給付月數 ${dec(m.Y, 2)}（年資每滿 1 年給 1 個月，未滿 1 年按比例）＝ ${int(Math.round(m.lumpAnnuity))} 元，年滿 ${m.legalAge} 歲並離職退保後請領。`,
  ];
  if (s.system === 'legacy') {
    parts.push(
      `你選了「98 年前已有勞保年資」，因此還有另一條路：<b>一次請領老年給付</b>。它用的是「退保前 ${(K.avgSalaryMonthsLegacy ?? 36)} 個月」平均月投保薪資（你填的是 ${int(m.S36)}），`
      + `月數 ${dec(m.legacyMonths, 2)} 個月，約 ${int(Math.round(m.lumpLegacy))} 元，但請領資格另有條件（例如年資滿 1 年且年滿 60 歲）。兩者只能擇一，核付後不得變更。`
    );
  }
  parts.push('另外：勞保年資未滿 15 年，但併計國民年金年資滿 15 年者，年滿 65 歲可以選擇請領勞保老年年金；這條路本工具沒有模擬，請直接洽勞保局。');
  $('#lumpNote').innerHTML = parts.join('<br><br>');
}

function renderFormula(m, s) {
  const host = $('#formulaHost');
  host.replaceChildren();
  const labels = LABELS(m);

  host.appendChild(formulaBlock('攤開看：月領金額是怎麼算出來的', [
    `<b>A 式</b> = 平均月投保薪資 × 年資 × ${K.formulaARatePct}% + ${int(K.formulaAAddon)}`,
    `= ${int(m.S)} × ${dec(m.Y, 4)} × ${K.formulaARatePct}% + ${int(K.formulaAAddon)} = <b>${int(Math.round(m.base.a))}</b> 元`,
    `<b>B 式</b> = 平均月投保薪資 × 年資 × ${K.formulaBRatePct}%`,
    `= ${int(m.S)} × ${dec(m.Y, 4)} × ${K.formulaBRatePct}% = <b>${int(Math.round(m.base.b))}</b> 元`,
    `<b>擇優</b> → ${m.base.which} 式勝出，基準月領 <b>${int(Math.round(m.base.best))}</b> 元`,
    `<b>${labels.early}</b> ×（1 − ${K.earlyPerYearPct}% × ${K.maxShiftYears}）= ${int(Math.round(m.lines[0].monthly))} 元`,
    `<b>${labels.legal}</b> ×1.00 = ${int(Math.round(m.lines[1].monthly))} 元`,
    `<b>${labels.defer}</b> ×（1 + ${K.deferPerYearPct}% × ${K.maxShiftYears}）= ${int(Math.round(m.lines[2].monthly))} 元`,
    m.cut < 1 ? `<b>折減假設</b> 全部再乘 ${Math.round(m.cut * 100)}%（使用者自選，非官方預測）` : '',
  ].filter(Boolean),
  `法源：勞工保險條例第 58 條之 1（A／B 兩式擇優）、第 58 條之 2（展延與減給各 ${K.deferPerYearPct}%／年、上限 ${K.deferMaxPct}%）。`
  + `平均月投保薪資按加保期間<b>最高 60 個月</b>之平均（第 19 條第 3 項第 1 款），`
  + `115 年分級表天花板 ${int(K.insuredSalaryMax)} 元。`));

  host.appendChild(formulaBlock('攤開看：交叉點為什麼落在那裡', [
    `設法定年齡為 T、基準月領為 M，u 表示「比 T 晚幾年死」。`,
    `提前 5 年累積 = 0.8M × 12 ×（u + 5）　法定累積 = M × 12 × u`,
    `兩者相等 → 0.8(u + 5) = u → u = 20，也就是 <b>T + 20 歲</b>`,
    `展延 5 年累積 = 1.2M × 12 ×（u − 5）　與法定相等 → 1.2(u − 5) = u → u = 30，即 <b>T + 30 歲</b>`,
    `所以在沒有物價調整的情況下，交叉點只跟 ±${K.earlyPerYearPct}% 有關，跟你的薪資與年資完全無關。`,
    `這就是為什麼「損益兩平大約 11-14 年」那種說法對不上：它算的是別的東西。`,
    m.opt.cpiOn ? `你開了物價調整，各方案的基期年度不同，交叉點會比上面的純算術再往前或往後移一點。` : '',
  ].filter(Boolean),
  '這一段是純算術，不是法規；法規只提供 ±4%／年這個係數。'));

  const items = RULES.items || [];
  const un = items.filter((i) => i.confidence !== 'verified');
  host.appendChild(formulaBlock('攤開看：本頁用到的法規常數與出處', [
    ...items.filter((i) => i.confidence === 'verified' && i.value != null).map((i) => {
      const v = typeof i.value === 'number'
        ? (Number.isInteger(i.value) ? int(i.value) : String(i.value))
        : String(i.value);
      return `<b>${i.labelZh}</b> ${v}${i.unit || ''} ｜ ${i.legalBasis}`;
    }),
    ...un.map((i) => `<b>${i.labelZh}</b> 未取得官方數值（unverified），本頁不使用、不推估 ｜ ${i.legalBasis}`),
  ],
  (RULES.sources || []).map((x) => `<a href="${x.url}" rel="noopener">${x.label}</a>`).join('、')
  + `　資料版本 ${RULES.version}。`));
}

/* ==========================================================================
   總繪製
   ========================================================================== */
function render({ from, race = false } = {}) {
  const s = store.get();
  const m = buildModel(s);
  lastModel = m;

  // 出生年次 → 法定請領年齡，直接寫回欄位提示
  $('#h-birth').textContent =
    `${m.row.label}：法定請領年齡 ${m.legalAge} 歲，最早可減額請領 ${m.earliest} 歲。你今年約 ${m.currentAge} 歲。`;

  // 投保薪資天花板
  const hs = $('#h-salary');
  if (s.salary >= K.insuredSalaryMax) {
    hs.innerHTML = `<b>已頂到 115 年分級表天花板 ${int(K.insuredSalaryMax)} 元。</b>`
      + '你的實際月薪再高，年金也不會再增加，因為投保薪資已經封頂。';
  } else {
    hs.textContent = `115 年分級表天花板 ${int(K.insuredSalaryMax)} 元，超過一律以 ${int(K.insuredSalaryMax)} 計。`;
  }

  // 通膨率欄位只有在開啟物價調整時才有意義
  const cpiField = $('#f-cpi');
  if (s.cpiOn) { delete cpiField.dataset.disabled; cpiField.querySelector('input').disabled = false; }
  else { cpiField.dataset.disabled = '1'; cpiField.querySelector('input').disabled = true; }

  // 一次請領那格只有在 98 年前有年資時才有意義
  const f36 = $('#f-salary36');
  const legacyOn = s.system === 'legacy';
  if (legacyOn) { delete f36.dataset.disabled; f36.querySelector('input').disabled = false; }
  else { f36.dataset.disabled = '1'; f36.querySelector('input').disabled = true; }

  renderVerdict(m, s);
  renderLump(m, s);
  // 拖壽命游標不影響公式與圖例，重建只會把使用者展開的抽屜關掉
  if (from !== 'life') renderFormula(m, s);

  if (!m.eligible) { raceTl?.kill(); return; }

  renderReadouts(m, s);
  renderTable(m, s);
  if (from !== 'life') renderLegend(m);

  $('#lifeChip').textContent = `壽命游標 ${s.life} 歲．可直接在圖上拖`;
  plot.opts.xTickValues = ageTicks(m);

  const cross = m.crossings.filter((c) => c.x <= m.axisEnd);
  $('#chartDesc').textContent =
    `橫軸是年齡（${m.axisStart} 到 ${m.axisEnd} 歲），縱軸是從開始請領那天算起累積已領到手的總金額。`
    + (cross.length
      ? `交叉點：${cross.map((c) => `${ageLabel(c.x)} ${LABELS(m)[c.winner].split('（')[0]}反超${LABELS(m)[c.loser].split('（')[0]}`).join('；')}。`
      : '在這段軸上三條線沒有交叉。')
    + `淡色虛線由左到右依序是：113 年國人平均壽命 ${K.lifeExpectancyAtBirth113All} 歲（那是 0 歲的平均餘命，不是 65 歲的）、`
    + `65 歲男性 ${dec(65 + K.lifeExpectancyAt65Male, 1)} 歲（餘命 ${K.lifeExpectancyAt65Male} 年）、`
    + `65 歲女性 ${dec(65 + K.lifeExpectancyAt65Female, 1)} 歲（餘命 ${K.lifeExpectancyAt65Female} 年）。`
    + `後兩條才是活到 65 歲的人該對照的終點，而且它們是期望值，一半的人會活得比它更久。`;

  if (race) {
    runRace(m, s);
  } else {
    paint(seriesFor(m, { emphasise: winnerKey(m, s.life) }), marksFor(m, s), domainFor(m));
    layoutCrossTags(m);
    layoutLifeTag(m, s);
    crossTags.forEach((t, i) => { if (m.crossings[i] && m.crossings[i].x <= m.axisEnd) t.style.opacity = '1'; });
  }

  if (from && from !== 'life') carbonTransfer($$('[data-live]'));
}

/** 年齡刻度落在 5 的倍數上，不然會出現 63.4 歲這種讀不出意義的刻度 */
function ageTicks(m) {
  const out = [];
  const step = (m.axisEnd - m.axisStart) > 34 ? 5 : 5;
  for (let a = Math.ceil(m.axisStart / step) * step; a <= m.axisEnd; a += step) out.push(a);
  if (out[0] !== m.axisStart) out.unshift(m.axisStart);
  return out;
}

$('#raceBtn').addEventListener('click', () => {
  if (!lastModel?.eligible) { toast('年資未滿 15 年，沒有月領曲線可以賽跑'); return; }
  render({ race: true });
});

window.addEventListener('resize', () => {
  clearTimeout(window.__rz);
  window.__rz = setTimeout(() => {
    if (!lastModel?.eligible) return;
    layoutCrossTags(lastModel);
    layoutLifeTag(lastModel, store.get());
  }, 200);
});

/* ==========================================================================
   啟動
   ========================================================================== */
async function boot() {
  try {
    const res = await fetch('./rules.json');
    if (res.ok) {
      RULES = await res.json();
      K = { ...K, ...Object.fromEntries((RULES.items || []).filter((i) => i.value != null).map((i) => [i.key, i.value])) };
      $('#dataver').textContent = `資料版本 ${RULES.version}`;
      $('#dataver').title = RULES.note || '';
      const un = (RULES.items || []).filter((i) => i.confidence !== 'verified').length;
      if (un > 0) {
        $('#dataver').insertAdjacentElement('afterend', el('span', {
          class: 'chip chip--unverified',
          title: '有常數未能查到官方原始數值，已在公式抽屜列出，且不參與計算。',
          text: `未查證 ${un} 項`,
        }));
      }
    }
  } catch { $('#dataver').textContent = '資料版本 離線'; }

  syncInputs();
  render({ race: true });

  // 首次進場：讀數逐行推出，讓人感覺數字是被算出來的
  printRows($$('#readouts .readout'), { stagger: 0.06, delay: 0.1 });

  if (store.cameFromLink) toast('已載入別人傳給你的情境');
}

boot();
