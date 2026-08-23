'use strict';
// SOLO LECTURA. Agrega OHLC del dia + beta al estudio de Max Pain.
require('dotenv').config();
const fs = require('fs');
const { TastytradeClient } = require('./src/tastytrade');
const tt = new TastytradeClient({
  clientSecret: process.env.TT_CLIENT_SECRET, refreshToken: process.env.TT_REFRESH_TOKEN,
  sessionToken: process.env.TT_SESSION_TOKEN, accountNumber: process.env.TT_ACCOUNT_NUMBER });

(async () => {
  const U = JSON.parse(fs.readFileSync('_universo_dedup.json', 'utf8'));
  const syms = U.map(o => o.sym);
  const q = {};
  for (let i = 0; i < syms.length; i += 50) {
    const p = syms.slice(i, i+50).map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
    const d = await tt._req(`/market-data?${p}`);
    (d.data?.items ?? []).forEach(it => { q[it.symbol] = it; });
  }
  const out = [];
  for (const o of U) {
    const i = q[o.sym]; if (!i) continue;
    const open = parseFloat(i.open || 0), hi = parseFloat(i['day-high-price'] || 0),
          lo = parseFloat(i['day-low-price'] || 0), close = parseFloat(i.close || i.last || 0),
          prev = parseFloat(i['prev-close'] || 0), beta = parseFloat(i.beta || 1);
    if (!open || !hi || !lo || !close || !prev) continue;
    out.push({ ...o, open, hi, lo, close, prev, beta, volume: parseFloat(i.volume || 0) });
  }
  fs.writeFileSync('_estudio_ohlc.json', JSON.stringify(out, null, 2));
  console.log(`con OHLC completo: ${out.length} de ${U.length}`);
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
