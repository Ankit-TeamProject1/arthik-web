// Pure calculations for the Insights page and the Financial health card (no screen code here).
import { localMonth, computeBook } from './model.js';

const live = b => (b.transactions || []).filter(t => !t.isDeleted);
const monthStart = (ts, off = 0) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth() + off, 1).getTime(); };
export const monthName = (ts, long) => new Date(ts).toLocaleDateString('en-IN', { month: long ? 'long' : 'short', year: long ? 'numeric' : undefined });

// Spent and income for each of the last n months, oldest first.
export function monthSeries(book, now, n = 6) {
  const out = [], idx = {};
  for (let i = n - 1; i >= 0; i--) { const s = monthStart(now, -i), o = { key: localMonth(s), start: s, label: monthName(s), spent: 0, income: 0 }; out.push(o); idx[o.key] = o; }
  live(book).forEach(t => { const o = idx[localMonth(t.occurredAt)]; if (!o) return; if (t.type === 'EXPENSE') o.spent += t.amount; else if (t.type === 'INCOME') o.income += t.amount; });
  return out;
}

// Everything the Insights page shows for the month that contains `now`.
export function monthInsights(book, now) {
  const mk = localMonth(now), pk = localMonth(monthStart(now, -1)), cats = Object.fromEntries((book.categories || []).map(c => [c.localId, c]));
  const cur = {}, prev = {}; let spent = 0, income = 0, pSpent = 0, pIncome = 0, entries = 0; const big = [];
  live(book).forEach(t => { const k = localMonth(t.occurredAt);
    if (k === mk) { entries++; if (t.type === 'EXPENSE') { spent += t.amount; cur[t.categoryLocalId] = (cur[t.categoryLocalId] || 0) + t.amount; big.push(t); } else if (t.type === 'INCOME') income += t.amount; }
    else if (k === pk) { if (t.type === 'EXPENSE') { pSpent += t.amount; prev[t.categoryLocalId] = (prev[t.categoryLocalId] || 0) + t.amount; } else if (t.type === 'INCOME') pIncome += t.amount; } });
  const ids = [...new Set([...Object.keys(cur), ...Object.keys(prev)])];
  const categories = ids.map(id => ({ id, name: id === 'undefined' || id === 'null' || !cats[id] ? 'No category' : cats[id].name, now: cur[id] || 0, before: prev[id] || 0 })).sort((a, b) => b.now - a.now || b.before - a.before);
  const d = new Date(now), dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(), isNow = mk === localMonth(Date.now());
  const days = isNow ? new Date().getDate() : dim, perDay = days ? spent / days : 0;
  return { spent, income, pSpent, pIncome, entries, categories, perDay, projected: isNow ? perDay * dim : null, isNow, dim,
    saved: income - spent, rate: income > 0 ? (income - spent) / income * 100 : null,
    biggest: big.sort((a, b) => b.amount - a.amount).slice(0, 5) };
}

// Financial health, from the Wealth book plus the Expense books (for spending and income).
export function wealthHealth(book, expenseBooks, rateHistory, now = Date.now()) {
  const c = computeBook(book, rateHistory, now), assets = c.assets || 0, liab = c.liabTotal || 0;
  const liquid = ((c.byKey.bank && c.byKey.bank.total) || 0) + ((c.byKey.cash && c.byKey.cash.total) || 0);
  let sp = 0, inc = 0, months = 0;
  expenseBooks.forEach(b => { const ser = monthSeries(b, now, 4); let use = ser.slice(0, 3); if (!use.some(m => m.income)) use = ser.slice(1);   // last 3 full months; if they hold no income, include this month
    use.forEach(m => { sp += m.spent; inc += m.income; }); months = Math.max(months, use.filter(m => m.spent || m.income).length); });
  const avgSpend = months ? sp / months / Math.max(1, expenseBooks.length) * Math.max(1, expenseBooks.length) : 0, rate = months && inc > 0 ? (inc - sp) / inc * 100 : null;
  const cover = avgSpend > 0 ? liquid / avgSpend : null, debt = assets > 0 ? liab / assets * 100 : null;
  const top = c.cats.filter(x => x.total > 0).sort((a, b) => b.total - a.total)[0], conc = top && assets > 0 ? top.total / assets * 100 : null;
  const rate3 = (v, good, ok, hi = true) => v == null ? 'na' : (hi ? (v >= good ? 'good' : v >= ok ? 'ok' : 'low') : (v <= good ? 'good' : v <= ok ? 'ok' : 'low'));
  const items = [
    { key: 'cover', label: 'Emergency cover', value: cover == null ? 'Not enough spending data' : (cover > 36 ? 'More than 3 years' : cover.toFixed(1) + ' months') + ' of spending in bank and cash', status: rate3(cover, 6, 3), tip: '6 months or more is comfortable; under 3 is thin.' },
    { key: 'debt', label: 'Debt vs assets', value: debt == null ? 'No assets recorded' : Math.round(debt) + '% of your assets is owed', status: rate3(debt, 30, 50, false), tip: 'Under 30% is healthy; over 50% is heavy.' },
    { key: 'save', label: 'Savings rate (last 3 months)', value: rate == null ? 'Needs income entries in an Expense book' : Math.round(rate) + '% of income saved', status: rate3(rate, 20, 10), tip: '20% or more is strong; under 10% is low.' },
    { key: 'spread', label: 'Spread of assets', value: conc == null ? 'No assets recorded' : Math.round(conc) + '% is in ' + top.label, status: rate3(conc, 40, 60, false), tip: 'Under 40% in one place is well spread; over 60% is concentrated.' } ];
  const pts = { good: 2, ok: 1, low: 0 }, rated = items.filter(i => i.status !== 'na');
  return { items, score: rated.length ? Math.round(rated.reduce((s, i) => s + pts[i.status], 0) / (rated.length * 2) * 100) : null, assets, liab, liquid, avgSpend };
}
