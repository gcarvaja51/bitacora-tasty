'use strict';
// SOLO LECTURA. Posiciones y ordenes abiertas en Tradier (SANDBOX / demo).
require('dotenv').config();
const { TradierClient } = require('./src/tradier');

(async () => {
  const tr = new TradierClient({});
  console.log('base:', process.env.TRADIER_BASE_URL || 'https://sandbox.tradier.com/v1', '(SANDBOX = demo)');

  const pos = await tr.getPositions();
  console.log('\n=== POSICIONES ABIERTAS EN TRADIER: ' + pos.length + ' ===');
  for (const p of pos) {
    console.log(JSON.stringify({
      symbol: p.symbol, qty: p.quantity, costo: p.cost_basis, abierta: p.date_acquired,
    }));
  }

  const ord = await tr.getOrders();
  const vivas = ord.filter(o => !['filled','canceled','rejected','expired'].includes(String(o.status)));
  console.log('\n=== ORDENES NO FINALIZADAS: ' + vivas.length + ' ===');
  for (const o of vivas) {
    console.log(JSON.stringify({ id: o.id, status: o.status, clase: o.class, sym: o.symbol,
                                 tipo: o.type, side: o.side, creada: o.create_date }));
  }
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
