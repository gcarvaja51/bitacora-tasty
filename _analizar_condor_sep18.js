'use strict';
// SOLO LECTURA. Analisis completo del iron condor SPX 2026-09-18:
// credito neto real (con comisiones), valor actual, breakevens y probabilidades.
require('dotenv').config();
const { TastytradeClient } = require('./src/tastytrade');

const tt = new TastytradeClient({
  clientSecret:  process.env.TT_CLIENT_SECRET,
  refreshToken:  process.env.TT_REFRESH_TOKEN,
  sessionToken:  process.env.TT_SESSION_TOKEN,
  accountNumber: process.env.TT_ACCOUNT_NUMBER,
});

// N(x) por Abramowitz-Stegun (misma que usa src/tastytrade.js)
function N(x) {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x)/Math.sqrt(2);
  const t = 1/(1+p*x);
  const y = 1-(((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t)*Math.exp(-x*x);
  return 0.5*(1+sign*y);
}
// Probabilidad RISK-NEUTRAL de terminar ITM = N(d2) para call, N(-d2) para put.
function probITM(S, K, T, vol, tipo) {
  const d2 = (Math.log(S/K) - 0.5*vol*vol*T) / (vol*Math.sqrt(T));
  return tipo === 'C' ? N(d2) : N(-d2);
}

(async () => {
  // ── 1) Transacciones reales del vencimiento, con comisiones ──
  const tx = await tt.getAllTransactions('2026-07-01', '2026-08-22');
  const legs = tx.filter(t => (t.symbol || '').includes('260918') && /SPX /.test(t.symbol || ''));
  legs.sort((a,b) => (a['executed-at']||'').localeCompare(b['executed-at']||''));

  let cash = 0, fees = 0;
  console.log('=== MOVIMIENTOS DEL VENCIMIENTO 2026-09-18 ===');
  for (const t of legs) {
    const v = parseFloat(t.value || 0);
    const signo = (t['value-effect'] === 'Credit') ? 1 : -1;
    const com = parseFloat(t.commission || 0) + parseFloat(t['clearing-fees'] || 0)
              + parseFloat(t['proprietary-index-option-fees'] || 0)
              + parseFloat(t['regulatory-fees'] || 0);
    cash += signo * v;
    fees += com;
    console.log([
      (t['executed-at']||'').slice(0,16).replace('T',' '),
      (t.action||'').padEnd(14),
      (t.symbol||'').trim().padEnd(22),
      ('@' + t.price).padEnd(9),
      (signo > 0 ? '+' : '-') + v,
      'com=' + com.toFixed(2),
    ].join(' | '));
  }
  console.log('\ncredito neto BRUTO : $' + cash.toFixed(2));
  console.log('comisiones+fees    : $' + fees.toFixed(2));
  console.log('credito neto REAL  : $' + (cash - fees).toFixed(2));

  // ── 2) Valor actual de las 4 patas vivas ──
  const LEGS = [
    { sym:'SPX   260918C07915000', dir:+1, tipo:'C', k:7915 },  // long
    { sym:'SPX   260918C07900000', dir:-1, tipo:'C', k:7900 },  // short
    { sym:'SPX   260918P07400000', dir:-1, tipo:'P', k:7400 },  // short
    { sym:'SPX   260918P07385000', dir:+1, tipo:'P', k:7385 },  // long
  ];
  const p = LEGS.map(l => `symbols[]=${encodeURIComponent(l.sym)}`).join('&');
  const md = await tt._req(`/market-data?${p}`);
  const m = {}; (md.data?.items ?? []).forEach(i => { m[i.symbol] = i; });

  const spotRes = await tt._req(`/market-data?symbols[]=SPX`);
  const S = parseFloat((spotRes.data?.items ?? [])[0]?.mark || 0);

  let costoCerrar = 0, delta = 0, theta = 0, vega = 0;
  for (const l of LEGS) {
    const q = m[l.sym];
    const mark = parseFloat(q.mark);
    costoCerrar += (l.dir === -1 ? mark : -mark) * 100;   // recomprar shorts, vender longs
    delta += l.dir * parseFloat(q.delta) * 100;
    theta += l.dir * parseFloat(q.theta) * 100;
    vega  += l.dir * parseFloat(q.vega)  * 100;
  }

  const ivCall = parseFloat(m['SPX   260918C07900000'].volatility);
  const ivPut  = parseFloat(m['SPX   260918P07400000'].volatility);

  // ── 3) Tiempo a vencimiento: SPX mensual liquida AM el 18-sep 09:30 ET ──
  const ahora = new Date();
  const venc  = new Date('2026-09-18T13:30:00.000Z');
  const T = (venc - ahora) / (1000*60*60*24*365);
  const dias = (venc - ahora) / (1000*60*60*24);

  const creditoNeto = cash - fees;
  const c = creditoNeto / 100;                 // en puntos de indice
  const beAlto = 7900 + c;
  const beBajo = 7400 - c;

  const pCallITM = probITM(S, 7900, T, ivCall, 'C');
  const pPutITM  = probITM(S, 7400, T, ivPut,  'P');
  const pMaxProfit = 1 - pCallITM - pPutITM;
  const pArribaBE = probITM(S, beAlto, T, ivCall, 'C');
  const pAbajoBE  = probITM(S, beBajo, T, ivPut,  'P');
  const pProfit   = 1 - pArribaBE - pAbajoBE;

  console.log('\n=== POSICION HOY ===');
  console.log('spot SPX                : ' + S);
  console.log('dias a vencimiento      : ' + dias.toFixed(2));
  console.log('IV call 7900 / put 7400 : ' + (ivCall*100).toFixed(2) + '% / ' + (ivPut*100).toFixed(2) + '%');
  console.log('costo de cerrar ahora   : $' + costoCerrar.toFixed(2));
  console.log('P&L si cierra ahora     : $' + (creditoNeto - costoCerrar).toFixed(2));
  console.log('delta / theta / vega    : ' + delta.toFixed(1) + ' / ' + theta.toFixed(1) + ' / ' + vega.toFixed(1));

  console.log('\n=== RIESGO / RECOMPENSA (ancho 15 pts por lado) ===');
  console.log('max ganancia (ambos expiran sin valor) : $' + creditoNeto.toFixed(2));
  console.log('max perdida (un lado full ITM)         : $' + (1500 - creditoNeto).toFixed(2));
  console.log('ratio recompensa/riesgo                : ' + (creditoNeto/(1500-creditoNeto)).toFixed(3) + ' : 1');
  console.log('breakeven bajo / alto                  : ' + beBajo.toFixed(2) + ' / ' + beAlto.toFixed(2));
  console.log('colchon abajo / arriba                 : ' + (S-beBajo).toFixed(0) + ' pts (' + ((S-beBajo)/S*100).toFixed(2) + '%) / ' + (beAlto-S).toFixed(0) + ' pts (' + ((beAlto-S)/S*100).toFixed(2) + '%)');

  // Las probabilidades NO se calculan aca, a proposito. Hacerlo con una sola IV por lado
  // (N(d2) plano) daba P(S<7400) = 21,6% cuando el propio mercado, que cotiza el spread
  // 7400/7385 a 1,70 sobre 15 de ancho, no esta pagando mas de ~16%. La causa es el skew:
  // el put LARGO del 7385 cotiza con IV MAS ALTA (16,11%) que el corto del 7400 (15,90%),
  // y eso abarata el spread y baja la probabilidad real. Con IV plana se sobreestimaba el
  // riesgo del lado put en casi 9 puntos porcentuales.
  console.log('\n>> Probabilidades: correr _prob_condor_sep18.js (ajusta por sonrisa y se');
  console.log('   valida contra el precio observado de los dos spreads verticales).');
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
