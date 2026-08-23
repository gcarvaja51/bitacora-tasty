'use strict';
// SOLO LECTURA. Cierre real de hoy contra el Max Pain de la cadena del 21-ago.
require('dotenv').config();
const fs = require('fs');
const { TastytradeClient } = require('./src/tastytrade');

const tt = new TastytradeClient({
  clientSecret: process.env.TT_CLIENT_SECRET, refreshToken: process.env.TT_REFRESH_TOKEN,
  sessionToken: process.env.TT_SESSION_TOKEN, accountNumber: process.env.TT_ACCOUNT_NUMBER });

// Max Pain calculado hoy sobre la cadena que vence 2026-08-21
const MP = [
  ['SPX', 7670, 'SPXW PM'], ['SPY', 755, 'SPY'], ['QQQ', 708, 'QQQ'], ['NDX', 29430, 'NDXP PM'],
  ['ADBE', 240, ''], ['BA', 220, ''], ['BE', 202.5, ''], ['GAP', 20.5, ''], ['IBIT', 36, ''],
  ['JBLU', 5.5, ''], ['NFLX', 76, ''], ['NIO', 4, ''], ['NU', 14, ''], ['SOFI', 17.5, ''],
];

(async () => {
  const syms = MP.map(m => m[0]);
  const p = syms.map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
  const d = await tt._req(`/market-data?${p}`);
  const q = {}; (d.data?.items ?? []).forEach(i => { q[i.symbol] = i; });

  console.log('capturado ' + new Date().toISOString());
  console.log('sym  | cierre    | prev cls  | var %  | max pain | dist cierre | %      | converge?');
  console.log('-----+-----------+-----------+--------+----------+-------------+--------+----------');
  const out = [];
  for (const [sym, mp, nota] of MP) {
    const i = q[sym] || {};
    const cierre = parseFloat(i.close || i.last || i.mark || 0);
    const prev   = parseFloat(i['prev-close'] || 0);
    const varPct = prev ? (cierre/prev - 1) * 100 : NaN;
    const dist   = cierre - mp;
    const distPct= mp ? dist/mp*100 : NaN;
    // ¿el cierre quedo MAS cerca del max pain que la apertura del dia (prev close)?
    const acerco = Math.abs(cierre - mp) < Math.abs(prev - mp);
    out.push({ sym, nota, cierre, prev, varPct, maxPain: mp, dist, distPct, acerco });
    console.log(
      sym.padEnd(4) + ' | ' + String(cierre.toFixed(2)).padStart(9) + ' | ' +
      String(prev.toFixed(2)).padStart(9) + ' | ' + String(varPct.toFixed(2)+'%').padStart(6) + ' | ' +
      String(mp).padStart(8) + ' | ' + String((dist>=0?'+':'')+dist.toFixed(2)).padStart(11) + ' | ' +
      String((distPct>=0?'+':'')+distPct.toFixed(2)+'%').padStart(6) + ' | ' + (acerco ? 'SI' : 'no')
    );
  }
  const n = out.length, si = out.filter(o => o.acerco).length;
  console.log(`\nse acercaron al Max Pain: ${si} de ${n}  (${(si/n*100).toFixed(0)}%)`);
  fs.writeFileSync('_cierres_vs_maxpain.json', JSON.stringify(out, null, 2));
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
