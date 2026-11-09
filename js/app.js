import { APP_VERSION, AUTO_LOCK_MS } from './config.js';
import * as dbx from './dropbox.js';
import { encrypt, decrypt, isEncrypted } from './crypto.js';
import { CATS, computeBook, computeExpense, activeBooks, wealthBooks, expenseBooks, setCurrency, setMask, money, pct, fmtDate } from './model.js';

const root = document.getElementById('app');
const S = { enc: null, rev: null, modified: null, data: null, bookIdx: 0, offline: false, error: '', busy: false };

// ---------- tiny DOM helper (text is always set as text, never as HTML) ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
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
function lock() { S.data = null; view.cache = null; clearTimeout(lockTimer); if (S.enc) screenUnlock('Locked.'); else screenWelcome(); }

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
    S.error = ''; S.bookIdx = 0; touch(); route();
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
  { id: 'rent', label: 'Rent' }, { id: 'settings', label: 'Settings' },
];
const NAV_E = [
  { id: 'dashboard', label: 'Home' }, { id: 'transactions', label: 'Entries' }, { id: 'budgets', label: 'Budgets' }, { id: 'settings', label: 'Settings' },
];
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
  const masked = !!book && book.bookType === 'WEALTH' && hidden();
  setMask(masked);
  const isExp = !!book && book.bookType === 'EXPENSE';
  const NAV = isExp ? NAV_E : NAV_W;
  if (!book) body = emptyState();
  else if (isExp && page === 'transactions') body = pageEntries();
  else if (isExp && page === 'budgets') body = pageBudgets();
  else if (isExp && page !== 'settings') body = pageExpenseDashboard();
  else if (page === 'cat') body = pageCategory(arg);
  else if (page === 'liabilities') body = pageLiabilities();
  else if (page === 'goals') body = pageGoals();
  else if (page === 'rent') body = pageRent();
  else if (page === 'settings') body = pageSettings();
  else body = pageDashboard();
  const active = ['cat'].includes(page) ? 'dashboard' : (NAV.find(n => n.id === page) ? page : 'dashboard');
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' }, NAV.map(n => h('a', { href: '#/' + n.id, class: n.id === active ? 'on' : '', 'aria-current': n.id === active ? 'page' : null }, h('span', { class: 'dot' }), n.label)));
  const brandRow = () => h('div', { class: 'brand sm' }, h('img', { class: 'logo', src: 'icons/logo.png', alt: '', width: 40, height: 40 }), h('div', { class: 'brandname' }, 'Arthik'));
  const side = h('aside', { class: 'side' }, brandRow(), h('div', { class: 'bookbox' }, bookPicker()), nav.cloneNode(true));
  mount(h('div', { class: 'layout' }, side, h('main', { class: 'main' }, h('div', { class: 'mbar' }, brandRow(), h('div', { class: 'bookbox' }, bookPicker())), body, h('div', { class: 'foot' }, 'Arthik web ' + APP_VERSION + ' · view only' + (matchMedia('(hover:hover)').matches ? ' · shortcuts: / search, H hide values' : ''))), nav));
  window.scrollTo(0, 0);
}
addEventListener('hashchange', () => { if (S.data) route(); });
// Laptop shortcuts: "/" search entries, "h" hide or show values, "g" then nothing else is needed.
addEventListener('keydown', e => {
  if (!S.data || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target && e.target.tagName || '').toLowerCase(); if (['input', 'select', 'textarea'].includes(tag)) return;
  const b = currentBook(); if (!b) return;
  if (e.key === '/' && b.bookType === 'EXPENSE') { e.preventDefault(); if (!location.hash.includes('transactions')) location.hash = '#/transactions'; setTimeout(() => { const i = document.querySelector('input[type=search]'); if (i) i.focus(); }, 50); }
  else if ((e.key === 'h' || e.key === 'H') && b.bookType === 'WEALTH') { setHidden(!hidden()); view.cache = null; route(); }
});

function emptyState() {
  return h('div', null, h('h1', null, 'No books found'), h('p', null, 'Your backup has no active books.'));
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

function donut(c) {
  const parts = c.cats.filter(x => x.total > 0), tot = parts.reduce((s, x) => s + x.total, 0);
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
const mask = (t) => t;

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
  const tiles = c.cats.filter(x => x.items.length).map(x => {
    const gain = x.cost > 0 && ['demat', 'mf'].includes(x.key) ? (x.total - x.cost) / x.cost * 100 : null;
    return tile('#/cat/' + x.key, x.label, x.code, x.color, x.ill, money(x.total), c.assets > 0 ? x.total / c.assets * 100 : 0, gain, x.items.some(i => i.excluded));
  });
  tiles.push(tile('#/liabilities', 'Liabilities', 'LI', '#EF4444', 'liab', money(c.liabTotal), c.liabTotal > 0 ? 100 : 0, null, false));
  return h('div', null, bookHeader('Dashboard', book.name), backupBanner(), installHint(),
    h('section', { class: 'card hero' },
      h('div', { class: 'irow' }, h('div', { class: 'lbl' }, 'Net Worth'),
        h('button', { class: 'eye', 'aria-pressed': hidden(), 'aria-label': hidden() ? 'Show Net Worth' : 'Hide Net Worth', onclick: () => { setHidden(!hidden()); route(); } }, hidden() ? 'Show' : 'Hide')),
      h('div', { class: 'big' }, mask(money(c.netWorth))),
      h('div', { class: 'hsub' }, h('span', null, 'Assets ', h('b', null, mask(money(c.assets)))), h('span', null, 'Liabilities ', h('b', null, mask(money(c.liabTotal))))),
      change !== null && !hidden() ? h('div', { class: 'tnote ' + (change >= 0 ? 'up' : 'down') }, pct(change) + ' vs about a month ago') : null,
      hidden() ? null : trend(book, c.netWorth)),
    h('section', { class: 'card alloc' }, d.svg, h('ul', { class: 'legend' }, d.parts.sort((a, b) => b.total - a.total).map(p => h('li', null, h('span', { class: 'sw', style: { background: p.color } }), `${p.label} ${(p.total / d.tot * 100).toFixed(1)}%`)))),
    h('h2', null, 'Categories'), h('div', { class: 'grid g3d' }, tiles),
    h('div', { class: 'small' }, 'Prices and NAVs are the last ones saved by your phone. Live refresh arrives in a later phase.'));
}

function itemCard(it) {
  return h('div', { class: 'item' },
    it.excluded ? h('div', { class: 'excl' }, 'Not in Net Worth') : null,
    h('div', { class: 'irow' }, h('div', { class: 'iname' }, it.name), h('div', { class: 'ival' }, money(it.value))),
    it.sub ? h('div', { class: 'isub' }, it.sub) : null,
    (it.lines || []).map(l => h('div', { class: 'iline' }, l)));
}

function pageCategory(key) {
  const c = computed(), cat = c.byKey[key] || c.cats[0];
  return h('div', null, bookHeader(cat.label, 'Wealth'),
    h('section', null, h('div', { class: 'lbl' }, 'Counted toward Net Worth'), h('div', { class: 'big2' }, money(cat.total))),
    cat.items.length ? h('div', { class: 'list' }, cat.items.sort((a, b) => b.value - a.value).map(itemCard)) : h('p', null, 'Nothing here yet.'),
    h('a', { href: '#/dashboard', class: 'btn ghost' }, '← Dashboard'));
}

function pageLiabilities() {
  const c = computed();
  return h('div', null, bookHeader('Liabilities', 'Loans and dues'),
    h('section', null, h('div', { class: 'lbl' }, 'Total outstanding'), h('div', { class: 'big2' }, money(c.liabTotal))),
    c.liabilities.length ? h('div', { class: 'list' }, c.liabilities.sort((a, b) => b.value - a.value).map(l => itemCard({ ...l, sub: (l.kind === 'Loan' ? 'Loan · ' : '') + (l.sub || '') }))) : h('p', null, 'No liabilities. '));
}

function pageGoals() {
  const c = computed();
  return h('div', null, bookHeader('Goals', 'Progress'),
    c.goals.length ? h('div', { class: 'list' }, c.goals.map(g => h('div', { class: 'item' },
      h('div', { class: 'irow' }, h('div', { class: 'iname' }, g.name), h('div', { class: 'ival' }, g.pct.toFixed(0) + '%')),
      h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': g.pct.toFixed(0), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span', { style: { width: g.pct + '%' } })),
      h('div', { class: 'iline' }, `${money(g.current)} of ${money(g.target)}${g.targetDate ? ' · by ' + fmtDate(g.targetDate) : ''}`),
      g.linked.map(l => h('div', { class: 'isub' }, `${l.cat}: ${l.name} — ${money(l.value)}`))))) : h('p', null, 'No goals yet.'));
}

function pageRent() {
  const c = computed();
  return h('div', null, bookHeader('Rent receivable', 'Tracking only — not in Net Worth'),
    c.rent.length ? h('div', { class: 'list' }, c.rent.map(r => {
      const pays = (r.payments || []).filter(p => p.entryType === 'RENT').sort((a, b) => b.receivedDate - a.receivedDate);
      return h('div', { class: 'item' }, h('div', { class: 'irow' }, h('div', { class: 'iname' }, r.propertyName), h('div', { class: 'ival' }, money(r.monthlyRent) + '/mo')),
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
function txRow(t, c) {
  const a = c.acc[t.accountLocalId], to = c.acc[t.toAccountLocalId], cat = c.cat[t.categoryLocalId], ty = TYPE[t.type] || TYPE.EXPENSE;
  const mode = t.type !== 'TRANSFER' && a ? ` (${a.name})` : '';
  const title = t.type === 'TRANSFER' ? `${a ? a.name : '?'} → ${to ? to.name : '?'}${t.note ? ' · ' + t.note : ''}` : (cat ? cat.name : 'Uncategorised') + (t.note ? ' · ' + t.note : '') + mode;
  const dot = t.type === 'TRANSFER' ? 'var(--pri)' : (cat ? catColors(c)[cat.localId] : 'var(--line2)');
  return h('div', { class: 'tx' },
    h('span', { class: 'dotc', style: { background: dot } }),
    h('div', { class: 'txm' }, h('div', { class: 'txt' }, title, h('span', { class: 'ttag ' + ty.cls }, ty.label)), h('div', { class: 'isub' }, dayLabel(t.occurredAt))),
    h('div', { class: 'txa ' + ty.cls }, ty.sign + money(t.amount)));
}

const sentence = x => { const t = String(x || '').replace(/_/g, ' ').trim().toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
const niceName = x => { const t = String(x || '').trim(); return t && t === t.toLowerCase() ? t.charAt(0).toUpperCase() + t.slice(1) : t; };
const accType = a => { const ty = sentence(a.type); return ty && ty.replace(/\s/g, '').toLowerCase() !== String(a.name || '').replace(/\s/g, '').toLowerCase() ? ty : ''; };

// ---------- small helpers: backup age, install hint, due pills ----------
function backupBanner() {
  const t = S.data && S.data.exportedAt; if (!t) return null;
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
function pageExpenseDashboard() {
  const c = computed(), book = currentBook();
  const oldest = c.txs.length ? c.txs[c.txs.length - 1].occurredAt : Date.now(), od = new Date(oldest), nd = new Date();
  const minOff = (od.getFullYear() - nd.getFullYear()) * 12 + od.getMonth() - nd.getMonth();
  const cur = em === 0, ml = monthLabel(em);
  const go = d => h('button', { class: 'mnav', 'aria-label': d < 0 ? 'Previous month' : 'Next month', disabled: d < 0 ? em <= minOff : em >= 0, onclick: () => { em = Math.max(minOff, Math.min(0, em + d)); route(); } }, d < 0 ? '‹' : '›');
  return h('div', null, bookHeader('Dashboard', book.name), backupBanner(), installHint(),
    h('div', { class: 'monthbar' }, go(-1), h('div', { class: 'mlabel' }, ml, cur ? '' : h('button', { class: 'link', onclick: () => { em = 0; route(); } }, 'Back to this month')), go(1)),
    h('section', { class: 'card hero' }, h('div', { class: 'lbl' }, cur ? 'This month spent' : ml + ' spent'), h('div', { class: 'big' }, money(c.month)),
      h('div', { class: 'hsub' }, cur ? h('span', null, 'Today ', h('b', { class: 'down' }, money(c.today))) : null, h('span', null, (cur ? 'Income this month ' : 'Income '), h('b', { class: 'up' }, money(c.monthIncome))))),
    h('h2', null, 'Accounts'),
    h('div', { class: 'grid' }, c.accounts.map(a => h('div', { class: 'tile' }, h('div', { class: 'tile-top' }, h('span', { class: 'tname' }, niceName(a.name)), accType(a) ? h('span', { class: 'tnote' }, accType(a)) : null),
      h('div', { class: 'tval' + (a.balance < 0 ? ' down' : '') }, money(a.balance)), duePill(a, c)))),
    h('h2', null, cur ? 'Spending by category (this month)' : 'Spending by category (' + ml + ')'),
    !c.topCats.length ? h('section', { class: 'card empty' }, h('p', null, cur ? 'Nothing spent yet this month.' : 'No spending recorded in ' + ml + '.')) : null,
    c.topCats.length ? h('div', null,  h('section', { class: 'card' }, c.topCats.slice(0, 8).map(x => {
      const pctw = c.month > 0 ? x.spent / c.month * 100 : 0;
      const col = x.cat ? catColors(c)[x.cat.localId] : 'var(--mut)';
      return h('div', { class: 'catrow' }, h('div', { class: 'irow' }, h('span', null, h('span', { class: 'sw', style: { background: col } }), x.cat ? x.cat.name : 'Uncategorised'), h('b', null, money(x.spent))), h('div', { class: 'bar' }, h('span', { style: { width: pctw + '%', background: col } })));
    }))) : null,
    cur && c.upcoming.length ? h('div', null, h('h2', null, 'Upcoming (next 7 days)'), h('div', { class: 'list' }, c.upcoming.map(r => h('div', { class: 'item' },
      h('div', { class: 'irow' }, h('div', { class: 'iname' }, r.name), h('div', { class: 'ival' }, money(r.amount))),
      h('div', { class: 'isub' }, `${r.type.toLowerCase()} · ${fmtDate(r.nextRunAt)}${r.nextRunAt < Date.now() ? ' · due' : ''}`))))) : null,
    cur && c.owed.length ? h('div', null, h('h2', null, 'Money owed to you'), h('div', { class: 'list' }, c.owed.map(r => h('div', { class: 'item' },
      h('div', { class: 'irow' }, h('div', { class: 'iname' }, r.personName), h('div', { class: 'ival' }, money(r.amount))), r.note ? h('div', { class: 'isub' }, r.note) : null)))) : null,
    h('h2', null, 'Recent entries'),
    h('section', { class: 'card' }, c.txs.slice(0, 10).map(t => txRow(t, c)), c.txs.length ? h('a', { href: '#/transactions', class: 'btn ghost' }, 'See all entries') : h('p', null, 'No entries yet. Entries you add in the Android app appear here after you take a new backup.')));
}

const ef = { q: '', type: 'ALL', month: 'ALL', cat: 'ALL', acc: 'ALL', limit: 100 };
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
    if (!q) return true;
    const cat = c.cat[t.categoryLocalId], a = c.acc[t.accountLocalId];
    return [t.note, cat && cat.name, a && a.name, String(t.amount)].filter(Boolean).join(' ').toLowerCase().includes(q);
  });
  const shown = rows.slice(0, ef.limit);
  const spent = rows.filter(t => t.type === 'EXPENSE').reduce((s, t) => s + t.amount, 0), got = rows.filter(t => t.type === 'INCOME').reduce((s, t) => s + t.amount, 0);
  const search = h('input', { type: 'search', placeholder: 'Search note, category, account or amount', value: ef.q, 'aria-label': 'Search entries' });
  search.addEventListener('change', () => { ef.q = search.value; ef.limit = 100; route(); });
  const sel = (opts, cur, set, label) => h('select', { 'aria-label': label, onchange: e => { set(e.target.value); ef.limit = 100; route(); } }, opts.map(([v, l]) => h('option', { value: v, selected: v === cur }, l)));
  const groups = []; shown.forEach(t => { const k = dayLabel(t.occurredAt); const g = groups[groups.length - 1]; if (g && g.k === k) g.rows.push(t); else groups.push({ k, rows: [t] }); });
  return h('div', null, bookHeader('Entries', currentBook().name),
    h('div', { class: 'filters' }, search,
      sel([['ALL', 'All types'], ['EXPENSE', 'Expenses'], ['INCOME', 'Income'], ['TRANSFER', 'Transfers']], ef.type, v => ef.type = v, 'Type'),
      sel([['ALL', 'All categories'], ...(c.catList || Object.values(c.cat)).map(x => [String(x.localId), x.name])], ef.cat, v => ef.cat = v, 'Category'),
      sel([['ALL', 'All accounts'], ...Object.values(c.acc).map(a => [String(a.localId), niceName(a.name) + (accType(a) ? ' (' + accType(a) + ')' : '')])], ef.acc, v => ef.acc = v, 'Account'),
      sel([['ALL', 'All months'], ...months.map(m => [m, new Date(m + '-15').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })])], ef.month, v => ef.month = v, 'Month')),
    h('div', { class: 'hsub', style: { margin: '10px 0' } }, h('span', null, rows.length + ' entries'), h('span', null, 'Spent ', h('b', { class: 'down' }, money(spent))), h('span', null, 'Income ', h('b', { class: 'up' }, money(got)))),
    h('section', { class: 'card' }, groups.map(g => h('div', null, h('div', { class: 'dayh' }, g.k), g.rows.map(t => txRow(t, c)))), rows.length ? null : h('p', { class: 'empty' }, c.txs.length ? 'No entries match these filters. Try clearing the search or choosing “All”.' : 'No entries yet.')),
    rows.length > shown.length ? h('button', { class: 'btn', onclick: () => { ef.limit += 200; route(); } }, `Show more (${rows.length - shown.length} left)`) : null);
}

function pageBudgets() {
  const c = computed();
  const mname = new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  return h('div', null, bookHeader('Budgets', mname),
    c.budgets.length ? h('div', { class: 'list' }, c.budgets.map(b => { const p = b.cap > 0 ? b.spent / b.cap * 100 : 0;
      return h('div', { class: 'item' }, h('div', { class: 'irow' }, h('div', { class: 'iname' }, b.cat ? b.cat.name : 'Category'), h('div', { class: 'ival ' + (p > 100 ? 'down' : '') }, Math.round(p) + '%')),
        h('div', { class: 'bar' + (p > 100 ? ' over' : ''), role: 'progressbar', 'aria-valuenow': Math.round(p), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span', { style: { width: Math.min(100, p) + '%', background: p > 100 ? null : (b.cat ? catColors(c)[b.cat.localId] : null) } })),
        h('div', { class: 'iline' }, `${money(b.spent)} of ${money(b.cap)}` + (b.spent > b.cap ? ` · over by ${money(b.spent - b.cap)}` : ` · ${money(b.cap - b.spent)} left`))); })) : h('section', { class: 'card empty' }, h('p', null, 'No budgets set for this month. Set them in the Android app, then take a new backup.')));
}

function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name }); document.body.append(a); a.click(); a.remove();
}
function pageSettings() {
  const ex = expenseBooks(S.data);
  return h('div', null, bookHeader('Settings', 'Arthik web ' + APP_VERSION),
    h('section', { class: 'card' }, h('h2', null, 'Your data file'),
      h('p', null, 'Dropbox › Apps › Arthik › arthik-data.json'), h('p', { class: 'small' }, 'Last saved ' + (S.modified ? new Date(S.modified).toLocaleString('en-IN') : 'unknown') + (S.offline ? ' (offline copy)' : '')),
      h('p', { class: 'small' }, `${wealthBooks(S.data).length} Wealth book(s) and ${ex.length} Expense book(s) in this file. Use the book picker at the top to switch.`),
      h('div', { class: 'row' },
        S.enc ? h('button', { class: 'btn', onclick: () => download('arthik-backup-' + new Date().toISOString().slice(0, 10) + '.json', S.enc) }, 'Download backup (protected)') : null,
        h('button', { class: 'btn', onclick: () => { if (confirm('This saves your data WITHOUT a password. Keep the file somewhere safe.')) download('arthik-backup-unprotected.json', JSON.stringify(S.data, null, 2)); } }, 'Download unprotected copy'))),
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
