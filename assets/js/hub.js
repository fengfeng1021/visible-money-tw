import { printRows, revealOnScroll, stampIn } from './core/motion.js';
import { amortize } from './core/fin.js';
import { $, el, iconHTML, mountTheme } from './core/ui.js';
import { int } from './core/format.js';
import { drawThumb } from './core/thumb.js';

/* 七張單據。tint 是它在整個套件裡的紙色身分，kind 是招牌視覺的形狀。 */
const DOCS = [
  {
    href: './apps/mortgage-cliff/',
    name: '房貸懸崖模擬器',
    cat: '借款',
    tint: 'var(--ply-3)',
    kind: 'cliff',
    job: '寬限期結束的那一個月，月付金會跳多高？分段利率、額外還本、升息壓力算在同一條時間軸上，三個情境可以擺在一起比。',
    see: '招牌視覺：跨越全期的月付金時間軸，寬限期屆滿處長出一道帶高度標註的斷崖',
  },
  {
    href: './apps/afford-ceiling/',
    name: '買房預算天花板壓力測試',
    cat: '借款',
    tint: 'var(--ply-3)',
    kind: 'waterfall',
    job: '不告訴你這間房月付多少，反過來算：以你的收入，安全的上限在哪。再用升息、失業、育兒三種壞事檢驗它。',
    see: '招牌視覺：月現金流瀑布，壓力情境按下去「剩餘」那一段會沉到零線以下',
  },
  {
    href: './apps/pension-race/',
    name: '勞保年金請領年齡賽跑',
    cat: '退休',
    tint: 'var(--ply-4)',
    kind: 'race',
    job: '60 歲減領、65 歲全額、70 歲展延，到底幾歲開始領最划算？只要填三格。',
    see: '招牌視覺：三條累積已領總額曲線在人生軸上賽跑，交叉的那一年就是答案',
  },
  {
    href: './apps/retire-fan/',
    name: '退休提領存活扇形',
    cat: '退休',
    tint: 'var(--ply-4)',
    kind: 'fan',
    job: '這筆錢撐不撐得到 90 歲，不是一個數字而是一個機率。另外看看萬一退休頭五年就遇到大跌會發生什麼事。',
    see: '招牌視覺：數十條退休金人生同時往前跑，歸零的路徑變紅落到地面堆積',
  },
  {
    href: './apps/etf-lottery/',
    name: '台股 ETF 起始日樂透',
    cat: '投資',
    tint: 'var(--ply-2)',
    kind: 'hist',
    job: '不給你一個幸運的報酬率，給你所有可能起始日的分布。因為你的績效有一大半只是運氣。',
    see: '招牌視覺：所有起始月的報酬分布直方圖，拉長持有年數時整片分布會收窄',
  },
  {
    href: './apps/dividend-tax-map/',
    name: '股利課稅交叉點地圖',
    cat: '稅務',
    tint: 'var(--accent-wash)',
    kind: 'map',
    job: '合併計稅 8.5% 抵減，還是分開計稅 28%？不給你一個答案，給你一張圖告訴你離翻轉點多遠。',
    see: '招牌視覺：二維決策地圖，分界線在股利約 94 萬處出現折點，那是 8 萬抵減上限咬人的地方',
  },
  {
    href: './apps/ex-dividend/',
    name: '除息填息機',
    cat: '認知',
    tint: 'var(--down-wash)',
    kind: 'cut',
    job: '按下「除息」，看股價當場掉一塊、那一塊變成現金飛進你的錢包。配息不是報酬，這一秒就懂。',
    see: '招牌視覺：一根股價柱子被切掉一塊，缺口變成現金飛向錢包，錢包上滴下稅與健保兩滴水',
  },
];

const SOURCES = [
  ['tw-tax.json', '綜合所得稅免稅額、扣除額、累進級距、股利兩制（114／115 年度並列）', '2026-08'],
  ['tw-labor-pension.json', '勞保老年年金 A／B 式係數、展延減給、請領年齡對照、投保薪資分級表', '2026-08'],
  ['tw-nhi.json', '二代健保補充保費費率、四類所得的不同起扣門檻、單次費基上限', '2026-08'],
  ['tw-lending.json', '央行選擇性信用管制成數、DBR 22 倍適用範圍、青安 3.0、房價負擔能力', '2026-08'],
  ['tw-mortgage.json', '房貸試算參數與方案預設值（青安 3.0／一般房貸／第二戶）', '2026-08'],
  ['market/*.json', '0050／006208／0056／00878／00919 還原權息月序列（臺灣證券交易所）', '2026-08'],
];

/* ---------- 明細表 ---------- */
const list = $('#docs');
for (const d of DOCS) {
  list.appendChild(el('li', { class: 'doc' }, [
    el('a', { class: 'doc__link', href: d.href }, [
      el('span', { class: 'doc__tint', style: `background:${d.tint}`, 'aria-hidden': 'true' }),
      el('span', { class: 'doc__main' }, [
        el('h3', { class: 'doc__name' }, [
          el('span', { text: d.name }),
          el('span', { class: 'chip', text: d.cat }),
        ]),
        el('p', { class: 'doc__job', text: d.job }),
        el('span', { class: 'doc__see', text: d.see }),
      ]),
      el('canvas', { class: 'doc__thumb', 'data-kind': d.kind, role: 'img', 'aria-label': `${d.name}的招牌視覺形狀示意` }),
      el('span', { class: 'doc__go', html: `開啟 ${iconHTML('go')}` }),
    ]),
  ]));
}

/* ---------- 法源表 ---------- */
const srcRows = $('#srcRows');
for (const [file, what, when] of SOURCES) {
  srcRows.appendChild(el('tr', {}, [
    el('td', { text: file }),
    el('td', { text: what }),
    el('td', { text: when }),
  ]));
}

document.querySelectorAll('.doc__thumb').forEach((c) => drawThumb(c, c.dataset.kind));

mountTheme($('#coverActions'));

/* ---------- 當場算一次給你看 ----------
   這一行不是文案，是頁面載入時用 apps 共用的同一個攤還引擎算出來的。
   宣稱可以造假，示範不行。 */
(function proof() {
  const principal = 10000000;
  const years = 40;
  const graceYears = 5;
  const res = amortize({
    principal,
    totalMonths: years * 12,
    graceMonths: graceYears * 12,
    // 青安 3.0：撥貸 3 年內 1.775%，補貼逐年退場
    rateSegments: [
      { from: 1, rate: 0.01775 },
      { from: 37, rate: 0.019 },
      { from: 49, rate: 0.02025 },
    ],
    method: 'annuity',
  });
  const c = res.cliff;
  const line = $('#proofLine');
  const note = $('#proofNote');
  if (!c) { line.textContent = '（這組條件下沒有斷崖）'; return; }
  const y = Math.floor((c.month - 1) / 12) + 1;
  const m = ((c.month - 1) % 12) + 1;
  line.innerHTML =
    `青安 3.0 借 <em>${int(principal / 10000)} 萬</em>、${years} 年、寬限 ${graceYears} 年，` +
    `第 <em>${y}</em> 年第 <em>${m}</em> 個月，月付金從 ${int(Math.round(c.before))} 跳到 ` +
    `<b>${int(Math.round(c.after))}</b> 元（<b>${c.ratio.toFixed(2)} 倍</b>）`;
  note.textContent =
    `這一行是你打開頁面時當場算出來的，用的就是「房貸懸崖模擬器」裡的同一個攤還引擎。` +
    `總利息 ${int(Math.round(res.totalInterest))} 元。利率為青安 3.0 公告值，實際以承貸銀行核定為準。`;
})();

/* ---------- 動效：明細表逐行印出 ----------
   一頁只花一個招牌動效。這裡的理由是：讓訪客感覺這疊單據是被一行一行推出來的，
   同時建立由上而下的閱讀順序。其餘章節只在進入視窗時安靜地揭露一次。 */
printRows('#proof', { delay: 0.05 });
printRows('.doc', { stagger: 0.05, delay: 0.12 });
revealOnScroll('.term');
revealOnScroll('#sources .ledger-wrap');
