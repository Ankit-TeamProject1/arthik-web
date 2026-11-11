// Live prices: same free sources as the Android app. Browsers block these sites directly (no CORS),
// so a small "price relay" (Cloudflare Worker, see relay-worker.js) can be set in Settings > Prices.
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const AMFI = 'https://www.amfiindia.com/spages/NAVAll.txt';
const GOLD = 'https://www.goldapi.io/api/';
let directBlocked = false;

export class PriceError extends Error { constructor(m, blocked) { super(m); this.blocked = !!blocked; } }

async function getRaw(url, opts, relay) {
  const tryRelay = async () => { const r = await fetch(relay.replace(/\/+$/, '') + '/?u=' + encodeURIComponent(url), opts); if (!r.ok) throw new PriceError('HTTP ' + r.status); return r; };
  if (relay && directBlocked) return tryRelay();
  try { const r = await fetch(url, opts); if (!r.ok) throw new PriceError('HTTP ' + r.status); return r; }
  catch (e) {
    if (e instanceof PriceError) throw e;
    if (relay) { directBlocked = true; return tryRelay(); }
    throw new PriceError('The browser blocked this request. Set up the price relay in Settings › Prices.', true);
  }
}

export async function stockPrice(symbol, exch, relay) {
  const sym = String(symbol || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!sym) throw new PriceError('No symbol');
  const sfx = exch === 'BSE' || exch === 'BO' ? '.BO' : '.NS';
  const j = await (await getRaw(YAHOO + encodeURIComponent(sym) + sfx, {}, relay)).json();
  const p = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta && j.chart.result[0].meta.regularMarketPrice;
  if (!(p > 0)) throw new PriceError('No price for ' + sym);
  return p;
}

// One download for all funds: code;isin;isin2;name;nav;date
export async function amfiNavs(relay) {
  const t = await (await getRaw(AMFI, {}, relay)).text(), byCode = {}, byIsin = {};
  t.split(/\r?\n/).forEach(l => { const p = l.split(';'); if (p.length < 5) return; const nav = parseFloat(p[4]); if (!(nav > 0)) return;
    if (/^\d+$/.test(p[0].trim())) byCode[p[0].trim()] = nav; [p[1], p[2]].forEach(i => { i = (i || '').trim(); if (i && i !== '-') byIsin[i] = nav; }); });
  if (!Object.keys(byCode).length) throw new PriceError('The NAV file was empty');
  return { byCode, byIsin };
}

// ₹ per gram for gold (24K/22K/18K/14K) and silver (999/925)
export async function metalRates(key, relay) {
  if (!key) throw new PriceError('Add your GoldAPI key in Settings › Prices');
  const one = async m => { const j = await (await getRaw(GOLD + m + '/INR', { headers: { 'x-access-token': key } }, relay)).json(); if (!(j && j.price_gram_24k > 0)) throw new PriceError((j && j.error) || 'No ' + m + ' rate'); return j; };
  const [g, s] = await Promise.all([one('XAU'), one('XAG')]);
  return { gold: { '24K': g.price_gram_24k, '22K': g.price_gram_22k, '18K': g.price_gram_18k, '14K': g.price_gram_14k }, silver: { '999': s.price_gram_24k, '925': s.price_gram_24k * 0.925 } };
}

const r2 = n => Math.round(n * 100) / 100;
export const caratRate = (m, rates) => { const x = m.metalType === 'SILVER' ? rates.silver[m.caratType] : rates.gold[m.caratType]; return x > 0 ? r2(x) : null; };

// Stocks, ETFs and funds. Returns { prices: Map(uid -> price), failed: [names], skipped }
export async function marketPrices(holdings, relay) {
  const prices = new Map(), failed = []; const live = holdings.filter(x => !x.isArchived);
  const mf = live.filter(x => x.kind === 'MF'), st = live.filter(x => x.kind === 'STOCK' || x.kind === 'ETF');
  let nav = null;
  if (mf.length) { try { nav = await amfiNavs(relay); } catch (e) { mf.forEach(x => failed.push(x.name)); if (e.blocked) return { prices: prices, failed, blocked: true }; } }
  if (nav) mf.forEach(x => { const p = (x.amfi && nav.byCode[String(x.amfi).trim()]) || (x.isin && nav.byIsin[String(x.isin).trim()]); if (p) prices.set(x.uid, p); else failed.push(x.name); });
  let blocked = false;
  await Promise.all(st.map(async x => { try { let p; try { p = await stockPrice(x.name, x.exchange || 'NSE', relay); } catch (e) { if (x.exchange || e.blocked || !/No price|HTTP 404/.test(e.message)) throw e; p = await stockPrice(x.name, 'BSE', relay); } prices.set(x.uid, p); } catch (e) { failed.push(x.name); if (e.blocked) blocked = true; } }));
  return { prices, failed, blocked };
}
