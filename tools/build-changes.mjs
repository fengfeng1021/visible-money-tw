/* 把四個領域查證回來的法規變動合併成一份時間軸，並指派影響計算規格。

   為什麼要有這一步：代理人回報的 impactRule 是給人看的散文，
   前端需要的是「用哪一種算法、需要使用者哪幾格」的結構。
   這裡用欄位路徑把散文對應成 changes.js 認得的 impact 種類，
   對應不到的就老實標成 info（只說明影響誰，不硬掰金額）。

   用法：node tools/build-changes.mjs
*/

import { readFile, writeFile } from 'node:fs/promises';

const raw = JSON.parse(await readFile('.research/changelog-verification.json', 'utf8'));
const seed = JSON.parse(await readFile('assets/data/tw-changes.json', 'utf8'));

/* 我手寫並且已經在瀏覽器裡驗算過的 impact 規格，優先於自動推斷 */
const HAND = new Map(seed.changes.map((c) => [c.id, c.impact]));

/* 級距的實際數值。自動推斷推不出陣列，只能在這裡對照。 */
const BRACKETS = {
  113: [
    { upTo: 560000, rate: 0.05, quick: 0 },
    { upTo: 1260000, rate: 0.12, quick: 39200 },
    { upTo: 2520000, rate: 0.2, quick: 140000 },
    { upTo: 4720000, rate: 0.3, quick: 392000 },
    { upTo: null, rate: 0.4, quick: 864000 },
  ],
  114: [
    { upTo: 590000, rate: 0.05, quick: 0 },
    { upTo: 1330000, rate: 0.12, quick: 41300 },
    { upTo: 2660000, rate: 0.2, quick: 147700 },
    { upTo: 4980000, rate: 0.3, quick: 413700 },
    { upTo: null, rate: 0.4, quick: 911700 },
  ],
  115: [
    { upTo: 610000, rate: 0.05, quick: 0 },
    { upTo: 1380000, rate: 0.12, quick: 42700 },
    { upTo: 2770000, rate: 0.2, quick: 153100 },
    { upTo: 5190000, rate: 0.3, quick: 430100 },
    { upTo: null, rate: 0.4, quick: 949100 },
  ],
};

const isNum = (v) => v !== null && v !== undefined && /^-?[\d.]+$/.test(String(v).replace(/,/g, ''));

/** 依欄位路徑推斷影響計算種類 */
function inferImpact(c) {
  if (HAND.has(c.id)) return HAND.get(c.id);
  const f = String(c.field || '').toLowerCase();
  const both = isNum(c.before) && isNum(c.after);

  // 級距：把前後兩組實際陣列塞進來，前端才算得出稅額差
  if (f.includes('bracket')) {
    const y = (String(c.field).match(/\.(\d{3})\./) || [])[1];
    const after = BRACKETS[y];
    const before = BRACKETS[String(Number(y) - 1)] || BRACKETS[String(Number(y) - 2)];
    if (after && before) {
      return { kind: 'brackets', need: ['salary'], beforeBrackets: before, afterBrackets: after };
    }
    return { kind: 'info' };
  }

  if (!both) return { kind: 'info' };

  if (f.includes('exemptionage70')) {
    return { kind: 'deduction', perHead: 'field', headField: 'dependentsOver70', need: ['salary'] };
  }
  if (f.includes('exemption') && !f.includes('amt') && !f.includes('insurance')) {
    return { kind: 'deduction', perHead: 'household', need: ['salary'] };
  }
  if (f.includes('standard')) {
    return { kind: 'deduction', doubleIfMarried: true, need: ['salary'] };
  }
  if (f.includes('salarydeduction') || f.includes('disabilitydeduction')) {
    return { kind: 'deduction', perHead: 'perEarner', need: ['salary'] };
  }
  if (f.includes('longtermcare')) {
    return { kind: 'deduction', perHead: 'field', headField: 'longTermCareCount', need: ['salary'] };
  }
  if (f.includes('preschool')) {
    return { kind: 'deduction', perHead: 'field', headField: 'children0to6', need: ['salary'] };
  }
  if (f.includes('rent')) {
    return {
      kind: 'deduction', need: ['salary', 'annualRent'],
      onlyIf: { annualRent: { min: 1 } },
      onlyIfMiss: '你沒有房租支出，這一條規範的是租屋族。',
    };
  }
  if (f.includes('ltv') || f.includes('成數')) {
    return {
      kind: 'ltv', need: ['savings'],
      onlyIf: { homeCount: { min: 1 } },
      onlyIfMiss: '你名下沒有房，這一條規範的是第二戶以上，目前不影響你。',
    };
  }
  if ((f.includes('rate') || f.includes('利率')) && c.category === 'lending') {
    const b = Number(String(c.before).replace(/,/g, ''));
    const a = Number(String(c.after).replace(/,/g, ''));
    // 只有看起來像年利率百分比的才套月付金算法
    if (b > 0 && b < 20 && a > 0 && a < 20) {
      return { kind: 'mortgageRate', need: ['mortgageBalance', 'mortgageMonthsLeft'], onlyIf: { hasMortgage: true } };
    }
  }
  if (f.includes('insuredsalary') || f.includes('投保薪資')) {
    return { kind: 'insuredSalary', need: ['insuredSalary', 'laborYears'] };
  }
  return { kind: 'info' };
}

/* ---------- 合併 ---------- */
const byId = new Map();

// 先放我手寫的種子（它們的文案是為畫面寫的，比較好讀）
for (const c of seed.changes) byId.set(c.id, c);

let added = 0, kept = 0;
for (const d of raw) {
  for (const c of d.changes || []) {
    if (byId.has(c.id)) { kept++; continue; }
    // 代理人回報的 impactRule 是散文，畫面不需要，但保留在 note 供查核
    const { impactRule, ...rest } = c;
    byId.set(c.id, {
      ...rest,
      impact: inferImpact(c),
      note: [c.note, impactRule ? `計算方式：${impactRule}` : ''].filter(Boolean).join('\n'),
    });
    added++;
  }
}

// 把種子條目缺的 impact 也補上（理論上都有，防呆）
for (const c of byId.values()) {
  if (!c.impact) c.impact = inferImpact(c);
}

const changes = [...byId.values()]
  .sort((a, b) => String(b.effectiveDate).localeCompare(String(a.effectiveDate)));

const kinds = {};
for (const c of changes) kinds[c.impact.kind] = (kinds[c.impact.kind] || 0) + 1;

const out = {
  version: '2026-08',
  verifiedAt: '2026-08-04',
  note: seed.note,
  changes,
};

await writeFile('assets/data/tw-changes.json', JSON.stringify(out, null, 1));

console.log(`合併完成：${changes.length} 條（種子保留 ${kept}，新增 ${added}）`);
console.log('影響計算種類分布：', JSON.stringify(kinds));
console.log('可算出金額的條目：', changes.filter((c) => c.impact.kind !== 'info').length);
const byYear = {};
for (const c of changes) { const y = String(c.effectiveDate).slice(0, 4); byYear[y] = (byYear[y] || 0) + 1; }
console.log('依年份：', JSON.stringify(byYear));
