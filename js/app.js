import { APP_VERSION, AUTO_LOCK_MS } from './config.js';
import * as dbx from './dropbox.js';
import { encrypt, decrypt, isEncrypted } from './crypto.js';
import { CATS, computeBook, wealthBooks, expenseBooks, money, pct, fmtDate } from './model.js';

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
  return h('div', { class: 'center' }, h('div', { class: 'brand' }, h('div', { class: 'logo' }, 'A'), h('div', { class: 'brandname' }, 'Arthik')), ...content);
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
const NAV = [
  { id: 'dashboard', label: 'Home' }, { id: 'liabilities', label: 'Liabilities' }, { id: 'goals', label: 'Goals' },
  { id: 'rent', label: 'Rent' }, { id: 'settings', label: 'Settings' },
];
const view = { cache: null };
function currentBook() { const w = wealthBooks(S.data); return w[Math.min(S.bookIdx, w.length - 1)] || null; }
function computed() {
  const b = currentBook(); if (!b) return null;
  if (!view.cache || view.cache.book !== b) view.cache = { book: b, c: computeBook(b, S.data.rateHistory || []) };
  return view.cache.c;
}

function route() {
  if (!S.data) return screenUnlock();
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [page, arg] = hash.split('/');
  const books = wealthBooks(S.data);
  let body;
  if (!books.length) body = emptyState();
  else if (page === 'cat') body = pageCategory(arg);
  else if (page === 'liabilities') body = pageLiabilities();
  else if (page === 'goals') body = pageGoals();
  else if (page === 'rent') body = pageRent();
  else if (page === 'settings') body = pageSettings();
  else body = pageDashboard();
  const active = ['cat'].includes(page) ? 'dashboard' : (NAV.find(n => n.id === page) ? page : 'dashboard');
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' }, NAV.map(n => h('a', { href: '#/' + n.id, class: n.id === active ? 'on' : '', 'aria-current': n.id === active ? 'page' : null }, h('span', { class: 'dot' }), n.label)));
  const side = h('aside', { class: 'side' }, h('div', { class: 'brand sm' }, h('div', { class: 'logo' }, 'A'), h('div', { class: 'brandname' }, 'Arthik')), nav.cloneNode(true));
  mount(h('div', { class: 'layout' }, side, h('main', { class: 'main' }, body, h('div', { class: 'foot' }, 'Arthik web ' + APP_VERSION + ' · view only')), nav));
  window.scrollTo(0, 0);
}
addEventListener('hashchange', () => { if (S.data) route(); });

function emptyState() {
  return h('div', null, h('h1', null, 'No wealth book found'), h('p', null, 'Your backup has no Wealth book. Expense books arrive in the next phase.'));
}

function bookHeader(title, sub) {
  const books = wealthBooks(S.data);
  return h('header', { class: 'top' },
    h('div', null, sub ? h('div', { class: 'crumb' }, sub) : null, h('h1', null, title)),
    books.length > 1 ? h('select', { 'aria-label': 'Book', onchange: e => { S.bookIdx = +e.target.value; route(); } }, books.map((b, i) => h('option', { value: i, selected: i === S.bookIdx }, b.name))) : null,
    h('button', { class: 'btn ghost', onclick: lock }, 'Lock'));
}

function donut(c) {
  const parts = c.cats.filter(x => x.total > 0), tot = parts.reduce((s, x) => s + x.total, 0);
  const R = 52, C = 2 * Math.PI * R; let off = 0;
  const s = svg('svg', { viewBox: '0 0 140 140', class: 'donut', role: 'img', 'aria-label': 'Asset allocation' });
  s.append(svg('circle', { cx: 70, cy: 70, r: R, fill: 'none', stroke: '#D5DAE3', 'stroke-width': 22 }));
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
  return svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'trend', preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Net Worth over time' }, svg('polyline', { points: xy, fill: 'none', stroke: '#2F3F5C', 'stroke-width': 4, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
}

function pageDashboard() {
  const c = computed(), book = currentBook();
  const d = donut(c);
  const last = (book.netWorthSnapshots || []).filter(s => s.date < Date.now() - 25 * 86400000).sort((a, b) => b.date - a.date)[0];
  const change = last && last.value ? (c.netWorth - last.value) / Math.abs(last.value) * 100 : null;
  const tiles = c.cats.filter(x => x.items.length).map(x => {
    const gain = x.cost > 0 ? (x.total - x.cost) / x.cost * 100 : null;
    const hasEx = x.items.some(i => i.excluded);
    return h('a', { class: 'tile', href: '#/cat/' + x.key }, h('div', { class: 'tile-top' }, h('span', { class: 'tname' }, x.label), h('span', { class: 'chip', style: { background: x.color } }, x.code)),
      h('div', { class: 'tval' }, money(x.total)),
      h('div', { class: 'tnote' + (gain !== null && ['demat', 'mf'].includes(x.key) ? (gain >= 0 ? ' up' : ' down') : '') }, gain !== null && ['demat', 'mf'].includes(x.key) ? pct(gain) : (c.assets > 0 ? (x.total / c.assets * 100).toFixed(1) + '% of assets' : '')),
      hasEx ? h('div', { class: 'excl' }, 'Some not in Net Worth') : null);
  });
  tiles.push(h('a', { class: 'tile', href: '#/liabilities' }, h('div', { class: 'tile-top' }, h('span', { class: 'tname' }, 'Liabilities'), h('span', { class: 'chip', style: { background: '#B5655B' } }, 'LI')), h('div', { class: 'tval' }, money(c.liabTotal)), h('div', { class: 'tnote' }, c.liabilities.length + ' entries')));
  return h('div', null, bookHeader('Dashboard', book.name),
    h('section', { class: 'card hero' }, h('div', { class: 'lbl' }, 'Net Worth'), h('div', { class: 'big' }, money(c.netWorth)),
      h('div', { class: 'hsub' }, h('span', null, 'Assets ', h('b', null, money(c.assets))), h('span', null, 'Liabilities ', h('b', null, money(c.liabTotal)))),
      change !== null ? h('div', { class: 'tnote ' + (change >= 0 ? 'up' : 'down') }, pct(change) + ' vs about a month ago') : null, trend(book, c.netWorth)),
    h('section', { class: 'card alloc' }, d.svg, h('ul', { class: 'legend' }, d.parts.sort((a, b) => b.total - a.total).map(p => h('li', null, h('span', { class: 'sw', style: { background: p.color } }), `${p.label} ${(p.total / d.tot * 100).toFixed(1)}%`)))),
    h('h2', null, 'Categories'), h('div', { class: 'grid' }, tiles),
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

function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name }); document.body.append(a); a.click(); a.remove();
}
function pageSettings() {
  const ex = expenseBooks(S.data);
  return h('div', null, bookHeader('Settings', 'Arthik web ' + APP_VERSION),
    h('section', { class: 'card' }, h('h2', null, 'Your data file'),
      h('p', null, 'Dropbox › Apps › Arthik › arthik-data.json'), h('p', { class: 'small' }, 'Last saved ' + (S.modified ? new Date(S.modified).toLocaleString('en-IN') : 'unknown') + (S.offline ? ' (offline copy)' : '')),
      h('p', { class: 'small' }, `${wealthBooks(S.data).length} Wealth book(s) and ${ex.length} Expense book(s) in this file. Expense books arrive in the next phase.`),
      h('div', { class: 'row' },
        S.enc ? h('button', { class: 'btn', onclick: () => download('arthik-backup-' + new Date().toISOString().slice(0, 10) + '.json', S.enc) }, 'Download backup (protected)') : null,
        h('button', { class: 'btn', onclick: () => { if (confirm('This saves your data WITHOUT a password. Keep the file somewhere safe.')) download('arthik-backup-unprotected.json', JSON.stringify(S.data, null, 2)); } }, 'Download unprotected copy'))),
    !S.enc ? null : h('section', { class: 'card' }, h('h2', null, 'Replace data'), h('p', { class: 'small' }, 'Load a newer Android backup over this file.'), h('button', { class: 'btn', onclick: () => screenSetup(true) }, 'Replace from a backup file')),
    h('section', { class: 'card' }, h('h2', null, 'Session'), h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: lock }, 'Lock now'),
      S.enc ? h('button', { class: 'btn', onclick: refresh }, 'Reload from Dropbox') : null,
      h('button', { class: 'btn danger', onclick: () => { if (confirm('Sign out of Dropbox on this device?')) { dbx.signOut(); S.data = null; S.enc = null; try { localStorage.removeItem(CACHE); } catch {} screenWelcome(); } } }, 'Sign out'))));
}
async function refresh() {
  try { const f = await dbx.download(); if (f) { S.enc = f.text; S.rev = f.rev; S.modified = f.modified; S.offline = false; cacheSave(); S.data = null; screenUnlock('Reloaded. Enter your password.'); } }
  catch (e) { alert(e.message); }
}

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
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
