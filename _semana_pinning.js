'use strict';
// SOLO LECTURA. Trae el historico diario (Yahoo) de los 113 subyacentes del estudio
// para medir el comportamiento en la SEMANA previa al vencimiento.
const fs = require('fs');

// Yahoo usa tickers propios para los indices
const MAP = { SPX:'^GSPC', NDX:'^NDX', RUT:'^RUT', VIX:'^VIX' };

async function barras(sym) {
  const y = MAP[sym] || sym;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?interval=1d&range=3mo`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const res = j.chart?.result?.[0];
  if (!res) throw new Error('sin datos');
  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close?.[i] == null) continue;
    out.push({
      fecha: new Date(ts[i]*1000).toISOString().slice(0,10),
      o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i],
    });
  }
  return out;
}

(async () => {
  const U = JSON.parse(fs.readFileSync('_estudio_ohlc.json', 'utf8'));
  const out = [];
  let ok = 0, fail = 0;
  for (const o of U) {
    try {
      const b = await barras(o.sym);
      if (b.length < 30) { fail++; continue; }
      out.push({ sym: o.sym, maxPain: o.maxPain, barras: b });
      ok++;
      if (ok % 20 === 0) console.log(`  ${ok} listos...`);
    } catch (e) { fail++; console.log(`  ${o.sym}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 120));   // no martillar a Yahoo
  }
  fs.writeFileSync('_historico.json', JSON.stringify(out));
  console.log(`\nhistorico obtenido: ${ok}  |  fallos: ${fail}`);
  const ej = out[0];
  console.log(`ejemplo ${ej.sym}: ${ej.barras.length} barras, de ${ej.barras[0].fecha} a ${ej.barras[ej.barras.length-1].fecha}`);
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
