/* 數字與日期格式化。台灣用語，全站唯一的格式來源。 */

const nf = new Intl.NumberFormat('zh-TW');
const nf1 = new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 整數千分位。NaN / Infinity 一律回傳「—」而不是壞掉的字串。 */
export function int(v) {
  if (!Number.isFinite(v)) return '-';
  return nf.format(Math.round(v));
}

export function dec(v, digits = 2) {
  if (!Number.isFinite(v)) return '-';
  if (digits === 1) return nf1.format(v);
  if (digits === 2) return nf2.format(v);
  return new Intl.NumberFormat('zh-TW', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(v);
}

/** 元。大額自動換成萬／億，因為台灣人講「一千兩百萬」不講「12,000,000」。 */
export function money(v, { compact = false, sign = false } = {}) {
  if (!Number.isFinite(v)) return '-';
  const s = sign && v > 0 ? '+' : '';
  if (!compact) return s + int(v);
  const a = Math.abs(v);
  if (a >= 1e8) return s + dec(v / 1e8, 2) + ' 億';
  if (a >= 1e4) return s + dec(v / 1e4, a >= 1e6 ? 0 : 1).replace(/\.0$/, '') + ' 萬';
  return s + int(v);
}

/** 百分比。輸入是比例（0.0412 → 4.12%）。 */
export function pct(v, digits = 2, { sign = false } = {}) {
  if (!Number.isFinite(v)) return '-';
  const s = sign && v > 0 ? '+' : '';
  return s + dec(v * 100, digits) + '%';
}

/** 已經是百分點的數字（4.12 → 4.12%）。 */
export function pp(v, digits = 2, { sign = false } = {}) {
  if (!Number.isFinite(v)) return '-';
  const s = sign && v > 0 ? '+' : '';
  return s + dec(v, digits) + '%';
}

/** 倍數 */
export function times(v, digits = 2) {
  if (!Number.isFinite(v)) return '-';
  return dec(v, digits) + ' 倍';
}

/** 月數 → 「N 年 M 個月」 */
export function months(m) {
  if (!Number.isFinite(m)) return '-';
  const t = Math.max(0, Math.round(m));
  const y = Math.floor(t / 12);
  const mo = t % 12;
  if (y === 0) return `${mo} 個月`;
  if (mo === 0) return `${y} 年`;
  return `${y} 年 ${mo} 個月`;
}

/** 期數 → 民國年月。base 為起始年月（西元）。 */
export function periodToROC(period, startYear, startMonth) {
  const total = (startYear * 12 + (startMonth - 1)) + (period - 1);
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return `${y - 1911} 年 ${String(m).padStart(2, '0')} 月`;
}

export function ad(year, month) {
  return `${year}/${String(month).padStart(2, '0')}`;
}

/** 民國年 → 西元年 */
export const rocToAD = (r) => r + 1911;
export const adToROC = (a) => a - 1911;

/** 年齡＋月 → 「71 歲 4 個月」 */
export function ageLabel(years) {
  if (!Number.isFinite(years)) return '-';
  const y = Math.floor(years);
  const m = Math.round((years - y) * 12);
  if (m === 0) return `${y} 歲`;
  if (m === 12) return `${y + 1} 歲`;
  return `${y} 歲 ${m} 個月`;
}

/** 碼（台灣央行升降息單位，1 碼 = 0.25 個百分點） */
export function codes(n) {
  if (!Number.isFinite(n)) return '-';
  if (n === 0) return '不變';
  const s = n > 0 ? '升' : '降';
  const a = Math.abs(n);
  return `${s} ${a % 1 === 0 ? a : dec(a, 2)} 碼`;
}

/** 讓長數字在窄螢幕上可斷行的安全空白 */
export function wrapable(s) {
  return String(s).replace(/,/g, ',​');
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 安全解析使用者輸入：允許逗號、全形數字、空白 */
export function parseNum(raw, fallback = NaN) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : fallback;
  if (raw == null) return fallback;
  const s = String(raw)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[，,\s_]/g, '')
    .replace(/[％%]/g, '');
  if (s === '' || s === '-') return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}
