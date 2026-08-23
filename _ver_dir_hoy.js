'use strict';
// SOLO LECTURA. Cotiza en vivo (TastyTrade, no el sandbox diferido) el bull call
// spread 7655/7665 de SPXW 0DTE que esta abierto en Tradier.
require('dotenv').config();
const { TastytradeClient } = require('./src/tastytrade');

const tt = new TastytradeClient({
  clientSecret: process.env.TT_CLIENT_SECRET,
  refreshToken: process.env.TT_REFRESH_TOKEN,
  sessionToken: process.env.TT_SESSION_TOKEN,
  accountNumber: process.env.TT_ACCOUNT_NUMBER,
});

const LARGO = 'SPXW  260821C07655000';   // +1
const CORTO = 'SPXW  260821C07665000';   // -1
const DEBITO = 790;                      // pagado, en dolares

(async () => {
  const p = [LARGO, CORTO].map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
  const d = await tt._req(`/market-data?${p}`);
  const m = {}; (d.data?.items ?? []).forEach(i => { m[i.symbol] = i; });
  const spot = parseFloat(((await tt._req('/market-data?symbols[]=SPX')).data?.items ?? [])[0]?.mark || 0);

  const L = m[LARGO], C = m[CORTO];
  const valor = (parseFloat(L.mark) - parseFloat(C.mark)) * 100;

  console.log('SPX ahora           : ' + spot);
  console.log('largo  C7655 mark   : ' + L.mark + '  (bid ' + L.bid + ' / ask ' + L.ask + ')');
  console.log('corto  C7665 mark   : ' + C.mark + '  (bid ' + C.bid + ' / ask ' + C.ask + ')');
  console.log('valor del spread    : $' + valor.toFixed(2) + '   (max posible $1000)');
  console.log('debito pagado       : $' + DEBITO.toFixed(2));
  console.log('P&L ahora           : $' + (valor - DEBITO).toFixed(2));
  console.log('max ganancia si >7665 al cierre : $' + (1000 - DEBITO).toFixed(2));
  console.log('max perdida si <7655 al cierre  : $-' + DEBITO.toFixed(2));
  console.log('breakeven           : ' + (7655 + DEBITO/100).toFixed(2) + '   (SPX esta ' + (spot - (7655+DEBITO/100)).toFixed(2) + ' pts respecto del BE)');
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
