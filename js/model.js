// Turns the backup JSON (format "arthik-backup", schema 3) into the numbers the screens show.
// Mirrors WealthDashboardViewModel on Android so both apps agree.
import { fd, rd, ppfEpfValue, addMonths } from './calc.js';

export const CATS = [
  { key: 'fd', label: 'FD and NSC', code: 'FD', color: '#2F3F5C' },
  { key: 'rd', label: 'RD', code: 'RD', color: '#6F86AD' },
  { key: 'ppf', label: 'PPF', code: 'PF', color: '#9DB0CE' },
  { key: 'epf', label: 'EPF', code: 'EP', color: '#4F8F8B' },
  { key: 'nps', label: 'NPS', code: 'NP', color: '#5F9EA0' },
  { key: 'apy', label: 'APY', code: 'AP', color: '#7FB5A8' },
  { key: 'mf', label: 'Mutual Funds', code: 'MF', color: '#D08A4E' },
  { key: 'demat', label: 'Demat', code: 'DM', color: '#B5655B' },
  { key: 'insurance', label: 'Insurance', code: 'IN', color: '#8E7BB5' },
  { key: 'metal', label: 'Gold and Silver', code: 'AU', color: '#C9B458' },
  { key: 'asset', label: 'Manual Assets', code: 'MA', color: '#7C8798' },
  { key: 'bank', label: 'Bank', code: 'BK', color: '#4C78A8' },
  { key: 'receivable', label: 'Receivables', code: 'RC', color: '#A9825A' },
  { key: 'kametti', label: 'Kametti', code: 'KM', color: '#B07AA1' },
  { key: 'cash', label: 'Cash in Hand', code: 'CH', color: '#6A9F58' },
];

const live = (a) => (a || []).filter(x => !x.isArchived);
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const upper = (s) => (s || '').charAt(0).toUpperCase() + (s || '').slice(1).toLowerCase();

export function wealthBooks(data) { return (data.books || []).filter(b => b.bookType === 'WEALTH' && !b.isArchived); }
export function expenseBooks(data) { return (data.books || []).filter(b => b.bookType === 'EXPENSE' && !b.isArchived); }

export function metalLabel(m) { return `${upper(m.metalType)} ${m.caratType} (${upper(m.form)})`; }

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
    const lines = [`${x.interestRate}% · matures ${fmtDate(mat)}`];
    if (!matured) lines.push(`Accrued interest (not counted yet): ${money(Math.max(0, liveV - x.principalAmount))}`);
    if (x.payoutMode === 'PAYOUT') lines.push(`Interest paid out ${x.payoutFrequency.toLowerCase()} · next ${fmtDate(fd.nextPayoutDue(x))} · ${money(fd.payoutAmount(x))}`);
    add('fd', { id: 'fd:' + x.name, name: x.name, sub: [x.kind, x.bankName].filter(Boolean).join(' · '), value, cost: x.principalAmount, lines, excluded: x.excludeFromNetWorth });
  });

  live(book.recurringDeposits).forEach(x => {
    const inst = x.installments || [];
    const raw = sum(inst, i => i.amount);
    const liveV = inst.length ? rd.currentValueFromEntries(x, inst, now) : rd.currentValueSchedule(x, now);
    const mat = rd.maturityDate(x), matured = now >= mat;
    const value = matured ? liveV : raw;
    add('rd', { name: x.name, sub: [x.bankName, `${money(x.monthlyInstallment)}/month`].filter(Boolean).join(' · '), value, cost: raw,
      lines: [`${x.interestRate}% · ${inst.length} instalments recorded · matures ${fmtDate(mat)}`,
              ...(matured ? [] : [`Accrued interest (not counted yet): ${money(Math.max(0, liveV - raw))}`])], excluded: x.excludeFromNetWorth });
  });

  live(book.ppfAccounts).forEach(x => {
    const all = x.deposits || [];
    const principal = sum(all, d => d.amount);
    const dep = all.filter(d => d.type !== 'INTEREST').map(d => [d.depositDate, d.amount]);
    const liveV = ppfEpfValue(dep, rates('PPF'), now);
    add('ppf', { name: x.name, sub: [x.bankOrPostOfficeName, x.accountNumber].filter(Boolean).join(' · '), value: principal, cost: sum(dep, d => d[1]),
      lines: [`Opened ${fmtDate(x.accountOpenDate)} · ${all.length} entries`, `Interest not yet credited (not counted): ${money(Math.max(0, liveV - principal))}`], excluded: x.excludeFromNetWorth });
  });

  live(book.epfAccounts).forEach(x => {
    const all = x.contributions || [];
    const ee = all.filter(c => c.tileType === 'EMPLOYEE_EMPLOYER').map(c => [c.contributionDate, c.amount]);
    const pension = sum(all.filter(c => c.tileType === 'PENSION'), c => c.amount);
    const eeP = sum(ee, c => c[1]);
    const liveV = ppfEpfValue(ee, rates('EPF'), now);
    add('epf', { name: x.name, sub: [x.companyName, x.uan ? 'UAN ' + x.uan : ''].filter(Boolean).join(' · '), value: eeP + pension, cost: eeP,
      lines: [`Employee + employer ${money(eeP)} · Pension ${money(pension)}`, `Interest not yet credited (not counted): ${money(Math.max(0, liveV - eeP))}`], excluded: x.excludeFromNetWorth });
  });

  live(book.npsAccounts).forEach(x => add('nps', { name: x.name, sub: [`Tier ${x.tier}`, x.pfm].filter(Boolean).join(' · '), value: x.currentValue,
    lines: [`Value updated ${fmtDate(x.lastUpdatedAt)}`, ...(x.monthlyContribution ? [`Monthly ${money(x.monthlyContribution)}`] : [])], excluded: x.excludeFromNetWorth }));

  live(book.apyAccounts).forEach(x => add('apy', { name: x.name, sub: [x.bankName, `Pension slab ${money(x.pensionSlab)}`].filter(Boolean).join(' · '), value: x.totalContributedSoFar,
    lines: [`Monthly ${money(x.monthlyContribution)} · started ${fmtDate(x.startDate)}`], excluded: x.excludeFromNetWorth }));

  live(book.mutualFunds).forEach(x => {
    const es = x.entries || [];
    const units = sum(es, e => e.unitsAllotted), invested = sum(es, e => e.investedAmount);
    const avgNav = units > 0 ? invested / units : 0;
    const nav = x.lastFetchedNav ?? avgNav;
    const value = units * nav;
    const gain = invested > 0 ? (value - invested) / invested * 100 : null;
    add('mf', { name: x.schemeName, sub: [x.fundHouse, x.platformName].filter(Boolean).join(' · '), value, cost: invested,
      lines: [`${units.toFixed(3)} units · invested ${money(invested)}${gain === null ? '' : ' · ' + pct(gain)}`,
              x.lastFetchedNav == null ? 'No saved NAV yet — valued at your average cost' : `NAV ${nav.toFixed(4)} as of ${fmtDate(x.lastFetchedAt)}`,
              ...(x.sip && !x.sip.isHeld ? [`SIP ${money(x.sip.sipAmount)}/month`] : [])], excluded: x.excludeFromNetWorth });
  });

  live(book.dematHoldings).forEach(x => {
    // Backups from Android don't carry holding type / face value, so every holding is valued like a share.
    const price = x.lastFetchedPrice ?? (x.avgBuyPrice > 0 ? x.avgBuyPrice : 0);
    const value = x.unitsHeld * price;
    const cost = x.avgBuyPrice > 0 ? x.unitsHeld * x.avgBuyPrice : 0;
    add('demat', { name: x.stockSymbol, sub: [x.exchangeCode, x.accountName].filter(Boolean).join(' · '), value, cost,
      lines: [`${x.unitsHeld} units · avg ${money(x.avgBuyPrice)}`, x.lastFetchedPrice == null ? 'No saved price — valued at your average cost' : `Price ${money(price)} as of ${fmtDate(x.lastFetchedAt)}`], excluded: x.excludeFromNetWorth });
  });

  live(book.insurancePolicies).forEach(x => add('insurance', { name: x.policyName, sub: [x.insurerName, x.policyType].filter(Boolean).join(' · '),
    value: x.hasCashValue ? x.currentSurrenderValue : 0,
    lines: [`Sum assured: ${money(x.sumAssured)}`, x.hasCashValue ? `Surrender value: ${money(x.currentSurrenderValue)}` : 'No cash value',
            ...(x.nextDueDate ? [`Next premium ${money(x.premiumAmount)} on ${fmtDate(x.nextDueDate)}`] : [])], excluded: x.excludeFromNetWorth }));

  live(book.metalHoldings).forEach(x => add('metal', { name: metalLabel(x), sub: `${x.quantityGrams} g`, value: x.quantityGrams * (x.currentPricePerGram ?? 0),
    lines: [x.currentPricePerGram == null ? 'No price saved' : `${money(x.currentPricePerGram)} per gram`], excluded: x.excludeFromNetWorth }));

  live(book.manualAssets).forEach(x => add('asset', { name: x.name, sub: x.assetType, value: x.currentValue, lines: [`Updated ${fmtDate(x.lastUpdatedByUserAt)}`], excluded: x.excludeFromNetWorth }));
  live(book.bankBalances).forEach(x => add('bank', { name: x.bankName, sub: x.accountDetails, value: x.currentBalance, lines: [], excluded: x.excludeFromNetWorth }));
  live(book.wealthReceivables).forEach(x => add('receivable', { name: x.personName, sub: x.note, value: x.currentAmount, lines: [`Updated ${fmtDate(x.lastUpdatedAt)}`], excluded: x.excludeFromNetWorth }));
  live(book.kamettiAccounts).forEach(x => {
    const bal = sum(x.entries || [], e => e.amount);
    add('kametti', { name: x.name, sub: `${money(x.monthlyAmount)}/month · ${x.totalMonths} months`, value: bal, lines: [`${(x.entries || []).length} entries`], excluded: x.excludeFromNetWorth });
  });
  add('cash', { name: 'Cash in hand', sub: '', value: Number(book.cashInHand || 0), lines: [], excluded: !!book.cashExcludedFromNetWorth });

  // Liabilities (manual) + loans (scheduled)
  const liabilities = [];
  live(book.liabilities).forEach(x => liabilities.push({ kind: 'Liability', name: x.name, sub: x.liabilityType, value: x.outstandingBalance,
    lines: x.emiAmount > 0 ? [`EMI ${money(x.emiAmount)}/month · ${x.interestRate}%`] : [x.dueDate ? `Pay by ${fmtDate(x.dueDate)} · no interest` : 'One payment · no interest'], excluded: !!x.excludeFromNetWorth }));
  live(book.loans).forEach(x => {
    const pays = x.payments || [];
    const next = pays.filter(p => !p.isPaid && !p.isPrepayment).sort((a, b) => a.installmentNumber - b.installmentNumber)[0];
    const outstanding = next ? next.openingBalance : (pays.length ? 0 : x.principal);
    liabilities.push({ kind: 'Loan', name: x.name, sub: x.lenderName || 'Loan · EMI schedule', value: outstanding,
      lines: [next ? `Next EMI ${money(next.emiAmount)} on ${fmtDate(next.dueDate)}` : 'All instalments paid', `${x.annualInterestRatePercent}% · ${x.tenureMonths} months`], excluded: !!x.excludeFromNetWorth });
  });
  const liabTotal = sum(liabilities.filter(l => !l.excluded), l => l.value);

  const list = CATS.map(c => cats[c.key]);
  const assets = sum(list, c => c.total);
  const rent = live(book.rentReceivables);
  return { cats: list, byKey: cats, assets, liabilities, liabTotal, netWorth: assets - liabTotal, rent, goals: goalProgress(book, cats, now) };
}

const GOAL_MAP = { FD: 'fd', RD: 'rd', DEMAT: 'demat', MUTUAL_FUND: 'mf', MANUAL_ASSET: 'asset', PPF: 'ppf', EPF: 'epf', NPS: 'nps', APY: 'apy',
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
    return { name: g.name, target: g.targetAmount, targetDate: g.targetDate, current, linked, pct: g.targetAmount > 0 ? Math.min(100, current / g.targetAmount * 100) : 0 };
  });
}

/** Months of spending covered, as a rough health indicator is left for Phase 3. */

// ---- formatting helpers (Indian digit grouping) ----
export function money(n) {
  if (n == null || isNaN(n)) return '—';
  const neg = n < 0; let s = Math.round(Math.abs(n)).toString();
  if (s.length > 3) { const last3 = s.slice(-3); let rest = s.slice(0, -3); rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ','); s = rest + ',' + last3; }
  return (neg ? '−' : '') + '₹' + s;
}
export function pct(n) { return (n >= 0 ? '▲ ' : '▼ ') + Math.abs(n).toFixed(1) + '%'; }
export function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
export { addMonths };
