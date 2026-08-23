'use strict';
// SOLO LECTURA. Detalle completo de las ordenes no finalizadas en Tradier (sandbox),
// para decidir con criterio cuales se cancelan. No cancela nada.
require('dotenv').config();
const { TradierClient } = require('./src/tradier');

(async () => {
  const tr = new TradierClient({});
  const ord = await tr.getOrders();
  const vivas = ord.filter(o => !['filled','canceled','rejected','expired'].includes(String(o.status)));

  console.log('ordenes no finalizadas: ' + vivas.length + '\n');
  const porDia = {};
  for (const o of vivas) {
    const dia = String(o.create_date).slice(0,10);
    (porDia[dia] = porDia[dia] || []).push(o);
  }
  for (const dia of Object.keys(porDia).sort()) {
    console.log('--- ' + dia + ' (' + porDia[dia].length + ') ---');
    for (const o of porDia[dia]) {
      const legs = (o.leg || []).map(l =>
        `${l.side} ${l.quantity} ${l.option_symbol || l.symbol}`).join(' + ');
      console.log(`  #${o.id} [${o.status}] ${o.type} ${o.duration || ''} ${o.price != null ? '@'+o.price : ''}`);
      console.log(`     ${legs || '(sin patas en la respuesta)'}`);
      console.log(`     creada ${o.create_date}  |  transaccion ${o.transaction_date || '-'}`);
    }
  }

  // Vencimientos involucrados: una orden de un 0DTE ya vencido es basura pura
  const hoy = new Date().toISOString().slice(0,10).replace(/-/g,'').slice(2);
  console.log('\nfecha de hoy en formato OCC: ' + hoy);
  const conVencViejo = vivas.filter(o => (o.leg || []).some(l => {
    const m = String(l.option_symbol||'').match(/[A-Z]+(\d{6})[CP]/);
    return m && m[1] < hoy;
  }));
  console.log('ordenes cuyas patas YA VENCIERON: ' + conVencViejo.length + ' de ' + vivas.length);
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
