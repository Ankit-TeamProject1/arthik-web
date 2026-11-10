// Turns the backup JSON (format "arthik-backup", schema 3) into the numbers the screens show.
// Mirrors WealthDashboardViewModel on Android so both apps agree.
import { fd, rd, ppfEpfValue, addMonths } from './calc.js';

export const CATS = [
  { key: 'fd', label: 'FD and NSC', code: 'FD', color: '#3B82F6', ill: 'fd' },
  { key: 'rd', label: 'RD', code: 'RD', color: '#14B8A6', ill: 'rd' },
  { key: 'ppf', label: 'PPF', code: 'PF', color: '#8B5CF6', ill: 'ppf' },
  { key: 'epf', label: 'EPF', code: 'EP', color: '#6366F1', ill: 'epf' },
  { key: 'nps', label: 'NPS', code: 'NP', color: '#F59E0B', ill: 'nps' },
  { key: 'apy', label: 'APY', code: 'AP', color: '#EC4899', ill: 'apy' },
  { key: 'mf', label: 'Mutual Funds', code: 'MF', color: '#0EA5E9', ill: 'mf' },
  { key: 'demat', label: 'Demat', code: 'DM', color: '#10B981', ill: 'demat' },
  { key: 'insurance', label: 'Insurance', code: 'IN', color: '#06B6D4', ill: 'ins' },
  { key: 'metal', label: 'Gold and Silver', code: 'AU', color: '#EAB308', ill: 'gold' },
  { key: 'asset', label: 'Manual Assets', code: 'MA', color: '#A16207', ill: 'manual' },
  { key: 'bank', label: 'Bank', code: 'BK', color: '#2563EB', ill: 'bank' },
  { key: 'receivable', label: 'Receivables', code: 'RC', color: '#22C55E', ill: 'recv' },
  { key: 'kametti', label: 'Kametti', code: 'KM', color: '#F97316', ill: 'kam' },
  { key: 'cash', label: 'Cash in Hand', code: 'CH', color: '#16A34A', ill: 'cash' },
];

const live = (a) => (a || []).filter(x => !x.isArchived);
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const upper = (s) => (s || '').charAt(0).toUpperCase() + (s || '').slice(1).toLowerCase();

export function activeBooks(data) { return (data.books || []).filter(b => !b.isArchived); }
export function wealthBooks(data) { return (data.books || []).filter(b => b.bookType === 'WEALTH' && !b.isArchived); }
export function expenseBooks(data) { return (data.books || []).filter(b => b.bookType === 'EXPENSE' && !b.isArchived); }

export function metalLabel(m) { return `${upper(m.metalType)} ${m.caratType} (${upper(m.form)})`; }

const tenureText = (x) => { const tm = x.tenureMonths || 0, y = Math.floor(tm / 12), mo = tm % 12, d = x.tenureExtraDays || 0, p = [];
  if (y) p.push(y + (y === 1 ? ' year' : ' years')); if (mo) p.push(mo + (mo === 1 ? ' month' : ' months')); if (d) p.push(d + (d === 1 ? ' day' : ' days')); return p.join(' ') || '0 days'; };
const fyEndOf = (now) => { const d = new Date(now), y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return new Date(y + 1, 2, 31, 23, 59, 0, 0).getTime(); };

export function computeBook(book, rateHistory = [], now = Date.now()) {
  const rates = (inst) => rateHistory.filter(r => r.instrument === inst);
  const cats = {}; CATS.forEach(c => { cats[c.key] = { ...c, items: [], total: 0, cost: 0 }; });
  const add = (key, item) => {
    item.excluded = !!item.excluded;
    cats[key].items.push(item);
    if (!item.excluded) { cats[key].total += item.value; cats[key].cost += item.cost || 0; }
  };

  live(book.fixedDeposits).forEach(x => {
    const liveV = fd.currentValue(x, now), mat = fd.maturityDate(x), matured = now >= mat;
    const value = matured ? liveV : x.principalAmount;
    const lines = [`${x.interestRate}% · ${tenureText(x)} · matures ${fmtDate(mat)}`];
    if (!matured) lines.push(`Accrued interest (not counted yet): ${money(Math.max(0, liveV - x.principalAmount))}`);
    if (x.payoutMode === 'PAYOUT') { const yrs = (x.tenureMonths + (x.tenureExtraDays || 0) / 30.44) / 12; lines.push(`Total interest over the tenure (paid out): ${money(x.principalAmount * x.interestRate / 100 * yrs)} · principal back at maturity: ${money(x.principalAmount)}`); }
    else { const mv = fd.maturityValue(x); lines.push(`${matured ? 'Matured' : 'At maturity'}: ${money(mv)} · total interest ${money(Math.max(0, mv - x.principalAmount))}`); }
    if (x.payoutMode === 'PAYOUT') lines.push(`Interest paid out ${x.payoutFrequency.toLowerCase()} · next ${fmtDate(fd.nextPayoutDue(x))} · ${money(fd.payoutAmount(x))}`);
    add('fd', { src: x, id: 'fd:' + x.name, name: x.name, sub: [x.kind, x.bankName].filter(Boolean).join(' · '), value, cost: x.principalAmount, lines, excluded: x.excludeFromNetWorth });
  });

  live(book.recurringDeposits).forEach(x => {
    const inst = x.installments || [];
    const raw = sum(inst, i => i.amount);
    const liveV = inst.length ? rd.currentValueFromEntries(x, inst, now) : rd.currentValueSchedule(x, now);
    const mat = rd.maturityDate(x), matured = now >= mat;
    const value = matured ? liveV : raw;
    add('rd', { src: x, name: x.name, sub: [x.bankName, `${money(x.monthlyInstallment)}/month`].filter(Boolean).join(' · '), value, cost: raw,
      lines: [`${x.interestRate}% · ${inst.length} instalments recorded · matures ${fmtDate(mat)}`,
              ...(matured ? [] : [`Accrued interest (not counted yet): ${money(Math.max(0, liveV - raw))}`]),
              (() => { const mv = rd.maturityValue(x), dep = x.monthlyInstallment * x.tenureMonths; return `At maturity (if every instalment is paid): ${money(mv)} · total interest ${money(Math.max(0, mv - dep))}`; })()], excluded: x.excludeFromNetWorth });
  });

  live(book.ppfAccounts).forEach(x => {
    const all = x.deposits || [];
    const principal = sum(all, d => d.amount);
    const dep = all.filter(d => d.type !== 'INTEREST').map(d => [d.depositDate, d.amount]);
    const liveV = ppfEpfValue(dep, rates('PPF'), now);
    add('ppf', { src: x, name: x.name, sub: [x.bankOrPostOfficeName, x.accountNumber].filter(Boolean).join(' · '), value: principal, cost: sum(dep, d => d[1]),
      lines: [`Opened ${fmtDate(x.accountOpenDate)} · ${all.length} entries`, `Interest not yet credited (not counted): ${money(Math.max(0, liveV - principal))}`,
      (() => { const fe = fyEndOf(now), v = ppfEpfValue(dep, rates('PPF'), fe); return `Estimated interest by year end (${fmtDate(fe)}): ${money(Math.max(0, v - principal))} · balance then ${money(v)}`; })()], excluded: x.excludeFromNetWorth });
  });

  live(book.epfAccounts).forEach(x => {
    const all = x.contributions || [];
    const ee = all.filter(c => c.tileType === 'EMPLOYEE_EMPLOYER').map(c => [c.contributionDate, c.amount]);
    const pension = sum(all.filter(c => c.tileType === 'PENSION'), c => c.amount);
    const eeP = sum(ee, c => c[1]);
    const liveV = ppfEpfValue(ee, rates('EPF'), now);
    add('epf', { src: x, name: x.name, sub: [x.companyName, x.uan ? 'UAN ' + x.uan : ''].filter(Boolean).join(' · '), value: eeP + pension, cost: eeP,
      lines: [`Employee + employer ${money(eeP)} · Pension ${money(pension)}`, `Interest not yet credited (not counted): ${money(Math.max(0, liveV - eeP))}`,
      (() => { const fe = fyEndOf(now), v = ppfEpfValue(ee, rates('EPF'), fe); return `Estimated interest by year end (${fmtDate(fe)}): ${money(Math.max(0, v - eeP))} · employee + employer balance then ${money(v)}`; })()], excluded: x.excludeFromNetWorth });
  });

  live(book.npsAccounts).forEach(x => add('nps', { src: x, name: x.name, sub: [`Tier ${x.tier}`, x.pfm].filter(Boolean).join(' · '), value: x.currentValue,
    lines: [`Value updated ${fmtDate(x.lastUpdatedAt)}`, ...(x.monthlyContribution ? [`Monthly ${money(x.monthlyContribution)}`] : [])], excluded: x.excludeFromNetWorth }));

  live(book.apyAccounts).forEach(x => add('apy', { src: x, name: x.name, sub: [x.bankName, `Pension slab ${money(x.pensionSlab)}`].filter(Boolean).join(' · '), value: x.totalContributedSoFar,
    lines: [`Monthly ${money(x.monthlyContribution)} · started ${fmtDate(x.startDate)}`], excluded: x.excludeFromNetWorth }));

  live(book.mutualFunds).forEach(x => {
    const es = x.entries || [];
    const units = sum(es, e => e.unitsAllotted), invested = sum(es, e => e.investedAmount);
    const avgNav = units > 0 ? invested / units : 0;
    const nav = x.lastFetchedNav ?? avgNav;
    const value = units * nav;
    const gain = invested > 0 ? (value - invested) / invested * 100 : null;
    add('mf', { src: x, name: x.schemeName, sub: [x.fundHouse, x.platformName].filter(Boolean).join(' · '), value, cost: invested,
      lines: [`${units.toFixed(3)} units · invested ${money(invested)}${gain === null ? '' : ' · ' + pct(gain)}`,
              x.lastFetchedNav == null ? 'No saved NAV yet — valued at your average cost' : `NAV ${nav.toFixed(4)} as of ${fmtDate(x.lastFetchedAt)}`,
              ...(x.sip && !x.sip.isHeld ? [`SIP ${money(x.sip.sipAmount)}/month`] : [])], excluded: x.excludeFromNetWorth });
  });

  live(book.dematHoldings).forEach(x => {
    // Backups from Android don't carry holding type / face value, so every holding is valued like a share.
    const price = x.lastFetchedPrice ?? (x.avgBuyPrice > 0 ? x.avgBuyPrice : 0);
    const value = x.unitsHeld * price;
    const cost = x.avgBuyPrice > 0 ? x.unitsHeld * x.avgBuyPrice : 0;
    add('demat', { src: x, name: x.stockSymbol, sub: [x.exchangeCode, x.accountName].filter(Boolean).join(' · '), value, cost,
      lines: [`${x.unitsHeld} units · avg ${money(x.avgBuyPrice)}`, x.lastFetchedPrice == null ? 'No saved price — valued at your average cost' : `Price ${money(price)} as of ${fmtDate(x.lastFetchedAt)}`], excluded: x.excludeFromNetWorth });
  });

  live(book.insurancePolicies).forEach(x => add('insurance', { src: x, name: x.policyName, sub: [x.insurerName, x.policyType].filter(Boolean).join(' · '),
    value: x.hasCashValue ? x.currentSurrenderValue : 0,
    lines: [`Sum assured: ${money(x.sumAssured)}`, x.hasCashValue ? `Surrender value: ${money(x.currentSurrenderValue)}` : 'No cash value',
            ...(x.nextDueDate ? [`Next premium ${money(x.premiumAmount)} on ${fmtDate(x.nextDueDate)}`] : [])], excluded: x.excludeFromNetWorth }));

  live(book.metalHoldings).forEach(x => add('metal', { src: x, name: metalLabel(x), sub: `${x.quantityGrams} g`, value: x.quantityGrams * (x.currentPricePerGram ?? 0),
    lines: [x.currentPricePerGram == null ? 'No price saved' : `${money(x.currentPricePerGram)} per gram`], excluded: x.excludeFromNetWorth }));

  live(book.manualAssets).forEach(x => add('asset', { src: x, name: x.name, sub: assetLabel(x.assetType), value: x.currentValue, lines: [`Updated ${fmtDate(x.lastUpdatedByUserAt)}`], excluded: x.excludeFromNetWorth }));
  live(book.bankBalances).forEach(x => add('bank', { src: x, name: x.bankName, sub: x.accountDetails, value: x.currentBalance, lines: [], excluded: x.excludeFromNetWorth }));
  live(book.wealthReceivables).forEach(x => add('receivable', { src: x, name: x.personName, sub: x.note, value: x.currentAmount, lines: [`Updated ${fmtDate(x.lastUpdatedAt)}`], excluded: x.excludeFromNetWorth }));
  live(book.kamettiAccounts).forEach(x => {
    const bal = sum(x.entries || [], e => e.amount);
    add('kametti', { src: x, name: x.name, sub: `${money(x.monthlyAmount)}/month · ${x.totalMonths} months`, value: bal, lines: [`${(x.entries || []).length} entries`], excluded: x.excludeFromNetWorth });
  });
  add('cash', { name: 'Cash in hand', sub: '', value: Number(book.cashInHand || 0), lines: [], excluded: !!book.cashExcludedFromNetWorth });

  // Liabilities (manual) + loans (scheduled)
  const liabilities = [];
  live(book.liabilities).forEach(x => liabilities.push({ key: 'liability', src: x, kind: 'Liability', name: x.name, sub: liabLabel(x.liabilityType), value: x.outstandingBalance,
    lines: x.emiAmount > 0 ? [`EMI ${money(x.emiAmount)}/month · ${x.interestRate}%`] : [x.dueDate ? `Pay by ${fmtDate(x.dueDate)} · no interest` : 'One payment · no interest'], excluded: !!x.excludeFromNetWorth }));
  live(book.loans).forEach(x => {
    const pays = x.payments || [];
    const next = pays.filter(p => !p.isPaid && !p.isPrepayment).sort((a, b) => a.installmentNumber - b.installmentNumber)[0];
    const outstanding = next ? next.openingBalance : (pays.length ? 0 : x.principal);
    liabilities.push({ key: 'loan', src: x, kind: 'Loan', name: x.name, sub: x.lenderName || 'Loan · EMI schedule', value: outstanding,
      lines: [next ? `Next EMI ${money(next.emiAmount)} on ${fmtDate(next.dueDate)}` : 'All instalments paid', `${x.annualInterestRatePercent}% · ${x.tenureMonths} months`], excluded: !!x.excludeFromNetWorth });
  });
  const liabTotal = sum(liabilities.filter(l => !l.excluded), l => l.value);

  const list = CATS.map(c => cats[c.key]);
  const assets = sum(list, c => c.total);
  const rent = live(book.rentReceivables);
  return { cats: list, byKey: cats, assets, liabilities, liabTotal, netWorth: assets - liabTotal, rent, goals: goalProgress(book, cats, now) };
}

export const GOAL_MAP = { FD: 'fd', RD: 'rd', DEMAT: 'demat', MUTUAL_FUND: 'mf', MANUAL_ASSET: 'asset', PPF: 'ppf', EPF: 'epf', NPS: 'nps', APY: 'apy',
  INSURANCE: 'insurance', KAMETTI: 'kametti', BANK_BALANCE: 'bank', METAL: 'metal', WEALTH_RECEIVABLE: 'receivable' };

function goalProgress(book, cats) {
  return live(book.goals).map(g => {
    let current = 0; const linked = [];
    (g.linkedAssets || []).forEach(l => {
      const cat = cats[GOAL_MAP[l.type]]; if (!cat) return;
      const item = cat.items.find(i => i.name === l.name);
      if (!item) return;
      linked.push({ cat: cat.label, name: l.name, value: item.value });
      if (!item.excluded) current += item.value;
    });
    return { src: g, name: g.name, target: g.targetAmount, targetDate: g.targetDate, current, linked, pct: g.targetAmount > 0 ? Math.min(100, current / g.targetAmount * 100) : 0 };
  });
}

/** Months of spending covered, as a rough health indicator is left for Phase 3. */

// ---- formatting helpers (Indian digit grouping) ----
let SYM = '₹', INDIAN = true, MASK = false;
export function setMask(v) { MASK = !!v; }
export function setCurrency(code) {
  INDIAN = !code || code === 'INR';
  try { SYM = INDIAN ? '₹' : new Intl.NumberFormat('en', { style: 'currency', currency: code }).formatToParts(0).find(p => p.type === 'currency').value; }
  catch { SYM = code + ' '; }
}
export function money(n) {
  if (n == null || isNaN(n)) return '—';
  if (MASK) return SYM + '••••••';
  const neg = n < 0; let s = Math.round(Math.abs(n)).toString();
  if (INDIAN) { if (s.length > 3) { const last3 = s.slice(-3); let rest = s.slice(0, -3); rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ','); s = rest + ',' + last3; } }
  else s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '−' : '') + SYM + s;
}
export function pct(n) { return (n >= 0 ? '▲ ' : '▼ ') + Math.abs(n).toFixed(1) + '%'; }
export function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
export { addMonths };

// ---------- Expense books ----------
const pad = (n) => String(n).padStart(2, '0');
export const localMonth = (ts) => { const d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1); };
// The Android app groups budgets by UTC month, so budgets here do the same to give the same numbers.
export const utcMonth = (ts) => { const d = new Date(ts); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1); };

export function computeExpense(book, now = Date.now()) {
  const txs = (book.transactions || []).filter(t => !t.isDeleted).slice().sort((a, b) => b.occurredAt - a.occurredAt);
  const accAll = book.accounts || [], catAll = book.categories || [];
  const acc = Object.fromEntries(accAll.map(a => [a.localId, a])), cat = Object.fromEntries(catAll.map(c => [c.localId, c]));
  const bal = Object.fromEntries(accAll.map(a => [a.localId, 0]));
  txs.forEach(t => {
    if (t.type === 'INCOME') bal[t.accountLocalId] = (bal[t.accountLocalId] || 0) + t.amount;
    else if (t.type === 'EXPENSE') bal[t.accountLocalId] = (bal[t.accountLocalId] || 0) - t.amount;
    else if (t.type === 'TRANSFER') { bal[t.accountLocalId] = (bal[t.accountLocalId] || 0) - t.amount; if (t.toAccountLocalId != null) bal[t.toAccountLocalId] = (bal[t.toAccountLocalId] || 0) + t.amount; }
  });
  const accounts = accAll.filter(a => !a.isArchived).map(a => ({ ...a, balance: bal[a.localId] || 0 }));
  const sod = new Date(now); sod.setHours(0, 0, 0, 0);
  const eod = sod.getTime() + 86400000 - 1;
  const mk = localMonth(now);
  let today = 0, month = 0, monthIncome = 0;
  txs.forEach(t => {
    if (t.type === 'EXPENSE' && t.occurredAt >= sod.getTime() && t.occurredAt <= eod) today += t.amount;
    if (localMonth(t.occurredAt) === mk) { if (t.type === 'EXPENSE') month += t.amount; if (t.type === 'INCOME') monthIncome += t.amount; }
  });
  const um = utcMonth(now), spentByCat = {};
  txs.forEach(t => { if (t.type === 'EXPENSE' && t.categoryLocalId != null && utcMonth(t.occurredAt) === um) spentByCat[t.categoryLocalId] = (spentByCat[t.categoryLocalId] || 0) + t.amount; });
  const budgets = (book.budgets || []).filter(b => b.month === um).map(b => ({ cat: cat[b.categoryLocalId], cap: b.capAmount, spent: spentByCat[b.categoryLocalId] || 0 }))
    .sort((a, b) => (b.spent / b.cap) - (a.spent / a.cap));
  const topCats = Object.entries(spentByCat).map(([id, v]) => ({ cat: cat[id], spent: v })).sort((a, b) => b.spent - a.spent);
  const upcoming = (book.recurringRules || []).filter(r => !r.isDeleted && !r.isPaused && r.nextRunAt <= now + 7 * 86400000 && (!r.endDate || r.nextRunAt <= r.endDate))
    .sort((a, b) => a.nextRunAt - b.nextRunAt).map(r => ({ ...r, account: acc[r.accountLocalId], cat: cat[r.categoryLocalId] }));
  const owed = (book.expenseReceivables || []).filter(r => !r.isCollected);
  return { txs, acc, cat, accounts, rulesAll: (book.recurringRules || []).filter(r => !r.isDeleted), today, month, monthIncome, budgets, topCats, upcoming, owed, total: accounts.reduce((s, a) => s + a.balance, 0) };
}

const _pretty = v => String(v || '').replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase());
export function assetLabel(v) { return _pretty(v); }
export function liabLabel(v) { return _pretty(v); }
