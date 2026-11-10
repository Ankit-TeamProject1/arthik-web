// Broker holding statements (Excel / CSV), read inside the browser. Nothing is uploaded anywhere.
// Built for the Zerodha (Kite) holdings workbook; other brokers are read by header names where possible.

export const KINDS = [['MF', 'Mutual Funds'], ['STOCK', 'Stocks'], ['SGB', 'SGB'], ['ETF', 'ETF'], ['BOND', 'Bonds'], ['OTHER', 'Other']];
export const KIND_NAME = Object.fromEntries(KINDS);

// ---------- minimal .xlsx reader (zip + xml), no libraries ----------
const u16 = (b, o) => b[o] | (b[o + 1] << 8), u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
async function inflate(raw) { const ds = new DecompressionStream('deflate-raw'); const w = ds.writable.getWriter(); w.write(raw); w.close(); return new Uint8Array(await new Response(ds.readable).arrayBuffer()); }
async function unzip(buf) {
  const b = new Uint8Array(buf); let e = b.length - 22;
  while (e >= 0 && u32(b, e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('This is not a valid Excel file.');
  const n = u16(b, e + 10); let p = u32(b, e + 16); const files = {}, dec = new TextDecoder();
  for (let i = 0; i < n; i++) {
    const method = u16(b, p + 10), csz = u32(b, p + 20), nl = u16(b, p + 28), xl = u16(b, p + 30), cl = u16(b, p + 32), lo = u32(b, p + 42);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nl)); p += 46 + nl + xl + cl;
    const ds = lo + 30 + u16(b, lo + 26) + u16(b, lo + 28), data = b.subarray(ds, ds + csz);
    files[name] = { method, data };
  }
  const get = async name => { const f = files[name]; if (!f) return null; const raw = f.method === 0 ? f.data : await inflate(f.data); return new TextDecoder().decode(raw); };
  return { get, has: n => !!files[n] };
}
const colIx = ref => { const m = /^([A-Z]+)/.exec(ref); let n = 0; for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const xml = s => new DOMParser().parseFromString(s, 'application/xml');
export async function readXlsx(buf) {
  const z = await unzip(buf);
  const wb = xml(await z.get('xl/workbook.xml')), rels = xml(await z.get('xl/_rels/workbook.xml.rels'));
  const target = {}; [...rels.getElementsByTagName('Relationship')].forEach(r => { target[r.getAttribute('Id')] = r.getAttribute('Target'); });
  let sst = []; const ss = await z.get('xl/sharedStrings.xml');
  if (ss) sst = [...xml(ss).getElementsByTagName('si')].map(si => [...si.getElementsByTagName('t')].map(t => t.textContent).join(''));
  const out = [];
  for (const s of [...wb.getElementsByTagName('sheet')]) {
    const rid = s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    let t = target[rid] || ''; t = t.replace(/^\/?(xl\/)?/, 'xl/');
    const sx = await z.get(t); if (!sx) continue;
    const rows = [];
    [...xml(sx).getElementsByTagName('row')].forEach(r => {
      const arr = [];
      [...r.getElementsByTagName('c')].forEach(c => {
        const ix = colIx(c.getAttribute('r')), ty = c.getAttribute('t'), v = c.getElementsByTagName('v')[0];
        let val = null;
        if (ty === 'inlineStr') val = [...c.getElementsByTagName('t')].map(x => x.textContent).join('');
        else if (v) val = ty === 's' ? sst[+v.textContent] : (ty === 'str' || ty === 'e' || ty === 'b') ? v.textContent : (v.textContent === '' ? null : +v.textContent);
        arr[ix] = val;
      });
      rows[+r.getAttribute('r') - 1] = arr;
    });
    out.push({ name: s.getAttribute('name'), rows: Array.from(rows, r => r || []) });
  }
  return out;
}
export function readCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return [{ name: 'CSV', rows: rows.map(r => r.map(x => x === '' ? null : (isFinite(x) && x.trim() !== '' ? +x : x))) }];
}
export async function readFile(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) return readXlsx(await file.arrayBuffer());
  if (name.endsWith('.csv') || name.endsWith('.txt')) return readCsv(await file.text());
  if (name.endsWith('.pdf')) throw new Error('PDF statements are coming in the next version. For now please use the Excel (.xlsx) or CSV file from your broker.');
  if (name.endsWith('.xls')) throw new Error('This is an old .xls file. Open it in Excel and Save As .xlsx, then upload again.');
  throw new Error('Please choose an Excel (.xlsx) or CSV file.');
}

// ---------- understanding the statement ----------
const S = v => (v == null ? '' : String(v).trim());
const N = v => { if (v == null || v === '' || v === '-') return 0; const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : 0; };
export function classify({ name, isin, sector, itype, fromMfSheet }) {
  const nm = S(name).toUpperCase(), is = S(isin).toUpperCase(), sec = S(sector).toUpperCase(), it = S(itype);
  if (fromMfSheet || (it && it !== '-')) return 'MF';
  if (/^SGB/.test(nm) || /^IN00/.test(is)) return 'SGB';
  if (sec === 'ETF' || /BEES|\bETF\b/.test(nm)) return 'ETF';
  if (sec === 'DEBT' || /^IN[A-Z0-9]{6}07/.test(is)) return 'BOND';
  if (/^INF/.test(is) && !sec) return 'MF';
  return 'STOCK';
}
const dateFrom = s => { const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s) || null; if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12).getTime(); const d = /(\d{2})[-/](\d{2})[-/](\d{4})/.exec(s); return d ? new Date(+d[3], +d[2] - 1, +d[1], 12).getTime() : null; };

export function parseStatement(sheets) {
  const tpl = parseTemplate(sheets); if (tpl) return tpl;
  const pick = sheets.filter(s => /combined/i.test(s.name)); const use = pick.length ? pick : sheets;
  const holdings = [], notes = []; let clientId = '', asOn = null, broker = '';
  for (const sh of use) {
    const rows = sh.rows; let hi = -1;
    for (let i = 0; i < rows.length; i++) {
      const t = rows[i].map(S);
      if (!clientId) { const k = t.findIndex(x => /^client id$/i.test(x)); if (k >= 0) clientId = t[k + 1] || ''; }
      t.forEach(x => { if (!asOn) { const d = /as on|as of|as at/i.test(x) ? dateFrom(x) : null; if (d) asOn = d; } });
      if (hi < 0 && t.some(x => /^(symbol|scheme|stock|instrument|security|name)/i.test(x)) && t.some(x => /isin|average|avg|quantity|qty|units/i.test(x))) { hi = i; break; }
    }
    if (hi < 0) continue;
    const hd = rows[hi].map(S), col = re => hd.findIndex(x => re.test(x));
    const c = { sym: col(/^(symbol|scheme|stock|instrument name|security|name)/i), isin: col(/isin/i), sector: col(/^sector/i), itype: col(/^instrument type/i),
      qty: col(/quantity available|^qty|^quantity$|^units|balance units/i), avg: col(/average price|avg\.? ?(cost|price)|buy avg|average cost/i), px: col(/closing price|ltp|current price|market price|^nav/i) };
    const pledged = hd.map((x, i) => /pledged/i.test(x) && /quantity|qty/i.test(x) ? i : -1).filter(i => i >= 0);
    if (c.sym < 0 || c.qty < 0) { notes.push('Sheet "' + sh.name + '": could not find the Symbol and Quantity columns.'); continue; }
    const fromMf = /mutual/i.test(sh.name);
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i]; const name = S(r[c.sym]); if (!name) continue;
      const units = N(r[c.qty]) + pledged.reduce((a, j) => a + N(r[j]), 0); if (!(units > 0)) continue;
      const isin = c.isin >= 0 ? S(r[c.isin]) : '', sector = c.sector >= 0 ? S(r[c.sector]) : '', itype = c.itype >= 0 ? S(r[c.itype]) : '';
      const kind = classify({ name, isin, sector, itype, fromMfSheet: fromMf });
      holdings.push({ kind, name, isin, units, plan: kind === 'MF' ? planOptionOf(name).plan : '', option: kind === 'MF' ? planOptionOf(name).option : '', avgPrice: c.avg >= 0 ? N(r[c.avg]) : 0, price: c.px >= 0 ? N(r[c.px]) : 0, tag: kind === 'MF' ? (itype && itype !== '-' ? itype : '') : (sector && sector !== '-' ? sector : '') });
    }
  }
  if (!holdings.length) notes.push('No holdings were found in this file.');
  if (clientId && /^[A-Z]{2,3}\d{3,}$/.test(clientId)) broker = 'Zerodha';
  return { holdings, clientId, asOn, broker, notes };
}

// ---------- merge into what is already saved ----------
const norm = s => S(s).toLowerCase();
const keyOf = h => (S(h.isin) ? 'i:' + S(h.isin).toUpperCase() : 'n:' + norm(h.name));
export function planImport(existing, parsed, broker, accountId) {
  const mine = (existing || []).filter(x => !x.isArchived && norm(x.broker) === norm(broker) && (!accountId || !x.accountId || norm(x.accountId) === norm(accountId)));
  const map = new Map(mine.map(x => [keyOf(x), x]));
  const plan = { add: [], update: [], same: [], missing: [] }, seen = new Set();
  parsed.holdings.forEach(h => {
    const k = keyOf(h), old = map.get(k) || mine.find(x => norm(x.name) === norm(h.name)); seen.add(old || k);
    if (!old) { plan.add.push(h); return; }
    const changed = Math.abs(old.units - h.units) > 1e-6 || Math.abs((old.avgPrice || 0) - h.avgPrice) > 1e-4 || Math.abs((old.price || 0) - h.price) > 1e-4;
    (changed ? plan.update : plan.same).push({ old, now: h });
  });
  plan.missing = mine.filter(x => !seen.has(x));
  return plan;
}
export function applyImport(book, plan, ctx, removeMissing) {
  const arr = book.brokerHoldings = book.brokerHoldings || [], when = ctx.asOn || Date.now();
  plan.add.forEach(h => arr.push({ broker: ctx.broker, accountId: ctx.accountId || '', kind: h.kind, name: h.name, isin: h.isin, units: h.units, avgPrice: h.avgPrice, price: h.price, priceDate: when, tag: h.tag, isArchived: false }));
  plan.update.forEach(({ old, now }) => { old.units = now.units; old.avgPrice = now.avgPrice; old.price = now.price; old.priceDate = when; if (!old.isin && now.isin) old.isin = now.isin; if (!old.accountId && ctx.accountId) old.accountId = ctx.accountId; if (now.tag) old.tag = now.tag; });
  plan.same.forEach(({ old, now }) => { old.priceDate = when; if (!old.accountId && ctx.accountId) old.accountId = ctx.accountId; });
  if (removeMissing) plan.missing.forEach(x => { x.isArchived = true; x.deletedAt = Date.now(); });
}

// ================= v0.7.4: Excel template (download a sample, fill it, upload it) =================
export const TEMPLATE_COLS = ['Broker / Platform', 'Client ID / Account', 'Type', 'Name or Symbol', 'Plan', 'Option', 'ISIN', 'AMFI scheme code', 'Folio no.', 'Quantity / Units', 'Average buy price', 'Latest price / NAV', 'Price as on', 'Category / Sector', 'Notes'];
const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zipStore(files) {
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
  const w16 = n => [n & 255, (n >> 8) & 255], w32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  files.forEach(([name, text]) => {
    const nb = enc.encode(name), d = enc.encode(text), crc = crc32(d);
    const lh = new Uint8Array([0x50, 0x4b, 3, 4, ...w16(20), ...w16(0), ...w16(0), ...w16(0), ...w16(0x21), ...w32(crc), ...w32(d.length), ...w32(d.length), ...w16(nb.length), ...w16(0)]);
    parts.push(lh, nb, d);
    cen.push(new Uint8Array([0x50, 0x4b, 1, 2, ...w16(20), ...w16(20), ...w16(0), ...w16(0), ...w16(0), ...w16(0x21), ...w32(crc), ...w32(d.length), ...w32(d.length), ...w16(nb.length), ...w16(0), ...w16(0), ...w16(0), ...w16(0), ...w32(0), ...w32(off)]), nb);
    off += lh.length + nb.length + d.length;
  });
  const cl = cen.reduce((a, x) => a + x.length, 0);
  const end = new Uint8Array([0x50, 0x4b, 5, 6, ...w16(0), ...w16(0), ...w16(files.length), ...w16(files.length), ...w32(cl), ...w32(off), ...w16(0)]);
  return new Blob([...parts, ...cen, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
const xe = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colL = i => String.fromCharCode(65 + i);
const SST = { list: [], map: new Map() };
const sstIx = t => { let i = SST.map.get(t); if (i == null) { i = SST.list.length; SST.list.push(t); SST.map.set(t, i); } return i; };
function sheetXml(rows, widths, valids) {
  const dim = 'A1:' + colL(Math.max(0, ...rows.map(r => r.length - 1))) + rows.length;
  const body = rows.map((r, ri) => '<row r="' + (ri + 1) + '">' + r.map((v, ci) => { if (v == null || v === '') return ''; const ref = colL(ci) + (ri + 1), st = ri === 0 && widths ? ' s="1"' : '';
    return typeof v === 'number' ? '<c r="' + ref + '"' + st + '><v>' + v + '</v></c>' : '<c r="' + ref + '" t="s"' + st + '><v>' + sstIx(String(v)) + '</v></c>'; }).join('') + '</row>').join('');
  const cols = widths ? '<cols>' + widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>' : '<cols><col min="1" max="1" width="110" customWidth="1"/></cols>';
  const dv = valids && valids.length ? '<dataValidations count="' + valids.length + '">' + valids.map(([sq, list]) => '<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="' + sq + '"><formula1>"' + list + '"</formula1></dataValidation>').join('') + '</dataValidations>' : '';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0">' + (widths ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : '') + '</sheetView></sheetViews>' + cols + '<sheetData>' + body + '</sheetData>' + dv + '</worksheet>';
}
export function buildHoldingsXlsx(holdRows, withSamples) {
  SST.list = []; SST.map = new Map();
  const sample = [
    ['Zerodha', 'AB1234', 'STOCK', 'IRFC', '', '', 'INE053F01010', '', '', 600, 24.8, 83.5, '2026-11-10', 'Financial services', 'sample row: delete me'],
    ['Zerodha', 'AB1234', 'MF', 'Parag Parikh Flexi Cap Fund - Direct Plan', 'Direct', 'Growth', 'INF879O01027', '122639', '1234567/89', 679.155, 91.2854, 93.9483, '2026-11-10', 'Equity - Flexi Cap', 'sample row: delete me'],
    ['Zerodha', 'AB1234', 'SGB', 'SGBSEP28VI-GB', '', '', 'IN0020200195', '', '', 10, 5117, 14296.43, '2026-11-10', '', 'sample row: delete me'],
    ['Groww', '', 'ETF', 'NIFTYBEES', '', '', 'INF204KB14I2', '', '', 17, 164.26, 285.01, '2026-11-10', '', 'sample row: delete me']];
  const rows = [TEMPLATE_COLS, ...(withSamples ? sample : holdRows)];
  const help = [['How to fill the Holdings sheet'], [''], ['One row per holding (not per purchase). Quantity and Average buy price are the totals your broker shows.'],
    ['Required: Broker / Platform, Type, Name or Symbol, Quantity / Units, Average buy price. Everything else is optional.'],
    ['Type: MF, STOCK, SGB, ETF, BOND or OTHER (pick from the drop-down).'],
    ['Mutual funds: Plan = Direct or Regular; Option = Growth, IDCW or Bonus. These are read from the name if left empty.'],
    ['Matching on re-upload: first by ISIN, then by AMFI scheme code, then by name + plan + option. Fill ISIN or AMFI code whenever you can.'],
    ['Latest price / NAV: if blank, the holding is valued at your average buy price. Price as on: YYYY-MM-DD (today if blank).'],
    ['Delete the sample rows before uploading. A holding you leave out of a later upload is NOT deleted unless you tick the option in the preview.'],
    ['Your file is read inside your browser and is never sent anywhere.']];
  const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const sh1 = sheetXml(rows, [16, 16, 8, 44, 9, 9, 16, 12, 14, 12, 12, 14, 12, 22, 24], [['C2:C2000', 'MF,STOCK,SGB,ETF,BOND,OTHER'], ['E2:E2000', 'Direct,Regular'], ['F2:F2000', 'Growth,IDCW,Bonus']]), sh2 = sheetXml(help, null, null);
  const sst = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + SST.list.length + '" uniqueCount="' + SST.list.length + '">' + SST.list.map(t => '<si><t xml:space="preserve">' + xe(t) + '</t></si>').join('') + '</sst>';
  return zipStore([
    ['[Content_Types].xml', ct],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + R + '/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="' + R + '"><sheets><sheet name="Holdings" sheetId="1" r:id="rId1"/><sheet name="How to fill" sheetId="2" r:id="rId2"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + R + '/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="' + R + '/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="' + R + '/styles" Target="styles.xml"/><Relationship Id="rId4" Type="' + R + '/sharedStrings" Target="sharedStrings.xml"/></Relationships>'],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2F3F5C"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
    ['xl/worksheets/sheet1.xml', sh1],
    ['xl/worksheets/sheet2.xml', sh2],
    ['xl/sharedStrings.xml', sst]]);
}
export const planOptionOf = name => { const n = String(name || ''); return { plan: /direct/i.test(n) ? 'Direct' : /regular/i.test(n) ? 'Regular' : '', option: /idcw|dividend/i.test(n) ? 'IDCW' : /bonus/i.test(n) ? 'Bonus' : /growth/i.test(n) ? 'Growth' : '' }; };
const cap = s => { const t = S(s).toLowerCase(); return t ? t[0].toUpperCase() + t.slice(1) : ''; };
const asDate = v => { if (v == null || v === '') return null; if (typeof v === 'number') return v > 20000 ? new Date(Math.round((v - 25569) * 86400000)).setHours(12, 0, 0, 0) : null; return dateFrom(String(v)); };
/** Reads the downloaded template (sheet "Holdings"). Returns null if the file is not the template. */
export function parseTemplate(sheets) {
  const sh = sheets.find(s => /holdings/i.test(s.name)) || sheets[0]; if (!sh) return null;
  const hi = sh.rows.findIndex(r => r.map(S).some(x => /^name or symbol$/i.test(x))); if (hi < 0) return null;
  const hd = sh.rows[hi].map(S), ix = n => hd.findIndex(x => x.toLowerCase() === n.toLowerCase()), c = Object.fromEntries(TEMPLATE_COLS.map(n => [n, ix(n)]));
  const holdings = [], notes = [], KIND = new Set(KINDS.map(k => k[0]));
  sh.rows.slice(hi + 1).forEach((r, i) => {
    const g = n => (c[n] >= 0 ? r[c[n]] : null), name = S(g('Name or Symbol')); if (!name && !S(g('Broker / Platform'))) return;
    const line = hi + i + 2, units = N(g('Quantity / Units')), broker = S(g('Broker / Platform')); let kind = S(g('Type')).toUpperCase();
    if (/sample row/i.test(S(g('Notes')))) { notes.push('Row ' + line + ' is a sample row (Notes say "sample row") and was skipped.'); return; }
    if (!broker || !name || !(units > 0)) { notes.push('Row ' + line + ' skipped: Broker, Name and Quantity are required.'); return; }
    const isin = S(g('ISIN')).toUpperCase(); if (!KIND.has(kind)) { const k2 = classify({ name, isin, sector: S(g('Category / Sector')), itype: '' }); notes.push('Row ' + line + ' (' + name + '): Type "' + kind + '" not recognised, treated as ' + KIND_NAME[k2] + '.'); kind = k2; }
    const po = kind === 'MF' ? planOptionOf(name) : { plan: '', option: '' };
    holdings.push({ broker, accountId: S(g('Client ID / Account')), kind, name, isin, units, avgPrice: N(g('Average buy price')), price: N(g('Latest price / NAV')), priceDate: asDate(g('Price as on')),
      plan: cap(g('Plan')) || po.plan, option: (S(g('Option')).toUpperCase() === 'IDCW' ? 'IDCW' : cap(g('Option'))) || po.option, amfi: S(g('AMFI scheme code')), folio: S(g('Folio no.')), note: S(g('Notes')), tag: S(g('Category / Sector')) });
  });
  if (!holdings.length) notes.push('No holdings were found in the Holdings sheet.');
  return { holdings, clientId: '', asOn: null, broker: '', notes, multi: true };
}

// ---------- matching: ISIN, then AMFI code, then name + plan + option, then name alone ----------
const nameKey = h => norm(String(h.name || '').replace(/\b(direct|regular|plan|growth|idcw|dividend|bonus|option|fund)\b/gi, ' ').replace(/[^a-z0-9 ]/gi, ' ').replace(/\s+/g, ' '));
export function planImport2(existing, parsed, broker, accountId) {
  const multi = !!parsed.multi, plan = { add: [], update: [], same: [], missing: [], byName: [], dupes: [], dupIsin: [], elsewhere: [] }, used = new Set();
  const live = (existing || []).filter(x => !x.isArchived), brokersIn = new Set(parsed.holdings.map(h => norm(multi ? h.broker : broker)));
  parsed.holdings.forEach(h => {
    const hb = multi ? h.broker : broker, ha = multi ? h.accountId : accountId;
    const pool = live.filter(x => !used.has(x) && norm(x.broker) === norm(hb) && (!ha || !x.accountId || norm(x.accountId) === norm(ha)));
    let old = null, how = '';
    if (S(h.isin)) { old = pool.find(x => S(x.isin).toUpperCase() === S(h.isin).toUpperCase()); how = 'isin'; }
    if (!old && S(h.amfi)) { old = pool.find(x => S(x.amfi) && S(x.amfi) === S(h.amfi)); how = 'amfi'; }
    if (!old) { const po = h.kind === 'MF' ? { plan: h.plan || planOptionOf(h.name).plan, option: h.option || planOptionOf(h.name).option } : null;
      old = pool.find(x => norm(x.name) === norm(h.name) && (!po || ((x.plan || planOptionOf(x.name).plan) === po.plan && (x.option || planOptionOf(x.name).option) === po.option))); how = 'name'; }
    if (!old) { const cand = pool.filter(x => nameKey(x) === nameKey(h) && x.kind === h.kind); if (cand.length === 1 && !S(cand[0].isin) && !S(h.isin)) { old = cand[0]; how = 'fuzzy'; } }
    if (!old) { plan.add.push(h); return; }
    used.add(old); if (how === 'fuzzy' && h.kind === 'MF') plan.byName.push(h.name);
    const changed = Math.abs(old.units - h.units) > 1e-6 || Math.abs((old.avgPrice || 0) - h.avgPrice) > 1e-4 || (h.price > 0 && Math.abs((old.price || 0) - h.price) > 1e-4);
    (changed ? plan.update : plan.same).push({ old, now: h });
  });
  plan.missing = multi ? [] : live.filter(x => brokersIn.has(norm(x.broker)) && !used.has(x) && (multi || !accountId || !x.accountId || norm(x.accountId) === norm(accountId)));
  // possible duplicates inside the file: same fund name, different plan/option or ids
  const seen = new Map(); parsed.holdings.filter(h => h.kind === 'MF').forEach(h => { const po = planOptionOf(h.name), k = norm(h.broker) + '|' + nameKey(h) + '|' + (h.plan || po.plan) + '|' + (h.option || po.option); (seen.get(k) || seen.set(k, []).get(k)).push(h); });
  seen.forEach(a => { if (a.length > 1) plan.dupes.push(a.map(h => h.name).join('  /  ')); });
  // same ISIN twice in the file (any type)
  const byIsin = new Map(); parsed.holdings.forEach(h => { const i = S(h.isin).toUpperCase(); if (!i) return; const k = norm(multi ? h.broker : broker) + '|' + i; (byIsin.get(k) || byIsin.set(k, []).get(k)).push(h); });
  byIsin.forEach((a, k) => { if (a.length > 1) plan.dupIsin.push(k.split('|')[1] + ': ' + a.map(h => h.name).join(' / ')); });
  // a New row whose ISIN already exists under another broker or client ID
  plan.elsewhere = plan.add.map(h => { const i = S(h.isin).toUpperCase(); if (!i) return null; const o = live.find(x => S(x.isin).toUpperCase() === i); return o ? h.name + ' is also saved under ' + (o.broker || 'no broker') + (o.accountId ? ' / ' + o.accountId : '') : null; }).filter(Boolean);
  return plan;
}
export function applyImport2(book, plan, ctx, removeMissing) {
  const arr = book.brokerHoldings = book.brokerHoldings || [], when = ctx.asOn || Date.now();
  const rec = (h, base) => Object.assign(base, { broker: h.broker || ctx.broker, accountId: h.accountId || ctx.accountId || base.accountId || '', kind: h.kind, name: h.name, isin: h.isin || base.isin || '', units: h.units, avgPrice: h.avgPrice, price: h.price > 0 ? h.price : (base.price || 0), priceDate: h.priceDate || when, tag: h.tag || base.tag || '', plan: h.plan || base.plan || '', option: h.option || base.option || '', amfi: h.amfi || base.amfi || '', folio: h.folio || base.folio || '', note: h.note || base.note || '', isArchived: false });
  plan.add.forEach(h => arr.push(rec(h, {})));
  plan.update.forEach(({ old, now }) => { const nm = old.name; rec(now, old); if (S(nm)) old.name = nm; });
  plan.same.forEach(({ old, now }) => { old.priceDate = now.priceDate || when; if (!old.accountId && (now.accountId || ctx.accountId)) old.accountId = now.accountId || ctx.accountId; });
  if (removeMissing) plan.missing.forEach(x => { x.isArchived = true; x.deletedAt = Date.now(); });
}
