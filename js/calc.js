// Straight ports of the Android calculators (FdCalculator, RdCalculator, PpfEpfCalculator).
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

export function addMonths(ts, m) { const d = new Date(ts); d.setMonth(d.getMonth() + m); return d.getTime(); }
const addDays = (ts, n) => { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); };

const periods = (f) => ({ MONTHLY: 12, QUARTERLY: 4, ANNUALLY: 1, CUMULATIVE: 4 }[f] || 4);

export const fd = {
  maturityDate: (x) => addDays(addMonths(x.startDate, x.tenureMonths), x.tenureExtraDays || 0),
  payoutAmount: (x) => x.principalAmount * (x.interestRate / 100) / periods(x.payoutFrequency),
  nextPayoutDue(x) {
    const base = x.lastInterestPayoutAt ?? x.startDate;
    const f = x.payoutFrequency;
    if (f === 'QUARTERLY') return addMonths(base, 3);
    if (f === 'ANNUALLY') return addMonths(base, 12);
    return addMonths(base, 1);
  },
  maturityValue(x) {
    if (x.payoutMode === 'PAYOUT') return x.principalAmount;
    const years = (x.tenureMonths + (x.tenureExtraDays || 0) / 30.44) / 12;
    const rate = x.interestRate / 100;
    if (x.interestType === 'SIMPLE') return x.principalAmount * (1 + rate * years);
    const n = periods(x.compoundingFrequency);
    return x.principalAmount * Math.pow(1 + rate / n, n * years);
  },
  currentValue(x, now = Date.now()) {
    const maturity = fd.maturityDate(x);
    if (x.payoutMode === 'PAYOUT') {
      if (now >= maturity) return x.principalAmount;
      const per = periods(x.payoutFrequency);
      const periodMs = YEAR_MS / per;
      const last = x.lastInterestPayoutAt ?? x.startDate;
      const frac = Math.min(1, Math.max(0, (now - last) / periodMs));
      return x.principalAmount + fd.payoutAmount(x) * frac;
    }
    if (now >= maturity) return fd.maturityValue(x);
    if (now <= x.startDate) return x.principalAmount;
    const yrs = (now - x.startDate) / YEAR_MS;
    const rate = x.interestRate / 100;
    if (x.interestType === 'SIMPLE') return x.principalAmount * (1 + rate * yrs);
    const n = periods(x.compoundingFrequency);
    return x.principalAmount * Math.pow(1 + rate / n, n * yrs);
  },
};

export const rd = {
  maturityDate: (x) => addMonths(x.startDate, x.tenureMonths),
  maturityValue(x) {
    const n = periods(x.compoundingFrequency), rate = x.interestRate / 100;
    let total = 0;
    for (let i = 1; i <= x.tenureMonths; i++) total += x.monthlyInstallment * Math.pow(1 + rate / n, n * ((x.tenureMonths - i + 1) / 12));
    return total;
  },
  currentValueSchedule(x, now = Date.now()) {
    const elapsed = Math.min(x.tenureMonths, Math.max(0, Math.floor((now - x.startDate) / (30.44 * 86400000))));
    if (elapsed <= 0) return 0;
    if (elapsed >= x.tenureMonths) return rd.maturityValue(x);
    const n = periods(x.compoundingFrequency), rate = x.interestRate / 100;
    let total = 0;
    for (let i = 1; i <= elapsed; i++) total += x.monthlyInstallment * Math.pow(1 + rate / n, n * ((elapsed - i + 1) / 12));
    return total;
  },
  currentValueFromEntries(x, installments, now = Date.now()) {
    if (!installments.length) return 0;
    const n = periods(x.compoundingFrequency), rate = x.interestRate / 100;
    return installments.reduce((s, i) => s + i.amount * Math.pow(1 + rate / n, n * Math.max(0, (now - i.installmentDate) / YEAR_MS)), 0);
  },
};

/** deposits: [[date, amount]] (INTEREST entries already removed). rates: [{ratePercent, effectiveFrom}] */
export function ppfEpfValue(deposits, rates, asOf = Date.now()) {
  if (!deposits.length) return 0;
  const sortedRates = [...rates].sort((a, b) => a.effectiveFrom - b.effectiveFrom);
  if (!sortedRates.length) return deposits.reduce((s, d) => s + d[1], 0);
  const sorted = [...deposits].sort((a, b) => a[0] - b[0]);
  const e = new Date(sorted[0][0]);
  let fyYear = e.getMonth() >= 3 ? e.getFullYear() : e.getFullYear() - 1;
  let opening = 0;
  for (;;) {
    const fyStart = new Date(fyYear, 3, 1, 0, 0, 0, 0).getTime();
    if (fyStart > asOf) break;
    const fyEnd = new Date(fyYear + 1, 3, 1, 0, 0, 0, 0).getTime();
    let rateForYear = sortedRates.filter(r => r.effectiveFrom <= fyStart).pop()?.ratePercent ?? sortedRates[0].ratePercent;
    const monthlyRate = rateForYear / 100 / 12;
    let yearInterest = 0;
    for (let m = 0; m < 12; m++) {
      const fifth = new Date(fyYear, 3 + m, 5, 23, 59, 0, 0).getTime();
      if (fifth > asOf) break;
      const cum = sorted.filter(d => d[0] >= fyStart && d[0] <= fifth).reduce((s, d) => s + d[1], 0);
      yearInterest += (opening + cum) * monthlyRate;
    }
    const periodEnd = Math.min(fyEnd, asOf + 1);
    const depositsThisYear = sorted.filter(d => d[0] >= fyStart && d[0] < periodEnd).reduce((s, d) => s + d[1], 0);
    opening += depositsThisYear + yearInterest;
    fyYear += 1;
  }
  return opening;
}

// ---- Loans (same reducing-balance method as the Android app) ----
export function loanEmi(principal, ratePct, months) {
  if (!(months > 0) || !(principal > 0)) return 0;
  const r = ratePct / 12 / 100; if (r === 0) return principal / months;
  const f = Math.pow(1 + r, months); return principal * r * f / (f - 1);
}
function nextMonth(ts) { // calendar step that keeps month-ends (31 Jan -> 28 Feb), like Android's Calendar.add(MONTH)
  const d = new Date(ts), day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + 1);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); return d.getTime();
}
export function loanSchedule(principal, ratePct, months, startDate) {
  const out = []; if (!(months > 0) || !(principal > 0)) return out;
  const emi = loanEmi(principal, ratePct, months), r = ratePct / 12 / 100; let bal = principal, when = startDate;
  for (let n = 1; n <= months; n++) {
    when = nextMonth(when); const open = bal, interest = open * r; let prin = emi - interest, close = open - prin;
    if (n === months || close < 0) { prin = open; close = 0; }
    out.push({ installmentNumber: n, dueDate: when, emiAmount: n === months ? prin + interest : emi, principalComponent: prin, interestComponent: interest, openingBalance: open, closingBalance: close, isPaid: false, paidDate: null, isPrepayment: false });
    bal = close;
  }
  return out;
}
