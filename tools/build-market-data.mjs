/* 離線建置還原權息序列。
   為什麼要離線建置：STOCK_DAY 一次只回一個月、且是「未還原」價格。
   直接拿收盤價算報酬會系統性算錯（除息當天看起來就是虧損）。
   本腳本把原始收盤價與還原序列分開存放，並記錄每一筆調整因子，
   讓 App 端可以攤開給使用者看每一次調整是怎麼來的。

   用法：node tools/build-market-data.mjs [--from 2010] [--only 0050]
*/

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('assets/data/market');
const THROTTLE_MS = 420;

const TICKERS = [
  { id: '0050', name: '元大台灣50', listed: '2003-06-30', kind: 'etf' },
  { id: '006208', name: '富邦台50', listed: '2012-07-17', kind: 'etf' },
  { id: '0056', name: '元大高股息', listed: '2007-12-26', kind: 'etf' },
  { id: '00878', name: '國泰永續高股息', listed: '2020-07-20', kind: 'etf' },
  { id: '00919', name: '群益台灣精選高息', listed: '2022-10-20', kind: 'etf' },
];

/* STOCK_DAY 的資料下限：民國99年1月4日 */
const DATA_FLOOR = '2010-01';

/* 已知的分割／反分割事件。TWT49U 不含分割，未處理會產生假崩盤。
   偵測到未登錄的異常跳動時，腳本會在 warnings 裡列出來要求人工確認。 */
const SPLITS = [
  // 已人工查證：TWSE STOCK_DAY 114/06/18 收盤由 188.65 → 47.57（1 股換 4 股）。
  // 不登錄的話，2025 年度報酬會變成 −65.8%、2026 年 +58.6%，整組回測失真。
  { id: '0050', date: '2025-06-18', ratio: 4 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 3) {
  for (let k = 0; k < tries; k++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'visible-money-tw data builder (static site, non-commercial)' },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (k === tries - 1) throw e;
      await sleep(1200 * (k + 1));
    }
  }
}

const rocToISO = (s) => {
  // "114/06/02" 或 "113年01月04日"
  const m = String(s).match(/(\d+)\D+(\d+)\D+(\d+)/);
  if (!m) return null;
  const y = Number(m[1]) + 1911;
  return `${y}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
};

const num = (s) => {
  const v = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
};

function monthsBetween(fromYM, toYM) {
  const out = [];
  let [y, m] = fromYM.split('-').map(Number);
  const [ty, tm] = toYM.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}${String(m).padStart(2, '0')}01`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

async function fetchDaily(id, fromYM, toYM) {
  const months = monthsBetween(fromYM, toYM);
  const rows = [];
  for (const d of months) {
    const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${d}&stockNo=${id}&response=json`;
    let j;
    try { j = await getJSON(url); } catch (e) { console.error(`  ! ${id} ${d} ${e.message}`); await sleep(THROTTLE_MS); continue; }
    if (j?.stat === 'OK' && Array.isArray(j.data)) {
      for (const r of j.data) {
        const date = rocToISO(r[0]);
        const close = num(r[6]);
        if (date && close != null) rows.push({ date, close, volume: num(r[1]) || 0 });
      }
    }
    process.stdout.write(`\r  ${id} ${d} → ${rows.length} 筆   `);
    await sleep(THROTTLE_MS);
  }
  process.stdout.write('\n');
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

async function fetchExRights(years) {
  /* TWT49U 一次可查一段區間，但資料量大，逐年抓比較穩。
     回傳 map: id -> [{ date, pre, ref, factor, kind }] */
  const map = new Map();
  for (const y of years) {
    const url = `https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=${y}0101&endDate=${y}1231&response=json`;
    let j;
    try { j = await getJSON(url); } catch (e) { console.error(`  ! exRight ${y} ${e.message}`); await sleep(THROTTLE_MS); continue; }
    if (j?.stat === 'OK' && Array.isArray(j.data)) {
      for (const r of j.data) {
        const id = String(r[1]).trim();
        if (!TICKERS.some((t) => t.id === id)) continue;
        const date = rocToISO(r[0]);
        const pre = num(r[3]);
        const ref = num(r[4]);
        if (!date || pre == null || ref == null || pre <= 0) continue;
        if (!map.has(id)) map.set(id, []);
        map.get(id).push({
          date, pre, ref,
          value: num(r[5]),
          kind: String(r[6] || '').trim(),
          factor: ref / pre,
        });
      }
    }
    process.stdout.write(`\r  除權息 ${y} → ${[...map.values()].reduce((s, a) => s + a.length, 0)} 筆   `);
    await sleep(THROTTLE_MS);
  }
  process.stdout.write('\n');
  for (const a of map.values()) a.sort((x, y2) => x.date.localeCompare(y2.date));
  return map;
}

/** 還原價：Adj_t = Close_t × Π_{d>t} f_d
    （把過去的價格往下調，讓最新價等於實際價） */
function buildAdjusted(daily, events, splits) {
  const adj = daily.map((r) => ({ ...r, adj: r.close }));
  const all = [
    ...events.map((e) => ({ date: e.date, factor: e.factor, kind: e.kind || '息' })),
    ...splits.map((s) => ({ date: s.date, factor: 1 / s.ratio, kind: `分割 1:${s.ratio}` })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  for (const ev of all) {
    for (let i = 0; i < adj.length; i++) {
      if (adj[i].date < ev.date) adj[i].adj *= ev.factor;
      else break;
    }
  }
  return { adj, applied: all };
}

/** 偵測未被任何事件解釋的異常跳動（可能是漏掉的分割） */
function detectAnomalies(daily, applied) {
  const known = new Set(applied.map((e) => e.date));
  const out = [];
  for (let i = 1; i < daily.length; i++) {
    const chg = daily[i].close / daily[i - 1].close - 1;
    if (chg < -0.16 && !known.has(daily[i].date)) {
      out.push({ date: daily[i].date, from: daily[i - 1].close, to: daily[i].close, change: chg });
    }
  }
  return out;
}

function toMonthly(adjRows) {
  const byMonth = new Map();
  for (const r of adjRows) byMonth.set(r.date.slice(0, 7), r); // 保留該月最後一個交易日
  return [...byMonth.entries()].map(([ym, r]) => ({ ym, date: r.date, adj: r.adj, close: r.close }));
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const now = new Date();
  const toYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  if (!existsSync(OUT)) await mkdir(OUT, { recursive: true });

  const list = only ? TICKERS.filter((t) => t.id === only) : TICKERS;
  const years = [];
  for (let y = 2010; y <= now.getFullYear(); y++) years.push(y);

  console.log('抓取除權息事件…');
  const exMap = await fetchExRights(years);

  const index = [];
  for (const t of list) {
    console.log(`抓取 ${t.id} ${t.name}…`);
    const from = t.listed.slice(0, 7) > DATA_FLOOR ? t.listed.slice(0, 7) : DATA_FLOOR;
    const daily = await fetchDaily(t.id, from, toYM);
    if (!daily.length) { console.error(`  ! ${t.id} 無資料，跳過`); continue; }

    const events = exMap.get(t.id) || [];
    const splits = SPLITS.filter((s) => s.id === t.id);
    const { adj, applied } = buildAdjusted(daily, events, splits);
    const anomalies = detectAnomalies(daily, applied);
    const monthly = toMonthly(adj);

    const payload = {
      id: t.id,
      name: t.name,
      kind: t.kind,
      listed: t.listed,
      builtAt: new Date().toISOString().slice(0, 10),
      source: 'TWSE STOCK_DAY + TWT49U（除權除息計算結果表）',
      note: '還原價 Adj_t = Close_t × Π(除權息參考價 ÷ 除權息前收盤價)。原始收盤價另存於 close 欄位，兩者不得混用。',
      firstDate: daily[0].date,
      lastDate: daily[daily.length - 1].date,
      dailyCount: daily.length,
      adjustments: applied,
      anomalies,
      monthly,
    };
    await writeFile(path.join(OUT, `${t.id}.json`), JSON.stringify(payload));
    index.push({
      id: t.id, name: t.name, listed: t.listed,
      firstDate: daily[0].date, lastDate: daily[daily.length - 1].date,
      months: monthly.length, adjustments: applied.length,
      anomalies: anomalies.length,
    });
    console.log(`  ✓ ${t.id} ${monthly.length} 個月、${applied.length} 次調整、${anomalies.length} 個待確認異常`);
    if (anomalies.length) console.log('    待確認：', anomalies.map((a) => `${a.date} ${(a.change * 100).toFixed(1)}%`).join(', '));
  }

  await writeFile(path.join(OUT, 'index.json'), JSON.stringify({
    builtAt: new Date().toISOString().slice(0, 10),
    dataFloor: DATA_FLOOR,
    tickers: index,
  }, null, 2));
  console.log('\n完成。index.json 已更新。');
}

main().catch((e) => { console.error(e); process.exit(1); });
