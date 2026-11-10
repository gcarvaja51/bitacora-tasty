// Prueba del TP 50% y el stop -$150 de la demo de Alejandro (src/ironballs_demo.js) con TastyTrade FALSO.
// La corre scripts/pruebas.js. Imprime una linea JSON.
const fs = require('fs'), os = require('os'), path = require('path');
const { crearIronBallsDemo } = require('../src/ironballs_demo');
const ale = require('../src/ironballs_ale');

(async () => {
  const S = 'SPXW  261110C07490000', L = 'SPXW  261110C07495000';
  let precios;
  const tt = { accountNumber: 'TEST', async _req(ruta, opt = {}) {
    if (opt.method === 'POST' && !ruta.endsWith('/orders/dry-run')) throw new Error('orden real prohibida');
    if (ruta.startsWith('/market-data')) {
      const syms = [...ruta.matchAll(/symbols\[\]=([^&]+)/g)].map((m) => decodeURIComponent(m[1]));
      return { data: { items: syms.map((s) => s === 'SPX' ? { symbol: 'SPX', last: 7480 } : { symbol: s, bid: precios[s][0], ask: precios[s][1] }) } };
    }
    if (ruta.endsWith('/orders/dry-run')) return { data: { 'fee-calculation': { 'total-fees': '1.72' }, warnings: [] } };
    throw new Error('ruta no permitida: ' + ruta);
  } };
  const p = ale.armarDesdeFoto({ es_optionstrat: true, etiquetas: [{ strike: 7495, tipo: 'C', posicion: 'arriba' }, { strike: 7490, tipo: 'C', posicion: 'abajo' }],
    dia_resaltado: 10, mes_resaltado: 'Nov', net_credit: 200, net_debit: null, max_loss: 300, max_profit: 200, chance_of_profit: 60, breakeven: null }, '2026-11-10');
  const out = {};
  const nueva = () => crearIronBallsDemo({ tt, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ibale-')), horaETmin: () => 800,
                                           archivo: 'x.json', fuente: 'Alejandro', stopUsd: 150, tpPct: 0.5 });
  // 1) TP: entra a 2.05 (medio 2.10 - 0.05); cuando el medio de recompra baja a 1.00 la ganancia es $105 >= $102.5 → TP
  precios = { [S]: [4.0, 4.2], [L]: [1.9, 2.1] };
  let d = nueva();
  const a = await d.abrir(p, { autor: 'Alejandro' });
  out.entrada = a.registro?.precioEntrada;
  precios = { [S]: [2.5, 2.7], [L]: [1.0, 1.2] };   // medio 1.50: ganancia $55, todavia no
  await d.revisarStop(); out.sigueAbierta = d.resumen().abiertas.length === 1;
  precios = { [S]: [1.9, 2.1], [L]: [0.9, 1.1] };   // medio 1.00: ganancia $105 → TP
  await d.revisarStop();
  const r1 = d.resumen().lista[0]; out.motivoTP = r1.motivoCierre; out.estadoTP = r1.estado;
  // 2) STOP: medio de recompra 3.60 → perdida $155 >= $150
  precios = { [S]: [4.0, 4.2], [L]: [1.9, 2.1] };
  d = nueva(); await d.abrir(p, {});
  precios = { [S]: [5.5, 5.7], [L]: [1.9, 2.1] };
  await d.revisarStop();
  out.motivoStop = d.resumen().lista[0].motivoCierre;
  // 3) "Fuera" de Alejandro EN NEGATIVO para nosotros: NO cierra, sigue abierta (TP/stop/15:30)
  precios = { [S]: [4.0, 4.2], [L]: [1.9, 2.1] };
  d = nueva(); await d.abrir(p, {});
  precios = { [S]: [4.2, 4.4], [L]: [1.9, 2.1] };   // medio 2.30 → salida 2.35: -$30
  const f1 = await d.cerrar({ ultima: true, soloSiGana: true, motivo: 'FUERA_ALEJANDRO', pipe: { resultadoDolares: 40 } });
  out.fueraNegativo = f1.estado; out.siguioAbierta = d.resumen().abiertas.length === 1;
  // 4) "Fuera" EN POSITIVO aunque sea poco: cierra (medio 1.90 → salida 1.95: +$10 bruto, +$6.56 neto)
  precios = { [S]: [3.8, 4.0], [L]: [1.9, 2.1] };
  const f2 = await d.cerrar({ ultima: true, soloSiGana: true, motivo: 'FUERA_ALEJANDRO', pipe: { resultadoDolares: 40 } });
  out.fueraPositivo = f2.estado; out.netoFuera = f2.registro?.pnlUsd;
  // 5) spread de 10 puntos: el stop se duplica a $300 (proporcional al ancho)
  const L10 = 'SPXW  261110C07500000';
  const p10 = ale.armarDesdeFoto({ es_optionstrat: true, etiquetas: [{ strike: 7500, tipo: 'C', posicion: 'arriba' }, { strike: 7490, tipo: 'C', posicion: 'abajo' }],
    dia_resaltado: 10, mes_resaltado: 'Nov', net_credit: 300, net_debit: null, max_loss: 700, max_profit: 300, chance_of_profit: 60, breakeven: null }, '2026-11-10');
  precios = { [S]: [4.0, 4.2], [L10]: [1.0, 1.2] };   // medio 3.00 → entra a 2.95
  d = nueva(); const a10 = await d.abrir(p10, {});
  out.stop10 = a10.registro?.stopUsd;
  precios = { [S]: [5.6, 5.8], [L10]: [1.0, 1.2] };   // medio 4.60 → -$165: con 5 pts cerraria, con 10 sigue
  await d.revisarStop(); out.sigue10con165 = d.resumen().abiertas.length === 1;
  precios = { [S]: [7.0, 7.2], [L10]: [1.0, 1.2] };   // medio 6.00 → -$305 → STOP_300
  await d.revisarStop(); out.motivoStop10 = d.resumen().lista[0].motivoCierre;
  console.log(JSON.stringify(out));
})().catch((e) => { console.log(JSON.stringify({ error: e.message })); });
