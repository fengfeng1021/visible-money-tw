window.addEventListener('error', (e) => { window.__err = String(e.message); });

/* 退休模組 = 勞保年金請領年齡賽跑 ＋ 退休提領存活扇形。
   合併的理由不是版面，是資料流：賽跑算出來的月領金額本來就是扇形的地板，
   原本要靠 sessionStorage 一鍵傳遞，現在是同一頁裡的同一個變數。

   輸入只問一次：出生年次、性別、投保薪資、年資、勞退專戶、退休年齡、
   計畫終齡、退休支出、可投資資產，全部來自 assets/js/core/profile.js。
   缺什麼才在需要它的那一段就地問。 */

import { gsap, EASE, printRows, stampIn, makeCounter, carbonTransfer, still } from '../../assets/js/core/motion.js';
import { Plot, niceTicks, histogram, quantile } from '../../assets/js/core/plot.js';
import { createStore } from '../../assets/js/core/state.js';
import {
  $, $$, el, iconHTML, bindSlider, bindField, bindSegmented,
  mountTopbar, mountTheme, toast, formulaBlock,
} from '../../assets/js/core/ui.js';
import { int, dec, money, pct, pp, ageLabel, parseNum, clamp } from '../../assets/js/core/format.js';
import { blockBootstrap, mean, stdev } from '../../assets/js/core/fin.js';
import * as P from '../../assets/js/core/profile.js';
import { askBox, fieldControl } from '../../assets/js/core/profile-ui.js';

/* ==========================================================================
   1. 法規常數：一律讀 assets/data/*.json，載不進來就拒答，不用寫死的備份值
   ========================================================================== */
let LAW = null;      // assets/data/tw-labor-pension.json
let DATA = null;     // assets/data/tw-returns.json（年度報酬序列與簡易生命表）
let K = null;        // 從 LAW 攤平出來的常數表
const BLOCK = 3;     // 區塊拔靴的區塊長度（年）

/* 模型假設。這些不是法規，也不是查證過的歷史統計，全部標未查證、全部可以在畫面上改掉。
   放在這裡而不是常數檔，是因為它們屬於「這個模擬器怎麼想」，不屬於「法律怎麼規定」。 */
const MODEL = {
  mus: 7, sigs: 18, mub: 2.5, sigb: 6, muc: 1.3, rho: 0.15, infl: 2,
  crashShape: [-0.36, -0.22, 0.05, -0.12, 0.08],
  guardrail: { upper: 1.2, lower: 0.8, cut: 0.1, raise: 0.1 },
};

const ROC_NOW = new Date().getFullYear() - 1911;

/* 沒有檔案時的範例值。只用來讓首屏有結論，不會寫進使用者的檔案。 */
const DEMO = {
  birthYearROC: 55, sex: 'm',
  insuredSalary: 45800, laborYears: 30, laborMonths: 0,
  pensionAccount: 1500000,
  retireAge: 65, planToAge: 90,
  retireSpend: 70000, investable: 12000000,
};
const PROFILE_KEYS = Object.keys(DEMO);
const p = (k) => P.getOr(k, DEMO[k]);
const isDemo = (k) => !P.has(k);

/* 模組自己的旋鈕：不屬於「使用者是誰」，屬於「這一次想試什麼」。 */
const DEFAULTS = () => ({
  tab: 'race',
  claimAge: null,            // null = 跟著法定年齡走
  system: 'legacy',
  salary36: null,            // null = 跟投保薪資同值
  cpiOn: false,
  cpi: 2,
  cut: 100,
  penRetireManual: null,     // null = 由勞退專戶餘額換算
  stock: 55, bond: 30,
  strategy: 'fixed',
  infl: MODEL.infl,
  inflMode: 'fixed',
  crashOn: false,
  crashDepth: -45,
  mode: 'normal',
  pool: 'taiex',
  precise: false,
  mus: MODEL.mus, sigs: MODEL.sigs, mub: MODEL.mub, sigb: MODEL.sigb, muc: MODEL.muc, rho: MODEL.rho,
});
const store = createStore('vm:retire', DEFAULTS());
const S = () => store.get();

const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* ==========================================================================
   2. 版面掛載
   ========================================================================== */
mountTopbar({ title: '退休' });
const actions = $('#sheetActions');
mountShareBoth(actions);
mountTheme(actions);

/** 分享連結要同時帶著「我是誰」（檔案）與「我在試什麼」（這一頁的旋鈕）。 */
function mountShareBoth(host) {
  const btn = el('button', {
    class: 'btn btn--ghost btn--sm', type: 'button',
    html: iconHTML('share') + '<span>複製情境連結</span>',
    onclick: async () => {
      const u = new URL(store.shareUrl());
      const fromProfile = new URL(P.shareUrl(location.href)).searchParams.get('p');
      if (fromProfile) u.searchParams.set('p', fromProfile);
      const url = u.toString();
      try {
        await navigator.clipboard.writeText(url);
        toast('連結已複製，裡面同時帶著你的檔案與這一頁的假設');
      } catch {
        const box = el('input', { class: 'num', value: url, style: 'position:fixed;left:-9999px' });
        document.body.appendChild(box); box.select();
        try { document.execCommand('copy'); toast('連結已複製'); }
        catch { prompt('複製這段網址：', url); }
        box.remove();
      }
    },
  });
  host.appendChild(btn);
}

/* ==========================================================================
   3. 法規查表
   ========================================================================== */
/** tw-labor-pension.json 的 birthYearROC 是「46以前」「47」「51以後」這種人話，這裡翻成區間 */
function parseBirthRange(s) {
  const str = String(s);
  const n = parseNum(str.replace(/[^0-9]/g, ''), NaN);
  if (str.includes('以前')) return { from: -Infinity, to: n, label: `${n} 年次（含）以前` };
  if (str.includes('以後')) return { from: n, to: Infinity, label: `${n} 年次（含）以後` };
  return { from: n, to: n, label: `${n} 年次` };
}

function claimAgeRow(birthROC) {
  const rows = K.claimAges;
  for (const r of rows) if (birthROC >= r.from && birthROC <= r.to) return r;
  return rows[rows.length - 1];
}

/** 月薪 → 投保薪資級距（落在哪一級就以該級上限投保，超過天花板一律天花板） */
function gradeFor(wage) {
  for (const g of K.grades) if (wage <= g) return g;
  return K.grades[K.grades.length - 1];
}

/**
 * 分齡平均餘命。內政部 113 年簡易生命表只有 60／65／70／75／80 歲，
 * 不做內插：年齡不在表上時就明說引用的是哪一列。
 */
function lifeRow(age, sex) {
  const lt = DATA?.lifeTable;
  if (!lt?.ages?.length) return null;
  let i = lt.ages.indexOf(age);
  const exact = i >= 0;
  if (i < 0) {
    // 取最接近的一列，並且說出來
    let best = 0, bd = Infinity;
    lt.ages.forEach((a, k) => { const d = Math.abs(a - age); if (d < bd) { bd = d; best = k; } });
    i = best;
  }
  return {
    age: lt.ages[i],
    years: sex === 'f' ? lt.female[i] : lt.male[i],
    male: lt.male[i], female: lt.female[i],
    exact, vintage: lt.vintage || '簡易生命表',
  };
}

/* ==========================================================================
   4. 勞保核心數學
   A 式 = 平均月投保薪資 × 年資 × 0.775% + 3,000
   B 式 = 平均月投保薪資 × 年資 × 1.55%
   展延／減給：每 1 年 ±4%，最多 5 年
   ========================================================================== */
function baseMonthly(salary, years) {
  const a = salary * years * (K.formulaARatePct / 100) + K.formulaAAddon;
  const b = salary * years * (K.formulaBRatePct / 100);
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
 * 物價調整依勞保條例第 65 條之 4：以請領當年度為基期，累計成長率達 5% 才依該成長率調整，
 * 調整後基期跟著移動。這不是每年按通膨外推，兩者差很多。
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

/** 一次請領老年給付（僅 98 年前已有年資者可選）：前 15 年 1 個月、超過部分 2 個月，有月數上限 */
function legacyLumpMonths(Y) {
  const first = Math.min(Y, 15) * K.legacyMonthsFirst15;
  const rest = Math.max(0, Y - 15) * K.legacyMonthsAfter15;
  return Math.min(first + rest, K.legacyMonthsCap);
}

/**
 * 勞退月退休金：勞工退休金條例第 23 條是「依年金生命表，以平均餘命及利率等基礎計算」。
 * 勞保局用的是勞退年金生命表，本站沒有那張表，這裡用內政部簡易生命表的平均餘命替代，
 * 利率用 assets/data 裡那一筆已公告的年金生命表利率。所以這是估計值，不是核定金額。
 */
function laborPensionMonthly(balance, startAge, sex) {
  if (!(balance > 0)) return { monthly: 0, n: 0, row: null };
  const row = lifeRow(startAge, sex);
  if (!row) return { monthly: 0, n: 0, row: null };
  const n = Math.round(row.years * 12);
  const i = (K.laborPensionRatePct / 100) / 12;
  const monthly = i === 0 ? balance / n : balance * i / (1 - Math.pow(1 + i, -n));
  return { monthly, n, row, i };
}

/* ==========================================================================
   5. 賽跑模型：一組輸入 → 三條曲線 ＋ 交叉點 ＋ 逐格年齡表
   ========================================================================== */
const LINE_KEYS = ['early', 'legal', 'defer'];
const LINE_COLORS = { early: '--series-4', legal: '--series-1', defer: '--series-5' };

function buildRace() {
  const s = S();
  const salary = Math.min(Math.max(0, p('insuredSalary')), K.insuredSalaryMax);
  const Y = Math.max(0, p('laborYears')) + clamp(Math.max(0, p('laborMonths')), 0, 11) / 12;
  const row = claimAgeRow(p('birthYearROC'));
  const legalAge = row.legalAge;
  const earliest = row.earliestAge;
  const life = p('planToAge');
  const cut = clamp(s.cut, 1, 100) / 100;
  const opt = { cpiOn: !!s.cpiOn, cpi: clamp(s.cpi, -5, 20) / 100 };

  const base = baseMonthly(salary, Y);
  const eligible = Y >= K.minInsuredYears;

  const axisStart = earliest;
  const axisEnd = Math.max(95, Math.ceil(life) + 1);
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

  /* 交叉點：兩兩相比，找累積總額互換名次的那一格 */
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
        crossings.push({ x, y: A.data[n].y, winner: (d1 > 0 ? A : B).key, loser: (d1 > 0 ? B : A).key });
      }
    }
  }
  crossings.sort((a, b) => a.x - b.x);

  const totalAt = (line, age) => {
    const k = Math.round((age - line.claimAge) * 12);
    if (k <= 0) return 0;
    return line.cum[Math.min(k, line.cum.length - 1)];
  };

  /* 法定 −5 到 +5 每一格 */
  const table = [];
  for (let d = -K.maxShiftYears; d <= K.maxShiftYears; d++) {
    const age = legalAge + d;
    const monthly = base.best * shiftFactor(age, legalAge) * cut;
    const maxK = Math.max(0, Math.round((Math.ceil(life) + 1 - age) * 12));
    const cum = cumArray(monthly, maxK, opt);
    const k = Math.round((life - age) * 12);
    const total = k <= 0 ? 0 : cum[Math.min(k, cum.length - 1)];
    table.push({ age, d, monthly, total, factor: shiftFactor(age, legalAge) });
  }
  const bestTotal = Math.max(...table.map((r) => r.total));
  table.forEach((r) => { r.gap = r.total - bestTotal; });

  /* 選定的請領年齡：使用者沒選就用法定年齡 */
  const claimAge = clamp(Number.isFinite(s.claimAge) ? s.claimAge : legalAge,
    legalAge - K.maxShiftYears, legalAge + K.maxShiftYears);
  const picked = table.find((r) => r.age === claimAge) || table[K.maxShiftYears];

  /* 一次金 */
  const lumpAnnuity = salary * Y * K.lumpsumMonthsPerYear;
  const salary36 = Math.min(Math.max(0, Number.isFinite(s.salary36) ? s.salary36 : salary), K.insuredSalaryMax);
  const legacyMonths = legacyLumpMonths(Y);
  const lumpLegacy = salary36 * legacyMonths;

  return {
    salary, Y, row, legalAge, earliest, base, eligible, cut, opt, life,
    axisStart, axisEnd, grid, lines, crossings, totalAt, table, bestTotal,
    claimAge, picked, monthlyPicked: eligible ? picked.monthly : 0,
    lumpAnnuity, lumpLegacy, legacyMonths, salary36,
    currentAge: ROC_NOW - p('birthYearROC'),
  };
}

/* ==========================================================================
   6. 招牌視覺一：三條累積曲線的賽跑
   ========================================================================== */
const plot = new Plot($('#chart'), {
  aspect: 0.58,
  minHeight: 240,
  yFormat: (v) => (v >= 10000 ? Math.round(v / 10000) + '萬' : String(Math.round(v))),
  xFormat: (v) => String(Math.round(v)),
  padding: { left: 50, bottom: 28, top: 20, right: 14 },
});
plot.onCursor = null;

const plotHost = $('#plotCard');
const crossTags = [];
for (let i = 0; i < 3; i++) {
  const t = el('div', { class: 'cross-tag', 'aria-hidden': 'true' });
  plotHost.appendChild(t);
  crossTags.push(t);
}
const lifeTag = el('div', { class: 'life-tag', 'aria-hidden': 'true' });
plotHost.appendChild(lifeTag);

const hidden = new Set();
const raceCanvas = $('#chart');

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

/* 終齡游標的字樣改用 DOM 標籤（見 layoutLifeTag），因為 plot.js 的 x 軸標記一律
   把字寫在圖頂，會跟交叉點標籤疊在一起。 */
function marksFor(m) {
  const sex = p('sex');
  const marks = [
    { axis: 'x', value: clamp(m.life, m.axisStart, m.axisEnd), color: cssv('--accent'), dash: [6, 3] },
    { axis: 'x', value: clamp(m.claimAge, m.axisStart, m.axisEnd), color: cssv('--ink-2'), dash: [3, 3] },
  ];
  const lt = DATA?.lifeTable;
  if (lt?.atBirth?.total) {
    marks.push({ axis: 'x', value: lt.atBirth.total, color: cssv('--ink-3'), dash: [2, 3] });
  }
  const r65 = lifeRow(65, sex);
  if (r65) {
    marks.push({ axis: 'x', value: 65 + r65.male, color: cssv('--ink-3'), dash: [1, 4] });
    marks.push({ axis: 'x', value: 65 + r65.female, color: cssv('--ink-3'), dash: [1, 4] });
  }
  if (S().system === 'legacy' && m.eligible && m.lumpLegacy > 0) {
    marks.push({
      axis: 'y', value: m.lumpLegacy, color: cssv('--ink-2'), dash: [8, 4],
      label: `一次請領 ${dec(m.lumpLegacy / 10000, 1)} 萬（領完就不再增加）`,
    });
  }
  return marks;
}

function layoutLifeTag(m) {
  const x = plot.sx(clamp(m.life, m.axisStart, m.axisEnd));
  lifeTag.textContent = `${m.life} 歲`;
  lifeTag.style.left = clamp(x, plot.pad.left + 14, plot.w - 14) + 'px';
  lifeTag.style.top = (raceCanvas.offsetTop + plot.h - plot.pad.bottom - 20) + 'px';
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

function layoutCrossTags(m, revealCount = Infinity) {
  const labels = LABELS(m);
  const canvasTop = raceCanvas.offsetTop;
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

function winnerKey(m) {
  let best = null, bv = -Infinity;
  for (const L of m.lines) {
    const v = m.totalAt(L, m.life);
    if (v > bv) { bv = v; best = L.key; }
  }
  return best;
}

/** 招牌動效：三條線一起向右賽跑，在交叉那一格停一下再打標籤。
    它讓使用者理解的是：誰贏不是一個定論，是一條隨著年齡不斷換手的名次。 */
let raceTl = null;
function runRace(m) {
  raceTl?.kill();
  const domain = domainFor(m);
  const emphasise = winnerKey(m);
  if (still()) {
    paint(seriesFor(m, { emphasise }), marksFor(m), domain);
    layoutCrossTags(m);
    layoutLifeTag(m);
    return;
  }
  crossTags.forEach((t) => { t.style.opacity = '0'; });
  const stops = m.crossings.map((c) => c.x).filter((x) => x <= m.axisEnd);
  const span = m.axisEnd - m.axisStart;
  const TOTAL = 1.7;
  const o = { x: m.axisStart };
  const draw = () => { paint(seriesFor(m, { upto: o.x }), marksFor(m), domain); layoutLifeTag(m); };

  raceTl = gsap.timeline({
    onComplete: () => {
      paint(seriesFor(m, { emphasise }), marksFor(m), domain);
      layoutCrossTags(m);
      layoutLifeTag(m);
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

/** 年齡刻度落在 5 的倍數上，不然會出現 63.4 歲這種讀不出意義的刻度 */
function ageTicks(m) {
  const out = [];
  for (let a = Math.ceil(m.axisStart / 5) * 5; a <= m.axisEnd; a += 5) out.push(a);
  if (out[0] !== m.axisStart) out.unshift(m.axisStart);
  return out;
}

function renderLegend(m) {
  const host = $('#legend');
  host.replaceChildren();
  const labels = LABELS(m);
  for (const key of LINE_KEYS) {
    host.appendChild(el('button', {
      class: 'legend__item', type: 'button',
      'aria-pressed': String(!hidden.has(key)),
      onclick: () => {
        if (hidden.has(key)) hidden.delete(key); else hidden.add(key);
        if (hidden.size === LINE_KEYS.length) hidden.delete(key);
        renderRace();
      },
    }, [
      el('span', { class: 'legend__key', style: `background:${cssv(LINE_COLORS[key])}` }),
      el('span', { text: labels[key] }),
    ]));
  }
}

/* 圖面本身就是終齡游標的拖曳區；滑桿是它的鍵盤等效路徑 */
let dragging = false;
function ageFromPointer(e) {
  const rect = raceCanvas.getBoundingClientRect();
  const age = plot.ix(e.clientX - rect.left);
  return clamp(Math.round(age), 70, 105);
}
raceCanvas.addEventListener('pointerdown', (e) => {
  if (!raceModel || !raceModel.eligible) return;
  dragging = true;
  raceCanvas.setPointerCapture(e.pointerId);
  setPlanToAge(ageFromPointer(e));
});
raceCanvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const v = ageFromPointer(e);
  if (v === p('planToAge')) return;
  setPlanToAge(v);
});
const endDrag = (e) => {
  if (!dragging) return;
  dragging = false;
  try { raceCanvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
};
raceCanvas.addEventListener('pointerup', endDrag);
raceCanvas.addEventListener('pointercancel', endDrag);

function setPlanToAge(v) {
  sLife.set(v, { silent: true });
  P.set({ planToAge: v });
}

/* ==========================================================================
   7. 招牌視覺二：蒙地卡羅資產路徑扇形（模擬跑在 Web Worker）
   沒有建置步驟，所以 worker 用 Blob URL 建。函式先 toString 再包起來，
   這樣它在編輯器裡仍然是真的程式碼，不是一坨字串。
   ========================================================================== */
function workerMain() {
  /* 可重現的偽隨機：同一組情境每次跑出同一張圖，使用者才信得過 */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rand) {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* 大跌形狀等比縮放：Π(1+s_i)^k = 1+D，解出 k，形狀不變、累計跌幅精確命中 */
  function scaleCrash(shape, depth) {
    let ln = 0;
    for (const s of shape) ln += Math.log(1 + s);
    const k = ln === 0 ? 0 : Math.log(1 + depth) / ln;
    return shape.map((s) => Math.pow(1 + s, k) - 1);
  }

  function inflSeq(rand, c, n) {
    const out = new Float64Array(n);
    if (c.cpiPool) {
      const s = blockBootstrap(c.cpiPool, n, c.blockLen, rand);
      for (let t = 0; t < n; t++) out[t] = s[t];
    } else {
      out.fill(c.infl);
    }
    return out;
  }

  /** 第 t 年（退休後第 t 年）的名目年金。兩層各有自己的開始年度：
      勞保從請領年齡開始、勞退從法定可請領月退的年齡開始，不是一退休就兩層都有。 */
  function pensionAt(c, t, infFac) {
    let v = 0;
    if (t >= c.penLaborFrom) v += c.penLabor * 12 * (c.cpiLabor ? infFac : 1);
    if (t >= c.penRetireFrom) v += c.penRetire * 12 * (c.cpiRetire ? infFac : 1);
    return v;
  }

  /**
   * 單一路徑的逐年遞推。
   * 期末餘額 = (期初餘額 − 當年淨提領) × (1 + r_t)
   * 名目支出_t = 月支出 × 12 × Π(1+π_k)，k < t
   * 當年淨提領 = 名目支出_t − 年金_t
   */
  function simPath(seed, c, capture) {
    const rand = mulberry32(seed);
    const n = c.years;
    const real = new Float64Array(n + 1);
    real[0] = c.assets0;
    let bal = c.assets0;
    let ruinYear = -1;
    const rootRho = Math.sqrt(Math.max(0, 1 - c.rho * c.rho));
    const rets = capture ? [] : null;
    const income = capture ? [] : null;

    const w0 = Math.max(0, c.spend0 - pensionAt(c, 0, 1)) / c.assets0;

    let hi = null;
    if (c.boot) hi = blockBootstrap(c.poolIdx, n, c.blockLen, rand);

    const inf = inflSeq(rand, c, n);
    let cum = 1;

    for (let t = 0; t < n; t++) {
      const infFac = cum;
      const nominalSpend = c.spend0 * infFac;
      const pen = pensionAt(c, t, infFac);
      let draw = Math.max(0, nominalSpend - pen);

      if (c.strategy === 'guardrail' && t > 0 && bal > 0 && w0 > 0) {
        const wr = draw / bal;
        if (wr > w0 * c.guardUp) draw *= (1 - c.guardCut);
        else if (wr < w0 * c.guardLo) draw *= (1 + c.guardRaise);
      }

      let rs, rb;
      if (c.boot) {
        const k = hi[t];
        rs = c.stockPool[k];
        rb = c.bondPool[k];
      } else {
        const z1 = gauss(rand), z2 = gauss(rand);
        rs = c.mus + c.sigs * z1;
        rb = c.mub + c.sigb * (c.rho * z1 + rootRho * z2);
      }
      if (c.crashR && t < c.crashR.length) {
        rs = c.crashR[t];
        if (c.crashB) rb = c.crashB[t];
      }
      const r = c.ws * rs + c.wb * rb + c.wc * c.muc;
      if (rets) rets.push(r);

      const afterDraw = bal - draw;
      if (income) {
        income.push({
          age: c.ageRetire + t,
          pension: pen / infFac,
          withdraw: Math.min(draw, Math.max(0, bal)) / infFac,
        });
      }
      cum *= (1 + inf[t]);
      if (afterDraw <= 0) {
        ruinYear = t;
        for (let k = t + 1; k <= n; k++) real[k] = 0;
        bal = 0;
        break;
      }
      bal = afterDraw * (1 + r);
      if (bal < 0) bal = 0;
      real[t + 1] = bal / cum;
      if (bal === 0) { ruinYear = t; for (let k = t + 2; k <= n; k++) real[k] = 0; break; }
    }
    return { real, ruinYear, rets, income, inf: capture ? Array.from(inf) : null };
  }

  /** 用一組給定的報酬序列走一次（順序風險對照：同一組報酬與通膨，只有順序不同） */
  function walk(rets, inf, c) {
    const n = c.years;
    const out = new Float64Array(n + 1);
    out[0] = c.assets0;
    let bal = c.assets0;
    const w0 = Math.max(0, c.spend0 - pensionAt(c, 0, 1)) / c.assets0;
    let cum = 1;
    for (let t = 0; t < n; t++) {
      const infFac = cum;
      const pen = pensionAt(c, t, infFac);
      let draw = Math.max(0, c.spend0 * infFac - pen);
      if (c.strategy === 'guardrail' && t > 0 && bal > 0 && w0 > 0) {
        const wr = draw / bal;
        if (wr > w0 * c.guardUp) draw *= (1 - c.guardCut);
        else if (wr < w0 * c.guardLo) draw *= (1 + c.guardRaise);
      }
      cum *= (1 + inf[t]);
      const afterDraw = bal - draw;
      if (afterDraw <= 0) { for (let k = t + 1; k <= n; k++) out[k] = 0; return out; }
      bal = afterDraw * (1 + rets[t]);
      if (bal < 0) bal = 0;
      out[t + 1] = bal / cum;
    }
    return out;
  }

  function sortedAt(matrix, paths, n, y) {
    const col = new Float64Array(paths);
    for (let q2 = 0; q2 < paths; q2++) col[q2] = matrix[q2 * (n + 1) + y];
    return col.sort();
  }
  function q(sorted, pr) {
    const pos = (sorted.length - 1) * pr;
    const lo = Math.floor(pos), hi2 = Math.ceil(pos);
    return lo === hi2 ? sorted[lo] : sorted[lo] + (sorted[hi2] - sorted[lo]) * (pos - lo);
  }

  self.onmessage = (ev) => {
    const { runId, cfg } = ev.data;
    const c = { ...cfg };
    if (c.crashOn) {
      if (c.crashHist) { c.crashR = c.crashHist.stock; c.crashB = c.crashHist.bond; }
      else c.crashR = scaleCrash(c.crashShape, c.crashDepth);
    }
    const n = c.years, paths = c.paths;
    const matrix = new Float64Array(paths * (n + 1));
    const ruinYears = new Int16Array(paths);
    const finals = new Float64Array(paths);
    let success = 0;

    const CHUNK = 100;
    for (let pi = 0; pi < paths; pi++) {
      const r = simPath(c.seed + pi * 7919, c, false);
      matrix.set(r.real, pi * (n + 1));
      ruinYears[pi] = r.ruinYear;
      finals[pi] = r.real[n];
      if (r.real[n] > 0) success++;
      if ((pi + 1) % CHUNK === 0 || pi === paths - 1) {
        self.postMessage({ type: 'tick', runId, done: pi + 1, total: paths, success });
      }
    }

    const bands = [];
    for (let y = 0; y <= n; y++) {
      const s = sortedAt(matrix, paths, n, y);
      bands.push({
        age: c.ageRetire + y,
        p10: q(s, 0.10), p25: q(s, 0.25), p50: q(s, 0.50), p75: q(s, 0.75), p90: q(s, 0.90),
      });
    }

    const order = Array.from({ length: paths }, (_, i) => i).sort((a, b) => finals[a] - finals[b]);
    const pick = (idxs, k) => {
      if (!k) return [];
      const step = Math.max(1, Math.floor(idxs.length / k));
      const out = [];
      for (let i = 0; i < idxs.length && out.length < k; i += step) {
        const pp2 = idxs[i];
        out.push({ v: Array.from(matrix.subarray(pp2 * (n + 1), pp2 * (n + 1) + n + 1)), ruinYear: ruinYears[pp2] });
      }
      return out;
    };
    const allIdx = Array.from({ length: paths }, (_, i) => i);
    const worstIdx = order.slice(0, Math.max(1, Math.round(paths * 0.1)));
    const keepPaths = pick(allIdx, c.keep);
    const worstPaths = pick(worstIdx, c.keep);

    const medIdx = order[Math.floor(paths / 2)];
    const med = simPath(c.seed + medIdx * 7919, c, true);
    const rev = med.rets.slice().reverse();

    const ruinAges = [];
    for (let pi = 0; pi < paths; pi++) if (ruinYears[pi] >= 0) ruinAges.push(c.ageRetire + ruinYears[pi]);

    const worstFinals = worstIdx.map((i) => finals[i]);
    const worstMean = worstFinals.reduce((a, b) => a + b, 0) / worstFinals.length;

    self.postMessage({
      type: 'done', runId,
      n, ageRetire: c.ageRetire,
      paths, success,
      successRate: success / paths,
      bands, keepPaths, worstPaths, ruinAges,
      worstMean,
      medianReturns: med.rets,
      income: med.income,
      seqOrig: Array.from(walk(med.rets, med.inf, c)),
      seqRev: Array.from(walk(rev, med.inf, c)),
      firstDraw: Math.max(0, c.spend0 - (c.penLaborFrom === 0 ? c.penLabor * 12 : 0) - (c.penRetireFrom === 0 ? c.penRetire * 12 : 0)),
    });
  };
}

const workerUrl = URL.createObjectURL(
  new Blob([
    // 區塊拔靴用的是 core/fin.js 的那一份實作，原封不動注入，不在這裡重寫一次
    'const blockBootstrap = ' + blockBootstrap.toString() + ';\n',
    '(' + workerMain.toString() + ')()',
  ], { type: 'text/javascript' })
);
const worker = new Worker(workerUrl);
worker.onerror = (e) => {
  window.__err = 'worker: ' + e.message;
  $('#fanProgress').hidden = true;
  toast('模擬引擎出錯了，請重新整理這一頁');
};

/** 資產路徑扇形。路徑向右生長 → 不確定性從一個詞變成一個會分岔、會有幾條掉下去的形狀。
    歸零的路徑變紅落到地面堆積，那座小丘就是破產年齡分佈本身。 */
class Fan {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.data = null;
    this.prev = null;
    this.t = 1;
    this.u = 1;
    this.dpr = 1;
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement || canvas);
    this._onTheme = () => this.draw();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', this._onTheme);
    this.resize();
  }

  resize() {
    const host = this.c.parentElement;
    const w = Math.max(240, host.clientWidth);
    const h = Math.round(Math.min(420, Math.max(220, w * 0.62)));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.c.style.width = '100%';
    this.c.style.height = h + 'px';
    this.c.width = Math.round(w * this.dpr);
    this.c.height = Math.round(h * this.dpr);
    this.w = w; this.h = h;
    this.pad = { top: 14, right: w < 420 ? 10 : 16, bottom: 40, left: w < 420 ? 44 : 56 };
    this.ground = 16;
    this.draw();
  }

  setData(d, { animate = 'morph' } = {}) {
    this.prev = this.data && this.data.n === d.n ? this.data : null;
    this.data = d;
    this.maxY = Math.max(d.bands.reduce((m, b) => Math.max(m, b.p90), 0), d.assets0) * 1.08 || 1;
    gsap.killTweensOf(this);
    if (still() || animate === 'none') { this.t = 1; this.u = 1; this.draw(); return; }
    if (animate === 'grow' || !this.prev) {
      this.t = 0; this.u = 1;
      gsap.to(this, { t: 1, duration: 1.35, ease: EASE, onUpdate: () => this.draw() });
    } else {
      // 形變：路徑一一對應（同一組亂數種子），所以整把扇子是「塌陷」不是「重畫」
      this.t = 1; this.u = 0;
      gsap.to(this, { u: 1, duration: 0.6, ease: 'power2.inOut', onUpdate: () => this.draw() });
    }
  }

  sx(age) {
    const d = this.data;
    const x0 = d.ageRetire, x1 = d.ageRetire + d.n;
    return this.pad.left + ((age - x0) / Math.max(1, x1 - x0)) * (this.w - this.pad.left - this.pad.right);
  }
  sy(v) {
    const B = this.h - this.pad.bottom - this.ground;
    return B - (v / this.maxY) * (B - this.pad.top);
  }
  _mix(now, before) {
    if (this.u >= 1 || before == null) return now;
    return before + (now - before) * this.u;
  }

  draw() {
    const d = this.data;
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (!d) return;

    const L = this.pad.left, R = this.w - this.pad.right;
    const T = this.pad.top, B = this.h - this.pad.bottom - this.ground;
    const narrow = this.w < 420;

    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = cssv('--rule-faint') || '#E0E0D8';
    ctx.fillStyle = cssv('--ink-3') || '#5F656C';
    ctx.font = `500 10px ${cssv('--font-mono') || 'monospace'}`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of niceTicks(0, this.maxY, 4)) {
      const y = Math.round(this.sy(v)) + 0.5;
      if (y < T - 1 || y > B + 1) continue;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke();
      ctx.fillText(v >= 1e8 ? (v / 1e8).toFixed(1) + '億' : Math.round(v / 1e4) + '萬', L - 6, y);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const stepAge = d.n > 30 ? 10 : 5;
    for (let a = d.ageRetire; a <= d.ageRetire + d.n; a += stepAge) {
      const x = Math.round(this.sx(a)) + 0.5;
      ctx.strokeStyle = cssv('--rule-faint') || '#E0E0D8';
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, B); ctx.stroke();
      ctx.fillText(a + '歲', x, B + this.ground + 6);
    }
    ctx.strokeStyle = cssv('--rule') || '#C6C6BE';
    ctx.beginPath();
    ctx.moveTo(L + 0.5, T); ctx.lineTo(L + 0.5, B + 0.5); ctx.lineTo(R, B + 0.5);
    ctx.stroke();
    ctx.restore();

    const curYear = this.t * d.n;

    /* 百分位帶 */
    const bandTop = Math.min(d.n, Math.ceil(curYear));
    for (const [lo, hi, alpha] of [['p10', 'p90', 0.10], ['p25', 'p75', 0.20]]) {
      ctx.beginPath();
      let started = false;
      for (let y = 0; y <= bandTop; y++) {
        const b = d.bands[y], pb = this.prev?.bands[y];
        const x = this.sx(b.age), yy = this.sy(this._mix(b[hi], pb?.[hi]));
        started ? ctx.lineTo(x, yy) : (ctx.moveTo(x, yy), started = true);
      }
      for (let y = bandTop; y >= 0; y--) {
        const b = d.bands[y], pb = this.prev?.bands[y];
        ctx.lineTo(this.sx(b.age), this.sy(this._mix(b[lo], pb?.[lo])));
      }
      ctx.closePath();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = cssv('--accent') || '#123A72';
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    /* 個別路徑：成功的細灰線，歸零的變紅並墜到地面 */
    const paths = d.paths || [];
    const groundY = B + this.ground - 3;
    ctx.lineWidth = narrow ? 0.9 : 1.1;
    ctx.lineJoin = 'round';
    for (let i = 0; i < paths.length; i++) {
      const pth = paths[i];
      const prv = this.prev?.paths?.[i];
      const ruin = pth.ruinYear;
      const upto = Math.min(d.n, Math.floor(curYear));
      ctx.beginPath();
      let dead = -1;
      for (let y = 0; y <= upto; y++) {
        const v = this._mix(pth.v[y], prv?.v[y]);
        if (v <= 0 && dead < 0) { dead = y; break; }
        const x = this.sx(d.ageRetire + y), yy = this.sy(v);
        y === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
      }
      ctx.globalAlpha = narrow ? 0.20 : 0.16;
      ctx.strokeStyle = cssv('--ink-3') || '#5F656C';
      ctx.stroke();

      if (dead > 0 && ruin >= 0) {
        const lastV = this._mix(pth.v[dead - 1], prv?.v[dead - 1]);
        ctx.beginPath();
        ctx.moveTo(this.sx(d.ageRetire + dead - 1), this.sy(Math.max(0, lastV)));
        ctx.lineTo(this.sx(d.ageRetire + dead - 1 + 0.35), groundY);
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = cssv('--up') || '#B4232C';
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    /* 中位線 */
    ctx.beginPath();
    for (let y = 0; y <= Math.min(d.n, Math.ceil(curYear)); y++) {
      const b = d.bands[y], pb = this.prev?.bands[y];
      const x = this.sx(b.age), yy = this.sy(this._mix(b.p50, pb?.p50));
      y === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
    }
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = cssv('--accent') || '#123A72';
    ctx.stroke();

    /* 地面與堆積：丘越高，代表越多條人生在那個年齡花光 */
    ctx.save();
    ctx.strokeStyle = cssv('--rule-strong') || '#9B9B92';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L, B + 0.5); ctx.lineTo(R, B + 0.5);
    ctx.stroke();
    const pile = d.pile || [];
    const maxPile = Math.max(1, ...pile);
    ctx.fillStyle = cssv('--up') || '#B4232C';
    ctx.globalAlpha = this.u;
    const bw = Math.max(2, (R - L) / Math.max(1, d.n) * 0.7);
    for (let y = 0; y <= d.n; y++) {
      if (!pile[y] || y > curYear) continue;
      const hgt = (pile[y] / maxPile) * (this.ground - 4);
      ctx.fillRect(Math.round(this.sx(d.ageRetire + y) - bw / 2), Math.round(B + this.ground - 3 - hgt),
        Math.round(bw), Math.max(1, Math.round(hgt)));
    }
    ctx.restore();
  }
}

const fan = new Fan($('#fan'));

/* 成功率環 */
const ringCtx = $('#ring').getContext('2d');
let ringValue = 0;
function drawRing(v) {
  ringValue = v;
  const ctx = ringCtx, r = 50, cx = 64, cy = 64;
  ctx.clearRect(0, 0, 128, 128);
  ctx.lineWidth = 12;
  ctx.strokeStyle = cssv('--rule-faint') || '#E0E0D8';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  if (v > 0) {
    ctx.strokeStyle = cssv('--accent') || '#123A72';
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(v, 0, 1));
    ctx.stroke();
  }
}
const ringNum = makeCounter($('#ringNum'), (v) => Math.round(v / 5) * 5 + '%');
function setRing(v, { animate = true } = {}) {
  ringNum(v * 100);
  if (still() || !animate) { drawRing(v); return; }
  const o = { v: ringValue };
  gsap.killTweensOf(o);
  gsap.to(o, { v, duration: 0.5, ease: EASE, onUpdate: () => drawRing(o.v) });
}
drawRing(0);

/* 次要圖表 */
const plotRuin = new Plot($('#chartRuin'), {
  aspect: 0.34, minHeight: 150,
  yFormat: (v) => String(Math.round(v)),
  xFormat: (v) => Math.round(v) + '歲',
  padding: { left: 44, bottom: 28, top: 12, right: 14 },
});
const plotSeq = new Plot($('#chartSeq'), {
  aspect: 0.38, minHeight: 170,
  yFormat: (v) => (v >= 1e8 ? (v / 1e8).toFixed(1) + '億' : Math.round(v / 1e4) + '萬'),
  xFormat: (v) => Math.round(v) + '歲',
  padding: { left: 50, bottom: 28, top: 12, right: 14 },
});
const plotIncome = new Plot($('#chartIncome'), {
  aspect: 0.34, minHeight: 150,
  yFormat: (v) => (v >= 1e4 ? Math.round(v / 1e4) + '萬' : String(Math.round(v))),
  xFormat: (v) => Math.round(v) + '歲',
  padding: { left: 50, bottom: 28, top: 12, right: 14 },
});

function legendHTML(host, items) {
  host.replaceChildren();
  for (const it of items) {
    host.appendChild(el('span', { class: 'legend__item' }, [
      el('span', { class: 'legend__key' + (it.band ? ' legend__key--band' : ''), style: `background:${it.color}` }),
      el('span', { text: it.label }),
    ]));
  }
}

/* ==========================================================================
   8. 抽樣池
   ========================================================================== */
const POOL_META = {
  taiex: { seriesKey: 'taiexTotalReturn', short: '台股', label: '臺灣發行量加權股價報酬指數（含息）' },
  sp500: { seriesKey: 'sp500TotalReturn', short: 'S&P 500', label: 'S&P 500 含息年度報酬' },
};

function buildPool(poolKey) {
  const meta = POOL_META[poolKey] || POOL_META.taiex;
  const s = DATA?.series?.[meta.seriesKey];
  const b = DATA?.series?.ust10yTotalReturn;
  if (!s?.values?.length || !b?.values?.length) return null;
  const off = s.startYear - b.startYear;
  if (off < 0 || off + s.values.length > b.values.length) return null;
  return {
    key: poolKey, meta,
    startYear: s.startYear, endYear: s.endYear, n: s.values.length,
    raw: s.values,
    caveat: s.caveat || '',
    source: s.source || '',
    stock: s.values.map((v) => v / 100),
    bond: b.values.slice(off, off + s.values.length).map((v) => v / 100),
    bondLabel: b.label,
  };
}
const currentPool = () => (DATA ? buildPool(S().pool) : null);
const cpiPool = () => {
  const c = DATA?.series?.twCPI;
  return c?.values?.length ? c : null;
};

/** 這個池子裡實際最差的連續 len 年（以累計報酬最低者為準） */
function worstWindow(values, len = 5) {
  if (!values || values.length < len) return null;
  let bi = -1, bc = Infinity;
  for (let i = 0; i + len <= values.length; i++) {
    let c = 1;
    for (let k = 0; k < len; k++) c *= 1 + values[i + k];
    if (c < bc) { bc = c; bi = i; }
  }
  return bi < 0 ? null : { i: bi, cum: bc, len };
}

function cagr(pct01) {
  let prod = 1;
  for (const r of pct01) prod *= 1 + r;
  return { total: prod, annual: Math.pow(prod, 1 / pct01.length) - 1 };
}

/* ==========================================================================
   9. 地板：賽跑的月領金額直接流進來，勞退由專戶餘額換算
   ========================================================================== */
function floorOf(m) {
  const s = S();
  const retireAge = p('retireAge');
  const sex = p('sex');
  const penLabor = m.eligible ? m.monthlyPicked : 0;

  // 勞退月退休金依法年滿 60 歲且年資滿 15 年才可請領，所以它的起算年齡不會早於 60
  const penRetireAge = Math.max(retireAge, 60);
  const auto = laborPensionMonthly(p('pensionAccount'), penRetireAge, sex);
  const manual = Number.isFinite(s.penRetireManual) ? s.penRetireManual : null;
  const penRetire = manual != null ? manual : auto.monthly;

  return {
    penLabor, penRetire, auto, manual, penRetireAge,
    claimAge: m.claimAge,
    penLaborFrom: Math.max(0, m.claimAge - retireAge),
    penRetireFrom: Math.max(0, penRetireAge - retireAge),
    total: penLabor + penRetire,
  };
}

/* ==========================================================================
   10. 輸入元件
   ========================================================================== */
let raceModel = null;
let lastSim = null;
let simTimer = 0;

function scheduleSim(delay = 140) {
  clearTimeout(simTimer);
  simTimer = setTimeout(() => runSim(), delay);
}

/* --- 模組層級的共用旋鈕 --- */
const sLife = bindSlider($('#s-life'), {
  format: (v) => `${v}<small>歲</small>`,
  onInput: (v) => { P.set({ planToAge: v }); },
});

/* --- 第一段 --- */
const sClaim = bindSlider($('#s-claim'), {
  format: (v) => `${v}<small>歲</small>`,
  onInput: (v) => { store.set({ claimAge: v }); renderAll(); scheduleSim(); },
});

const segSystem = bindSegmented($('#seg-system'), { onChange: (v) => { store.set({ system: v }); renderRace(); renderRaceFormula(); } });
const segCut = bindSegmented($('#seg-cut'), { onChange: (v) => { store.set({ cut: Number(v) }); renderAll(); scheduleSim(); } });
const fSalary36 = bindField($('#f-salary36'), {
  pretty: int,
  onChange: (v) => { if (Number.isFinite(v) && v > 0) { store.set({ salary36: v }); renderRace(); } },
});
const fCpi = bindField($('#f-cpi'), {
  validate: (v) => (Number.isFinite(v) && v >= -5 && v <= 20 ? null : '請填 -5 到 20 之間'),
  onChange: (v, { valid }) => { if (valid) { store.set({ cpi: v }); renderAll(); scheduleSim(); } },
});
$('#sw-cpi').querySelector('input').addEventListener('change', (e) => {
  store.set({ cpiOn: e.target.checked });
  renderAll(); scheduleSim();
});
$('#raceBtn').addEventListener('click', () => {
  if (!raceModel?.eligible) { toast('年資未滿 15 年，沒有月領曲線可以賽跑'); return; }
  runRace(raceModel);
});
$('#raceReset').addEventListener('click', () => {
  const d = DEFAULTS();
  store.set({
    claimAge: null, system: d.system, salary36: null, cpiOn: d.cpiOn, cpi: d.cpi, cut: d.cut,
  });
  syncInputs(); renderAll(); scheduleSim(0);
  toast('這一段的假設回到預設值，你的檔案沒有被動到');
});
$('#raceInputs').addEventListener('submit', (e) => e.preventDefault());

/* --- 第二段 --- */
const sAgeRetire = bindSlider($('#s-ageRetire'), {
  format: (v) => `${v}<small>歲</small>`,
  onInput: (v) => { P.set({ retireAge: v }); },
});
const sStock = bindSlider($('#s-stock'), {
  format: (v) => `${v}<small>%</small>`,
  onInput: (v) => {
    let bond = S().bond;
    if (v + bond > 100) { bond = 100 - v; sBond.set(bond, { silent: true }); }
    store.set({ stock: v, bond });
    paintAlloc(); scheduleSim();
  },
});
const sBond = bindSlider($('#s-bond'), {
  format: (v) => `${v}<small>%</small>`,
  onInput: (v) => {
    let stock = S().stock;
    if (v + stock > 100) { stock = 100 - v; sStock.set(stock, { silent: true }); }
    store.set({ stock, bond: v });
    paintAlloc(); scheduleSim();
  },
});
const sInfl = bindSlider($('#s-infl'), {
  format: (v) => `${dec(v, 1)}<small>%</small>`,
  onInput: (v) => { store.set({ infl: v }); paintInflHint(); scheduleSim(); },
});
const sCrash = bindSlider($('#s-crash'), {
  format: (v) => `跌 ${Math.abs(v)}<small>%</small>`,
  onInput: (v) => { store.set({ crashDepth: v }); scheduleSim(); },
});
const segStrategy = bindSegmented($('#seg-strategy'), {
  onChange: (v) => { store.set({ strategy: v }); paintStrategyHint(); scheduleSim(); },
});
const segMode = bindSegmented($('#seg-mode'), {
  onChange: (v) => { store.set({ mode: v }); paintAlloc(); scheduleSim(0); },
});
const segPool = bindSegmented($('#seg-pool'), {
  onChange: (v) => { store.set({ pool: v }); paintAlloc(); scheduleSim(0); },
});
const segInfl = bindSegmented($('#seg-infl'), {
  onChange: (v) => { store.set({ inflMode: v }); paintInflHint(); scheduleSim(0); },
});
const fPenRetire = bindField($('#f-pRetire'), {
  pretty: int,
  onChange: (v, { raw }) => {
    const empty = String(raw).trim() === '';
    store.set({ penRetireManual: empty ? null : (Number.isFinite(v) && v >= 0 ? v : null) });
    renderAll(); scheduleSim();
  },
});
$('#crashOn').addEventListener('change', (e) => {
  store.set({ crashOn: e.target.checked });
  $('.crash-set').dataset.on = String(e.target.checked);
  scheduleSim(0);
});
$('#preciseOn').addEventListener('change', (e) => { store.set({ precise: e.target.checked }); scheduleSim(0); });
$('#cpiLabor').addEventListener('change', (e) => { store.set({ cpiLabor: e.target.checked }); scheduleSim(); });
$('#cpiRetire').addEventListener('change', (e) => { store.set({ cpiRetire: e.target.checked }); scheduleSim(); });
$('#backToNormal').addEventListener('click', () => { segMode.set('normal'); store.set({ mode: 'normal' }); paintMode(); scheduleSim(0); });
$('#fanReset').addEventListener('click', () => {
  const d = DEFAULTS();
  store.set({
    penRetireManual: null, stock: d.stock, bond: d.bond, strategy: d.strategy,
    infl: d.infl, inflMode: d.inflMode, crashOn: d.crashOn, crashDepth: d.crashDepth,
    mode: d.mode, pool: d.pool, precise: d.precise,
    mus: d.mus, sigs: d.sigs, mub: d.mub, sigb: d.sigb, muc: d.muc, rho: d.rho,
  });
  syncInputs(); renderAll(); scheduleSim(0);
  toast('這一段的假設回到預設值，你的檔案沒有被動到');
});
$('#fanInputs').addEventListener('submit', (e) => e.preventDefault());

let worstOnly = false;
$('#worstBtn').addEventListener('click', (e) => {
  worstOnly = !worstOnly;
  e.currentTarget.setAttribute('aria-pressed', String(worstOnly));
  e.currentTarget.textContent = worstOnly ? '看回全部路徑' : '只看最差 10%';
  if (lastSim) paintFan(lastSim, 'grow');
});
$('#playBtn').addEventListener('click', () => { if (lastSim) paintFan(lastSim, 'grow'); });

/* --- 分頁 --- */
const TABS = [
  ['race', $('#tab-race'), $('#panel-race')],
  ['fan', $('#tab-fan'), $('#panel-fan')],
];
let fanSeen = false;
function selectTab(name, { focus = false } = {}) {
  store.set({ tab: name });
  for (const [n, btn, panel] of TABS) {
    const on = n === name;
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
    panel.hidden = !on;
  }
  requestAnimationFrame(() => {
    if (name === 'race') {
      plot.resize();
      if (raceModel) { layoutCrossTags(raceModel); layoutLifeTag(raceModel); }
    } else {
      fan.resize(); plotRuin.resize(); plotSeq.resize(); plotIncome.resize();
      // 扇形的生長動效是這一段的招牌，第一次被看見時才播，不要在分頁藏著時浪費掉
      if (lastSim && !fanSeen) { fanSeen = true; paintFan(lastSim, 'grow'); }
    }
    if (focus) $(`#panel-${name}`).focus();
  });
}
TABS.forEach(([name, btn]) => {
  btn.addEventListener('click', () => selectTab(name));
  btn.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const other = TABS.find(([n]) => n !== name);
    other[1].focus();
    selectTab(other[0]);
  });
});

/* ==========================================================================
   11. 缺什麼問什麼：askBox 問缺的，details 讓填過的可以改，但不再問一次
   ========================================================================== */
function askAndEdit(host, keys, { title }) {
  host.replaceChildren();
  const ask = askBox(keys, { title, compact: true, onReady: () => {} });
  host.appendChild(ask.el);
  const det = el('details', { class: 'filled' });
  host.appendChild(det);

  let sig = null;
  function build(done) {
    const wasOpen = det.open;
    det.replaceChildren(
      el('summary', {}, [
        el('span', { text: `已填 ${done.length} 格` }),
        el('span', { class: 'filled__vals', text: done.map((k) => P.display(k)).join('　') }),
        el('span', { text: '改' }),
      ]),
      el('div', { class: 'filled__body askbox__grid' },
        done.map((k) => fieldControl(k, { compact: true }))),
    );
    det.open = wasOpen;
  }
  function refresh() {
    ask.refresh();
    const done = keys.filter((k) => P.has(k));
    det.hidden = !done.length;
    const s = done.join(',') + '|' + done.map((k) => P.display(k)).join(',');
    if (s !== sig) { sig = s; build(done); }
  }
  refresh();
  return { refresh };
}

let asks = [];
function mountAsks() {
  asks = [
    askAndEdit($('#askModule'), ['birthYearROC', 'sex'], {
      title: '這兩格兩段都要用：它們決定你的法定請領年齡與平均餘命',
    }),
    askAndEdit($('#askRace'), ['insuredSalary', 'laborYears', 'laborMonths'], {
      title: '勞保這一段還缺這幾格',
    }),
    askAndEdit($('#askFan'), ['investable', 'retireSpend'], {
      title: '退休模擬還缺這兩格',
    }),
    askAndEdit($('#askAccount'), ['pensionAccount'], {
      title: '填了勞退專戶餘額，勞退那一層才算得出來',
    }),
  ];
}
const refreshAsks = () => asks.forEach((a) => a.refresh());

/* ==========================================================================
   12. 讀數與結論
   ========================================================================== */
const cClaim = makeCounter($('#r-claim'), (v) => `${Math.round(v)}<small>歲</small>`, { html: true });
const cLabor = makeCounter($('#r-labor'), (v) => money(Math.round(v)));
const cFloor = makeCounter($('#r-floor'), (v) => money(Math.round(v)));
const cSuccess = makeCounter($('#r-success'), (v) => `${Math.round(v / 5) * 5}<small>%</small>`, { html: true });
const cWr = makeCounter($('#r-wr'), (v) => dec(v, 2) + '<small>%</small>', { html: true });
const cWorst = makeCounter($('#r-worst'), (v) => (v <= 0 ? '0' : dec(v / 1e4, 0)) + '<small>萬</small>', { html: true });
const cGap = makeCounter($('#r-gap'), (v) => money(Math.round(v)));

let stampedFor = null;
function setStamp(text, kind, key) {
  const stampEl = $('#verdictStamp');
  stampEl.hidden = false;
  if (stampedFor === key) return;
  stampedFor = key;
  stampEl.innerHTML = `<span class="stamp${kind ? ' stamp--' + kind : ''}">${text}</span>`;
  stampIn(stampEl.firstElementChild);
}

/** 組合實質報酬：(1+μ)/(1+π) − 1。用在邊界情況的說明，不用在模擬本身。 */
function realRate() {
  const s = S();
  const cash = 100 - s.stock - s.bond;
  const ws = s.stock / 100, wb = s.bond / 100, wc = cash / 100;
  const pool = s.mode === 'bootstrap' ? currentPool() : null;
  const mu = pool
    ? mean(pool.stock.map((rs, i) => ws * rs + wb * pool.bond[i])) + wc * s.muc / 100
    : (s.stock * s.mus + s.bond * s.mub + cash * s.muc) / 10000;
  const cpi = s.inflMode === 'cpi' ? cpiPool() : null;
  const pi = cpi ? mean(cpi.values) / 100 : s.infl / 100;
  return (1 + mu) / (1 + pi) - 1;
}
function presentValueFactor(r, n) {
  if (Math.abs(r) < 1e-9) return n;
  return (1 - Math.pow(1 + r, -n)) / r * (1 + r);
}

function renderHeadline() {
  const m = raceModel;
  const f = floorOf(m);
  const life = m.life;
  const sim = lastSim;
  const rounded = sim ? Math.round(sim.successRate * 20) * 5 : null;

  cClaim(m.claimAge);
  cLabor(f.penLabor);
  cFloor(f.total);
  $('#lb-claim').textContent = m.eligible ? '你打算開始領的年齡' : '可請領一次金的年齡';
  $('#lb-live').textContent = `撐到 ${life} 歲的機率`;
  $('#r-claimd').textContent = m.eligible
    ? (m.claimAge === m.legalAge ? '法定年齡' : pp((m.picked.factor - 1) * 100, 0, { sign: true }))
    : '年資未滿 15 年';
  $('#r-labord').textContent = m.eligible ? `${m.base.which} 式擇優` : '無月退';
  $('#r-floord').textContent = f.penRetire > 0
    ? `含勞退 ${int(Math.round(f.penRetire))} 元`
    : '勞退那一層還沒填';

  if (sim) {
    cSuccess(sim.successRate * 100);
    const se = Math.sqrt(Math.max(1e-9, sim.successRate * (1 - sim.successRate) / sim.paths));
    $('#r-err').textContent = `${sim.paths} 次模擬，95% 誤差 ${dec(1.96 * se * 100, 1)} 個百分點`;
  }

  const h = $('#verdict-h');
  const body = $('#verdictBody');
  const labels = LABELS(m);
  const win = winnerKey(m);
  const spend = p('retireSpend');

  if (!m.eligible) {
    h.innerHTML = `勞保年資 <em>${dec(m.Y, 2)}</em> 年，未滿 ${K.minInsuredYears} 年，依法沒有月退可以領。`
      + (rounded != null ? `沒有這層地板，這筆錢撐到 ${life} 歲的機率是 <em>${rounded}%</em>。` : '');
    body.textContent = '第一段不會給你一個不存在的月領金額，它換成老年一次金；'
      + '第二段的地板因此只剩勞退那一層，缺口全部由投資部位承擔，這就是年資未滿 15 年真正的代價。';
    setStamp('不適用年金', 'void', 'refuse');
    return;
  }

  const totals = m.lines.map((L) => ({ key: L.key, v: m.totalAt(L, life) })).sort((a, b) => b.v - a.v);
  const gap = totals[0].v - totals[1].v;
  const bestRow = m.table.find((r) => r.total === m.bestTotal);

  h.innerHTML = `你打算 <em>${m.claimAge}</em> 歲開始領，月領 <em>${int(Math.round(f.penLabor))}</em> 元；`
    + (rounded != null
      ? `把它當地板，這筆錢撐到 <em>${life}</em> 歲的機率大約 <em>${rounded}%</em>。`
      : '正在跑第二段的模擬…');

  const parts = [];
  parts.push(`活到 ${life} 歲的話，${labels[win].split('（')[0]}領最多，比第二名多 ${int(Math.round(gap))} 元。`);
  if (bestRow && bestRow.age !== m.claimAge) {
    parts.push(`你現在選的是 ${m.claimAge} 歲；改成 ${bestRow.age} 歲開始領，到 ${life} 歲為止可以多領 ${int(Math.round(m.bestTotal - m.picked.total))} 元。`);
  } else {
    parts.push(`在你設定的終齡下，${m.claimAge} 歲就是總額最高的那一格。`);
  }
  if (f.total >= spend && spend > 0) {
    parts.push(`每月地板 ${int(Math.round(f.total))} 元已經蓋過每月支出 ${int(spend)} 元，投資部位不必負擔生活費，`
      + `但勞退那一層不隨物價調整，這個結餘會逐年變薄。`);
  } else {
    parts.push(`每月支出 ${int(spend)} 元裡，地板負擔 ${int(Math.round(f.total))} 元，剩下 ${int(Math.round(Math.max(0, spend - f.total)))} 元要靠投資部位。`);
  }
  if (f.penLaborFrom > 0) {
    parts.push(`注意：你打算 ${p('retireAge')} 歲退休、${m.claimAge} 歲才開始領勞保，中間 ${f.penLaborFrom} 年沒有這層地板，模擬已經把這段空窗算進去。`);
  }
  body.textContent = parts.join('');

  if (rounded != null) {
    setStamp(`存活 ${rounded}%`, rounded >= 85 ? 'ok' : rounded >= 60 ? '' : 'void',
      `${rounded}:${m.claimAge}:${life}`);
  }
}

/* ==========================================================================
   13. 第一段的繪製
   ========================================================================== */
function renderRace() {
  const m = raceModel;
  const s = S();

  // 出生年次 → 法定請領年齡，直接寫回請領年齡滑桿
  const lo = m.legalAge - K.maxShiftYears, hi = m.legalAge + K.maxShiftYears;
  const range = sClaim.el;
  range.min = String(lo); range.max = String(hi);
  sClaim.set(m.claimAge, { silent: true });
  $('#claimTicks').replaceChildren(
    el('span', { text: String(lo) }),
    el('span', { text: String(m.legalAge) }),
    el('span', { text: String(hi) }),
  );
  $('#claimHint').textContent =
    `${m.row.label}：法定請領年齡 ${m.legalAge} 歲，最早可減額請領 ${m.earliest} 歲，最晚展延到 ${hi} 歲。`
    + `你今年約 ${m.currentAge} 歲。這個年齡決定的月領金額，就是第二段的地板。`;

  // 通膨率欄位只有在開啟物價調整時才有意義
  const cpiField = $('#f-cpi');
  if (s.cpiOn) { delete cpiField.dataset.disabled; cpiField.querySelector('input').disabled = false; }
  else { cpiField.dataset.disabled = '1'; cpiField.querySelector('input').disabled = true; }

  const f36 = $('#f-salary36');
  if (s.system === 'legacy') { delete f36.dataset.disabled; f36.querySelector('input').disabled = false; }
  else { f36.dataset.disabled = '1'; f36.querySelector('input').disabled = true; }

  renderLump(m);
  if (!m.eligible) { raceTl?.kill(); return; }

  renderAgeTable(m);
  renderLegend(m);

  $('#lifeChip').textContent = `終齡游標 ${m.life} 歲．可直接在圖上拖`;
  plot.opts.xTickValues = ageTicks(m);

  const cross = m.crossings.filter((c) => c.x <= m.axisEnd);
  const r65 = lifeRow(65, p('sex'));
  const lt = DATA?.lifeTable;
  $('#chartDesc').textContent =
    `橫軸是年齡（${m.axisStart} 到 ${m.axisEnd} 歲），縱軸是從開始請領那天算起累積已領到手的總金額。`
    + (cross.length
      ? `交叉點：${cross.map((c) => `${ageLabel(c.x)} ${LABELS(m)[c.winner].split('（')[0]}反超${LABELS(m)[c.loser].split('（')[0]}`).join('；')}。`
      : '在這段軸上三條線沒有交叉。')
    + (lt && r65
      ? `淡色虛線由左到右依序是：國人平均壽命 ${lt.atBirth.total} 歲（那是 0 歲的平均餘命，不是 65 歲的）、`
        + `65 歲男性 ${dec(65 + r65.male, 1)} 歲、65 歲女性 ${dec(65 + r65.female, 1)} 歲。`
        + `後兩條才是活到 65 歲的人該對照的終點，而且它們是期望值，一半的人會活得比它更久。`
      : '');

  paint(seriesFor(m, { emphasise: winnerKey(m) }), marksFor(m), domainFor(m));
  layoutCrossTags(m);
  layoutLifeTag(m);
  crossTags.forEach((t, i) => { if (m.crossings[i] && m.crossings[i].x <= m.axisEnd) t.style.opacity = '1'; });
}

function renderAgeTable(m) {
  const body = $('#ageBody');
  body.replaceChildren();
  const passed = m.currentAge;
  m.table.forEach((r) => {
    const tr = el('tr', {
      onclick: () => { store.set({ claimAge: r.age }); renderAll(); scheduleSim(); },
    });
    if (r.total === m.bestTotal && m.bestTotal > 0) tr.dataset.best = '1';
    if (r.d === 0) tr.dataset.legal = '1';
    if (r.age === m.claimAge) tr.dataset.pick = '1';
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
  $('#tableFoot').textContent = [
    `以 ${m.life} 歲為終點，${best ? `${best.age} 歲開始領` : '-'}總額最高；你目前選定 ${m.claimAge} 歲。`,
    m.currentAge > m.earliest
      ? `你今年約 ${m.currentAge} 歲，${m.earliest} 到 ${Math.min(m.currentAge - 1, m.legalAge + K.maxShiftYears)} 歲那幾格已經過去，只是拿來對照。`
      : `你今年約 ${m.currentAge} 歲，最早可以從 ${m.earliest} 歲開始減額請領（前提是年資已滿 ${K.minInsuredYears} 年）。`,
    m.cut < 1 ? `已套用 ${Math.round(m.cut * 100)}% 給付折減假設（使用者自選，非官方預測）。` : '',
    m.opt.cpiOn ? `已套用物價調整假設：年通膨 ${pp(m.opt.cpi * 100, 1)}，累計達 ${K.cpiThresholdPct}% 才調整一次。` : '',
  ].filter(Boolean).join('');
}

function renderLump(m) {
  const showRefuse = !m.eligible;
  $('#lumpCard').hidden = !showRefuse;
  $('#plotCard').hidden = showRefuse;
  $('#tableCard').hidden = showRefuse;
  if (!showRefuse) return;

  $('#r-lump').textContent = int(Math.round(m.lumpAnnuity));
  $('#r-lumpm').textContent = dec(m.Y, 2);
  $('#r-lumpage').textContent = `${m.legalAge} 歲`;
  $('#refuseBody').textContent =
    `勞保年資 ${dec(m.Y, 2)} 年，未滿 ${K.minInsuredYears} 年，依勞工保險條例第 58 條第 1 項第 1 款不能請領老年年金，`
    + '只能請領老年一次金。沒有月領金額可以跟別的年齡賽跑，所以那張圖不畫；畫出來會是一個不存在的東西。';

  const parts = [
    `<b>老年一次金</b>＝平均月投保薪資 ${int(m.salary)} × 給付月數 ${dec(m.Y, 2)}`
    + `（年資每滿 1 年給 ${K.lumpsumMonthsPerYear} 個月，未滿 1 年按比例）＝ ${int(Math.round(m.lumpAnnuity))} 元，`
    + `年滿 ${m.legalAge} 歲並離職退保後請領。`,
  ];
  if (S().system === 'legacy') {
    parts.push(
      `你選了「98 年前已有勞保年資」，因此還有另一條路：<b>一次請領老年給付</b>。`
      + `它用的是「退保前 ${K.avgSalaryMonthsLegacy} 個月」平均月投保薪資（你填的是 ${int(m.salary36)}），`
      + `月數 ${dec(m.legacyMonths, 2)} 個月，約 ${int(Math.round(m.lumpLegacy))} 元，`
      + `但請領資格另有條件。兩者只能擇一，核付後不得變更。`
    );
  }
  parts.push('另外：勞保年資未滿 15 年，但併計國民年金年資滿 15 年者，年滿 65 歲可以選擇請領勞保老年年金；這條路本工具沒有模擬，請直接洽勞保局。');
  $('#lumpNote').innerHTML = parts.join('<br><br>');
}

function renderRaceFormula() {
  const m = raceModel;
  const host = $('#raceFormula');
  host.replaceChildren();
  const labels = LABELS(m);

  host.appendChild(formulaBlock('攤開看：月領金額是怎麼算出來的', [
    `<b>A 式</b> = 平均月投保薪資 × 年資 × ${K.formulaARatePct}% + ${int(K.formulaAAddon)}`,
    `= ${int(m.salary)} × ${dec(m.Y, 4)} × ${K.formulaARatePct}% + ${int(K.formulaAAddon)} = <b>${int(Math.round(m.base.a))}</b> 元`,
    `<b>B 式</b> = 平均月投保薪資 × 年資 × ${K.formulaBRatePct}%`,
    `= ${int(m.salary)} × ${dec(m.Y, 4)} × ${K.formulaBRatePct}% = <b>${int(Math.round(m.base.b))}</b> 元`,
    `<b>擇優</b> → ${m.base.which} 式勝出，基準月領 <b>${int(Math.round(m.base.best))}</b> 元`,
    `<b>${labels.early}</b> ×（1 − ${K.earlyPerYearPct}% × ${K.maxShiftYears}）= ${int(Math.round(m.lines[0].monthly))} 元`,
    `<b>${labels.legal}</b> ×1.00 = ${int(Math.round(m.lines[1].monthly))} 元`,
    `<b>${labels.defer}</b> ×（1 + ${K.deferPerYearPct}% × ${K.maxShiftYears}）= ${int(Math.round(m.lines[2].monthly))} 元`,
    `<b>你選的 ${m.claimAge} 歲</b> ×${dec(m.picked.factor, 2)} = <b>${int(Math.round(m.picked.monthly))}</b> 元，這個數字直接送進第二段當地板`,
    m.cut < 1 ? `<b>折減假設</b> 全部再乘 ${Math.round(m.cut * 100)}%（使用者自選，非官方預測）` : '',
  ].filter(Boolean),
  `法源：勞工保險條例第 58 條之 1（A／B 兩式擇優）、第 58 條之 2（展延與減給各 ${K.deferPerYearPct}%／年、上限 ${K.deferMaxPct}%）。`
  + `平均月投保薪資按加保期間<b>最高 ${K.avgSalaryMonthsAnnuity} 個月</b>之平均（第 19 條第 3 項第 1 款），`
  + `分級表天花板 ${int(K.insuredSalaryMax)} 元。常數取自 assets/data/tw-labor-pension.json（資料版本 ${LAW.version}）。`));

  host.appendChild(formulaBlock('攤開看：交叉點為什麼落在那裡', [
    `設法定年齡為 T、基準月領為 M，u 表示「比 T 晚幾年死」。`,
    `提前 5 年累積 = 0.8M × 12 ×（u + 5）　法定累積 = M × 12 × u`,
    `兩者相等 → 0.8(u + 5) = u → u = 20，也就是 <b>T + 20 歲</b>`,
    `展延 5 年累積 = 1.2M × 12 ×（u − 5）　與法定相等 → 1.2(u − 5) = u → u = 30，即 <b>T + 30 歲</b>`,
    `所以在沒有物價調整的情況下，交叉點只跟 ±${K.earlyPerYearPct}% 有關，跟你的薪資與年資完全無關。`,
    `這就是為什麼「損益兩平大約 11 到 14 年」那種說法對不上：它算的是別的東西。`,
    m.opt.cpiOn ? `你開了物價調整，各方案的基期年度不同，交叉點會比上面的純算術再往前或往後移一點。` : '',
  ].filter(Boolean),
  '這一段是純算術，不是法規；法規只提供每年 4% 這個係數。'));
}

/* ==========================================================================
   14. 第二段的繪製
   ========================================================================== */
function paintAlloc() {
  const s = S();
  const cash = 100 - s.stock - s.bond;
  $('#cashPct').textContent = cash + '%';
  const ws = s.stock / 100, wb = s.bond / 100, wc = cash / 100;
  const pool = s.mode === 'bootstrap' ? currentPool() : null;
  if (pool) {
    const port = pool.stock.map((rs, i) => (ws * rs + wb * pool.bond[i] + wc * s.muc / 100) * 100);
    $('#muPct').textContent = pp(mean(port), 1);
    $('#sigPct').textContent = pp(stdev(port), 1);
    return;
  }
  const mu = ws * s.mus + wb * s.mub + wc * s.muc;
  const varp = (ws * s.sigs) ** 2 + (wb * s.sigb) ** 2 + 2 * ws * wb * s.sigs * s.sigb * s.rho;
  $('#muPct').textContent = pp(mu, 1);
  $('#sigPct').textContent = pp(Math.sqrt(Math.max(0, varp)), 1);
}

function paintStrategyHint() {
  $('#strategyHint').textContent = S().strategy === 'fixed'
    ? '固定實質金額：不管市值漲跌，每年都領到同樣的購買力。這就是 4% 法則的本質。'
    : '動態護欄：當年提領率超過初始的 1.2 倍就砍 10%，低於 0.8 倍就加 10%。成功率會變高，代價是你真的要在壞年頭少花錢。';
}

function paintInflHint() {
  const s = S();
  const cpi = cpiPool();
  const on = s.inflMode === 'cpi' && cpi;
  const slider = $('#s-infl input[type="range"]');
  const twin = $('#t-infl');
  if (slider) slider.disabled = Boolean(on);
  if (twin) twin.disabled = Boolean(on);
  $('#s-infl').style.opacity = on ? '0.45' : '';
  $('#inflHint').textContent = on
    ? `抽主計總處 CPI 年增率 ${cpi.startYear} 到 ${cpi.endYear} 的 ${cpi.values.length} 個年度，同樣是連續 ${BLOCK} 年一塊。`
      + `這 30 年的平均只有 ${dec(mean(cpi.values), 2)}%、最高 ${dec(Math.max(...cpi.values), 2)}%，沒有涵蓋任何一段高通膨時期，`
      + `所以抽出來的通膨偏低，對退休模擬是樂觀的方向。`
    : `固定 ${dec(s.infl, 1)}%：每一年都一樣。這是模型假設，不是資料。`;
}

function paintCrashHint(pool) {
  const s = S();
  const hint = $('#crashHint');
  const slider = $('#s-crash input[type="range"]');
  const hist = pool ? worstWindow(pool.stock, 5) : null;
  if (slider) slider.disabled = Boolean(hist);
  $('.crash-set').dataset.hist = String(Boolean(hist));
  if (hist) {
    const y0 = pool.startYear + hist.i;
    hint.textContent =
      `歷史模式下這個滑桿不生效：前五年直接套用「${pool.meta.short}」抽樣池裡實際最差的連續 5 年（${y0} 到 ${y0 + 4}，累計 ${pp((hist.cum - 1) * 100, 1)}），`
      + `債券那一腳也換成同樣那五個年度。`
      + (pool.key === 'taiex'
        ? `注意：這 ${pool.n} 年裡最差的 5 年也只跌 ${dec(Math.abs((hist.cum - 1) * 100), 1)}%，這本身就是樣本太薄的證據，不是台股很安全的證據。`
        : '');
  } else {
    hint.textContent = '這不是某一段真實歷史，是一個你可以調整幅度的壓力情境。同樣的平均報酬，只要壞的年份排在最前面，結局就完全不同。';
  }
  $('.crash-set').dataset.on = String(s.crashOn);
}

function paintMode() {
  const s = S();
  const boot = s.mode === 'bootstrap';
  const pool = boot ? currentPool() : null;
  const blocked = boot && !pool;

  $('#refuse').hidden = !blocked;
  $('#bootNote').hidden = !(boot && pool);
  $$('#fanCard, #ruinCard, #seqCard, #incomeCard').forEach((n) => { n.dataset.stale = String(blocked); });

  $('#poolSet').dataset.on = String(boot);
  $$('#seg-pool .segmented__opt').forEach((b) => { b.disabled = !boot; });

  $('#modeHint').textContent = boot
    ? `每次抽連續 ${BLOCK} 年，保留報酬的自相關（比逐年獨立抽樣誠實）。但抽樣池就只有下面那幾十個年度，抽再多次也不會生出樣本裡沒有的情境。`
    : '報酬由你指定的 μ、σ、ρ 生成。好處是假設全部攤在檯面上、可以自己調；壞處是常態分布沒有真實市場的厚尾，也沒有自相關。';

  $('#poolHint').textContent = pool
    ? (pool.key === 'taiex'
      ? `台股含息報酬指數 ${pool.startYear} 到 ${pool.endYear}，只有 ${pool.n} 個年度，而且幾乎整段都在結構性多頭。`
      : `S&P 500 ${pool.startYear} 到 ${pool.endYear}，${pool.n} 個年度，含 1929、1973、2000、2008。它不是台股，幣別與稅制都不同。`)
    : '';
  paintCrashHint(pool);
  if (pool) renderBootNote(pool);

  if (blocked) {
    $('#refuseWhy').textContent = '歷史區塊拔靴法需要 assets/data/tw-returns.json 裡的年度報酬序列，這個檔案現在載不進來（離線開檔或路徑錯誤都會這樣），所以不畫假的分布。';
    $('#refuseCan').textContent = '可以回答的範圍：參數化常態模式，你自己指定 μ 與 σ，模型的假設全部攤在檯面上。';
  }
}

function renderBootNote(pool) {
  const s = S();
  const g = cagr(pool.stock);
  const w = worstWindow(pool.stock, 5);
  const worstYear = pool.raw.indexOf(Math.min(...pool.raw));
  const cpi = s.inflMode === 'cpi' ? cpiPool() : null;

  $('#bootN').textContent = String(pool.n);
  $('#bootLead').textContent =
    `抽樣池是${pool.meta.label}，${pool.startYear} 到 ${pool.endYear} 共 ${pool.n} 個年度，`
    + `每次抽連續 ${BLOCK} 年。重抽一萬次也不會生出這 ${pool.n} 年裡沒發生過的事，`
    + `所以下面那把扇子的形狀，先天就被這段期間的樣子決定了。`;

  $('#bootCaveat').replaceChildren(
    el('span', { class: 'boot-note__quote-src', text: '資料檔原文的但書：' }),
    el('span', { text: pool.caveat || '（這一份序列沒有附但書）' }),
  );

  const rows = [
    ['樣本', `${pool.n} 個年度（${pool.startYear} 到 ${pool.endYear}）`],
    ['算術平均／標準差', `${pp(mean(pool.raw), 2)}／${dec(stdev(pool.raw), 2)}%`],
    ['年化（幾何）', pp(g.annual * 100, 2)],
    ['累積', `${dec(g.total, 2)} 倍`],
    ['最差單一年度', `${pp(pool.raw[worstYear], 2)}（${pool.startYear + worstYear}）`],
    ['最差連續 5 年', w ? `${pool.startYear + w.i} 到 ${pool.startYear + w.i + 4}，累計 ${pp((w.cum - 1) * 100, 1)}` : '-'],
    ['債券那一腳', pool.bondLabel || '同年度的美國 10 年期公債模型化報酬'],
    ['通膨', cpi ? `抽台灣 CPI ${cpi.startYear} 到 ${cpi.endYear}（${cpi.values.length} 年，平均 ${dec(mean(cpi.values), 2)}%）` : `固定 ${dec(s.infl, 1)}%`],
  ];
  const dl = $('#bootStats');
  dl.replaceChildren();
  for (const [k, v] of rows) {
    dl.appendChild(el('dt', { text: k }));
    dl.appendChild(el('dd', { text: v }));
  }

  $('#bootBond').textContent =
    (pool.key === 'taiex'
      ? `這 ${pool.n} 個年度的算術平均是 ${pp(mean(pool.raw), 2)}，遠高於任何長期股票報酬的合理預期值。用它抽樣，成功率會偏高、尾端會偏薄。`
      : `這 ${pool.n} 個年度含 1929、1973 到 1974、2000 到 2002、2008 幾段真實的大跌，尾端比台股那幾年厚得多；代價是它是美元計價的美國市場。`)
    + '　債券那一腳沒有台灣的可用長序列，只能用同年度的美國 10 年期公債模型化報酬替代：那是以殖利率重新定價推算出來的，不是實際可投資指數。'
    + '　股與債抽的是同一組年度，所以股債的共動關係來自歷史本身，這個模式下不使用 ρ，左欄的 μ、σ、ρ 也全部不生效。';
}

function renderFloorRows() {
  const m = raceModel;
  const f = floorOf(m);
  const host = $('#floorRows');
  host.replaceChildren();

  const rows = [
    [
      '勞保老年年金',
      `${m.claimAge} 歲開始領，來自上一段的賽跑`,
      m.eligible ? int(Math.round(f.penLabor)) : '0',
      m.eligible ? '' : '年資未滿 15 年，沒有月退',
    ],
    [
      '勞退月退休金',
      f.manual != null
        ? '你自己填的核定金額'
        : (f.auto.row
          ? `專戶 ${money(p('pensionAccount'), { compact: true })}元 ÷ ${f.auto.row.age} 歲平均餘命 ${dec(f.auto.row.years, 2)} 年`
          : '沒有生命表，算不出來'),
      int(Math.round(f.penRetire)),
      f.penRetireAge > p('retireAge') ? `${f.penRetireAge} 歲才開始領` : '',
    ],
  ];
  for (const [label, sub, val, note] of rows) {
    host.appendChild(el('dt', {}, [
      el('span', { text: label }),
      el('small', { text: sub }),
    ]));
    host.appendChild(el('dd', {}, [
      el('span', { text: val }),
      note ? el('small', { text: ' ' + note }) : null,
    ]));
  }
  host.appendChild(el('dt', {}, [el('b', { text: '每月地板合計' })]));
  host.appendChild(el('dd', { text: int(Math.round(f.total)) }));

  $('#retireHint').textContent =
    `退休年齡決定模擬從幾歲開始跑，也決定勞退月退的起算年齡（法定不早於 60 歲）。`
    + (f.penLaborFrom > 0
      ? `你選的請領年齡比退休年齡晚 ${f.penLaborFrom} 年，那段空窗沒有勞保這層地板。`
      : '');
}

function renderAdvanced() {
  const host = $('#advBody');
  host.replaceChildren();
  const s = S();
  const rows = [
    ['mus', '股票 μ', '%', s.mus], ['sigs', '股票 σ', '%', s.sigs],
    ['mub', '債券 μ', '%', s.mub], ['sigb', '債券 σ', '%', s.sigb],
    ['muc', '現金 μ', '%', s.muc], ['rho', '股債相關 ρ', '', s.rho],
  ];
  const grid = el('div', { class: 'fieldgrid fieldgrid--2' });
  for (const [key, label, unit, v] of rows) {
    grid.appendChild(el('label', { class: 'field' }, [
      el('span', { class: 'field__label', text: label }),
      el('span', { class: 'field__control' }, [
        el('input', {
          type: 'text', inputmode: 'decimal', value: String(v),
          onchange: (e) => {
            const nv = clamp(parseNum(e.target.value, v), key === 'rho' ? -1 : -20, key === 'rho' ? 1 : 60);
            e.target.value = String(nv);
            store.set({ [key]: nv });
            paintAlloc(); scheduleSim(0);
          },
        }),
        unit ? el('span', { class: 'field__unit', text: unit }) : null,
      ]),
    ]));
  }
  host.appendChild(grid);
  host.appendChild(el('p', {
    class: 'adv-note',
    text: '這六個數字全部是未查證的模型假設，不是歷史統計，而且只在「參數化常態」模式生效。'
        + '站上確實內建了台股與 S&P 500 的年度報酬序列，但那是給「歷史區塊拔靴法」抽樣用的；'
        + '它們的樣本期間太特殊，直接拿去當 μ 會高估，所以這裡不自動代入。改動它們，右邊整張圖就會換一個樣子，這正是重點。',
  }));
}

/* ==========================================================================
   15. 跑模擬
   ========================================================================== */
let runId = 0;

function buildCfg() {
  const s = S();
  const m = raceModel;
  const f = floorOf(m);
  const cash = 100 - s.stock - s.bond;
  const narrow = window.innerWidth < 420;
  const pool = s.mode === 'bootstrap' ? currentPool() : null;
  const boot = Boolean(pool);
  const cpi = s.inflMode === 'cpi' ? cpiPool() : null;
  const w = boot && s.crashOn ? worstWindow(pool.stock, 5) : null;
  const retireAge = p('retireAge');
  const g = MODEL.guardrail;

  return {
    assets0: Math.max(1, p('investable')),
    years: Math.max(1, p('planToAge') - retireAge),
    ageRetire: retireAge,
    spend0: p('retireSpend') * 12,
    penLabor: f.penLabor, penRetire: f.penRetire,
    penLaborFrom: f.penLaborFrom, penRetireFrom: f.penRetireFrom,
    cpiLabor: s.cpiLabor !== false, cpiRetire: Boolean(s.cpiRetire),
    infl: s.infl / 100,
    ws: s.stock / 100, wb: s.bond / 100, wc: cash / 100,
    mus: s.mus / 100, sigs: s.sigs / 100,
    mub: s.mub / 100, sigb: s.sigb / 100,
    muc: s.muc / 100, rho: s.rho,
    strategy: s.strategy,
    guardUp: g.upper, guardLo: g.lower, guardCut: g.cut, guardRaise: g.raise,
    crashOn: s.crashOn, crashDepth: s.crashDepth / 100, crashShape: MODEL.crashShape,
    boot, blockLen: BLOCK,
    poolIdx: boot ? pool.stock.map((_, i) => i) : null,
    stockPool: boot ? pool.stock : null,
    bondPool: boot ? pool.bond : null,
    crashHist: w ? { stock: pool.stock.slice(w.i, w.i + w.len), bond: pool.bond.slice(w.i, w.i + w.len) } : null,
    cpiPool: cpi ? cpi.values.map((v) => v / 100) : null,
    paths: s.precise ? 1000 : 200,
    keep: s.precise ? 0 : (narrow ? 40 : 60),
    seed: 20260803,
  };
}

function runSim() {
  if (!K) return;
  paintMode();
  if (S().mode === 'bootstrap' && !DATA) return;
  const cfg = buildCfg();
  runId += 1;
  $('#fanProgress').hidden = false;
  $('#fanProgressBar').style.width = '0%';
  worker.postMessage({ runId, cfg });
}

worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.runId !== runId) return;
  if (m.type === 'tick') {
    $('#fanProgressBar').style.width = (m.done / m.total * 100).toFixed(1) + '%';
    setRing(m.success / m.done, { animate: false });
    return;
  }
  $('#fanProgress').hidden = true;
  lastSim = m;
  renderSim(m);
};

let firstFanPaint = true;
function paintFan(m, animate) {
  const src = worstOnly ? m.worstPaths : m.keepPaths;
  const pile = new Array(m.n + 1).fill(0);
  for (const a of m.ruinAges) pile[a - m.ageRetire] += 1;
  fan.setData({
    n: m.n, ageRetire: m.ageRetire, bands: m.bands,
    paths: src, pile, assets0: p('investable'),
  }, { animate });
}

function renderSim(m) {
  const s = S();
  const rounded = Math.round(m.successRate * 20) * 5;

  // 扇形的招牌動效：分頁還藏著的時候不播，等使用者切過去第一次看見時再長一次
  const visible = S().tab === 'fan';
  if (visible) { paintFan(m, firstFanPaint ? 'grow' : 'morph'); firstFanPaint = false; fanSeen = true; }
  else paintFan(m, 'none');
  setRing(m.successRate);

  cWr(m.firstDraw / Math.max(1, p('investable')) * 100);
  cWorst(m.worstMean);
  cGap(Math.max(0, p('retireSpend') - floorOf(raceModel).total));

  const ruinEl = $('#r-ruin');
  if (m.ruinAges.length) {
    const sorted = m.ruinAges.slice().sort((a, b) => a - b);
    ruinEl.innerHTML = `${Math.round(quantile(sorted, 0.5))}<small>歲</small>`;
  } else {
    ruinEl.textContent = '無';
  }

  renderHeadline();
  renderRuinPlot(m);
  renderSeqPlot(m);
  renderIncomePlot(m);
  renderFanFormula(m, rounded);
  carbonTransfer($$('[data-live]'));
}

function renderRuinPlot(m) {
  if (!m.ruinAges.length) {
    plotRuin.setSeries([], { animate: false });
    $('#ruinDesc').textContent = '這一組假設下沒有任何一條路徑在終齡前歸零，所以這張圖是空的。這不代表不會發生，只代表在你設定的報酬假設裡沒發生。';
    return;
  }
  const lo = Math.min(...m.ruinAges), hi = Math.max(...m.ruinAges);
  const bins = Math.max(1, Math.min(28, hi - lo + 1));
  const h = histogram(m.ruinAges, bins, lo - 0.5, hi + 0.5);
  plotRuin.setSeries([{
    type: 'bars',
    data: h.bins.map((b) => ({ x: b.x, y: b.y })),
    color: cssv('--up'),
    barRatio: 0.8,
  }], { animate: false });
  const sorted = m.ruinAges.slice().sort((a, b) => a - b);
  $('#ruinDesc').textContent =
    `${m.paths} 條路徑裡有 ${m.ruinAges.length} 條在終齡前歸零，最早 ${lo} 歲、中位 ${Math.round(quantile(sorted, 0.5))} 歲、最晚 ${hi} 歲。`;
}

function renderSeqPlot(m) {
  const mk = (arr) => arr.map((v, i) => ({ x: m.ageRetire + i, y: v }));
  plotSeq.setSeries([
    { type: 'line', data: mk(m.seqOrig), color: cssv('--series-1'), width: 2.4, label: '原順序' },
    { type: 'line', data: mk(m.seqRev), color: cssv('--series-4'), width: 2.4, dash: [5, 4], label: '順序反轉' },
  ], { animate: false });
  const a = m.seqOrig[m.n], b = m.seqRev[m.n];
  $('#seqDesc').textContent =
    `兩條線用的是完全相同的一組年報酬率，只有先後順序不同。終齡時的餘額差了 ${money(Math.abs(a - b), { compact: true })}元`
    + `（${money(a, { compact: true })} 對 ${money(b, { compact: true })}）。這個差額不是報酬造成的，是順序造成的。`;
}

function renderIncomePlot(m) {
  const pen = m.income.map((r) => ({ x: r.age, y: 0, y1: r.pension, color: cssv('--series-3') }));
  const wd = m.income.map((r) => ({ x: r.age, y: r.pension, y1: r.pension + r.withdraw, color: cssv('--series-1') }));
  plotIncome.setSeries([
    { type: 'stack', data: pen, barRatio: 0.9 },
    { type: 'stack', data: wd, barRatio: 0.9 },
  ], { animate: false });
  legendHTML($('#incomeLegend'), [
    { label: '年金（地板）', color: cssv('--series-3') },
    { label: '投資提領', color: cssv('--series-1') },
  ]);
  const s = S();
  const f = floorOf(raceModel);
  const first = m.income[0], lastRow = m.income[m.income.length - 1];
  const erosion = first && lastRow && first.pension > 0 ? (1 - lastRow.pension / first.pension) : 0;
  $('#incomeDesc').textContent =
    '中位路徑的收入組成，全部換算成今日購買力。'
    + (f.penLaborFrom > 0 ? `前 ${f.penLaborFrom} 年還沒開始領勞保，地板那一層是矮的。` : '')
    + (s.cpiRetire || f.penRetire === 0
      ? '你設定的年金全部隨物價調整，所以地板那一層在圖上維持水平。'
      : `勞退月退不隨物價調整，${m.n} 年後年金那一層的實質購買力被磨掉 ${pct(Math.max(0, erosion), 0)}，缺口只能由投資部位補上。`);
}

function renderFanFormula(m, rounded) {
  const s = S();
  const host = $('#fanFormula');
  host.replaceChildren();
  const cash = 100 - s.stock - s.bond;
  const f = floorOf(raceModel);
  const pen0 = (f.penLaborFrom === 0 ? f.penLabor * 12 : 0) + (f.penRetireFrom === 0 ? f.penRetire * 12 : 0);
  const spend = p('retireSpend');

  host.appendChild(formulaBlock('攤開看：地板那兩層是怎麼來的', [
    `<b>勞保老年年金</b> = 上一段選定的 ${raceModel.claimAge} 歲那一格 = <b>${int(Math.round(f.penLabor))}</b> 元／月`
      + `，從退休後第 ${f.penLaborFrom} 年開始計入`,
    f.manual != null
      ? `<b>勞退月退休金</b> = 你自己填的核定金額 <b>${int(Math.round(f.penRetire))}</b> 元／月`
      : (f.auto.row
        ? `<b>勞退月退休金</b> ≈ 專戶餘額 × i ÷ (1 − (1+i)<sup>−n</sup>)，`
          + `i = ${dec(K.laborPensionRatePct, 4)}% ÷ 12、n = ${f.auto.row.age} 歲平均餘命 ${dec(f.auto.row.years, 2)} 年 × 12 = ${f.auto.n} 個月`
        : `<b>勞退月退休金</b> 沒有生命表可用，這一層算不出來`),
    f.manual == null && f.auto.row
      ? `= ${int(p('pensionAccount'))} × ${dec(f.auto.i, 6)} ÷ (1 − (1+${dec(f.auto.i, 6)})<sup>−${f.auto.n}</sup>) = <b>${int(Math.round(f.penRetire))}</b> 元／月，從 ${f.penRetireAge} 歲起`
      : '',
    `<b>每月地板合計</b> = ${int(Math.round(f.penLabor))} + ${int(Math.round(f.penRetire))} = <b>${int(Math.round(f.total))}</b> 元`,
    `<b>投資部位每月要扛</b> = ${int(spend)} − ${int(Math.round(f.total))} = <b>${int(Math.round(Math.max(0, spend - f.total)))}</b> 元`,
  ].filter(Boolean),
  '勞退月退休金依勞工退休金條例第 23 條，是「依年金生命表，以平均餘命及利率等基礎計算」。'
  + `勞保局用的是勞退年金生命表，本站沒有那張表，這裡改用內政部簡易生命表的分齡平均餘命（${DATA?.lifeTable?.vintage || '未載入'}），`
  + `利率取 assets/data/tw-labor-pension.json 的年金生命表利率 ${dec(K.laborPensionRatePct, 4)}%。`
  + '所以這是估計值，不是核定金額；查得到核定數字就在左欄改掉它。'));

  host.appendChild(formulaBlock('攤開看：每一年的餘額是怎麼算出來的', [
    `<b>期末餘額</b> = (期初餘額 − 當年淨提領) × (1 + r<sub>t</sub>)`,
    s.inflMode === 'cpi' && cpiPool()
      ? `<b>名目支出_t</b> = 月支出 × 12 × Π(1+π<sub>k</sub>)，π 逐年從 CPI 序列抽出來，每條路徑都不一樣`
      : `<b>名目支出_t</b> = 月支出 × 12 × (1+π)<sup>t</sup>　= ${int(spend)} × 12 × (1+${dec(s.infl / 100, 3)})<sup>t</sup>`,
    `<b>年金_t</b> = 勞保（第 ${f.penLaborFrom} 年起）${int(Math.round(f.penLabor))}×12×${s.cpiLabor !== false ? '(1+π)^t' : '1'}`
      + ` ＋ 勞退（第 ${f.penRetireFrom} 年起）${int(Math.round(f.penRetire))}×12×${s.cpiRetire ? '(1+π)^t' : '1'}`,
    `<b>當年淨提領</b> = 名目支出_t − 年金_t，下限 0`,
    `第 1 年淨提領 = ${int(spend * 12)} − ${int(pen0)} = <b>${int(Math.max(0, spend * 12 - pen0))}</b> 元`,
    `首年淨提領率 = ${int(Math.max(0, spend * 12 - pen0))} ÷ ${int(p('investable'))} = <b>${pct(m.firstDraw / Math.max(1, p('investable')), 2)}</b>`,
    `<b>成功</b> = 到 ${p('planToAge')} 歲時餘額 > 0；${m.paths} 條路徑中有 ${m.success} 條成功`,
    `= ${pct(m.successRate, 2)} → 四捨五入到 5% → <b>${rounded}%</b>`,
  ], '成功率一律四捨五入到 5%，是因為蒙地卡羅的輸出本來就沒有兩位數的精度。把 73.4% 寫出來會讓人以為那是一個測量值，它不是。'));

  const poolF = s.mode === 'bootstrap' ? currentPool() : null;
  const wF = poolF && s.crashOn ? worstWindow(poolF.stock, 5) : null;
  host.appendChild(poolF
    ? formulaBlock('攤開看：報酬 r_t 是怎麼生成的', [
      `<b>模式</b> 歷史區塊拔靴（block = ${BLOCK} 年），抽樣池 ${poolF.meta.label} ${poolF.startYear} 到 ${poolF.endYear}`,
      `<b>母體</b> ${poolF.n} 個年度，算術平均 ${pp(mean(poolF.raw), 2)}、標準差 ${dec(stdev(poolF.raw), 2)}%、年化 ${pp(cagr(poolF.stock).annual * 100, 2)}`,
      `每 ${BLOCK} 年一塊、隨機起點、跨越尾端就繞回開頭，抽到 ${m.n} 年為止`,
      `r<sub>股</sub>(t) = 抽中年度的實際報酬；r<sub>債</sub>(t) = <b>同一個年度</b>的美國 10 年期公債模型化報酬`,
      `r<sub>t</sub> = ${dec(s.stock / 100, 2)}·r<sub>股</sub> + ${dec(s.bond / 100, 2)}·r<sub>債</sub> + ${dec(cash / 100, 2)}·${pp(s.muc, 2)}（現金無波動）`,
      `<b>不使用</b> μ、σ、ρ：股債共動來自同一批年度，不是相關係數假設`,
      s.crashOn && wF
        ? `<b>順序風險</b> 前 5 年強制換成 ${poolF.startYear + wF.i} 到 ${poolF.startYear + wF.i + 4}，這個池子裡實際最差的連續 5 年（累計 ${pp((wF.cum - 1) * 100, 1)}）`
        : `<b>順序風險</b> 未套用。打開左邊的開關，前 5 年會被換成這個池子裡實際最差的連續 5 年`,
      `<b>亂數</b> mulberry32，種子固定，所以同一組輸入永遠畫出同一張圖`,
    ], `區塊拔靴只會重排歷史，不會創造歷史。${poolF.n} 個年度撐 ${m.n} 年的退休期間，樣本本來就薄。`)
    : formulaBlock('攤開看：報酬 r_t 是怎麼生成的', [
      `<b>模式</b> 參數化常態（另一個選項是歷史區塊拔靴，block = ${BLOCK} 年）`,
      `r<sub>股</sub> = μ<sub>股</sub> + σ<sub>股</sub>·z₁　= ${pp(s.mus, 2)} + ${pp(s.sigs, 2)}·z₁`,
      `r<sub>債</sub> = μ<sub>債</sub> + σ<sub>債</sub>·(ρ·z₁ + √(1−ρ²)·z₂)　ρ = ${dec(s.rho, 2)}`,
      `r<sub>t</sub> = ${dec(s.stock / 100, 2)}·r<sub>股</sub> + ${dec(s.bond / 100, 2)}·r<sub>債</sub> + ${dec(cash / 100, 2)}·${pp(s.muc, 2)}`,
      s.crashOn
        ? `<b>順序風險</b> 前 5 年的 r<sub>股</sub> 被替換成一組形狀固定、等比縮放到累計 ${dec(s.crashDepth, 0)}% 的序列（形狀假設，不是任何一段真實歷史）`
        : `<b>順序風險</b> 未套用。打開左邊的開關，前 5 年的股票報酬會被強制換掉`,
      `<b>亂數</b> mulberry32，種子固定，所以同一組輸入永遠畫出同一張圖`,
    ], 'μ、σ、ρ 全部是模型假設，不是查證過的歷史統計。它們可以在左欄「攤開改」裡改掉，改完這一頁所有數字都會跟著換。'));

  if (s.strategy === 'guardrail') {
    const g = MODEL.guardrail;
    host.appendChild(formulaBlock('攤開看：動態護欄怎麼動', [
      `初始提領率 w₀ = 首年淨提領 ÷ 期初資產 = <b>${pct(m.firstDraw / Math.max(1, p('investable')), 2)}</b>`,
      `當年提領率 > w₀ × ${dec(g.upper, 2)} → 當年提領 × ${dec(1 - g.cut, 2)}`,
      `當年提領率 < w₀ × ${dec(g.lower, 2)} → 當年提領 × ${dec(1 + g.raise, 2)}`,
      `代價：這條規則要求你在壞年頭真的少花錢，模型不會替你做這件事`,
    ], 'Guyton-Klinger 簡化版，是研究結論而非法規，屬於未查證的模型假設。'));
  }

  // 邊界情況：資產撐不住時，要指出缺口，不要只顯示一個 0%
  if (rounded === 0) {
    const years = m.n;
    const annualGap = Math.max(0, spend * 12 - pen0);
    const need = annualGap * presentValueFactor(realRate(), years);
    host.appendChild(formulaBlock('攤開看：缺口有多大', [
      `以今日購買力計，每年缺口 ${int(annualGap)} 元`,
      `要撐滿 ${years} 年，在實質報酬 ${pp(realRate() * 100, 1)} 的假設下大約需要 <b>${money(need, { compact: true })}</b>元本金`,
      `你目前是 ${money(p('investable'), { compact: true })}元，差 <b>${money(Math.max(0, need - p('investable')), { compact: true })}</b>元`,
      `缺口可以靠三個地方補：多存本金、減少支出、或把終齡拉回現實`,
    ], '這一段是年金現值的算術，不是模擬結果；它假設報酬固定、沒有波動，只用來標出量級。'));
  }
}

/* ==========================================================================
   16. 法源與模型假設
   ========================================================================== */
function renderSources() {
  const tb = $('#sourceRows');
  tb.replaceChildren();
  const rows = [];

  const lawSrc = (LAW.sources || []).map((x) => x.url)[0];
  rows.push(
    { label: '老年年金 A 式', value: `年資 × ${K.formulaARatePct}% + ${int(K.formulaAAddon)} 元`, status: 'verified', basis: '勞工保險條例第 58 條之 1 第 1 款', url: lawSrc },
    { label: '老年年金 B 式', value: `年資 × ${K.formulaBRatePct}%`, status: 'verified', basis: '勞工保險條例第 58 條之 1 第 2 款', url: lawSrc },
    { label: '展延／減給', value: `每年 ${K.deferPerYearPct}%，上限 ${K.deferMaxPct}%（${K.maxShiftYears} 年）`, status: 'verified', basis: '勞工保險條例第 58 條之 2', url: lawSrc },
    { label: '請領年金最低年資', value: `${K.minInsuredYears} 年`, status: 'verified', basis: '勞工保險條例第 58 條第 1 項第 1 款', url: lawSrc },
    { label: '投保薪資分級表天花板', value: `${int(K.insuredSalaryMax)} 元／月`, status: 'verified', basis: `共 ${K.grades.length} 級，最低 ${int(K.grades[0])} 元。${LAW.note || ''}`, url: (LAW.sources || []).find((x) => /投保薪資/.test(x.label))?.url || lawSrc },
    { label: '年金物價調整門檻', value: `累計成長率 ${K.cpiThresholdPct}%`, status: 'verified', basis: '勞工保險條例第 65 條之 4。達標時按該累計成長率全額調整，不是每年調。', url: lawSrc },
    { label: '法定請領年齡對照', value: `${K.claimAges[0].legalAge} 到 ${K.claimAges[K.claimAges.length - 1].legalAge} 歲`, status: 'verified', basis: '勞工保險條例第 58 條第 5 項，依出生年次逐步調高至 65 歲', url: lawSrc },
    { label: '勞退年金生命表利率', value: `${dec(K.laborPensionRatePct, 4)}%`, status: 'verified', basis: '勞工退休金條例第 23 條：月退休金依年金生命表，以平均餘命及利率等基礎計算。本站沒有勞退年金生命表，改用內政部簡易生命表的平均餘命，所以換算值是估計。', url: lawSrc },
  );

  const lt = DATA?.lifeTable;
  if (lt) {
    rows.push({
      label: '分齡平均餘命',
      value: `65 歲男 ${dec(lt.male[lt.ages.indexOf(65)], 2)} 年／女 ${dec(lt.female[lt.ages.indexOf(65)], 2)} 年`,
      status: 'verified',
      basis: `${lt.vintage}。只收 ${lt.ages.join('／')} 歲五列，本站不做內插。`,
      url: lt.source,
    });
  }
  for (const key of ['taiexTotalReturn', 'sp500TotalReturn', 'ust10yTotalReturn', 'twCPI']) {
    const q = DATA?.series?.[key];
    if (!q) continue;
    rows.push({
      label: q.label || key,
      value: `${q.values.length} 個年度（${q.startYear} 到 ${q.endYear}）`,
      status: 'verified',
      basis: q.caveat || '',
      url: q.source || (DATA.sources || []).find((x) => x.key === key)?.url,
    });
  }

  rows.push(
    { label: '股票 μ／σ', value: `${pp(S().mus, 1)}／${pp(S().sigs, 1)}`, status: 'unverified', basis: '模型假設，不是歷史統計。只在參數化常態模式生效，可在左欄改掉。' },
    { label: '債券 μ／σ', value: `${pp(S().mub, 1)}／${pp(S().sigb, 1)}`, status: 'unverified', basis: '模型假設，同上。歷史模式的債券改用同年度的美國 10 年期公債模型化報酬。' },
    { label: '現金 μ', value: pp(S().muc, 1), status: 'unverified', basis: '模型假設。現金在本模型視為零波動，風險完全表現在跑不贏通膨。' },
    { label: '股債相關 ρ', value: dec(S().rho, 2), status: 'unverified', basis: '模型假設。實務上 ρ 不是常數，2022 年股債同跌就是反例。' },
    { label: '通膨假設', value: pp(S().infl, 1), status: 'unverified', basis: '模型假設，是「固定通膨」選項的預設值。' },
    { label: '退休前五年大跌的形狀', value: MODEL.crashShape.map((x) => pp(x * 100, 0)).join(' '), status: 'unverified', basis: '這不是任何一段真實歷史，是一個會被等比縮放到你指定跌幅的形狀假設。' },
    { label: '動態護欄門檻', value: `${MODEL.guardrail.upper}／${MODEL.guardrail.lower}／±${pp(MODEL.guardrail.cut * 100, 0)}`, status: 'unverified', basis: 'Guyton-Klinger 簡化版。原始規則比這複雜，且同樣是研究結論而非法規。' },
    { label: '台灣公債長期年度報酬序列', value: '未收錄', status: 'unverified', basis: '沒有可逐年驗證的公開官方序列，所以歷史模式的債券只能用美國 10 年期公債的模型化報酬替代。這是本工具明講的缺口，不是可以拿別的數字填的空格。' },
  );

  for (const r of rows) {
    tb.appendChild(el('tr', {}, [
      el('td', { text: r.label }),
      el('td', { text: r.value }),
      el('td', {}, [el('span', {
        class: 'chip' + (r.status === 'verified' ? ' chip--on' : ''),
        text: r.status === 'verified' ? '已查證' : '未查證',
      })]),
      el('td', {}, [
        el('span', { text: (r.basis || '') + ' ' }),
        r.url ? el('a', { href: r.url, target: '_blank', rel: 'noopener', text: '法源' }) : null,
      ]),
    ]));
  }

  const bad = rows.filter((r) => r.status !== 'verified').length;
  const badge = $('#unverifiedBadge');
  badge.textContent = bad ? `未查證 ${bad} 項` : '全部已查證';
  badge.classList.toggle('chip--on', bad === 0);
  badge.title = bad ? '這幾項是模型假設，不是事實，全部可以在左欄改掉。' : '';
}

/* ==========================================================================
   17. 總繪製
   ========================================================================== */
function renderProfileNote() {
  const c = P.completeness();
  const mine = PROFILE_KEYS.filter((k) => P.has(k)).length;
  const note = $('#profileNote');
  if (mine) {
    note.innerHTML = `這些數字用的是你在首頁填過的資料：這一頁需要的 ${PROFILE_KEYS.length} 格裡你已經填了 <b>${mine}</b> 格`
      + `（整份檔案 ${c.filled} 格）。剩下的只會在需要它的那一段就地問你。`;
  } else {
    note.textContent = '你還沒有財務檔案，下面每一個數字都是範例值。改動任何一格就會存進這台裝置，其他工具不會再問你一次。';
  }
}

function syncInputs() {
  const s = S();
  sLife.set(p('planToAge'), { silent: true });
  sAgeRetire.set(p('retireAge'), { silent: true });
  fSalary36.set(Number.isFinite(s.salary36) ? s.salary36 : Math.min(p('insuredSalary'), K.insuredSalaryMax), { silent: true });
  fCpi.set(s.cpi, { silent: true });
  fPenRetire.set(s.penRetireManual == null ? '' : s.penRetireManual, { silent: true });
  segSystem.set(s.system);
  segCut.set(String(s.cut));
  segStrategy.set(s.strategy);
  segMode.set(s.mode);
  segPool.set(s.pool);
  segInfl.set(s.inflMode);
  sStock.set(s.stock, { silent: true });
  sBond.set(s.bond, { silent: true });
  sInfl.set(s.infl, { silent: true });
  sCrash.set(s.crashDepth, { silent: true });
  $('#sw-cpi').querySelector('input').checked = !!s.cpiOn;
  $('#crashOn').checked = !!s.crashOn;
  $('#preciseOn').checked = !!s.precise;
  $('#cpiLabor').checked = s.cpiLabor !== false;
  $('#cpiRetire').checked = !!s.cpiRetire;
  $('.crash-set').dataset.on = String(!!s.crashOn);
  paintAlloc();
  paintStrategyHint();
  paintInflHint();
  renderAdvanced();
}

/** 重算模型 + 重畫兩段共用的部分。模擬本身另外排程，因為它比較貴。 */
function renderAll() {
  raceModel = buildRace();
  renderProfileNote();
  renderRace();
  renderFloorRows();
  renderRaceFormula();
  renderFloorHints();
  renderHeadline();
}

function renderFloorHints() {
  // 專戶餘額還沒填時，勞退那一層是 0，這件事要說出來而不是靜靜當成 0
  const has = P.has('pensionAccount');
  $('#askAccount').hidden = false;
  const note = $('#floorRows');
  if (!has && !isDemoSilent) note.dataset.demo = '1';
}
const isDemoSilent = true;

/* ==========================================================================
   18. 啟動
   ========================================================================== */
function refuseAll(why) {
  $('#verdict-h').textContent = '這個問題現在回答不了';
  $('#verdictBody').textContent = why;
  $('#verdictStamp').hidden = false;
  $('#verdictStamp').innerHTML = '<span class="stamp stamp--void">資料未載入</span>';
  $('#panel-race').hidden = true;
  $('#panel-fan').hidden = true;
  $('#tabs').hidden = true;
}

async function boot() {
  const grab = async (path) => { try { const r = await fetch(path); return r.ok ? await r.json() : null; } catch { return null; } };
  const [law, returns] = await Promise.all([
    grab('../../assets/data/tw-labor-pension.json'),
    grab('../../assets/data/tw-returns.json'),
  ]);

  if (!law) {
    $('#dataver').textContent = '資料版本 離線';
    refuseAll('勞保老年給付的法規常數放在 assets/data/tw-labor-pension.json，這個檔案現在載不進來。'
      + '沒有那份常數就沒有 A 式、B 式與請領年齡對照表，這一頁不會用寫死的備份值算給你看。');
    return;
  }

  LAW = law;
  DATA = returns;
  K = {
    version: law.version,
    formulaARatePct: law.formulaA.ratePct,
    formulaAAddon: law.formulaA.addon,
    formulaBRatePct: law.formulaB.ratePct,
    deferPerYearPct: law.deferred.perYearPct,
    deferMaxPct: law.deferred.maxPct,
    earlyPerYearPct: law.early.perYearPct,
    earlyMaxPct: law.early.maxPct,
    maxShiftYears: law.deferred.maxYears,
    minInsuredYears: law.annuityMinYears,
    avgSalaryMonthsAnnuity: law.avgSalaryMonthsAnnuity,
    avgSalaryMonthsLegacy: law.avgSalaryMonthsLegacyLumpsum,
    insuredSalaryMax: law.insuredSalary.max,
    grades: law.insuredSalary.grades,
    lumpsumMonthsPerYear: law.lumpsum.oldAgeLumpsumMonthsPerYear,
    legacyMonthsFirst15: law.lumpsum.legacyMonthsFirst15,
    legacyMonthsAfter15: law.lumpsum.legacyMonthsAfter15,
    legacyMonthsCap: law.lumpsum.legacyMonthsCap,
    cpiThresholdPct: law.cpiAdjust.thresholdPct,
    laborPensionRatePct: law.laborPensionMonthlyAnnuityInterestRatePct,
    claimAges: (law.claimAgeByBirthYear || []).map((r) => ({
      ...parseBirthRange(r.birthYearROC), legalAge: r.legalAge, earliestAge: r.earliestAge,
    })),
  };
  DEMO.insuredSalary = K.insuredSalaryMax;

  $('#dataver').textContent = `資料版本 ${law.version}`;
  $('#dataver').title = law.note || '';
  $('#dataver2').textContent = `勞保 ${law.version}${DATA ? `．序列 ${DATA.version}（查證於 ${DATA.verifiedAt}）` : '．序列未載入'}`;

  mountAsks();
  P.subscribe(() => {
    refreshAsks();
    // 檔案裡的欄位跟這一頁的滑桿是同一個數字，改了要同步回去
    sLife.set(p('planToAge'), { silent: true });
    sAgeRetire.set(p('retireAge'), { silent: true });
    renderAll();
    scheduleSim();
  });

  syncInputs();
  renderSources();
  legendHTML($('#fanLegend'), [
    { label: '中間 50%', color: cssv('--accent'), band: true },
    { label: '10 到 90%', color: cssv('--accent'), band: true },
    { label: '中位路徑', color: cssv('--accent') },
    { label: '歸零', color: cssv('--up') },
  ]);

  renderAll();
  selectTab(S().tab === 'fan' ? 'fan' : 'race');

  // 首屏就是論點：第一段載入即自動跑一次賽跑，第二段的模擬同時開始
  runRace(raceModel);
  runSim();

  printRows($$('#readouts .readout'), { stagger: 0.06, delay: 0.12 });

  if (store.cameFromLink) toast('已載入別人傳給你的情境');
}

window.addEventListener('resize', () => {
  clearTimeout(window.__rz);
  window.__rz = setTimeout(() => {
    if (!raceModel?.eligible || S().tab !== 'race') return;
    layoutCrossTags(raceModel);
    layoutLifeTag(raceModel);
  }, 200);
});

boot();
