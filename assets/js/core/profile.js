/* 我的財務檔案：一次填、全站共用。

   為什麼要有這個：七個工具原本各自要求使用者從頭填一次，換一個工具就重來。
   合併之後，使用者的情況只存在一個地方，任何一個計算需要什麼就從這裡拿。

   更重要的是互動邏輯：不要一次攤 21 個欄位給人填。
   法規變動時間軸上的每一條只跟使用者要「這一條算得出金額所需要的那幾格」，
   缺什麼就當場問什麼。填得越多，能回答的問題越多，這個進度本身就是回訪的理由。
*/

import { parseNum, int, dec } from './format.js';

const KEY = 'vm:profile';
const SEEN_KEY = 'vm:lastSeen';

/* ==========================================================================
   欄位定義。這是全站唯一的「使用者資料字典」。
   group 決定它在「我的檔案」頁面裡歸在哪一區；
   ask 是當某個計算缺這一格時，畫面上要問的那句話。
   ========================================================================== */
export const FIELDS = {
  /* --- 家庭 --- */
  married: {
    group: '家庭', label: '已婚', type: 'bool', default: false,
    ask: '你是分開申報還是有配偶合併申報？',
  },
  dependents: {
    group: '家庭', label: '扶養親屬人數', type: 'int', unit: '人', default: 0, min: 0, max: 12,
    ask: '你申報時扶養幾個人？',
  },
  dependentsOver70: {
    group: '家庭', label: '其中年滿 70 歲的直系尊親屬', type: 'int', unit: '人', default: 0, min: 0, max: 8,
    ask: '扶養的人裡面，有幾位是年滿 70 歲的父母或祖父母？他們的免稅額多五成。',
  },
  children0to6: {
    group: '家庭', label: '6 歲以下子女', type: 'int', unit: '人', default: 0, min: 0, max: 8,
    ask: '你有幾個 6 歲以下的小孩？這關係到幼兒學前特別扣除額。',
  },
  longTermCareCount: {
    group: '家庭', label: '符合長照資格的受扶養者', type: 'int', unit: '人', default: 0, min: 0, max: 8,
    ask: '家裡有幾位符合長期照顧特別扣除額資格的人？',
  },

  /* --- 收入 --- */
  salary: {
    group: '收入', label: '本人月固定薪資', type: 'money', unit: '元', default: 0,
    ask: '你每個月的固定薪資是多少？',
  },
  spouseSalary: {
    group: '收入', label: '配偶月固定薪資', type: 'money', unit: '元', default: 0,
    ask: '配偶每個月的固定薪資是多少？',
  },
  annualBonus: {
    group: '收入', label: '年終與獎金（全年）', type: 'money', unit: '元', default: 0,
    ask: '你一年的年終加獎金大約多少？銀行核貸多半不認列，但報稅要算。',
  },
  otherIncome: {
    group: '收入', label: '其他各類所得（全年）', type: 'money', unit: '元', default: 0,
    ask: '租金、執行業務、稿費等其他所得，全年合計多少？',
  },

  /* --- 支出 --- */
  monthlyLiving: {
    group: '支出', label: '每月生活支出', type: 'money', unit: '元', default: 0,
    ask: '扣掉房貸或房租之後，你家每個月的生活開銷大約多少？',
  },
  annualRent: {
    group: '支出', label: '全年房租支出', type: 'money', unit: '元', default: 0,
    ask: '你一年付多少房租？自 113 年度起這是特別扣除額，上限 18 萬，可以跟標準扣除額併用。',
  },

  /* --- 房貸 --- */
  hasMortgage: {
    group: '房貸', label: '目前有房貸', type: 'bool', default: false,
    ask: '你現在有房貸嗎？',
  },
  mortgageBalance: {
    group: '房貸', label: '房貸未償餘額', type: 'money', unit: '元', default: 0,
    ask: '你的房貸現在還欠多少？',
  },
  mortgageMonthsLeft: {
    group: '房貸', label: '剩餘期數', type: 'int', unit: '期', default: 0, min: 0, max: 480,
    ask: '房貸還剩幾期？',
  },
  mortgageRate: {
    group: '房貸', label: '房貸年利率', type: 'rate', unit: '%', default: 2.318,
    ask: '你的房貸年利率是多少？',
  },
  mortgageGraceLeft: {
    group: '房貸', label: '寬限期剩餘', type: 'int', unit: '期', default: 0, min: 0, max: 60,
    ask: '寬限期還剩幾期？沒有就填 0。',
  },
  mortgageInterestPaid: {
    group: '房貸', label: '全年已付利息', type: 'money', unit: '元', default: 0,
    ask: '你一年繳了多少房貸利息？列舉扣除時會用到，上限 30 萬且要先扣掉儲蓄投資特別扣除額。',
  },
  homeCount: {
    group: '房貸', label: '名下房屋數', type: 'int', unit: '間', default: 0, min: 0, max: 9,
    ask: '你名下目前有幾間房？這決定央行的成數上限。',
  },

  /* --- 其他負債 --- */
  debtMonthly: {
    group: '負債', label: '無擔保負債月付', type: 'money', unit: '元', default: 0,
    ask: '信貸、卡循、學貸加起來每月要還多少？',
  },
  debtBalance: {
    group: '負債', label: '無擔保負債餘額', type: 'money', unit: '元', default: 0,
    ask: '這些無擔保負債總共還欠多少？DBR 22 倍算的就是這個，房貸不算在內。',
  },

  /* --- 資產 --- */
  savings: {
    group: '資產', label: '可動用現金', type: 'money', unit: '元', default: 0,
    ask: '你手上可以馬上動用的錢有多少？',
  },
  investable: {
    group: '資產', label: '可投資資產總額', type: 'money', unit: '元', default: 0,
    ask: '不含自住房，你的投資部位總共多少？',
  },
  interestIncome: {
    group: '資產', label: '全年利息所得', type: 'money', unit: '元', default: 0,
    ask: '存款利息一年大約多少？儲蓄投資特別扣除額上限每戶 27 萬。',
  },

  /* --- 勞保勞退 --- */
  birthYearROC: {
    group: '勞保勞退', label: '出生年次（民國）', type: 'int', unit: '年次', default: 0, min: 20, max: 100,
    ask: '你是民國幾年出生的？這決定你的法定請領年齡。',
  },
  sex: {
    group: '勞保勞退', label: '性別', type: 'enum', options: [['m', '男'], ['f', '女']], default: 'm',
    ask: '生命表的平均餘命男女不同，你是？',
  },
  insuredSalary: {
    group: '勞保勞退', label: '最高 60 個月平均月投保薪資', type: 'money', unit: '元', default: 0,
    ask: '你的勞保投保薪資是多少？上限 45,800，超過就以上限計。',
  },
  laborYears: {
    group: '勞保勞退', label: '勞保年資', type: 'int', unit: '年', default: 0, min: 0, max: 60,
    ask: '你的勞保年資有幾年？滿 15 年才能請領年金。',
  },
  laborMonths: {
    group: '勞保勞退', label: '另加月數', type: 'int', unit: '月', default: 0, min: 0, max: 11,
    ask: '年資零頭還有幾個月？',
  },
  pensionAccount: {
    group: '勞保勞退', label: '勞退個人專戶餘額', type: 'money', unit: '元', default: 0,
    ask: '你的勞工退休金個人專戶現在有多少？',
  },

  /* --- 投資 --- */
  annualDividend: {
    group: '投資', label: '全年股利所得', type: 'money', unit: '元', default: 0,
    ask: '你一年領多少股利？這決定合併計稅與分開計稅哪個划算。',
  },
  dividendPayouts: {
    group: '投資', label: '一年配息筆數', type: 'int', unit: '筆', default: 1, min: 1, max: 12,
    ask: '你的股利分幾次入帳？單筆滿 2 萬才扣二代健保補充保費，筆數會改變結果。',
  },
  brokerDiscount: {
    group: '投資', label: '券商手續費折數', type: 'rate', unit: '折', default: 6, min: 1, max: 10,
    ask: '你的券商手續費打幾折？',
  },

  /* --- 退休計畫 --- */
  retireAge: {
    group: '退休計畫', label: '打算退休年齡', type: 'int', unit: '歲', default: 65, min: 45, max: 80,
    ask: '你打算幾歲退休？',
  },
  planToAge: {
    group: '退休計畫', label: '計畫終齡', type: 'int', unit: '歲', default: 90, min: 70, max: 105,
    ask: '你想讓這筆錢撐到幾歲？',
  },
  retireSpend: {
    group: '退休計畫', label: '退休後每月支出', type: 'money', unit: '元', default: 0,
    ask: '退休後你每個月大概要花多少？用今天的購買力填。',
  },
};

export const GROUPS = ['家庭', '收入', '支出', '房貸', '負債', '資產', '勞保勞退', '投資', '退休計畫'];

/* ==========================================================================
   儲存
   ========================================================================== */
const enc = (obj) => {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch { return ''; }
};
const dec64 = (s) => {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return null; }
};

function load() {
  const fromUrl = new URLSearchParams(location.search).get('p');
  if (fromUrl) {
    const v = dec64(fromUrl);
    if (v && typeof v === 'object') return v;
  }
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* 隱私模式：靜默使用空檔案 */ }
  return {};
}

let data = load();
const subs = new Set();
let saveTimer = 0;

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* noop */ }
  }, 200);
}

/* ==========================================================================
   API
   ========================================================================== */

/** 取值。沒填過就回 undefined，不要回預設值 —— 呼叫端必須分得出「填了 0」跟「沒填」。 */
export function get(key) {
  return data[key];
}

/** 取值，沒填過時回退到欄位預設值 */
export function getOr(key, fallback) {
  const v = data[key];
  if (v === undefined || v === null || v === '') {
    return fallback !== undefined ? fallback : FIELDS[key]?.default;
  }
  return v;
}

export function has(key) {
  const v = data[key];
  return v !== undefined && v !== null && v !== '';
}

export function set(patch, { silent = false } = {}) {
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    const clean = normalize(k, v);
    if (!Object.is(data[k], clean)) { data[k] = clean; changed = true; }
  }
  if (!changed) return data;
  persist();
  if (!silent) subs.forEach((fn) => fn(data));
  return data;
}

function normalize(key, v) {
  const f = FIELDS[key];
  if (!f) return v;
  if (v === '' || v === null || v === undefined) return undefined;
  switch (f.type) {
    case 'bool': return Boolean(v);
    case 'int': {
      const n = Math.round(parseNum(v, NaN));
      if (!Number.isFinite(n)) return undefined;
      return Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, n));
    }
    case 'money': {
      const n = parseNum(v, NaN);
      return Number.isFinite(n) ? Math.max(0, n) : undefined;
    }
    case 'rate': {
      const n = parseNum(v, NaN);
      if (!Number.isFinite(n)) return undefined;
      return Math.min(f.max ?? 100, Math.max(f.min ?? 0, n));
    }
    case 'enum': return String(v);
    default: return v;
  }
}

export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

export function all() { return { ...data }; }

export function clear() {
  data = {};
  try { localStorage.removeItem(KEY); } catch { /* noop */ }
  subs.forEach((fn) => fn(data));
}

/** 這個計算需要哪些欄位、目前缺哪些 */
export function missing(keys) {
  return keys.filter((k) => !has(k));
}

/** 填寫進度。用來在畫面上顯示「填了 8 格，可以回答 5 個問題」 */
export function completeness() {
  const total = Object.keys(FIELDS).length;
  const filled = Object.keys(FIELDS).filter(has).length;
  return { filled, total, ratio: total ? filled / total : 0 };
}

/* ==========================================================================
   帶著走：分享網址、匯出、匯入
   沒有帳號，所以「把檔案帶到另一台裝置」必須有一條明確的路。
   ========================================================================== */
export function shareUrl(base = location.href) {
  const u = new URL(base);
  u.search = '';
  u.searchParams.set('p', enc(data));
  return u.toString();
}

export function exportJSON() {
  return JSON.stringify({
    _: '看得見的錢．我的財務檔案',
    savedAt: new Date().toISOString().slice(0, 10),
    data,
  }, null, 2);
}

export function importJSON(text) {
  try {
    const j = JSON.parse(text);
    const next = j && typeof j === 'object' && j.data ? j.data : j;
    if (!next || typeof next !== 'object') return { ok: false, error: '這不是一份財務檔案' };
    const clean = {};
    for (const [k, v] of Object.entries(next)) {
      if (FIELDS[k]) clean[k] = normalize(k, v);
    }
    if (!Object.keys(clean).length) return { ok: false, error: '檔案裡沒有任何認得的欄位' };
    data = clean;
    persist();
    subs.forEach((fn) => fn(data));
    return { ok: true, count: Object.keys(clean).length };
  } catch (e) {
    return { ok: false, error: '檔案讀不開：' + e.message };
  }
}

/* ==========================================================================
   上次來訪的時間點。
   沒有帳號也沒有後端，但只要記得使用者上次看到哪一版，
   就能在他回來時告訴他「這段期間有幾條變動影響你」。
   這是這個網站唯一、也是誠實可行的召回機制。
   ========================================================================== */
export function lastSeen() {
  try { return localStorage.getItem(SEEN_KEY) || null; } catch { return null; }
}

export function markSeen(dateISO) {
  try { localStorage.setItem(SEEN_KEY, dateISO || new Date().toISOString().slice(0, 10)); }
  catch { /* noop */ }
}

/** 顯示用：把一個欄位的值格式化 */
export function display(key) {
  const f = FIELDS[key];
  const v = data[key];
  if (!f || v === undefined) return null;
  switch (f.type) {
    case 'bool': return v ? '是' : '否';
    case 'money': return int(v) + ' ' + (f.unit || '');
    case 'rate': return dec(v, 3).replace(/\.?0+$/, '') + ' ' + (f.unit || '');
    case 'enum': return (f.options.find(([k]) => k === v) || [, v])[1];
    default: return int(v) + ' ' + (f.unit || '');
  }
}
