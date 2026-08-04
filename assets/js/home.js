/* 首頁：法規變動時間軸。

   這一頁的存在理由：法規會變，這件事對所有試算工具都是負債（算過的答案會過期），
   本站把它翻成資產——每一次變動都是一次有正當理由回來的機會，
   而且回來時看到的不是新聞，是「這條對你值多少錢」。
*/

import { printRows, revealOnScroll, stampIn, makeCounter } from './core/motion.js';
import { $, $$, el, iconHTML, mountTheme, toast } from './core/ui.js';
import { int, dec } from './core/format.js';
import { drawThumb } from './core/thumb.js';
import * as P from './core/profile.js';
import { askBox, portabilityBar } from './core/profile-ui.js';
import { evaluate, sortChanges, sinceLastSeen, buildICS, personalEvents } from './core/changes.js';

/* 這一個放在最前面，而且刻意跟下面三個模組不同層級。
   它是整站唯一「一格輸入、一根滑桿、一屏看完」的東西，
   也是唯一每個受僱勞工都用得到、而且每年真的要重做一次的決定。 */
const SIMPLE = {
  href: './apps/self-contribution/',
  name: '勞退自提要不要勾',
  kind: 'race',
  tint: 'var(--down-wash)',
  job: '人資系統裡那個欄位，每年可以改一次。填月薪、拉滑桿，看你這個月實際少領多少、退休帳戶多多少。'
    + '自提是免稅的，所以你少領的比你以為的少很多。',
  see: '一格輸入、一根滑桿、一屏看完。附自己投資要賺幾 % 才追得上的損益兩平點。',
};

const MODULES = [
  {
    href: './apps/deposit-yield/',
    name: '存錢',
    kind: 'stair',
    tint: 'var(--ply-1)',
    job: '同一筆錢放在幾家數位帳戶，跟全部放一家，全年差多少利息。'
      + '再往下算一關：利息一次進來太多會被扣二代健保補充保費，'
      + '那條門檻前後有一段「多領反而少拿」的死區。',
    chip: '自己填利率',
    see: '牌告利率由你自己填，本站不建任何一家銀行的利率資料庫。'
      + '附利率階梯圖、配置單、死區數線與五月報稅那一關。',
  },
  {
    href: './apps/borrow/',
    fallback: './apps/mortgage-cliff/',
    name: '借款',
    kind: 'cliff',
    tint: 'var(--ply-3)',
    job: '我背的這筆房貸會不會爆，以及我還沒買的那間到底買不買得起。寬限期斷崖、分段利率、額外還本、升息與失業的壓力測試。',
    parts: ['房貸懸崖模擬器', '買房預算天花板壓力測試'],
  },
  {
    href: './apps/refinance/',
    name: '房貸轉貸',
    kind: 'payback',
    tint: 'var(--ply-3)',
    job: '利率差只是分子。真正決定值不值得的是「一次性成本要幾個月的月付差才賺得回來」，'
      + '而那筆成本裡最大的一項——提前清償違約金——只有你的合約知道。'
      + '所以這一頁把不動、回原行議價、轉去別家三條路並排算。',
    chip: '兩格必填',
    see: '違約金與代書費不預填、必填、空白就不給判決。'
      + '設定登記費按土地法第 76 條算給你看，塗銷免費也寫清楚是哪一條。',
  },
  {
    href: './apps/retire/',
    fallback: './apps/pension-race/',
    name: '退休',
    kind: 'race',
    tint: 'var(--ply-4)',
    job: '幾歲開始領勞保年金最划算，以及這筆錢撐不撐得到 90 歲。三條累積領取曲線的交叉點，加上數百條退休金人生的存活率。',
    parts: ['勞保年金請領年齡賽跑', '退休提領存活扇形'],
  },
  {
    href: './apps/invest-tax/',
    fallback: './apps/dividend-tax-map/',
    name: '投資與稅',
    kind: 'map',
    tint: 'var(--ply-2)',
    job: '五月股利要勾哪一個、換一個起始日結果差多少、配息到底有沒有讓我變有錢。稅制交叉點地圖、起始日報酬分布、除息填息機。',
    parts: ['股利課稅交叉點地圖', '台股 ETF 起始日樂透', '除息填息機'],
  },
];

const SOURCES = [
  ['tw-changes.json', '法規變動時間軸（本頁主體）', '2026-08'],
  ['tw-tax.json', '綜合所得稅免稅額、扣除額、累進級距、股利兩制（114／115 年度並列）', '2026-08'],
  ['tw-labor-pension.json', '勞保老年年金 A／B 式係數、展延減給、請領年齡對照、投保薪資分級表', '2026-08'],
  ['tw-nhi.json', '二代健保補充保費費率、四類所得的不同起扣門檻、單次費基上限', '2026-08'],
  ['tw-lending.json', '央行選擇性信用管制成數、DBR 22 倍適用範圍、青安 3.0、房價負擔能力', '2026-08'],
  ['tw-returns.json', '長期年度報酬序列與內政部簡易生命表', '2026-08'],
  ['tw-housing-costs.json', '買房一次性成本與各縣市負擔能力（法規與市場估計分開標示）', '2026-08'],
  ['tw-trading.json', '台股交易成本。手續費地位有爭議，兩種說法並列不選邊', '2026-08'],
  ['market/*.json', '0050／006208／0056／00878／00919 還原權息月序列（臺灣證券交易所）', '2026-08'],
];

const CAT_LABEL = { tax: '稅', lending: '房貸', pension: '勞保勞退', nhi: '健保', market: '市場' };
const STATUS_LABEL = { 'in-force': '已生效', scheduled: '將生效', shelved: '已暫緩', repealed: '已廢止' };

let DATA = { changes: [], version: '—' };
let RULES = {};
let filter = 'recent';
let showAll = false;

/* 一頁 107 條沒有人會讀完。預設只給兩種入口：
   有填資料的人看「影響我的」，沒填的人看「最近一年」。
   其餘按類別，全部要按一下才展開。 */
const VIEWS = [
  { key: 'mine', label: '影響我的' },
  { key: 'recent', label: '最近一年' },
  { key: 'all', label: '全部' },
];


/* 不同單位的金額不能相加。
   「每年少繳的稅」「一次性的可貸額度變化」「剩餘貸款期間的利息差」「一生的年金差」
   是四種不同的東西，把它們加起來會得到一個看起來很大但沒有任何意義的數字，
   而那正是本站聲稱不做的假精確。所以只給分項小計，不給總計。 */
const UNIT_LABEL = {
  perYear: '每年',
  oneOff: '一次性',
  loanTerm: '剩餘貸款期間合計',
  lifetime: '一生合計',
};

function tallyByUnit() {
  const bucket = {};
  let pending = 0;
  for (const ch of DATA.changes) {
    const r = evaluate(ch, rulesFor(ch));
    if (r.state === 'affected') {
      const k = r.unitClass || 'oneOff';
      bucket[k] = bucket[k] || { sum: 0, n: 0 };
      bucket[k].sum += r.amount;
      bucket[k].n++;
    } else if (r.state === 'need-more') pending++;
  }
  return { bucket, pending };
}

/* ==========================================================================
   時間軸
   ========================================================================== */
function rulesFor(change) {
  // 影響計算需要「變動前」與「變動後」兩組常數。稅制的兩個年度剛好就是這件事。
  if (change.category === 'tax') {
    return { rules: RULES.tax?.years?.['115'], prevRules: RULES.tax?.years?.['114'] };
  }
  return { rules: RULES[change.category], prevRules: null };
}

/* 同一格不要在頁面上被問十次。第一條需要它的變動就地問，
   後面的只指回去，否則整條時間軸會變成一排重複的表單。 */
let askedThisPass = new Set();

function impactBlock(change) {
  const r = evaluate(change, rulesFor(change));

  if (r.state === 'need-more') {
    const fresh = r.missing.filter((k) => !askedThisPass.has(k));
    const box = el('div', { class: 'tl__impact tl__impact--muted' });

    if (!fresh.length) {
      const names = r.missing.map((k) => P.FIELDS[k]?.label || k).join('、');
      box.appendChild(el('span', {
        class: 'tl__impact-amount',
        text: '上面那格填完就會算出來',
      }));
      box.appendChild(el('p', { class: 'tl__impact-why', text: `這一條需要：${names}。` }));
      return box;
    }

    fresh.forEach((k) => askedThisPass.add(k));
    box.appendChild(el('span', {
      class: 'tl__impact-amount',
      text: `再填 ${fresh.length} 格就算得出來`,
    }));
    const ask = askBox(fresh, { title: '', onReady: () => { render(); } });
    box.appendChild(ask.el);
    return box;
  }

  if (r.state === 'affected') {
    const good = r.amount > 0;
    const box = el('div', { class: 'tl__impact', 'data-dir': good ? 'good' : 'bad' });
    box.appendChild(el('span', {
      class: 'tl__impact-amount',
      text: (good ? '對你有利 ' : '對你不利 ') + int(Math.abs(r.amount)) + ' 元'
        + (r.monthly ? `（每月 ${int(Math.abs(r.monthly))} 元）` : ''),
    }));
    if (r.explain) box.appendChild(el('p', { class: 'tl__impact-why', text: r.explain }));
    return box;
  }

  if (r.state === 'no-effect') {
    const box = el('div', { class: 'tl__impact tl__impact--muted' });
    box.appendChild(el('span', { class: 'tl__impact-amount', text: '這一條不影響你' }));
    if (r.explain) box.appendChild(el('p', { class: 'tl__impact-why', text: r.explain }));
    return box;
  }

  return null;
}

function renderTimeline() {
  askedThisPass = new Set();
  // 首頁上方的快速填寫已經在問這五格了，時間軸裡不要再問一次
  ['salary', 'married', 'dependents', 'homeCount', 'annualDividend'].forEach((k) => {
    if (!P.has(k)) askedThisPass.add(k);
  });
  const host = $('#tl');
  host.replaceChildren();
  const full = visibleChanges();
  const CAP = 20;
  const list = showAll ? full : full.slice(0, CAP);

  for (const c of list) {
    const item = el('li', { class: 'tl__item', id: 'c-' + c.id });

    const d = String(c.effectiveDate);
    item.appendChild(el('div', { class: 'tl__when' }, [
      el('b', { text: d.slice(0, 7).replace('-', '／') }),
      el('span', { text: d.slice(8) ? d.slice(8) + ' 日' : '' }),
    ]));

    const main = el('div', { class: 'tl__main' });
    main.appendChild(el('h3', { class: 'tl__title' }, [
      el('span', { text: c.title }),
      el('span', { class: 'tl__status', 'data-s': c.status, text: STATUS_LABEL[c.status] || c.status }),
      el('span', { class: 'chip', text: CAT_LABEL[c.category] || c.category }),
    ]));

    if (c.before && c.after && c.before !== 'null') {
      main.appendChild(el('div', { class: 'tl__delta' }, [
        el('s', { text: c.before + (c.unit || '') }),
        el('span', { text: '→' }),
        el('b', { text: c.after + (c.unit || '') }),
      ]));
    }

    main.appendChild(el('p', { class: 'tl__who', text: c.whoIsAffected }));

    const imp = impactBlock(c);
    if (imp) main.appendChild(imp);

    const det = el('details', { class: 'formula' }, [
      el('summary', { text: '攤開看：法源與註記' }),
      el('div', { class: 'formula__body' }, [
        el('div', { class: 'formula__line', html: `<b>法源</b> ${c.legalBasis}` }),
        el('div', { class: 'formula__line', html: `<b>生效</b> ${c.effectiveDate}${c.announcedDate ? `　<b>公告</b> ${c.announcedDate}` : ''}` }),
        el('div', { class: 'formula__line', html: `<b>查證</b> ${c.confidence === 'verified' ? '已查證' : c.confidence === 'probable' ? '高度可能，但無正式公告文號' : '未查證'}` }),
        c.note ? el('p', { class: 'formula__src', text: c.note }) : null,
        c.sourceUrl ? el('p', { class: 'formula__src' }, [
          el('a', { href: c.sourceUrl, target: '_blank', rel: 'noopener', text: '官方來源' }),
        ]) : null,
      ]),
    ]);
    main.appendChild(det);

    item.appendChild(main);
    host.appendChild(item);
  }

  if (!showAll && full.length > list.length) {
    const more = el('li', { class: 'tl__item', style: 'grid-template-columns:1fr' });
    more.appendChild(el('button', {
      type: 'button',
      class: 'btn btn--ghost btn--block',
      text: `再顯示 ${full.length - list.length} 條`,
      onclick: () => { showAll = true; renderTimeline(); },
    }));
    host.appendChild(more);
  }

  if (!list.length) {
    host.appendChild(el('li', { class: 'tl__item', style: 'grid-template-columns:1fr' }, [
      el('div', { class: 'state' }, [
        el('h3', { class: 'state__title', text: filter === 'mine' ? '還沒有一條算得出對你的金額' : '這個分類目前沒有條目' }),
        el('p', {
          class: 'state__body',
          text: filter === 'mine'
            ? '往上填幾格，或先看「最近一年」那一欄有哪些跟你有關。'
            : '換一個分類看看。',
        }),
      ]),
    ]));
  }

  $('#tlFoot').textContent =
    `目前顯示 ${list.length} 條，收錄合計 ${DATA.changes.length} 條，資料版本 ${DATA.version}。`
    + `已暫緩的條目代表該修法沒有上路，不要據以規劃。`;

  printRows($$('.tl__item', host), { stagger: 0.035 });
}

function renderFilters() {
  const host = $('#filters');
  host.replaceChildren();

  const counts = {
    mine: DATA.changes.filter((c) => evaluate(c, rulesFor(c)).state === 'affected').length,
    recent: DATA.changes.filter(inLastYear).length,
    all: DATA.changes.length,
  };

  const add = (key, label, n) => host.appendChild(el('button', {
    type: 'button',
    class: 'segmented__opt',
    style: 'border:1px solid var(--rule-strong)',
    'aria-pressed': String(filter === key),
    text: n === null ? label : `${label} ${n}`,
    onclick: () => { filter = key; showAll = false; renderFilters(); renderTimeline(); },
  }));

  for (const v of VIEWS) add(v.key, v.label, counts[v.key]);
  for (const k of [...new Set(DATA.changes.map((c) => c.category))]) {
    add(k, CAT_LABEL[k] || k, DATA.changes.filter((c) => c.category === k).length);
  }
}

function inLastYear(c) {
  const d = new Date(String(c.effectiveDate));
  return Number.isFinite(+d) && (Date.now() - +d) < 400 * 86400000;
}

function visibleChanges() {
  const sorted = sortChanges(DATA.changes);
  if (filter === 'mine') {
    return sorted.filter((c) => evaluate(c, rulesFor(c)).state === 'affected');
  }
  if (filter === 'recent') return sorted.filter(inLastYear);
  if (filter === 'all') return sorted;
  return sorted.filter((c) => c.category === filter);
}

/* ==========================================================================
   自從你上次來
   ========================================================================== */
function renderNewSince() {
  const host = $('#newSince');
  host.replaceChildren();
  const seen = P.lastSeen();
  if (!seen) return;

  const s = sinceLastSeen(DATA.changes, seen, { rules: RULES.tax?.years?.['115'], prevRules: RULES.tax?.years?.['114'] });
  if (!s || !s.count) return;

  const box = el('div', { class: 'newsince' });
  box.appendChild(el('p', {
    class: 'newsince__lead',
    text: s.items.length
      ? `你上次來之後有 ${s.count} 條新變動，其中 ${s.items.length} 條影響你。`
      : `你上次來之後有 ${s.count} 條新變動。`,
  }));
  const parts = Object.entries(s.byUnit || {})
    .filter(([, v]) => Math.abs(v.sum) >= 1)
    .map(([k, v]) => `${UNIT_LABEL[k] || k}${v.sum > 0 ? '有利' : '不利'} ${int(Math.abs(v.sum))} 元`);
  box.appendChild(el('p', {
    class: 'newsince__body',
    text: parts.length
      ? `以你目前填的資料估算：${parts.join('、')}。`
      : '沒有一條算得出對你的金額，往下看有沒有跟你有關的。',
  }));
  host.appendChild(box);
  stampIn(box);
}

/* ==========================================================================
   封面：有檔案就給結論，沒檔案就給入口
   ========================================================================== */
function renderCover() {
  const c = P.completeness();
  const cta = $('#coverCta');
  cta.replaceChildren();

  cta.appendChild(el('a', { class: 'btn', href: '#quickfill', text: c.filled ? '補填我的檔案' : '填三格開始' }));
  cta.appendChild(el('a', { class: 'btn btn--ghost', href: '#timeline', text: '直接看變動' }));

  const proof = $('#proof');
  if (!c.filled) { proof.hidden = true; return; }

  // 已經有檔案：分項小計就是首屏的證明。不給總計，因為單位不同不能相加。
  const { bucket, pending } = tallyByUnit();
  const parts = Object.entries(bucket)
    .filter(([, v]) => Math.abs(v.sum) >= 1)
    .sort((a, b) => Math.abs(b[1].sum) - Math.abs(a[1].sum));
  const hit = Object.values(bucket).reduce((n, v) => n + v.n, 0);

  proof.hidden = false;
  $('#proofLabel').textContent = `以你填的 ${c.filled} 格資料算出來的`;
  $('#proofLine').innerHTML = parts.length
    ? parts.map(([k, v]) =>
        `<em>${UNIT_LABEL[k] || k}</em>${v.sum > 0 ? '有利' : '不利'} <b>${int(Math.abs(v.sum))}</b> 元`
      ).join('　／　')
    : `目前收錄的 ${DATA.changes.length} 條變動裡，還沒有一條算得出對你的金額`;
  $('#proofNote').textContent =
    (hit
      ? `共 ${hit} 條算得出金額。這幾個數字的時間單位不同，所以分開列、不加總：`
        + `把每年省的稅跟一次性的可貸額度加在一起會得到一個沒有意義的數字。`
      : '')
    + (pending ? `另外有 ${pending} 條需要你再填幾格才算得出來，往下捲會就地問你。` : '');
}

/* ==========================================================================
   三個模組
   ========================================================================== */
function docRow(m, extraClass) {
  return el('li', { class: 'doc' + (extraClass ? ' ' + extraClass : '') }, [
    el('a', { class: 'doc__link', href: m.href, 'data-fallback': m.fallback || '' }, [
      el('span', { class: 'doc__tint', style: `background:${m.tint}`, 'aria-hidden': 'true' }),
      el('span', { class: 'doc__main' }, [
        el('h3', { class: 'doc__name' }, [
          el('span', { text: m.name }),
          m.parts
            ? el('span', { class: 'chip', text: `${m.parts.length} 個工具` })
            : el('span', { class: 'chip chip--on', text: m.chip || '一屏看完' }),
        ]),
        el('p', { class: 'doc__job', text: m.job }),
        el('span', { class: 'doc__see', text: m.see || ('包含：' + (m.parts || []).join('、')) }),
      ]),
      el('canvas', {
        class: 'doc__thumb', 'data-kind': m.kind, role: 'img',
        'aria-label': `${m.name}的招牌視覺形狀示意`,
      }),
      el('span', { class: 'doc__go', html: `開啟 ${iconHTML('go')}` }),
    ]),
  ]);
}

function renderModules() {
  const simple = $('#simpleDoc');
  if (simple) { simple.replaceChildren(); simple.appendChild(docRow(SIMPLE, 'doc--hero')); }
  const list = $('#docs');
  list.replaceChildren();
  for (const m of MODULES) list.appendChild(docRow(m));
  $$('.doc__thumb').forEach((cv) => drawThumb(cv, cv.dataset.kind));

  // 模組頁還沒上線時，連結退回原本的單一工具，不要給使用者 404
  $$('.doc__link').forEach(async (a) => {
    if (!a.dataset.fallback) return;
    try {
      const res = await fetch(a.getAttribute('href'), { method: 'HEAD' });
      if (!res.ok) a.setAttribute('href', a.dataset.fallback);
    } catch { a.setAttribute('href', a.dataset.fallback); }
  });
}

/* ==========================================================================
   帶著走：行事曆與檔案
   ========================================================================== */
function renderCarry() {
  const host = $('#carryHost');
  host.replaceChildren();

  const events = personalEvents(RULES.pension);
  const box = el('div', { class: 'note' });
  if (events.length) {
    box.appendChild(el('p', {
      html: `<b>依你的檔案，有 ${events.length} 個日期值得放進行事曆</b>：`
        + events.map((e) => `${e.date} ${e.title}`).join('、') + '。',
    }));
  } else {
    box.appendChild(el('p', {
      text: '填了房貸寬限期或出生年次之後，這裡會產生屬於你的提醒日期：寬限期到期那個月、法定請領年齡那一年、還有每年五月的報稅季。',
    }));
  }
  host.appendChild(box);

  const bar = el('div', { class: 'btnrow', style: 'margin-top:var(--s-3)' });
  bar.appendChild(el('button', {
    class: 'btn' + (events.length ? '' : ' btn--ghost'),
    type: 'button',
    disabled: !events.length,
    html: iconHTML('down') + '<span>下載行事曆提醒</span>',
    onclick: () => {
      const ics = buildICS(events);
      const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
      const a = el('a', { href: URL.createObjectURL(blob), download: '看得見的錢-提醒.ics' });
      document.body.appendChild(a); a.click(); a.remove();
      toast('已下載。匯入行事曆之後，到期前一週會提醒你。');
    },
  }));
  host.appendChild(bar);

  portabilityBar(host, P);

  host.appendChild(el('p', {
    class: 'disclaimer',
    style: 'margin-top:var(--s-4)',
    text: '沒有帳號就沒有推播，這是刻意的。行事曆提醒與匯出的檔案都在你自己手上，'
      + '本站不知道你是誰，也沒有任何伺服器記錄你填了什麼。',
  }));
}

/* ==========================================================================
   啟動
   ========================================================================== */
function render() {
  renderCover();
  renderNewSince();
  renderFilters();
  renderTimeline();
  renderCarry();
}

async function boot() {
  const grab = async (p) => { try { const r = await fetch(p); return r.ok ? await r.json() : null; } catch { return null; } };

  const [changes, tax, lending, pension, nhi] = await Promise.all([
    grab('./assets/data/tw-changes.json'),
    grab('./assets/data/tw-tax.json'),
    grab('./assets/data/tw-lending.json'),
    grab('./assets/data/tw-labor-pension.json'),
    grab('./assets/data/tw-nhi.json'),
  ]);

  DATA = changes || { changes: [], version: '離線' };
  RULES = { tax, lending, pension, nhi };
  $('#dataver').textContent = `資料版本 ${DATA.version || '—'}`;

  mountTheme($('#coverActions'));

  const srcRows = $('#srcRows');
  for (const [file, what, when] of SOURCES) {
    srcRows.appendChild(el('tr', {}, [
      el('td', { text: file }), el('td', { text: what }), el('td', { text: when }),
    ]));
  }

  // 首頁的快速填寫：挑對最多條變動有解鎖效果的幾格
  const quick = askBox(['salary', 'married', 'dependents', 'homeCount', 'annualDividend'], {
    title: '這五格解鎖最多條變動的金額計算',
    compact: true,
    onReady: () => { render(); },
  });
  $('#askHost').appendChild(quick.el);
  if (quick.el.hidden) {
    $('#askHost').appendChild(el('p', {
      class: 'note note--ok',
      text: '這五格你都填過了。往下每一條變動都會直接算出對你的金額，缺什麼會就地再問。',
    }));
  }

  renderModules();
  render();

  P.subscribe(() => { quick.refresh(); render(); });

  revealOnScroll('.term');
  revealOnScroll('#sources .ledger-wrap');

  // 記下他已經看過的最新一條變動是哪一天生效的。
  // 不能記今天的日期 —— 那樣下次回來時「比上次新」的門檻會被推到未來，
  // 所有新變動都會被吃掉，這個召回機制就等於沒有。
  const newest = DATA.changes.reduce(
    (m, c) => (String(c.effectiveDate) > m ? String(c.effectiveDate) : m), '');
  const remember = () => { if (newest) P.markSeen(newest); };
  window.addEventListener('pagehide', remember, { once: true });
  setTimeout(remember, 45000);
}

boot();
