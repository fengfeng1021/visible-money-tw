/* 共用金融數學。多個 App 會用到的部分集中在這裡，避免七份各自寫錯一次。
   單位約定：利率一律用「年利率的小數」（0.0215），期數一律用「月」。 */

/** 本息平均攤還月付金。i = 月利率。i = 0 時退化為等額攤本金。 */
export function pmt(principal, monthlyRate, n) {
  if (n <= 0) return 0;
  if (!Number.isFinite(monthlyRate) || monthlyRate === 0) return principal / n;
  return (principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -n));
}

/** 由月付金反解可貸本金 */
export function principalFromPmt(payment, monthlyRate, n) {
  if (n <= 0) return 0;
  if (!Number.isFinite(monthlyRate) || monthlyRate === 0) return payment * n;
  return (payment * (1 - Math.pow(1 + monthlyRate, -n))) / monthlyRate;
}

/** 給定月付金與餘額，還要幾期還完（可能非整數） */
export function periodsToClear(balance, payment, monthlyRate) {
  if (payment <= 0) return Infinity;
  if (monthlyRate === 0) return balance / payment;
  const denom = payment - balance * monthlyRate;
  if (denom <= 0) return Infinity; // 月付連利息都不夠，永遠還不完
  return -Math.log(denom / payment) / Math.log(1 + monthlyRate);
}

/**
 * 攤還表。支援：寬限期、分段利率、額外還本、三種還款方式。
 * @param {object} o
 *   principal, totalMonths, graceMonths,
 *   rateSegments: [{ from: 1, rate: 0.0215 }]  期數起點（1-based）由小到大
 *   extras: [{ month, amount, mode: 'shorten'|'lower', repeatYearly }]
 *   method: 'annuity' | 'equalPrincipal' | 'interestOnly'
 * @returns {{ rows, totalInterest, totalPaid, cliff, months }}
 */
export function amortize(o) {
  const {
    principal, totalMonths, graceMonths = 0,
    rateSegments = [{ from: 1, rate: 0.02 }],
    extras = [], method = 'annuity',
  } = o;

  const segs = [...rateSegments].sort((a, b) => a.from - b.from);
  const rateAt = (m) => {
    let r = segs[0]?.rate ?? 0;
    for (const s of segs) { if (m >= s.from) r = s.rate; else break; }
    return r / 12;
  };

  // 展開額外還本（含每年重複）
  const extraMap = new Map();
  for (const e of extras) {
    if (!e || !Number.isFinite(e.amount) || e.amount <= 0) continue;
    const push = (m) => {
      if (m < 1 || m > totalMonths) return;
      const prev = extraMap.get(m);
      if (prev) prev.amount += e.amount;
      else extraMap.set(m, { amount: e.amount, mode: e.mode || 'shorten' });
    };
    if (e.repeatYearly) { for (let m = e.month; m <= totalMonths; m += 12) push(m); }
    else push(e.month);
  }

  const rows = [];
  let balance = principal;
  let payment = 0;
  let lastRate = null;
  let remaining = totalMonths;
  let totalInterest = 0;
  let totalPaid = 0;
  let cliff = null;
  const jumps = [];
  const equalPrincipalPart = principal / Math.max(1, totalMonths - graceMonths);

  for (let m = 1; m <= totalMonths && balance > 0.005; m++) {
    const i = rateAt(m);
    const inGrace = m <= graceMonths;
    const monthsLeft = totalMonths - m + 1;

    let interest = balance * i;
    let principalPart = 0;

    if (method === 'interestOnly') {
      principalPart = m === totalMonths ? balance : 0;
      payment = interest + principalPart;
    } else if (inGrace) {
      principalPart = 0;
      payment = interest;
    } else if (method === 'equalPrincipal') {
      principalPart = Math.min(balance, equalPrincipalPart);
      payment = principalPart + interest;
    } else {
      // 利率變動、寬限期屆滿、或額外還本降月付 → 重算月付金
      if (lastRate === null || i !== lastRate || payment === 0) {
        payment = pmt(balance, i, monthsLeft);
        lastRate = i;
      }
      principalPart = Math.min(balance, payment - interest);
      if (principalPart < 0) principalPart = 0;
      payment = interest + principalPart;
    }

    // 斷崖：月付金相對前一期跳升超過 5% 的所有時點。
    // 取「最大」的那一次當主斷崖，不是第一次 —— 分段利率的小台階常常排在
    // 寬限期屆滿之前，取第一次會把 7% 的小台階講成斷崖，把真正的 2.9 倍蓋掉。
    const prev = rows[rows.length - 1];
    if (prev && payment > prev.payment * 1.05) {
      const jump = {
        month: m,
        before: prev.payment,
        after: payment,
        delta: payment - prev.payment,
        ratio: payment / prev.payment,
        cause: prev.grace && !inGrace ? 'grace' : 'rate',
      };
      jumps.push(jump);
      if (!cliff || jump.ratio > cliff.ratio) cliff = jump;
    }

    balance -= principalPart;

    const ex = extraMap.get(m);
    let extraPaid = 0;
    if (ex && balance > 0) {
      extraPaid = Math.min(balance, ex.amount);
      balance -= extraPaid;
      if (ex.mode === 'lower') {
        payment = 0; // 觸發下一期以新餘額重算
        lastRate = null;
      }
    }

    totalInterest += interest;
    totalPaid += payment + extraPaid;

    rows.push({
      m, payment, interest, principal: principalPart,
      extra: extraPaid, balance: Math.max(0, balance),
      rate: i * 12, grace: inGrace,
    });

    if (balance <= 0.005) { remaining = m; break; }
    remaining = m;
  }

  return {
    rows, totalInterest, totalPaid, cliff, jumps,
    months: remaining,
    clearedEarly: remaining < totalMonths,
  };
}

/* ---------- 現金流 ---------- */

export function npv(rate, flows) {
  return flows.reduce((s, cf, i) => s + cf / Math.pow(1 + rate, i), 0);
}

/** IRR（等距期間）。Newton 失敗時退回二分法。 */
export function irr(flows, guess = 0.08) {
  let r = guess;
  for (let k = 0; k < 60; k++) {
    let f = 0, df = 0;
    for (let i = 0; i < flows.length; i++) {
      const d = Math.pow(1 + r, i);
      f += flows[i] / d;
      if (i > 0) df -= (i * flows[i]) / (d * (1 + r));
    }
    if (Math.abs(f) < 1e-9) return r;
    if (!Number.isFinite(df) || df === 0) break;
    const next = r - f / df;
    if (!Number.isFinite(next) || next <= -0.999) break;
    if (Math.abs(next - r) < 1e-10) return next;
    r = next;
  }
  return bisect((x) => npv(x, flows));
}

/** XIRR：不規則日期的年化。dates 為 Date 或毫秒。 */
export function xirr(flows, dates, guess = 0.08) {
  const t0 = +new Date(dates[0]);
  const yrs = dates.map((d) => (+new Date(d) - t0) / (365 * 86400000));
  const f = (r) => flows.reduce((s, cf, i) => s + cf / Math.pow(1 + r, yrs[i]), 0);
  const df = (r) => flows.reduce((s, cf, i) => s - (yrs[i] * cf) / Math.pow(1 + r, yrs[i] + 1), 0);

  let r = guess;
  for (let k = 0; k < 60; k++) {
    const v = f(r), d = df(r);
    if (Math.abs(v) < 1e-8) return r;
    if (!Number.isFinite(d) || d === 0) break;
    const next = r - v / d;
    if (!Number.isFinite(next) || next <= -0.999) break;
    if (Math.abs(next - r) < 1e-11) return next;
    r = next;
  }
  return bisect(f);
}

function bisect(f, lo = -0.99, hi = 10) {
  let flo = f(lo), fhi = f(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return NaN;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (Math.abs(fm) < 1e-10 || hi - lo < 1e-12) return mid;
    if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

/* ---------- 統計 ---------- */

export function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN; }

export function stdev(a) {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

export function maxDrawdown(series) {
  let peak = -Infinity, mdd = 0, peakAt = 0, troughAt = 0, curPeakAt = 0;
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (v > peak) { peak = v; curPeakAt = i; }
    const dd = peak > 0 ? (v - peak) / peak : 0;
    if (dd < mdd) { mdd = dd; peakAt = curPeakAt; troughAt = i; }
  }
  return { mdd, peakAt, troughAt };
}

/** 可重現的偽隨機（同一個情境每次跑出同一張圖，使用者才信得過） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 常態亂數（Box-Muller） */
export function gauss(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 區塊拔靴：保留報酬序列的自相關，比逐年獨立抽樣誠實 */
export function blockBootstrap(source, n, blockLen, rand) {
  const out = [];
  if (!source.length) return out;
  while (out.length < n) {
    const start = Math.floor(rand() * source.length);
    for (let k = 0; k < blockLen && out.length < n; k++) {
      out.push(source[(start + k) % source.length]);
    }
  }
  return out;
}

/* ---------- 台灣通用規則 ---------- */

/** 累進稅額：brackets = [{ upTo, rate, quick }]，quick 為累進差額 */
export function progressiveTax(netIncome, brackets) {
  if (!(netIncome > 0)) return { tax: 0, rate: 0, bracket: 0 };
  for (let i = 0; i < brackets.length; i++) {
    const b = brackets[i];
    if (netIncome <= b.upTo || b.upTo == null) {
      return { tax: Math.max(0, netIncome * b.rate - b.quick), rate: b.rate, bracket: i };
    }
  }
  const last = brackets[brackets.length - 1];
  return { tax: Math.max(0, netIncome * last.rate - last.quick), rate: last.rate, bracket: brackets.length - 1 };
}

/** 二代健保補充保費：單筆給付達門檻才起扣，且有單次費基上限 */
export function nhiSupplement(amount, { rate = 0.0211, floor = 20000, cap = 10000000 } = {}) {
  if (!(amount >= floor)) return 0;
  return Math.min(amount, cap) * rate;
}

/** 台股交易成本。ETF 證交稅 0.1%，個股 0.3%。 */
export function twTradeCost(amount, { side = 'buy', discount = 0.6, minFee = 20, feeRate = 0.001425, taxRate = 0.001 } = {}) {
  if (!(amount > 0)) return 0;
  const fee = Math.max(minFee, Math.round(amount * feeRate * discount));
  const tax = side === 'sell' ? Math.round(amount * taxRate) : 0;
  return fee + tax;
}
