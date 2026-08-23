'use strict';
// SOLO LECTURA. Max Pain de cada subyacente con posicion abierta en Tastytrade,
// calculado sobre el open interest de la cadena del vencimiento que se tiene.
//
// Definicion: Max Pain = el strike donde el pago total a los TENEDORES de opciones
// es minimo (o sea, donde mas primas vencen sin valor). Para cada strike candidato K:
//     pago(K) = SUM_calls  OI_c * max(0, K  - Kc)
//             + SUM_puts   OI_p * max(0, Kp - K)
// y se busca el K que lo minimiza.
require('dotenv').config();
const { TastytradeClient } = require('./src/tastytrade');

const tt = new TastytradeClient({
  clientSecret: process.env.TT_CLIENT_SECRET,
  refreshToken: process.env.TT_REFRESH_TOKEN,
  sessionToken: process.env.TT_SESSION_TOKEN,
  accountNumber: process.env.TT_ACCOUNT_NUMBER,
});

const VENTANA_PCT = 99;   // cadena COMPLETA: una ventana estrecha recortaba OI y movia el resultado

async function spot(sym) {
  const d = await tt._req(`/market-data?symbols[]=${encodeURIComponent(sym)}`);
  const i = (d.data?.items ?? [])[0];
  return i ? { mark: parseFloat(i.mark || i.last || 0), last: parseFloat(i.last || 0),
               prevClose: parseFloat(i['prev-close'] || 0) } : null;
}

async function cadena(sym, expiry) {
  const d = await tt._req(`/option-chains/${encodeURIComponent(sym)}/nested`);
  const chain = (d.data?.items ?? [])[0];
  const exp = (chain?.expirations ?? []).find(e => e['expiration-date'] === expiry);
  return exp ? (exp.strikes ?? []) : null;
}

async function oiDe(symbols) {
  const out = {};
  for (let i = 0; i < symbols.length; i += 50) {
    const p = symbols.slice(i, i+50).map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
    const d = await tt._req(`/market-data?${p}`);
    (d.data?.items ?? []).forEach(it => { out[it.symbol] = parseInt(it['open-interest'] || 0, 10); });
  }
  return out;
}

function maxPain(filas) {
  // filas: [{ strike, oiCall, oiPut }]
  const strikes = filas.map(f => f.strike).sort((a,b) => a-b);
  let mejor = null;
  for (const K of strikes) {
    let pago = 0;
    for (const f of filas) {
      if (K > f.strike) pago += f.oiCall * (K - f.strike);   // calls ITM
      if (f.strike > K) pago += f.oiPut  * (f.strike - K);   // puts ITM
    }
    if (!mejor || pago < mejor.pago) mejor = { K, pago };
  }
  return mejor;
}

const OBJETIVOS = [
  ['ADBE','2026-09-18'], ['BA','2026-09-18'], ['BE','2026-09-18'], ['GAP','2026-09-04'],
  ['IBIT','2026-09-25'], ['JBLU','2026-09-25'], ['NFLX','2026-09-18'], ['NIO','2026-11-20'],
  ['NU','2026-09-18'], ['NU','2026-11-20'], ['SOFI','2026-09-25'], ['SPX','2026-09-18'],
];

(async () => {
  const res = [];
  for (const [sym, exp] of OBJETIVOS) {
    try {
      const s = await spot(sym);
      const strikes = await cadena(sym, exp);
      if (!strikes) { console.log(`${sym} ${exp}: sin cadena para ese vencimiento`); continue; }

      const lo = s.mark * (1 - VENTANA_PCT), hi = s.mark * (1 + VENTANA_PCT);
      const usar = strikes.filter(k => { const v = parseFloat(k['strike-price']); return v >= lo && v <= hi; });

      const syms = [];
      usar.forEach(k => { if (k.call) syms.push(k.call); if (k.put) syms.push(k.put); });
      const oi = await oiDe(syms);

      const filas = usar.map(k => ({
        strike: parseFloat(k['strike-price']),
        oiCall: oi[k.call] || 0,
        oiPut:  oi[k.put]  || 0,
      })).filter(f => f.oiCall + f.oiPut > 0);

      if (!filas.length) { console.log(`${sym} ${exp}: sin open interest utilizable`); continue; }

      const mp = maxPain(filas);
      const totOI = filas.reduce((a,f) => a + f.oiCall + f.oiPut, 0);
      res.push({ sym, exp, spot: s.mark, maxPain: mp.K, strikes: filas.length, oi: totOI,
                 dist: s.mark - mp.K });
      console.log(`${sym.padEnd(5)} ${exp}  spot ${String(s.mark).padStart(9)}  MAX PAIN ${String(mp.K).padStart(8)}  ` +
                  `dist ${(s.mark - mp.K >= 0 ? '+' : '') + (s.mark - mp.K).toFixed(2)}  ` +
                  `(${filas.length} strikes, OI ${totOI.toLocaleString()})`);
    } catch (e) {
      console.log(`${sym} ${exp}: ERROR ${e.message}`);
    }
  }
  require('fs').writeFileSync('_max_pain_resultado_full.json', JSON.stringify(res, null, 2));
  console.log('\nguardado en _max_pain_resultado_full.json');
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
