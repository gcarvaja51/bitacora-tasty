'use strict';
// SOLO LECTURA. Agrega el cierre real de hoy al estudio de Max Pain y calcula
// las metricas que sirven para juzgar la teoria de la imantacion.
require('dotenv').config();
const fs = require('fs');
const { TastytradeClient } = require('./src/tastytrade');

const tt = new TastytradeClient({
  clientSecret: process.env.TT_CLIENT_SECRET, refreshToken: process.env.TT_REFRESH_TOKEN,
  sessionToken: process.env.TT_SESSION_TOKEN, accountNumber: process.env.TT_ACCOUNT_NUMBER });

(async () => {
  const est = JSON.parse(fs.readFileSync('_estudio_maxpain.json', 'utf8'));
  const syms = [...new Set(est.map(e => e.sym))];

  const q = {};
  for (let i = 0; i < syms.length; i += 50) {
    const p = syms.slice(i, i+50).map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
    const d = await tt._req(`/market-data?${p}`);
    (d.data?.items ?? []).forEach(it => { q[it.symbol] = it; });
  }

  const out = [];
  for (const e of est) {
    const i = q[e.sym]; if (!i) continue;
    const cierre = parseFloat(i.close || i.last || i.mark || 0);
    const prev   = parseFloat(i['prev-close'] || e.prev || 0);
    if (!cierre || !prev) continue;
    const distCierrePct = (cierre - e.maxPain) / e.maxPain * 100;
    const distPrevPct   = (prev   - e.maxPain) / e.maxPain * 100;
    out.push({
      ...e, cierre, prev,
      varDiaPct: (cierre/prev - 1) * 100,
      distCierrePct, distPrevPct,
      // ¿se acerco al Max Pain durante la sesion?
      convergio: Math.abs(distCierrePct) < Math.abs(distPrevPct),
      // cuanto se acerco (positivo = se acerco)
      acercamientoPct: Math.abs(distPrevPct) - Math.abs(distCierrePct),
      // ¿cerro DENTRO del piso plano del Max Pain?
      dentroDelPiso: cierre >= e.piso01.lo && cierre <= e.piso01.hi,
    });
  }

  fs.writeFileSync('_estudio_completo.json', JSON.stringify(out, null, 2));

  const n = out.length;
  const conv = out.filter(o => o.convergio).length;
  const dentro = out.filter(o => o.dentroDelPiso).length;
  const abs = out.map(o => Math.abs(o.distCierrePct)).sort((a,b)=>a-b);
  const med = abs[Math.floor(abs.length/2)];
  const dentro1 = out.filter(o => Math.abs(o.distCierrePct) <= 1).length;
  const dentro2 = out.filter(o => Math.abs(o.distCierrePct) <= 2).length;
  const dentro5 = out.filter(o => Math.abs(o.distCierrePct) <= 5).length;

  console.log(`capturado ${new Date().toISOString()}`);
  console.log(`\n=== RESULTADO SOBRE ${n} CADENAS (vencimiento 2026-08-21) ===`);
  console.log(`  convergieron hacia el Max Pain : ${conv} (${(conv/n*100).toFixed(1)}%)   [azar = 50%]`);
  console.log(`  cerraron DENTRO del piso plano : ${dentro} (${(dentro/n*100).toFixed(1)}%)`);
  console.log(`  |distancia| mediana al cierre  : ${med.toFixed(2)}%`);
  console.log(`  cerraron a <=1% del Max Pain   : ${dentro1} (${(dentro1/n*100).toFixed(1)}%)`);
  console.log(`  cerraron a <=2%                : ${dentro2} (${(dentro2/n*100).toFixed(1)}%)`);
  console.log(`  cerraron a <=5%                : ${dentro5} (${(dentro5/n*100).toFixed(1)}%)`);
  console.log(`  acercamiento medio             : ${(out.reduce((a,o)=>a+o.acercamientoPct,0)/n).toFixed(3)} pp`);

  console.log('\n--- los 10 que MAS cerca cerraron ---');
  [...out].sort((a,b)=>Math.abs(a.distCierrePct)-Math.abs(b.distCierrePct)).slice(0,10)
    .forEach(o => console.log(`  ${o.sym.padEnd(6)} cierre ${String(o.cierre.toFixed(2)).padStart(10)}  MP ${String(o.maxPain).padStart(9)}  ${o.distCierrePct.toFixed(2)}%`));
  console.log('\n--- los 10 que MAS lejos ---');
  [...out].sort((a,b)=>Math.abs(b.distCierrePct)-Math.abs(a.distCierrePct)).slice(0,10)
    .forEach(o => console.log(`  ${o.sym.padEnd(6)} cierre ${String(o.cierre.toFixed(2)).padStart(10)}  MP ${String(o.maxPain).padStart(9)}  ${o.distCierrePct.toFixed(2)}%`));
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
