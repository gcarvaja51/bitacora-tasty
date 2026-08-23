'use strict';
// SOLO LECTURA. Cierre de hoy de cada subyacente abierto, contra su Max Pain.
require('dotenv').config();
const fs = require('fs');
const { TastytradeClient } = require('./src/tastytrade');

const tt = new TastytradeClient({
  clientSecret: process.env.TT_CLIENT_SECRET,
  refreshToken: process.env.TT_REFRESH_TOKEN,
  sessionToken: process.env.TT_SESSION_TOKEN,
  accountNumber: process.env.TT_ACCOUNT_NUMBER,
});

(async () => {
  const mp = JSON.parse(fs.readFileSync('_max_pain_resultado_full.json', 'utf8'));
  const subs = [...new Set(mp.map(r => r.sym))];
  const p = subs.map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
  const d = await tt._req(`/market-data?${p}`);
  const q = {}; (d.data?.items ?? []).forEach(i => { q[i.symbol] = i; });

  console.log('leido a las ' + new Date().toISOString());
  console.log('sym   | cierre   | prev cls | var %   | max pain | dist al MP | dir. para converger');
  console.log('------+----------+----------+---------+----------+------------+--------------------');
  const out = [];
  for (const r of mp) {
    const i = q[r.sym] || {};
    const cierre = parseFloat(i.close || i.last || i.mark || 0);
    const prev   = parseFloat(i['prev-close'] || 0);
    const varPct = prev ? (cierre/prev - 1) * 100 : NaN;
    const dist   = cierre - r.maxPain;
    out.push({ ...r, cierre, prev, varPct, distCierre: dist });
    console.log(
      r.sym.padEnd(5) + ' | ' +
      String(cierre.toFixed(2)).padStart(8) + ' | ' +
      String(prev.toFixed(2)).padStart(8) + ' | ' +
      String(varPct.toFixed(2) + '%').padStart(7) + ' | ' +
      String(r.maxPain).padStart(8) + ' | ' +
      String((dist >= 0 ? '+' : '') + dist.toFixed(2)).padStart(10) + ' | ' +
      (Math.abs(dist) < 1e-9 ? 'ya esta' : (dist > 0 ? 'BAJAR' : 'SUBIR'))
    );
  }
  fs.writeFileSync('_cierres_hoy_resultado.json', JSON.stringify(out, null, 2));
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
