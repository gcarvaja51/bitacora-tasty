'use strict';
// SOLO LECTURA. Lista los subyacentes con posicion abierta en Tastytrade (cuenta REAL),
// agrupados, con los vencimientos involucrados.
require('dotenv').config();
const { TastytradeClient } = require('./src/tastytrade');

const tt = new TastytradeClient({
  clientSecret: process.env.TT_CLIENT_SECRET,
  refreshToken: process.env.TT_REFRESH_TOKEN,
  sessionToken: process.env.TT_SESSION_TOKEN,
  accountNumber: process.env.TT_ACCOUNT_NUMBER,
});

(async () => {
  const pos = await tt.getPositions();
  const porSub = {};
  for (const p of pos) {
    const u = p['underlying-symbol'] || p.symbol;
    (porSub[u] = porSub[u] || []).push(p);
  }
  const subs = Object.keys(porSub).sort();
  console.log('posiciones abiertas: ' + pos.length + '  |  subyacentes distintos: ' + subs.length + '\n');
  for (const u of subs) {
    const ps = porSub[u];
    const vencs = [...new Set(ps.map(p => (p['expires-at'] || '').slice(0,10)).filter(Boolean))].sort();
    const tipos = [...new Set(ps.map(p => p['instrument-type']))];
    console.log(`${u.padEnd(8)} ${String(ps.length).padStart(2)} patas | ${tipos.join(',')} | vence: ${vencs.join(', ') || '(acciones)'}`);
    for (const p of ps) {
      console.log(`    ${p['quantity-direction'].padEnd(5)} ${p.quantity} x ${p.symbol.trim()}`);
    }
  }
  console.log('\nSUBYACENTES: ' + subs.join(' '));
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
