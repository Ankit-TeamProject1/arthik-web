// Repeating items in the Wealth book: what is due, what is coming, and how to record one.
// Mirrors the Android app's rules (RD, EPF, APY, NPS, SIP, Kametti, Rent). Nothing is ever recorded by itself.
import { fd, rd, ppfEpfValue } from './calc.js';
export const RTYPES = {
  FDMAT: 'FD matured', RDMAT: 'RD matured', PPF: 'PPF interest', LIAB: 'Payment due', INS: 'Insurance premium',
  RD: 'Recurring deposit', EPF_EE: 'EPF · employee + employer', EPF_PEN: 'EPF · pension', APY: 'Atal Pension', NPS: 'NPS', SIP: 'Mutual fund SIP', KAMETTI: 'Kametti', RENT: 'Rent received',
};
const ymOf = ts => { const d = new Date(ts); return d.getFullYear() * 12 + d.getMonth(); };
const dim = (y, m) => new Date(y, m + 1, 0).getDate();
export function addM(ts, n) { const d = new Date(ts), day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + n); d.setDate(Math.min(day, dim(d.getFullYear(), d.getMonth()))); return d.getTime(); }
const startOfDay = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayOf = ts => new Date(ts).getDate();
// the one date after "anchor" on the chosen day of month (looks back at most 6 months), like Android's RecurringDayOfMonthCalculator
export function nextOnDay(anchor, day, now) {
  const f = new Date(now); f.setDate(1); f.setMonth(f.getMonth() - 6); f.setHours(0, 0, 0, 0);
  const d = new Date(anchor < f.getTime() ? f.getTime() : anchor); d.setDate(1); d.setMonth(d.getMonth() + 1); d.setDate(Math.min(day, dim(d.getFullYear(), d.getMonth())));
  return startOfDay(d.getTime());
}
// walk a monthly schedule: first unfilled month decides "next"; it is "due" if that date has passed
function walk(anchor, months, filled, now) {
  let first = null, pend = 0;
  for (let n = 0; n < months; n++) { const d = addM(anchor, n); if (filled.has(ymOf(d))) continue; if (first == null) first = d; if (d <= now) pend++; else break; }
  if (first == null) first = addM(anchor, months);
  return { next: first, due: first <= now && pend > 0 ? first : null, pend };
}
export function rentPending(r, now) {
  const done = new Set((r.payments || []).filter(p => p.entryType === 'RENT').map(p => p.dueDate)), out = []; let n = 0, d = addM(r.startDate, 0);
  while (d <= now && n < 600) { if (!done.has(d)) out.push(d); n++; d = addM(r.startDate, n); }
  return { pending: out, next: out.length ? out[0] : d };
}
export function sipStatus(f, now) {
  const sip = f.sip; const filled = new Set((f.entries || []).filter(e => e.isSip || Math.abs(e.investedAmount - sip.sipAmount) < 1).map(e => ymOf(e.purchaseDate)));
  const startYm = ymOf(sip.startDate), cur = Math.max(0, ymOf(now) - startYm), pend = []; let next = null;
  const cyc = n => { const s = new Date(sip.startDate), d = new Date(s.getFullYear(), s.getMonth() + n, 1); d.setDate(Math.min(s.getDate(), dim(d.getFullYear(), d.getMonth()))); d.setHours(0, 0, 0, 0); return d.getTime(); };
  for (let n = Math.max(0, cur - 6); n <= cur + 24; n++) { if (filled.has(startYm + n)) continue; const d = cyc(n); if (d <= now) pend.push(d); else { next = d; break; } }
  return { pend, next: next ?? pend[0] ?? cyc(cur + 1) };
}

/** Everything repeating in this wealth book. due = the date to record now (or null), next = the next scheduled date. */
export function recurringItems(book, now = Date.now()) {
  const L = a => (a || []).filter(x => !x.isArchived), out = [];
  const add = (o) => out.push({ held: false, ...o });
  L(book.recurringDeposits).forEach(r => { const filled = new Set((r.installments || []).map(e => ymOf(e.installmentDate))); const w = walk(r.startDate, r.tenureMonths, filled, now);
    add({ type: 'RD', arr: 'recurringDeposits', ref: r, id: r.name, name: r.name, amount: r.monthlyInstallment, due: w.due, next: w.next, pend: w.pend }); });
  L(book.epfAccounts).forEach(a => [['EPF_EE', 'EMPLOYEE_EMPLOYER', a.monthlyEeContribution, ' — Employee + employer'], ['EPF_PEN', 'PENSION', a.monthlyPensionContribution, ' — Pension']].forEach(([t, tile, amt, suf]) => {
    if (!(amt > 0)) return;
    const filled = new Set((a.contributions || []).filter(e => e.tileType === tile && !e.isTransfer && Math.abs(e.amount - amt) < 0.01).map(e => ymOf(e.contributionDate)));
    const day = dayOf(a.recurringDepositDate || a.accountOpenDate), nowYm = ymOf(now); let due = null, next = null, pend = 0;
    for (let k = 0; k < 600; k++) { const sd = addM(a.accountOpenDate, k), sym = ymOf(sd), p = new Date(sd); p.setDate(1); p.setMonth(p.getMonth() + 1); p.setDate(Math.min(day, dim(p.getFullYear(), p.getMonth())));
      if (filled.has(sym)) continue; if (next == null) next = p.getTime(); if (sym < nowYm && now >= p.getTime()) { if (due == null) due = sd; pend++; } else break; }
    add({ type: t, arr: 'epfAccounts', ref: a, id: a.name, tile, name: a.name + suf, amount: amt, due, next: next ?? now, pend }); }));
  L(book.apyAccounts).forEach(a => { const anchor = a.lastContributionDate || a.startDate, day = a.recurringDayOfMonth || dayOf(a.startDate), nx = nextOnDay(anchor, day, now);
    add({ type: 'APY', arr: 'apyAccounts', ref: a, id: a.name, name: a.name, amount: a.monthlyContribution, due: now >= nx ? nx : null, next: nx, pend: now >= nx ? 1 : 0 }); });
  L(book.npsAccounts).forEach(a => { if (!(a.monthlyContribution > 0)) return; const anchor = a.lastContributionDate || a.lastUpdatedAt || now, day = a.recurringDayOfMonth || dayOf(anchor), nx = nextOnDay(anchor, day, now);
    add({ type: 'NPS', arr: 'npsAccounts', ref: a, id: a.name, name: a.name, amount: a.monthlyContribution, due: now >= nx ? nx : null, next: nx, pend: now >= nx ? 1 : 0 }); });
  L(book.mutualFunds).forEach(f => { if (!f.sip || !(f.sip.sipAmount > 0)) return; const s = sipStatus(f, now);
    add({ type: 'SIP', arr: 'mutualFunds', ref: f, id: f.schemeName, name: f.schemeName, amount: f.sip.sipAmount, due: !f.sip.isHeld && s.pend.length ? s.pend[0] : null, next: s.next, pend: s.pend.length, held: !!f.sip.isHeld, needsNav: true }); });
  L(book.brokerHoldings).forEach(f => { if (f.kind !== 'MF' || !f.sip || !(f.sip.sipAmount > 0)) return; const s = sipStatus(f, now);
    add({ type: 'SIP', arr: 'brokerHoldings', ref: f, id: f.name + '|' + (f.broker || ''), name: f.name, amount: f.sip.sipAmount, due: !f.sip.isHeld && s.pend.length ? s.pend[0] : null, next: s.next, pend: s.pend.length, held: !!f.sip.isHeld, needsNav: true }); });
  L(book.kamettiAccounts).forEach(k => { const filled = new Set((k.entries || []).filter(e => !e.isWon).map(e => ymOf(e.entryDate))); const w = walk(k.recurringDepositDate || k.startDate, k.totalMonths, filled, now);
    add({ type: 'KAMETTI', arr: 'kamettiAccounts', ref: k, id: k.name, name: k.name, amount: k.monthlyAmount, due: w.due, next: w.next, pend: w.pend }); });
  (book.rentReceivables || []).filter(r => !r.isArchived).forEach(r => { const s = rentPending(r, now);
    add({ type: 'RENT', arr: 'rentReceivables', ref: r, id: r.propertyName, name: r.propertyName + (r.tenantName ? ' · ' + r.tenantName : ''), amount: r.monthlyRent, due: s.pending[0] ?? null, next: s.next, pend: s.pending.length }); });
  return out.sort((a, b) => (a.due ? 0 : 1) - (b.due ? 0 : 1) || (a.due || a.next) - (b.due || b.next));
}

const DAY = 86400000;
const fyStartOf = ts => { const d = new Date(ts); return new Date(d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1, 3, 1, 0, 0, 0, 0).getTime(); };
/** One-off events that need a decision: matured FD/RD to renew, PPF interest to credit, a payment or premium falling due. */
export function eventItems(book, now = Date.now(), rateHistory = []) {
  const L = a => (a || []).filter(x => !x.isArchived), out = [];
  const add = o => out.push({ held: false, kind: 'event', ...o });
  L(book.fixedDeposits).forEach(x => { if (!x.autoRenewMode || x.autoRenewMode === 'DISABLED') return; const mat = fd.maturityDate(x); if (mat > now) return; const mv = fd.maturityValue(x);
    add({ type: 'FDMAT', arr: 'fixedDeposits', ref: x, id: x.name, name: x.name, amount: x.autoRenewMode === 'PRINCIPAL_PLUS_INTEREST' ? mv : x.principalAmount, due: mat, next: mat, pend: 1, mv, tenure: x.tenureMonths, rate: x.interestRate }); });
  L(book.recurringDeposits).forEach(x => { if (!x.autoRenewMode || x.autoRenewMode === 'DISABLED') return; const mat = rd.maturityDate(x); if (mat > now) return; const mv = rd.maturityValue(x);
    add({ type: 'RDMAT', arr: 'recurringDeposits', ref: x, id: x.name, name: x.name, amount: x.autoRenewMode === 'PRINCIPAL_PLUS_INTEREST' ? mv : x.monthlyInstallment, due: mat, next: mat, pend: 1, mv, tenure: x.tenureMonths, rate: x.interestRate }); });
  const rates = rateHistory.filter(r => r.instrument === 'PPF');
  // PPF interest: oldest financial year (up to 5 back) with no interest credited yet is offered first, one at a time
  L(book.ppfAccounts).forEach(a => { const all = a.deposits || [], dep = all.filter(d => d.type !== 'INTEREST').map(d => [d.depositDate, d.amount]); if (!dep.length) return;
    const cur = fyStartOf(now), first = fyStartOf(Math.min(...dep.map(d => d[0])));
    let fs = Math.max(first, new Date(new Date(cur).getFullYear() - 5, 3, 1, 0, 0, 0, 0).getTime());
    for (; fs < cur; fs = new Date(new Date(fs).getFullYear() + 1, 3, 1, 0, 0, 0, 0).getTime()) {
      const credit = new Date(new Date(fs).getFullYear() + 1, 3, 1, 0, 0, 0, 0).getTime(), fsEnd = credit - 1;
      if (all.some(e => e.type === 'INTEREST' && fyStartOf(e.depositDate) === credit)) continue;
      const during = dep.filter(d => d[0] >= fs && d[0] <= fsEnd).reduce((x, d) => x + d[1], 0);
      const interest = Math.max(0, ppfEpfValue(dep, rates, fsEnd) - ppfEpfValue(dep, rates, fs) - during); if (!(interest > 0)) continue;
      const y = new Date(credit).getFullYear();
      add({ type: 'PPF', arr: 'ppfAccounts', ref: a, id: a.name, name: a.name + ' · interest FY ' + (y - 1) + '-' + String(y).slice(2), amount: Math.round(interest * 100) / 100, due: credit, next: credit, pend: 1 }); break; } });
  L(book.liabilities).forEach(l => { if (!(l.emiAmount === 0 && l.tenureMonths === 0 && l.interestRate === 0) || !l.dueDate || !(l.outstandingBalance > 0 || l.repeatsMonthly) || l.dueDate > now + 3 * DAY) return;
    add({ type: 'LIAB', arr: 'liabilities', ref: l, id: l.name, name: l.name, amount: l.outstandingBalance, due: l.dueDate, next: l.dueDate, pend: 1 }); });
  L(book.insurancePolicies).forEach(p => { if (!p.nextDueDate || p.nextDueDate > now + 7 * DAY) return;
    add({ type: 'INS', arr: 'insurancePolicies', ref: p, id: p.policyName, name: p.policyName, amount: p.premiumAmount, due: p.nextDueDate, next: p.nextDueDate, pend: 1 }); });
  return out.sort((a, b) => a.due - b.due);
}
export const allDue = (book, now, rh) => [...recurringItems(book, now), ...eventItems(book, now, rh)].filter(i => i.due).sort((a, b) => a.due - b.due);
const ID_KEY = { rentReceivables: 'propertyName', mutualFunds: 'schemeName', insurancePolicies: 'policyName' };

/** Records one due occurrence into the (fresh) book. Throws if it was already recorded elsewhere.
 *  opts: {amount, nav, mode, receivedDate, rate, months, start}; data = whole file (for rent -> Expense account and PPF rates). */
export function confirmInBook(book, it, opts, now = Date.now(), data = null) {
  const idKey = ID_KEY[it.arr] || 'name';
  const rec = (book[it.arr] || []).find(x => (it.arr === 'brokerHoldings' ? x.name + '|' + (x.broker || '') === it.id : x[idKey] === it.id) && !x.isArchived); if (!rec) throw new Error('“' + it.id + '” was removed on another device.');
  const mini = { [it.arr]: [rec] }, rh = (data && data.rateHistory) || [];
  const fresh = [...recurringItems(mini, now), ...eventItems(mini, now, rh)].find(x => x.type === it.type && x.id === it.id);
  if (!fresh || fresh.due !== it.due) throw new Error('This one was already recorded on another device.');
  const money = v => Math.round(Number(v) * 100) / 100, amt = money(opts.amount);
  if (it.type !== 'LIAB' && it.type !== 'INS' && !(amt > 0)) throw new Error('Enter an amount above zero.');
  const due = it.due;
  if (it.type === 'RD') (rec.installments = rec.installments || []).push({ amount: amt, installmentDate: due });
  else if (it.type === 'KAMETTI') (rec.entries = rec.entries || []).push({ amount: amt, entryDate: due, isWon: false });
  else if (it.type === 'EPF_EE' || it.type === 'EPF_PEN') (rec.contributions = rec.contributions || []).push({ amount: amt, contributionDate: due, tileType: it.tile, isTransfer: false });
  else if (it.type === 'APY') { rec.totalContributedSoFar = money((rec.totalContributedSoFar || 0) + amt); rec.lastContributionDate = due; rec.lastUpdatedAt = now; }
  else if (it.type === 'NPS') { rec.currentValue = money((rec.currentValue || 0) + amt); rec.lastContributionDate = due; rec.lastUpdatedAt = now; }
  else if (it.type === 'SIP') { const nav = Number(opts.nav); if (!(nav > 0)) throw new Error('Enter the NAV (price per unit) for this SIP.');
    (rec.entries = rec.entries || []).push({ investedAmount: amt, navAtPurchase: nav, unitsAllotted: Math.round(amt / nav * 1000) / 1000, purchaseDate: due, isSip: true });
    if (it.arr === 'brokerHoldings') { const u = Math.round(amt / nav * 1000) / 1000, oldU = +rec.units || 0, inv = oldU * (+rec.avgPrice || 0) + amt; rec.units = Math.round((oldU + u) * 1000) / 1000; rec.avgPrice = rec.units > 0 ? Math.round(inv / rec.units * 10000) / 10000 : 0; rec.price = nav; rec.priceDate = now; }
    rec.sip.lastConfirmedDate = now; if (it.arr !== 'brokerHoldings') { rec.lastFetchedNav = nav; rec.lastFetchedAt = now; } }
  else if (it.type === 'RENT') { const rcv = opts.receivedDate || now; (rec.payments = rec.payments || []).push({ amount: amt, paymentMode: opts.mode || 'TRANSFER', dueDate: due, receivedDate: rcv, entryType: 'RENT' });
    rec.lastConfirmedAt = rcv; const ln = rec.linkedAccount;
    if (ln && data) { const eb = (data.books || []).find(b => b.bookType === 'EXPENSE' && !b.isArchived && b.name === ln.bookName), ac = eb && (eb.accounts || []).find(a => a.name === ln.accountName && !a.isArchived);
      if (ac) { eb.transactions = eb.transactions || []; eb.transactions.push({ localId: eb.transactions.reduce((m, x) => Math.max(m, x.localId || 0), 0) + 1, type: 'INCOME', amount: amt, accountLocalId: ac.localId, toAccountLocalId: null, categoryLocalId: null, note: 'Rent from ' + (rec.tenantName || rec.propertyName), occurredAt: rcv }); } } }
  else if (it.type === 'PPF') (rec.deposits = rec.deposits || []).push({ amount: amt, depositDate: due, type: 'INTEREST', note: 'Interest credited' });
  else if (it.type === 'LIAB') { rec.outstandingBalance = 0; const left = rec.repeatsMonthly && rec.repeatMonthsLeft > 0 ? rec.repeatMonthsLeft - 1 : null;
    if (rec.repeatsMonthly && rec.repeatMonthsLeft > 0 && left <= 0) { rec.repeatsMonthly = false; rec.repeatMonthsLeft = null; rec.dueDate = null; }
    else { rec.dueDate = rec.repeatsMonthly ? addM(due, 1) : null; if (rec.repeatsMonthly) rec.repeatMonthsLeft = left; } }
  else if (it.type === 'INS') { const step = { MONTHLY: 1, QUARTERLY: 3, ANNUALLY: 12 }[rec.premiumFrequency] || 12; const d = new Date(due); const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + step); d.setDate(Math.min(day, dim(d.getFullYear(), d.getMonth()))); rec.nextDueDate = d.getTime(); }
  else if (it.type === 'FDMAT' || it.type === 'RDMAT') {
    const months = Math.round(Number(opts.months)), rate = Number(opts.rate), start = opts.start || due; if (!(months > 0)) throw new Error('Enter the new tenure in months.'); if (!(rate >= 0 && rate <= 100)) throw new Error('Enter the interest rate.');
    const copy = JSON.parse(JSON.stringify(rec)); delete copy.deletedAt; copy.isArchived = false; copy.interestRate = rate; copy.tenureMonths = months; copy.startDate = start; copy.lastInterestPayoutAt = null;
    if (it.type === 'FDMAT') { copy.principalAmount = amt; copy.tenureExtraDays = 0; } else { copy.monthlyInstallment = amt; copy.installments = []; }
    rec.autoRenewMode = 'DISABLED'; rec.isArchived = true; rec.renewed = true; book[it.arr].push(copy); }
}
export function declineInBook(book, it) { const rec = (book[it.arr] || []).find(x => x.name === it.id && !x.isArchived); if (!rec) throw new Error('Not found.'); rec.autoRenewMode = 'DISABLED'; }

// ---------- Calendar ----------
const pad = n => String(n).padStart(2, '0'), ymd = ts => { const d = new Date(ts); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); };
const sod = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
/** Upcoming dated things for a calendar: {key, title, detail, date, rrule?}. amounts included only if opts.amounts */
export function calendarEvents(book, now = Date.now(), rh = []) {
  const out = [], today = sod(now), nxt = d => Math.max(d, today);
  if (book.bookType === 'EXPENSE') {
    (book.recurringRules || []).filter(r => !r.isDeleted && !r.isPaused).forEach(r => { if (r.endDate && r.endDate < today) return;
      const f = { DAILY: 'DAILY', WEEKLY: 'WEEKLY', MONTHLY: 'MONTHLY', YEARLY: 'YEARLY' }[r.frequency] || 'MONTHLY';
      out.push({ key: 'rule' + r.name, verb: r.type === 'INCOME' ? 'Receive' : 'Pay', name: r.name, amount: r.amount, date: nxt(r.nextRunAt), rrule: 'FREQ=' + f + ';INTERVAL=' + (r.interval || 1) + (r.endDate ? ';UNTIL=' + ymd(r.endDate) : ';COUNT=24') }); });
    return out.sort((a, b) => a.date - b.date);
  }
  recurringItems(book, now).forEach(i => { if (i.held) return; const verb = { RENT: 'Rent due from', SIP: 'SIP', KAMETTI: 'Kametti', RD: 'RD instalment', APY: 'APY contribution', NPS: 'NPS contribution' }[i.type] || 'EPF contribution';
    let count = 24; if (i.type === 'RD') count = Math.max(1, (i.ref.tenureMonths || 1) - (i.ref.installments || []).length); if (i.type === 'KAMETTI') count = Math.max(1, (i.ref.totalMonths || 1) - (i.ref.entries || []).filter(e => !e.isWon).length);
    let dt = i.next; for (let k = 1; dt < today && k < 600; k++) dt = addM(i.next, k);
    out.push({ key: i.type + i.id, verb, name: i.name, amount: i.amount, date: dt, rrule: 'FREQ=MONTHLY;COUNT=' + count }); });
  eventItems(book, now, rh).forEach(i => out.push({ key: i.type + i.id, verb: { FDMAT: 'Renew', RDMAT: 'Renew', PPF: 'Credit', LIAB: 'Pay', INS: 'Premium due:' }[i.type], name: i.name, amount: i.amount, date: nxt(i.due) }));
  (book.fixedDeposits || []).filter(x => !x.isArchived && fd.maturityDate(x) > now).forEach(x => out.push({ key: 'FDM' + x.name, verb: 'FD matures:', name: x.name, amount: fd.maturityValue(x), date: fd.maturityDate(x) }));
  (book.recurringDeposits || []).filter(x => !x.isArchived && rd.maturityDate(x) > now).forEach(x => out.push({ key: 'RDM' + x.name, verb: 'RD matures:', name: x.name, amount: rd.maturityValue(x), date: rd.maturityDate(x) }));
  (book.insurancePolicies || []).filter(p => !p.isArchived && p.nextDueDate && p.nextDueDate > now + 7 * DAY).forEach(p => out.push({ key: 'INSN' + p.policyName, verb: 'Premium due:', name: p.policyName, amount: p.premiumAmount, date: p.nextDueDate, rrule: 'FREQ=MONTHLY;INTERVAL=' + ({ MONTHLY: 1, QUARTERLY: 3, ANNUALLY: 12 }[p.premiumFrequency] || 12) + ';COUNT=' + ({ MONTHLY: 24, QUARTERLY: 8, ANNUALLY: 5 }[p.premiumFrequency] || 5) }));
  (book.liabilities || []).filter(l => !l.isArchived && l.dueDate && l.dueDate > now + 3 * DAY && (l.outstandingBalance > 0 || l.repeatsMonthly)).forEach(l => out.push({ key: 'LIABN' + l.name, verb: 'Pay', name: l.name, amount: l.outstandingBalance, date: l.dueDate, rrule: l.repeatsMonthly ? 'FREQ=MONTHLY;COUNT=12' : undefined }));
  (book.loans || []).filter(l => !l.isArchived).forEach(l => { const un = (l.payments || []).filter(p => !p.isPaid && !p.isPrepayment).sort((a, b) => a.installmentNumber - b.installmentNumber); if (un.length) out.push({ key: 'LOAN' + l.name, verb: 'EMI:', name: l.name, amount: un[0].emiAmount, date: nxt(un[0].dueDate), rrule: 'FREQ=MONTHLY;COUNT=' + un.length }); });
  return out.sort((a, b) => a.date - b.date);
}
const esc = t => String(t).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const fold = l => { const o = []; while (l.length > 74) { o.push(l.slice(0, 74)); l = ' ' + l.slice(74); } o.push(l); return o.join('\r\n'); };
export function eventTitle(e, amounts, rupee = '₹') { return 'Arthik: ' + e.verb + ' ' + e.name + (amounts && e.amount ? ' · ' + rupee + Math.round(e.amount).toLocaleString('en-IN') : ''); }
export function buildIcs(events, { amounts = false, leadDays = 1, now = Date.now() } = {}) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const trig = leadDays > 0 ? '-PT' + (24 * leadDays - 9) + 'H' : 'PT9H';
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Arthik//Web//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  events.forEach((e, i) => { L.push('BEGIN:VEVENT', 'UID:arthik-' + ymd(e.date) + '-' + i + '-' + esc(e.key).replace(/[^A-Za-z0-9-]/g, '') + '@arthik', 'DTSTAMP:' + stamp, 'DTSTART;VALUE=DATE:' + ymd(e.date), 'DTEND;VALUE=DATE:' + ymd(e.date + 90000000),
    'SUMMARY:' + esc(eventTitle(e, amounts)), 'DESCRIPTION:' + esc('Open Arthik to record it. Nothing is added automatically.'));
    if (e.rrule) L.push('RRULE:' + e.rrule);
    L.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Arthik reminder', 'TRIGGER;RELATED=START:' + trig, 'END:VALARM', 'END:VEVENT'); });
  L.push('END:VCALENDAR'); return L.map(fold).join('\r\n') + '\r\n';
}
export function googleLink(e, amounts) {
  const q = new URLSearchParams({ action: 'TEMPLATE', text: eventTitle(e, amounts), dates: ymd(e.date) + '/' + ymd(e.date + 90000000), details: 'Open Arthik to record it. Nothing is added automatically.' });
  if (e.rrule) q.set('recur', 'RRULE:' + e.rrule); return 'https://calendar.google.com/calendar/render?' + q.toString();
}
