/* 離站連結的唯一出口。
 *
 * 為什麼要有這一層：一個試算站掛上分潤連結之後，最容易出事的不是「掛了」，
 * 而是「掛了但沒說」「活動結束了還掛著」「排序偷偷跟著分潤走」。這三件事
 * 在公平交易法第 21 條底下都是引人錯誤之表示。所以全站的離站連結一律走這裡，
 * 而這裡只做四件事：
 *
 *   1. 把 id 換成網址。沒設定分潤就退回官網原始網址，不加任何追蹤參數。
 *   2. 過期自動下架。每一筆都必須填 expires，過期就退回官網並標示活動已結束。
 *   3. 只要本頁渲染過任何一個生效的分潤連結，就自動掛上揭露元件。
 *   4. 不回傳金額。這個模組沒有任何 API 能問到某個連結值多少錢，
 *      所以工具裡的排序不可能、也無法讀到分潤高低。
 *
 * 計算邏輯不 import 這個檔。這是刻意的：試算結果與分潤設定在程式碼層級就不相通。
 */

import { el, iconHTML } from './ui.js';

let CONF = null;
let pending = null;

/* 本頁是否實際渲染過至少一個生效中的分潤連結。
   揭露元件只在 true 時出現——沒有分潤卻掛揭露，同樣是不實陳述。 */
let usedLive = false;

/** 讀設定檔。載不到就當成「沒有任何分潤」，站台照常運作。 */
export function loadPartners(url = '../../assets/data/partners.json') {
  if (CONF) return Promise.resolve(CONF);
  if (pending) return pending;
  pending = fetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { CONF = j || { enabled: false, links: {} }; return CONF; })
    .catch(() => { CONF = { enabled: false, links: {} }; return CONF; });
  return pending;
}

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/[\s　（）()．·・.,、，－\-_/]/g, '');

function expired(entry, now) {
  if (!entry?.expires) return true;           // 沒填期限視同過期，不給預設寬容
  const t = Date.parse(entry.expires + 'T23:59:59+08:00');
  return !Number.isFinite(t) || t < now.getTime();
}

/**
 * 解析一個連結 id。
 * @returns {{known:boolean, label:string, href:string, live:boolean, expired:boolean, note:string|null}}
 *   live=true 代表這次會送出追蹤連結，也就是需要揭露。
 */
export function resolve(id, now = new Date()) {
  const e = CONF?.links?.[id];
  if (!e) return { known: false, label: id, href: null, live: false, expired: false, note: null };

  const isExpired = expired(e, now);
  const canTrack = !!(CONF.enabled && e.affiliate && !isExpired
    && !(CONF.rules?.excludedKinds || []).includes(e.kind));

  return {
    known: true,
    label: e.label || id,
    href: canTrack ? e.affiliate : (e.official || null),
    live: canTrack,
    expired: isExpired && !!e.affiliate,
    note: e.note || null,
    kind: e.kind || null,
  };
}

/** 使用者自己打的機構名稱 → 連結 id。找不到就回 null，不做模糊猜測。 */
export function matchByName(name) {
  const key = norm(name);
  if (!key || !CONF?.links) return null;
  for (const [id, e] of Object.entries(CONF.links)) {
    const names = [e.label, id, ...(e.aliases || [])];
    if (names.some((n) => norm(n) === key)) return id;
  }
  return null;
}

/**
 * 產生一個離站連結。沒有這個 id、或連官網都沒設，就回 null，
 * 呼叫端要能接受「這裡沒有連結」而不是硬塞一個。
 */
export function outbound(id, { text, class: cls = 'btn btn--ghost btn--sm', now } = {}) {
  const r = resolve(id, now);
  if (!r.href) return null;
  if (r.live) usedLive = true;

  const a = el('a', {
    class: cls,
    href: r.href,
    target: '_blank',
    // sponsored 是給搜尋引擎的，noopener 是給瀏覽器的。有分潤才標 sponsored，
    // 沒分潤的官網連結標了反而是另一種不實陳述。
    rel: r.live ? 'sponsored nofollow noopener' : 'noopener',
    html: `${text || r.label}${iconHTML('go')}`,
  });
  if (r.live) a.dataset.sponsored = 'true';
  return a;
}

/** 這一頁到目前為止有沒有送出過追蹤連結。 */
export const hasLiveLinks = () => usedLive;

/**
 * 分潤揭露。只有在本頁真的渲染過生效的分潤連結時才出現。
 * 呼叫端可以在每次重繪後呼叫，元件會自己決定要不要在。
 */
export function mountDisclosure(host) {
  if (!host) return;
  const existing = host.querySelector('[data-disclosure]');
  if (!usedLive) { existing?.remove(); return; }
  if (existing) return;

  const d = CONF?.disclosure || {};
  host.appendChild(el('div', { class: 'note note--warn', dataset: { disclosure: 'true' } }, [
    el('p', { class: 'disclose__lead', html: `<b>利益揭露</b>　${d.short || ''}` }),
    el('ul', { class: 'disclose__list' },
      (d.long || []).map((line) => el('li', { text: line }))),
    d.lawNote ? el('p', { class: 'disclose__law', text: d.lawNote }) : null,
  ]));
}

/** 給揭露頁用：列出全部設定，包含沒有分潤的。不回傳金額，設定檔裡也沒有金額欄位。 */
export function allLinks(now = new Date()) {
  if (!CONF?.links) return [];
  return Object.keys(CONF.links).map((id) => ({ id, ...resolve(id, now) }));
}

export const conf = () => CONF;
