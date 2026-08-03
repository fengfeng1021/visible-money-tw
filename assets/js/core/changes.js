/* 法規變動 → 對你影響多少錢。

   這是新主體的引擎。作法很單純，也正因為單純才誠實：
   同一套計算，用「變動前的常數」跑一次、用「變動後的常數」再跑一次，差額就是影響。
   沒有任何一條是憑感覺標「影響大／中／小」。

   算不出金額的條目就老實說算不出來，並講清楚它影響誰。
*/

import { progressiveTax, pmt, principalFromPmt, nhiSupplement } from './fin.js';
import * as P from './profile.js';

/* ==========================================================================
   影響計算的種類。
   每一種都宣告它需要使用者的哪幾格，缺格就回報缺哪幾格，不要硬算。
   ========================================================================== */

const num = (v) => {
  if (v === null || v === undefined || v === 'null' || v === '') return null;
  const n = Number(String(v).replace(/[,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** 課稅所得淨額。扣除額變動要換算成錢，得先知道使用者落在哪一級。 */
function taxableIncome(prof, rules) {
  const salary = (P.getOr('salary', 0) + P.getOr('spouseSalary', 0)) * 12 + P.getOr('annualBonus', 0);
  const other = P.getOr('otherIncome', 0) + P.getOr('interestIncome', 0);
  const gross = salary + other;
  const heads = 1 + (P.getOr('married', false) ? 1 : 0) + P.getOr('dependents', 0);
  const exemption = heads * (rules?.exemption ?? 97000)
    + P.getOr('dependentsOver70', 0) * ((rules?.exemptionAge70 ?? 145500) - (rules?.exemption ?? 97000));
  const standard = P.getOr('married', false) ? (rules?.standardMarried ?? 262000) : (rules?.standardSingle ?? 131000);
  const salaryDed = Math.min(salary, (rules?.salaryDeduction ?? 218000) * (1 + (P.getOr('married', false) ? 1 : 0)));
  const net = gross - exemption - standard - salaryDed;
  return { gross, net: Math.max(0, net) };
}

/** 邊際稅率：多一塊扣除額實際上省多少 */
function marginalRate(prof, rules) {
  const { net } = taxableIncome(prof, rules);
  const brackets = rules?.brackets || [];
  for (const b of brackets) {
    if (b.upTo == null || net <= b.upTo) return b.rate;
  }
  return brackets.length ? brackets[brackets.length - 1].rate : 0.05;
}

const KINDS = {
  /* 扣除額或免稅額改變 → 少繳的稅 = 差額 × 適用人數（或倍數）× 邊際稅率
     人數規則有三種，寫錯任何一種都會少算或多算：
       household  免稅額這種「每個人都有」的 → 本人 + 配偶 + 扶養親屬
       field      幼兒學前、長照這種「有幾個符合的人」的 → 讀那一格
       single     薪資特扣這種「本人（與配偶）各自適用」的 → 有配偶時加倍
  */
  deduction: {
    need: ['salary'],
    calc(ch, rules) {
      const before = num(ch.before), after = num(ch.after);
      if (before === null || after === null) return null;
      const married = Boolean(P.getOr('married', false));
      const mode = ch.impact?.perHead || 'one';

      let heads = 1;
      let headsWhy = '';
      if (mode === 'household') {
        heads = 1 + (married ? 1 : 0) + P.getOr('dependents', 0);
        headsWhy = `本人${married ? '、配偶' : ''}${P.getOr('dependents', 0) ? `與 ${P.getOr('dependents', 0)} 位受扶養親屬` : ''}共 ${heads} 人`;
      } else if (mode === 'field') {
        heads = P.getOr(ch.impact.headField, 0);
        if (!heads) {
          return { amount: 0, explain: '你沒有適用這一項的人數，所以這一條不影響你。' };
        }
        headsWhy = `${heads} 人適用`;
      } else if (mode === 'perEarner') {
        heads = 1 + (married ? 1 : 0);
        headsWhy = married ? '本人與配偶各自適用' : '只有本人適用';
      } else if (ch.impact?.doubleIfMarried && married) {
        heads = 2;
        headsWhy = '有配偶者加倍扣除';
      }

      const rate = marginalRate(null, rules);
      const amount = (after - before) * heads * rate;
      return {
        amount,
        explain: `每人多了 ${fmt(after - before)} 元扣除額${headsWhy ? `（${headsWhy}）` : ''}，`
          + `以你目前的邊際稅率 ${(rate * 100).toFixed(0)}% 換算，一年少繳 ${fmt(Math.abs(amount))} 元。`,
      };
    },
  },

  /* 課稅級距門檻整組移動 → 用前後兩組級距各算一次稅 */
  brackets: {
    need: ['salary'],
    calc(ch, rules, prev) {
      if (!rules?.brackets || !prev?.brackets) return null;
      const { net } = taxableIncome(null, rules);
      if (!net) return { amount: 0, explain: '你的課稅所得淨額是 0，這一條不影響你。' };
      const a = progressiveTax(net, prev.brackets).tax;
      const b = progressiveTax(net, rules.brackets).tax;
      return {
        amount: a - b,
        explain: `以你的課稅所得淨額 ${fmt(net)} 元，舊級距要繳 ${fmt(a)} 元、新級距要繳 ${fmt(b)} 元，`
          + `差 ${fmt(Math.abs(a - b))} 元。`,
      };
    },
  },

  /* 貸款成數上限改變 → 可多貸的金額 */
  ltv: {
    need: ['savings'],
    calc(ch) {
      const before = num(ch.before), after = num(ch.after);
      if (before === null || after === null) return null;
      // 以使用者的自備款反推他打算買的房價：自備款 ÷ (1 − 舊成數)
      const savings = P.getOr('savings', 0);
      if (!savings) return null;
      const priceBefore = savings / Math.max(0.01, 1 - before);
      const priceAfter = savings / Math.max(0.01, 1 - after);
      return {
        amount: priceAfter - priceBefore,
        explain: `成數從 ${(before * 100).toFixed(0)} 成放寬到 ${(after * 100).toFixed(0)} 成，`
          + `同樣 ${fmt(savings)} 元的自備款，能買的房價從 ${fmt(priceBefore)} 元變成 ${fmt(priceAfter)} 元。`,
      };
    },
  },

  /* 貸款利率改變 → 月付金與總利息的差 */
  mortgageRate: {
    need: ['mortgageBalance', 'mortgageMonthsLeft'],
    calc(ch) {
      const before = num(ch.before), after = num(ch.after);
      if (before === null || after === null) return null;
      const bal = P.getOr('mortgageBalance', 0);
      const n = P.getOr('mortgageMonthsLeft', 0);
      if (!bal || !n) return null;
      const a = pmt(bal, before / 100 / 12, n);
      const b = pmt(bal, after / 100 / 12, n);
      return {
        amount: (a - b) * n,
        monthly: a - b,
        explain: `你的餘額 ${fmt(bal)} 元、剩 ${n} 期，月付金從 ${fmt(a)} 元變成 ${fmt(b)} 元，`
          + `剩餘期間合計差 ${fmt(Math.abs((a - b) * n))} 元。`,
      };
    },
  },

  /* 投保薪資上限改變 → 勞保年金月領差 × 預估請領年數 */
  insuredSalary: {
    need: ['insuredSalary', 'laborYears'],
    calc(ch, rules) {
      const before = num(ch.before), after = num(ch.after);
      if (before === null || after === null) return null;
      const my = P.getOr('insuredSalary', 0);
      const years = P.getOr('laborYears', 0) + P.getOr('laborMonths', 0) / 12;
      if (!my || !years) return null;
      const capped = (cap) => Math.min(my, cap);
      const formulaB = (s) => s * years * 0.0155;
      const a = formulaB(capped(before));
      const b = formulaB(capped(after));
      if (Math.abs(a - b) < 1) {
        return { amount: 0, explain: `你的投保薪資 ${fmt(my)} 元沒有頂到上限，這一條不影響你。` };
      }
      return {
        amount: (b - a) * 12 * 20,
        monthly: b - a,
        explain: `投保薪資上限從 ${fmt(before)} 元調到 ${fmt(after)} 元，你的月領從 ${fmt(a)} 元變成 ${fmt(b)} 元。`
          + `以請領 20 年估算，一生多領 ${fmt(Math.abs((b - a) * 12 * 20))} 元。`,
      };
    },
  },

  /* 補充保費費率或門檻改變 → 全年多扣或少扣的錢 */
  nhi: {
    need: ['annualDividend'],
    calc(ch, rules, prev) {
      const div = P.getOr('annualDividend', 0);
      const payouts = Math.max(1, P.getOr('dividendPayouts', 1));
      if (!div) return null;
      const per = div / payouts;
      const opt = (o) => ({ rate: num(o.rate) ?? 0.0211, floor: num(o.floor) ?? 20000, cap: num(o.cap) ?? 10000000 });
      const a = nhiSupplement(per, opt(ch.impact?.beforeOpts || {})) * payouts;
      const b = nhiSupplement(per, opt(ch.impact?.afterOpts || {})) * payouts;
      return {
        amount: a - b,
        explain: `你一年 ${fmt(div)} 元股利分 ${payouts} 次入帳，每次 ${fmt(per)} 元。`
          + `補充保費從 ${fmt(a)} 元變成 ${fmt(b)} 元。`,
      };
    },
  },

  /* 只有說明、算不出金額 */
  info: { need: [], calc: () => ({ amount: null, explain: null }) },
};

function fmt(v) {
  if (!Number.isFinite(v)) return '-';
  return new Intl.NumberFormat('zh-TW').format(Math.round(v));
}

/* ==========================================================================
   對外
   ========================================================================== */

/**
 * @returns {{state:'affected'|'no-effect'|'need-more'|'info', amount:number|null,
 *            monthly:number|null, explain:string|null, missing:string[]}}
 */
export function evaluate(change, { rules, prevRules } = {}) {
  const kindKey = change.impact?.kind || 'info';
  const kind = KINDS[kindKey] || KINDS.info;

  // 先看這條變動是不是根本不適用這個人。
  // 條件欄位「沒填」跟「填了不符合」是兩件事：沒填就去問，不能直接宣告不影響他 ——
  // 那是在他沒說的情況下替他下結論，正好是本站聲稱不做的事。
  if (change.impact?.onlyIf) {
    const condKeys = Object.keys(change.impact.onlyIf);
    const unknown = P.missing(condKeys);
    if (unknown.length) {
      return { state: 'need-more', amount: null, monthly: null, explain: null, missing: unknown };
    }
    if (!matches(change.impact.onlyIf)) {
      return { state: 'no-effect', amount: null, monthly: null, explain: change.impact.onlyIfMiss || null, missing: [] };
    }
  }

  // 去重：kind 宣告的與條目自己宣告的常常重疊，不去重會把同一格問兩次
  const need = [...new Set([...(kind.need || []), ...(change.impact?.need || [])])];
  const gaps = P.missing(need);
  if (gaps.length) {
    return { state: 'need-more', amount: null, monthly: null, explain: null, missing: gaps };
  }

  let out = null;
  try { out = kind.calc(change, rules, prevRules); } catch { out = null; }
  if (!out) {
    return { state: 'info', amount: null, monthly: null, explain: null, missing: [] };
  }
  if (out.amount === null) {
    return { state: 'info', amount: null, monthly: null, explain: out.explain || null, missing: [] };
  }
  if (Math.abs(out.amount) < 1) {
    return { state: 'no-effect', amount: 0, monthly: null, explain: out.explain, missing: [] };
  }
  return {
    state: 'affected',
    amount: out.amount,
    monthly: out.monthly ?? null,
    explain: out.explain,
    missing: [],
  };
}

/** onlyIf: { hasMortgage: true } 這種簡單條件 */
function matches(cond) {
  return Object.entries(cond).every(([k, v]) => {
    const got = P.getOr(k);
    if (typeof v === 'boolean') return Boolean(got) === v;
    if (v && typeof v === 'object' && 'min' in v) return Number(got) >= v.min;
    return got === v;
  });
}

/** 把整份時間軸依日期排序，最新的在前 */
export function sortChanges(list) {
  return [...list].sort((a, b) => String(b.effectiveDate).localeCompare(String(a.effectiveDate)));
}

/** 上次來訪之後有幾條新變動、合計影響多少 */
export function sinceLastSeen(list, lastSeenISO, evalOpts) {
  if (!lastSeenISO) return null;
  const fresh = list.filter((c) => String(c.effectiveDate) > lastSeenISO);
  if (!fresh.length) return { count: 0, total: 0, items: [] };
  let total = 0;
  const items = [];
  for (const c of fresh) {
    const r = evaluate(c, evalOpts);
    if (r.state === 'affected') { total += r.amount; items.push({ change: c, result: r }); }
  }
  return { count: fresh.length, total, items };
}

/* ==========================================================================
   行事曆匯出（.ics）。
   沒有後端就沒有推播，但「把日期放進使用者自己的行事曆」是一條
   完全靜態、而且比推播更不打擾的召回路徑。
   ========================================================================== */
export function buildICS(events, { name = '看得見的錢' } = {}) {
  const stamp = (d) => String(d).replace(/-/g, '');
  const esc = (s) => String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//visible-money-tw//TW//ZH',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`,
  ];
  for (const e of events) {
    if (!e.date) continue;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.id || Math.abs(hash(e.title + e.date))}@visible-money-tw`,
      `DTSTAMP:${stamp(new Date().toISOString().slice(0, 10))}T000000Z`,
      `DTSTART;VALUE=DATE:${stamp(e.date)}`,
      `SUMMARY:${esc(e.title)}`,
      e.desc ? `DESCRIPTION:${esc(e.desc)}` : 'DESCRIPTION:',
      'BEGIN:VALARM',
      'TRIGGER:-P7D',
      'ACTION:DISPLAY',
      `DESCRIPTION:${esc(e.title)}`,
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
  return h;
}

/** 依使用者的檔案產生屬於他的提醒日期 */
export function personalEvents(rules) {
  const out = [];
  const year = new Date().getFullYear();

  // 報稅季：每年 5 月 1 日
  if (P.has('annualDividend') || P.has('salary')) {
    out.push({
      id: 'tax-season-' + (year + 1),
      date: `${year + 1}-05-01`,
      title: '綜合所得稅申報開始',
      desc: '記得先確認股利要勾合併計稅還是分開計稅。',
    });
  }

  // 寬限期到期
  const grace = P.getOr('mortgageGraceLeft', 0);
  if (grace > 0) {
    const d = new Date();
    d.setMonth(d.getMonth() + grace);
    out.push({
      id: 'grace-end',
      date: d.toISOString().slice(0, 10),
      title: '房貸寬限期到期，月付金會跳升',
      desc: '寬限期結束後要用剩餘年數還完全部本金，月付金通常會跳一到三倍。',
    });
  }

  // 勞保法定請領年齡
  const birth = P.getOr('birthYearROC', 0);
  if (birth) {
    const table = rules?.claimAgeByBirthYear || [];
    let legal = 65;
    for (const row of table) {
      const m = String(row.birthYearROC).match(/(\d+)/);
      if (!m) continue;
      if (String(row.birthYearROC).includes('以前') && birth <= Number(m[1])) { legal = row.legalAge; break; }
      if (String(row.birthYearROC).includes('以後') && birth >= Number(m[1])) { legal = row.legalAge; break; }
      if (birth === Number(m[1])) { legal = row.legalAge; break; }
    }
    out.push({
      id: 'pension-age',
      date: `${birth + 1911 + legal}-01-01`,
      title: `你在這一年滿 ${legal} 歲，可以請領勞保老年年金`,
      desc: '提前領每年減 4%、延後領每年增 4%，各以 5 年為限。',
    });
  }

  return out;
}
