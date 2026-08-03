/* 補洞：TWSE 會對連續請求回 307 導流到節流頁，第一輪建置因此漏了一些月份。
   月報酬序列有洞會讓滾動視窗回測算錯，所以這一輪只重抓缺的月份，
   節流放寬到 1.2 秒並在 307 時退避重試。 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('assets/data/market');
const THROTTLE = 1200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rocToISO = (s) => {
  const m = String(s).match(/(\d+)\D+(\d+)\D+(\d+)/);
  if (!m) return null;
  return `${Number(m[1]) + 1911}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
};
const num = (s) => { const v = Number(String(s).replace(/,/g, '')); return Number.isFinite(v) ? v : null; };

async function fetchMonth(id, ym) {
  const d = ym.replace('-', '') + '01';
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${d}&stockNo=${id}&response=json`;
  for (let k = 0; k < 6; k++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'visible-money-tw data builder' }, redirect: 'manual' });
      if (res.status === 307 || res.status === 302 || res.status === 429) { await sleep(3000 * (k + 1)); continue; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (j?.stat !== 'OK' || !Array.isArray(j.data)) return [];
      return j.data.map((r) => ({ date: rocToISO(r[0]), close: num(r[6]) })).filter((r) => r.date && r.close != null);
    } catch (e) {
      if (k === 5) { console.error(`  ! ${id} ${ym} ${e.message}`); return null; }
      await sleep(2000 * (k + 1));
    }
  }
  return null;
}

function missingMonths(monthly, firstYM, lastYM) {
  const have = new Set(monthly.map((m) => m.ym));
  const out = [];
  let [y, m] = firstYM.split('-').map(Number);
  const [ly, lm] = lastYM.split('-').map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    if (!have.has(ym)) out.push(ym);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

async function main() {
  const index = JSON.parse(await readFile(path.join(OUT, 'index.json'), 'utf8'));
  for (const t of index.tickers) {
    const file = path.join(OUT, `${t.id}.json`);
    const j = JSON.parse(await readFile(file, 'utf8'));
    const gaps = missingMonths(j.monthly, j.monthly[0].ym, j.monthly[j.monthly.length - 1].ym);
    if (!gaps.length) { console.log(`${t.id} 無缺漏`); continue; }
    console.log(`${t.id} 缺 ${gaps.length} 個月，開始補…`);

    const added = [];
    for (const ym of gaps) {
      const rows = await fetchMonth(t.id, ym);
      if (rows && rows.length) {
        const last = rows[rows.length - 1];
        added.push({ ym, date: last.date, close: last.close });
        process.stdout.write(`\r  ${t.id} ${ym} ✓ (${added.length}/${gaps.length})   `);
      } else {
        process.stdout.write(`\r  ${t.id} ${ym} － (${added.length}/${gaps.length})   `);
      }
      await sleep(THROTTLE);
    }
    process.stdout.write('\n');

    // 補進來的原始收盤價要套上「該日之後」所有調整因子，才能和既有還原序列同尺規
    for (const a of added) {
      let f = 1;
      for (const ev of j.adjustments) if (ev.date > a.date) f *= ev.factor;
      a.adj = a.close * f;
    }
    j.monthly = [...j.monthly, ...added].sort((x, y) => x.ym.localeCompare(y.ym));
    j.filledAt = new Date().toISOString().slice(0, 10);
    j.filledMonths = added.length;
    await writeFile(file, JSON.stringify(j));
    const t2 = index.tickers.find((x) => x.id === t.id);
    t2.months = j.monthly.length;
    console.log(`  ${t.id} 補回 ${added.length} 個月，現有 ${j.monthly.length} 個月`);
  }
  index.filledAt = new Date().toISOString().slice(0, 10);
  await writeFile(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2));
  console.log('補洞完成');
}

main().catch((e) => { console.error(e); process.exit(1); });
