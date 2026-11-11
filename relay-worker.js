// Arthik price relay — paste this into a free Cloudflare Worker (Workers & Pages > Create > Hello World > Edit code).
// It only forwards to the three price sites below and adds the permission header browsers need.
const ALLOW = ['query1.finance.yahoo.com', 'www.amfiindia.com', 'www.goldapi.io'];
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'x-access-token', 'access-control-allow-methods': 'GET, OPTIONS' };
export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url).searchParams.get('u');
    let t; try { t = new URL(u); } catch { return new Response('Missing ?u=', { status: 400, headers: CORS }); }
    if (t.protocol !== 'https:' || !ALLOW.includes(t.hostname)) return new Response('Not allowed', { status: 403, headers: CORS });
    const h = { 'User-Agent': 'Mozilla/5.0' }; const k = req.headers.get('x-access-token'); if (k) h['x-access-token'] = k;
    const r = await fetch(t.toString(), { headers: h });
    return new Response(r.body, { status: r.status, headers: { ...CORS, 'content-type': r.headers.get('content-type') || 'text/plain' } });
  }
};
