/* 存款利息實拿試算。
 *
 * 這一頁跟市面上所有「數位帳戶利率比較」最大的差別：**這裡沒有任何一家銀行的牌告**。
 * 理由不是懶，是責任。牌告每個月都在動，內建的那一刻就開始過期，
 * 而拿過期的牌告去排「哪一家最高」，在公平交易法第 21 條底下就是引人錯誤之表示。
 * 所以利率一律由使用者自己抄進來，這一頁只負責把三件他算不出來的事算對：
 *
 *   1. 級距崩塌。高利率都有金額上限，超過的那一塊直接掉回牌告。
 *      決定你實拿多少的不是「最高利率」，是「你的第二塊錢利率」。
 *   2. 補充保費死區。利息**單次給付**達 2 萬元是按**全額**計費，不是只算超過的部分。
 *      所以門檻上方有一段區間，你領得比較多、實拿反而比較少。
 *   3. 稅的連動。購屋借款利息扣除額要先扣掉你實際申報的儲蓄投資特別扣除額，
 *      多賺的利息有一部分是從房貸扣除額裡挖來的。多數人不知道這兩格是連動的。
 *
 * 計算檔案不 import partners.js。這是刻意的：分潤設定與試算結果在程式碼層級就不相通。
 */

import { printRows, stampIn, makeCounter, revealOnScroll, still } from '../../assets/js/core/motion.js';
import { Plot } from '../../assets/js/core/plot.js';
import { nhiSupplement } from '../../assets/js/core/fin.js';
import {
  $, el, bindSlider, bindField, bindSegmented, createPlies,
  mountTopbar, mountTheme, mountShare, formulaBlock, iconHTML,
} from '../../assets/js/core/ui.js';
import { int, dec, pp, parseNum, clamp } from '../../assets/js/core/format.js';
import { createStore } from '../../assets/js/core/state.js';
import * as P from '../../assets/js/core/profile.js';
import { loadPartners, matchByName, outbound, mountDisclosure } from '../../assets/js/core/partners.js';

/* ==========================================================================
   常數。全部來自 assets/data，載不到就拒答，不用寫死的備份值。
   ========================================================================== */
let NHI = null;
let TAX = null;
let TAXY = null;
let TAXYEAR = null;

const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const SERIES = ['--series-1', '--series-2', '--series-3', '--series-4'];
const clone = (x) => JSON.parse(JSON.stringify(x));

/* ==========================================================================
   狀態
   ========================================================================== */

/* 預設值刻意用「甲／乙」而不是任何真實銀行名稱。
   一旦寫了銀行名就等於對那家做了利率陳述，而那個陳述明天就會過期。 */
const DEFAULTS = {
  total: 1000000,
  freq: 2,
  otherInterest: 0,
  mortgageInterest: 0,
  accts: [
    { name: '甲帳戶', tiers: [{ upTo: 100000, rate: 2 }], rest: 0.6 },
    { name: '乙帳戶', tiers: [{ upTo: 300000, rate: 1.2 }], rest: 0.6 },
  ],
};

const store = createStore('vm:deposit-yield', DEFAULTS);
const S = () => store.get();

const SCEN = {};      // 各聯的狀態快照
let curPly = 1;

/* ==========================================================================
   核心計算
   ========================================================================== */

/**
 * 把一家帳戶攤成由低到高的位置區段。
 * 順序就是實際適用順序：你的第一塊錢一定先吃第一段，這不是你能選的。
 */
function segmentsOf(a, acctIndex) {
  const segs = [];
  let prev = 0;
  const tiers = (a.tiers || [])
    .map((t) => ({ upTo: Number(t.upTo), rate: Number(t.rate) }))
    .filter((t) => Number.isFinite(t.upTo) && t.upTo > 0 && Number.isFinite(t.rate) && t.rate >= 0)
    .sort((x, y) => x.upTo - y.upTo);

  for (const t of tiers) {
    const w = t.upTo - prev;
    if (w > 0.5) segs.push({ acct: acctIndex, rate: t.rate, width: w, from: prev, to: t.upTo, rest: false });
    prev = Math.max(prev, t.upTo);
  }
  // 超過的部分永遠存在（哪怕是 0%），這樣錢一定放得下，不會憑空消失
  const rest = Number(a.rest);
  segs.push({
    acct: acctIndex,
    rate: Number.isFinite(rest) && rest > 0 ? rest : 0,
    width: Infinity, from: prev, to: Infinity, rest: true,
  });
  return segs;
}

/** 這家的級距是不是「越後面利率越高」。是的話貪婪法就不保證最佳，畫面上要講。 */
function isAscending(a, i) {
  const s = segmentsOf(a, i);
  for (let k = 1; k < s.length; k++) if (s[k].rate > s[k - 1].rate + 1e-9) return true;
  return false;
}

/**
 * 配置。每次挑「目前可用的段裡利率最高的那一段」填到滿。
 *
 * 為什麼這樣是對的：段與段之間沒有整數限制，錢可以任意切分，
 * 而且各家帳戶的高利額度互相獨立。在每家級距都是由高往低的前提下
 * （台灣數位帳戶幾乎都是這個形狀），這個貪婪解就是最佳解——
 * 任何把錢從高利段挪到低利段的調整都只會讓總利息變少。
 *
 * 「目前可用」這個限制是真的存在的：同一家裡面，第二段要等第一段填滿才適用，
 * 你不能跳過第一段直接享受第二段。所以這裡用指標逐段推進，而不是把全部段落攤平排序。
 */
function walk(accts, budget) {
  const bySeg = accts.map((a, i) => segmentsOf(a, i));
  const ptr = bySeg.map(() => 0);
  const taken = [];
  let left = Math.max(0, budget);
  let guard = 0;

  const pickNext = () => {
    let bi = -1, br = -Infinity;
    for (let i = 0; i < bySeg.length; i++) {
      const s = bySeg[i][ptr[i]];
      if (s && s.rate > br + 1e-12) { br = s.rate; bi = i; }
    }
    return bi;
  };

  while (left > 0.5 && guard++ < 500) {
    const bi = pickNext();
    if (bi < 0) break;
    const s = bySeg[bi][ptr[bi]];

    // 剩下的錢要進「超過上限的部分」時，如果有好幾家的牌告利率剛好一樣，就平分。
    // 利息一模一樣（同一個利率），但每一家的單次入帳都變小，比較不容易踩到補充保費門檻。
    // 把餘額全部堆在其中一家是隨機的，而那個隨機會害人多繳錢。
    if (!Number.isFinite(s.width)) {
      const tied = [];
      for (let i = 0; i < bySeg.length; i++) {
        const t = bySeg[i][ptr[i]];
        if (t && !Number.isFinite(t.width) && Math.abs(t.rate - s.rate) < 1e-12) tied.push(t);
      }
      const each = left / tied.length;
      tied.forEach((t) => taken.push({ ...t, put: each }));
      left = 0;
      break;
    }

    const put = Math.min(left, s.width);
    taken.push({ ...s, put });
    left -= put;
    if (put >= s.width - 1e-9) ptr[bi]++; else break;
  }

  const ni = pickNext();
  return {
    taken,
    marginal: ni >= 0 ? bySeg[ni][ptr[ni]].rate : null,
    marginalAcct: ni,
    interest: taken.reduce((n, s) => n + s.put * s.rate / 100, 0),
  };
}

/** 全押一家：把全部的錢只放進某一家，取結果最好的那家 */
function bestSingle(accts, total) {
  let best = null;
  accts.forEach((a, i) => {
    const r = walk([a], total);
    if (!best || r.interest > best.interest) best = { acct: i, interest: r.interest, taken: r.taken };
  });
  return best || { acct: -1, interest: 0, taken: [] };
}

function compute() {
  const s = S();
  const accts = s.accts || [];
  const total = Math.max(0, Number(s.total) || 0);
  const freq = Math.max(1, Number(s.freq) || 1);

  const w = walk(accts, total);
  const single = bestSingle(accts, total);

  // 每家各自的利息 → 每次入帳 → 該家的補充保費（扣費是各家各自按單次給付認定的）
  const perAcct = accts.map((a, i) => {
    const segs = w.taken.filter((t) => t.acct === i);
    const put = segs.reduce((n, t) => n + t.put, 0);
    const interest = segs.reduce((n, t) => n + t.put * t.rate / 100, 0);
    const payout = interest / freq;
    const premiumPer = nhiSupplement(payout, {
      rate: NHI.rate, floor: NHI.thresholds.interest, cap: NHI.singlePaymentCap,
    });
    return {
      i, name: a.name || `第 ${i + 1} 家`, segs, put, interest, payout,
      premiumPer, premium: premiumPer * freq,
      blended: put > 0 ? interest / put * 100 : 0,
    };
  });

  const interest = w.interest;
  const premium = perAcct.reduce((n, x) => n + x.premium, 0);
  const gain = interest - single.interest;

  return {
    total, freq, accts, taken: w.taken, marginal: w.marginal, marginalAcct: w.marginalAcct,
    interest, single, gain, perAcct, premium,
    net: interest - premium,
    effective: total > 0 ? interest / total * 100 : 0,
    topRate: Math.max(0, ...accts.flatMap((a, i) => segmentsOf(a, i).map((x) => x.rate))),
    ascending: accts.map((a, i) => isAscending(a, i)).some(Boolean),
    ready: accts.length > 0 && accts.some((a, i) => segmentsOf(a, i).some((x) => x.rate > 0)),
  };
}

/** 補充保費死區：門檻到「扣完之後才追平門檻前一元」的那個金額 */
function deadZone() {
  const floor = NHI.thresholds.interest;
  return { floor, upper: floor / (1 - NHI.rate) };
}

/* ==========================================================================
   版面
   ========================================================================== */
mountTopbar({ title: '存款利息實拿試算' });
mountTheme($('#sheetActions'));
mountShare($('#sheetActions'), store);

const plot = new Plot($('#stair'), {
  aspect: 0.46,
  minHeight: 200,
  maxHeight: 320,
  yFormat: (v) => dec(v, 2) + '%',
  xFormat: (v) => (v >= 10000 ? Math.round(v / 10000) + '萬' : String(Math.round(v))),
  padding: { left: 54, bottom: 28, top: 16, right: 14 },
});

const cSplit = makeCounter($('#r-split'), (v) => int(v) + ' 元');
const cSingle = makeCounter($('#r-single'), (v) => int(v) + ' 元');
const cGain = makeCounter($('#r-gain'), (v) => int(v) + ' 元');

let stamped = null;

/* ---- 輸入綁定 ---------------------------------------------------------- */
const fTotal = bindField($('#f-total'), {
  pretty: int,
  validate: (v) => (!Number.isFinite(v) || v < 0 ? '請填一個不是負數的金額' : null),
  onChange: (v, { valid, source }) => {
    if (!valid) return;
    store.set({ total: v });
    P.set({ savings: v });                 // 寫回共用檔案，其他工具不用再問一次
    if (source !== 'set') sTotal.set(clamp(Math.round(v / 10000), 0, 1000), { silent: true });
    render();
  },
});

const sTotal = bindSlider($('#s-total'), {
  format: (v) => (v >= 10000 ? `${dec(v / 10000, 2)}<small>億</small>` : `${int(v)}<small>萬</small>`),
  onInput: (v, source) => {
    if (source === 'set') return;
    const total = v * 10000;
    store.set({ total });
    fTotal.set(total, { silent: true });
    render();
  },
});

const segFreq = bindSegmented($('#seg-freq'), {
  onChange: (v) => { store.set({ freq: Number(v) }); render(); },
});

const fOther = bindField($('#f-otherInterest'), {
  pretty: int,
  onChange: (v, { source }) => {
    const n = Number.isFinite(v) ? v : 0;
    store.set({ otherInterest: n });
    P.set({ interestIncome: n });
    if (source !== 'set') render();
  },
});

const fMortgage = bindField($('#f-mortgageInterest'), {
  pretty: int,
  onChange: (v, { source }) => {
    const n = Number.isFinite(v) ? v : 0;
    store.set({ mortgageInterest: n });
    P.set({ mortgageInterestPaid: n });
    if (source !== 'set') render();
  },
});

$('#addAcct').addEventListener('click', () => {
  const accts = clone(S().accts);
  if (accts.length >= 4) return;
  accts.push({ name: `第 ${accts.length + 1} 家`, tiers: [{ upTo: 100000, rate: 0 }], rest: 0 });
  store.set({ accts });
  renderAccounts(); render();
});

/* 只給金額形狀，不給利率。給了利率就等於對某一家做了陳述。 */
const SHAPES = [100000, 300000, 500000, 1000000];
let shapeIdx = 0;
$('#addShape').addEventListener('click', () => {
  const accts = clone(S().accts);
  if (accts.length >= 4) return;
  const cap = SHAPES[shapeIdx % SHAPES.length];
  shapeIdx++;
  accts.push({ name: '', tiers: [{ upTo: cap, rate: 0 }], rest: 0 });
  store.set({ accts });
  renderAccounts(); render();
});

$('#resetBtn').addEventListener('click', () => {
  store.reset();
  syncInputs(); renderAccounts(); render();
});

createPlies($('#plies'), {
  labels: ['第一聯', '第二聯', '第三聯', '第四聯'],
  onAdd: (id) => { SCEN[curPly] = clone(S()); SCEN[id] = clone(S()); curPly = id; },
  onSwitch: (id) => {
    SCEN[curPly] = clone(S());
    curPly = id;
    store.replace(clone(SCEN[id] || DEFAULTS));
    syncInputs(); renderAccounts(); render();
  },
  onRemove: (id, active) => {
    delete SCEN[id];
    curPly = active;
    if (SCEN[active]) store.replace(clone(SCEN[active]));
    syncInputs(); renderAccounts(); render();
  },
});

function syncInputs() {
  const s = S();
  fTotal.set(s.total, { silent: true });
  sTotal.set(clamp(Math.round(s.total / 10000), 0, 1000), { silent: true });
  segFreq.set(String(s.freq));
  fOther.set(s.otherInterest || 0, { silent: true });
  fMortgage.set(s.mortgageInterest || 0, { silent: true });
}

/* ==========================================================================
   帳戶列：結構改變時才重建 DOM，打字時只改狀態，不然游標會被沖掉
   ========================================================================== */
function numInput(value, { unit, label, wide = false, decimals = false, onInput }) {
  const input = el('input', {
    type: 'text',
    inputmode: decimals ? 'decimal' : 'numeric',
    value: value === '' || value == null ? '' : (decimals ? String(value) : int(value)),
    'aria-label': label,
    oninput: (e) => onInput(parseNum(e.target.value, NaN)),
    onblur: (e) => {
      const v = parseNum(e.target.value, NaN);
      if (Number.isFinite(v)) e.target.value = decimals ? String(v) : int(v);
    },
  });
  return el('label', { class: 'field' + (wide ? '' : ' field--compact') }, [
    el('span', { class: 'field__label', text: label }),
    el('span', { class: 'field__control' }, [
      input,
      unit ? el('span', { class: 'field__unit', text: unit }) : null,
    ]),
  ]);
}

function renderAccounts() {
  const host = $('#acctRows');
  host.replaceChildren();
  const accts = S().accts || [];

  accts.forEach((a, i) => {
    const color = cssv(SERIES[i % SERIES.length]);

    const nameInput = el('input', {
      type: 'text',
      value: a.name || '',
      placeholder: `第 ${i + 1} 家`,
      'aria-label': '帳戶名稱',
      oninput: (e) => { const n = clone(S().accts); n[i].name = e.target.value; store.set({ accts: n }); },
      onchange: () => { renderAlloc(compute()); refreshLinks(); },
    });

    const tiers = el('div', { class: 'acct__tiers' });
    (a.tiers || []).forEach((t, k) => {
      const prevCap = k > 0 ? Number(a.tiers[k - 1].upTo) : 0;
      tiers.appendChild(el('div', { class: 'acct__tier' }, [
        numInput(t.upTo, {
          unit: '元',
          label: k === 0 ? '高利上限到' : `第 ${k + 1} 段到`,
          onInput: (v) => { const n = clone(S().accts); n[i].tiers[k].upTo = v; store.set({ accts: n }); render(); },
        }),
        numInput(t.rate, {
          unit: '%', decimals: true,
          label: k === 0 ? '這一段年利率' : `第 ${k + 1} 段年利率`,
          onInput: (v) => { const n = clone(S().accts); n[i].tiers[k].rate = v; store.set({ accts: n }); render(); },
        }),
        (a.tiers.length > 1
          ? el('button', {
            type: 'button', class: 'row__del', 'aria-label': '刪除這一段', html: iconHTML('close'),
            onclick: () => { const n = clone(S().accts); n[i].tiers.splice(k, 1); store.set({ accts: n }); renderAccounts(); render(); },
          })
          : el('span', { class: 'field__hint', text: prevCap ? '' : '' })),
      ]));
    });

    const linkHost = el('span', { class: 'acct__link', dataset: { acct: String(i) } });

    host.appendChild(el('div', { class: 'acct', style: `border-left-color:${color}` }, [
      el('div', { class: 'acct__head' }, [
        el('span', { class: 'acct__swatch', style: `background:${color}` }),
        el('label', { class: 'field field--compact' }, [
          el('span', { class: 'field__label', text: '這一家叫什麼' }),
          el('span', { class: 'field__control' }, [nameInput]),
        ]),
        (accts.length > 1
          ? el('button', {
            type: 'button', class: 'row__del', 'aria-label': `刪除${a.name || '這一家'}`, html: iconHTML('close'),
            onclick: () => { const n = clone(S().accts); n.splice(i, 1); store.set({ accts: n }); renderAccounts(); render(); },
          })
          : null),
      ]),
      el('div', { class: 'acct__body' }, [
        tiers,
        el('div', { class: 'acct__rest' }, [
          numInput(a.rest, {
            unit: '%', decimals: true, label: '超過上限的部分',
            onInput: (v) => { const n = clone(S().accts); n[i].rest = v; store.set({ accts: n }); render(); },
          }),
          el('span', { class: 'field__hint', text: '通常就是這家的一般活儲牌告' }),
        ]),
        el('div', { class: 'acct__foot' }, [
          el('button', {
            type: 'button', class: 'btn btn--quiet btn--sm', text: '再加一段級距',
            onclick: () => {
              const n = clone(S().accts);
              const last = n[i].tiers[n[i].tiers.length - 1];
              n[i].tiers.push({ upTo: (Number(last?.upTo) || 100000) * 3, rate: 0 });
              store.set({ accts: n }); renderAccounts(); render();
            },
          }),
          linkHost,
        ]),
      ]),
    ]));
  });

  refreshLinks();
}

/** 只有使用者自己打出來的機構名稱才會出現離站連結。本站不主動推薦任何一家。 */
function refreshLinks() {
  const accts = S().accts || [];
  accts.forEach((a, i) => {
    const host = $(`.acct__link[data-acct="${i}"]`);
    if (!host) return;
    host.replaceChildren();
    const id = matchByName(a.name);
    if (!id) return;
    const link = outbound(id, { text: `${a.name} 官網`, class: 'btn btn--ghost btn--sm' });
    if (link) host.appendChild(link);
  });
  mountDisclosure($('#discloseHost'));
}

/* ==========================================================================
   繪製
   ========================================================================== */
function render() {
  if (!NHI || !TAX) return;
  const c = compute();

  cSplit(c.interest);
  cSingle(c.single.interest);
  cGain(c.gain);

  const gpp = c.total > 0 ? c.gain / c.total * 100 : 0;
  const d = $('#r-gainPct');
  d.textContent = c.gain > 0.5 ? `年化多 ${dec(gpp, 3)} 個百分點` : '拆單沒有幫助';
  d.dataset.dir = c.gain > 0.5 ? 'up' : 'flat';

  $('#r-marginal').textContent = c.marginal == null ? '—' : pp(c.marginal, 3);

  renderVerdict(c);
  renderStair(c);
  renderAlloc(c);
  renderCliff(c);
  renderTax(c);
  renderFormula(c);
}

function renderVerdict(c) {
  const lead = $('#verdict-h');
  const body = $('#verdictBody');
  const stamp = $('#verdictStamp');
  const dz = deadZone();

  if (!c.ready) {
    lead.textContent = '先填一家帳戶的級距';
    body.textContent = '填「高利上限」跟「上限內的年利率」，這裡就會告訴你錢該怎麼放。';
    stamp.hidden = true; stamped = null;
    return;
  }

  const dead = c.perAcct.filter((x) => x.payout >= dz.floor && x.payout <= dz.upper);
  const charged = c.perAcct.filter((x) => x.premiumPer > 0);

  if (c.gain > 0.5) {
    lead.innerHTML = `拆開放，全年多拿 <em>${int(c.gain)}</em> 元。`;
  } else if (c.accts.length < 2) {
    lead.innerHTML = `只填了一家，<em>沒有東西可以比較</em>。`;
  } else if (c.marginal != null && c.topRate - c.marginal < 0.001) {
    lead.innerHTML = `你的錢都還在最高利的那一段裡，<em>不用拆</em>。`;
  } else {
    lead.innerHTML = `現在這樣放<em>已經是最好的配置</em>了。`;
  }

  const parts = [];

  if (c.marginal != null && c.topRate - c.marginal > 0.001) {
    parts.push(`你看到的最高利率是 ${pp(c.topRate, 3)}，但你的下一塊錢只拿得到 ${pp(c.marginal, 3)}——`
      + `高利額度已經被填滿了。整筆平均下來的實質年利率是 ${pp(c.effective, 3)}。`);
  } else if (c.marginal != null) {
    parts.push(`你的錢還在最高利的那一段裡，下一塊錢一樣拿 ${pp(c.marginal, 3)}。`);
  }

  if (c.gain > 0.5) {
    parts.push(`同樣 ${int(c.total)} 元，全押最高利那家只有 ${int(c.single.interest)} 元；`
      + `按上限拆開放是 ${int(c.interest)} 元。多出來的 ${int(c.gain)} 元不是投資報酬，只是把錢放對格子。`);
  }

  if (dead.length) {
    parts.push(`但先處理這件事：${dead.map((x) => x.name).join('、')}每次入帳 `
      + `${int(dead[0].payout)} 元，剛好落在補充保費死區裡——`
      + `扣完 ${int(dead[0].premiumPer)} 元之後實拿 ${int(dead[0].payout - dead[0].premiumPer)} 元，`
      + `比只領 ${int(dz.floor - 1)} 元還少。`);
  } else if (charged.length) {
    parts.push(`補充保費會被扣走 ${int(c.premium)} 元（${charged.map((x) => x.name).join('、')}的單次給付達 ${int(dz.floor)} 元），`
      + `所以實拿是 ${int(c.net)} 元。`);
  } else if (c.interest > 0) {
    parts.push(`每一家的單次入帳都在 ${int(dz.floor)} 元以下，不會被扣補充保費，${int(c.interest)} 元全部是你的。`);
  }

  body.textContent = parts.join('');

  stamp.hidden = false;
  const key = `${dead.length}:${charged.length}:${Math.round(c.gain)}:${Math.round(c.interest)}`;
  if (stamped !== key) {
    const bad = dead.length > 0;
    stamp.innerHTML = `<span class="stamp${bad ? ' stamp--void' : ''}">${bad ? '踩到死區' : (c.gain > 0.5 ? '值得拆' : '照原樣')}</span>`;
    stampIn(stamp.firstElementChild);
    stamped = key;
  }
}

function renderStair(c) {
  const accts = c.accts;
  const capSum = accts.reduce((n, a, i) => n
    + segmentsOf(a, i).filter((s) => Number.isFinite(s.width)).reduce((m, s) => m + s.width, 0), 0);
  const xMax = Math.max(c.total * 1.3, capSum * 1.3, 200000);

  const full = walk(accts, xMax);

  // 幽靈階梯：整條形狀，包含每一階往下掉的那一豎
  const ghost = [];
  let x = 0;
  for (const s of full.taken) {
    ghost.push({ x, y: s.rate });
    x += s.put;
    ghost.push({ x, y: s.rate });
  }

  // 各家自己的顏色橫槓：一眼看得出這一段錢是誰在收
  const perAcct = accts.map(() => []);
  x = 0;
  for (const s of full.taken) {
    const arr = perAcct[s.acct];
    if (arr) { arr.push({ x, y: s.rate }, { x: x + s.put, y: s.rate }, { x: x + s.put, y: NaN }); }
    x += s.put;
  }

  const series = [
    { type: 'step', data: ghost, color: cssv('--ghost'), width: 1.25, noCursor: true },
    ...perAcct.map((data, i) => ({
      type: 'line', data, color: cssv(SERIES[i % SERIES.length]), width: 3.5, noCursor: true,
    })),
  ];

  // 其他聯的鬼影：複寫單據的整個意義就是並排比較
  for (const [id, snap] of Object.entries(SCEN)) {
    if (Number(id) === curPly || !snap?.accts) continue;
    const w2 = walk(snap.accts, xMax);
    const pts = []; let gx = 0;
    for (const s of w2.taken) {
      pts.push({ x: gx, y: s.rate });
      gx += s.put;
      pts.push({ x: gx, y: s.rate });
    }
    series.push({ type: 'step', data: pts, color: cssv('--ghost'), width: 1, dash: [4, 3], noCursor: true });
  }

  const maxRate = Math.max(0.5, ...full.taken.map((s) => s.rate));
  plot.setSeries(series, { animate: false });
  plot.setDomain({ x0: 0, x1: xMax, y0: 0, y1: maxRate * 1.18 });
  plot.setMarks([{
    axis: 'x', value: c.total, color: cssv('--accent'), dash: [4, 3],
    label: `你的 ${int(c.total)} 元`,
  }]);

  const legend = $('#legend');
  legend.replaceChildren();
  accts.forEach((a, i) => {
    legend.appendChild(el('span', { class: 'legend__item' }, [
      el('span', { class: 'legend__key', style: `background:${cssv(SERIES[i % SERIES.length])}` }),
      el('span', { text: a.name || `第 ${i + 1} 家` }),
    ]));
  });

  $('#stairDesc').textContent =
    `橫軸是累計放進去的金額，縱軸是那一塊錢適用的年利率。每一階往下掉，就是一段高利額度被填滿。`
    + (c.marginal != null
      ? `你的 ${int(c.total)} 元停在 ${pp(c.marginal, 3)} 這一階上，這就是你下一塊錢的利率。`
      : '')
    + (Object.keys(SCEN).length > 1 ? '虛線是其他聯的情境。' : '');
}

function renderAlloc(c) {
  const tb = $('#allocRows');
  const tf = $('#allocFoot');
  tb.replaceChildren(); tf.replaceChildren();
  const dz = deadZone();
  const maxPut = Math.max(1, ...c.perAcct.map((x) => x.put));

  const describe = (segs) => segs.map((s) => {
    const where = s.rest
      ? (s.from > 0 ? `超過 ${int(s.from)} 的部分` : '全額')
      : (s.from > 0 ? `${int(s.from)}–${int(s.to)}` : `前 ${int(s.to)}`);
    return `${where} ${pp(s.rate, 3)}`;
  }).join('、');

  c.perAcct.forEach((x, i) => {
    if (x.put <= 0.5) return;
    const inDead = x.payout >= dz.floor && x.payout <= dz.upper;
    const color = cssv(SERIES[i % SERIES.length]);
    tb.appendChild(el('tr', { dataset: inDead ? { dead: 'true' } : {} }, [
      el('td', {}, [
        el('span', { class: 'legend__key', style: `background:${color};display:inline-block;margin-right:6px` }),
        el('b', { text: x.name }),
        el('div', { class: 'field__hint', text: describe(x.segs), style: 'margin:2px 0 0' }),
      ]),
      el('td', { class: 'num' }, [
        el('span', { text: int(x.put) }),
        el('span', { class: 'bar' }, [el('span', { style: `width:${x.put / maxPut * 100}%;background:${color}` })]),
      ]),
      el('td', { class: 'num', text: pp(x.blended, 3) }),
      el('td', { class: 'num', text: int(x.interest) }),
      el('td', { class: 'num', text: int(x.payout) }),
      el('td', { class: 'num', text: x.premium > 0 ? `−${int(x.premium)}` : '0' }),
    ]));
  });

  if (!tb.children.length) {
    tb.appendChild(el('tr', {}, [el('td', { colspan: '6', class: 'field__hint', text: '還沒有可以配置的金額。' })]));
  }

  tf.appendChild(el('tr', {}, [
    el('td', { text: '合計' }),
    el('td', { class: 'num', text: int(c.perAcct.reduce((n, x) => n + x.put, 0)) }),
    el('td', { class: 'num', text: pp(c.effective, 3) }),
    el('td', { class: 'num', text: int(c.interest) }),
    el('td', { class: 'num', text: '—' }),
    el('td', { class: 'num', text: c.premium > 0 ? `−${int(c.premium)}` : '0' }),
  ]));
  tf.appendChild(el('tr', {}, [
    el('td', { text: '實拿' }),
    el('td', { class: 'num', text: '—' }),
    el('td', { class: 'num', text: c.total > 0 ? pp(c.net / c.total * 100, 3) : '—' }),
    el('td', { class: 'num' }, [el('b', { text: int(c.net) })]),
    el('td', { class: 'num', text: '—' }),
    el('td', { class: 'num', text: '—' }),
  ]));

  const foot = $('#allocFootNote');
  foot.replaceChildren();
  foot.appendChild(el('p', { class: 'field__hint', style: 'margin:0', html:
    `「適用利率」是這家帳戶裡各段加權平均後的實際利率，不是牌告上那個最大的數字。`
    + `補充保費是<b>各家銀行各自</b>按單次給付認定的，所以把錢拆到不同家，`
    + `本身就有機會讓每一筆都停在 ${int(deadZone().floor)} 元以下——這是拆單的第二個好處，`
    + `而且它通常比多出來的利息更值錢。`
    + (c.ascending
      ? `<br><b>注意：</b>你有一家的後段利率比前段高。這種階梯式級距下，`
        + `「先填滿利率高的那段」不成立（你得先把前段填滿才享受得到後段），`
        + `所以上面的配置是可行解，不保證是最佳解。`
      : '') }));
}

function renderCliff(c) {
  const dz = deadZone();
  const width = dz.upper - dz.floor;
  const lo = dz.floor * 0.85;
  const hi = dz.floor * 1.25;
  const span = hi - lo;
  const pctOf = (v) => (v - lo) / span * 100;

  $('#dzDead').style.flexBasis = `${width / span * 100}%`;
  $('.deadzone__seg--safe').style.flexBasis = `${pctOf(dz.floor)}%`;

  // 標記線畫的是「最大的那一筆單次入帳」，因為會不會被扣是由它決定的
  const top = c.perAcct.reduce((a, b) => (b.payout > (a?.payout ?? -1) ? b : a), null);
  const mark = $('#dzMark');
  if (top && top.payout > lo && top.payout < hi) {
    mark.hidden = false;
    mark.style.left = `${pctOf(top.payout)}%`;
    mark.dataset.label = `${top.name} ${int(top.payout)}`;
  } else {
    mark.hidden = true;
  }

  $('#dzLabels').innerHTML =
    `<span>${int(lo)}</span>`
    + `<span><b>起扣 ${int(dz.floor)}</b></span>`
    + `<span><b>死區到 ${int(Math.ceil(dz.upper))}</b>（寬 ${int(Math.ceil(dz.upper) - dz.floor)} 元）</span>`
    + `<span>${int(hi)}</span>`;

  const note = $('#cliffNote');
  note.replaceChildren();

  const dead = c.perAcct.filter((x) => x.payout >= dz.floor && x.payout <= dz.upper);
  const charged = c.perAcct.filter((x) => x.premiumPer > 0);

  if (dead.length) {
    const x = dead[0];
    // 要退出死區得把「單次入帳」壓到門檻以下 → 全年利息降到 floor × 次數以下
    const cut = Math.ceil((x.payout - (dz.floor - 1)) * c.freq);
    note.className = 'note note--stop';
    note.innerHTML =
      `<b>${x.name}每次入帳 ${int(x.payout)} 元，正好踩在死區裡。</b>`
      + `達 ${int(dz.floor)} 元是按<b>全額</b>計費，所以扣掉 ${int(x.premiumPer)} 元之後實拿 `
      + `${int(x.payout - x.premiumPer)} 元，比只領 ${int(dz.floor - 1)} 元（完全不用扣）還少了 `
      + `${int(dz.floor - 1 - (x.payout - x.premiumPer))} 元。`
      + `把這家的全年利息壓低 ${int(cut)} 元、或把其中一部分錢挪到別家，你反而多拿。`;
  } else if (charged.length) {
    note.className = 'note';
    note.innerHTML =
      `${charged.map((x) => `<b>${x.name}</b>每次入帳 ${int(x.payout)} 元，扣 ${int(x.premiumPer)} 元`).join('；')}。`
      + `已經超過死區了，扣繳是划算的——多領的還是比扣掉的多。`
      + `全年合計扣 ${int(c.premium)} 元，實拿 ${int(c.net)} 元。`;
  } else {
    note.className = 'note note--ok';
    note.innerHTML = c.interest > 0
      ? `<b>目前每一家的單次入帳都在 ${int(dz.floor)} 元以下，不會被扣補充保費。</b>`
        + `全年利息 ${int(c.interest)} 元完整入袋。`
      : `還沒有利息可以算。`;
  }

  const reform = NHI.annualSettlementReform;
  $('#cliffLede').innerHTML =
    `二代健保補充保費對利息所得的規則是：<b>單次給付達 ${int(dz.floor)} 元就按全額計費</b>，費率 ${pp(NHI.rate * 100, 2)}，`
    + `不是只算超過的部分。所以門檻上方有一段寬 ${int(Math.ceil(dz.upper) - dz.floor)} 元的區間，你領得比較多、實拿卻比較少。`
    + `你選的入帳頻率是<b>${{ 12: '每月', 4: '每季', 2: '半年', 1: '一次' }[c.freq]}</b>，`
    + `同樣的全年利息拆成越多次，每一次就越不容易碰到門檻。`
    + (reform ? `<br>（把利息改成年度結算的修法目前<b>${reform.status}</b>，資料時點 ${reform.asOf}，不要據以規劃。）` : '');
}

function renderTax(c) {
  const host = $('#taxBody');
  host.replaceChildren();

  const other = Number(S().otherInterest) || 0;
  const mort = Number(S().mortgageInterest) || 0;
  const cap = TAXY.savingsDeduction;
  const mcap = TAXY.mortgageInterestCap;

  const houseTotal = c.interest + other;
  const declared = Math.min(houseTotal, cap);
  const taxable = Math.max(0, houseTotal - cap);

  // 順序不能顛倒：先減掉實際申報的儲蓄投資特扣，為負則 0，最後才套 30 萬上限
  const mortAfter = Math.min(Math.max(0, mort - declared), mcap);
  const mortAlone = Math.min(mort, mcap);
  const crowded = mortAlone - mortAfter;

  const line = (label, value, mod = '') => el('div', { class: `taxline ${mod}` }, [
    el('span', { class: 'taxline__label', html: label }),
    el('span', { class: 'taxline__value num', text: value }),
  ]);

  host.appendChild(el('p', { class: 'field__hint', style: 'margin:0 0 var(--s-2)',
    text: `以下用 ${TAXY.label || TAXYEAR + ' 年度'}的額度計算。你現在存的錢，利息是明年五月才申報。` }));
  host.appendChild(line('全戶存款利息（本頁算出來的 ＋ 你填的其他利息）', int(houseTotal) + ' 元'));
  host.appendChild(line(`可用的儲蓄投資特別扣除額（每一申報戶上限 ${int(cap)}）`, int(declared) + ' 元', 'taxline--good'));
  host.appendChild(line('要併入綜合所得課稅的利息', int(taxable) + ' 元', taxable > 0 ? 'taxline--bad' : ''));

  if (mort > 0) {
    host.appendChild(el('h3', { style: 'margin:var(--s-5) 0 0;font-size:var(--t-base)', text: '這一格會被上面吃掉' }));
    host.appendChild(line('你實際支付的購屋借款利息', int(mort) + ' 元'));
    host.appendChild(line(`如果完全沒有利息所得，可列舉 min(${int(mort)}, ${int(mcap)})`, int(mortAlone) + ' 元'));
    host.appendChild(line('被實際申報的儲蓄投資特扣扣掉', crowded > 0 ? `−${int(crowded)} 元` : '0 元', crowded > 0 ? 'taxline--bad' : ''));
    host.appendChild(line('<b>實際可列舉的購屋借款利息</b>', int(mortAfter) + ' 元', 'taxline--total'));
  }

  const notes = [];
  if (crowded > 0) {
    notes.push(`你這一頁多賺的利息裡，有 <b>${int(crowded)} 元</b>其實是從購屋借款利息扣除額裡挖來的——`
      + `法定順序是「實際支付利息 − 實際申報之儲蓄投資特別扣除額」，為負則 0，`
      + `<b>最後</b>才套 ${int(mcap)} 元上限，不可以先封頂再減。這一格是全台灣最常被算錯的扣除額。`);
  }
  if (mort > 0) {
    notes.push(`購屋借款利息屬<b>列舉扣除額</b>，選用它就不能用標準扣除額`
      + `（單身 ${int(TAXY.standardSingle)}、夫妻 ${int(TAXY.standardMarried)}）。`
      + `列舉總額沒有大於標準扣除額的話，這一格其實用不到。另外它限自用住宅、已辦戶籍登記、以一屋為限。`);
  }
  if (taxable > 0) {
    notes.push(`超過 ${int(cap)} 元的部分要併入綜合所得總額，實際多繳多少要看你的邊際稅率，`
      + `完整試算在<a href="../invest-tax/">投資與稅</a>那一頁。`);
  } else if (houseTotal > 0) {
    // 「兩個年度金額相同」這件事要從常數檔讀出來確認，不能憑印象寫死
    const same = Object.values(TAX.years).every((y) => y.savingsDeduction === cap);
    notes.push(`全戶存款利息還在 ${int(cap)} 元的儲蓄投資特別扣除額額度內，這部分不用繳綜所稅。`
      + `這一格是<b>法定固定金額</b>，不隨消費者物價指數調整`
      + (same ? `——常數檔裡的 ${Object.keys(TAX.years).join(' 與 ')} 年度都是同一個數字。` : '。'));
  }

  notes.forEach((h) => host.appendChild(el('p', { class: 'field__hint', style: 'margin-top:var(--s-3)', html: h })));
}

function renderFormula(c) {
  const host = $('#formulaHost');
  host.replaceChildren();
  const dz = deadZone();
  const top = c.perAcct.reduce((a, b) => (b.payout > (a?.payout ?? -1) ? b : a), null);

  host.appendChild(formulaBlock('攤開看：這幾個數字怎麼算出來的', [
    `<b>配置規則</b>：每次挑「目前可用的段裡利率最高的那一段」填到滿，填不下才換下一段。`,
    `為什麼這樣就是最佳解：段與段之間沒有整數限制，錢可以任意切分，各家的高利額度也互相獨立。`
    + `在每家級距都是<b>由高往低</b>的前提下，任何把錢從高利段挪到低利段的調整都只會讓總利息變少。`,
    `「目前可用」是真的限制：同一家裡面，第二段要等第一段填滿才適用，你不能跳過第一段直接享受第二段。`,
    `<b>平手就平分</b>：剩下的錢要進「超過上限的部分」時，如果有好幾家的牌告利率一樣，本頁把它平均分掉。`
      + `利息完全相同（同一個利率），但每一家的單次入帳都變小，比較不容易踩到補充保費門檻。`,
    `<b>全年利息</b> = Σ（放進這一段的錢 × 這一段年利率）= <b>${int(c.interest)}</b>`,
    `<b>實質年利率</b> = 全年利息 ÷ 本金 = ${int(c.interest)} ÷ ${int(c.total)} = <b>${pp(c.effective, 3)}</b>`,
    `<b>下一塊錢的利率</b> = 目前可用的段裡最高的那個 = <b>${c.marginal == null ? '—' : pp(c.marginal, 3)}</b>`,
    `<b>每次入帳</b> = 該家全年利息 ÷ 入帳次數（本頁假設每次金額相等）`,
    `<b>補充保費</b> = 單次給付 ≥ ${int(dz.floor)} 時，<b>單次給付全額</b> × ${pp(NHI.rate * 100, 2)}`
      + `（不是只算超過門檻的部分；單次費基上限 ${int(NHI.singlePaymentCap)}，所以單次最多扣 ${int(NHI.maxPremiumPerPayment)}）`,
    top && top.premiumPer > 0
      ? `以${top.name}為例：${int(top.payout)} × ${pp(NHI.rate * 100, 2)} = <b>${int(top.premiumPer)}</b> 元／次，`
        + `一年 ${c.freq} 次共 ${int(top.premium)} 元`
      : `目前沒有任何一筆單次給付達到 ${int(dz.floor)} 元，所以補充保費是 0`,
    `<b>死區上緣</b> = 門檻 ÷ (1 − 費率) = ${int(dz.floor)} ÷ (1 − ${dec(NHI.rate, 4)}) = <b>${dec(dz.upper, 1)}</b>`,
    `所以 ${int(dz.floor)} 到 ${int(Math.ceil(dz.upper))} 這 ${int(Math.ceil(dz.upper) - dz.floor)} 元寬的區間裡，`
      + `你領得比 ${int(dz.floor - 1)} 元多，實拿卻比較少。`,
    `<b>購屋借款利息扣除額</b> = min( max(0, 實際支付利息 − 實際申報之儲蓄投資特扣), ${int(TAXY.mortgageInterestCap)} )`,
    `順序不能顛倒。先封頂再減是錯的，會高估扣除額。`,
  ], `補充保費費率與起扣門檻取自 <code>assets/data/tw-nhi.json</code>（資料時點 ${NHI.verifiedAt}）；`
    + `儲蓄投資特別扣除額與購屋借款利息上限取自 <code>assets/data/tw-tax.json</code>（${TAXY.label || TAXYEAR + ' 年度'}）。`
    + `扣繳實務由給付單位執行，個案認定以中央健康保險署為準。`));

  host.appendChild(formulaBlock('這一頁刻意沒有做的事、以及它算得不夠準的地方', [
    `<b>不內建任何一家銀行的牌告利率。</b>牌告每個月都在動，內建的那一刻就開始過期；`
      + `拿過期的牌告排名次，在公平交易法第 21 條底下是引人錯誤之表示。你自己抄，永遠是最新的。`,
    `<b>用單利計算。</b>結息後利息滾回本金會再生息，本頁沒有把這一段算進去。`
      + `以年利率 2%、半年結息一次估算，一年的差距約 0.01 個百分點，對決策不影響；`
      + `但你若把利息留在戶頭好幾年，實際會比本頁的數字略高一點。`,
    `<b>假設每次入帳金額相等。</b>活儲多半 6/20、12/20 結息，兩次的計息日數其實不同，`
      + `所以真實的單次給付會在本頁數字上下浮動——如果你的單次入帳很接近 ${int(dz.floor)} 元，這個誤差有可能決定會不會被扣。`,
    `<b>沒有算開戶門檻與活動條件。</b>高利額度幾乎都綁條件（新戶、月月扣、消費筆數、數位帳戶限定），`
      + `而且常常有活動期限。這些只有各家自己的公告算數。`,
    `<b>沒有算你把錢搬來搬去的成本。</b>跨行轉帳手續費、免費次數用完、以及你自己的時間。`
      + `如果拆單一年只多拿一百多塊，那多半不值得。`,
    `<b>沒有把定存、外幣、投資型商品放進來。</b>這一頁只處理「隨時可動用的活存」這一個問題。`,
    `<b>補充保費是逐筆扣的，不是年度結算的。</b>所以「全年利息不到 2 萬就不用扣」是錯的理解，`
      + `要看的是每一筆。反過來也成立：全年 5 萬拆成 4 季各 12,500，一樣一毛都不用扣。`,
  ], null));
}

/* ==========================================================================
   啟動
   ========================================================================== */
async function boot() {
  const grab = async (p) => { try { const r = await fetch(p); return r.ok ? await r.json() : null; } catch { return null; } };
  const [nhi, tax] = await Promise.all([
    grab('../../assets/data/tw-nhi.json'),
    grab('../../assets/data/tw-tax.json'),
  ]);

  if (!nhi?.rate || !nhi?.thresholds?.interest || !tax?.years) {
    $('#verdict-h').textContent = '常數檔載不進來，這一頁不會用寫死的備份值算給你看';
    $('#verdictBody').textContent = '請重新整理，或確認網路連線。補充保費費率與起扣門檻每年都可能修法，'
      + '拿記憶中的數字算給你看，比不算更糟。';
    return;
  }
  NHI = nhi; TAX = tax;
  // 這一頁是往前看的：你現在存的錢，利息是明年五月才申報。
  // 所以取常數檔裡最新的那個年度，而不是 defaultYear（那是「上一次申報」用的）。
  const years = Object.keys(TAX.years).map(Number).filter(Number.isFinite).sort((a, b) => b - a);
  TAXYEAR = years[0] || TAX.defaultYear;
  TAXY = TAX.years[String(TAXYEAR)];

  $('#dataver').textContent = `資料版本 ${NHI.version || TAX.version || '—'}`;

  // 共用檔案裡已經有的就直接用，不要再問一次
  if (!store.cameFromLink) {
    if (P.has('savings')) store.set({ total: P.get('savings') }, { silent: true });
    if (P.has('interestIncome')) store.set({ otherInterest: P.get('interestIncome') }, { silent: true });
    if (P.has('mortgageInterestPaid')) store.set({ mortgageInterest: P.get('mortgageInterestPaid') }, { silent: true });
  }

  SCEN[curPly] = clone(S());

  loadPartners('../../assets/data/partners.json').then(refreshLinks);

  syncInputs();
  renderAccounts();
  render();

  // 換主題要重畫：畫布上的顏色是當下讀出來的色票，不會跟著 CSS 一起變
  window.addEventListener('vm:theme', () => { renderAccounts(); render(); });

  if (!still()) {
    printRows(['.app-head', '#inputs', '#verdict'], { stagger: 0.07, delay: 0.04 });
    revealOnScroll(['#stairCard', '#allocCard', '#cliffCard', '#taxCard']);
  }
}

boot();
