#!/usr/bin/env node
'use strict';

// Depurador de ordenes zombi del sandbox de Tradier (2026-08-25, a pedido del
// usuario: "quitemos todo esto zombi, depuremos").
//
// QUE ES UN ZOMBI. Tradier acepta el multileg, devuelve un id, y lo deja en
// 'pending' con exec_quantity 0 PARA SIEMPRE: ni se llena ni vence. Al 25-ago hay
// 26 acumulados desde el 12-ago. 24 son type:'market' con price:null — o sea
// anteriores al arreglo del 20-ago que dejo de mandar ordenes a mercado — y 2 son
// limites de la Direccional que no llegaron a llenarse.
//
// POR QUE MOLESTAN. hasOpenPosition() cuenta 'pending' como posicion viva, asi que
// cada zombi hacia que la funcion devolviera true de por vida. Eso ya esta mitigado
// por ORDEN_ZOMBI_MS (src/tradier.js), que las descarta a los 3 min por EDAD — pero
// la mitigacion tapa el sintoma. Mientras sigan ahi, cualquier lectura cruda de las
// ordenes del broker miente, y el conteo de "cuantas ordenes hay vivas" no sirve.
//
// LO QUE YA SE SABIA Y HAY QUE RE-VERIFICAR. El comentario de hasOpenPosition dice
// que las 21 de entonces devolvian HTTP 400 "order not available to be canceled".
// Eso se midio el 19-ago; este script lo vuelve a probar una por una en vez de
// asumirlo, y reporta cuales ceden y cuales no.
//
//   node scripts/depurar_zombis.js            simulacro: lista y no cancela nada
//   node scripts/depurar_zombis.js --aplicar  intenta cancelar cada una
//
// Solo toca ordenes 'pending' con exec_quantity 0. Una orden con ejecucion parcial
// NO se toca: cancelarla dejaria una pata suelta, que es peor que el zombi.

require('dotenv').config();
const { TradierClient } = require('../src/tradier');

const APLICAR = process.argv.includes('--aplicar');
const tradier = new TradierClient({});

(async () => {
  let ordenes;
  try {
    ordenes = await tradier.getOrders();
  } catch (e) {
    console.error('No se pudieron leer las ordenes:', e.message);
    process.exit(1);
  }

  const zombis = ordenes.filter((o) => {
    const est = String(o.status || '').toLowerCase();
    const eje = Number(o.exec_quantity || 0);
    return est === 'pending' && eje === 0;
  });

  const parciales = ordenes.filter((o) => {
    const est = String(o.status || '').toLowerCase();
    const eje = Number(o.exec_quantity || 0);
    return est === 'pending' && eje > 0;
  });

  console.log(`ordenes en el broker : ${ordenes.length}`);
  console.log(`zombis (pending, 0 ejecutado) : ${zombis.length}`);
  if (parciales.length) {
    console.log(`parcialmente ejecutadas: ${parciales.length} — NO SE TOCAN (cancelarlas dejaria una pata suelta)`);
    for (const o of parciales) console.log(`   id=${o.id} exec=${o.exec_quantity}/${o.quantity}`);
  }
  if (!zombis.length) { console.log('\nNada que depurar.'); return; }

  if (!APLICAR) {
    console.log('\nSIMULACRO — no se cancela nada. Se intentaria con:');
    for (const o of zombis) {
      console.log(`   id=${o.id} ${String(o.create_date).slice(0, 16)} ${String(o.type).padEnd(7)} price=${o.price ?? '—'}`);
    }
    console.log('\nCorrelo con --aplicar para cancelarlas de verdad.');
    return;
  }

  const ok = [], fallo = [];
  for (const o of zombis) {
    try {
      await tradier.cancelOrder(o.id);
      ok.push(o.id);
      console.log(`   ${o.id}  CANCELADA`);
    } catch (e) {
      const msg = String(e.message || '').slice(0, 90);
      fallo.push({ id: o.id, msg });
      console.log(`   ${o.id}  no cede — ${msg}`);
    }
    // El sandbox se atraganta si se le mandan seguidas; ya paso el 2026-08-19.
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`\ncanceladas: ${ok.length} de ${zombis.length}`);
  if (fallo.length) {
    console.log(`no cedieron: ${fallo.length}`);
    const motivos = {};
    for (const f of fallo) motivos[f.msg] = (motivos[f.msg] || 0) + 1;
    for (const [m, n] of Object.entries(motivos)) console.log(`   ${n}x  ${m}`);
    console.log('\nLas que no ceden quedan como estaban. El filtro por EDAD de');
    console.log('src/tradier.js (ORDEN_ZOMBI_MS) las sigue ignorando, asi que no bloquean.');
  }
})();
