'use strict';
// Diagnostico del Max Pain de SPX 2026-09-18: de donde sale el minimo.
require('dotenv').config();
const { TastytradeClient } = require('./src/tastytrade');
const tt = new TastytradeClient({
  clientSecret: process.env.TT_CLIENT_SECRET, refreshToken: process.env.TT_REFRESH_TOKEN,
  sessionToken: process.env.TT_SESSION_TOKEN, accountNumber: process.env.TT_ACCOUNT_NUMBER,
});
const EXP = '2026-09-18';

(async () => {
  const d = await tt._req('/option-chains/SPX/nested');
  const chain = (d.data?.items ?? [])[0];
  console.log('roots en la respuesta:', (d.data?.items ?? []).map(i => i['root-symbol'] || i['underlying-symbol']).join(', '));
  const exps = (chain?.expirations ?? []);
  console.log('vencimientos con fecha ' + EXP + ':', exps.filter(e => e['expiration-date'] === EXP)
    .map(e => `${e['option-chain-type']}/${e['expiration-type']}/settlement=${e['settlement-type']}`).join(' | '));

  const exp = exps.find(e => e['expiration-date'] === EXP);
  const strikes = exp.strikes ?? [];
  const syms = [];
  strikes.forEach(k => { if (k.call) syms.push(k.call); if (k.put) syms.push(k.put); });

  const oi = {};
  for (let i = 0; i < syms.length; i += 50) {
    const p = syms.slice(i, i+50).map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
    const r = await tt._req(`/market-data?${p}`);
    (r.data?.items ?? []).forEach(it => { oi[it.symbol] = parseInt(it['open-interest'] || 0, 10); });
  }

  const filas = strikes.map(k => ({ strike: +k['strike-price'], c: oi[k.call]||0, p: oi[k.put]||0 }))
                       .filter(f => f.c + f.p > 0).sort((a,b) => a.strike - b.strike);

  const totC = filas.reduce((a,f)=>a+f.c,0), totP = filas.reduce((a,f)=>a+f.p,0);
  console.log(`\nstrikes con OI: ${filas.length}  | OI calls ${totC.toLocaleString()}  | OI puts ${totP.toLocaleString()}`);
  console.log('rango de strikes: ' + filas[0].strike + ' a ' + filas[filas.length-1].strike);

  console.log('\n--- TOP 12 strikes por OI total ---');
  [...filas].sort((a,b)=>(b.c+b.p)-(a.c+a.p)).slice(0,12)
    .forEach(f => console.log(`  ${String(f.strike).padStart(6)}  call ${String(f.c).padStart(7)}  put ${String(f.p).padStart(7)}`));

  console.log('\n--- OI de CALLS en strikes MUY bajos (deep ITM) ---');
  filas.filter(f => f.strike < 5000 && f.c > 0).slice(0,15)
    .forEach(f => console.log(`  ${String(f.strike).padStart(6)}  call OI ${f.c}`));

  const pago = (K) => filas.reduce((a,f) =>
    a + (K > f.strike ? f.c*(K-f.strike) : 0) + (f.strike > K ? f.p*(f.strike-K) : 0), 0);

  const curva = filas.map(f => ({ K: f.strike, pago: pago(f.strike) }));
  curva.sort((a,b) => a.pago - b.pago);
  console.log('\n--- 10 strikes de MENOR pago total (el minimo = Max Pain) ---');
  curva.slice(0,10).forEach(c => console.log(`  ${String(c.K).padStart(6)}  pago ${(c.pago/1e9).toFixed(3)} B`));

  console.log('\n--- pago alrededor de 7400-7800, cada 50 ---');
  for (let K = 7300; K <= 7800; K += 50) console.log(`  ${K}  ${(pago(K)/1e9).toFixed(3)} B`);
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
