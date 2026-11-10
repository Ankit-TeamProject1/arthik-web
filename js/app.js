import { APP_VERSION, AUTO_LOCK_MS } from './config.js';
import * as dbx from './dropbox.js';
import { optionList, sameName, KIND_LABEL } from './lists.js';
import { encrypt, decrypt, isEncrypted } from './crypto.js';
import { loanEmi, loanSchedule } from './calc.js';
import { RTYPES, recurringItems, eventItems, allDue, confirmInBook, declineInBook, rentPending, calendarEvents, buildIcs, googleLink, eventTitle } from './recurring.js';
import { readFile, parseStatement, parseTemplate, planUpdate, applyUpdate, newUid, planImport2 as planImport, applyImport2 as applyImport, buildHoldingsXlsx, classify, planOptionOf, KINDS, KIND_NAME } from './broker.js';
import { GOAL_MAP, assetLabel, utcMonth, CATS, computeBook, computeExpense, activeBooks, wealthBooks, expenseBooks, setCurrency, setMask, money, pct, fmtDate, metalLabel, price2 } from './model.js';

const root = document.getElementById('app');
const S = { pw: null, enc: null, rev: null, modified: null, data: null, bookIdx: 0, offline: false, error: '', busy: false };

// ---------- tiny DOM helper (text is always set as text, never as HTML) ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
    else el.setAttribute(k, v === true ? '' : v);
  }
  kids.flat().forEach(c => { if (c == null || c === false) return; el.append(c.nodeType ? c : document.createTextNode(String(c))); });
  return el;
}
const svgns = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(svgns, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  kids.forEach(k => el.append(k)); return el;
}
function mount(...nodes) { root.replaceChildren(...nodes); }

// ---------- local cache of the (still encrypted) file, for offline viewing ----------
const CACHE = 'arthik.cache';
function cacheSave() { try { localStorage.setItem(CACHE, JSON.stringify({ enc: S.enc, rev: S.rev, modified: S.modified })); } catch {} }
function cacheLoad() { try { return JSON.parse(localStorage.getItem(CACHE) || 'null'); } catch { return null; } }

// ---------- auto-lock ----------
let lockTimer = null, lastActive = Date.now();
function touch() { lastActive = Date.now(); clearTimeout(lockTimer); if (S.data) lockTimer = setTimeout(lock, AUTO_LOCK_MS); }
['click', 'keydown', 'touchstart', 'scroll', 'mousemove'].forEach(e => addEventListener(e, touch, { passive: true }));
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.data && Date.now() - lastActive > AUTO_LOCK_MS) lock(); });
function lock() { dueSeen.clear(); S.data = null; S.pw = null; closeModal(); view.cache = null; clearTimeout(lockTimer); if (S.enc) screenUnlock('Locked.'); else screenWelcome(); }

// ---------- screens: welcome / sign-in ----------
function shell(...content) {
  return h('div', { class: 'center' }, h('div', { class: 'brand' }, h('img', { class: 'logo', src: 'icons/logo.png', alt: '', width: 40, height: 40 }), h('div', { class: 'brandname' }, 'Arthik')), ...content);
}
function card(...kids) { return h('section', { class: 'card auth' }, ...kids); }
function errBox() { return S.error ? h('div', { class: 'err', role: 'alert' }, S.error) : null; }

function screenWelcome() {
  mount(shell(card(
    h('div', { class: 'step' }, 'STEP 1 OF 2'),
    h('h1', null, 'Sign in to your Dropbox'),
    h('p', null, 'Your data lives in one encrypted file in your own Dropbox (Apps › Arthik). Arthik opens it here in your browser. There is no other server.'),
    errBox(),
    h('button', { class: 'btn primary big', onclick: () => dbx.startSignIn().catch(e => { S.error = e.message; screenWelcome(); }) }, 'Sign in with Dropbox'),
    h('div', { class: 'small' }, 'Works the same in Chrome on a laptop, Safari on iPhone and iPad.'),
    h('button', { class: 'link', onclick: screenViewFile }, 'Just look at a backup file (no sign-in, nothing is saved)'),
  )));
}

// Opens a backup file straight from the device. Nothing is uploaded or stored.
function screenViewFile() {
  const file = h('input', { type: 'file', accept: '.json,application/json,text/plain', 'aria-label': 'Backup file' });
  const pw = h('input', { type: 'password', placeholder: 'Backup password (only if protected)', autocomplete: 'off', 'aria-label': 'Backup password' });
  const msg = h('div', { class: 'err', hidden: true });
  const fail = (m) => { msg.textContent = m; msg.hidden = false; };
  const btn = h('button', { class: 'btn primary big', onclick: async () => {
    const f = file.files[0]; if (!f) return fail('Choose a backup file first.');
    let text = await f.text();
    if (isEncrypted(text)) {
      const r = await decrypt(text, pw.value);
      if (!r.ok) return fail(r.reason === 'wrong' ? 'That password is not correct.' : 'This file could not be read.');
      text = r.text;
    }
    try { const j = JSON.parse(text); if (!j.books) throw 0; S.data = j; } catch { return fail('This does not look like an Arthik backup file.'); }
    S.enc = null; S.bookIdx = 0; view.cache = null; touch(); route();
  } }, 'Open');
  mount(shell(card(h('h1', null, 'Look at a backup file'), h('p', null, 'The file stays on this device.'), file, pw, msg, btn,
    h('button', { class: 'link', onclick: screenWelcome }, 'Back'))));
}

function screenBusy(msg) { mount(shell(card(h('p', { class: 'center-text' }, msg || 'Loading…')))); }

function screenUnlock(note) {
  const pw = h('input', { type: 'password', id: 'pw', autocomplete: 'current-password', placeholder: 'Data password', 'aria-label': 'Data password' });
  const go = async () => {
    if (!pw.value) return;
    btn.disabled = true; btn.textContent = 'Unlocking…';
    const r = await decrypt(S.enc, pw.value);
    if (!r.ok) { S.error = r.reason === 'wrong' ? 'That password is not correct.' : 'This file could not be read.'; return screenUnlock(); }
    try { S.data = JSON.parse(r.text); } catch { S.error = 'This file could not be read.'; return screenUnlock(); }
    S.error = ''; S.pw = pw.value; S.bookIdx = 0; touch(); route();
  };
  const btn = h('button', { class: 'btn primary big', onclick: go }, 'Unlock');
  pw.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  mount(shell(card(
    h('div', { class: 'step' }, 'STEP 2 OF 2'),
    h('h1', null, 'Unlock your data'),
    h('div', { class: 'meta' }, 'File: ', h('b', null, 'Apps/Arthik/arthik-data.json'), S.modified ? ' · saved ' + new Date(S.modified).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''),
    S.offline ? h('div', { class: 'note' }, 'Dropbox could not be reached — showing your last saved copy.') : null,
    note ? h('div', { class: 'note' }, note) : null,
    errBox(),
    h('label', { for: 'pw' }, 'Data password'), pw, btn,
    h('div', { class: 'small' }, 'The password never leaves your device. If it is forgotten, the file cannot be recovered. The app locks itself after 5 minutes of inactivity.'),
    h('button', { class: 'link', onclick: () => { if (confirm('Sign out of Dropbox on this device?')) { dbx.signOut(); S.enc = null; screenWelcome(); } } }, 'Sign out of Dropbox'),
  )));
  setTimeout(() => pw.focus(), 50);
}

// ---------- first-time set-up: bring in the Android backup ----------
function screenSetup(replacing) {
  const file = h('input', { type: 'file', accept: '.json,application/json,text/plain', id: 'bf' });
  const p1 = h('input', { type: 'password', placeholder: 'Choose a data password', autocomplete: 'new-password', 'aria-label': 'Data password' });
  const p2 = h('input', { type: 'password', placeholder: 'Type it again', autocomplete: 'new-password', 'aria-label': 'Data password again' });
  const p0 = h('input', { type: 'password', placeholder: 'Backup password (only if the file is protected)', autocomplete: 'off', 'aria-label': 'Backup password' });
  const msg = h('div', { class: 'note', hidden: true });
  const btn = h('button', { class: 'btn primary big' }, replacing ? 'Replace my data' : 'Save to Dropbox');
  btn.onclick = async () => {
    S.error = ''; msg.hidden = true;
    const f = file.files[0];
    if (!f) return fail('Choose your Arthik backup file first.');
    let text = await f.text(), out;
    try {
      if (isEncrypted(text)) {
        if (!p0.value) return fail('This backup is password-protected. Enter its password.');
        const r = await decrypt(text, p0.value);
        if (!r.ok) return fail(r.reason === 'wrong' ? 'That backup password is not correct.' : 'This file could not be read.');
        JSON.parse(r.text); out = text;               // keep the file exactly as the Android app wrote it
      } else {
        const j = JSON.parse(text);
        if (!j.books || !j.schemaVersion) return fail('This does not look like an Arthik backup file.');
        if (j.schemaVersion > 3) return fail('This backup is from a newer version of Arthik.');
        if (p1.value.length < 8) return fail('Choose a data password of at least 8 characters.');
        if (p1.value !== p2.value) return fail('The two passwords do not match.');
        out = await encrypt(text, p1.value);
      }
    } catch { return fail('This file could not be read.'); }
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await dbx.upload(out, replacing ? S.rev : null);
      S.enc = out; S.rev = r.rev; S.modified = r.modified; cacheSave(); S.data = null;
      screenUnlock('Saved. Enter your data password to open it.');
    } catch (e) {
      if (e.message === 'CONFLICT') fail('A file already exists in Dropbox or changed on another device. Reload and try again.');
      else fail(e.message);
      btn.disabled = false; btn.textContent = replacing ? 'Replace my data' : 'Save to Dropbox';
    }
  };
  function fail(m) { msg.textContent = m; msg.hidden = false; msg.className = 'err'; }
  mount(shell(card(
    h('div', { class: 'step' }, replacing ? 'REPLACE DATA' : 'FIRST-TIME SET-UP'),
    h('h1', null, replacing ? 'Replace data from a backup' : 'Bring in your data'),
    h('p', null, replacing ? 'This overwrites the file in Dropbox with the backup you choose.' : 'No data file exists in your Dropbox yet. On your Android phone use Settings › Backup, then choose the saved .json file here.'),
    h('label', { for: 'bf' }, 'Backup file'), file,
    h('label', null, 'If the backup is password-protected'), p0,
    h('label', null, 'Data password for this web app'), p1, p2,
    h('div', { class: 'small' }, 'A protected backup keeps its own password. For an unprotected one, this password is what protects the file in Dropbox. Write it down: there is no recovery.'),
    msg, btn,
    replacing ? h('button', { class: 'link', onclick: () => route() }, 'Cancel') : null,
  )));
}

// ---------- main app ----------
const NAV_W = [
  { id: 'dashboard', label: 'Home' }, { id: 'liabilities', label: 'Liabilities' }, { id: 'goals', label: 'Goals' },
  { id: 'rent', label: 'Rent' }, { id: 'recurring', label: 'Recurring' }, { id: 'settings', label: 'Settings' },
];
const NAV_E = [
  { id: 'dashboard', label: 'Home' }, { id: 'transactions', label: 'Entries' }, { id: 'recurring', label: 'Recurring' }, { id: 'budgets', label: 'Budgets' }, { id: 'settings', label: 'Settings' },
];
const NAV_WM = [{ id: 'dashboard', label: 'Home' }, { id: 'liabilities', label: 'Liabilities' }, { id: 'recurring', label: 'Recurring' }, { id: 'more', label: 'More' }];
const NAV_EM = [{ id: 'dashboard', label: 'Home' }, { id: 'transactions', label: 'Entries' }, { id: 'recurring', label: 'Recurring' }, { id: 'more', label: 'More' }];
const view = { cache: null };
let em = 0; // Expense dashboard month offset (0 = this month, -1 = last month...)
const monthNow = () => { if (!em) return Date.now(); const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + em, 15, 12).getTime(); };
function currentBook() { const w = activeBooks(S.data); return w[Math.min(S.bookIdx, w.length - 1)] || null; }
function computed() {
  const b = currentBook(); if (!b) return null;
  const mk = hidden() && b.bookType === 'WEALTH';
  if (!view.cache || view.cache.book !== b || view.cache.mk !== mk || view.cache.em !== em) view.cache = { book: b, mk, em, c: b.bookType === 'EXPENSE' ? computeExpense(b, monthNow()) : computeBook(b, S.data.rateHistory || []) };
  return view.cache.c;
}

function route() {
  if (!S.data) return screenUnlock();
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [page, arg] = hash.split('/');
  const book = currentBook();
  let body;
  if (book) setCurrency(book.currencyCode);
  setMask(false);
  const isExp = !!book && book.bookType === 'EXPENSE';
  const NAV = isExp ? NAV_E : NAV_W;
  if (!book) body = page === 'settings' ? pageSettings() : emptyState();
  else if (isExp && page === 'transactions') body = pageEntries();
  else if (page === 'more') body = pageMore();
  else if (page === 'calendar') body = pageCalendar();
  else if (isExp && page === 'budgets') body = pageBudgets();
  else if (isExp && page === 'recurring') body = pageRecurring();
  else if (isExp && page === 'accounts') body = pageAccounts();
  else if (isExp && page === 'categories') body = pageCategories();
  else if (isExp && page === 'trash') body = pageTrash();
  else if (isExp && page !== 'settings') body = pageExpenseDashboard();
  else if (page === 'cat') body = pageCategory(arg);
  else if (page === 'invest') body = pageInvest();
  else if (page === 'liabilities' || page === 'cards') body = pageLiabilities();
  else if (page === 'goals') body = pageGoals();
  else if (page === 'rent') body = pageRent();
  else if (page === 'recurring') body = pageWealthRecurring();
  else if (page === 'more') body = pageMore();
  else if (page === 'trash') body = pageTrash();
  else if (page === 'settings') body = pageSettings();
  else body = pageDashboard();
  const active = ['cat', 'invest'].includes(page) ? 'dashboard' : ['accounts', 'categories', 'trash'].includes(page) ? 'settings' : page === 'cards' ? 'liabilities' : (NAV.find(n => n.id === page) ? page : 'dashboard');
  const dueN = !book ? 0 : isExp ? dueRules(book).length : wDue(book, true).length;
  const mkNav = (list, act) => h('nav', { class: 'nav', 'aria-label': 'Main' }, list.map(n => h('a', { href: '#/' + n.id, class: n.id === act ? 'on' : '', 'aria-current': n.id === act ? 'page' : null }, h('span', { class: 'dot' }), n.label, n.id === 'recurring' && dueN ? h('span', { class: 'reddot', 'aria-label': dueN + ' due' }) : null)));
  const mList = isExp ? NAV_EM : NAV_WM, mActive = mList.some(n => n.id === page) ? page : (['dashboard', 'cat', 'invest'].includes(page) ? 'dashboard' : 'more');
  const nav = mkNav(mList, mActive), sideNav = mkNav(NAV, active);
  const brandRow = () => h('div', { class: 'brand sm' }, h('img', { class: 'logo', src: 'icons/logo.png', alt: '', width: 40, height: 40 }), h('div', { class: 'brandname' }, 'Arthik'));
  const side = h('aside', { class: 'side' }, brandRow(), h('div', { class: 'bookbox' }, bookPicker()), sideNav);
  mount(h('div', { class: 'layout' }, side, h('main', { class: 'main' }, h('div', { class: 'mbar' }, brandRow(), h('div', { class: 'bookbox' }, bookPicker())), body, (isExp && canEdit() ? h('button', { class: 'fab', 'aria-label': 'Add an entry', onclick: () => openEntry(null) }, '+') : null), h('div', { class: 'foot' }, 'Arthik web ' + APP_VERSION + (canEdit() ? ' · editing on' : ' · view only') + (matchMedia('(hover:hover)').matches ? (isExp ? (canEdit() ? ' · shortcuts: N new entry, / search' : ' · shortcut: / search') : ' · shortcut: H hide values') : ''))), nav));
  decorate(page);
  window.scrollTo(0, 0);
  if (isExp && canEdit() && !dueSeen.has(book.name)) { dueSeen.add(book.name); if (dueRules(book).length) setTimeout(showDue, 300); }
  if (book && !isExp && canEdit() && !dueSeen.has(book.name)) { dueSeen.add(book.name); if (wDue(book).length) setTimeout(showWealthDue, 300); }
}
addEventListener('hashchange', () => { if (S.data) route(); });
// Laptop shortcuts: "/" search entries, "h" hide or show values, "g" then nothing else is needed.
addEventListener('keydown', e => {
  if (e.key === 'Escape') { const pk = document.querySelector('.overlay.picker'); if (pk) pk.remove(); else closeModal(); }
  if (!S.data || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target && e.target.tagName || '').toLowerCase(); if (['input', 'select', 'textarea'].includes(tag)) return;
  const b = currentBook(); if (!b) return;
  if (e.key === '/' && b.bookType === 'EXPENSE') { e.preventDefault(); if (!location.hash.includes('transactions')) location.hash = '#/transactions'; setTimeout(() => { const i = document.querySelector('input[type=search]'); if (i) i.focus(); }, 50); }
  else if ((e.key === 'n' || e.key === 'N') && b.bookType === 'EXPENSE' && canEdit()) { e.preventDefault(); openEntry(null); }
  else if ((e.key === 'h' || e.key === 'H') && b.bookType === 'WEALTH') { setHidden(!hidden()); view.cache = null; route(); }
});

function emptyState() {
  return h('div', null, h('h1', null, 'No books found'), h('p', null, 'There are no active books.'), (S.data.books || []).some(b => b.isArchived) ? h('p', null, h('a', { class: 'btn primary', href: '#/settings' }, 'Restore a deleted book')) : null);
}

function bookPicker() {
  const books = activeBooks(S.data);
  if (!books.length) return null;
  const cur = currentBook();
  const kind = h('div', { class: 'bookkind' }, cur.bookType === 'EXPENSE' ? 'Expense book' : 'Wealth book');
  if (books.length < 2) return h('div', null, h('div', { class: 'bookname' }, cur.name), kind);
  return h('div', null, h('select', { class: 'bookpick', 'aria-label': 'Book', onchange: e => { S.bookIdx = +e.target.value; em = 0; location.hash = '#/dashboard'; route(); } },
    books.map((b, i) => h('option', { value: i, selected: i === S.bookIdx }, b.name))), kind);
}
function bookHeader(title, sub) {
  return h('header', { class: 'top' },
    h('div', null, sub ? h('div', { class: 'crumb' }, sub) : null, h('h1', null, title)),
    h('button', { class: 'btn ghost', onclick: lock }, 'Lock'));
}

// Mutual Funds and Demat are shown as one "Investments" group on the Home page
function mergedCats(c) {
  const mf = c.byKey.mf, dm = c.byKey.demat, out = [];
  c.cats.forEach(x => { if (x.key === 'mf') out.push({ key: 'invest', label: 'Investments', code: 'IV', color: dm.color, ill: 'demat', items: [...mf.items, ...dm.items], total: mf.total + dm.total, cost: mf.cost + dm.cost }); else if (x.key !== 'demat') out.push(x); });
  return out;
}
function donut(c) {
  const parts = mergedCats(c).filter(x => x.total > 0), tot = parts.reduce((s, x) => s + x.total, 0);
  const R = 52, C = 2 * Math.PI * R; let off = 0;
  const s = svg('svg', { viewBox: '0 0 140 140', class: 'donut', role: 'img', 'aria-label': 'Asset allocation' });
  s.append(svg('circle', { cx: 70, cy: 70, r: R, fill: 'none', stroke: 'rgba(128,128,128,.25)', 'stroke-width': 22 }));
  parts.forEach(p => { const len = tot ? p.total / tot * C : 0; s.append(svg('circle', { cx: 70, cy: 70, r: R, fill: 'none', stroke: p.color, 'stroke-width': 22, 'stroke-dasharray': `${len} ${C - len}`, 'stroke-dashoffset': -off, transform: 'rotate(-90 70 70)' })); off += len; });
  return { svg: s, parts, tot };
}

function trend(book, nw) {
  const pts = (book.netWorthSnapshots || []).map(s => ({ t: s.date, v: s.value }));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (!pts.length || pts[pts.length - 1].t < today.getTime()) pts.push({ t: today.getTime(), v: nw });
  pts.sort((a, b) => a.t - b.t);
  if (pts.length < 2) return h('div', { class: 'small' }, 'The Net Worth trend appears once there is more than one day of history.');
  const W = 600, H = 150, min = Math.min(...pts.map(p => p.v)), max = Math.max(...pts.map(p => p.v)), span = max - min || 1, t0 = pts[0].t, t1 = pts[pts.length - 1].t || 1;
  const xy = pts.map(p => `${((p.t - t0) / ((t1 - t0) || 1) * (W - 10) + 5).toFixed(1)},${(H - 12 - (p.v - min) / span * (H - 24)).toFixed(1)}`).join(' ');
  return svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'trend', preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Net Worth over time' }, svg('polyline', { points: xy, fill: 'none', stroke: '#387ed1', 'stroke-width': 4, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
}

const hidden = () => { try { return localStorage.getItem('arthik.hide') === '1'; } catch { return false; } };
const setHidden = (v) => { try { v ? localStorage.setItem('arthik.hide', '1') : localStorage.removeItem('arthik.hide'); } catch {} };
const mask = (t) => (hidden() ? '••••••' : t);

function pageMore() {
  const book = currentBook(), isExp = book.bookType === 'EXPENSE', c = computed();
  const links = isExp ? [['#/budgets', 'Budgets', 'Monthly limits per category'], ['#/calendar', 'Calendar reminders', 'Add due dates to Google Calendar (optional)'], ['#/settings', 'Settings', 'Accounts, categories, backup, theme'], ['#/trash', 'Recently deleted', trashItems(book).length + ' item(s) you can restore']]
    : [['#/goals', 'Goals', 'Savings goals and progress'], ['#/rent', 'Rent', 'Properties you rent out'], ['#/calendar', 'Calendar reminders', 'Add due dates to Google Calendar (optional)'], ['#/settings', 'Settings', 'Backup, theme, your data file'], ['#/trash', 'Recently deleted', trashItems(book).length + ' item(s) you can restore']];
  return h('div', null, bookHeader('More', book.name), h('div', { class: 'list' }, links.map(([href, t, sub]) => h('a', { class: 'item clk morelink', href }, h('div', { class: 'irow' }, h('div', { class: 'iname' }, t), h('div', { class: 'ival' }, '›')), h('div', { class: 'isub' }, sub)))));
}
function pageDashboard() {
  const c = computed(), book = currentBook();
  const d = donut(c);
  const last = (book.netWorthSnapshots || []).filter(s => s.date < Date.now() - 25 * 86400000).sort((a, b) => b.date - a.date)[0];
  const change = last && last.value ? (c.netWorth - last.value) / Math.abs(last.value) * 100 : null;
  const tile = (href, label, code, color, ill, value, share, gain, hasEx) => h('a', { class: 'tile3d', href, style: { '--acc': color } },
    h('div', { class: 't3-top' }, h('span', { class: 'chip round', style: { background: color } }, code), h('img', { class: 't3-ill', src: 'icons/ill/' + ill + '.svg', alt: '', width: 56, height: 56 })),
    h('div', { class: 'tname' }, label), h('div', { class: 'tval' }, value),
    h('div', { class: 't3-bar' }, h('span', { style: { width: Math.min(100, Math.max(0, share)) + '%', background: color } })),
    h('div', { class: 't3-foot' }, h('span', { class: 'tnote' }, share.toFixed(0) + '% of total'), gain !== null ? h('span', { class: 'badge ' + (gain >= 0 ? 'up' : 'down') }, pct(gain)) : (hasEx ? h('span', { class: 'excl' }, 'Some excluded') : null)));
  const tiles = mergedCats(c).filter(x => x.items.length).map(x => {
    const gain = x.cost > 0 && ['invest'].includes(x.key) ? (x.total - x.cost) / x.cost * 100 : null;
    return tile(x.key === 'invest' ? '#/invest' : '#/cat/' + x.key, x.label, x.code, x.color, x.ill, money(x.total), c.assets > 0 ? x.total / c.assets * 100 : 0, gain, x.items.some(i => i.excluded));
  });
  return h('div', null, bookHeader('Home', book.name), backupBanner(), installHint(), wDueBanner(book),
    h('div', { class: 'toprow' },
    h('section', { class: 'card hero' },
      h('div', { class: 'irow' }, h('div', { class: 'lbl' }, 'Net Worth'),
        h('button', { class: 'eye', 'aria-pressed': hidden(), 'aria-label': hidden() ? 'Show Net Worth' : 'Hide Net Worth', onclick: () => { setHidden(!hidden()); route(); } }, hidden() ? 'Show' : 'Hide')),
      h('div', { class: 'big' }, mask(money(c.netWorth))),
      h('div', { class: 'hsub' }, h('span', null, 'Assets ', h('b', null, mask(money(c.assets)))), h('span', null, 'Liabilities ', h('b', null, mask(money(c.liabTotal))))),
      change !== null && !hidden() ? h('div', { class: 'tnote ' + (change >= 0 ? 'up' : 'down') }, pct(change) + ' vs about a month ago') : null,
      hidden() ? null : trend(book, c.netWorth)),
    h('section', { class: 'card alloc' }, d.svg, h('ul', { class: 'legend' }, d.parts.sort((a, b) => b.total - a.total).map(p => h('li', null, h('span', { class: 'sw', style: { background: p.color } }), `${p.label} ${(p.total / d.tot * 100).toFixed(1)}%`))))),
    h('h2', null, 'Categories'), h('div', { class: 'grid g3d' }, tiles),
    comingUp(book),
    h('div', { class: 'small' }, 'Prices and NAVs are the last ones saved by your phone. Live refresh arrives in a later phase.'));
}

// ---- sorting of cards (by opening date by default) ----
let sortMode = 'new'; try { sortMode = localStorage.getItem('arthik.sort') || 'new'; } catch {}
const SORTS = [['new', 'Opening date · newest first'], ['old', 'Opening date · oldest first'], ['val', 'Value · highest first'], ['name', 'Name · A to Z']];
function openDate(it) {
  const s = it.src; if (!s) return null;
  const d = s.startDate ?? s.accountOpenDate ?? s.policyStartDate;
  if (d) return d;
  const e = (s.entries || s.installments || s.deposits || s.contributions || []).map(x => x.purchaseDate ?? x.entryDate ?? x.installmentDate ?? x.depositDate ?? x.contributionDate).filter(Boolean);
  return e.length ? Math.min(...e) : (s.lastUpdatedAt ?? s.lastUpdatedByUserAt ?? null);
}
function sortItems(items) {
  const a = items.slice(), nm = (x, y) => String(x.name).localeCompare(String(y.name));
  if (sortMode === 'val') return a.sort((x, y) => y.value - x.value);
  if (sortMode === 'name') return a.sort(nm);
  const dir = sortMode === 'old' ? 1 : -1;
  return a.sort((x, y) => { const dx = openDate(x), dy = openDate(y); if (dx == null && dy == null) return nm(x, y); if (dx == null) return 1; if (dy == null) return -1; return dx === dy ? nm(x, y) : (dx - dy) * dir; });
}
const sortBar = () => h('div', { class: 'sortbar' }, h('label', { class: 'small' }, 'Sort by '), h('select', { 'aria-label': 'Sort cards by', onchange: e => { sortMode = e.target.value; try { localStorage.setItem('arthik.sort', sortMode); } catch {} route(); } }, SORTS.map(([v, l]) => h('option', { value: v, selected: v === sortMode }, l))));
const backLink = (href, label) => h('a', { href, class: 'btn ghost back' }, '← ' + label);
const DECO = Object.fromEntries(CATS.map(c => [c.key, [c.color, c.ill]]));
Object.assign(DECO, { liability: ['#EF4444', 'liab'], loan: ['#F97316', 'loan'], card: ['#E11D48', 'card'], goal: ['#10B981', 'goal'], rent: ['#22C55E', 'rent'], rec: ['#8B5CF6', 'rec'],
  cal: ['#3B82F6', 'cal'], settings: ['#6366F1', 'settings'], trash: ['#64748B', 'trash'], entries: ['#0EA5E9', 'entries'], budget: ['#F59E0B', 'budget'], cats: ['#EC4899', 'manual'], due: ['#F59E0B', 'bell'], hold: ['#10B981', 'demat'] });
const PAGE_DECO = { cards: 'card', liabilities: 'liability', goals: 'goal', rent: 'rent', recurring: 'rec', calendar: 'cal', trash: 'trash', budgets: 'budget', accounts: 'bank', categories: 'cats', settings: 'settings', transactions: 'entries', dashboard: 'bank' };
const MORE_DECO = { '#/budgets': 'budget', '#/calendar': 'cal', '#/settings': 'settings', '#/trash': 'trash', '#/cards': 'card', '#/goals': 'goal', '#/rent': 'rent' };
// Soft colour + picture on every card that has none yet (cards built by itemCard already have them)
function decorate(page) {
  document.querySelectorAll('.main .item:not(.acc), .main .tile:not(.acc)').forEach(el => {
    const k = el.dataset.deco || (el.classList.contains('morelink') ? MORE_DECO[el.getAttribute('href')] : PAGE_DECO[page]) || 'rec', d = DECO[k] || DECO.rec;
    el.classList.add('acc'); el.style.setProperty('--acc', d[0]);
    const host = el.querySelector('.iname') || el.querySelector('.tname');
    if (host && !host.querySelector('.iill')) { const im = document.createElement('img'); im.className = 'iill'; im.src = 'icons/ill/' + d[1] + '.svg'; im.alt = ''; im.width = 36; im.height = 36; host.prepend(im); }
  });
}
// "Due" pills on every tile that has a repeating schedule or a dated event (same rules as the Recurring tab)
function wPill(src) {
  const book = currentBook(); if (!book || book.bookType !== 'WEALTH' || !src) return null;
  const now = Date.now(), k = book.name + ':' + Math.floor(now / 30000);
  if (!view.pill || view.pill.k !== k || view.pill.d !== S.data) { const m = new Map(); [...recurringItems(book, now), ...eventItems(book, now, S.data.rateHistory || [])].forEach(i => { if (!m.has(i.ref)) m.set(i.ref, []); m.get(i.ref).push(i); }); view.pill = { k, d: S.data, m }; }
  const list = view.pill.m.get(src); if (!list) return null;
  const sn = snoozes(), dueL = list.filter(i => i.due && !i.held);
  if (dueL.length) { if (dueL.every(i => sn[wKey(book.name, i)] > now)) return h('span', { class: 'ttag' }, 'Snoozed'); const n = dueL.reduce((a, i) => a + (i.pend || 1), 0), t0 = new Date().setHours(0, 0, 0, 0); return h('span', { class: 'ttag down' }, n === 1 && dueL[0].due >= t0 ? 'Due today' : n + ' due'); }
  const nx = list.filter(i => !i.held && i.next && i.next > now && i.next - now <= 7 * 86400000).sort((a, b) => a.next - b.next)[0];
  return nx ? h('span', { class: 'ttag blue' }, 'Due ' + fmtDate(nx.next)) : null;
}
function comingUp(book) {
  const now = Date.now(), lim = now + 30 * 86400000;
  const ev = calendarEvents(book, now, S.data.rateHistory || []).filter(e => e.date <= lim).slice(0, 6); if (!ev.length) return null;
  const deco = k => /^LIAB/.test(k) ? 'liability' : /^LOAN/.test(k) ? 'loan' : /^INS/.test(k) ? 'insurance' : /^FD/.test(k) ? 'fd' : /^RD/.test(k) ? 'rd' : /^PPF/.test(k) ? 'ppf' : /^SIP/.test(k) ? 'mf' : /^EPF/.test(k) ? 'epf' : /^NPS/.test(k) ? 'nps' : /^APY/.test(k) ? 'apy' : /^KAMETTI/.test(k) ? 'kametti' : /^RENT/.test(k) ? 'rent' : 'rec';
  return h('div', null, h('h2', null, 'Coming up (next 30 days)'), h('div', { class: 'list' }, ev.map(e => h('a', { class: 'item clk', href: '#/recurring', 'data-deco': deco(e.key) },
    h('div', { class: 'irow' }, h('div', { class: 'iname' }, e.verb + ' ' + e.name), h('div', { class: 'ival' }, e.amount ? money(e.amount) : '')), h('div', { class: 'isub' }, fmtDate(e.date))))));
}
function itemCard(it, key, look) {
  const ed = canEdit() && key && WSPEC[key] && it.src;
  const dd = look || DECO[key], cdef = dd ? { color: dd[0], ill: dd[1] } : null;
  return h('div', { class: 'item' + (cdef ? ' acc' : '') + (ed ? ' clk' : ''), style: cdef ? { '--acc': cdef.color } : null, role: ed ? 'button' : null, tabindex: ed ? 0 : null, onclick: ed ? () => openWealth(key, it) : null, onkeydown: ed ? e => { if (e.key === 'Enter') openWealth(key, it); } : null },
    it.excluded ? h('div', { class: 'excl' }, 'Not in Net Worth') : null,
    h('div', { class: 'irow' }, h('div', { class: 'iname' }, cdef ? h('img', { class: 'iill', src: 'icons/ill/' + cdef.ill + '.svg', alt: '', width: 36, height: 36 }) : null, it.name, wPill(it.src)), h('div', { class: 'ival' }, money(it.value))),
    it.sub ? h('div', { class: 'isub' }, it.sub) : null,
    openDate(it) && ['new', 'old'].includes(sortMode) ? h('div', { class: 'iline dim' }, 'Opened ' + fmtDate(openDate(it))) : null,
    (it.lines || []).map(l => h('div', { class: 'iline' }, l)));
}

function pageCategory(key) {
  const c = computed(), cat = c.byKey[key] || c.cats[0];
  return h('div', null, backLink('#/dashboard', 'Home'), bookHeader(cat.label, 'Wealth'),
    h('section', null, h('div', { class: 'lbl' }, 'Counted toward Net Worth'), h('div', { class: 'big2' }, money(cat.total))),
    canEdit() && WSPEC[cat.key] ? h('button', { class: 'btn primary', style: { margin: '0 0 12px' }, onclick: () => openWealth(cat.key, null) }, '+ Add ' + WSPEC[cat.key].noun) : null,
    canEdit() && cat.key === 'cash' ? h('button', { class: 'btn primary', style: { margin: '0 0 12px' }, onclick: openCash }, 'Update cash in hand') : null,
    cat.items.length > 1 ? sortBar() : null,
    cat.items.length ? h('div', { class: 'list' }, sortItems(cat.items).map(it => itemCard(it, it.hold ? 'hold' : cat.key))) : h('p', { class: 'empty' }, canEdit() ? 'Nothing here yet. Use the button above to add one.' : 'Nothing here yet.'),
    );
}

// ---------- Investments: mutual funds, stocks, SGB, ETF and bonds in one place ----------
let invBroker = '', invKind = '';
const brokerOf = it => String(it.hold ? it.broker : (it.src && (it.src.accountName || it.src.platformName)) || '').trim();
const acctOf = it => String(it.hold && it.src ? it.src.accountId || '' : '').trim();
const acctKey = (b, a) => b + '||' + (a || '');
const acctLabel = k => { const [b, a] = k.split('||'); return b + (a ? ' · ' + a : ''); };
const KIND_LOOK = { MF: ['#7C3AED', 'mf'], STOCK: ['#2563EB', 'demat'], SGB: ['#D97706', 'gold'], ETF: ['#0D9488', 'bank'], BOND: ['#16A34A', 'fd'], OTHER: ['#64748B', 'manual'] };
const kindOf = it => it.hold ? it.kind : it._cat === 'mf' ? 'MF' : classify({ name: it.name, isin: '', sector: '', itype: '' });
function pageInvest() {
  const c = computed(), all = [...c.byKey.mf.items.map(i => ({ ...i, _cat: 'mf' })), ...c.byKey.demat.items.map(i => ({ ...i, _cat: 'demat' }))];
  const saved = (currentBook().brokerAccounts || []).filter(a => a.broker).map(a => acctKey(a.broker, a.accountId));
  const accts = []; [...all.filter(i => brokerOf(i)).map(i => acctKey(brokerOf(i), acctOf(i))), ...saved].forEach(k => { if (!accts.some(x => x.toLowerCase() === k.toLowerCase())) accts.push(k); });
  accts.sort((a, b) => a.localeCompare(b)); const unlinked = all.some(i => !brokerOf(i));
  if (invBroker && invBroker !== '-' && !accts.some(b => b.toLowerCase() === invBroker.toLowerCase())) invBroker = '';
  const inAcct = i => invBroker === '-' ? !brokerOf(i) : acctKey(brokerOf(i), acctOf(i)).toLowerCase() === invBroker.toLowerCase();
  const byB = all.filter(i => !invBroker || inAcct(i));
  const kinds = KINDS.map(([k, l]) => [k, l, byB.filter(i => kindOf(i) === k)]).filter(x => x[2].length);
  if (invKind && !kinds.some(x => x[0] === invKind)) invKind = '';
  const list = byB.filter(i => !invKind || kindOf(i) === invKind), cnt = a => a.filter(i => !i.excluded);
  const val = cnt(list).reduce((a, i) => a + i.value, 0), cost = cnt(list).reduce((a, i) => a + (i.cost || 0), 0), gain = cost > 0 ? (val - cost) / cost * 100 : null;
  const tab = (label, on, fn, n) => h('button', { type: 'button', class: 'chip2' + (on ? ' on' : ''), onclick: () => { fn(); route(); } }, label, n != null ? h('span', { class: 'cnt' }, ' ' + n) : null);
  return h('div', null, backLink('#/dashboard', 'Home'), bookHeader('Investments', 'Mutual funds, stocks, SGB, ETF and bonds'),
    h('section', null, h('div', { class: 'lbl' }, 'Value' + (invBroker ? ' · ' + (invBroker === '-' ? 'not linked' : acctLabel(invBroker)) : '') + (invKind ? ' · ' + KIND_NAME[invKind] : '')), h('div', { class: 'big2' }, money(val)),
      h('div', { class: 'isub' }, 'Invested ' + money(cost) + (gain === null ? '' : ' · ' + (val >= cost ? 'Gain ' : 'Loss ') + money(Math.abs(val - cost)) + ' (' + pct(gain) + ')'))),
    canEdit() ? h('div', { class: 'row', style: { margin: '0 0 12px' } }, h('button', { class: 'btn primary', onclick: () => openUpload() }, 'Upload broker statement'),
      h('button', { class: 'btn primary', onclick: () => openWealth('hold', null, { broker: invBroker && invBroker !== '-' ? invBroker.split('||')[0] : '', accountId: invBroker && invBroker !== '-' ? invBroker.split('||')[1] : '', kind: invKind || 'STOCK' }) }, '+ Add holding'),
      h('button', { class: 'btn ghost', onclick: openExcelMenu }, 'Excel ▾')) : null,
    canEdit() && legacyList(currentBook()).length ? h('div', { class: 'okbox' }, h('b', null, legacyList(currentBook()).length + ' older entr' + (legacyList(currentBook()).length > 1 ? 'ies' : 'y') + ' in the old format. '), 'Move them into the new list to manage everything in one place. ', h('button', { class: 'btn', type: 'button', onclick: openConvertOld }, 'Move to new list')) : null,
    accts.length || unlinked ? h('div', { class: 'tabrow', role: 'tablist', 'aria-label': 'Account' }, tab('All accounts', !invBroker, () => { invBroker = ''; }), accts.map(b => tab(acctLabel(b), b.toLowerCase() === invBroker.toLowerCase(), () => { invBroker = b; })), unlinked && accts.length ? tab('Not linked', invBroker === '-', () => { invBroker = '-'; }) : null, canEdit() ? h('button', { type: 'button', class: 'chip2 addacc', onclick: openAddAccount }, '+ Account') : null) : (canEdit() ? h('div', { class: 'tabrow' }, h('button', { type: 'button', class: 'chip2 addacc', onclick: openAddAccount }, '+ Account')) : null),
    kinds.length ? h('div', { class: 'tabrow', role: 'tablist', 'aria-label': 'Type' }, tab('All', !invKind, () => { invKind = ''; }, byB.length), kinds.map(([k, l, a]) => { const b = tab(l, invKind === k, () => { invKind = k; }, a.length); b.style.setProperty('--kc', (KIND_LOOK[k] || KIND_LOOK.OTHER)[0]); b.classList.add('kc'); return b; })) : null,
    list.length > 1 ? sortBar() : null,
    list.length ? h('div', { class: 'list' }, sortItems(list).map(it => itemCard(it, it.hold ? 'hold' : it._cat, KIND_LOOK[kindOf(it)] || KIND_LOOK.OTHER))) : h('p', { class: 'empty' }, canEdit() ? 'Nothing here yet. Upload your broker statement, or add a holding.' : 'Nothing here yet.'));
}
// a named account (broker + client ID / nickname) that exists before any holding is saved in it
function openAddAccount() {
  const st = { broker: '', account: '' };
  sheetForm('Add account', api => {
    const bBtn = h('button', { type: 'button', class: 'btn pickbtn' }), aBox = h('input', { type: 'text', placeholder: 'Client ID or a nickname, e.g. Zerodha 1', 'aria-label': 'Account name', autocomplete: 'off', oninput: e => { st.account = e.target.value; } });
    const newPicks = [], paintB = () => { bBtn.textContent = st.broker || 'Choose broker / platform…'; }; paintB();
    bBtn.onclick = () => openBankPicker(st.broker, optionList('broker', S.data), (n, isNew) => { st.broker = n; if (isNew) newPicks.push({ kind: 'broker', name: n }); paintB(); }, 'broker');
    return h('div', null, h('p', { class: 'small' }, 'An account keeps its holdings separate. Uploads into a new account never change holdings saved in another account.'),
      h('div', { class: 'flbl' }, 'Broker / platform'), bBtn, h('div', { class: 'flbl' }, 'Account name'), aBox,
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary big', onclick: ev => {
        const nm = st.account.trim().replace(/\s+/g, ' '); if (!st.broker) return api.fail('Choose the broker / platform.'); if (!nm) return api.fail('Type the account name.');
        if ((currentBook().brokerAccounts || []).some(a => sameName(a.broker, st.broker) && sameName(a.accountId, nm)) || (currentBook().brokerHoldings || []).some(x => !x.isArchived && sameName(x.broker, st.broker) && sameName(x.accountId, nm))) return api.fail('This account already exists.');
        api.run(ev.currentTarget, 'Saving…', () => mutateWealth((b, d) => { b.brokerAccounts = b.brokerAccounts || []; b.brokerAccounts.push({ broker: st.broker, accountId: nm });
          newPicks.forEach(({ kind, name }) => { d.customLists = d.customLists || {}; d.customLists[kind] = d.customLists[kind] || []; if (!optionList(kind, d).some(x => sameName(x, name))) d.customLists[kind].push(name); }); })).then(ok => { if (ok) { invBroker = acctKey(st.broker, nm); toast('Account added ✓'); route(); } }); } }, 'Add account')));
  });
}
// older Mutual Fund / Demat entries (Android format) that can be moved into the new holdings list
function legacyList(book) {
  const out = [];
  (book.mutualFunds || []).filter(x => !x.isArchived).forEach(x => out.push({ arr: 'mutualFunds', idf: 'schemeName', src: x, name: x.schemeName, broker: x.platformName || '', kind: 'MF' }));
  (book.dematHoldings || []).filter(x => !x.isArchived).forEach(x => out.push({ arr: 'dematHoldings', idf: 'stockSymbol', src: x, name: x.stockSymbol, broker: x.accountName || '', kind: classify({ name: x.stockSymbol, isin: '', sector: '', itype: '' }) }));
  return out;
}
function toHolding(l) {
  const x = l.src;
  if (l.arr === 'mutualFunds') { const es = (x.entries || []).filter(e => !e.isDeleted), u = es.reduce((a, e) => a + (e.unitsAllotted || 0), 0), inv = es.reduce((a, e) => a + (e.investedAmount || 0), 0), po = planOptionOf(x.schemeName);
    return { broker: l.broker, accountId: '', kind: 'MF', name: x.schemeName, isin: '', units: +u.toFixed(4), avgPrice: u > 0 ? +(inv / u).toFixed(4) : 0, price: +x.lastFetchedNav > 0 ? +x.lastFetchedNav : 0, priceDate: x.lastFetchedAt || null, tag: '', plan: po.plan, option: po.option, amfi: x.schemeCode || '', folio: x.folioNumber || '', note: '', sip: x.sip || null, entries: JSON.parse(JSON.stringify(es)), excludeFromNetWorth: !!x.excludeFromNetWorth, isArchived: false }; }
  return { broker: l.broker, accountId: '', kind: l.kind, name: x.stockSymbol, isin: '', units: +x.unitsHeld || 0, avgPrice: +x.avgBuyPrice || 0, price: +x.lastFetchedPrice > 0 ? +x.lastFetchedPrice : 0, priceDate: x.lastFetchedAt || null, tag: '', plan: '', option: '', amfi: '', folio: '', note: '', sip: null, entries: [], excludeFromNetWorth: !!x.excludeFromNetWorth, isArchived: false };
}
function openConvertOld() {
  const book = currentBook(), list = legacyList(book);
  const clash = l => (book.brokerHoldings || []).some(h2 => !h2.isArchived && sameName(h2.name, l.name) && sameName(h2.broker || '', l.broker));
  const ok = list.filter(l => !clash(l)), skip = list.filter(clash);
  sheetForm('Move older entries to the new list', api => h('div', null,
    h('p', { class: 'small' }, 'Each older entry becomes a holding with the same name, units, average price and last price. The older entry is then moved to Recently deleted (you can bring it back from there). Your total and Net Worth do not change.'),
    h('div', { class: 'okbox' }, h('b', null, ok.length + ' will be moved'), ok.map(l => h('div', { class: 'small' }, `${KIND_NAME[l.kind] || l.kind} · ${l.name}${l.broker ? ' · ' + l.broker : ''}`))),
    skip.length ? h('div', { class: 'warnbox' }, h('b', null, skip.length + ' left as they are (a holding with the same name and account already exists)'), skip.map(l => h('div', { class: 'small' }, l.name))) : null,
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary big', disabled: !ok.length, onclick: ev => api.run(ev.currentTarget, 'Moving…', () => mutateWealth(b => {
      b.brokerHoldings = b.brokerHoldings || [];
      ok.forEach(l => { const o = (b[l.arr] || []).find(y => !y.isArchived && y[l.idf] === l.name); if (!o) return; b.brokerHoldings.push(toHolding({ ...l, src: o })); o.isArchived = true; o.deletedAt = Date.now(); });
    })).then(done => { if (done) toast(ok.length + ' moved ✓'); }) }, 'Confirm and move ' + ok.length))));
}
// every holding shown on the Investments page as template rows (older Mutual Fund / Demat entries included, marked in Notes)
function holdingRows(book) {
  const rows = (book.brokerHoldings || []).filter(x => !x.isArchived).map(x => [x.broker, x.accountId, x.kind, x.name, x.plan, x.option, x.isin, x.amfi, x.folio, x.units, x.avgPrice, x.price || '', x.priceDate ? dstr(x.priceDate) : '', x.tag, x.note || '', x.uid || '']);
  (book.mutualFunds || []).filter(x => !x.isArchived).forEach(x => { const es = x.entries || [], u = es.reduce((a, e) => a + (e.unitsAllotted || 0), 0), inv = es.reduce((a, e) => a + (e.investedAmount || 0), 0), po = planOptionOf(x.schemeName);
    rows.push([x.platformName || '', '', 'MF', x.schemeName, po.plan, po.option, '', x.schemeCode || '', x.folioNumber || '', +u.toFixed(4), u > 0 ? +(inv / u).toFixed(4) : 0, x.lastFetchedNav || '', x.lastFetchedAt ? dstr(x.lastFetchedAt) : '', '', 'older Mutual Fund entry', '']); });
  (book.dematHoldings || []).filter(x => !x.isArchived).forEach(x => rows.push([x.accountName || '', '', classify({ name: x.stockSymbol, isin: '', sector: '', itype: '' }), x.stockSymbol, '', '', '', '', '', x.unitsHeld, x.avgBuyPrice, x.lastFetchedPrice || '', x.lastFetchedAt ? dstr(x.lastFetchedAt) : '', '', 'older Demat entry', '']));
  return rows;
}
function openExcelMenu() {
  sheetForm('Excel', api => h('div', null, h('p', { class: 'small' }, 'Fill many holdings in one go, or keep an editable copy of what you have.'),
    h('div', { class: 'stack' }, h('button', { class: 'btn', type: 'button', onclick: () => { download('arthik-holdings-sample.xlsx', buildHoldingsXlsx([], true)); closeModal(); } }, 'Download sample Excel (blank template)'),
      h('button', { class: 'btn', type: 'button', onclick: async ev => { if (!holdingRows(currentBook()).length) { api.fail('There are no holdings in this book yet, so there is nothing to download.'); return; }
        if (canEdit() && (currentBook().brokerHoldings || []).some(x => !x.isArchived && !x.uid)) { const b0 = ev.currentTarget; b0.disabled = true; try { await mutateWealth(b => (b.brokerHoldings || []).forEach(x => { if (!x.uid) x.uid = newUid(); })); } catch (e) { b0.disabled = false; api.fail(e.message); return; } }
        const rows = holdingRows(currentBook()); download('arthik-holdings-' + new Date().toISOString().slice(0, 10) + '.xlsx', buildHoldingsXlsx(rows, false)); closeModal(); toast(rows.length + ' holdings downloaded ✓'); } }, 'Download my holdings (Excel)'),
      canEdit() ? h('button', { class: 'btn', type: 'button', onclick: () => { api.close(); openUpdateOnly(); } }, 'Update my saved holdings from an edited file') : null,
      canEdit() ? h('button', { class: 'btn primary', type: 'button', onclick: () => openUpload() }, 'Upload a filled Excel / broker file') : null),
    h('p', { class: 'small' }, '“Update my saved holdings” changes only what you edited in a downloaded file (for example, filling in Client IDs) and never adds or removes anything. ' + 'Older Mutual Fund and Demat entries are included and marked in Notes. Re-uploading them would add them again as new holdings, so delete the older ones after you upload.')));
}
function openUpdateOnly() {
  const st = { plan: null };
  sheetForm('Update my saved holdings', api => {
    const box = h('div'), fileIn = h('input', { type: 'file', accept: '.xlsx,.xlsm,.csv', 'aria-label': 'Edited holdings file' });
    const read = h('button', { type: 'button', class: 'btn primary big' }, 'Read the file');
    const paint = () => {
      const pl = st.plan; if (!pl) { box.replaceChildren(); return; }
      const warn = (t, a) => a.length ? h('div', { class: 'warnbox' }, t + ' ' + a.slice(0, 5).join(', ') + (a.length > 5 ? '…' : '')) : null;
      const go = h('button', { type: 'button', class: 'btn primary big', disabled: !pl.change.length }, 'Confirm and save ' + pl.change.length + ' change' + (pl.change.length === 1 ? '' : 's'));
      go.onclick = () => api.run(go, 'Saving…', () => mutateWealth(b => { const p2 = planUpdate(b.brokerHoldings, st.parsed); applyUpdate(b, p2); })).then(ok => ok && toast(pl.change.length + ' updated ✓'));
      box.replaceChildren(h('div', { class: 'okbox' }, h('b', null, pl.change.length + ' will change · ' + pl.same + ' unchanged'), pl.change.length ? h('ul', { class: 'plist plbox' }, pl.change.map(c => h('li', null, c.name + ' · ' + c.text.join(' · ')))) : h('div', { class: 'small' }, 'Nothing differs from what is saved.')),
        warn('Skipped (no Arthik ID in the row, use a normal upload for these):', pl.noId), warn('Not found any more (changed or deleted since the download):', pl.notFound),
        h('div', { class: 'small' }, 'Nothing is added or removed. Only the cells you changed are applied.'), h('div', { class: 'actions' }, go));
    };
    read.onclick = async () => {
      const f = fileIn.files && fileIn.files[0]; if (!f) return api.fail('Choose your edited file first.');
      read.disabled = true; read.textContent = 'Reading…';
      try { const sheets = await readFile(f), p = parseTemplate(sheets); if (!p || !p.holdings.length) throw new Error('This does not look like a holdings file downloaded from Arthik.'); st.parsed = p; st.plan = planUpdate(currentBook().brokerHoldings, p); paint(); api.fail(''); }
      catch (e) { api.fail(e.message); } finally { read.disabled = false; read.textContent = 'Read the file'; }
    };
    return h('div', null, h('p', { class: 'small' }, 'Use the file from Excel ▾ → Download my holdings. Change any cell you need (Client ID, broker, notes, quantity, prices…) and choose it here. The hidden Arthik ID column finds each holding, even if its Client ID changed.'),
      h('div', { class: 'flbl' }, 'Edited file'), fileIn, h('div', { class: 'actions' }, read), box);
  });
}
const SUPPORTED_BROKERS = [['Zerodha', 'Zerodha (Kite)']];
function openUpload() {
  const book = currentBook();
  const st = { broker: (invBroker && invBroker !== '-' && SUPPORTED_BROKERS.some(b => b[0].toLowerCase() === invBroker.split('||')[0].toLowerCase())) ? SUPPORTED_BROKERS.find(b => b[0].toLowerCase() === invBroker.split('||')[0].toLowerCase())[0] : '', account: invBroker && invBroker !== '-' ? invBroker.split('||')[1] || '' : '', parsed: null, plan: null, rm: false };
  sheetForm('Upload broker statement', api => {
    const box = h('div');
    const fileIn = h('input', { type: 'file', accept: '.xlsx,.xlsm,.csv', 'aria-label': 'Statement file' });
    const bBtn = h('select', { 'aria-label': 'Broker', onchange: e => { st.broker = e.target.value; if (st.parsed) previewPaint(); } }, h('option', { value: '' }, 'Choose broker…'), SUPPORTED_BROKERS.map(b => h('option', { value: b[0], selected: st.broker === b[0] }, b[1]))), acc = h('button', { type: 'button', class: 'btn pickbtn' });
    const ctlBox = h('div'); const pickLabel = () => { bBtn.value = st.broker || ''; acc.textContent = st.account || 'Choose client ID / account…'; };
    acc.onclick = () => openBankPicker(st.account, optionList('clientid', S.data), (n, isNew) => { st.account = n; if (isNew) newPicks.push({ kind: 'clientid', name: n }); pickLabel(); if (st.parsed) previewPaint(); }, 'clientid');
    bBtn.onclick = null;
    const newPicks = [];
    const read = h('button', { type: 'button', class: 'btn primary big' }, 'Read the file');
    const go = h('button', { type: 'button', class: 'btn primary big' }, 'Confirm and save');
    const preview = h('div'); ctlBox.append(h('div', { class: 'flbl' }, 'Broker'), bBtn, h('div', { class: 'small' }, 'Only brokers whose statement we can read are listed. For any other broker, use the Arthik Excel template (Excel ▾ → sample): it works for every broker. More brokers are added when a sample statement is available.'), h('div', { class: 'flbl' }, 'Client ID'), acc);
    const previewPaint = () => {
      const p = st.parsed; if (!p) { preview.replaceChildren(); return; }
      st.plan = planImport(book.brokerHoldings, p, st.broker || '', st.account); bBtn.parentElement; ctlBox.hidden = !!p.multi;
      const pl = st.plan, nameOf = x => x.name;
      const sec = (t, a, f) => a.length ? h('div', null, h('div', { class: 'flbl' }, t + ' (' + a.length + ')'), h('ul', { class: 'plist plbox' }, a.map(x => h('li', null, f(x))))) : null;
      const diff = (o, n) => { const t = []; if (Math.abs(o.units - n.units) > 1e-6) t.push(`units ${+(+o.units).toFixed(4)} → ${+(+n.units).toFixed(4)}`); if (Math.abs((o.avgPrice || 0) - n.avgPrice) > 1e-4) t.push(`avg ${price2(o.avgPrice)} → ${price2(n.avgPrice)}`); if (n.price > 0 && Math.abs((o.price || 0) - n.price) > 1e-4) t.push(`price ${price2(o.price)} → ${price2(n.price)}`); return t.join(', '); };
      const whose = x => (x.broker || st.broker) + (x.accountId || st.account ? ' / ' + (x.accountId || st.account) : '');
      const fNew = x => `${KIND_NAME[x.kind]} · ${nameOf(x)} · ${+x.units.toFixed(4)} @ ${price2(x.avgPrice)} · ${whose(x)}`, fChg = x => `${nameOf(x.now)} · ${diff(x.old, x.now)}`, fGone = x => `${x.name} · ${x.broker || ''}${x.accountId ? ' / ' + x.accountId : ''}`;
      const legacy = [...(book.mutualFunds || []).filter(x => !x.isArchived).map(x => x.schemeName), ...(book.dematHoldings || []).filter(x => !x.isArchived).map(x => x.stockSymbol)];
      const dup = p.holdings.filter(x => legacy.some(l => sameName(l, x.name)));
      const warns = () => [
        pl.byName.length ? h('div', { class: 'warnbox' }, 'Matched by name only (no ISIN or AMFI code): ' + pl.byName.slice(0, 4).join(', ') + (pl.byName.length > 4 ? '…' : '') + '. Please check these are the right plan and option.') : null,
        pl.dupes.length ? h('div', { class: 'warnbox' }, 'Possible duplicates in the file (same fund, different plan or option): ' + pl.dupes.slice(0, 3).join(' | ')) : null,
        pl.dupIsin.length ? h('div', { class: 'warnbox' }, 'The same ISIN appears more than once in this file, so it would be added as separate holdings: ' + pl.dupIsin.slice(0, 3).join(' | ') + '. Merge those rows into one if they are the same holding.') : null,
        pl.elsewhere.length ? h('div', { class: 'warnbox' }, 'Possibly the same holding saved under another broker or client ID: ' + pl.elsewhere.slice(0, 3).join(' | ') + (pl.elsewhere.length > 3 ? '…' : '') + '. Check this is not a duplicate.') : null,
        dup.length ? h('div', { class: 'warnbox' }, dup.length + ' of these also exist as older Mutual Fund / Demat entries (' + dup.slice(0, 3).map(x => x.name).join(', ') + (dup.length > 3 ? '…' : '') + '). After importing, delete the old ones to avoid counting twice.') : null];
      const summary = () => [pl.add.length ? 'add ' + pl.add.length + ' new' : '', pl.update.length ? 'update ' + pl.update.length : '', pl.same.length ? 'refresh the price date of ' + pl.same.length + ' unchanged' : '', st.rm && pl.missing.length ? 'move ' + pl.missing.length + ' to Recently deleted' : ''].filter(Boolean).join(', ');
      const lists = () => [sec('New: will be added', pl.add, fNew), sec('Changed: will be updated', pl.update, fChg), st.rm ? sec('Will be moved to Recently deleted', pl.missing, fGone) : null,
        pl.same.length ? h('div', { class: 'small' }, pl.same.length + ' unchanged (only their price date is refreshed).') : null];
      const confirmPaint = () => {
        const back = h('button', { type: 'button', class: 'btn' }, '← Back'); back.onclick = previewPaint;
        preview.replaceChildren(h('div', { class: 'okbox' }, h('b', null, 'Please confirm. '), 'This will ' + (summary() || 'change nothing') + '. Nothing else in your data is touched.'), ...lists().filter(Boolean), ...warns().filter(Boolean), h('div', { class: 'actions' }, back, go));
      };
      go.textContent = 'Confirm and save'; go.disabled = false;
      const review = h('button', { type: 'button', class: 'btn primary big' }, 'Review changes'); review.onclick = () => { if (!st.broker && !st.parsed.multi) return api.fail('Choose the broker this statement is from.'); if (!(pl.add.length + pl.update.length + pl.same.length + (st.rm ? pl.missing.length : 0))) return api.fail('There is nothing to import.'); confirmPaint(); };
      preview.replaceChildren(
        h('div', { class: 'okbox' }, 'Found ' + p.holdings.length + ' holdings' + (p.asOn ? ' as on ' + fmtDate(p.asOn) : '') + (p.clientId ? ' · client ' + p.clientId : '') + '. Nothing is saved yet. Next you will see every change and confirm it.'),
        p.notes.map(n => h('div', { class: 'small' }, n)),
        ...lists().filter(Boolean),
        pl.missing.length ? h('div', null, !st.rm ? sec('Saved earlier but not in this file (kept)', pl.missing, fGone) : null, toggleRow('Also move these to Recently deleted', () => st.rm, v => { st.rm = v; previewPaint(); })) : null,
        ...warns().filter(Boolean), h('div', { class: 'actions' }, review));
    };
    read.onclick = async () => {
      const f = fileIn.files && fileIn.files[0]; if (!f) return api.fail('Choose your statement file first.');
      read.disabled = true; read.textContent = 'Reading…';
      try { const sheets = await readFile(f); const p = parseStatement(sheets); if (!p.holdings.length) throw new Error(p.notes.join(' ') || 'No holdings found.');
        st.parsed = p; if (!st.broker && p.broker) st.broker = p.broker; if (!st.account && p.clientId) { st.account = p.clientId; } pickLabel(); previewPaint(); }
      catch (e) { st.parsed = null; preview.replaceChildren(); api.fail(e.message); }
      read.disabled = false; read.textContent = 'Read the file';
    };
    go.onclick = () => {
      if (!st.broker && !st.parsed.multi) return api.fail('Choose the broker this statement is from.');
      const asOn = st.parsed.asOn, ctx = { broker: st.broker, accountId: st.parsed.multi ? '' : st.account.trim(), asOn };
      api.run(go, 'Saving…', () => mutateWealth((b, d) => { newPicks.forEach(({ kind, name }) => { d.customLists = d.customLists || {}; d.customLists[kind] = d.customLists[kind] || []; if (!optionList(kind, d).some(x => sameName(x, name))) d.customLists[kind].push(name); });
        const plan = planImport(b.brokerHoldings, st.parsed, ctx.broker, ctx.accountId); applyImport(b, plan, ctx, st.rm); })).then(ok => ok && toast('Imported ✓ ' + (st.plan ? st.plan.add.length + ' added, ' + st.plan.update.length + ' updated' : '')));
    };
    return h('div', null, h('p', { class: 'small' }, 'Choose the holdings file from your broker (Excel or CSV), or the Arthik sample Excel after filling it. It is read inside this page; the file itself is never uploaded or saved.'),
      h('div', { class: 'flbl' }, 'Statement file'), fileIn, ctlBox,
      h('div', { class: 'actions' }, read), preview);
  });
}

const isCard = l => String(l.src && l.src.liabilityType || '').toLowerCase().replace(/[^a-z]/g, '') === 'creditcard';
let liabKind = '';
const liabKindOf = l => isCard(l) ? 'CARD' : l.kind === 'Loan' ? 'LOAN' : 'OTHER';
function openAddLiability() {
  sheetForm('Add liability', api => h('div', null, h('div', { class: 'flbl' }, 'What is it?'),
    h('div', { class: 'stack' },
      h('button', { type: 'button', class: 'btn big', onclick: () => { api.close(); openWealth('loan', null); } }, 'Bank loan with EMIs (home, car, education, personal)'),
      h('button', { type: 'button', class: 'btn big', onclick: () => { api.close(); openWealth('card', null); } }, 'Credit card'),
      h('button', { type: 'button', class: 'btn big', onclick: () => { api.close(); openWealth('liability', null, { liabilityType: 'PERSONAL_LOAN' }); } }, 'Other money I owe')),
    h('p', { class: 'small' }, 'A bank loan gets a full EMI schedule you can tick off. A credit card tracks the bill and its pay-by date. Other money is a single amount you owe, with an optional pay-by date or your own EMI.')));
}
function pageLiabilities() {
  const c = computed(), all = c.liabilities, list = all.filter(l => !liabKind || liabKindOf(l) === liabKind), total = list.filter(l => !l.excluded).reduce((a, l) => a + l.value, 0);
  const kinds = [['LOAN', 'Loans'], ['CARD', 'Credit cards'], ['OTHER', 'Other dues']].map(([k, l]) => [k, l, all.filter(x => liabKindOf(x) === k).length]).filter(x => x[2]);
  if (liabKind && !kinds.some(x => x[0] === liabKind)) liabKind = '';
  const tab = (label, on, fn, n) => h('button', { type: 'button', class: 'chip2' + (on ? ' on' : ''), onclick: () => { fn(); route(); } }, label, h('span', { class: 'cnt' }, ' ' + n));
  return h('div', null, bookHeader('Liabilities', 'Loans, credit cards and other dues'),
    h('section', null, h('div', { class: 'lbl' }, 'Total outstanding' + (liabKind ? ' · ' + (kinds.find(x => x[0] === liabKind) || [0, ''])[1] : '')), h('div', { class: 'big2' }, money(total))),
    canEdit() ? h('div', { class: 'row', style: { margin: '0 0 12px' } }, h('button', { class: 'btn primary', onclick: openAddLiability }, '+ Add')) : null,
    kinds.length > 1 ? h('div', { class: 'tabrow', role: 'tablist', 'aria-label': 'Type' }, tab('All', !liabKind, () => { liabKind = ''; }, all.length), kinds.map(([k, l, n]) => tab(l, liabKind === k, () => { liabKind = k; }, n))) : null,
    list.length > 1 ? sortBar() : null,
    list.length ? h('div', { class: 'list' }, sortItems(list).map(l => itemCard({ ...l, sub: (l.kind === 'Loan' ? 'Loan · ' : '') + (l.sub || '') }, isCard(l) ? 'card' : l.key))) : h('p', { class: 'empty' }, 'No liabilities.'));
}

function pageGoals() {
  const c = computed();
  return h('div', null, bookHeader('Goals', 'Progress'),
    canEdit() ? h('button', { class: 'btn primary', style: { margin: '0 0 12px' }, onclick: () => openWealth('goal', null) }, '+ Add goal') : null,
    c.goals.length ? h('div', { class: 'list' }, c.goals.map(g => h('div', { class: 'item clk', role: 'button', tabindex: 0, onclick: () => openGoalDetail(g), onkeydown: e => { if (e.key === 'Enter') openGoalDetail(g); } },
      h('div', { class: 'irow' }, h('div', { class: 'iname' }, g.name), h('div', { class: 'ival' }, g.pct.toFixed(0) + '%' + (g.pct >= 100 ? ' ✓' : ''))),
      h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': g.pct.toFixed(0), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span', { style: { width: Math.min(100, g.pct) + '%' } })),
      h('div', { class: 'iline' }, `${money(g.current)} of ${money(g.target)}${g.targetDate ? ' · by ' + fmtDate(g.targetDate) : ''}`),
      g.linked.length ? h('div', { class: 'isub' }, g.linked.length + (g.linked.length > 1 ? ' linked items' : ' linked item') + ' · tap to see') : null))) : h('p', null, 'No goals yet.'));
}
function openGoalDetail(g) {
  sheetForm(g.name, api => h('div', null,
    h('div', { class: 'irow' }, h('div', { class: 'lbl' }, 'Progress'), h('b', null, g.pct.toFixed(0) + '%' + (g.pct >= 100 ? ' ✓' : ''))),
    h('div', { class: 'bar' }, h('span', { style: { width: Math.min(100, g.pct) + '%' } })),
    h('div', { class: 'iline' }, `${money(g.current)} of ${money(g.target)}${g.targetDate ? ' · by ' + fmtDate(g.targetDate) : ''}`),
    h('div', { class: 'flbl', style: { marginTop: '14px' } }, 'Linked items'),
    g.linked.length ? h('div', { class: 'erows' }, g.linked.map(l => h('div', { class: 'erow' }, h('span', null, `${l.name} · ${l.cat}` + (l.excluded ? ' (not counted: Net Worth switch is off)' : '')), h('b', null, money(l.value)))))
      : h('p', { class: 'small' }, 'Nothing linked yet. Pick this goal when you add an asset, or tick items in Edit goal.'),
    canEdit() ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary big', onclick: () => { api.close(); openWealth('goal', { src: g.src }); } }, 'Edit goal')) : null));
}

function pageRent() {
  const c = computed();
  return h('div', null, bookHeader('Rent receivable', 'Tracking only — not in Net Worth'),
    canEdit() ? h('button', { class: 'btn primary', style: { margin: '0 0 12px' }, onclick: () => openWealth('rent', null) }, '+ Add rented property') : null,
    c.rent.length > 1 ? sortBar() : null,
    c.rent.length ? h('div', { class: 'list' }, sortItems(c.rent.map(r => ({ src: r, name: r.propertyName, value: r.monthlyRent }))).map(x => x.src).map(r => {
      const pays = (r.payments || []).filter(p => p.entryType === 'RENT').sort((a, b) => b.receivedDate - a.receivedDate);
      return h('div', { class: 'item' + (canEdit() ? ' clk' : ''), role: canEdit() ? 'button' : null, tabindex: canEdit() ? 0 : null, onclick: canEdit() ? () => openWealth('rent', { src: r }) : null }, h('div', { class: 'irow' }, h('div', { class: 'iname' }, r.propertyName), h('div', { class: 'ival' }, money(r.monthlyRent) + '/mo')),
        h('div', { class: 'isub' }, [r.tenantName, r.tenantPhone].filter(Boolean).join(' · ')),
        h('div', { class: 'iline' }, `Shift date ${fmtDate(r.startDate)} · security deposit ${money(r.securityDeposit)}`),
        pays.slice(0, 3).map(p => h('div', { class: 'isub' }, `Received ${fmtDate(p.receivedDate)} · ${money(p.amount)} · ${p.paymentMode.toLowerCase()}`)));
    })) : h('p', null, 'No rented properties.'));
}


// ---------- Expense book pages ----------
const dayLabel = (ts) => new Date(ts).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const PALETTE = ['#3B82F6', '#F59E0B', '#14B8A6', '#EC4899', '#8B5CF6', '#10B981', '#F97316', '#0EA5E9', '#EF4444', '#6366F1', '#EAB308', '#22C55E'];
const TYPE = { INCOME: { label: 'Income', cls: 'up', sign: '+' }, EXPENSE: { label: 'Expense', cls: 'down', sign: '−' }, TRANSFER: { label: 'Transfer', cls: 'blue', sign: '' } };
// Each category gets its own colour: the one saved in the app, unless several categories share the same one
// (the default), in which case they are told apart with a palette.
function catColors(c) {
  if (c._cc) return c._cc;
  const cats = Object.values(c.cat), parsed = {}, count = {};
  cats.forEach(x => { const m = typeof x.colorHex === 'string' && x.colorHex.trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{8})$/i);
    const col = m ? '#' + (m[1].length === 8 ? m[1].slice(2) : m[1]).toUpperCase() : null; parsed[x.localId] = col; if (col) count[col] = (count[col] || 0) + 1; });
  const out = {}; cats.forEach((x, i) => { const col = parsed[x.localId]; out[x.localId] = col && count[col] === 1 ? col : PALETTE[i % PALETTE.length]; });
  return (c._cc = out);
}
const CAT_PIC = [[/groc|vegetab|fruit|milk|kirana|supermarket/i, '🛒'], [/fuel|petrol|diesel|cng/i, '⛽'], [/din|food|restaurant|eat|swiggy|zomato|cafe|snack|lunch|dinner/i, '🍽️'], [/rent|home|house|maintenance|society/i, '🏠'], [/electric|water|gas|bill|utilit|wifi|internet|broadband/i, '💡'],
  [/car|bike|auto|cab|taxi|transport|travel|metro|bus|train|toll|parking/i, '🚗'], [/health|medic|doctor|pharm|hospital|gym|fitness/i, '💊'], [/movie|entertain|netflix|ott|music|game|fun/i, '🎬'], [/shop|cloth|apparel|fashion|amazon|flipkart/i, '🛍️'], [/flight|trip|holiday|vacation|hotel/i, '✈️'],
  [/school|educat|fees|course|book|tuition/i, '🎓'], [/salary|income|bonus|pay\b|wage/i, '💼'], [/gift|donat|charity|festival/i, '🎁'], [/phone|mobile|recharge|dth/i, '📱'], [/insur|premium|emi|loan|invest|sip|saving/i, '🏦'], [/interest|dividend|refund|cashback/i, '💰']];
const catPic = (name, type) => { const m = CAT_PIC.find(([re]) => re.test(name || '')); return m ? m[1] : type === 'TRANSFER' ? '🔁' : type === 'INCOME' ? '💰' : '🧾'; };
function txRow(t, c) {
  const a = c.acc[t.accountLocalId], to = c.acc[t.toAccountLocalId], cat = c.cat[t.categoryLocalId], ty = TYPE[t.type] || TYPE.EXPENSE;
  const mode = t.type !== 'TRANSFER' && a ? ` (${a.name})` : '';
  const title = t.type === 'TRANSFER' ? `${a ? a.name : '?'} → ${to ? to.name : '?'}${t.note ? ' · ' + t.note : ''}` : (cat ? cat.name : 'Uncategorised') + (t.note ? ' · ' + t.note : '') + mode;
  const dot = t.type === 'TRANSFER' ? 'var(--pri)' : (cat ? catColors(c)[cat.localId] : 'var(--line2)');
  const ed = canEdit() && !t.__ro;
  return h('div', { class: 'tx soft' + (ed ? ' clk' : ''), style: { '--tc': dot }, role: ed ? 'button' : null, tabindex: ed ? 0 : null, onclick: ed ? () => openEntry(t) : null, onkeydown: ed ? e => { if (e.key === 'Enter') openEntry(t); } : null },
    h('span', { class: 'txpic', 'aria-hidden': 'true' }, catPic(cat && cat.name, t.type)),
    h('div', { class: 'txm' }, h('div', { class: 'txt' }, title, h('span', { class: 'ttag ' + ty.cls }, ty.label), t.settle ? h('span', { class: 'ttag ' + (t.settle.paid ? '' : t.settle.kind === 'I_OWE' ? 'down' : 'blue') }, (t.settle.kind === 'I_OWE' ? 'I owe ' : 'Owed by ') + t.settle.person + (t.settle.paid ? ' · settled' : '')) : null), h('div', { class: 'isub' }, dayLabel(t.occurredAt))),
    h('div', { class: 'txa ' + ty.cls }, ty.sign + money(t.amount)));
}

const sentence = x => { const t = String(x || '').replace(/_/g, ' ').trim().toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
const niceName = x => { const t = String(x || '').trim(); return t && t === t.toLowerCase() ? t.charAt(0).toUpperCase() + t.slice(1) : t; };
const accType = a => { const ty = sentence(a.type); return ty && ty.replace(/\s/g, '').toLowerCase() !== String(a.name || '').replace(/\s/g, '').toLowerCase() ? ty : ''; };

// ---------- small helpers: backup age, install hint, due pills ----------
function backupBanner() {
  if (canEdit()) {   // nudge: no full backup downloaded for 14 days (or never)
    const last = S.data && (S.data.lastBackupAt || 0); let snooze = 0; try { snooze = +localStorage.getItem('arthik.backupsnooze') || 0; } catch {}
    const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
    if ((last && days < 14) || Date.now() < snooze || !S.data || !activeBooks(S.data).length) return null;
    return h('div', { class: 'fresh old' }, h('span', null, '⚠ ' + (last ? `Your last backup was ${days} days ago.` : 'You have not downloaded a backup yet.') + ' Your data lives only in Dropbox, so a copy on your device is a good idea. '),
      h('button', { class: 'btn', type: 'button', onclick: openBackup }, 'Download backup'), h('button', { class: 'link', type: 'button', onclick: () => { try { localStorage.setItem('arthik.backupsnooze', String(Date.now() + 3 * 86400000)); } catch {} route(); } }, 'Remind me in 3 days'));
  }
  const t = S.data && S.data.exportedAt; if (!t) return null;   // when editing is on, the web file is the live copy
  const days = Math.floor((Date.now() - t) / 86400000);
  const old = days >= 14;
  return h('div', { class: 'fresh' + (old ? ' old' : '') }, old ? '⚠ ' : '', `Data from your backup of ${fmtDate(t)}` + (days <= 0 ? ' (today)' : ` (${days} day${days === 1 ? '' : 's'} old)`) + (old ? '. Take a fresh backup on your Android phone and use Settings › Replace from a backup file.' : ''));
}
function installHint() {
  try {
    const ua = navigator.userAgent, ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
    if (!ios || standalone || localStorage.getItem('arthik.hint') === '1') return null;
    return h('div', { class: 'note hint' }, h('b', null, 'Tip: '), 'tap the Share button in Safari, then “Add to Home Screen”. Arthik then opens like a normal app, without the browser bars. ',
      h('button', { class: 'link', onclick: e => { try { localStorage.setItem('arthik.hint', '1'); } catch {} e.target.closest('.hint').remove(); } }, 'Got it'));
  } catch { return null; }
}
function duePill(a, c) {
  if (a.type !== 'CREDIT_CARD') return null;
  const rules = (c.rulesAll || []).filter(r => !r.isPaused && (r.accountLocalId === a.localId || r.toAccountLocalId === a.localId)).sort((x, y) => x.nextRunAt - y.nextRunAt);
  const r = rules[0]; if (!r) return null;
  const sod = new Date(); sod.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(r.nextRunAt).setHours(0, 0, 0, 0) - sod.getTime()) / 86400000);
  const txt = days < 0 ? `Overdue by ${-days} day${days === -1 ? '' : 's'}` : days === 0 ? 'Due today' : `Due in ${days} day${days === 1 ? '' : 's'}`;
  return h('div', { class: 'pill ' + (days < 0 ? 'bad' : days <= 3 ? 'warn' : 'ok') }, txt, ' · ', money(r.amount));
}
const monthLabel = (off) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + off, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }); };

// ---------- editing: safe saving ----------
const canEdit = () => !!(S.data && S.enc && S.pw && !S.offline && dbx.isSignedIn());
let saving = false;
// Applies fn to the data and saves it. If the file in Dropbox changed on another device meanwhile,
// it re-reads the newest file, applies the same change again on top of it, and retries - nothing is overwritten.
async function mutate(fn) {
  if (saving) throw new Error('Another save is still running. Try again in a moment.');
  saving = true;
  let base = JSON.stringify(S.data);   // the last copy we know is saved; used to undo if saving fails
  try {
    for (let i = 0; i < 4; i++) {
      fn(S.data);
      const text = await encrypt(JSON.stringify(S.data), S.pw);
      try {
        const r = await dbx.upload(text, S.rev);
        S.enc = text; S.rev = r.rev; S.modified = r.modified; cacheSave(); view.cache = null; return;
      } catch (e) {
        if (e.message !== 'CONFLICT') throw e;
        const f = await dbx.download(); if (!f) throw new Error('The file was removed from Dropbox. Nothing was saved.');
        const d = await decrypt(f.text, S.pw);
        if (!d.ok) throw new Error('The password was changed on another device. Lock and unlock with the new password. Nothing was saved.');
        S.data = JSON.parse(d.text); S.enc = f.text; S.rev = f.rev; S.modified = f.modified; base = d.text; view.cache = null;
      }
    }
    throw new Error('The file keeps changing on another device. Try again.');
  } catch (e) { S.data = JSON.parse(base); view.cache = null; throw e; }
  finally { saving = false; }
}
const findBook = (d, name) => activeBooks(d).find(b => b.name === name && b.bookType === 'EXPENSE');

let toastT = null;
function toast(msg, bad) {
  document.querySelectorAll('.toast').forEach(x => x.remove());
  const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, msg); document.body.append(t);
  clearTimeout(toastT); toastT = setTimeout(() => t.remove(), bad ? 6000 : 2500);
}
function closeModal() { document.querySelectorAll('.overlay').forEach(x => x.remove()); }
const dstr = ts => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

function openEntry(t) {
  closeModal();
  const book = currentBook(), bname = book.name, c = computed();
  const isEdit = !!t;
  const accs = (book.accounts || []).filter(a => !a.isArchived || (t && (t.accountLocalId === a.localId || t.toAccountLocalId === a.localId)));
  const cats = (book.categories || []).filter(x => !x.isArchived || (t && t.categoryLocalId === x.localId));
  let lastAcc = null; try { lastAcc = +localStorage.getItem('arthik.lastacc.' + bname) || null; } catch {}
  const st = {
    type: t ? t.type : 'EXPENSE', cat: t ? t.categoryLocalId : (() => { try { const k = +localStorage.getItem('arthik.lastcat.' + bname); return cats.some(x => x.localId === k) ? k : null; } catch { return null; } })(),
    acc: t ? t.accountLocalId : ((accs.find(a => a.localId === lastAcc) || accs.find(a => a.isDefault) || accs[0] || {}).localId),
    to: t ? t.toAccountLocalId : null,
  };
  const amount = h('input', { type: 'text', inputmode: 'decimal', class: 'amt', placeholder: '0', value: t ? String(t.amount) : '', 'aria-label': 'Amount', autocomplete: 'off' });
  const date = h('input', { type: 'date', value: dstr(t ? t.occurredAt : Date.now()), max: dstr(Date.now() + 86400000 * 366), 'aria-label': 'Date' });
  const note = h('input', { type: 'text', value: (t && t.note) || '', placeholder: 'Comment (optional)', maxlength: 120, 'aria-label': 'Comment' });
  const msg = h('div', { class: 'err', hidden: true });
  const stl = { kind: t && t.settle ? t.settle.kind : '', person: t && t.settle ? t.settle.person : '' };
  const people = [...new Set((book.transactions || []).map(x => x.settle && x.settle.person).filter(Boolean))];
  const rcv = { on: false, acc: t ? t.accountLocalId : null }, rcvBox = h('div', null);
  const stlBox = h('div', null), person = h('input', { type: 'text', 'aria-label': 'Person', placeholder: 'Whose money? e.g. Ankit', value: stl.person, list: 'ppl', autocomplete: 'off', maxlength: 40, oninput: e => { stl.person = e.target.value; } });
  const stlPaint = () => { const ex = st.type === 'EXPENSE'; stlBox.hidden = !ex; if (!ex) return;
    const paidInfo = t && t.settle && t.settle.paid ? h('div', { class: 'small' }, 'Marked paid on ' + fmtDate(t.settle.paidAt) + '. ' + (t.settle.receivedTxId ? 'The money received was recorded as an Income entry.' : 'No accounting entry was made.')) : null;
    stlBox.replaceChildren(h('div', { class: 'flbl' }, 'Settle with someone? (optional)'),
      chipRow([['', 'No'], ['OWED_TO_ME', 'Owed to me (I paid for them)'], ['I_OWE', 'I owe (they paid for me)']], () => stl.kind, v => { stl.kind = v; stlPaint(); }),
      stl.kind ? h('div', null, h('div', { class: 'flbl' }, stl.kind === 'I_OWE' ? 'Who paid for you?' : 'Who do they owe?'), person, h('datalist', { id: 'ppl' }, people.map(p => h('option', { value: p }))),
        h('div', { class: 'small' }, stl.kind === 'I_OWE' ? 'This entry reduces your account now. When you pay them back, press "Mark as paid": no second entry is made.' : 'This entry reduces your account now. When they pay you back, press "Mark as paid": no second entry is made.')) : null, paidInfo); };
  const typeBox = h('div', { class: 'seg', role: 'tablist' }), catBox = h('div', null), accBox = h('div', null), toBox = h('div', null);
  const chips = (list, key, box, label, extra) => { box.replaceChildren(h('div', { class: 'flbl' }, label), h('div', { class: 'chips' }, list.map(x => {
    const id = x.localId, on = st[key] === id, col = extra ? extra(x) : null;
    return h('button', { type: 'button', class: 'chip2' + (on ? ' on' : ''), style: on && col ? { background: col, borderColor: col } : null, onclick: () => { st[key] = id; paint(); } },
      col ? h('span', { class: 'sw', style: { background: on ? '#fff' : col } }) : null, key === 'cat' ? x.name : niceName(x.name)); }))); };
  function paint() {
    typeBox.replaceChildren(...[['EXPENSE', 'Expense'], ['INCOME', 'Income'], ['TRANSFER', 'Transfer']].map(([k, l]) =>
      h('button', { type: 'button', class: 'segb ' + TYPE[k].cls + (st.type === k ? ' on' : ''), onclick: () => { st.type = k; paint(); } }, l)));
    const tr = st.type === 'TRANSFER';
    catBox.hidden = tr; if (!tr) chips(cats, 'cat', catBox, 'Category', x => catColors(c)[x.localId]);
    chips(accs, 'acc', accBox, tr ? 'From account' : 'Account (cash, bank, card…)');
    toBox.hidden = !tr; if (tr) chips(accs.filter(a => a.localId !== st.acc), 'to', toBox, 'To account');
    stlPaint();
  }
  const save = h('button', { type: 'button', class: 'btn primary big' }, isEdit ? 'Save changes' : 'Save entry');
  const fail = m => { msg.textContent = m; msg.hidden = false; };
  save.onclick = async () => {
    msg.hidden = true;
    const amt = Math.round(parseFloat(String(amount.value).replace(/,/g, '')) * 100) / 100;
    if (!(amt > 0)) return fail('Enter an amount greater than zero.');
    if (st.acc == null) return fail('Choose an account.');
    const tr = st.type === 'TRANSFER';
    if (tr && (st.to == null || st.to === st.acc)) return fail('Choose a different account to transfer to.');
    if (!tr && st.cat == null) return fail('Choose a category.');
    if (!date.value) return fail('Choose a date.');
    const [y, m, dd] = date.value.split('-').map(Number), now = new Date();
    const same = isEdit && dstr(t.occurredAt) === date.value;
    const when = same ? t.occurredAt : (dstr(now) === date.value ? now.getTime() : new Date(y, m - 1, dd, 12).getTime());
    const who = String(stl.person || '').trim().replace(/\s+/g, ' ');
    if (st.type === 'EXPENSE' && stl.kind && !who) return fail('Type the name of the person.');
    const rec = { type: st.type, amount: amt, accountLocalId: st.acc, toAccountLocalId: tr ? st.to : null, categoryLocalId: tr ? null : st.cat, note: note.value.trim() || null, occurredAt: when };
    const keepPaid = t && t.settle && t.settle.kind === stl.kind;
    rec.settle = st.type === 'EXPENSE' && stl.kind ? { kind: stl.kind, person: who, paid: keepPaid ? !!t.settle.paid : false, paidAt: keepPaid ? t.settle.paidAt : null } : null;
    save.disabled = true; save.textContent = 'Saving…';
    try {
      await mutate(d => {
        const b = findBook(d, bname); if (!b) throw new Error('This book was not found any more.');
        b.transactions = b.transactions || [];
        if (isEdit) { const i = b.transactions.findIndex(x => x.localId === t.localId); if (i < 0) throw new Error('This entry was deleted on another device. Nothing was changed.'); b.transactions[i] = { ...b.transactions[i], ...rec }; }
        else b.transactions.push({ localId: b.transactions.reduce((mx, x) => Math.max(mx, x.localId || 0), 0) + 1, ...rec });
      });
      try { localStorage.setItem('arthik.lastacc.' + bname, String(st.acc)); } catch {}
      try { if (st.cat != null) localStorage.setItem('arthik.lastcat.' + bname, String(st.cat)); } catch {}
      closeModal(); toast(isEdit ? 'Changes saved ✓' : 'Entry saved ✓'); route();
    } catch (e) { fail(e.message + ' Your entry was NOT saved. You can try again.'); save.disabled = false; save.textContent = isEdit ? 'Save changes' : 'Save entry'; }
  };
  const del = isEdit ? h('button', { type: 'button', class: 'btn danger', onclick: async () => {
    if (!confirm('Delete this entry? You can bring it back from Settings > Recently deleted.')) return;
    del.disabled = true;
    try { await mutate(d => { const b = findBook(d, bname); if (!b) return; const x = (b.transactions || []).find(y => y.localId === t.localId); if (x) { x.isDeleted = true; x.deletedAt = Date.now(); } }); closeModal(); toast('Entry deleted · restore it from Settings'); route(); }
    catch (e) { fail(e.message + ' Nothing was deleted.'); del.disabled = false; }
  } }, 'Delete') : null;
  const paintRcv = () => {
    if (!(isEdit && t.settle && t.settle.kind === 'OWED_TO_ME' && !t.settle.paid)) return;
    rcvBox.replaceChildren(toggleRow('Also record the money received (adds an Income entry)', () => rcv.on, v => { rcv.on = v; paintRcv(); }),
      rcv.on ? h('div', null, h('div', { class: 'flbl' }, 'Received into'), h('div', { class: 'chips' }, accs.filter(a => !a.isArchived).map(a => h('button', { type: 'button', class: 'chip2' + (rcv.acc === a.localId ? ' on' : ''), onclick: () => { rcv.acc = a.localId; paintRcv(); } }, niceName(a.name)))),
        h('div', { class: 'small' }, 'Off by default. If you leave it off, only the tile is marked paid and your balance does not change.')) : null);
  };
  paintRcv();
  const paidBtn = isEdit && t.settle ? h('button', { type: 'button', class: 'btn' + (t.settle.paid ? '' : ' primary') }, t.settle.paid ? 'Mark as not paid' : 'Mark as paid') : null;
  if (paidBtn) paidBtn.onclick = async () => { paidBtn.disabled = true; try { await mutate(d => { const b = findBook(d, bname); const x = b && (b.transactions || []).find(y => y.localId === t.localId); if (!x || !x.settle) throw new Error('This entry was changed on another device.'); if (x.settle.paid) { const r = x.settle.receivedTxId && b.transactions.find(y => y.localId === x.settle.receivedTxId); if (r) { r.isDeleted = true; r.deletedAt = Date.now(); } x.settle = { ...x.settle, paid: false, paidAt: null, receivedTxId: null }; }
        else { let rid = null; if (rcv.on && x.settle.kind === 'OWED_TO_ME') { rid = b.transactions.reduce((mx, y) => Math.max(mx, y.localId || 0), 0) + 1; b.transactions.push({ localId: rid, type: 'INCOME', amount: x.amount, accountLocalId: rcv.acc != null ? rcv.acc : x.accountLocalId, toAccountLocalId: null, categoryLocalId: x.categoryLocalId, note: 'Received from ' + x.settle.person, occurredAt: Date.now() }); } x.settle = { ...x.settle, paid: true, paidAt: Date.now(), receivedTxId: rid }; } }); closeModal(); toast(t.settle.paid ? 'Marked as not paid' : 'Marked as paid ✓ (no new entry made)'); route(); } catch (e) { fail(e.message + ' Nothing was changed.'); paidBtn.disabled = false; } };
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': isEdit ? 'Edit entry' : 'Add entry' },
    h('div', { class: 'sheethead' }, h('h2', null, isEdit ? 'Edit entry' : 'Add entry'), h('button', { class: 'x', 'aria-label': 'Close', onclick: closeModal }, '×')),
    typeBox, h('div', { class: 'flbl' }, 'Amount'), amount, catBox, accBox, toBox, stlBox, rcvBox,
    h('div', { class: 'two' }, h('div', null, h('div', { class: 'flbl' }, 'Date'), date), h('div', null, h('div', { class: 'flbl' }, 'Comment'), note)),
    msg, h('div', { class: 'actions' }, save, paidBtn, del));
  const ov = h('div', { class: 'overlay', onclick: e => { if (e.target === ov) closeModal(); } }, sheet);
  ov.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.querySelector('.overlay.picker')) closeModal(); if (e.key === 'Enter' && e.target.tagName === 'INPUT') save.click(); });
  document.body.append(ov); paint(); setTimeout(() => amount.focus(), 50);
}

// ---------- editing: accounts, categories, budgets ----------
const ACC_TYPES = [['BANK', 'Bank'], ['CASH', 'Cash'], ['CREDIT_CARD', 'Credit card'], ['PLUXEE', 'Pluxee']];
const nextId = list => (list || []).reduce((m, x) => Math.max(m, x.localId || 0), 0) + 1;
// Runs fn(book) on the current Expense book (found again by name after any reload) and saves safely.
const mutateBook = fn => { const name = currentBook().name; return mutate(d => { const b = findBook(d, name); if (!b) throw new Error('This book was not found any more.'); fn(b); }); };
// A simple bottom-sheet form. build(api) returns the body nodes; api.fail(msg), api.busy(btn, label, promiseFn)
function sheetForm(title, build) {
  closeModal();
  const msg = h('div', { class: 'err', hidden: true });
  const api = { fail: m => { msg.textContent = m; msg.hidden = false; }, close: closeModal,
    run: async (btn, label, fn) => { const old = btn.textContent; msg.hidden = true; btn.disabled = true; btn.textContent = label;
      try { await fn(); closeModal(); route(); return true; } catch (e) { api.fail(e.message + ' Nothing was changed.'); btn.disabled = false; btn.textContent = old; return false; } } };
  const body = build(api);
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheethead' }, h('h2', null, title), h('button', { class: 'x', 'aria-label': 'Close', onclick: closeModal }, '×')), body, msg);
  const ov = h('div', { class: 'overlay', onclick: e => { if (e.target === ov) closeModal(); } }, sheet);
  ov.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.querySelector('.overlay.picker')) closeModal(); if (e.key === 'Enter' && e.target.tagName === 'INPUT') { const sv = ov.querySelector('.btn.primary'); if (sv) sv.click(); } });
  document.body.append(ov); setTimeout(() => { const i = ov.querySelector('input[type=text]'); if (i) i.focus(); }, 50);
}
const chipRow = (opts, get, set, colorOf) => { const box = h('div', { class: 'chips' });
  const paint = () => box.replaceChildren(...opts.map(([v, l]) => { const on = get() === v; const col = colorOf ? colorOf(v) : null;
    return h('button', { type: 'button', class: 'chip2' + (on ? ' on' : ''), style: on && col ? { background: col, borderColor: col } : null, onclick: () => { set(v); paint(); } }, col ? h('span', { class: 'sw', style: { background: on ? '#fff' : col } }) : null, l); }));
  paint(); return box; };

function openAccount(a) {
  const book = currentBook(), isEdit = !!a;
  const used = isEdit && ((book.transactions || []).some(t => t.accountLocalId === a.localId || t.toAccountLocalId === a.localId) || (book.recurringRules || []).some(r => r.accountLocalId === a.localId || r.toAccountLocalId === a.localId));
  sheetForm(isEdit ? 'Edit account' : 'Add account', api => {
    const st = { type: a ? a.type : 'BANK', def: a ? !!a.isDefault : !(book.accounts || []).some(x => !x.isArchived) };
    const name = h('input', { type: 'text', value: a ? a.name : '', placeholder: 'e.g. HDFC Savings, Wallet', maxlength: 40, 'aria-label': 'Account name' });
    const defBtn = h('button', { type: 'button', class: 'chip2' }, '');
    const paintDef = () => { defBtn.className = 'chip2' + (st.def ? ' on' : ''); defBtn.textContent = st.def ? '★ Default account' : '☆ Make this the default account'; };
    defBtn.onclick = () => { st.def = !st.def; paintDef(); }; paintDef();
    const save = h('button', { type: 'button', class: 'btn primary big' }, isEdit ? 'Save changes' : 'Add account');
    save.onclick = () => {
      const nm = name.value.trim(); if (!nm) return api.fail('Enter a name for the account.');
      if ((book.accounts || []).some(x => x.localId !== (a && a.localId) && !x.isArchived && x.name.trim().toLowerCase() === nm.toLowerCase())) return api.fail('You already have an account with this name.');
      api.run(save, 'Saving…', () => mutateBook(b => {
        b.accounts = b.accounts || [];
        let acc; if (isEdit) { acc = b.accounts.find(x => x.localId === a.localId); if (!acc) throw new Error('This account was removed on another device.'); }
        else { acc = { localId: nextId(b.accounts), isDefault: false, createdAt: Date.now(), isArchived: false }; b.accounts.push(acc); }
        acc.name = nm; acc.type = st.type;
        if (st.def) { b.accounts.forEach(x => x.isDefault = false); acc.isDefault = true; } else acc.isDefault = false;
        if (!b.accounts.some(x => x.isDefault && !x.isArchived)) { const f = b.accounts.find(x => !x.isArchived); if (f) f.isDefault = true; }
      })).then(ok => ok && toast(isEdit ? 'Account saved ✓' : 'Account added ✓'));
    };
    const extra = [];
    if (isEdit) {
      const arch = h('button', { type: 'button', class: 'btn' }, a.isArchived ? 'Restore' : 'Archive');
      arch.onclick = () => {
        if (!a.isArchived && (book.accounts || []).filter(x => !x.isArchived).length < 2) return api.fail('You need at least one active account.');
        api.run(arch, 'Please wait…', () => mutateBook(b => { const acc = b.accounts.find(x => x.localId === a.localId); if (!acc) return; acc.isArchived = !acc.isArchived; if (acc.isArchived) acc.isDefault = false;
          if (!b.accounts.some(x => x.isDefault && !x.isArchived)) { const f = b.accounts.find(x => !x.isArchived); if (f) f.isDefault = true; } })).then(ok => ok && toast(a.isArchived ? 'Account restored' : 'Account archived'));
      }; extra.push(arch);
      if (!used) { const del = h('button', { type: 'button', class: 'btn danger' }, 'Delete');
        del.onclick = () => { if (!confirm('Delete this account? It has no entries, so nothing else changes.')) return;
          api.run(del, 'Deleting…', () => mutateBook(b => { b.accounts = b.accounts.filter(x => x.localId !== a.localId); if (!b.accounts.some(x => x.isDefault && !x.isArchived)) { const f = b.accounts.find(x => !x.isArchived); if (f) f.isDefault = true; } })).then(ok => ok && toast('Account deleted')); }; extra.push(del); }
    }
    return h('div', null, h('div', { class: 'flbl' }, 'Name'), name, h('div', { class: 'flbl' }, 'Type'), chipRow(ACC_TYPES, () => st.type, v => { st.type = v; }), h('div', { class: 'flbl' }, 'Default'), h('div', { class: 'chips' }, defBtn),
      isEdit && used ? h('p', { class: 'small' }, 'This account has entries, so it can be archived but not deleted. Archived accounts stay in your history.') : null,
      h('div', { class: 'actions' }, save, extra));
  });
}
function openCategory(x) {
  const book = currentBook(), isEdit = !!x, c = computed();
  const used = isEdit && ((book.transactions || []).some(t => t.categoryLocalId === x.localId) || (book.budgets || []).some(t => t.categoryLocalId === x.localId) || (book.recurringRules || []).some(t => t.categoryLocalId === x.localId));
  sheetForm(isEdit ? 'Edit category' : 'Add category', api => {
    const cur = isEdit ? (catColors(c)[x.localId] || PALETTE[0]) : PALETTE[(book.categories || []).length % PALETTE.length];
    const st = { color: cur };
    const name = h('input', { type: 'text', value: x ? x.name : '', placeholder: 'e.g. Groceries, Travel', maxlength: 30, 'aria-label': 'Category name' });
    const sw = h('div', { class: 'swatches' });
    const paintSw = () => sw.replaceChildren(...PALETTE.map(col => h('button', { type: 'button', class: 'swatch' + (st.color === col ? ' on' : ''), style: { background: col }, 'aria-label': 'Colour ' + col, onclick: () => { st.color = col; paintSw(); } })));
    paintSw();
    const save = h('button', { type: 'button', class: 'btn primary big' }, isEdit ? 'Save changes' : 'Add category');
    save.onclick = () => {
      const nm = name.value.trim(); if (!nm) return api.fail('Enter a name for the category.');
      if ((book.categories || []).some(y => y.localId !== (x && x.localId) && !y.isArchived && y.name.trim().toLowerCase() === nm.toLowerCase())) return api.fail('You already have a category with this name.');
      api.run(save, 'Saving…', () => mutateBook(b => {
        b.categories = b.categories || []; let cat;
        if (isEdit) { cat = b.categories.find(y => y.localId === x.localId); if (!cat) throw new Error('This category was removed on another device.'); }
        else { cat = { localId: nextId(b.categories), icon: 'category', isArchived: false }; b.categories.push(cat); }
        cat.name = nm; cat.colorHex = st.color;
      })).then(ok => ok && toast(isEdit ? 'Category saved ✓' : 'Category added ✓'));
    };
    const extra = [];
    if (isEdit) {
      const arch = h('button', { type: 'button', class: 'btn' }, x.isArchived ? 'Restore' : 'Archive');
      arch.onclick = () => api.run(arch, 'Please wait…', () => mutateBook(b => { const cat = b.categories.find(y => y.localId === x.localId); if (cat) cat.isArchived = !cat.isArchived; })).then(ok => ok && toast(x.isArchived ? 'Category restored' : 'Category archived'));
      extra.push(arch);
      if (!used) { const del = h('button', { type: 'button', class: 'btn danger' }, 'Delete');
        del.onclick = () => { if (!confirm('Delete this category? It has no entries or budgets, so nothing else changes.')) return;
          api.run(del, 'Deleting…', () => mutateBook(b => { b.categories = b.categories.filter(y => y.localId !== x.localId); })).then(ok => ok && toast('Category deleted')); }; extra.push(del); }
    }
    return h('div', null, h('div', { class: 'flbl' }, 'Name'), name, h('div', { class: 'flbl' }, 'Colour'), sw,
      isEdit && used ? h('p', { class: 'small' }, 'This category is used by entries or budgets, so it can be archived but not deleted. Archiving hides it from new entries; old entries keep it.') : null,
      h('div', { class: 'actions' }, save, extra));
  });
}
function openBudget(cat, cap) {
  const book = currentBook(), c = computed(), month = utcMonth(monthNow()), isEdit = cap != null;
  const cats = (book.categories || []).filter(x => !x.isArchived);
  const has = id => (book.budgets || []).some(b => b.month === month && b.categoryLocalId === id);
  sheetForm(isEdit ? 'Edit budget' : 'Set a budget', api => {
    const st = { cat: cat ? cat.localId : (cats.find(x => !has(x.localId)) || {}).localId };
    const amt = h('input', { type: 'text', inputmode: 'decimal', class: 'amt', value: isEdit ? String(cap) : '', placeholder: '0', 'aria-label': 'Monthly limit', autocomplete: 'off' });
    const save = h('button', { type: 'button', class: 'btn primary big' }, 'Save budget');
    save.onclick = () => {
      const v = Math.round(parseFloat(String(amt.value).replace(/,/g, '')) * 100) / 100;
      if (st.cat == null) return api.fail('Choose a category.'); if (!(v > 0)) return api.fail('Enter a limit greater than zero.');
      api.run(save, 'Saving…', () => mutateBook(b => { b.budgets = b.budgets || []; const ex = b.budgets.find(y => y.month === month && y.categoryLocalId === st.cat);
        if (ex) ex.capAmount = v; else b.budgets.push({ categoryLocalId: st.cat, month, capAmount: v }); })).then(ok => ok && toast('Budget saved ✓'));
    };
    const extra = [];
    if (isEdit) { const del = h('button', { type: 'button', class: 'btn danger' }, 'Remove budget');
      del.onclick = () => api.run(del, 'Removing…', () => mutateBook(b => { b.budgets = (b.budgets || []).filter(y => !(y.month === month && y.categoryLocalId === cat.localId)); })).then(ok => ok && toast('Budget removed')); extra.push(del); }
    return h('div', null, h('div', { class: 'flbl' }, 'Month'), h('p', { class: 'small', style: { margin: 0 } }, monthLabel(em)),
      isEdit ? h('div', null, h('div', { class: 'flbl' }, 'Category'), h('p', { style: { margin: 0, fontWeight: 600 } }, cat.name)) :
        h('div', null, h('div', { class: 'flbl' }, 'Category'), chipRow(cats.map(x => [x.localId, x.name + (has(x.localId) ? ' (has budget)' : '')]), () => st.cat, v => { st.cat = v; }, v => catColors(c)[v])),
      h('div', { class: 'flbl' }, 'Monthly limit'), amt, h('div', { class: 'actions' }, save, extra));
  });
}

// One table for all budgets of the month: type an amount against each category, leave the rest blank.
function openBudgetTable() {
  const book = currentBook(), c = computed(), month = utcMonth(monthNow());
  const cats = (book.categories || []).filter(x => !x.isArchived);
  const cur = Object.fromEntries((book.budgets || []).filter(b => b.month === month).map(b => [b.categoryLocalId, b.capAmount]));
  sheetForm('Budgets for ' + monthLabel(em), api => {
    const inputs = cats.map(x => ({ x, el: h('input', { type: 'text', inputmode: 'decimal', class: 'bamt', value: cur[x.localId] != null ? String(cur[x.localId]) : '', placeholder: '—', 'aria-label': 'Budget for ' + x.name, autocomplete: 'off' }) }));
    const save = h('button', { type: 'button', class: 'btn primary big' }, 'Save budgets');
    save.onclick = () => {
      const vals = {};
      for (const { x, el } of inputs) { const raw = el.value.trim().replace(/,/g, ''); if (!raw) continue; const v = Math.round(parseFloat(raw) * 100) / 100; if (!(v > 0)) return api.fail('“' + x.name + '”: enter a number above zero, or leave it blank.'); vals[x.localId] = v; }
      api.run(save, 'Saving…', () => mutateBook(b => { b.budgets = (b.budgets || []).filter(y => y.month !== month || !cats.some(x => x.localId === y.categoryLocalId));
        Object.entries(vals).forEach(([id, v]) => b.budgets.push({ categoryLocalId: +id, month, capAmount: v })); })).then(ok => ok && toast('Budgets saved ✓'));
    };
    return h('div', null, h('p', { class: 'small' }, 'Type a monthly limit for each category you want to track. Leave a box blank for no budget (blanking an existing one removes it).'),
      h('div', { class: 'btable' }, inputs.map(({ x, el }) => h('label', { class: 'brow' }, h('span', { class: 'bname' }, h('span', { class: 'sw', style: { background: catColors(c)[x.localId] } }), x.name), h('span', { class: 'bin' }, '₹', el)))),
      h('div', { class: 'actions' }, save));
  });
}
function copyBudgets() {
  const month = utcMonth(monthNow()), prev = utcMonth(new Date(new Date().getFullYear(), new Date().getMonth() + em - 1, 15, 12).getTime());
  return mutateBook(b => { b.budgets = b.budgets || []; (b.budgets.filter(x => x.month === prev)).forEach(x => { if (!b.budgets.some(y => y.month === month && y.categoryLocalId === x.categoryLocalId)) b.budgets.push({ categoryLocalId: x.categoryLocalId, month, capAmount: x.capAmount }); }); });
}

function pageAccounts() {
  const book = currentBook(), c = computed(), all = book.accounts || [], bal = Object.fromEntries(c.accounts.map(a => [a.localId, a.balance]));
  const row = a => h('div', { class: 'item' + (canEdit() ? ' clk' : ''), role: canEdit() ? 'button' : null, tabindex: canEdit() ? 0 : null, onclick: canEdit() ? () => openAccount(a) : null, onkeydown: e => { if (canEdit() && e.key === 'Enter') openAccount(a); } },
    h('div', { class: 'irow' }, h('div', { class: 'iname' }, niceName(a.name), a.isDefault && !a.isArchived ? h('span', { class: 'ttag blue' }, 'Default') : null), a.isArchived ? null : h('div', { class: 'ival' + (bal[a.localId] < 0 ? ' down' : '') }, money(bal[a.localId] || 0))),
    h('div', { class: 'isub' }, sentence(a.type)));
  const act = all.filter(a => !a.isArchived), arch = all.filter(a => a.isArchived);
  return h('div', null, bookHeader('Accounts', book.name), h('a', { href: '#/settings', class: 'link' }, '‹ Settings'),
    canEdit() ? h('button', { class: 'btn primary', style: { margin: '12px 0' }, onclick: () => openAccount(null) }, '+ Add account') : null,
    act.length ? h('div', { class: 'list' }, act.map(row)) : h('section', { class: 'card empty' }, h('p', null, 'No accounts yet.')),
    arch.length ? h('div', null, h('h2', null, 'Archived'), h('div', { class: 'list' }, arch.map(row))) : null);
}
function pageCategories() {
  const book = currentBook(), c = computed(), all = book.categories || [];
  const row = x => h('div', { class: 'item' + (canEdit() ? ' clk' : ''), role: canEdit() ? 'button' : null, tabindex: canEdit() ? 0 : null, onclick: canEdit() ? () => openCategory(x) : null, onkeydown: e => { if (canEdit() && e.key === 'Enter') openCategory(x); } },
    h('div', { class: 'irow' }, h('div', { class: 'iname' }, h('span', { class: 'sw', style: { background: catColors(c)[x.localId] } }), x.name)));
  const act = all.filter(a => !a.isArchived), arch = all.filter(a => a.isArchived);
  return h('div', null, bookHeader('Categories', book.name), h('a', { href: '#/settings', class: 'link' }, '‹ Settings'),
    canEdit() ? h('button', { class: 'btn primary', style: { margin: '12px 0' }, onclick: () => openCategory(null) }, '+ Add category') : null,
    act.length ? h('div', { class: 'list' }, act.map(row)) : h('section', { class: 'card empty' }, h('p', null, 'No categories yet.')),
    arch.length ? h('div', null, h('h2', null, 'Archived'), h('div', { class: 'list' }, arch.map(row))) : null);
}

// ---------- Phase 3: editing Wealth items (FD, RD, PPF, EPF, Bank, Cash) ----------
const F = {  // field helpers
  text: (k, label, o = {}) => ({ k, label, t: 'text', ...o }), num: (k, label, o = {}) => ({ k, label, t: 'num', ...o }),
  pick: (k, label, kind, o = {}) => ({ k, label, t: 'pick', kind, ...o }),
  date: (k, label, o = {}) => ({ k, label, t: 'date', ...o }), chips: (k, label, opts, o = {}) => ({ k, label, t: 'chips', opts, ...o }),
};
const COMPOUND = [['MONTHLY', 'Monthly'], ['QUARTERLY', 'Quarterly'], ['ANNUALLY', 'Yearly'], ['CUMULATIVE', 'At maturity']];
const fdDays = s => ((+s._ty || 0) * 12 + (+s._tm || 0)) * 30.4375 + (+s._td || 0);
const fdAutoWhy = s => s.payoutMode === 'PAYOUT' ? 'interest is paid out regularly, so it works as simple interest.' : (fdDays(s) > 0 && fdDays(s) < 180 ? 'a short FD (under 180 days) normally uses simple interest.' : 'a cumulative FD compounds, usually every quarter.');
function fdAuto(s) { s.interestType = s.payoutMode === 'PAYOUT' || (fdDays(s) > 0 && fdDays(s) < 180) ? 'SIMPLE' : 'COMPOUND'; if (s.interestType === 'COMPOUND' && !['MONTHLY', 'QUARTERLY', 'ANNUALLY', 'CUMULATIVE'].includes(s.compoundingFrequency)) s.compoundingFrequency = 'QUARTERLY'; }
const WSPEC = {
  fd: { auto: fdAuto, arr: 'fixedDeposits', nameKey: 'name', autoName: ['bankName', 'accountOrCertificateNumber'], autoHint: 'the bank name or the account / certificate number', noun: 'FD / NSC', fields: [
      F.chips('kind', 'Type', [['FD', 'Fixed Deposit'], ['NSC', 'NSC']]), F.pick('bankName', 'Bank name', 'bank'), F.text('accountOrCertificateNumber', 'Account / certificate no.', { ph: 'e.g. 5010 or last 4 digits' }),
      F.num('principalAmount', 'Amount invested', { req: 1, min: 0.01, rs: 1 }), F.date('startDate', 'Start date', { req: 1 }), F.num('interestRate', 'Interest rate (% per year)', { req: 1 }),
      { k: 'tenure', label: 'Tenure (fill any: years, months, days)', t: 'tenure' },
      F.chips('payoutMode', 'Interest is', [['CUMULATIVE', 'Added to the deposit (cumulative)'], ['PAYOUT', 'Paid out to you regularly']]),
      F.chips('interestType', 'Interest type', [['COMPOUND', 'Compound'], ['SIMPLE', 'Simple']], { show: s => s.payoutMode !== 'PAYOUT' }),
      { k: '_note', t: 'note', text: s => s._auto ? 'Chosen for you: ' + fdAutoWhy(s) + ' You can change it.' : '' },
      F.chips('compoundingFrequency', 'Compounds', COMPOUND, { show: s => s.interestType === 'COMPOUND' && s.payoutMode !== 'PAYOUT' }),
      F.chips('payoutFrequency', 'Paid out', COMPOUND.slice(0, 3), { show: s => s.payoutMode === 'PAYOUT' }),
      F.chips('autoRenewMode', 'On maturity', [['DISABLED', 'Do nothing'], ['PRINCIPAL_ONLY', 'Renew principal'], ['PRINCIPAL_PLUS_INTEREST', 'Renew with interest']]) ],
    make: () => ({ kind: 'FD', name: '', bankName: '', accountOrCertificateNumber: '', principalAmount: '', startDate: Date.now(), interestRate: '', tenureMonths: '', tenureExtraDays: 0, interestType: 'COMPOUND', compoundingFrequency: 'QUARTERLY', payoutMode: 'CUMULATIVE', payoutFrequency: 'MONTHLY', autoRenewMode: 'DISABLED', lastInterestPayoutAt: null, isArchived: false }) },
  rd: { arr: 'recurringDeposits', nameKey: 'name', autoName: ['bankName', 'accountOrCertificateNumber'], autoHint: 'the bank name or the account number', noun: 'RD', fields: [
      F.pick('bankName', 'Bank name', 'bank'), F.text('accountOrCertificateNumber', 'Account no.'),
      F.num('monthlyInstallment', 'Monthly instalment', { req: 1, min: 0.01, rs: 1 }), F.date('startDate', 'Start date', { req: 1 }), F.num('interestRate', 'Interest rate (% per year)', { req: 1 }),
      F.num('tenureMonths', 'Tenure (months)', { req: 1, int: 1, min: 1 }), F.chips('compoundingFrequency', 'Compounds', COMPOUND.slice(0, 3)),
      F.chips('autoRenewMode', 'On maturity', [['DISABLED', 'Do nothing'], ['PRINCIPAL_ONLY', 'Renew principal'], ['PRINCIPAL_PLUS_INTEREST', 'Renew with interest']]) ],
    entries: { key: 'installments', label: 'Instalments paid', dateKey: 'installmentDate', amtLabel: 'Amount', addLabel: 'Add instalment' },
    make: () => ({ name: '', bankName: '', accountOrCertificateNumber: '', monthlyInstallment: '', startDate: Date.now(), interestRate: '', tenureMonths: '', compoundingFrequency: 'QUARTERLY', autoRenewMode: 'DISABLED', installments: [], isArchived: false }) },
  ppf: { arr: 'ppfAccounts', nameKey: 'name', autoName: ['bankOrPostOfficeName', 'accountNumber'], autoHint: 'the bank / post office name or the account number', noun: 'PPF account', fields: [
      F.pick('bankOrPostOfficeName', 'Bank / post office name', 'bank'), F.text('accountNumber', 'Account no.'), F.date('accountOpenDate', 'Account opened on', { req: 1 }) ],
    entries: { key: 'deposits', label: 'Deposits, interest and withdrawals', dateKey: 'depositDate', amtLabel: 'Amount', addLabel: 'Add entry', typeKey: 'type', types: [['DEPOSIT', 'Deposit'], ['INTEREST', 'Interest credited'], ['DEDUCTION', 'Withdrawal']] },
    make: () => ({ name: '', bankOrPostOfficeName: '', accountNumber: '', accountOpenDate: Date.now(), deposits: [], isArchived: false }) },
  epf: { arr: 'epfAccounts', nameKey: 'name', autoName: ['companyName', 'pfAccountNumber'], autoHint: 'the company name or the PF account number', noun: 'EPF account', fields: [
      F.text('companyName', 'Company name', { ph: 'e.g. Acme Ltd' }), F.text('pfAccountNumber', 'PF account no.'), F.text('uan', 'UAN (optional)'), F.date('accountOpenDate', 'Account opened on', { req: 1 }),
      F.num('monthlyEeContribution', 'Monthly employee + employer amount (optional)', { nullable: 1, rs: 1 }), F.num('monthlyPensionContribution', 'Monthly pension amount (optional)', { nullable: 1, rs: 1 }), F.num('_day', 'Posted on day of month (1-31, optional)', { nullable: 1, int: 1 }) ],
    pre: st => { st._day = st.recurringDepositDate ? String(new Date(st.recurringDepositDate).getDate()) : ''; },
    check: rec => rec._day != null && (rec._day < 1 || rec._day > 31) ? 'The day of month must be between 1 and 31.' : '',
    post: rec => { if (rec._day) { const n = new Date(), d = new Date(n.getFullYear(), n.getMonth(), 1, 12); d.setDate(Math.min(rec._day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); rec.recurringDepositDate = d.getTime(); } else rec.recurringDepositDate = null; delete rec._day; },
    entries: { key: 'contributions', label: 'Contributions', dateKey: 'contributionDate', amtLabel: 'Amount', addLabel: 'Add contribution', typeKey: 'tileType', types: [['EMPLOYEE_EMPLOYER', 'Employee + employer'], ['PENSION', 'Pension']], extra: { isTransfer: false } },
    make: () => ({ name: '', companyName: '', uan: '', pfAccountNumber: '', accountOpenDate: Date.now(), monthlyEeContribution: null, monthlyPensionContribution: null, recurringDepositDate: null, contributions: [], isArchived: false }) },
  bank: { arr: 'bankBalances', nameKey: 'bankName', noun: 'bank balance', fields: [
      F.pick('bankName', 'Bank name', 'bank', { req: 1 }), F.text('accountDetails', 'Account details (optional)', { ph: 'e.g. xx1234' }), F.num('currentBalance', 'Current balance', { req: 1, rs: 1, zero: 1 }) ],
    make: () => ({ bankName: '', accountDetails: '', currentBalance: '', isArchived: false }) },
};

const FREQ3 = [['MONTHLY', 'Monthly'], ['QUARTERLY', 'Quarterly'], ['ANNUALLY', 'Yearly']];
Object.assign(WSPEC, {
  nps: { arr: 'npsAccounts', nameKey: 'name', noun: 'NPS account', fields: [
      F.text('name', 'Name', { req: 1, ph: 'e.g. NPS Tier 1' }), F.text('pran', 'PRAN (optional)'), F.pick('pfm', 'Pension fund manager (optional)', 'pfm'), F.chips('tier', 'Tier', [[1, 'Tier 1'], [2, 'Tier 2']]),
      F.num('currentValue', 'Current value', { req: 1, rs: 1, zero: 1 }), F.num('monthlyContribution', 'Monthly contribution (optional)', { nullable: 1 }), F.num('recurringDayOfMonth', 'Contribution day of month (optional)', { nullable: 1, int: 1 }) ],
    check: rec => rec.recurringDayOfMonth != null && (rec.recurringDayOfMonth < 1 || rec.recurringDayOfMonth > 31) ? 'The day of month must be between 1 and 31.' : '',
    post: (rec, st, src) => { rec.lastUpdatedAt = Date.now(); },
    make: () => ({ name: '', pran: '', pfm: '', tier: 1, currentValue: '', lastUpdatedAt: Date.now(), monthlyContribution: null, recurringDayOfMonth: null, lastContributionDate: null, isArchived: false }) },
  apy: { arr: 'apyAccounts', nameKey: 'name', noun: 'APY account', fields: [
      F.text('name', 'Name', { req: 1, ph: 'e.g. Atal Pension Yojana' }), F.text('pran', 'PRAN (optional)'), F.pick('bankName', 'Bank (optional)', 'bank'), F.text('accountNumber', 'Account no. (optional)'), F.text('ifsc', 'IFSC (optional)'),
      F.num('monthlyContribution', 'Monthly contribution', { req: 1, min: 0.01, rs: 1 }), F.chips('pensionSlab', 'Pension per month', [1000, 2000, 3000, 4000, 5000].map(v => [v, '₹' + v])),
      F.date('startDate', 'Started on', { req: 1 }), F.num('recurringDayOfMonth', 'Contribution day of month (optional)', { nullable: 1, int: 1 }), F.num('totalContributedSoFar', 'Total contributed so far', { req: 1, rs: 1, zero: 1 }) ],
    check: rec => rec.recurringDayOfMonth != null && (rec.recurringDayOfMonth < 1 || rec.recurringDayOfMonth > 31) ? 'The day of month must be between 1 and 31.' : '',
    make: () => ({ name: '', pran: '', bankName: '', accountNumber: '', ifsc: '', monthlyContribution: '', pensionSlab: 1000, startDate: Date.now(), totalContributedSoFar: '', lastContributionDate: null, recurringDayOfMonth: null, isArchived: false }) },
  mf: { arr: 'mutualFunds', nameKey: 'schemeName', noun: 'mutual fund', fields: [
      F.text('schemeName', 'Fund name', { req: 1, ph: 'e.g. Parag Parikh Flexi Cap' }), F.text('fundHouse', 'Fund house (optional)'), F.pick('platformName', 'Platform (optional)', 'platform'), F.text('folioNumber', 'Folio no. (optional)'), F.text('schemeCode', 'AMFI scheme code (optional)'),
      F.num('lastFetchedNav', 'Latest NAV (update it now and then)', { nullable: 1 }),
      F.num('_sipAmt', 'Monthly SIP amount (optional)', { nullable: 1, rs: 1 }), F.date('_sipStart', 'SIP first date', { opt: 1 }), F.chips('_sipHeld', 'SIP status', [['false', 'Running'], ['true', 'Held (paused)']]) ],
    pre: st => { st._sipAmt = st.sip ? String(st.sip.sipAmount) : ''; st._sipStart = st.sip ? st.sip.startDate : null; st._sipHeld = String(!!(st.sip && st.sip.isHeld)); },
    check: rec => rec._sipAmt != null && rec._sipAmt > 0 && !rec._sipStart ? 'Choose the SIP first date (the day of month it is taken).' : '',
    entries: { key: 'entries', label: 'Purchases', inputs: [{ k: 'invested', label: 'Amount invested' }, { k: 'nav', label: 'NAV on that day' }], addLabel: 'Add purchase', typeKey: 'isSip', boolType: 1, types: [['false', 'One-time'], ['true', 'SIP']],
      build: ne => { const inv = +ne.vals.invested, nav = +ne.vals.nav; if (!(inv > 0) || !(nav > 0)) return 'Enter the amount invested and the NAV (both above zero).';
        return { investedAmount: Math.round(inv * 100) / 100, navAtPurchase: nav, unitsAllotted: Math.round(inv / nav * 1000) / 1000, purchaseDate: tsOf(ne.date), isSip: ne.type === 'true' }; },
      dateKey: 'purchaseDate', line: e => `${money(e.investedAmount)} · ${e.unitsAllotted} units @ ${e.navAtPurchase}`, sipKey: 'isSip' },
    post: (rec, st, src) => { const old = src ? src.lastFetchedNav : null; if (rec.lastFetchedNav != null && rec.lastFetchedNav !== old) rec.lastFetchedAt = Date.now(); if (rec.lastFetchedNav == null) rec.lastFetchedAt = null;
      if (rec._sipAmt > 0) rec.sip = { ...((src && src.sip) || {}), sipAmount: rec._sipAmt, startDate: rec._sipStart, isHeld: rec._sipHeld === 'true', lastConfirmedDate: (src && src.sip && src.sip.lastConfirmedDate) || null }; else rec.sip = null; delete rec._sipAmt; delete rec._sipStart; delete rec._sipHeld; },
    make: () => ({ schemeCode: '', schemeName: '', folioNumber: '', fundHouse: '', platformName: '', lastFetchedNav: null, lastFetchedAt: null, entries: [], sip: null, isArchived: false }) },
  demat: { arr: 'dematHoldings', nameKey: 'stockSymbol', noun: 'share holding', fields: [
      F.text('stockSymbol', 'Share / stock symbol', { req: 1, ph: 'e.g. TCS' }), F.chips('exchangeCode', 'Exchange', [['NSE', 'NSE'], ['BSE', 'BSE']]), F.pick('accountName', 'Demat account / broker (optional)', 'broker'),
      F.num('unitsHeld', 'Number of shares', { req: 1, min: 0.0001 }), F.num('avgBuyPrice', 'Average buy price', { req: 1, min: 0.01, rs: 1 }), F.num('lastFetchedPrice', 'Latest price (update it now and then)', { nullable: 1, rs: 1 }) ],
    post: (rec, st, src) => { const old = src ? src.lastFetchedPrice : null; if (rec.lastFetchedPrice != null && rec.lastFetchedPrice !== old) rec.lastFetchedAt = Date.now(); if (rec.lastFetchedPrice == null) rec.lastFetchedAt = null; },
    make: () => ({ accountName: '', stockSymbol: '', exchangeCode: 'NSE', unitsHeld: '', avgBuyPrice: '', lastFetchedPrice: null, lastFetchedAt: null, isArchived: false }) },
  hold: { arr: 'brokerHoldings', nameKey: 'name', idOf: x => (x.name || '') + (x.broker ? ' (' + x.broker + ')' : ''), noun: 'holding', fields: [
      F.pick('broker', 'Broker / platform', 'broker', { req: 1 }), F.pick('accountId', 'Client ID / account (optional)', 'clientid'),
      F.chips('kind', 'Type', KINDS), F.text('name', 'Name or symbol', { req: 1, ph: 'e.g. TCS, NIFTYBEES or Parag Parikh Flexi Cap' }),
      F.chips('plan', 'Plan', [['', 'Not set'], ['Direct', 'Direct'], ['Regular', 'Regular']], { show: s => s.kind === 'MF' }), F.chips('option', 'Option', [['', 'Not set'], ['Growth', 'Growth'], ['IDCW', 'IDCW'], ['Bonus', 'Bonus']], { show: s => s.kind === 'MF' }),
      F.text('isin', 'ISIN (optional)'), F.text('amfi', 'AMFI scheme code (optional)', { show: s => s.kind === 'MF' }), F.text('folio', 'Folio no. (optional)', { show: s => s.kind === 'MF' }),
      F.num('units', 'Quantity / units', { req: 1, min: 0.0001 }), F.num('avgPrice', 'Average buy price per unit', { req: 1, zero: 1, rs: 1 }),
      F.num('price', 'Latest price / NAV (update now and then)', { nullable: 1, rs: 1 }),
      F.num('_sipAmt', 'Monthly SIP amount (optional)', { nullable: 1, rs: 1, show: s => s.kind === 'MF' }), F.date('_sipStart', 'SIP first date (if you set a SIP)', { opt: 1, show: s => s.kind === 'MF' }),
      F.chips('_sipHeld', 'SIP status', [['false', 'Running'], ['true', 'Held (paused)']], { show: s => s.kind === 'MF' }) ],
    pre: st => { st._sipAmt = st.sip ? String(st.sip.sipAmount) : ''; st._sipStart = st.sip ? st.sip.startDate : null; st._sipHeld = String(!!(st.sip && st.sip.isHeld)); },
    check: rec => rec.kind === 'MF' && rec._sipAmt != null && rec._sipAmt > 0 && !rec._sipStart ? 'Choose the SIP first date (the day of month it is taken).' : '',
    post: (rec, st, src) => { if (rec.kind === 'MF' && rec._sipAmt > 0) rec.sip = { ...((src && src.sip) || {}), sipAmount: rec._sipAmt, startDate: rec._sipStart, isHeld: rec._sipHeld === 'true', lastConfirmedDate: (src && src.sip && src.sip.lastConfirmedDate) || null }; else rec.sip = null; delete rec._sipAmt; delete rec._sipStart; delete rec._sipHeld; if (!rec.entries) rec.entries = (src && src.entries) || [];
      const old = src ? src.price : null; if (rec.price != null && rec.price !== old) rec.priceDate = Date.now(); if (rec.price == null) rec.priceDate = null; rec.isin = (rec.isin || '').trim().toUpperCase(); if (rec.kind !== 'MF') { rec.plan = ''; rec.option = ''; rec.amfi = ''; rec.folio = ''; } },
    make: () => ({ uid: newUid(), broker: '', accountId: '', sip: null, entries: [], kind: 'STOCK', plan: '', option: '', amfi: '', folio: '', name: '', isin: '', units: '', avgPrice: '', price: null, priceDate: null, tag: '', isArchived: false }) },
  insurance: { arr: 'insurancePolicies', nameKey: 'policyName', noun: 'insurance policy', fields: [
      F.text('policyName', 'Policy name', { req: 1, ph: 'e.g. HDFC Term Plan' }), F.pick('insurerName', 'Insurance company', 'insurer', { req: 1 }), F.text('policyNumber', 'Policy no. (optional)'),
      F.chips('policyType', 'Type', [['TERM', 'Term'], ['HEALTH', 'Health'], ['ENDOWMENT', 'Endowment'], ['MONEY_BACK', 'Money back'], ['ULIP', 'ULIP']]),
      F.num('sumAssured', 'Sum assured', { req: 1, rs: 1, zero: 1 }), F.num('premiumAmount', 'Premium', { req: 1, rs: 1, zero: 1 }), F.chips('premiumFrequency', 'Paid', FREQ3),
      F.date('startDate', 'Start date (optional)', { opt: 1 }), F.date('nextDueDate', 'Next premium due (optional)', { opt: 1 }), F.date('maturityDate', 'Maturity date (optional)', { opt: 1 }),
      F.chips('hasCashValue', 'Has a cash / surrender value?', [['true', 'Yes'], ['false', 'No']]), F.num('currentSurrenderValue', 'Surrender value now', { rs: 1, zero: 1, show: s => s.hasCashValue === 'true' }) ],
    pre: st => { st.hasCashValue = String(!!st.hasCashValue); },
    post: (rec) => { rec.hasCashValue = rec.hasCashValue === 'true'; if (!rec.hasCashValue) rec.currentSurrenderValue = 0; },
    make: () => ({ policyName: '', policyNumber: '', insurerName: '', policyType: 'TERM', startDate: null, maturityDate: null, sumAssured: '', premiumAmount: '', premiumFrequency: 'ANNUALLY', premiumPaymentTermYears: null, nextDueDate: null, hasCashValue: false, currentSurrenderValue: 0, isArchived: false }) },
  metal: { arr: 'metalHoldings', idOf: x => metalLabel(x), noun: 'gold / silver', fields: [
      F.chips('metalType', 'Metal', [['GOLD', 'Gold'], ['SILVER', 'Silver']]), F.chips('caratType', 'Purity', st => st.metalType === 'SILVER' ? ['999', '925'].map(v => [v, v]) : ['24K', '22K', '18K', '14K'].map(v => [v, v])),
      F.chips('form', 'Form', [['PHYSICAL', 'Physical'], ['DIGITAL', 'Digital']]), F.num('quantityGrams', 'Quantity (grams)', { req: 1, min: 0.001 }), F.num('currentPricePerGram', 'Price per gram now', { nullable: 1, rs: 1 }) ],
    fix: st => { const ok = st.metalType === 'SILVER' ? ['999', '925'] : ['24K', '22K', '18K', '14K']; if (!ok.includes(st.caratType)) st.caratType = ok[st.metalType === 'SILVER' ? 0 : 1]; },
    post: rec => { rec.lastUpdatedAt = Date.now(); },
    make: () => ({ metalType: 'GOLD', caratType: '22K', form: 'PHYSICAL', quantityGrams: '', currentPricePerGram: null, lastUpdatedAt: null, isArchived: false }) },
});

const ASSET_T = [['REAL_ESTATE', 'Real estate'], ['VEHICLE', 'Vehicle'], ['OTHER', 'Other']];
const LIAB_T = [['HOME_LOAN', 'Home loan'], ['CAR_LOAN', 'Car loan'], ['PERSONAL_LOAN', 'Personal loan'], ['OTHER', 'Other']];
const withCur = (list, k) => st => st[k] && !list.some(o => o[0] === st[k]) ? [...list, [st[k], assetLabel(st[k])]] : list;
const loanChanged = (a, b) => ['principal', 'annualInterestRatePercent', 'tenureMonths'].some(k => a[k] !== b[k]) || dstr(a.startDate) !== dstr(b.startDate);
const loanNums = s => ({ p: parseFloat(String(s.principal).replace(/,/g, '')), r: parseFloat(String(s.annualInterestRatePercent).replace(/,/g, '')) || 0, n: parseInt(s.tenureMonths, 10) });
Object.assign(WSPEC, {
  asset: { arr: 'manualAssets', nameKey: 'name', noun: 'asset', fields: [
      F.text('name', 'Name', { req: 1, ph: 'e.g. Flat in Pune, Honda City' }), F.chips('assetType', 'Type', null, { }), F.num('currentValue', 'Current value', { req: 1, rs: 1, zero: 1 }) ],
    post: rec => { rec.lastUpdatedByUserAt = Date.now(); },
    make: () => ({ name: '', assetType: 'REAL_ESTATE', currentValue: '', lastUpdatedByUserAt: Date.now(), isArchived: false }) },
  receivable: { arr: 'wealthReceivables', nameKey: 'personName', noun: 'money owed to you', fields: [
      F.text('personName', 'Who owes you', { req: 1, ph: 'e.g. Rahul' }), F.text('note', 'Note (optional)', { ph: 'e.g. loan, deposit' }), F.num('currentAmount', 'Amount still to receive', { req: 1, rs: 1, zero: 1 }) ],
    post: rec => { rec.lastUpdatedAt = Date.now(); },
    make: () => ({ personName: '', note: '', currentAmount: '', lastUpdatedAt: Date.now(), isArchived: false }) },
  kametti: { arr: 'kamettiAccounts', nameKey: 'name', noun: 'Kametti', fields: [
      F.text('name', 'Name', { req: 1, ph: 'e.g. Kametti A' }), F.num('monthlyAmount', 'Monthly amount', { req: 1, min: 0.01, rs: 1 }), F.num('totalMonths', 'Total months', { req: 1, int: 1, min: 1 }), F.date('startDate', 'Started on', { req: 1 }) ],
    entries: { key: 'entries', label: 'Deposits and payout', dateKey: 'entryDate', amtLabel: 'Amount', addLabel: 'Add entry', typeKey: 'isWon', types: [['false', 'Deposit'], ['true', 'Won (pot received)']],
      build: (ne, st, ents) => {
        if (ne.type === 'true') { const pot = (parseFloat(st.monthlyAmount) || 0) * (parseInt(st.totalMonths, 10) || 0); if (!(pot > 0)) return 'Fill the monthly amount and total months first; the pot is monthly amount x months.';
          if (ents.some(e => e.isWon)) return 'The Won payout is already recorded for this Kametti.'; return { amount: -Math.round(pot * 100) / 100, entryDate: tsOf(ne.date), isWon: true }; }
        const v = Math.round(parseFloat(ne.vals.amt) * 100) / 100; if (!(v > 0)) return 'Enter an amount above zero for the deposit.'; return { amount: v, entryDate: tsOf(ne.date), isWon: false }; } },
    make: () => ({ name: '', monthlyAmount: '', startDate: Date.now(), totalMonths: '', entries: [], isArchived: false }) },
  liability: { arr: 'liabilities', nameKey: 'name', noun: 'liability', fields: [
      F.text('name', 'Name', { req: 1, ph: 'e.g. HDFC credit card' }), F.chips('liabilityType', 'Type', null, {}),
      F.chips('_mode', 'How is it repaid?', [['FULL', 'One payment (no interest)'], ['EMI', 'EMIs with interest']]),
      F.num('outstandingBalance', 'Amount still to pay', { req: 1, rs: 1, zero: 1 }),
      F.date('dueDate', 'Pay by (optional)', { opt: 1, show: s => s._mode === 'FULL' }),
      F.num('principalAmount', 'Original amount', { req: 1, rs: 1, min: 0.01, show: s => s._mode === 'EMI' }), F.num('interestRate', 'Interest rate (% per year)', { show: s => s._mode === 'EMI', zero: 1 }),
      F.num('emiAmount', 'EMI per month', { req: 1, rs: 1, min: 0.01, show: s => s._mode === 'EMI' }), F.num('tenureMonths', 'Tenure (months)', { req: 1, int: 1, min: 1, show: s => s._mode === 'EMI' }),
      F.date('startDate', 'Started on', { req: 1, show: s => s._mode === 'EMI' }) ],
    pre: st => { st._mode = (+st.emiAmount > 0 || +st.tenureMonths > 0 || +st.interestRate > 0) ? 'EMI' : 'FULL'; },
    post: (rec, st, src) => { if (rec._mode === 'FULL') { rec.principalAmount = rec.outstandingBalance; rec.interestRate = 0; rec.tenureMonths = 0; rec.emiAmount = 0; rec.startDate = src ? src.startDate : Date.now(); rec.dueDate = rec.dueDate || null; } else rec.dueDate = null; delete rec._mode; },
    make: () => ({ name: '', liabilityType: 'CREDIT_CARD', principalAmount: '', interestRate: '', tenureMonths: '', emiAmount: '', startDate: Date.now(), outstandingBalance: '', dueDate: null, isArchived: false }) },
  card: { arr: 'liabilities', nameKey: 'name', noun: 'credit card', fields: [
      F.text('name', 'Card name', { req: 1, ph: 'e.g. HDFC credit card' }),
      F.num('outstandingBalance', 'Amount still to pay', { req: 1, rs: 1, zero: 1 }),
      F.date('dueDate', 'Pay by (optional)', { opt: 1 }),
      F.chips('repeatsMonthly', 'Repeats every month?', [['false', 'No (one bill)'], ['true', 'Yes, same day each month']]),
      F.num('repeatMonthsLeft', 'Number of EMIs / months to repeat (optional)', { nullable: 1, int: 1, min: 1, show: s => s.repeatsMonthly === 'true' }),
      { k: '_rnote', t: 'note', text: s => s.repeatsMonthly === 'true' ? 'After you mark a bill paid, the pay-by date moves to the same day next month and you are reminded again. Update the amount when the new bill arrives. With a number, the repeat stops by itself after that many payments; leave it empty to repeat until you stop it.' : '' } ],
    pre: st => { st.repeatsMonthly = String(!!st.repeatsMonthly); },
    check: rec => rec.repeatsMonthly === 'true' && !rec.dueDate ? 'Choose the pay-by date first; the reminder repeats on the same day every month.' : '',
    post: (rec, st, src) => { rec.repeatsMonthly = rec.repeatsMonthly === 'true'; if (!rec.repeatsMonthly || !(rec.repeatMonthsLeft > 0)) rec.repeatMonthsLeft = null; rec.liabilityType = 'CREDIT_CARD'; if (!(+rec.emiAmount > 0)) { rec.principalAmount = rec.outstandingBalance; rec.interestRate = 0; rec.tenureMonths = 0; rec.emiAmount = 0; } rec.startDate = rec.startDate || (src ? src.startDate : Date.now()); rec.dueDate = rec.dueDate || null; },
    make: () => ({ name: '', liabilityType: 'CREDIT_CARD', repeatsMonthly: false, repeatMonthsLeft: null, principalAmount: 0, interestRate: 0, tenureMonths: 0, emiAmount: 0, startDate: Date.now(), outstandingBalance: '', dueDate: null, isArchived: false }) },
  loan: { arr: 'loans', nameKey: 'name', noun: 'loan', fields: [
      F.text('name', 'Name', { req: 1, ph: 'e.g. Home loan' }), F.text('lenderName', 'Lender (optional)', { ph: 'e.g. SBI' }),
      F.pick('lenderName', 'Lender (optional)', 'bank'),
      F.num('principal', 'Loan amount', { req: 1, min: 0.01, rs: 1 }), F.num('annualInterestRatePercent', 'Interest rate (% per year)', { req: 1, zero: 1 }), F.num('tenureMonths', 'Tenure (months)', { req: 1, int: 1, min: 1 }),
      F.date('startDate', 'Loan start date', { req: 1 }),
      { k: '_note', t: 'note', text: s => { const { p, r, n } = loanNums(s); if (!(p > 0) || !(n > 0)) return ''; const e = loanEmi(p, r, n); return 'EMI will be ' + money(e) + ' a month · total interest about ' + money(e * n - p) + '. First EMI is due one month after the start date.'; } } ],
    check: (rec, st, src) => { if (!src) return ''; const ch = loanChanged(rec, src); if (ch && (src.payments || []).some(p => p.isPaid || p.isPrepayment)) return 'The amount, rate, tenure and start date cannot be changed after an EMI is marked paid. You can still change the name and lender, or delete the loan and add it again.'; return ''; },
    post: (rec, st, src) => { const ch = !src || loanChanged(rec, src);
      if (ch) { rec.payments = loanSchedule(rec.principal, rec.annualInterestRatePercent, rec.tenureMonths, rec.startDate); } else rec.payments = st.payments; rec.emiAmount = Math.round(loanEmi(rec.principal, rec.annualInterestRatePercent, rec.tenureMonths)); },
    extra: (st, repaint, api, isEdit) => {
      if (!isEdit || !(st.payments || []).length) return null;
      const pays = st.payments, unpaid = pays.filter(p => !p.isPaid && !p.isPrepayment), paidN = pays.filter(p => p.isPaid).length;
      const showAll = st._all, rows = (showAll ? pays : unpaid.slice(0, 6));
      return h('div', null, h('div', { class: 'flbl' }, `EMIs: ${paidN} of ${pays.length} paid`),
        h('div', { class: 'erows' }, rows.map(p => h('div', { class: 'erow' }, h('span', null, '#' + p.installmentNumber + ' · ' + fmtDate(p.dueDate)), h('b', null, money(p.emiAmount)),
          h('button', { class: 'btn' + (p.isPaid ? ' ghost' : ''), type: 'button', onclick: () => { p.isPaid = !p.isPaid; p.paidDate = p.isPaid ? Date.now() : null; repaint(); } }, p.isPaid ? 'Paid ✓ (undo)' : 'Mark paid')))),
        pays.length > rows.length || showAll ? h('button', { class: 'link', type: 'button', onclick: () => { st._all = !st._all; repaint(); } }, showAll ? 'Show fewer' : 'Show all ' + pays.length + ' EMIs') : null);
    },
    make: () => ({ name: '', lenderName: '', principal: '', annualInterestRatePercent: '', tenureMonths: '', startDate: Date.now(), emiAmount: 0, payments: [], isArchived: false }) },
  goal: { arr: 'goals', nameKey: 'name', noun: 'goal', noNW: 1, fields: [
      F.text('name', 'Goal name', { req: 1, ph: 'e.g. Home down payment' }), F.num('targetAmount', 'Target amount', { req: 1, min: 0.01, rs: 1 }), F.date('targetDate', 'Target date (optional)', { opt: 1 }) ],
    extra: (st, repaint) => {
      const rev = Object.fromEntries(Object.entries(GOAL_MAP).map(([a, b]) => [b, a])); st.linkedAssets = st.linkedAssets || [];
      const has = (t, n) => st.linkedAssets.some(l => l.type === t && l.name === n);
      const groups = computed().cats.filter(c => rev[c.key] && c.items.length);
      return h('div', null, h('div', { class: 'flbl' }, 'Money set aside for this goal (tick what counts)'),
        groups.length ? groups.map(c => h('div', null, h('div', { class: 'small', style: { marginTop: '8px' } }, c.label), c.items.map(i => { const t = rev[c.key], on = has(t, i.name);
          return h('label', { class: 'checkrow' }, h('input', { type: 'checkbox', checked: on, onchange: e => { if (e.target.checked) { if (!has(t, i.name)) st.linkedAssets.push({ type: t, name: i.name }); } else st.linkedAssets = st.linkedAssets.filter(l => !(l.type === t && l.name === i.name)); } }), h('span', null, i.name), h('b', null, money(i.value))); }))) : h('p', { class: 'small' }, 'Add some assets first, then link them here.'));
    },
    post: (rec, st) => { rec.linkedAssets = st.linkedAssets || []; },
    make: () => ({ name: '', targetAmount: '', targetDate: null, linkedAssets: [], isArchived: false }) },
  rent: { arr: 'rentReceivables', nameKey: 'propertyName', noun: 'rented property', noNW: 1, fields: [
      F.text('propertyName', 'Property', { req: 1, ph: 'e.g. Rohini flat' }), F.text('tenantName', 'Tenant name (optional)'), F.text('tenantPhone', 'Tenant phone (optional)'),
      F.num('monthlyRent', 'Monthly rent', { req: 1, min: 0.01, rs: 1 }), F.num('securityDeposit', 'Security deposit', { zero: 1, rs: 1 }), F.date('startDate', 'Tenant moved in on', { req: 1 }),
      F.chips('_link', 'When rent is received, also add it as income to (optional)', () => [['', 'Nowhere'], ...(S.data.books || []).filter(b => b.bookType === 'EXPENSE' && !b.isArchived).flatMap(b => (b.accounts || []).filter(a => !a.isArchived).map(a => [b.name + '||' + a.name, a.name + ' · ' + b.name]))]) ],
    pre: st => { st._link = st.linkedAccount ? st.linkedAccount.bookName + '||' + st.linkedAccount.accountName : ''; },
    post: rec => { const [bn, an] = String(rec._link || '').split('||'); rec.linkedAccount = rec._link && an ? { bookName: bn, accountName: an } : null; delete rec._link; },
    entries: { key: 'payments', label: 'Rent and deposit received', dateKey: 'receivedDate', amtLabel: 'Amount', addLabel: 'Add received', typeKey: 'entryType', types: [['RENT', 'Rent'], ['SECURITY', 'Security deposit']], mode: { opts: [['CASH', 'Cash'], ['TRANSFER', 'Bank transfer'], ['UPI', 'UPI']] },
      build: (ne, st, ents) => { const v = Math.round(parseFloat(ne.vals.amt) * 100) / 100; if (!(v > 0)) return 'Enter the amount received (above zero).'; const t = tsOf(ne.date); let due = t;
        if (ne.type === 'RENT' && typeof st.startDate === 'number') { const pd = rentPending({ startDate: st.startDate, payments: ents }, Date.now()).pending; if (pd.length) due = pd[0]; }
        return { amount: v, paymentMode: ne.mode, dueDate: due, receivedDate: t, entryType: ne.type }; },
      line: e => money(e.amount) + ' · ' + String(e.paymentMode || '').toLowerCase() },
    make: () => ({ propertyName: '', tenantName: '', tenantPhone: '', monthlyRent: '', securityDeposit: 0, startDate: Date.now(), payments: [], isArchived: false }) },
});
WSPEC.asset.fields[1].opts = withCur(ASSET_T, 'assetType'); WSPEC.liability.fields[1].opts = withCur(LIAB_T, 'liabilityType');
WSPEC.loan.fields.splice(1, 1); // keep only the lender picker
const wealthByName = (d, name) => activeBooks(d).find(b => b.name === name && b.bookType === 'WEALTH');
// Today's Net Worth point on the trend is recalculated after every Wealth change (so the Net Worth on/off switch shows up in the history too)
function snapToday(b, d) { const nw = Math.round(computeBook(b, d.rateHistory || []).netWorth * 100) / 100, t0 = new Date().setHours(0, 0, 0, 0), arr = b.netWorthSnapshots = b.netWorthSnapshots || [], x = arr.find(e => e.date >= t0); if (x) x.value = nw; else arr.push({ date: t0, value: nw }); }
const mutateWealth = fn => { const name = currentBook().name; return mutate(d => { const b = wealthByName(d, name); if (!b) throw new Error('This book was not found any more.'); fn(b, d); try { snapToday(b, d); } catch {} }); };
const tsOf = v => { const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d, 12).getTime(); };


// A searchable list of banks. Typing a name that is not in the list offers to add it.
function openBankPicker(cur, names, onPick, kind = 'bank') {
  const lab = KIND_LABEL[kind] || 'item';
  const all = cur && !names.some(n => sameName(n, cur)) ? [cur, ...names] : names;
  const q = h('input', { type: 'text', placeholder: 'Search, or type a new ' + lab + ' name…', 'aria-label': 'Search ' + lab + 's', autocomplete: 'off', autocapitalize: 'words' });
  const list = h('div', { class: 'blist', role: 'listbox' });
  const nice = t => t.replace(/\s+/g, ' ').trim().replace(/\w\S*/g, w => w === w.toLowerCase() || w === w.toUpperCase() && w.length > 4 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w);
  const done = (n, isNew) => { ov.remove(); onPick(n, isNew); };
  const paint = () => {
    const raw = q.value.trim(), t = raw.toLowerCase(), m = all.filter(n => !t || n.toLowerCase().includes(t));
    const rows = m.map(n => h('button', { type: 'button', role: 'option', class: 'bopt' + (sameName(n, cur) ? ' on' : ''), onclick: () => done(n, false) }, n, sameName(n, cur) ? ' ✓' : ''));
    if (raw && !all.some(n => sameName(n, raw))) { const addRow = h('button', { type: 'button', class: 'bopt add', onclick: () => done(kind === 'clientid' ? raw : nice(raw), true) }, '+ Add “' + (kind === 'clientid' ? raw : nice(raw)) + '” as a new ' + lab); if (rows.length) rows.push(addRow); else rows.unshift(addRow); }
    
    list.replaceChildren(...rows);
  };
  q.addEventListener('input', paint);
  q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const f = list.querySelector('.bopt'); if (f) f.click(); } });
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Choose ' + lab },
    h('div', { class: 'sheethead' }, h('h2', null, 'Choose ' + (/^[aeiou]/.test(lab) ? 'an ' : 'a ') + lab), h('button', { class: 'x', type: 'button', 'aria-label': 'Close', onclick: () => ov.remove() }, '×')), q, list);
  const ov = h('div', { class: 'overlay picker', onclick: e => { if (e.target === ov) ov.remove(); } }, sheet);
  document.body.append(ov); paint(); setTimeout(() => q.focus(), 50);
}
function toggleRow(label, get, set) {
  const sw = h('button', { type: 'button', class: 'switch', role: 'switch' }, h('span', { class: 'knob' }));
  const paint = () => { sw.setAttribute('aria-checked', String(!!get())); sw.className = 'switch' + (get() ? ' on' : ''); };
  sw.onclick = () => { set(!get()); paint(); }; paint();
  return h('div', { class: 'switchrow' }, h('span', null, label), sw);
}
function openWealth(key, it, preset) {
  const spec = WSPEC[key], book = currentBook(), isEdit = !!it, src = isEdit ? it.src : null;
  const idOf = spec.idOf || (x => x[spec.nameKey]);
  const arr0 = book[spec.arr] || [], idx0 = isEdit ? arr0.indexOf(src) : -1, origName = isEdit ? idOf(src) : null;
  const st = JSON.parse(JSON.stringify(isEdit ? src : spec.make()));
  if (spec.pre) spec.pre(st);
  if (preset && !isEdit) Object.assign(st, preset);
  st._auto = !isEdit && !!spec.auto;
  if (spec.fields.some(f => f.t === 'tenure')) { const tm = +st.tenureMonths || 0; st._ty = tm ? String(Math.floor(tm / 12) || '') : ''; st._tm = tm % 12 ? String(tm % 12) : ''; st._td = +st.tenureExtraDays ? String(st.tenureExtraDays) : ''; }
  const ds = {}; spec.fields.forEach(f => { if (f.t === 'date') ds[f.k] = st[f.k] ? dstr(st[f.k]) : ''; if (f.t === 'num' && st[f.k] != null) st[f.k] = String(st[f.k]); if (f.t === 'chips' && st[f.k] != null && typeof f.opts !== 'function' && f.opts.some(o => typeof o[0] === 'string') && typeof st[f.k] !== 'string') st[f.k] = String(st[f.k]); });
  const ent = spec.entries, ents = ent ? (st[ent.key] || []) : null; if (ent) st[ent.key] = ents;
  const inputs = ent ? (ent.inputs || [{ k: 'amt', label: ent.amtLabel || 'Amount' }]) : [];
  const ne = { date: dstr(Date.now()), vals: {}, type: ent && ent.types ? ent.types[0][0] : null, mode: ent && ent.mode ? ent.mode.opts[0][0] : null };
  const newPicks = [];
  const gType = key === 'hold' ? null : (Object.entries(GOAL_MAP).find(([, v]) => v === key) || [])[0] || null;
  const canGoal = !!gType || key === 'hold';
  const gl = { sel: '', name: '', target: '' };
  if (isEdit && canGoal) { const t0 = key === 'hold' ? (src.kind === 'MF' ? 'MUTUAL_FUND' : 'DEMAT') : gType, g0 = (book.goals || []).find(g => !g.isArchived && (g.linkedAssets || []).some(l => l.type === t0 && l.name === origName)); if (g0) gl.sel = g0.name; }
  const gl0 = gl.sel;
  sheetForm((isEdit ? 'Edit ' : 'Add ') + spec.noun, api => {
    const fieldsBox = h('div', null), entBox = h('div', null), extraBox = h('div', null);
    const autoOf = o => (spec.autoName || []).map(k => String(o[k] == null ? '' : o[k]).trim()).filter(Boolean).join(' ');
    const prev = h('div', { class: 'small prevname' });
    const updPrev = () => { if (!spec.autoName) return; const n = autoOf(st) || (isEdit ? src.name : ''); prev.textContent = n ? 'Will be saved as: “' + n + '”' : 'The name is made from ' + spec.autoHint + '.'; };
    const renderField = f => {
        let ctl;
        if (f.t === 'note') { const t = f.text(st); return t ? h('div', { class: 'small autonote' }, t) : null; }
        if (f.t === 'chips') { const o = typeof f.opts === 'function' ? f.opts(st) : f.opts; ctl = chipRow(o, () => st[f.k], v => { st[f.k] = v; if (spec.auto) { if (f.k === 'payoutMode') st._auto = true; else if (f.k === 'interestType') st._auto = false; if (st._auto) spec.auto(st); } paint(); }); }
        else if (f.t === 'date') ctl = h('input', { type: 'date', value: ds[f.k], 'aria-label': f.label, oninput: e => { ds[f.k] = e.target.value; } });
        else if (f.t === 'pick') { const btn = h('button', { type: 'button', class: 'pickbtn' }, ''); const paintB = () => { btn.textContent = st[f.k] ? st[f.k] : 'Choose ' + (/^[aeiou]/.test(KIND_LABEL[f.kind]) ? 'an ' : 'a ') + KIND_LABEL[f.kind] + '…'; btn.className = 'pickbtn' + (st[f.k] ? '' : ' empty'); btn.append(h('span', { class: 'chev' }, '▾')); }; paintB();
          btn.onclick = () => openBankPicker(st[f.k], optionList(f.kind, S.data), (n, isNew) => { st[f.k] = n; if (isNew && !newPicks.some(x => x.kind === f.kind && sameName(x.name, n))) newPicks.push({ kind: f.kind, name: n }); paintB(); updPrev(); }, f.kind); ctl = btn; }
        else if (f.t === 'tenure') ctl = h('div', { class: 'ten3' }, [['_ty', 'Years'], ['_tm', 'Months'], ['_td', 'Days']].map(([k, l]) => h('label', { class: 'tenbox' }, h('input', { type: 'text', inputmode: 'numeric', value: st[k] || '', placeholder: '0', 'aria-label': l, autocomplete: 'off', oninput: e => { st[k] = e.target.value.replace(/\D/g, ''); if (spec.auto) { st._auto = true; paint(); } } }), h('span', null, l))));
        else ctl = h('input', { type: 'text', value: st[f.k] == null ? '' : String(st[f.k]), inputmode: f.t === 'num' ? 'decimal' : null, placeholder: f.ph || '', 'aria-label': f.label, autocomplete: 'off', oninput: e => { st[f.k] = e.target.value; updPrev(); refreshNotes(); } });
        return h('div', null, h('div', { class: 'flbl' }, f.label), ctl);
    };
    const wraps = spec.fields.map(() => h('div', null)); fieldsBox.append(...wraps);
    const refreshNotes = () => spec.fields.forEach((f, ix) => { if (f.t === 'note') { const n = renderField(f); wraps[ix].replaceChildren(...(n ? [n] : [])); } });
    const paint = () => {
      if (spec.fix) spec.fix(st);
      if (spec.auto && st._auto) spec.auto(st);
      spec.fields.forEach((f, ix) => {
        const w = wraps[ix]; const vis = !f.show || f.show(st); w.hidden = !vis; if (!vis) return;
        if (!(f.t === 'chips' || f.t === 'note') && w._done) return;
        w._done = true; const node = renderField(f); w.replaceChildren(...(node ? [node] : []));
      });
      if (spec.autoName) { updPrev(); if (!prev.parentNode) { let li = 0; spec.fields.forEach((f, ix) => { if (spec.autoName.includes(f.k)) li = ix; }); wraps[li].after(prev); } }
      if (spec.extra) { const xn = spec.extra(st, paint, api, isEdit); extraBox.replaceChildren(...(xn ? [xn] : [])); }
      if (ent) {
        const sorted = ents.map((e, i) => ({ e, i })).sort((a, b) => b.e[ent.dateKey] - a.e[ent.dateKey]);
        const dIn = h('input', { type: 'date', value: ne.date, 'aria-label': 'Date', oninput: e => { ne.date = e.target.value; } });
        const ins = inputs.map(inp => h('input', { type: 'text', inputmode: 'decimal', placeholder: inp.label, value: ne.vals[inp.k] || '', 'aria-label': inp.label, autocomplete: 'off', oninput: e => { ne.vals[inp.k] = e.target.value.replace(/,/g, ''); } }));
        const add = h('button', { type: 'button', class: 'btn', onclick: () => {
          if (!ne.date) return api.fail('Choose the date of the entry.');
          let row;
          if (ent.build) { row = ent.build(ne, st, ents); if (typeof row === 'string') return api.fail(row); }
          else { const v = Math.round(parseFloat(ne.vals.amt) * 100) / 100; if (!(v > 0)) return api.fail('Enter a date and an amount above zero for the entry.');
            row = { amount: v, [ent.dateKey]: tsOf(ne.date), ...(ent.typeKey ? { [ent.typeKey]: ne.type } : {}), ...(ent.extra || {}), ...(key === 'ppf' ? { note: '' } : {}) }; }
          ents.push(row); ne.vals = {}; api.fail(''); paint(); } }, '+ ' + ent.addLabel);
        const show = e => ent.line ? ent.line(e) : money(e.amount);
        const tname = e => ent.types ? ((ent.types.find(t => t[0] === String(e[ent.typeKey])) || [0, ''])[1]) : '';
        entBox.replaceChildren(h('div', { class: 'flbl' }, ent.label + ' (' + ents.length + ')'),
          ent.types ? chipRow(ent.types, () => ne.type, v => { ne.type = v; }) : null,
          ent.mode ? chipRow(ent.mode.opts, () => ne.mode, v => { ne.mode = v; }) : null,
          h('div', { class: 'two' }, h('div', null, dIn), h('div', { class: 'stack' }, ins)), h('div', { class: 'actions' }, add),
          h('div', { class: 'erows' }, sorted.map(({ e, i }) => h('div', { class: 'erow' }, h('span', null, fmtDate(e[ent.dateKey]), tname(e) ? ' · ' + tname(e) : ''), h('b', null, show(e)),
            h('button', { class: 'x', type: 'button', 'aria-label': 'Remove entry', onclick: () => { ents.splice(i, 1); paint(); } }, '×')))));
      }
    };
    paint();
    const save = h('button', { type: 'button', class: 'btn primary big' }, isEdit ? 'Save changes' : 'Add');
    save.onclick = () => {
      const rec = {};
      if (spec.auto && st._auto) spec.auto(st);
      for (const f of spec.fields.filter(f => !f.show || f.show(st))) {
        if (f.t === 'note') continue;
        if (f.t === 'chips') { rec[f.k] = st[f.k]; continue; }
        if (f.t === 'tenure') { const y = +st._ty || 0, mo = +st._tm || 0, d = +st._td || 0; if (y * 12 + mo + d <= 0) return api.fail('Enter the tenure: years, months and/or days (any one is enough).'); if (y > 50) return api.fail('That tenure looks too long.'); rec.tenureMonths = y * 12 + mo; rec.tenureExtraDays = d; continue; }
        if (f.t === 'date') { if (!ds[f.k]) { if (f.opt) { rec[f.k] = null; continue; } return api.fail('Choose “' + f.label + '”.'); } rec[f.k] = tsOf(ds[f.k]); continue; }
        const raw = String(st[f.k] == null ? '' : st[f.k]).trim().replace(/,/g, '');
        if (f.t === 'text' || f.t === 'pick') { if (f.req && !raw) return api.fail((f.t === 'pick' ? 'Choose ' : 'Enter ') + f.label.toLowerCase() + '.'); rec[f.k] = raw; continue; }
        if (!raw) { if (f.req) return api.fail('Enter ' + f.label.toLowerCase() + '.'); rec[f.k] = f.nullable ? null : (f.def != null ? f.def : 0); continue; }
        const v = parseFloat(raw); if (!isFinite(v)) return api.fail('“' + f.label + '” must be a number.');
        if (f.min != null && v < f.min) return api.fail('“' + f.label + '” must be at least ' + f.min + '.'); if (!f.zero && !f.min && v < 0) return api.fail('“' + f.label + '” cannot be negative.');
        rec[f.k] = f.int ? Math.round(v) : Math.round(v * 10000) / 10000;
      }
      if (rec.interestRate != null && rec.interestRate > 100) return api.fail('The interest rate looks too high.');
      if (ent) rec[ent.key] = ents;
      if (spec.autoName) { const nm = autoOf(rec); if (nm) rec.name = nm; else if (isEdit) rec.name = src.name; else return api.fail('Enter ' + spec.autoHint + '.'); }
      if (spec.auto && rec.interestType == null) rec.interestType = st.interestType;
      if (!spec.noNW) rec.excludeFromNetWorth = !!st.excludeFromNetWorth;
      if (spec.check) { const m = spec.check(rec, st, src, isEdit); if (m) return api.fail(m); }
      if (spec.post) spec.post(rec, st, src);
      if (canGoal && gl.sel === '__new') { if (!gl.name.trim()) return api.fail('Enter the name of the new goal.'); if (!(parseFloat(String(gl.target).replace(/,/g, '')) > 0)) return api.fail('Enter the target amount of the new goal.'); if ((book.goals || []).some(g => !g.isArchived && sameName(g.name, gl.name.trim()))) return api.fail('A goal with that name already exists. Pick it from the list.'); }
      api.run(save, 'Saving…', () => mutateWealth((b, d) => {
        newPicks.forEach(({ kind, name }) => { d.customLists = d.customLists || {}; d.customLists[kind] = d.customLists[kind] || []; if (!optionList(kind, d).some(x => sameName(x, name))) d.customLists[kind].push(name); });
        b[spec.arr] = b[spec.arr] || []; let tgt;
        if (isEdit) { tgt = b[spec.arr][idx0]; if (!tgt || idOf(tgt) !== origName || tgt.isArchived) tgt = b[spec.arr].find(x => idOf(x) === origName && !x.isArchived); if (!tgt) throw new Error('This item was changed or removed on another device.'); }
        else { tgt = spec.make(); b[spec.arr].push(tgt); }
        Object.assign(tgt, rec);
        if (canGoal && (gl.sel !== gl0 || (isEdit && origName !== idOf(tgt)))) {
          const ty = key === 'hold' ? (tgt.kind === 'MF' ? 'MUTUAL_FUND' : 'DEMAT') : gType, nm = key === 'hold' ? tgt.name : idOf(tgt); b.goals = b.goals || [];
          b.goals.forEach(g => { g.linkedAssets = (g.linkedAssets || []).filter(l => !(l.type === ty && (l.name === origName || l.name === nm))); });
          let g = null;
          if (gl.sel === '__new') { g = { name: gl.name.trim(), targetAmount: Math.round(parseFloat(String(gl.target).replace(/,/g, '')) * 100) / 100, targetDate: null, linkedAssets: [], isArchived: false }; b.goals.push(g); }
          else if (gl.sel) g = b.goals.find(x => !x.isArchived && x.name === gl.sel);
          if (g) g.linkedAssets.push({ type: ty, name: nm });
        }
      })).then(ok => ok && toast(isEdit ? 'Saved ✓' : 'Added ✓'));
    };
    const extra = [];
    if (isEdit) { const del = h('button', { type: 'button', class: 'btn danger' }, 'Delete');
      del.onclick = () => { if (!confirm('Delete “' + origName + '”? It leaves your Net Worth, but you can bring it back from Settings > Recently deleted.')) return;
        api.run(del, 'Deleting…', () => mutateWealth(b => { const a = b[spec.arr] || []; let i = a[idx0] && idOf(a[idx0]) === origName && !a[idx0].isArchived ? idx0 : a.findIndex(x => idOf(x) === origName && !x.isArchived); if (i < 0) throw new Error('This item was already removed.'); a[i].isArchived = true; a[i].deletedAt = Date.now(); })).then(ok => ok && toast('Deleted · restore it from Settings')); }; extra.push(del); }
    const goalBox = h('div', null);
    const paintGoal = () => {
      const goals = (book.goals || []).filter(g => !g.isArchived);
      const sel = h('select', { 'aria-label': 'Goal', onchange: e => { gl.sel = e.target.value; paintGoal(); } }, h('option', { value: '' }, 'No goal'),
        goals.map(g => h('option', { value: g.name, selected: gl.sel === g.name }, g.name)), h('option', { value: '__new', selected: gl.sel === '__new' }, '+ New goal…'));
      goalBox.replaceChildren(h('div', { class: 'flbl' }, 'Link to a goal (optional)'), sel,
        gl.sel === '__new' ? h('div', { class: 'two' }, h('input', { type: 'text', placeholder: 'Goal name', value: gl.name, 'aria-label': 'New goal name', autocomplete: 'off', oninput: e => { gl.name = e.target.value; } }),
          h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Target amount', value: gl.target, 'aria-label': 'New goal target', autocomplete: 'off', oninput: e => { gl.target = e.target.value; } })) : null);
    };
    if (canGoal) paintGoal();
    return h('div', null, fieldsBox, extraBox, entBox, canGoal ? goalBox : null, spec.noNW ? null : toggleRow('Count in Net Worth', () => !st.excludeFromNetWorth, v => { st.excludeFromNetWorth = !v; }), h('div', { class: 'actions' }, save, extra));
  });
}
function openCash() {
  const book = currentBook(), st = { amt: String(book.cashInHand || 0), ex: !!book.cashExcludedFromNetWorth };
  sheetForm('Cash in hand', api => {
    const amt = h('input', { type: 'text', inputmode: 'decimal', class: 'amt', value: st.amt, 'aria-label': 'Cash in hand', autocomplete: 'off', oninput: e => { st.amt = e.target.value; } });
    const save = h('button', { type: 'button', class: 'btn primary big' }, 'Save');
    save.onclick = () => { const v = parseFloat(String(st.amt).replace(/,/g, '')); if (!isFinite(v) || v < 0) return api.fail('Enter the cash you have as a number (0 or more).');
      api.run(save, 'Saving…', () => mutateWealth(b => { b.cashInHand = Math.round(v * 100) / 100; if (st.ex) b.cashExcludedFromNetWorth = true; else delete b.cashExcludedFromNetWorth; })).then(ok => ok && toast('Cash updated ✓')); };
    return h('div', null, h('div', { class: 'flbl' }, 'Amount of cash you have'), amt, toggleRow('Count in Net Worth', () => !st.ex, v => { st.ex = !v; }), h('div', { class: 'actions' }, save));
  });
}
// "Owed to me" (I paid for someone) and "I owe" (someone paid for me): tied to the entry, settled with Mark as paid (no new accounting entry)
// an older "money owed to you" row (it has no entry behind it): mark it collected, optionally adding the money received as Income
function openOldOwed(r) {
  const book = currentBook(), bname = book.name, accs = (book.accounts || []).filter(a => !a.isArchived), cats = (book.categories || []).filter(x => !x.isArchived);
  const st = { rec: false, acc: (accs.find(a => a.isDefault) || accs[0] || {}).localId, cat: (cats[0] || {}).localId };
  sheetForm('Money owed to you', api => {
    const box = h('div'), paint = () => box.replaceChildren(
      toggleRow('Also record the money received (adds an Income entry)', () => st.rec, v => { st.rec = v; paint(); }),
      st.rec ? h('div', null, h('div', { class: 'flbl' }, 'Received into'), h('div', { class: 'chips' }, accs.map(a => h('button', { type: 'button', class: 'chip2' + (st.acc === a.localId ? ' on' : ''), onclick: () => { st.acc = a.localId; paint(); } }, niceName(a.name)))),
        h('div', { class: 'flbl' }, 'Category'), h('div', { class: 'chips' }, cats.map(x => h('button', { type: 'button', class: 'chip2' + (st.cat === x.localId ? ' on' : ''), onclick: () => { st.cat = x.localId; paint(); } }, x.name)))) : h('div', { class: 'small' }, 'Off: the row is only marked collected and your balances do not change.'));
    paint();
    return h('div', null, h('div', { class: 'irow' }, h('b', null, r.personName), h('b', null, money(r.amount))), r.note ? h('div', { class: 'isub' }, r.note) : null, h('div', { class: 'isub' }, 'Added ' + fmtDate(r.createdAt)),
      h('div', { class: 'small', style: { margin: '10px 0' } }, 'This is an older entry from before the Owed to me option, so it has no linked entry. New ones are made from an expense entry.'), box,
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary big', onclick: ev => api.run(ev.currentTarget, 'Saving…', () => mutateBook(b => {
        const x = (b.expenseReceivables || []).find(y => !y.isCollected && y.personName === r.personName && y.createdAt === r.createdAt && y.amount === r.amount); if (!x) throw new Error('This row was changed on another device.');
        x.isCollected = true; x.collectedAt = Date.now();
        if (st.rec) { if (st.acc == null || st.cat == null) throw new Error('Choose the account and category.'); b.transactions = b.transactions || [];
          b.transactions.push({ localId: b.transactions.reduce((m, y) => Math.max(m, y.localId || 0), 0) + 1, type: 'INCOME', amount: x.amount, accountLocalId: st.acc, toAccountLocalId: null, categoryLocalId: st.cat, note: 'Received from ' + x.personName, occurredAt: Date.now() }); }
      })).then(ok => ok && toast('Marked collected ✓')) }, 'Mark as collected')));
  });
}
// everything with one person: entries they owe you or you owe them, open and settled, with the running balance
function openPerson(name) {
  const c = computed(), book = currentBook(), mine = (c.txs || []).filter(t => t.settle && sameName(t.settle.person, name)).sort((a, b) => b.occurredAt - a.occurredAt);
  const legacy = (book.expenseReceivables || []).filter(r => sameName(r.personName, name));
  const owedMe = mine.filter(t => !t.settle.paid && t.settle.kind === 'OWED_TO_ME').reduce((a, t) => a + t.amount, 0) + legacy.filter(r => !r.isCollected).reduce((a, r) => a + r.amount, 0);
  const iOwe = mine.filter(t => !t.settle.paid && t.settle.kind === 'I_OWE').reduce((a, t) => a + t.amount, 0), net = owedMe - iOwe;
  sheetForm(name, api => h('div', null,
    h('div', { class: 'okbox' }, net === 0 ? h('b', null, 'All settled with ' + name + '.') : h('b', null, net > 0 ? name + ' owes you ' + money(net) : 'You owe ' + name + ' ' + money(-net)),
      h('div', { class: 'small' }, `Owed to me ${money(owedMe)} · I owe ${money(iOwe)} (open entries only)`)),
    h('div', { class: 'flbl' }, 'All entries (' + (mine.length + legacy.length) + ')'),
    h('div', { class: 'erows' }, mine.map(t => h('div', { class: 'erow clk', role: 'button', tabindex: 0, onclick: () => { api.close(); openEntry(t); } },
      h('span', null, fmtDate(t.occurredAt) + ' · ' + (t.settle.kind === 'I_OWE' ? 'I owe' : 'Owed to me') + (t.note ? ' · ' + t.note : '') + (t.settle.paid ? ' · settled' : '')), h('b', null, money(t.amount)))),
      legacy.map(r => h('div', { class: 'erow' }, h('span', null, fmtDate(r.createdAt) + ' · Owed to me (older entry)' + (r.note ? ' · ' + r.note : '') + (r.isCollected ? ' · collected' : '')), h('b', null, money(r.amount)))))));
}
function settleBox(c) {
  const sum = a => a.reduce((x, t) => x + t.amount, 0), ed = canEdit();
  const tile = (t, kind) => h('div', { class: 'item acc' + (ed ? ' clk' : ''), 'data-deco': 'recv', style: { '--acc': kind === 'I_OWE' ? '#EF4444' : '#22C55E' }, role: ed ? 'button' : null, tabindex: ed ? 0 : null, onclick: ed ? () => openEntry(t) : null, onkeydown: ed ? e => { if (e.key === 'Enter') openEntry(t); } : null },
    h('div', { class: 'irow' }, h('div', { class: 'iname' }, h('button', { type: 'button', class: 'link plink', title: 'See everything with ' + t.settle.person, onclick: e => { e.stopPropagation(); openPerson(t.settle.person); } }, t.settle.person)), h('div', { class: 'ival' }, money(t.amount))),
    h('div', { class: 'isub' }, [(c.cat[t.categoryLocalId] || {}).name, t.note, fmtDate(t.occurredAt)].filter(Boolean).join(' · ')), ed ? h('div', { class: 'iline dim' }, 'Tap to open the entry and mark it paid') : null);
  const blk = (title, list, kind, extra) => list.length || (extra && extra.length) ? h('div', null, h('h2', null, title + ' · ' + money(sum(list) + (extra || []).reduce((x, r) => x + r.amount, 0))), h('div', { class: 'list' }, list.map(t => tile(t, kind)),
    (extra || []).map(r => h('div', { class: 'item' + (ed ? ' clk' : ''), role: ed ? 'button' : null, tabindex: ed ? 0 : null, onclick: ed ? () => openOldOwed(r) : null, onkeydown: ed ? e => { if (e.key === 'Enter') openOldOwed(r); } : null }, h('div', { class: 'irow' }, h('div', { class: 'iname' }, r.personName), h('div', { class: 'ival' }, money(r.amount))), r.note ? h('div', { class: 'isub' }, r.note) : null, ed ? h('div', { class: 'iline dim' }, 'Tap to mark it collected') : null)))) : null;
  return h('div', null, blk('Owed to me', c.owedTx, 'OWED_TO_ME', c.owed), blk('I owe', c.oweTx, 'I_OWE'));
}
function pageExpenseDashboard() {
  const c = computed(), book = currentBook();
  const dn = dueRules(book).length;
  const oldest = c.txs.length ? c.txs[c.txs.length - 1].occurredAt : Date.now(), od = new Date(oldest), nd = new Date();
  const minOff = (od.getFullYear() - nd.getFullYear()) * 12 + od.getMonth() - nd.getMonth();
  const cur = em === 0, ml = monthLabel(em);
  const go = d => h('button', { class: 'mnav', 'aria-label': d < 0 ? 'Previous month' : 'Next month', disabled: d < 0 ? em <= minOff : em >= 0, onclick: () => { em = Math.max(minOff, Math.min(0, em + d)); route(); } }, d < 0 ? '‹' : '›');
  return h('div', null, bookHeader('Home', book.name), backupBanner(), installHint(), dn && canEdit() ? h('a', { class: 'banner', href: '#/recurring' }, h('b', null, dn + ' repeating entr' + (dn > 1 ? 'ies are' : 'y is') + ' due.'), ' Tap to review and record.') : null,
    h('div', { class: 'monthbar' }, go(-1), h('div', { class: 'mlabel' }, ml, cur ? '' : h('button', { class: 'link', onclick: () => { em = 0; route(); } }, 'Back to this month')), go(1)),
    h('div', { class: 'toprow' },
    h('section', { class: 'card hero' }, h('div', { class: 'lbl' }, cur ? 'This month spent' : ml + ' spent'), h('div', { class: 'big' }, money(c.month)),
      h('div', { class: 'hsub' }, cur ? h('span', null, 'Today ', h('b', { class: 'down' }, money(c.today))) : null, h('span', null, (cur ? 'Income this month ' : 'Income '), h('b', { class: 'up' }, money(c.monthIncome))))),
    h('section', { class: 'card' }, h('div', { class: 'lbl' }, cur ? 'Spending by category (this month)' : 'Spending by category (' + ml + ')'),
      !c.topCats.length ? h('p', { class: 'small' }, cur ? 'Nothing spent yet this month.' : 'No spending recorded in ' + ml + '.') : null,
      c.topCats.slice(0, 5).map(x => {
        const pctw = c.month > 0 ? x.spent / c.month * 100 : 0;
        const col = x.cat ? catColors(c)[x.cat.localId] : 'var(--mut)';
        return h('div', { class: 'catrow' }, h('div', { class: 'irow' }, h('span', null, h('span', { class: 'sw', style: { background: col } }), x.cat ? x.cat.name : 'Uncategorised'), h('b', null, money(x.spent))), h('div', { class: 'bar' }, h('span', { style: { width: pctw + '%', background: col } })));
      }), c.topCats.length > 5 ? h('div', { class: 'small' }, '+ ' + (c.topCats.length - 5) + ' more categories · ', h('a', { href: '#/transactions' }, 'see entries')) : null)),
    h('h2', null, 'Accounts'),
    h('div', { class: 'grid' }, c.accounts.map(a => h('div', { class: 'tile' }, h('div', { class: 'tile-top' }, h('span', { class: 'tname' }, niceName(a.name)), accType(a) ? h('span', { class: 'tnote' }, accType(a)) : null),
      h('div', { class: 'tval' + (a.balance < 0 ? ' down' : '') }, money(a.balance)), duePill(a, c)))),
    cur ? settleBox(c) : null,
    h('h2', null, 'Recent entries'),
    h('section', { class: 'card' }, c.txs.slice(0, 10).map(t => txRow(t, c)), c.txs.length ? h('a', { href: '#/transactions', class: 'btn ghost' }, 'See all entries') : h('p', null, canEdit() ? 'No entries yet. Tap the + button to add your first one.' : 'No entries yet.')),
    comingUp(book));
}

const ef = { settle: 'ALL', q: '', type: 'ALL', month: 'ALL', cat: 'ALL', acc: 'ALL', limit: 100 };
function pageEntries() {
  const c = computed();
  const months = [...new Set(c.txs.map(t => { const d = new Date(t.occurredAt); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }))];
  const q = ef.q.trim().toLowerCase();
  const rows = c.txs.filter(t => {
    if (ef.type !== 'ALL' && t.type !== ef.type) return false;
    if (ef.cat !== 'ALL' && String(t.categoryLocalId) !== ef.cat) return false;
    if (ef.acc !== 'ALL' && String(t.accountLocalId) !== ef.acc && String(t.toAccountLocalId) !== ef.acc) return false;
    const d = new Date(t.occurredAt), mk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    if (ef.month !== 'ALL' && mk !== ef.month) return false;
    if (ef.settle !== 'ALL') { const sl = t.settle; if (!sl) return false; if (ef.settle === 'PAID' ? !sl.paid : (sl.paid || sl.kind !== ef.settle)) return false; }
    if (!q) return true;
    const cat = c.cat[t.categoryLocalId], a = c.acc[t.accountLocalId];
    return [t.note, cat && cat.name, a && a.name, String(t.amount), t.settle && t.settle.person].filter(Boolean).join(' ').toLowerCase().includes(q);
  });
  const shown = rows.slice(0, ef.limit);
  const spent = rows.filter(t => t.type === 'EXPENSE').reduce((s, t) => s + t.amount, 0), got = rows.filter(t => t.type === 'INCOME').reduce((s, t) => s + t.amount, 0);
  const search = h('input', { type: 'search', placeholder: 'Search note, category, account, person or amount', value: ef.q, 'aria-label': 'Search entries' });
  search.addEventListener('change', () => { ef.q = search.value; ef.limit = 100; route(); });
  const sel = (opts, cur, set, label) => h('select', { 'aria-label': label, onchange: e => { set(e.target.value); ef.limit = 100; route(); } }, opts.map(([v, l]) => h('option', { value: v, selected: v === cur }, l)));
  const groups = []; shown.forEach(t => { const k = dayLabel(t.occurredAt); const g = groups[groups.length - 1]; if (g && g.k === k) g.rows.push(t); else groups.push({ k, rows: [t] }); });
  return h('div', null, bookHeader('Entries', currentBook().name),
    h('div', { class: 'filters' }, search,
      sel([['ALL', 'All types'], ['EXPENSE', 'Expenses'], ['INCOME', 'Income'], ['TRANSFER', 'Transfers']], ef.type, v => ef.type = v, 'Type'),
      sel([['ALL', 'All categories'], ...(c.catList || Object.values(c.cat)).map(x => [String(x.localId), x.name])], ef.cat, v => ef.cat = v, 'Category'),
      sel([['ALL', 'All accounts'], ...Object.values(c.acc).map(a => [String(a.localId), niceName(a.name) + (accType(a) ? ' (' + accType(a) + ')' : '')])], ef.acc, v => ef.acc = v, 'Account'),
      sel([['ALL', 'Owed / owing: all'], ['OWED_TO_ME', 'Owed to me (open)'], ['I_OWE', 'I owe (open)'], ['PAID', 'Settled']], ef.settle, v => ef.settle = v, 'Owed or owing'),
      sel([['ALL', 'All months'], ...months.map(m => [m, new Date(m + '-15').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })])], ef.month, v => ef.month = v, 'Month')),
    h('div', { class: 'hsub', style: { margin: '10px 0' } }, h('span', null, rows.length + ' entries'), h('span', null, 'Spent ', h('b', { class: 'down' }, money(spent))), h('span', null, 'Income ', h('b', { class: 'up' }, money(got)))),
    h('section', { class: 'card' }, groups.map(g => h('div', null, h('div', { class: 'dayh' }, g.k), g.rows.map(t => txRow(t, c)))), rows.length ? null : h('p', { class: 'empty' }, c.txs.length ? 'No entries match these filters. Try clearing the search or choosing “All”.' : 'No entries yet.')),
    rows.length > shown.length ? h('button', { class: 'btn', onclick: () => { ef.limit += 200; route(); } }, `Show more (${rows.length - shown.length} left)`) : null);
}

function pageBudgets() {
  const c = computed(), book = currentBook(), ml = monthLabel(em), ed = canEdit();
  const mn = h('div', { class: 'monthbar' },
    h('button', { class: 'mnav', 'aria-label': 'Previous month', onclick: () => { em -= 1; route(); } }, '‹'),
    h('div', { class: 'mlabel' }, ml, em ? h('button', { class: 'link', onclick: () => { em = 0; route(); } }, 'Back to this month') : ''),
    h('button', { class: 'mnav', 'aria-label': 'Next month', disabled: em >= 0, onclick: () => { em = Math.min(0, em + 1); route(); } }, '›'));
  const left = (book.categories || []).filter(x => !x.isArchived && !c.budgets.some(b => b.cat && b.cat.localId === x.localId));
  return h('div', null, bookHeader('Budgets', ml), mn,
    ed && (book.categories || []).some(x => !x.isArchived) ? h('button', { class: 'btn primary', style: { margin: '0 0 12px' }, onclick: openBudgetTable }, c.budgets.length ? 'Edit all budgets' : '+ Set budgets') : null,
    c.budgets.length ? h('div', { class: 'list' }, c.budgets.map(b => { const p = b.cap > 0 ? b.spent / b.cap * 100 : 0;
      return h('div', { class: 'item' + (ed ? ' clk' : ''), role: ed ? 'button' : null, tabindex: ed ? 0 : null, onclick: ed && b.cat ? () => openBudget(b.cat, b.cap) : null, onkeydown: e => { if (ed && b.cat && e.key === 'Enter') openBudget(b.cat, b.cap); } },
        h('div', { class: 'irow' }, h('div', { class: 'iname' }, b.cat ? b.cat.name : 'Category'), h('div', { class: 'ival ' + (p > 100 ? 'down' : '') }, Math.round(p) + '%')),
        h('div', { class: 'bar' + (p > 100 ? ' over' : ''), role: 'progressbar', 'aria-valuenow': Math.round(p), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span', { style: { width: Math.min(100, p) + '%', background: p > 100 ? null : (b.cat ? catColors(c)[b.cat.localId] : null) } })),
        h('div', { class: 'iline' }, `${money(b.spent)} of ${money(b.cap)}` + (b.spent > b.cap ? ` · over by ${money(b.spent - b.cap)}` : ` · ${money(b.cap - b.spent)} left`))); }))
      : h('section', { class: 'card empty' }, h('p', null, 'No budgets set for ' + ml + '.'),
          ed ? h('div', { class: 'row', style: { justifyContent: 'center' } }, h('button', { class: 'btn', onclick: () => { toast('Copying…'); copyBudgets().then(() => { toast('Budgets copied from last month ✓'); route(); }).catch(e => toast(e.message, true)); } }, 'Copy last month’s budgets'), (book.categories || []).some(x => !x.isArchived) ? h('button', { class: 'btn primary', onclick: openBudgetTable }, '+ Set budgets') : null) : null));
}

function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(text instanceof Blob ? text : new Blob([text], { type: 'application/json' })), download: name }); document.body.append(a); a.click(); a.remove();
}

// ---------- Recurring rules (Expense book): list, edit, and the "due now" popup ----------
const FREQS = [['DAILY', 'Daily'], ['WEEKLY', 'Weekly'], ['MONTHLY', 'Monthly'], ['YEARLY', 'Yearly']];
const SNOOZES = [['2h', '2 hours', 2 * 3600e3], ['8h', '8 hours', 8 * 3600e3], ['1d', '1 day', 86400e3], ['3d', '3 days', 3 * 86400e3], ['1w', '1 week', 7 * 86400e3]];
function addMonthsClamp(ts, m) { const d = new Date(ts), day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + m); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); return d.getTime(); }
function stepRule(r) { const n = Math.max(1, +r.interval || 1), t = r.nextRunAt;
  if (r.frequency === 'DAILY') return t + n * 86400000 + (new Date(t).getTimezoneOffset() - new Date(t + n * 86400000).getTimezoneOffset()) * 60000;
  if (r.frequency === 'WEEKLY') return stepRule({ ...r, frequency: 'DAILY', interval: 7 * n });
  return addMonthsClamp(t, r.frequency === 'YEARLY' ? 12 * n : n); }
const ruleLabel = r => { const n = +r.interval || 1, u = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[r.frequency] || 'month'; return n === 1 ? 'Every ' + u : 'Every ' + n + ' ' + u + 's'; };
const liveRules = b => (b.recurringRules || []).filter(r => !r.isDeleted);
const isDue = (r, now = Date.now()) => !r.isPaused && !r.isDeleted && r.nextRunAt <= now && (!r.endDate || r.nextRunAt <= r.endDate);
const sameRule = (a, b) => a.localId != null && b.localId != null ? a.localId === b.localId : (a.name === b.name && a.startDate === b.startDate);
const snoozeKey = (bn, r) => bn + '|' + (r.localId != null ? r.localId : r.name + '|' + r.startDate);
const snoozes = () => { try { return JSON.parse(localStorage.getItem('arthik.snooze') || '{}'); } catch { return {}; } };
const setSnooze = (keys, ms) => { try { const s = snoozes(), now = Date.now(); Object.keys(s).forEach(k => { if (s[k] < now) delete s[k]; }); keys.forEach(k => { s[k] = now + ms; }); localStorage.setItem('arthik.snooze', JSON.stringify(s)); } catch {} };
const dueSeen = new Set();
function dueRules(book) { const sn = snoozes(), now = Date.now(); return liveRules(book).filter(r => isDue(r, now) && !(sn[snoozeKey(book.name, r)] > now)).sort((a, b) => a.nextRunAt - b.nextRunAt); }
function recordRule(rule, all) {  // posts one entry (or every missed one) and moves the rule on
  const bname = currentBook().name, expect = rule.nextRunAt; let count = 0;
  return mutateBook(b => { b.transactions = b.transactions || [];
    const r = (b.recurringRules || []).find(x => sameRule(x, rule)); if (!r || r.isDeleted) throw new Error('This rule was removed on another device.'); if (r.nextRunAt !== expect) throw new Error('This one was already recorded on another device.');
    const now = Date.now(); count = 0;
    do { b.transactions.push({ localId: nextId(b.transactions), type: r.type, amount: r.amount, accountLocalId: r.accountLocalId, toAccountLocalId: r.type === 'TRANSFER' ? r.toAccountLocalId : null, categoryLocalId: r.type === 'TRANSFER' ? null : (r.categoryLocalId == null ? null : r.categoryLocalId), note: r.note || r.name, occurredAt: r.nextRunAt });
      r.nextRunAt = stepRule(r); count++; } while (all && count < 400 && isDue(r, now));
  }).then(() => count);
}
function showDue() {
  const book = currentBook(); if (!book || book.bookType !== 'EXPENSE' || !canEdit()) return;
  const list = dueRules(book); if (!list.length) { closeModal(); return; }
  const acc = Object.fromEntries((book.accounts || []).map(a => [a.localId, a.name])), now = Date.now();
  const occ = r => { let n = 0, t = { ...r }; while (isDue(t, now) && n < 400) { n++; t.nextRunAt = stepRule(t); } return n; };
  const total = list.reduce((a, r) => a + occ(r), 0);
  sheetForm('Due now', api => {
    let sn = '1d'; const sel = h('select', { 'aria-label': 'Remind me again in', onchange: e => { sn = e.target.value; } }, SNOOZES.map(([v, l]) => h('option', { value: v, selected: v === sn }, l)));
    const again = () => { route(); showDue(); };
    const rows = list.map(r => { const btn = h('button', { type: 'button', class: 'btn primary' }, 'Record');
      btn.onclick = () => { btn.disabled = true; btn.textContent = '…'; recordRule(r, false).then(() => { toast('Recorded ✓'); again(); }).catch(e => { api.fail(e.message + ' Nothing was changed.'); btn.disabled = false; btn.textContent = 'Record'; }); };
      const n = occ(r);
      return h('div', { class: 'item' }, h('div', { class: 'irow' }, h('div', { class: 'iname' }, r.name), h('div', { class: 'ival ' + (TYPE[r.type] || {}).cls }, money(r.amount))),
        h('div', { class: 'isub' }, (TYPE[r.type] ? TYPE[r.type].label : r.type) + ' · due ' + fmtDate(r.nextRunAt) + (acc[r.accountLocalId] ? ' · ' + niceName(acc[r.accountLocalId]) : '') + (n > 1 ? ' · ' + n + ' missed' : '')), h('div', { class: 'actions' }, btn)); });
    const all = h('button', { type: 'button', class: 'btn' }, 'Record all (' + total + ')');
    all.onclick = async () => { all.disabled = true; all.textContent = 'Recording…'; try { for (const r of list) await recordRule(r, true); toast('All recorded ✓'); closeModal(); route(); } catch (e) { api.fail(e.message + ' Some may already be recorded; check Entries.'); all.disabled = false; all.textContent = 'Record all (' + total + ')'; route(); showDue(); } };
    const later = h('button', { type: 'button', class: 'btn ghost' }, 'Later');
    later.onclick = () => { setSnooze(list.map(r => snoozeKey(book.name, r)), SNOOZES.find(x => x[0] === sn)[2]); closeModal(); toast('Okay, I will remind you again'); };
    return h('div', null, h('p', { class: 'small' }, 'These repeating entries are due. Nothing is added until you tap Record.'), h('div', { class: 'list' }, rows), h('div', { class: 'actions' }, all),
      h('div', { class: 'flbl' }, 'Not now? Remind me again in'), h('div', { class: 'row' }, sel, later));
  });
}
function pageRecurring() {
  const book = currentBook(), rules = liveRules(book).sort((a, b) => (a.isPaused ? 1 : 0) - (b.isPaused ? 1 : 0) || a.nextRunAt - b.nextRunAt), ed = canEdit();
  const acc = Object.fromEntries((book.accounts || []).map(a => [a.localId, a.name]));
  return h('div', null, bookHeader('Recurring', 'Repeating entries'),
    h('p', { class: 'small' }, 'Rules like rent, Netflix or a card bill. When one falls due, a pop-up asks you to record it. Nothing is added by itself.'),
    ed ? h('button', { class: 'btn primary', style: { margin: '0 0 12px' }, onclick: () => openRule(null) }, '+ New rule') : null,
    rules.length ? h('div', { class: 'list' }, rules.map(r => { const ty = TYPE[r.type] || TYPE.EXPENSE, due = isDue(r);
      return h('div', { class: 'item' + (ed ? ' clk' : '') + (r.isPaused ? ' paused' : ''), role: ed ? 'button' : null, tabindex: ed ? 0 : null, onclick: ed ? () => openRule(r) : null, onkeydown: ed ? e => { if (e.key === 'Enter') openRule(r); } : null },
        h('div', { class: 'irow' }, h('div', { class: 'iname' }, r.name, r.isPaused ? h('span', { class: 'ttag' }, 'Paused') : due ? h('span', { class: 'ttag down' }, 'Due') : null), h('div', { class: 'ival ' + ty.cls }, ty.sign + money(r.amount))),
        h('div', { class: 'isub' }, ty.label + ' · ' + ruleLabel(r) + (acc[r.accountLocalId] ? ' · ' + niceName(acc[r.accountLocalId]) : '')),
        h('div', { class: 'iline' }, (r.isPaused ? 'Next would be ' : 'Next: ') + fmtDate(r.nextRunAt) + (r.endDate ? ' · ends ' + fmtDate(r.endDate) : ''))); }))
      : h('p', { class: 'empty' }, ed ? 'No recurring rules yet. Use “+ New rule”.' : 'No recurring rules yet.'));
}
function openRule(r) {
  const book = currentBook(), isEdit = !!r, c = computed();
  const accs = (book.accounts || []).filter(a => !a.isArchived || (r && (r.accountLocalId === a.localId || r.toAccountLocalId === a.localId)));
  const cats = (book.categories || []).filter(x => !x.isArchived || (r && r.categoryLocalId === x.localId));
  const st = r ? { ...r } : { type: 'EXPENSE', name: '', amount: '', accountLocalId: (accs.find(a => a.isDefault) || accs[0] || {}).localId, toAccountLocalId: null, categoryLocalId: null, note: '', frequency: 'MONTHLY', interval: 1, isPaused: false };
  let nextD = dstr(r ? r.nextRunAt : Date.now()), endD = r && r.endDate ? dstr(r.endDate) : '';
  sheetForm(isEdit ? 'Edit rule' : 'New recurring rule', api => {
    const dyn = h('div', null);
    const paint = () => { const tr = st.type === 'TRANSFER';
      dyn.replaceChildren(
        h('div', { class: 'flbl' }, tr ? 'From account' : 'Account'), chipRow(accs.map(a => [a.localId, niceName(a.name)]), () => st.accountLocalId, v => { st.accountLocalId = v; if (st.toAccountLocalId === v) st.toAccountLocalId = null; paint(); }),
        tr ? h('div', { class: 'flbl' }, 'To account') : null, tr ? chipRow(accs.filter(a => a.localId !== st.accountLocalId).map(a => [a.localId, niceName(a.name)]), () => st.toAccountLocalId, v => { st.toAccountLocalId = v; }) : null,
        !tr ? h('div', { class: 'flbl' }, 'Category (optional)') : null, !tr ? chipRow([[null, 'None'], ...cats.map(x => [x.localId, x.name])], () => st.categoryLocalId, v => { st.categoryLocalId = v; }, v => v == null ? null : catColors(c)[v]) : null); };
    const mk = (label, key, ph, mode) => h('input', { type: 'text', inputmode: mode || null, value: st[key] == null ? '' : String(st[key]), placeholder: ph || '', 'aria-label': label, autocomplete: 'off', oninput: e => { st[key] = e.target.value; } });
    const seg = h('div', { class: 'seg' }); const paintSeg = () => seg.replaceChildren(...[['EXPENSE', 'Expense'], ['INCOME', 'Income'], ['TRANSFER', 'Transfer']].map(([k, l]) => h('button', { type: 'button', class: 'segb ' + TYPE[k].cls + (st.type === k ? ' on' : ''), onclick: () => { st.type = k; paintSeg(); paint(); } }, l)));
    paintSeg(); paint();
    const save = h('button', { type: 'button', class: 'btn primary big' }, isEdit ? 'Save changes' : 'Add rule');
    save.onclick = () => {
      const name = String(st.name || '').trim(), amt = Math.round(parseFloat(String(st.amount).replace(/,/g, '')) * 100) / 100, iv = parseInt(st.interval, 10), tr = st.type === 'TRANSFER';
      if (!name) return api.fail('Enter a name, like Netflix or Rent.'); if (!(amt > 0)) return api.fail('Enter an amount above zero.'); if (st.accountLocalId == null) return api.fail('Choose an account.');
      if (tr && (st.toAccountLocalId == null || st.toAccountLocalId === st.accountLocalId)) return api.fail('Choose a different account to transfer to.');
      if (!(iv >= 1 && iv <= 365)) return api.fail('“Repeat every” must be 1 or more.'); if (!nextD) return api.fail('Choose the ' + (isEdit ? 'next' : 'first') + ' date.');
      const next = tsOf(nextD), end = endD ? tsOf(endD) : null; if (end && end < next) return api.fail('The end date is before the next date.');
      const rec = { name, type: st.type, amount: amt, accountLocalId: st.accountLocalId, toAccountLocalId: tr ? st.toAccountLocalId : null, categoryLocalId: tr ? null : st.categoryLocalId, note: String(st.note || '').trim() || null, frequency: st.frequency, interval: iv, endDate: end, nextRunAt: next, isPaused: !!st.isPaused };
      api.run(save, 'Saving…', () => mutateBook(b => { b.recurringRules = b.recurringRules || [];
        if (isEdit) { const t = b.recurringRules.find(x => sameRule(x, r)); if (!t) throw new Error('This rule was removed on another device.'); Object.assign(t, rec); if (t.localId == null) t.localId = nextId(b.recurringRules); }
        else b.recurringRules.push({ localId: nextId(b.recurringRules), ...rec, startDate: next }); })).then(ok => ok && toast(isEdit ? 'Saved ✓' : 'Rule added ✓'));
    };
    const extra = [];
    if (isEdit) { const del = h('button', { type: 'button', class: 'btn danger' }, 'Delete');
      del.onclick = () => { if (!confirm('Delete “' + r.name + '”? Entries it already made stay. You can bring the rule back from Settings > Recently deleted.')) return;
        api.run(del, 'Deleting…', () => mutateBook(b => { const t = (b.recurringRules || []).find(x => sameRule(x, r)); if (!t) throw new Error('This rule was already removed.'); t.isDeleted = true; t.deletedAt = Date.now(); })).then(ok => ok && toast('Deleted · restore it from Settings')); }; extra.push(del); }
    return h('div', null, seg, h('div', { class: 'flbl' }, 'Name'), mk('Name', 'name', 'e.g. Netflix, Rent'), h('div', { class: 'flbl' }, 'Amount'), mk('Amount', 'amount', '0', 'decimal'), dyn,
      h('div', { class: 'flbl' }, 'Note (optional)'), mk('Note', 'note'), h('div', { class: 'flbl' }, 'Repeats'), chipRow(FREQS, () => st.frequency, v => { st.frequency = v; }),
      h('div', { class: 'flbl' }, 'Repeat every (number)'), mk('Repeat every', 'interval', '1', 'numeric'),
      h('div', { class: 'flbl' }, isEdit ? 'Next date' : 'First date'), h('input', { type: 'date', value: nextD, 'aria-label': 'Next date', oninput: e => { nextD = e.target.value; } }),
      h('div', { class: 'flbl' }, 'Ends on (optional)'), h('input', { type: 'date', value: endD, 'aria-label': 'End date', oninput: e => { endD = e.target.value; } }),
      isEdit ? toggleRow('Active (turn off to pause)', () => !st.isPaused, v => { st.isPaused = !v; }) : null, h('div', { class: 'actions' }, save, extra));
  });
}


// ---------- Wealth: repeating items (RD, EPF, APY, NPS, SIP, Kametti, Rent) ----------
const rKey = it => it.arr === 'brokerHoldings' ? 'hold' : R_KEY[it.type] === 'liability' && isCard({ src: it.ref }) ? 'card' : R_KEY[it.type];
const R_KEY = { FDMAT: 'fd', RDMAT: 'rd', PPF: 'ppf', LIAB: 'liability', INS: 'insurance', RD: 'rd', EPF_EE: 'epf', EPF_PEN: 'epf', APY: 'apy', NPS: 'nps', SIP: 'mf', KAMETTI: 'kametti', RENT: 'rent' };
const wKey = (bn, it) => bn + '|W|' + it.type + '|' + it.id;
const wDue = (book, ignoreSnooze) => { const sn = snoozes(), now = Date.now(); return allDue(book, now, S.data.rateHistory || []).filter(i => ignoreSnooze || !(sn[wKey(book.name, i)] > now)); };
function wDueBanner(book) { const n = wDue(book, true).length; return n ? h('a', { class: 'banner', href: '#/recurring' }, h('b', null, n + ' repeating item' + (n > 1 ? 's are' : ' is') + ' due.'), ' Tap to review and record.') : null; }
function showWealthDue(ignoreSnooze) {
  const book = currentBook(); if (!book || book.bookType !== 'WEALTH' || !canEdit()) return;
  const list = wDue(book, ignoreSnooze === true); if (!list.length) { closeModal(); return; }
  sheetForm('Due now', api => {
    let sn = '1d'; const sel = h('select', { 'aria-label': 'Remind me again in', onchange: e => { sn = e.target.value; } }, SNOOZES.map(([v, l]) => h('option', { value: v, selected: v === sn }, l)));
    const run = (btn, label, fn) => { btn.disabled = true; const old = btn.textContent; btn.textContent = '…'; fn().then(() => { toast(label); route(); showWealthDue(ignoreSnooze); }).catch(e => { api.fail(e.message + ' Nothing was changed.'); btn.disabled = false; btn.textContent = old; }); };
    const rows = list.map(it => {
      const st = { amt: String(it.amount), nav: (it.ref.lastFetchedNav ?? it.ref.price) != null && (it.ref.lastFetchedNav ?? it.ref.price) !== 0 ? String(it.ref.lastFetchedNav ?? it.ref.price) : '', mode: 'TRANSFER', rate: String(it.rate ?? ''), months: String(it.tenure ?? ''), start: dstr(it.due) };
      const inp = (label, key, mode) => h('input', { type: 'text', inputmode: mode || 'decimal', value: st[key], 'aria-label': label + ' for ' + it.name, autocomplete: 'off', oninput: e => { st[key] = e.target.value.replace(/,/g, ''); } });
      const fl = (label, ctl) => h('div', null, h('div', { class: 'flbl' }, label), ctl);
      const head = [h('div', { class: 'irow' }, h('div', { class: 'iname' }, it.name), h('div', { class: 'ival' }, it.type === 'LIAB' || it.type === 'INS' || it.type === 'PPF' || it.type === 'FDMAT' || it.type === 'RDMAT' ? money(it.amount) : money(it.amount))),
        h('div', { class: 'isub' }, RTYPES[it.type] + ' · ' + (it.type === 'FDMAT' || it.type === 'RDMAT' ? 'matured ' : it.type === 'PPF' ? 'year ended ' : 'due ') + fmtDate(it.type === 'PPF' ? it.due - 1 : it.due) + (it.pend > 1 ? ' · ' + it.pend + ' pending' : ''))];
      const btn = h('button', { type: 'button', class: 'btn primary' }, 'Record'), body = [];
      if (it.type === 'FDMAT' || it.type === 'RDMAT') {
        btn.textContent = 'Renew'; const no = h('button', { type: 'button', class: 'btn ghost' }, 'Don’t renew');
        body.push(h('p', { class: 'small' }, 'Matured value ' + money(it.mv) + '. Check the new terms, then renew. The old one is closed.'),
          h('div', { class: 'two' }, fl(it.type === 'RDMAT' ? 'New monthly instalment' : 'New amount', inp('Amount', 'amt')), fl('Rate % per year', inp('Rate', 'rate'))),
          h('div', { class: 'two' }, fl('Tenure (months)', inp('Months', 'months', 'numeric')), fl('Starts on', h('input', { type: 'date', value: st.start, 'aria-label': 'Start date', oninput: e => { st.start = e.target.value; } }))),
          h('div', { class: 'actions' }, btn, no));
        btn.onclick = () => run(btn, 'Renewed ✓', () => mutateWealth((b, d) => confirmInBook(b, it, { amount: st.amt, rate: st.rate, months: st.months, start: tsOf(st.start) }, Date.now(), d)));
        no.onclick = () => run(no, 'Okay, not renewing', () => mutateWealth(b => declineInBook(b, it)));
      } else if (it.type === 'LIAB' || it.type === 'INS') {
        btn.textContent = it.type === 'LIAB' ? 'Mark paid' : 'Premium paid';
        body.push(h('div', { class: 'actions' }, btn)); btn.onclick = () => run(btn, 'Done ✓', () => mutateWealth((b, d) => confirmInBook(b, it, { amount: it.amount }, Date.now(), d)));
      } else {
        btn.textContent = it.type === 'RENT' ? 'Received' : it.type === 'PPF' ? 'Add interest' : 'Record';
        const nav = it.needsNav ? fl('NAV', inp('NAV', 'nav')) : null;
        const mode = it.type === 'RENT' ? fl('Paid by', h('select', { 'aria-label': 'How was it paid', onchange: e => { st.mode = e.target.value; } }, [['CASH', 'Cash'], ['TRANSFER', 'Bank transfer'], ['UPI', 'UPI']].map(([v, l]) => h('option', { value: v, selected: v === st.mode }, l)))) : null;
        body.push(h('div', { class: 'two' }, fl(it.type === 'RENT' ? 'Rent received' : it.type === 'PPF' ? 'Interest credited' : 'Amount', inp('Amount', 'amt')), nav || mode || h('div')), h('div', { class: 'actions' }, btn));
        btn.onclick = () => run(btn, 'Recorded ✓', () => mutateWealth((b, d) => confirmInBook(b, it, { amount: st.amt, nav: st.nav, mode: st.mode }, Date.now(), d)));
      }
      return h('div', { class: 'item' }, ...head, ...body); });
    const later = h('button', { type: 'button', class: 'btn ghost' }, 'Later');
    later.onclick = () => { setSnooze(list.map(i => wKey(book.name, i)), SNOOZES.find(x => x[0] === sn)[2]); closeModal(); toast('Okay, I will remind you again'); route(); };
    return h('div', null, h('p', { class: 'small' }, 'These are due. Check the amount, then record. Nothing is added until you tap.'), h('div', { class: 'list' }, rows),
      h('div', { class: 'flbl' }, 'Not now? Remind me again in'), h('div', { class: 'row' }, sel, later));
  });
}
function pageWealthRecurring() {
  const book = currentBook(), ed = canEdit(), items = [...recurringItems(book), ...eventItems(book, Date.now(), S.data.rateHistory || [])].sort((a, b) => (a.due ? 0 : 1) - (b.due ? 0 : 1) || (a.due || a.next) - (b.due || b.next)), dueN = items.filter(i => i.due).length;
  return h('div', null, bookHeader('Recurring', 'Instalments, SIPs and rent'),
    h('p', { class: 'small' }, 'Deposits and receipts that repeat every month. When one falls due, you confirm it here or in the pop-up. Set the monthly amount in the item itself (EPF, APY, NPS, SIP, Kametti, RD, Rent).'),
    ed && dueN ? h('button', { class: 'btn primary', style: { margin: '0 0 12px' }, onclick: () => showWealthDue(true) }, 'Review ' + dueN + ' due now') : null,
    items.length ? h('div', { class: 'list' }, items.map(it => h('div', { class: 'item' + (ed ? ' clk' : '') + (it.held ? ' paused' : ''), 'data-deco': it.arr === 'brokerHoldings' ? 'hold' : R_KEY[it.type] === 'liability' && isCard({ src: it.ref }) ? 'card' : R_KEY[it.type], role: ed ? 'button' : null, tabindex: ed ? 0 : null, onclick: ed ? () => openWealth(rKey(it), { src: it.ref }) : null },
      h('div', { class: 'irow' }, h('div', { class: 'iname' }, it.name, it.held ? h('span', { class: 'ttag' }, 'Held') : it.due ? h('span', { class: 'ttag down' }, 'Due') : null), h('div', { class: 'ival' }, money(it.amount))),
      h('div', { class: 'isub' }, RTYPES[it.type]), h('div', { class: 'iline' }, (it.due ? 'Due since ' + fmtDate(it.due) : 'Next: ' + fmtDate(it.next)) + (it.pend > 1 ? ' · ' + it.pend + ' pending' : ''))))) :
      h('p', { class: 'empty' }, 'Nothing repeats yet. Add a monthly amount to an EPF, APY, NPS, SIP, Kametti or RD, or add rented property.'));
}


// ---------- Calendar reminders (optional): Google Calendar links and a .ics file ----------
function pageCalendar() {
  const book = currentBook(); let pref = { amounts: false, lead: 1 };
  try { pref = { ...pref, ...JSON.parse(localStorage.getItem('arthik.cal') || '{}') }; } catch {}
  const save = () => { try { localStorage.setItem('arthik.cal', JSON.stringify(pref)); } catch {} };
  const ev = calendarEvents(book, Date.now(), S.data.rateHistory || []);
  const list = h('div', { class: 'list' }), paintList = () => list.replaceChildren(...ev.map(e => h('div', { class: 'item' },
    h('div', { class: 'irow' }, h('div', { class: 'iname' }, eventTitle(e, pref.amounts).replace(/^Arthik: /, '')), h('div', { class: 'ival' }, fmtDate(e.date))),
    e.rrule ? h('div', { class: 'isub' }, 'Repeats ' + (/FREQ=MONTHLY;INTERVAL=(\d+)/.exec(e.rrule) ? 'every ' + RegExp.$1 + ' months' : /FREQ=MONTHLY/.test(e.rrule) ? 'every month' : /FREQ=WEEKLY/.test(e.rrule) ? 'every week' : /FREQ=YEARLY/.test(e.rrule) ? 'every year' : /FREQ=DAILY/.test(e.rrule) ? 'every day' : '')) : null,
    h('a', { class: 'btn', href: googleLink(e, pref.amounts), target: '_blank', rel: 'noopener noreferrer' }, 'Add to Google Calendar'))));
  paintList();
  const dl = h('button', { class: 'btn primary', type: 'button', onclick: () => { const blob = new Blob([buildIcs(ev, { amounts: pref.amounts, leadDays: pref.lead })], { type: 'text/calendar' }); const a = h('a', { href: URL.createObjectURL(blob), download: 'arthik-reminders.ics' }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); toast('Calendar file downloaded'); } }, 'Download calendar file (.ics)');
  const sel = h('select', { 'aria-label': 'Remind me', onchange: e => { pref.lead = +e.target.value; save(); } }, [[0, 'On the day, 9 am'], [1, '1 day before, 9 am'], [3, '3 days before, 9 am']].map(([v, l]) => h('option', { value: v, selected: v === pref.lead }, l)));
  return h('div', null, backLink('#/more', 'More'), bookHeader('Calendar reminders', 'Optional'),
    h('p', { class: 'small' }, 'Arthik cannot send phone notifications, but your calendar can. Add the due dates below to Google Calendar (or any calendar app) and it will remind you. This is a one-time copy of the dates as they are today. If you add or change instalments, download it again.'),
    h('section', { class: 'card' }, toggleRow('Show amounts in the event titles (they will be visible in your calendar)', () => pref.amounts, v => { pref.amounts = v; save(); paintList(); }),
      h('div', { class: 'flbl' }, 'Remind me'), sel, h('div', { class: 'actions' }, dl),
      h('p', { class: 'small' }, 'How to use the file: in Google Calendar on a computer, Settings › Import & export › Import, then pick the file. The reminder time is inside each event.')),
    ev.length ? list : h('p', { class: 'empty' }, 'Nothing is scheduled yet.'));
}

// ---------- Recently deleted (soft delete, like the mobile app) ----------
const TRASH_KEYS = ['fd', 'rd', 'ppf', 'epf', 'nps', 'apy', 'mf', 'demat', 'hold', 'insurance', 'metal', 'asset', 'bank', 'receivable', 'kametti', 'liability', 'loan', 'goal', 'rent'];
function trashItems(book) {
  if (book.bookType === 'EXPENSE') {
    const rl = (book.recurringRules || []).filter(r => r.isDeleted).map(r => ({ rule: r, title: 'Recurring · ' + r.name, sub: ruleLabel(r) + ' · ' + money(r.amount), at: r.deletedAt }));
    const cat = Object.fromEntries((book.categories || []).map(c => [c.localId, c.name])), acc = Object.fromEntries((book.accounts || []).map(a => [a.localId, a.name]));
    return (book.transactions || []).filter(t => t.isDeleted).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0)).map(t => ({ tx: t, title: (TYPE[t.type] ? TYPE[t.type].label : t.type) + ' · ' + money(t.amount), sub: [fmtDate(t.occurredAt), cat[t.categoryLocalId], acc[t.accountLocalId], t.note].filter(Boolean).join(' · '), at: t.deletedAt })).concat(rl).sort((a, b) => (b.at || 0) - (a.at || 0));
  }
  const out = [];
  TRASH_KEYS.forEach(k => { const sp = WSPEC[k]; const idOf = sp.idOf || (x => x[sp.nameKey]);
    (book[sp.arr] || []).forEach(rec => { if (rec.isArchived && !rec.renewed) out.push({ key: k, sp, rec, idOf, title: idOf(rec) || '(no name)', sub: sp.noun, at: rec.deletedAt }); }); });
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}
function pageTrash() {
  const book = currentBook(), items = trashItems(book), ed = canEdit();
  const exp = book.bookType === 'EXPENSE', bname = book.name;
  const doIt = (btn, label, fn, msg) => btn.onclick = async () => { btn.disabled = true; try { await fn(); toast(msg); route(); } catch (e) { toast(e.message + ' Nothing was changed.', true); btn.disabled = false; } };
  const rows = items.map(it => {
    const restore = h('button', { class: 'btn', type: 'button' }, 'Restore'), kill = h('button', { class: 'btn danger', type: 'button' }, 'Delete forever');
    if (exp && it.rule) {
      const rr = it.rule;
      doIt(restore, 'Restore', () => mutateBook(b => { const x = (b.recurringRules || []).find(y => sameRule(y, rr)); if (!x) throw new Error('Rule not found.'); delete x.isDeleted; delete x.deletedAt; }), 'Rule restored ✓');
      kill.onclick = async () => { if (!confirm('Delete this rule forever?')) return; kill.disabled = true; try { await mutateBook(b => { b.recurringRules = (b.recurringRules || []).filter(y => !sameRule(y, rr)); }); toast('Deleted forever'); route(); } catch (e) { toast(e.message, true); kill.disabled = false; } };
    } else if (exp) {
      const id = it.tx.localId;
      doIt(restore, 'Restore', () => mutate(d => { const b = findBook(d, bname); const x = b && (b.transactions || []).find(y => y.localId === id); if (!x) throw new Error('Entry not found.'); delete x.isDeleted; delete x.deletedAt; }), 'Entry restored ✓');
      kill.onclick = async () => { if (!confirm('Delete this entry forever? This cannot be undone.')) return; kill.disabled = true; try { await mutate(d => { const b = findBook(d, bname); if (b) b.transactions = (b.transactions || []).filter(y => y.localId !== id); }); toast('Deleted forever'); route(); } catch (e) { toast(e.message, true); kill.disabled = false; } };
    } else {
      const nm = it.idOf(it.rec), arr = it.sp.arr;
      const find = b => (b[arr] || []).findIndex(x => x.isArchived && it.idOf(x) === nm);
      doIt(restore, 'Restore', () => mutateWealth(b => { const i = find(b); if (i < 0) throw new Error('Item not found.'); b[arr][i].isArchived = false; delete b[arr][i].deletedAt; }), 'Restored ✓ · back in your Net Worth');
      kill.onclick = async () => { if (!confirm('Delete “' + nm + '” forever? This cannot be undone.')) return; kill.disabled = true; try { await mutateWealth(b => { const i = find(b); if (i >= 0) b[arr].splice(i, 1); }); toast('Deleted forever'); route(); } catch (e) { toast(e.message, true); kill.disabled = false; } };
    }
    return h('div', { class: 'item', 'data-deco': it.key || 'trash' }, h('div', { class: 'irow' }, h('div', { class: 'iname' }, it.title)), it.sub ? h('div', { class: 'isub' }, it.sub) : null,
      it.at ? h('div', { class: 'iline' }, 'Deleted ' + fmtDate(it.at)) : null, ed ? h('div', { class: 'actions' }, restore, kill) : null);
  });
  // ---- select several, then restore or delete forever in one save ----
  const applyOne = (it, b, kill) => {
    if (exp && it.rule) { const rr = it.rule; if (kill) b.recurringRules = (b.recurringRules || []).filter(y => !sameRule(y, rr)); else { const x = (b.recurringRules || []).find(y => sameRule(y, rr)); if (x) { delete x.isDeleted; delete x.deletedAt; } } }
    else if (exp) { const id = it.tx.localId; if (kill) b.transactions = (b.transactions || []).filter(y => y.localId !== id); else { const x = (b.transactions || []).find(y => y.localId === id); if (x) { delete x.isDeleted; delete x.deletedAt; } } }
    else { const nm = it.idOf(it.rec), arr = it.sp.arr, i = (b[arr] || []).findIndex(x => x.isArchived && it.idOf(x) === nm); if (i >= 0) { if (kill) b[arr].splice(i, 1); else { b[arr][i].isArchived = false; delete b[arr][i].deletedAt; } } }
  };
  const sel = new Set(); let selecting = false;
  const box = h('div'), bar = h('div', { class: 'selbar' });
  const bulk = async (kill) => {
    const picked = items.filter((_, i) => sel.has(i)); if (!picked.length) return;
    if (kill && !confirm('Delete ' + picked.length + ' item(s) forever? This cannot be undone.')) return;
    try { await mutate(d => { const b = exp ? findBook(d, bname) : wealthByName(d, bname); if (!b) throw new Error('Book not found.'); picked.forEach(it => applyOne(it, b, kill)); }); toast(kill ? 'Deleted forever' : picked.length + ' restored ✓'); route(); } catch (e) { toast(e.message + ' Nothing was changed.', true); }
  };
  const paint = () => {
    rows.forEach((r, i) => {
      r.classList.toggle('picked', sel.has(i)); r.classList.toggle('pickable', selecting);
      let cb = r.querySelector('.pickbox'); if (selecting && !cb) { cb = h('span', { class: 'pickbox', 'aria-hidden': 'true' }); r.prepend(cb); } if (!selecting && cb) cb.remove();
      const act = r.querySelector('.actions'); if (act) act.style.display = selecting ? 'none' : '';
      r.onclick = selecting ? () => { sel.has(i) ? sel.delete(i) : sel.add(i); paint(); } : null;
    });
    const n = sel.size;
    bar.replaceChildren(...(!ed || !rows.length ? [] : !selecting ? [h('button', { class: 'btn', type: 'button', onclick: () => { selecting = true; paint(); } }, 'Select several')]
      : [h('button', { class: 'btn', type: 'button', onclick: () => { n === rows.length ? sel.clear() : rows.forEach((_, i) => sel.add(i)); paint(); } }, n === rows.length ? 'Clear all' : 'Select all'),
         h('button', { class: 'btn primary', type: 'button', disabled: n ? null : true, onclick: () => bulk(false) }, 'Restore (' + n + ')'),
         h('button', { class: 'btn danger', type: 'button', disabled: n ? null : true, onclick: () => bulk(true) }, 'Delete forever (' + n + ')'),
         h('button', { class: 'btn ghost', type: 'button', onclick: () => { selecting = false; sel.clear(); paint(); } }, 'Cancel')]));
  };
  box.append(rows.length ? h('div', { class: 'list' }, rows) : h('p', { class: 'empty' }, 'Nothing deleted.')); paint();
  return h('div', null, backLink('#/settings', 'Settings'), bookHeader('Recently deleted', exp ? 'Entries you deleted' : 'Items you deleted'),
    h('p', { class: 'small' }, 'Deleted items are kept here, out of your totals, until you delete them forever. Restore puts them back as they were.' + (ed ? '' : ' Sign in to restore.')),
    bar, box);
}
// ---------- Backup (choose the books) and delete / restore a book ----------
const bkey = b => b.name + '|' + b.bookType, btype = b => b.bookType === 'EXPENSE' ? 'Expense book' : 'Wealth book';
// ---------- pick-list manager: rename or merge banks, brokers, client IDs, insurers, platforms, pension managers and person names ----------
const PL_KINDS = [['bank', 'Banks'], ['broker', 'Brokers'], ['clientid', 'Client IDs'], ['insurer', 'Insurers'], ['platform', 'MF platforms'], ['pfm', 'Pension managers'], ['person', 'People (owed / owing)']];
const PL_USE = { bank: ['W', ['fixedDeposits', 'bankName'], ['recurringDeposits', 'bankName'], ['ppfAccounts', 'bankOrPostOfficeName'], ['apyAccounts', 'bankName'], ['bankBalances', 'bankName'], ['loans', 'lenderName']],
  broker: ['W', ['brokerHoldings', 'broker'], ['dematHoldings', 'accountName'], ['brokerAccounts', 'broker']], clientid: ['W', ['brokerHoldings', 'accountId'], ['brokerAccounts', 'accountId']],
  insurer: ['W', ['insurancePolicies', 'insurerName']], platform: ['W', ['mutualFunds', 'platformName']], pfm: ['W', ['npsAccounts', 'pfm']], person: ['E', ['expenseReceivables', 'personName'], ['transactions', 'settle.person']] };
function plSlots(d, kind) {   // every place in the data that holds a name of this kind: [{get, set}]
  const [bt, ...fields] = PL_USE[kind], out = [];
  (d.books || []).filter(b => !b.isArchived && (bt === 'E' ? b.bookType === 'EXPENSE' : b.bookType !== 'EXPENSE')).forEach(b => fields.forEach(([arr, f]) => (b[arr] || []).forEach(x => {
    if (f === 'settle.person') { if (x.settle && x.settle.person) out.push({ get: () => x.settle.person, set: v => { x.settle.person = v; } }); }
    else if (x[f]) out.push({ get: () => x[f], set: v => { x[f] = v; } }); })));
  return out;
}
function plNames(d, kind) {
  const m = new Map(); plSlots(d, kind).forEach(sl => { const n = String(sl.get()).trim(), k = n.toLowerCase(); if (!k) return; const e = m.get(k) || { name: n, n: 0 }; e.n++; m.set(k, e); });
  (((d.customLists || {})[kind]) || []).forEach(n => { const k = String(n).trim().toLowerCase(); if (k && !m.has(k)) m.set(k, { name: String(n).trim(), n: 0 }); });
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function openPickLists(kind) {
  kind = kind || PL_KINDS[0][0];
  sheetForm('Pick lists', api => {
    const names = plNames(S.data, kind);
    return h('div', null, h('p', { class: 'small' }, 'Fix a typo or merge two spellings (for example “Hdfc” and “HDFC Bank”). Every place that uses the name is updated together.'),
      chipRow(PL_KINDS, () => kind, v => { api.close(); openPickLists(v); }),
      names.length ? h('div', { class: 'erows' }, names.map(x => h('div', { class: 'erow clk', role: 'button', tabindex: 0, onclick: () => { api.close(); openRenameName(kind, x.name); } }, h('span', null, x.name), h('b', null, x.n ? x.n + ' use' + (x.n > 1 ? 's' : '') : 'not used')))) : h('p', { class: 'small' }, 'Nothing saved in this list yet.'));
  });
}
function openRenameName(kind, name) {
  const st = { to: name };
  sheetForm('Rename or merge', api => {
    const others = plNames(S.data, kind).map(x => x.name).filter(n => n.toLowerCase() !== name.toLowerCase()), note = h('div', { class: 'small' }), btn = h('button', { type: 'button', class: 'btn primary big' }, 'Save');
    const inp = h('input', { type: 'text', value: name, list: 'plnames', 'aria-label': 'New name', autocomplete: 'off', maxlength: 60 });
    const upd = () => { const t = inp.value.trim().replace(/\s+/g, ' '); st.to = t; const hit = others.find(n => n.toLowerCase() === t.toLowerCase()); const uses = plSlots(S.data, kind).filter(sl => String(sl.get()).trim().toLowerCase() === name.toLowerCase()).length;
      note.textContent = !t ? 'Type the new name.' : t === name ? 'Change the spelling, or pick another name from the list to merge into it.' : (hit ? `“${name}” will be merged into the existing “${hit}”. ` : `“${name}” will be renamed. `) + uses + ' place' + (uses === 1 ? '' : 's') + ' will change.'; btn.disabled = !t || t === name; };
    inp.oninput = upd; upd();
    btn.onclick = () => { const t0 = st.to; if (!t0) return; api.run(btn, 'Saving…', () => mutate(d => {
      const hit = plNames(d, kind).map(x => x.name).find(n => n.toLowerCase() === t0.toLowerCase() && n.toLowerCase() !== name.toLowerCase()), to = hit || t0;
      plSlots(d, kind).forEach(sl => { if (String(sl.get()).trim().toLowerCase() === name.toLowerCase()) sl.set(to); });
      d.customLists = d.customLists || {}; const cl = d.customLists[kind] || [], out = []; cl.forEach(n => { const v = String(n).trim().toLowerCase() === name.toLowerCase() ? to : n; if (!out.some(y => String(y).trim().toLowerCase() === String(v).trim().toLowerCase())) out.push(v); });
      if (!hit && kind !== 'person' && !out.some(y => String(y).trim().toLowerCase() === to.toLowerCase())) out.push(to); d.customLists[kind] = out;
    })).then(ok => { if (ok) { toast('Updated ✓'); } }); };
    return h('div', null, h('p', null, h('b', null, name), ' · ' + (PL_KINDS.find(k => k[0] === kind) || [0, ''])[1].toLowerCase()), h('div', { class: 'flbl' }, 'New name'), inp, h('datalist', { id: 'plnames' }, others.map(n => h('option', { value: n }))), note,
      h('p', { class: 'small' }, 'Names inside item titles (for example “HDFC Bank 4455” on an FD) are not changed. Edit those items directly.'), h('div', { class: 'actions' }, btn));
  });
}
function openBackup() {
  const books = activeBooks(S.data), sel = new Set(books.map(bkey)); let prot = !!S.pw;
  sheetForm('Download backup', api => {
    const btn = h('button', { type: 'button', class: 'btn primary big' }, 'Download backup');
    btn.onclick = async () => {
      const picked = books.filter(b => sel.has(bkey(b))); if (!picked.length) return api.fail('Choose at least one book.');
      const data = { ...S.data, books: picked }, all = picked.length === books.length, stamp = new Date().toISOString().slice(0, 10);
      const nm = 'arthik-backup-' + stamp + (all ? '' : '-' + picked.map(b => b.name.replace(/[^A-Za-z0-9]+/g, '_')).join('+').slice(0, 40)) + (prot ? '' : '-unprotected') + '.json';
      btn.disabled = true; try { download(nm, prot ? await encrypt(JSON.stringify(data), S.pw) : JSON.stringify(data, null, 2)); closeModal(); toast('Backup downloaded ✓ (' + picked.length + ' book' + (picked.length > 1 ? 's' : '') + ')'); if (all && canEdit()) mutate(d => { d.lastBackupAt = Date.now(); }).then(() => route()).catch(() => {}); } catch (e) { api.fail(e.message); btn.disabled = false; }
    };
    return h('div', null, h('p', { class: 'small' }, 'Choose which books go into this backup file.'),
      books.map(b => toggleRow(b.name + ' · ' + btype(b), () => sel.has(bkey(b)), v => { v ? sel.add(bkey(b)) : sel.delete(bkey(b)); })),
      h('div', { class: 'flbl' }, 'Protection'), chipRow([['p', 'Locked with my data password'], ['u', 'No password (anyone can read it)']], () => (prot ? 'p' : 'u'), v => { prot = v === 'p'; }),
      h('div', { class: 'actions' }, btn));
  });
}
function openDeleteBook(b) {
  const st = { typed: '' };
  sheetForm('Delete book', api => {
    const btn = h('button', { type: 'button', class: 'btn danger big', disabled: true }, 'Delete this book');
    const inp = h('input', { type: 'text', 'aria-label': 'Type the book name', placeholder: b.name, autocomplete: 'off', oninput: e => { st.typed = e.target.value; btn.disabled = st.typed.trim() !== b.name.trim(); } });
    btn.onclick = () => api.run(btn, 'Deleting…', () => mutate(d => { const x = (d.books || []).find(y => bkey(y) === bkey(b) && !y.isArchived); if (!x) throw new Error('This book was not found any more.'); x.isArchived = true; x.deletedAt = Date.now(); S.bookIdx = 0; })).then(ok => ok && toast('Book deleted. You can restore it from Settings.'));
    return h('div', null, h('p', null, h('b', null, b.name), ' (' + btype(b) + ') will be removed from every screen, including all its items and entries.'),
      h('p', { class: 'small' }, 'It is kept inside your data file under "Deleted books" in Settings, so you can restore it, until you delete it forever. A backup first is a good idea.'),
      h('button', { type: 'button', class: 'btn', onclick: () => openBackup() }, 'Download a backup first'),
      h('div', { class: 'flbl' }, 'Type the book name to confirm'), inp, h('div', { class: 'actions' }, btn));
  });
}
function booksCard() {
  const act = activeBooks(S.data), gone = (S.data.books || []).filter(b => b.isArchived), ed = canEdit();
  const forever = b => { if (!confirm('Delete “' + b.name + '” forever? All its data is lost and this cannot be undone.')) return; mutate(d => { d.books = (d.books || []).filter(y => !(bkey(y) === bkey(b) && y.isArchived)); }).then(() => { toast('Deleted forever'); route(); }).catch(e => toast(e.message + ' Nothing was changed.', true)); };
  const restore = b => mutate(d => { const x = (d.books || []).find(y => bkey(y) === bkey(b) && y.isArchived); if (x) { x.isArchived = false; delete x.deletedAt; } }).then(() => { toast('Book restored ✓'); route(); }).catch(e => toast(e.message + ' Nothing was changed.', true));
  return h('section', { class: 'card' }, h('h2', null, 'Books'),
    h('div', { class: 'list' }, act.map(b => h('div', { class: 'brow2' }, h('span', null, h('b', null, b.name), ' · ', btype(b)), ed ? h('button', { class: 'btn danger', type: 'button', onclick: () => openDeleteBook(b) }, 'Delete') : null))),
    gone.length ? h('div', null, h('div', { class: 'flbl' }, 'Deleted books'), gone.map(b => h('div', { class: 'brow2' }, h('span', null, b.name, ' · ', btype(b), b.deletedAt ? ' · deleted ' + fmtDate(b.deletedAt) : ''),
      ed ? h('span', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => restore(b) }, 'Restore'), h('button', { class: 'btn danger', type: 'button', onclick: () => forever(b) }, 'Delete forever')) : null))) : null);
}
// ---------- Change the data password (re-saves the one Dropbox file; every device then needs the new password) ----------
async function changePassword(oldPw, newPw) {
  if (saving) throw new Error('Another save is still running. Try again in a moment.');
  saving = true;
  try {
    const f = await dbx.download(); if (!f) throw new Error('The file was removed from Dropbox. Nothing was changed.');
    const d = await decrypt(f.text, oldPw); if (!d.ok) throw new Error('The password was already changed on another device. Lock and unlock with the new password. Nothing was changed.');
    const text = await encrypt(d.text, newPw);
    let r; try { r = await dbx.upload(text, f.rev); } catch (e) { throw new Error(e.message === 'CONFLICT' ? 'The file changed on another device while saving. Try again. Nothing was changed.' : e.message); }
    S.data = JSON.parse(d.text); S.pw = newPw; S.enc = text; S.rev = r.rev; S.modified = r.modified; cacheSave(); view.cache = null;
  } finally { saving = false; }
}
function openChangePassword() {
  const st = { backed: false, skip: false };
  sheetForm('Change data password', api => {
    const inp = (label, ph) => h('input', { type: 'password', 'aria-label': label, placeholder: ph || label, autocomplete: 'off' });
    const cur = inp('Current password'), n1 = inp('New password', 'New password (at least 8 characters)'), n2 = inp('New password again');
    const bk = h('button', { type: 'button', class: 'btn' }, 'Download a backup now (current password)'), go = h('button', { type: 'button', class: 'btn primary big', disabled: true }, 'Change password');
    const ok = () => { go.disabled = !(st.backed || st.skip); };
    bk.onclick = async () => { bk.disabled = true; try { download('arthik-backup-' + new Date().toISOString().slice(0, 10) + '-before-password-change.json', S.enc || await encrypt(JSON.stringify(S.data), S.pw)); st.backed = true; bk.textContent = 'Backup downloaded ✓'; ok(); } catch (e) { api.fail(e.message); } bk.disabled = false; };
    go.onclick = () => {
      if (cur.value !== S.pw) return api.fail('The current password is not correct.');
      if (n1.value.length < 8) return api.fail('Choose a new password of at least 8 characters.');
      if (n1.value !== n2.value) return api.fail('The two new passwords do not match.');
      if (n1.value === cur.value) return api.fail('The new password is the same as the old one.');
      api.run(go, 'Changing…', () => changePassword(cur.value, n1.value)).then(ok => ok && toast('Password changed ✓ Use the new one on every device.'));
    };
    return h('div', null, h('p', { class: 'small' }, 'This changes the password for your whole data file in Dropbox. Every device, including this one, will ask for the NEW password the next time it unlocks. Your Dropbox sign-in is not affected.'),
      h('p', { class: 'warnbox' }, 'If you forget the new password, nobody can recover your data (not even me). Old backup files still open only with the password they were made with.'),
      h('div', { class: 'flbl' }, 'Step 1: a backup first'), bk,
      toggleRow('I already have a recent backup, skip', () => st.skip, v => { st.skip = v; ok(); }),
      h('div', { class: 'flbl' }, 'Step 2: the passwords'), cur, n1, n2, h('div', { class: 'actions' }, go));
  });
}
function pageSettings() {
  const ex = expenseBooks(S.data);
  return h('div', null, bookHeader('Settings', 'Arthik web ' + APP_VERSION + (canEdit() ? ' · editing on' : ' · view only')),
    h('section', { class: 'card' }, h('h2', null, 'Your data file'),
      h('p', null, 'Dropbox › Apps › Arthik › arthik-data.json'), h('p', { class: 'small' }, 'Last saved ' + (S.modified ? new Date(S.modified).toLocaleString('en-IN') : 'unknown') + (S.offline ? ' (offline copy)' : '')),
      h('p', { class: 'small' }, 'Download backup lets you choose which books to include, and whether the file is locked with your data password.'),
      h('p', null, h('a', { class: 'btn', href: '#/trash' }, 'Recently deleted (' + (currentBook() ? trashItems(currentBook()).length : 0) + ')')),
      h('p', { class: 'small' }, `${wealthBooks(S.data).length} Wealth book(s) and ${ex.length} Expense book(s) in this file. Use the book picker at the top to switch.`),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: openBackup }, 'Download backup…'), canEdit() ? h('button', { class: 'btn', onclick: openChangePassword }, 'Change data password') : null, canEdit() ? h('button', { class: 'btn', onclick: () => openPickLists() }, 'Pick lists…') : null)),
    booksCard(),
    (currentBook() && currentBook().bookType === 'EXPENSE') ? h('section', { class: 'card' }, h('h2', null, 'Manage this book'), h('p', { class: 'small' }, canEdit() ? 'Add, rename, recolour or archive.' : 'Sign in to Dropbox to make changes.'), h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/accounts' }, 'Accounts'), h('a', { class: 'btn', href: '#/categories' }, 'Categories'), h('a', { class: 'btn', href: '#/budgets' }, 'Budgets'))) : null,
    !S.enc ? null : h('section', { class: 'card' }, h('h2', null, 'Replace data'), h('p', { class: 'small' }, 'Load a newer Android backup over this file.'), h('button', { class: 'btn', onclick: () => screenSetup(true) }, 'Replace from a backup file')),
    h('section', { class: 'card' }, h('h2', null, 'Appearance'), h('div', { class: 'row' },
      ['Light', 'Dark', 'Match device'].map(t => h('button', { class: 'btn', onclick: () => { setTheme(t === 'Match device' ? null : t.toLowerCase()); route(); } }, t)))),
    h('section', { class: 'card' }, h('h2', null, 'Session'), h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: lock }, 'Lock now'),
      S.enc ? h('button', { class: 'btn', onclick: refresh }, 'Reload from Dropbox') : null,
      h('button', { class: 'btn danger', onclick: () => { if (confirm('Sign out of Dropbox on this device?')) { dbx.signOut(); S.data = null; S.enc = null; try { localStorage.removeItem(CACHE); } catch {} screenWelcome(); } } }, 'Sign out'))));
}
async function refresh() {
  try { const f = await dbx.download(); if (f) { S.enc = f.text; S.rev = f.rev; S.modified = f.modified; S.offline = false; cacheSave(); S.data = null; screenUnlock('Reloaded. Enter your password.'); } }
  catch (e) { alert(e.message); }
}

// ---------- theme ----------
function setTheme(t) { try { if (t) localStorage.setItem('arthik.theme', t); else localStorage.removeItem('arthik.theme'); } catch {} applyTheme(); }
function applyTheme() { let t = null; try { t = localStorage.getItem('arthik.theme'); } catch {} if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
applyTheme();

// ---------- start ----------
async function start() {
  screenBusy('Loading…');
  try { await dbx.finishSignInIfReturning(); } catch (e) { S.error = e.message; return screenWelcome(); }
  if (!dbx.isSignedIn()) return screenWelcome();
  try {
    const f = await dbx.download();
    if (!f) { S.enc = null; return screenSetup(false); }
    S.enc = f.text; S.rev = f.rev; S.modified = f.modified; S.offline = false; cacheSave();
  } catch (e) {
    if (e.message === 'NOT_SIGNED_IN') return screenWelcome();
    const c = cacheLoad();
    if (!c) { S.error = e.message; return screenWelcome(); }
    S.enc = c.enc; S.rev = c.rev; S.modified = c.modified; S.offline = true;
  }
  screenUnlock();
}
start();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
