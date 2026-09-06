#!/usr/bin/env node
'use strict';

// Bateria de pruebas — lo que la Torre de Control corre antes de desplegar.
//
//   node scripts/pruebas.js                    unidad (rapido, sin red)
//   node scripts/pruebas.js --humo             unidad + todos los endpoints contra produccion
//   node scripts/pruebas.js --humo --base http://localhost:3000
//
// POR QUE EXISTE, con nombre y fecha: el 2026-08-22 se desplego un cambio que
// tumbaba /api/spx/reversion-sombra con un 500 en cada request. Uso `spxConfig`,
// que no es global sino un const local en otras cuatro funciones.
//
// Ni `node -c` ni el optional chaining lo habrian visto: no es error de sintaxis
// —es de ejecucion— y `a?.b` sigue fallando si `a` no esta declarada. Estuvo
// caido ~20 minutos y se descubrio de casualidad, corriendo el Auditor. NINGUN
// chequeo tocaba ese endpoint.
//
// La prueba de humo de abajo lo habria cazado en dos segundos. Ese es todo el
// argumento.
//
// PRIORIDAD: los calculos de DINERO primero, las pantallas despues. Un color mal
// puesto se ve; un P&L mal calculado se cree.

const { resultadoOficial, agregar } = require('../src/pnl_oficial');
const { evaluarCircuitoDiario, frenosDeclarados } = require('../src/frenos');

const args = process.argv.slice(2);
const HUMO = args.includes('--humo');
// --local levanta el servidor en MODO_PRUEBAS y le hace el humo ANTES de
// desplegar. Es la diferencia entre cazar un ReferenceError en dos segundos o
// veinte minutos despues, con produccion caida.
const LOCAL = args.includes('--local');
const BASE = (args[args.indexOf('--base') + 1] || '').startsWith('http')
  ? args[args.indexOf('--base') + 1]
  : 'https://web-production-23473.up.railway.app';

let ok = 0, fail = 0;
const fallos = [];

function chequear(nombre, condicion, detalle) {
  if (condicion) { ok++; return; }
  fail++; fallos.push(`${nombre}${detalle ? ' — ' + detalle : ''}`);
  console.log(`  FALLA  ${nombre}${detalle ? ' — ' + detalle : ''}`);
}

function seccion(t) { console.log(`\n--- ${t} ---`); }

// ── 1. El dinero: la unica puerta a "cuanto gano este trade" ────────────────
seccion('El numero oficial (src/pnl_oficial.js)');

const conLibro = { status: 'closed', closedAt: '2026-08-20T18:00:00Z', pnl: -90,
                   paperPnl: { bruto: 105, neto: 100.8, confiable: true } };
let r = resultadoOficial(conLibro);
chequear('con libro propio manda la cadena real', r.pnl === 105, `dio ${r.pnl}`);
chequear('con libro es comparable', r.comparable === true);
chequear('con libro conserva el numero del broker', r.pnlBroker === -90);
// El caso que motivo toda la Fase 0: mismo trade, dos signos.
chequear('la diferencia se calcula y es la del caso real', r.diferencia === 195, `dio ${r.diferencia}`);

// Un libro marcado NO confiable no es libro. Si esto se rompe, entran al
// promedio trades que nadie valido — y sin ruido, en silencio.
r = resultadoOficial({ ...conLibro, paperPnl: { bruto: 105, confiable: false } });
chequear('un libro no confiable NO manda', r.fuente !== 'cadena_real', `dio ${r.fuente}`);
chequear('sin libro confiable no es comparable', r.comparable === false);

r = resultadoOficial({ status: 'closed', closedAt: '2026-08-20T18:00:00Z', pnl: 40,
                       pnlSource: 'ordenes_reales' });
chequear('sin libro cae al broker', r.fuente === 'broker' && r.pnl === 40);
chequear('el broker NO es comparable', r.comparable === false);

r = resultadoOficial({ status: 'closed', closedAt: '2026-07-20T18:00:00Z', pnl: 40,
                       pnlSource: 'gainloss' });
chequear('gainloss queda como dudoso', r.fuente === 'broker_dudoso', `dio ${r.fuente}`);

r = resultadoOficial({ status: 'closed', closedAt: '2026-08-20T18:00:00Z', pnl: 0,
                       pnlSource: 'sandbox_orden_fantasma',
                       closeReason: 'SANDBOX_GLITCH_SIN_POSICION' });
chequear('la orden fantasma no es una operacion', r.fuente === 'no_operacion');
chequear('la orden fantasma no aporta P&L', r.pnl === null);

r = resultadoOficial({ status: 'filled', pnl: null });
chequear('una posicion abierta queda pendiente', r.pendiente === true);
chequear('resultadoOficial tolera null', resultadoOficial(null).pendiente === true);

// Agregacion: comparables y legado NUNCA se suman.
const mezcla = [conLibro,
  { status: 'closed', closedAt: '2026-08-20T18:00:00Z', pnl: 40, pnlSource: 'ordenes_reales' },
  { status: 'closed', closedAt: '2026-08-20T18:00:00Z', pnl: 0,
    pnlSource: 'sandbox_orden_fantasma', closeReason: 'SANDBOX_GLITCH_SIN_POSICION' }];
const ag = agregar(mezcla);
chequear('agregar separa comparable de legado', ag.comparable.trades === 1 && ag.legado.trades === 1,
  `comp=${ag.comparable.trades} legado=${ag.legado.trades}`);
chequear('agregar excluye lo que no fue operacion', ag.excluidas === 1);
chequear('agregar no suma legado con comparable', ag.comparable.pnl === 105);
chequear('con 1 trade la muestra NO es suficiente', ag.comparable.muestraSuficiente === false);

// ── 1b. El calendario: cada dolar acaba realizado o en una pata viva ────────
// POR QUE EXISTE, con nombre y fecha: el 2026-09-05 el usuario reporto que el
// 15-abr-2026 el calendario decia +$6.258,21 en un dia que en caja fue -$77,59.
// Dos fallos silenciosos, ninguno con prueba que los tapara:
//   (a) las Expiration a net-value=0 se botaban del ledger, asi que la prima de
//       una pata larga vencida sin valor nunca se realizaba ($6.335,80 ese dia);
//   (b) un ROLL emitia fila propia con `pnl = order.netValue`, inventando
//       resultado y contando dos veces el credito de la pata nueva.
// La invariante que los caza a los dos: **caja = P&L realizado + patas vivas**.
seccion('El calendario (src/metrics.js)');

const { buildMetrics, getAmPm, fechaET } = require('../src/metrics');

const tx = (o) => Object.assign({
  'transaction-type': 'Trade', 'transaction-sub-type': '', 'order-id': 1,
  'net-value': '0', 'net-value-effect': 'Credit', quantity: '1',
  'underlying-symbol': 'SPX', commission: '0', 'clearing-fees': '0',
}, o);

// (a) Un cono: pata corta que se liquida en efectivo + pata larga que vence a
//     cero. La larga costo $200 y no volvio: tiene que aparecer en el P&L.
const libroExpira = [
  tx({ id: 1, 'transaction-date': '2026-04-15T14:00:00Z', 'executed-at': '2026-04-15T14:00:00Z',
       symbol: 'SPXW  260415C06915000', action: 'Sell to Open', 'net-value': '500', 'net-value-effect': 'Credit' }),
  tx({ id: 2, 'transaction-date': '2026-04-15T14:00:00Z', 'executed-at': '2026-04-15T14:00:00Z',
       symbol: 'SPXW  260415C07030000', action: 'Buy to Open',  'net-value': '200', 'net-value-effect': 'Debit' }),
  tx({ id: 3, 'transaction-type': 'Receive Deliver', 'transaction-sub-type': 'Cash Settled Assignment',
       'transaction-date': '2026-04-15T21:00:00Z', 'executed-at': '2026-04-15T21:00:00Z', 'order-id': null,
       symbol: 'SPXW  260415C06915000', 'net-value': '300', 'net-value-effect': 'Debit' }),
  tx({ id: 4, 'transaction-type': 'Receive Deliver', 'transaction-sub-type': 'Expiration',
       'transaction-date': '2026-04-15T21:00:00Z', 'executed-at': '2026-04-15T21:00:00Z', 'order-id': null,
       symbol: 'SPXW  260415C07030000', action: 'Sell to Close', 'net-value': '0', 'net-value-effect': 'None' }),
];
const mExp = buildMetrics(libroExpira, { limit: 0 });
chequear('una Expiration a $0 cierra la pata larga',
  Math.abs((mExp.stratByDay['2026-04-15'] || 0) - 0) < 0.01,
  `dio ${mExp.stratByDay['2026-04-15']}, la caja del dia es 0 (+500 -200 -300)`);

// (b) STO -> ROLL -> cierre real. El roll no es un cierre: no puede dejar
//     resultado en su propio dia, y el P&L completo aflora el dia del cierre.
const libroRoll = [
  tx({ id: 10, 'order-id': 100, 'transaction-date': '2026-06-10T14:00:00Z', 'executed-at': '2026-06-10T14:00:00Z',
       symbol: 'NU    260618C00012000', action: 'Sell to Open', 'net-value': '30', 'net-value-effect': 'Credit',
       'underlying-symbol': 'NU' }),
  tx({ id: 11, 'order-id': 200, 'transaction-date': '2026-06-15T14:00:00Z', 'executed-at': '2026-06-15T14:00:00Z',
       symbol: 'NU    260618C00012000', action: 'Buy to Close', 'net-value': '10', 'net-value-effect': 'Debit',
       'underlying-symbol': 'NU' }),
  tx({ id: 12, 'order-id': 200, 'transaction-date': '2026-06-15T14:00:00Z', 'executed-at': '2026-06-15T14:00:00Z',
       symbol: 'NU    260702C00012000', action: 'Sell to Open', 'net-value': '40', 'net-value-effect': 'Credit',
       'underlying-symbol': 'NU' }),
  tx({ id: 13, 'order-id': 300, 'transaction-date': '2026-06-29T14:00:00Z', 'executed-at': '2026-06-29T14:00:00Z',
       symbol: 'NU    260702C00012000', action: 'Buy to Close', 'net-value': '5', 'net-value-effect': 'Debit',
       'underlying-symbol': 'NU' }),
];
const mRoll = buildMetrics(libroRoll, { limit: 0 });
chequear('un ROLL no deja resultado en su dia',
  mRoll.stratByDay['2026-06-15'] === undefined,
  `dio ${mRoll.stratByDay['2026-06-15']}`);
chequear('el P&L de la cadena aflora entero el dia del cierre',
  Math.abs((mRoll.stratByDay['2026-06-29'] || 0) - 55) < 0.01,
  `dio ${mRoll.stratByDay['2026-06-29']}, la cadena vale +30 -10 +40 -5 = 55`);
chequear('un ROLL no genera fila propia',
  mRoll.strategies.filter(x => x.stratType === 'Roll').length === 0);
chequear('la operacion conserva su fecha de apertura original',
  mRoll.strategies[0]?.openDate === '2026-06-10',
  `dio ${mRoll.strategies[0]?.openDate}`);

// (c-bis) La caja del dia: el "+N" del calendario sumaba SOLO las ordenes de
//     apertura con neto positivo, asi que una apertura de debito o un roll que
//     se paga eran invisibles. 22 dias de 127 inflados, $14.088,50 de exceso; el
//     peor el 2026-05-29, que decia +$187 en un dia donde salieron $2.518.
const libroCaja = [
  tx({ id: 20, 'order-id': 400, 'transaction-date': '2026-07-01T14:00:00Z', 'executed-at': '2026-07-01T14:00:00Z',
       symbol: 'NU    260918P00013000', action: 'Sell to Open', 'net-value': '50', 'net-value-effect': 'Credit',
       'underlying-symbol': 'NU' }),
  tx({ id: 21, 'order-id': 401, 'transaction-date': '2026-07-01T15:00:00Z', 'executed-at': '2026-07-01T15:00:00Z',
       symbol: 'NU    260918C00015000', action: 'Buy to Open', 'net-value': '80', 'net-value-effect': 'Debit',
       'underlying-symbol': 'NU' }),
];
const mCaja = buildMetrics(libroCaja, { limit: 0 });
chequear('la caja del dia resta las aperturas de debito',
  Math.abs((mCaja.openByDay['2026-07-01'] || 0) + 30) < 0.01,
  `dio ${mCaja.openByDay['2026-07-01']}, deberia ser -30 (+50 de credito, -80 de debito)`);

// (c-quater) Un intradia NO deja caja en juego. Reportado por el usuario el
//     2026-09-05 mirando el 4-sep: "aparece una apertura de un bear call spread
//     en spx, es errado, porque ese trade se cerro intradia". Su prima ya esta
//     contada en la fila de cierre con su P&L; volver a enseñarla como caja
//     nueva lo mostraba dos veces, en los dos bloques del mismo dia.
const libroIntradia = [
  tx({ id: 30, 'order-id': 500, 'transaction-date': '2026-07-02T14:00:00Z', 'executed-at': '2026-07-02T14:00:00Z',
       symbol: 'SPXW  260702C07730000', action: 'Sell to Open', 'net-value': '100', 'net-value-effect': 'Credit' }),
  tx({ id: 31, 'order-id': 501, 'transaction-date': '2026-07-02T18:00:00Z', 'executed-at': '2026-07-02T18:00:00Z',
       symbol: 'SPXW  260702C07730000', action: 'Buy to Close', 'net-value': '40', 'net-value-effect': 'Debit' }),
];
const mIntra = buildMetrics(libroIntradia, { limit: 0 });
chequear('el intradia si deja resultado',
  Math.abs((mIntra.stratByDay['2026-07-02'] || 0) - 60) < 0.01,
  `dio ${mIntra.stratByDay['2026-07-02']}, deberia ser 60`);
chequear('el intradia NO deja caja en juego',
  mIntra.openByDay['2026-07-02'] === undefined,
  `dio ${mIntra.openByDay['2026-07-02']}, su prima ya esta en la fila de cierre`);
chequear('su apertura queda con vivo = 0, para que el detalle no la repita',
  (mIntra.movimientos.find(x => x.tipo === 'Apertura') || {}).vivo === 0);

// Cerrar solo una parte deja viva la otra: abrir 2 y cerrar 1 el mismo dia.
const libroParcial = [
  tx({ id: 32, 'order-id': 510, 'transaction-date': '2026-07-03T14:00:00Z', 'executed-at': '2026-07-03T14:00:00Z',
       symbol: 'SPXW  260710C07730000', action: 'Sell to Open', 'net-value': '100', 'net-value-effect': 'Credit',
       quantity: '2' }),
  tx({ id: 33, 'order-id': 511, 'transaction-date': '2026-07-03T18:00:00Z', 'executed-at': '2026-07-03T18:00:00Z',
       symbol: 'SPXW  260710C07730000', action: 'Buy to Close', 'net-value': '30', 'net-value-effect': 'Debit',
       quantity: '1' }),
];
const mParcial = buildMetrics(libroParcial, { limit: 0 });
chequear('un cierre parcial deja viva la parte que no se cerro',
  Math.abs((mParcial.openByDay['2026-07-03'] || 0) - 50) < 0.01,
  `dio ${mParcial.openByDay['2026-07-03']}, se cerro 1 de 2 contratos: quedan 50 de los 100`);

// (c-ter) El detalle del dia tiene que enseñar lo que PASO, no solo lo que
//     cerro. El 2026-09-04 hubo cinco ordenes y la pantalla mostraba dos filas,
//     porque las aperturas vivas y los rolls no existian para `strategies`.
const movs = mRoll.movimientos || [];
chequear('cada orden deja un movimiento, tambien las que no cierran nada',
  movs.length === 3, `dio ${movs.length} de 3 (apertura, roll, cierre)`);
chequear('el roll se marca como Roll, no como cierre',
  movs.find(x => x.date === '2026-06-15')?.tipo === 'Roll',
  `dio ${movs.find(x => x.date === '2026-06-15')?.tipo}`);
chequear('la apertura de un trade que sigue vivo tambien deja movimiento',
  movs.find(x => x.date === '2026-06-10')?.tipo === 'Apertura');
chequear('el movimiento lleva el neto de caja con su signo',
  Math.abs((movs.find(x => x.date === '2026-06-15')?.net || 0) - 30) < 0.01,
  `dio ${movs.find(x => x.date === '2026-06-15')?.net}, el roll fue -10 +40 = 30`);

// (d) Un roll cuya pata NUEVA muere el mismo dia tampoco deja caja. Encontrado
//     el 2026-09-05 auditando hacia atras: JBLU el 18-ago rolo a la put $6 09/18
//     y la recompro esa misma tarde; el roll seguia enseñando +$46,75 de caja
//     viva. La proporcion se mide en CONTRATOS y no en dinero: el valor de una
//     pata nacida de un roll viene arrastrado de dias anteriores, y restarlo del
//     neto daba disparates (COIN 31-jul: `vivo` 192,12 sobre un neto de 19,75).
const libroRollMuerto = [
  tx({ id: 40, 'order-id': 600, 'transaction-date': '2026-08-03T14:00:00Z', 'executed-at': '2026-08-03T14:00:00Z',
       symbol: 'JBLU  260904P00005500', action: 'Sell to Open', 'net-value': '15', 'net-value-effect': 'Credit',
       'underlying-symbol': 'JBLU' }),
  tx({ id: 41, 'order-id': 601, 'transaction-date': '2026-08-18T14:00:00Z', 'executed-at': '2026-08-18T14:00:00Z',
       symbol: 'JBLU  260904P00005500', action: 'Buy to Close', 'net-value': '48', 'net-value-effect': 'Debit',
       'underlying-symbol': 'JBLU' }),
  tx({ id: 42, 'order-id': 601, 'transaction-date': '2026-08-18T14:00:00Z', 'executed-at': '2026-08-18T14:00:00Z',
       symbol: 'JBLU  260918P00006000', action: 'Sell to Open', 'net-value': '95', 'net-value-effect': 'Credit',
       'underlying-symbol': 'JBLU' }),
  tx({ id: 43, 'order-id': 602, 'transaction-date': '2026-08-18T18:00:00Z', 'executed-at': '2026-08-18T18:00:00Z',
       symbol: 'JBLU  260918P00006000', action: 'Buy to Close', 'net-value': '94', 'net-value-effect': 'Debit',
       'underlying-symbol': 'JBLU' }),
];
const mRM = buildMetrics(libroRollMuerto, { limit: 0 });
chequear('un roll que muere el mismo dia no deja caja viva',
  mRM.openByDay['2026-08-18'] === undefined,
  `dio ${mRM.openByDay['2026-08-18']}`);
chequear('y la cadena entera aflora el dia del cierre',
  Math.abs((mRM.stratByDay['2026-08-18'] || 0) + 32) < 0.01,
  `dio ${mRM.stratByDay['2026-08-18']}, la cadena vale +15 -48 +95 -94 = -32`);

// (e) Una asignacion que entrega ACCIONES cierra la opcion corta. Es el unico
//     evento que lo registra —no hay fila "Cash Settled"— y botarlo dejaba la
//     corta viva para siempre con su prima sin realizar. Encontrado el
//     2026-09-05: la put de GAP $27 (+$279,87) y la de NU $13 (+$55,73) seguian
//     abiertas meses despues de haber sido asignadas.
const libroAsignacion = [
  tx({ id: 50, 'order-id': 700, 'transaction-date': '2026-05-28T14:00:00Z', 'executed-at': '2026-05-28T14:00:00Z',
       symbol: 'GAP   260618P00027000', action: 'Sell to Open', 'net-value': '279.87', 'net-value-effect': 'Credit',
       'underlying-symbol': 'GAP' }),
  tx({ id: 51, 'transaction-type': 'Receive Deliver', 'transaction-sub-type': 'Assignment', 'order-id': null,
       'transaction-date': '2026-05-29T21:00:00Z', 'executed-at': '2026-05-29T21:00:00Z',
       symbol: 'GAP   260618P00027000', 'net-value': '0', 'net-value-effect': 'None',
       'underlying-symbol': 'GAP' }),
  tx({ id: 52, 'transaction-type': 'Receive Deliver', 'transaction-sub-type': 'Buy to Open', 'order-id': null,
       'transaction-date': '2026-05-29T21:00:00Z', 'executed-at': '2026-05-29T21:00:00Z',
       symbol: 'GAP', action: 'Buy to Open', quantity: '100',
       'net-value': '2705', 'net-value-effect': 'Debit', 'underlying-symbol': 'GAP' }),
];
const mAs = buildMetrics(libroAsignacion, { limit: 0 });
chequear('una asignacion en acciones cierra la opcion y realiza su prima',
  Math.abs((mAs.stratByDay['2026-05-29'] || 0) - 279.87) < 0.01,
  `dio ${mAs.stratByDay['2026-05-29']}, la prima cobrada fue 279,87`);

// Pero cuando SI hay "Cash Settled", el Removal a $0 es su acompanante y no
// puede cerrar la pata otra vez.
const libroDoble = [
  tx({ id: 60, 'transaction-date': '2026-04-15T14:00:00Z', 'executed-at': '2026-04-15T14:00:00Z',
       symbol: 'SPXW  260415C06915000', action: 'Sell to Open', 'net-value': '500', 'net-value-effect': 'Credit' }),
  tx({ id: 61, 'transaction-type': 'Receive Deliver', 'transaction-sub-type': 'Assignment', 'order-id': null,
       'transaction-date': '2026-04-15T21:00:00Z', 'executed-at': '2026-04-15T21:00:00Z',
       symbol: 'SPXW  260415C06915000', 'net-value': '0', 'net-value-effect': 'None' }),
  tx({ id: 62, 'transaction-type': 'Receive Deliver', 'transaction-sub-type': 'Cash Settled Assignment', 'order-id': null,
       'transaction-date': '2026-04-15T21:00:00Z', 'executed-at': '2026-04-15T21:00:00Z',
       symbol: 'SPXW  260415C06915000', 'net-value': '300', 'net-value-effect': 'Debit' }),
];
const mDob = buildMetrics(libroDoble, { limit: 0 });
chequear('con Cash Settled, el Removal a $0 no cierra la pata dos veces',
  Math.abs((mDob.stratByDay['2026-04-15'] || 0) - 200) < 0.01,
  `dio ${mDob.stratByDay['2026-04-15']}, deberia ser 200 (+500 -300)`);

// (f) El resumen del mes: "Abierto" es lo que de ese mes SIGUE abierto hoy, no
//     la suma de la caja diaria. La caja diaria solo descuenta los cierres del
//     mismo dia, asi que sumada por mes cuenta entera la prima de una posicion
//     abierta y cerrada dentro del mes: febrero daba +$3.158 de "abierto" sin
//     tener ni una pata viva. Pedido del usuario el 2026-09-05, "para saber como
//     vamos". La invariante que lo ata: realizado + abierto = la caja real.
const libroMes = [
  // abre y cierra dentro del mes: no puede dejar nada "abierto"
  tx({ id: 70, 'order-id': 800, 'transaction-date': '2026-03-03T14:00:00Z', 'executed-at': '2026-03-03T14:00:00Z',
       symbol: 'NU    260320P00013000', action: 'Sell to Open', 'net-value': '100', 'net-value-effect': 'Credit',
       'underlying-symbol': 'NU' }),
  tx({ id: 71, 'order-id': 801, 'transaction-date': '2026-03-10T14:00:00Z', 'executed-at': '2026-03-10T14:00:00Z',
       symbol: 'NU    260320P00013000', action: 'Buy to Close', 'net-value': '40', 'net-value-effect': 'Debit',
       'underlying-symbol': 'NU' }),
  // abre y sigue viva
  tx({ id: 72, 'order-id': 802, 'transaction-date': '2026-03-20T14:00:00Z', 'executed-at': '2026-03-20T14:00:00Z',
       symbol: 'NU    271217P00013000', action: 'Sell to Open', 'net-value': '250', 'net-value-effect': 'Credit',
       'underlying-symbol': 'NU' }),
];
const mMes = buildMetrics(libroMes, { limit: 0 });
const sumaMes = (o) => Object.entries(o).reduce((a, [d, v]) => a + (d.startsWith('2026-03') ? v : 0), 0);
chequear('lo abierto y cerrado dentro del mes no cuenta como "abierto"',
  Math.abs(sumaMes(mMes.abiertoByDay) - 250) < 0.01,
  `dio ${sumaMes(mMes.abiertoByDay)}, solo la de dic-2027 sigue viva (250)`);
chequear('la suma de la caja diaria SI la contaria (por eso no se usa)',
  Math.abs(sumaMes(mMes.openByDay) - 350) < 0.01,
  `dio ${sumaMes(mMes.openByDay)}`);
chequear('realizado + abierto = la caja real del libro',
  Math.abs((sumaMes(mMes.stratByDay) + sumaMes(mMes.abiertoByDay)) - 310) < 0.01,
  `dio ${sumaMes(mMes.stratByDay) + sumaMes(mMes.abiertoByDay)}, la caja fue +100 -40 +250 = 310`);

// (g) La franja horaria va en hora de NUEVA YORK, no UTC. Reportado por el
//     usuario el 2026-09-05: "en la hoja reportes solo veo cierres pm, no am".
//     `getUTCHours() < 13` no se cumple nunca —el mercado abre 9:30 ET, que son
//     las 13:30 UTC en verano y las 14:30 en invierno— asi que el cubo AM salia
//     vacio: 164 de 266 cierres (62%) eran de la manana y se contaban como PM.
//     Se prueban las dos mitades del ano, que es donde el bug se escondia.
chequear('verano: 13:45 UTC son las 9:45 de Nueva York -> AM',
  getAmPm('2026-07-15T13:45:00Z') === 'AM (9-12h)', `dio ${getAmPm('2026-07-15T13:45:00Z')}`);
chequear('invierno: 15:00 UTC son las 10:00 de Nueva York -> AM',
  getAmPm('2026-02-17T15:00:00Z') === 'AM (9-12h)', `dio ${getAmPm('2026-02-17T15:00:00Z')}`);
chequear('verano: 18:00 UTC son las 14:00 -> PM',
  getAmPm('2026-07-15T18:00:00Z') === 'PM (12-16h)', `dio ${getAmPm('2026-07-15T18:00:00Z')}`);
chequear('invierno: 18:00 UTC son las 13:00 -> PM',
  getAmPm('2026-02-17T18:00:00Z') === 'PM (12-16h)', `dio ${getAmPm('2026-02-17T18:00:00Z')}`);
chequear('la liquidacion de vencimiento (21:00 UTC = 17:00 ET) no ensucia el PM',
  getAmPm('2026-04-15T21:00:00Z') === 'After-hours', `dio ${getAmPm('2026-04-15T21:00:00Z')}`);
chequear('antes de la apertura es Pre-market, no AM',
  getAmPm('2026-07-15T13:00:00Z') === 'Pre-market', `dio ${getAmPm('2026-07-15T13:00:00Z')}`);
chequear('las 9:30 en punto ya son AM',
  getAmPm('2026-07-15T13:30:00Z') === 'AM (9-12h)', `dio ${getAmPm('2026-07-15T13:30:00Z')}`);

// (g-bis) Y la FECHA tambien es la de Nueva York, no la de UTC. Norma del
//     usuario: "todo el informe de bitacora tasty es con hora nueva york".
//     `toISOString()` da la fecha UTC, que a partir de las 8pm ET ya es MANANA.
chequear('las 9pm de Nueva York siguen siendo el mismo dia, no el siguiente',
  fechaET('2026-04-16T01:00:00Z') === '2026-04-15', `dio ${fechaET('2026-04-16T01:00:00Z')}`);
chequear('en invierno igual (10pm ET del 17-feb)',
  fechaET('2026-02-18T03:00:00Z') === '2026-02-17', `dio ${fechaET('2026-02-18T03:00:00Z')}`);
chequear('en horario de mercado la fecha no cambia',
  fechaET('2026-04-15T18:00:00Z') === '2026-04-15', `dio ${fechaET('2026-04-15T18:00:00Z')}`);

// (c) El detalle de un dia sale de `metrics.strategies`: si viene recortado, los
//     meses viejos quedan mudos aunque la casilla muestre P&L. El 2026-09-05
//     habia 304 round-trips y 56 de 127 dias en blanco por el tope de 200, por
//     eso /api/transactions pide `limit: 0`. La prueba de humo comprueba que el
//     endpoint devuelve TODOS los round-trips que dice tener.

// ── 2. Los frenos ───────────────────────────────────────────────────────────
seccion('El circuito diario (src/frenos.js)');

const t = (p) => ({ strategyFamily: 'REVERSION', status: 'closed',
                    closedAt: '2026-08-22T18:00:00Z', pnl: p,
                    paperPnl: { bruto: p, confiable: true } });
const opt = { familia: 'REVERSION', fecha: '2026-08-22', capital: 100000, maxDrawdownPct: 3.5 };

chequear('no frena por debajo del limite', evaluarCircuitoDiario([t(-3400)], opt).bloquea === false);
// El borde exacto: la condicion es <=, asi que -3.5% DEBE frenar. Caza el dia
// que alguien lo cambie a < por accidente.
chequear('frena EXACTO en el limite', evaluarCircuitoDiario([t(-3500)], opt).bloquea === true);
chequear('frena pasado el limite', evaluarCircuitoDiario([t(-4000)], opt).bloquea === true);
const sinCap = evaluarCircuitoDiario([t(-3500)], { ...opt, capital: 0 });
chequear('sin capital frena por precaucion', sinCap.bloquea === true);
chequear('y lo dice con motivo propio', sinCap.fuente === 'sin_capital', `dio ${sinCap.fuente}`);

const declarados = frenosDeclarados({ maxDailyDrawdownPct: 3.5, riskPctPerTrade: 1, maxStopsPerDay: 2 });
const activos = declarados.filter(f => f.activo);
chequear('solo UN freno esta activo', activos.length === 1, `hay ${activos.length}`);
chequear('el activo es el drawdown diario', activos[0]?.clave === 'maxDailyDrawdownPct');
chequear('los decorativos vienen marcados',
  declarados.filter(f => !f.activo).every(f => (f.nota || '').includes('DECORATIVO')));

// ── 2b. El gate de posicion ────────────────────────────────────────────────
seccion('El gate de posicion (hasLocalOpenSPXWPosition)');

// Se prueba la REGLA, no la funcion: la funcion lee del disco. Si la regla
// cambia, estas expectativas tienen que cambiar con ella a proposito.
const GRACIA_MS = 90 * 1000;
function bloquea(e) {
  if (e.status !== 'submitted' && e.status !== 'filled') return false;
  if (e.strategyFamily === 'REVERSION') return false;
  if (e.closeOrderSentAt && (Date.now() - new Date(e.closeOrderSentAt).getTime()) > GRACIA_MS) return false;
  return true;
}
const haceRato = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const reciente = new Date(Date.now() - 10 * 1000).toISOString();

chequear('una direccional abierta bloquea',
  bloquea({ status: 'filled', strategyFamily: 'TENDENCIA' }) === true);
chequear('una Reversion abierta NO bloquea a la direccional',
  bloquea({ status: 'filled', strategyFamily: 'REVERSION' }) === false);
chequear('una cerrada no bloquea',
  bloquea({ status: 'closed', strategyFamily: 'TENDENCIA' }) === false);
// El caso de los 61 bloqueos en 10 dias: el cierre ya se mando y la
// reconciliacion (cada 5 min) todavia no cambio la etiqueta.
chequear('con el cierre ya mandado hace rato, deja de bloquear',
  bloquea({ status: 'filled', strategyFamily: 'TENDENCIA', closeOrderSentAt: haceRato }) === false);
// Pero no de inmediato: si no, se apilarian dos posiciones por un cierre que
// todavia no llena.
chequear('con el cierre recien mandado sigue bloqueando (gracia de 90s)',
  bloquea({ status: 'filled', strategyFamily: 'TENDENCIA', closeOrderSentAt: reciente }) === true);

// ── 2b-bis. Los apagones del broker ────────────────────────────────────────
seccion('Apagones del broker (src/apagon_broker.js)');

const ab = require('../src/apagon_broker');

// LO QUE MAS IMPORTA: no confundir un bug nuestro con una caida de Tradier. Si un
// 400 de "precio invalido" contara como apagon, el sistema se auto-absolveria y el
// bug quedaria tapado detras de un aviso de "el broker esta caido".
chequear('un 5xx es del broker',
  ab.esFalloDelBroker('Tradier API 500 /accounts/X/orders: An error occurred while communicating with the backend.'));
// El 400 con cuerpo de error de servidor, medido en vivo el 2026-09-03.
chequear('un 400 que dice "Unexpected server error" tambien es del broker',
  ab.esFalloDelBroker('Tradier API 400 /accounts/X/orders: {"message":"An error occurred while processing your request","error":"Unexpected server error"}'));
chequear('un 400 de precio invalido NO es del broker',
  ab.esFalloDelBroker('Tradier API 400 /accounts/X/orders: price must be greater than 0') === false);
chequear('un 400 de decimales NO es del broker',
  ab.esFalloDelBroker('Tradier API 400 /accounts/X/orders: price must use up to 2 decimal place(s)') === false);

const T0 = Date.parse('2026-09-03T13:46:00Z');
const minAp = n => T0 + n * 60000;

ab._reset();
const ap1 = ab.registrarFallo({ familia: 'REVERSION', mensaje: 'Tradier API 500 x: backend', ahora: minAp(0) });
chequear('un rechazo suelto todavia no declara apagon', ap1.enApagon === false && ap1.recienDeclarado === false);
const ap2 = ab.registrarFallo({ familia: 'REVERSION', mensaje: 'Tradier API 500 x: backend', ahora: minAp(1) });
chequear('el segundo seguido declara el apagon', ap2.recienDeclarado === true && ap2.enApagon === true);
const ap3 = ab.registrarFallo({ familia: 'TENDENCIA', mensaje: 'Tradier API 500 x: backend', ahora: minAp(2) });
chequear('dentro del apagon ya no se vuelve a avisar', ap3.enApagon === true && ap3.recienDeclarado === false);

// La duracion se cuenta desde el PRIMER fallo, no desde el que lo declara — si no,
// todo apagon saldria reportado mas corto de lo que fue.
const finAp = ab.registrarExito({ ahora: minAp(39) });
chequear('el exito cierra el apagon', finAp.seRecupero === true);
chequear('la duracion se mide desde el primer fallo', finAp.duracionMin === 39, `dio ${finAp.duracionMin}`);
chequear('cuenta los setups perdidos', finAp.setupsPerdidos === 3, `dio ${finAp.setupsPerdidos}`);
chequear('recuerda que familias golpeo', finAp.familias.length === 2);
chequear('tras recuperarse no hay apagon', ab.estado({ ahora: minAp(40) }).enApagon === false);

// Un bug nuestro en medio corta la racha: no puede sostener un apagon ajeno.
ab._reset();
ab.registrarFallo({ familia: 'REVERSION', mensaje: 'Tradier API 500 x: backend', ahora: minAp(0) });
ab.registrarFallo({ familia: 'REVERSION', mensaje: 'Tradier API 400 x: price must be greater than 0', ahora: minAp(1) });
const trasBug = ab.registrarFallo({ familia: 'REVERSION', mensaje: 'Tradier API 500 x: backend', ahora: minAp(2) });
chequear('un fallo nuestro corta la racha del broker', trasBug.recienDeclarado === false && trasBug.fallos === 1);

// Dos fallos separados por horas no son el mismo apagon (el ultimo de un martes y
// el primero de un miercoles no pueden encadenarse en uno de 18 horas).
ab._reset();
ab.registrarFallo({ familia: 'NEUTRAL', mensaje: 'Tradier API 500 x: backend', ahora: minAp(0) });
const lejano = ab.registrarFallo({ familia: 'NEUTRAL', mensaje: 'Tradier API 500 x: backend', ahora: minAp(120) });
chequear('dos fallos lejanos no son el mismo apagon', lejano.recienDeclarado === false && lejano.fallos === 1);

// Un exito sin apagon previo no inventa una recuperacion.
ab._reset();
chequear('exito sin apagon previo no reporta nada', ab.registrarExito({ ahora: minAp(0) }).seRecupero === false);
ab._reset();

// ── 2c. El conteo de impulsos de 15m ───────────────────────────────────────
seccion('El conteo de impulsos (src/impulsos.js)');

const { contarImpulsos, evaluarImpulso, tpPctPorImpulso, MIN_SCORE_IMPULSO_TARDIO } = require('../src/impulsos');

// Velas sinteticas, no una serie real: se prueba la REGLA. Cada vela es {h,l,c}
// y el umbral del dia sale de la mediana de (h-l), que aca vale 2 -> piso de 4.
const v = (h, l) => ({ h, l, c: (h + l) / 2 });

// Tres tramos al alza separados por retrocesos de mas de 4 puntos.
const tresImpulsos = [
  v(7600, 7598), v(7612, 7610), v(7604, 7602),   // impulso 1, retroceso
  v(7620, 7618), v(7612, 7610),                  // impulso 2, retroceso
  v(7628, 7626),                                 // impulso 3, en curso
];
chequear('tres tramos al alza cuentan como impulso 3',
  contarImpulsos({ velas: tresImpulsos, direction: 'BULLISH' }).impulso === 3);

// Un tramo limpio sin retroceso que llegue al umbral sigue siendo el impulso 1,
// por larga que sea la subida: lo que abre un impulso nuevo es el retroceso.
const unSoloTramo = [v(7600, 7598), v(7606, 7604), v(7612, 7610), v(7640, 7638)];
chequear('una subida sin retroceso sigue siendo impulso 1',
  contarImpulsos({ velas: unSoloTramo, direction: 'BULLISH' }).impulso === 1);

// El origen es el extremo del dia, no la primera vela: si el precio primero cae
// y despues sube, los impulsos se cuentan desde el minimo.
const cayoYSubio = [
  v(7620, 7618), v(7606, 7590), v(7600, 7598),   // el minimo real es 7590
  v(7612, 7610), v(7604, 7602),                  // impulso 1 desde el minimo, retroceso
  v(7622, 7620),                                 // impulso 2
];
const cys = contarImpulsos({ velas: cayoYSubio, direction: 'BULLISH' });
chequear('el origen es el minimo del dia, no la primera vela', cys.origenPrecio === 7590);
chequear('tras caer y rebotar dos tramos, va el impulso 2', cys.impulso === 2);

// Sin velas suficientes NO se inventa un numero: aplica=false.
chequear('con menos de 4 velas no aplica',
  contarImpulsos({ velas: [v(7600, 7598)], direction: 'BULLISH' }).aplica === false);
chequear('sin direccion valida no aplica',
  contarImpulsos({ velas: tresImpulsos, direction: 'LATERAL' }).aplica === false);

// La asimetria es el punto delicado de esta regla y por eso se prueba: el
// backtest del 27-ago dice que en BAJISTA el impulso 3+ es el que GANA (8/10),
// asi que encarecer la entrada ahi romperia la mitad bajista del sistema.
chequear('en alcista, el impulso 3 exige score alto',
  evaluarImpulso({ velas: tresImpulsos, direction: 'BULLISH' }).impulsoTardio === true);
chequear('en bajista NUNCA exige score alto, por mas impulsos que lleve',
  evaluarImpulso({ velas: tresImpulsos, direction: 'BEARISH' }).impulsoTardio === false);
chequear('en alcista, los impulsos 1-2 no exigen score alto',
  evaluarImpulso({ velas: unSoloTramo, direction: 'BULLISH' }).impulsoTardio === false);

// El liston exacto. Si alguien lo mueve, que sea a proposito y actualizando esto.
chequear('el impulso tardio pide exactamente 90',
  evaluarImpulso({ velas: tresImpulsos, direction: 'BULLISH' }).minScoreExigido === 90
  && MIN_SCORE_IMPULSO_TARDIO === 90);
chequear('sin impulso tardio no se pide nada extra',
  evaluarImpulso({ velas: unSoloTramo, direction: 'BULLISH' }).minScoreExigido === null);

// FALLA ABIERTA: sin velas suficientes NO se encarece la entrada. Una entrada de
// los primeros 45 min es impulso 1 o 2 por definicion, que es lo que hay que
// dejar pasar barato; subir el liston "por las dudas" castigaria el tramo bueno.
chequear('sin velas suficientes NO se sube el liston',
  evaluarImpulso({ velas: [v(7600, 7598)], direction: 'BULLISH' }).minScoreExigido === null);

// ── La escalera de TP (35 / config / 15) ──
// Son los tres numeros que decidio Guillermo. Quedan clavados aca a proposito:
// mover cualquiera obliga a tocar esta prueba, que es justo lo que se quiere.
chequear('impulso 1 alcista cobra al 35%', tpPctPorImpulso('BULLISH', 1) === 35);
chequear('impulso 2 alcista deja el TP de config', tpPctPorImpulso('BULLISH', 2) === null);
chequear('impulso 3 alcista cobra al 15%', tpPctPorImpulso('BULLISH', 3) === 15);
chequear('impulso 4+ tambien cobra al 15% (el 3 es piso, no igualdad)',
  tpPctPorImpulso('BULLISH', 4) === 15 && tpPctPorImpulso('BULLISH', 9) === 15);
chequear('en bajista el TP NUNCA se toca, en ningun impulso',
  [1, 2, 3, 4, 9].every(i => tpPctPorImpulso('BEARISH', i) === null));

// Y que la escalera llegue de verdad a la lectura que consume el server.
chequear('la lectura de un impulso 1 alcista trae tpPctExigido 35',
  evaluarImpulso({ velas: unSoloTramo, direction: 'BULLISH' }).tpPctExigido === 35);
chequear('la lectura de un impulso 3 alcista trae tpPctExigido 15',
  evaluarImpulso({ velas: tresImpulsos, direction: 'BULLISH' }).tpPctExigido === 15);
chequear('sin velas suficientes no se toca el TP',
  evaluarImpulso({ velas: [v(7600, 7598)], direction: 'BULLISH' }).tpPctExigido === null);

// ── 2d. La figura de cada posicion abierta ─────────────────────────────────
seccion('Las figuras de OptionStrat (src/optionstrat.js)');

// POR QUE EXISTE, con nombre y fecha: el 2026-09-02 se abrio un PMCC de F
// (compra call 10 dic-27 / venta call 14.5 sep-26). El agrupado por
// SUBYACENTE|VENCIMIENTO lo partio en dos, y la mitad corta salio etiquetada
// `short-call`: la hoja de posiciones dibujaba una call DESNUDA, de perdida
// ilimitada, para una pata que estaba cubierta por la LEAPS. Un dibujo de riesgo
// equivocado sobre cuenta real es exactamente lo que esta bateria debe frenar.
const { agruparPosiciones } = require('../src/optionstrat');

const opc = (und, exp, sym, dir, q = 1, precio) => ({
  'instrument-type': 'Equity Option', 'underlying-symbol': und,
  'expires-at': exp + 'T20:00:00.000Z', 'streamer-symbol': sym,
  'quantity-direction': dir, quantity: String(q),
  ...(precio === undefined ? {} : { 'average-open-price': String(precio) }),
});
const acc = (und, q) => ({ 'instrument-type': 'Equity', 'underlying-symbol': und, quantity: String(q) });
const figuras = pos => agruparPosiciones(pos).map(g => g.figura);

const PMCC_F = [
  opc('F', '2026-09-18', '.F260918C14.5', 'Short'),
  opc('F', '2027-12-17', '.F271217C10',   'Long'),
];
const fPmcc = agruparPosiciones(PMCC_F);
chequear('el PMCC de F sale en UNA figura, no partido en dos', fPmcc.length === 1, `dio ${fPmcc.length}`);
chequear('y se llama PMCC', fPmcc[0]?.figura === 'PMCC', `dio ${fPmcc[0]?.figura}`);
// El slug NO es 'poor-mans-covered-call': esa ruta da "Error 404 Strategy type
// not found" en OptionStrat (comprobado en vivo el 2026-09-02).
chequear('se dibuja como diagonal-call-spread, que es lo unico que OptionStrat entiende',
  fPmcc[0]?.url === 'https://optionstrat.com/build/diagonal-call-spread/F/.F271217C10,-.F260918C14.5',
  `dio ${fPmcc[0]?.url}`);
chequear('NUNCA vuelve a salir una call desnuda en un PMCC',
  !figuras(PMCC_F).includes('Short Call'));

// Comprar la CERCANA y vender la lejana tambien es diagonal, pero no es un PMCC
// y llamarlo asi mentiria sobre el riesgo: se prefiere dejarlo en dos mitades.
chequear('la diagonal invertida no se llama PMCC',
  !figuras([opc('F', '2026-09-18', '.F260918C10', 'Long'),
            opc('F', '2027-12-17', '.F271217C14.5', 'Short')]).includes('PMCC'));

chequear('mismo strike y dos vencimientos = calendario',
  figuras([opc('F', '2026-09-18', '.F260918C14', 'Short'),
           opc('F', '2027-12-17', '.F271217C14', 'Long')])[0] === 'Calendar Call Spread');

// Las guardas de la fusion. Con 100 acciones detras la call corta es una covered
// call de verdad y la LEAPS es OTRO trade: fundirlas seria inventar una figura.
chequear('con 100 acciones no se fusiona nada',
  JSON.stringify(figuras([acc('JBLU', 100),
    opc('JBLU', '2026-09-25', '.JBLU260925C5', 'Short'),
    opc('JBLU', '2027-01-15', '.JBLU270115C4', 'Long')])) === '["Covered Call","Long Call"]');
chequear('con dos cortas candidatas la pareja es ambigua y no se fusiona',
  agruparPosiciones([
    opc('F', '2026-09-18', '.F260918C14.5', 'Short'),
    opc('F', '2026-10-16', '.F261016C15',   'Short'),
    opc('F', '2027-12-17', '.F271217C10',   'Long')]).length === 3);

// No regresion: lo que ya funcionaba el 2026-08-31 sigue igual.
chequear('GAP mantiene sus dos figuras separadas por vencimiento',
  JSON.stringify(figuras([acc('GAP', 100),
    opc('GAP', '2026-09-25', '.GAP260925C25', 'Short'),
    opc('GAP', '2026-09-04', '.GAP260904P20', 'Short'),
    opc('GAP', '2026-09-04', '.GAP260904P18', 'Long')])) === '["Bull Put Spread","Covered Call"]');
chequear('la vertical de calls sigue siendo vertical',
  figuras([opc('F', '2026-09-18', '.F260918C14', 'Long'),
           opc('F', '2026-09-18', '.F260918C16', 'Short')])[0] === 'Bull Call Spread');
chequear('el CSP suelto de la rueda no cambia',
  figuras([opc('SOFI', '2026-09-25', '.SOFI260925P17.5', 'Short')])[0] === 'Cash-Secured Put');
chequear('el iron condor de 4 patas no cambia',
  figuras([opc('SPX', '2026-09-18', '.SPX260918P6400', 'Long'),
           opc('SPX', '2026-09-18', '.SPX260918P6500', 'Short'),
           opc('SPX', '2026-09-18', '.SPX260918C7800', 'Short'),
           opc('SPX', '2026-09-18', '.SPX260918C7900', 'Long')])[0] === 'Iron Condor');

// ── 2d-bis. El precio de apertura en la URL de OptionStrat ─────────────────

// POR QUE EXISTE, con nombre y fecha: el 2026-09-04 Guillermo detecto que las
// primas que muestra OptionStrat no coincidian con las que cobro al abrir. La
// URL solo llevaba los CONTRATOS, asi que OptionStrat valoraba la figura a
// precio de mercado de HOY. En el bull put de ADBE decia "NET CREDIT $59.50"
// cuando la prima real fueron $58.00; en la covered call de GAP la desviacion
// era de $117.
//
// La sintaxis `@precio` por pata lo arregla y ademas hace aparecer el
// "Unrealized gain/loss". Verificado en vivo con las cuatro formas que
// manejamos (ADBE, SPX, NU x2 y F).
const conPrecio = agruparPosiciones([
  opc('ADBE', '2026-10-02', '.ADBE261002P240', 'Long',  1, 2.03),
  opc('ADBE', '2026-10-02', '.ADBE261002P245', 'Short', 1, 2.61),
]);
chequear('la URL lleva el precio de apertura de cada pata',
  conPrecio[0]?.url === 'https://optionstrat.com/build/bull-put-spread/ADBE/.ADBE261002P240@2.03,-.ADBE261002P245@2.61',
  `dio ${conPrecio[0]?.url}`);

// Con cantidad 2 el precio va en las DOS copias de la pata.
chequear('la pata repetida por cantidad lleva precio en cada copia',
  agruparPosiciones([opc('NU', '2026-11-20', '.NU261120C14', 'Short', 2, 2.11)])[0]?.url
    === 'https://optionstrat.com/build/covered-call/NU/-.NU261120C14@2.11,-.NU261120C14@2.11'
  || agruparPosiciones([opc('NU', '2026-11-20', '.NU261120C14', 'Short', 2, 2.11)])[0]?.url
    === 'https://optionstrat.com/build/short-call/NU/-.NU261120C14@2.11,-.NU261120C14@2.11');

// Sin precio no se inventa uno: se emite la pata pelada y OptionStrat valora a
// mercado. Es peor que con precio, pero mejor que un grafico equivocado.
chequear('sin average-open-price la URL sale sin @, no con @0 ni @NaN',
  !/@/.test(agruparPosiciones([opc('SOFI', '2026-09-25', '.SOFI260925P17.5', 'Short')])[0]?.url || ''));
chequear('un precio invalido tampoco ensucia la URL',
  !/@/.test(agruparPosiciones([opc('SOFI', '2026-09-25', '.SOFI260925P17.5', 'Short', 1, 0)])[0]?.url || ''));

// El decimal se normaliza: 55.70 -> 55.7, como hace la propia OptionStrat.
chequear('el precio se normaliza sin ceros de relleno',
  /@55\.7,/.test(agruparPosiciones([
    opc('SPX', '2026-10-16', '.SPXW261016P7310', 'Long',  1, 55.70),
    opc('SPX', '2026-10-16', '.SPXW261016P7320', 'Short', 1, 57.10),
  ])[0]?.url || ''));

// ── 2e. Indices: sector propio y simbolo correcto en Yahoo ─────────────────
seccion('Los indices (src/indices.js)');

// POR QUE EXISTE: el 2026-09-02 SPX y VIX salian en el donut de sectores como
// "Sin sector". Yahoo solo devuelve `sector` para quoteType EQUITY, asi que un
// indice nunca lo va a traer; la categoria la tenemos que poner nosotros.
const { esIndice, sectorDe, simboloYahoo, SECTOR_INDICES } = require('../src/indices');

chequear('SPX y VIX son indices', esIndice('SPX') && esIndice('VIX'));
chequear('los ETF de indice tambien (SPY, QQQ, IWM, DIA)',
  ['SPY','QQQ','IWM','DIA'].every(esIndice));
chequear('todos caen en el sector Indices',
  ['SPX','VIX','SPY','QQQ','NDX','RUT'].every(s => sectorDe(s) === SECTOR_INDICES));
chequear('una accion NO es indice y sigue preguntandole a Yahoo',
  !esIndice('F') && !esIndice('NU') && sectorDe('ADBE') === null);
chequear('da igual mayusculas o minusculas', esIndice('spx') && esIndice('vix'));

// Los simbolos, verificados contra Yahoo en vivo el 2026-09-02. Estos numeros
// estan clavados a proposito: si alguien cambia un mapeo, esta prueba lo canta.
chequear('SPX -> ^GSPC (S&P 500)',       simboloYahoo('SPX') === '^GSPC');
// `VIX` pelado devuelve una respuesta SIN precio. Este era el bug: VIX no estaba
// mapeado, asi que /api/market-data/VIX venia vacio.
chequear('VIX -> ^VIX, no `VIX`',        simboloYahoo('VIX') === '^VIX');
// ^IXIC es el NASDAQ Composite (26.217); NDX es el NASDAQ-100 (29.143). Eran dos
// indices distintos con un 11% de diferencia.
chequear('NDX -> ^NDX (NASDAQ-100), no ^IXIC (Composite)',
  simboloYahoo('NDX') === '^NDX');
chequear('RUT -> ^RUT (Russell 2000)',   simboloYahoo('RUT') === '^RUT');
chequear('las semanales del SPX cuelgan del mismo indice',
  simboloYahoo('SPXW') === '^GSPC');
chequear('un ETF se pide por su propio ticker, sin ^',
  simboloYahoo('SPY') === 'SPY' && simboloYahoo('QQQ') === 'QQQ');
chequear('una accion se pide tal cual', simboloYahoo('F') === 'F');

// ── 2f. El calendario de la NYSE ───────────────────────────────────────────
//
// Por que existe: el 2026-09-06 el usuario vio que el bot trabajaba un domingo y
// pregunto por el lunes. Habia siete guards de "hay mercado hoy?" en el repo y
// solo uno —el de server.js— conocia los feriados; los demas solo miraban sabado
// y domingo, asi que el lunes 2026-09-07 (Labor Day) iban a correr todos. La
// tabla se extrajo a src/calendario_nyse.json y estas pruebas son lo que impide
// que alguien vuelva a escribir la suya.
seccion('El calendario de la NYSE (src/calendario_nyse.js)');

const cal = require('../src/calendario_nyse');

// El caso que origino todo. Labor Day 2026 cae lunes: dia habil y sin campana.
chequear('Labor Day 2026-09-07 NO es dia de mercado', cal.esDiaDeMercado('2026-09-07') === false);
chequear('...y dice que el motivo es el feriado, no el fin de semana',
         cal.motivoCierre('2026-09-07') === 'feriado', `dio ${cal.motivoCierre('2026-09-07')}`);
chequear('el domingo se distingue del feriado',
         cal.motivoCierre('2026-09-06') === 'fin_de_semana', `dio ${cal.motivoCierre('2026-09-06')}`);
chequear('el martes siguiente si es dia de mercado', cal.esDiaDeMercado('2026-09-08') === true);

// Lo que necesita el 1DTE: el viernes previo a Labor Day apunta al MARTES.
// Con el salto de solo-fin-de-semana apuntaba al lunes, una expiracion que no
// existe en la cadena, y findStrikesByDelta caia al fallback.
chequear('siguienteDiaDeMercado salta fin de semana Y feriado',
         cal.siguienteDiaDeMercado('2026-09-04') === '2026-09-08',
         `dio ${cal.siguienteDiaDeMercado('2026-09-04')}`);

// La trampa que ya estaba documentada y no hay que perder: el 1-ene-2028 cae
// sabado, asi que la NYSE cierra el viernes 31-dic-2027.
chequear('2027-12-31 esta en el calendario (Año Nuevo 2028 cae sabado)',
         cal.esFeriado('2027-12-31') === true);
chequear('...y 2028-01-01 no hace falta que este (es sabado)',
         cal.esDiaDeMercado('2028-01-01') === false);

// Ningun feriado observado puede caer en fin de semana: si pasa es un tipeo.
const feriadoEnFinde = [...cal.FERIADOS].filter(f => cal.esFinDeSemana(f));
chequear('ningun feriado de la tabla cae en sabado o domingo',
         feriadoEnFinde.length === 0, `caen en finde: ${feriadoEnFinde.join(', ')}`);
const mediosDuplicados = [...cal.MEDIOS_DIAS].filter(d => cal.FERIADOS.has(d));
chequear('ningun medio dia esta ademas como feriado (son cosas distintas)',
         mediosDuplicados.length === 0, `duplicados: ${mediosDuplicados.join(', ')}`);

// El borde exacto de la campana. Caza el dia que alguien cambie un < por un <=.
const enET = (fecha, hhmm) => {
  // Construye un instante que en Nueva York sea exactamente esa hora.
  const [h, m] = hhmm.split(':').map(Number);
  for (let offset = 0; offset <= 26; offset++) {
    const d = new Date(`${fecha}T${String(offset).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
    if (cal.fechaET(d) === fecha && cal.minutosET(d) === h * 60 + m) return d;
  }
  throw new Error(`no se pudo construir ${fecha} ${hhmm} ET`);
};
chequear('9:29 ET todavia no es horario de mercado', cal.enHorarioDeMercado(enET('2026-09-08', '9:29')) === false);
chequear('9:30 ET ya lo es',                          cal.enHorarioDeMercado(enET('2026-09-08', '9:30')) === true);
chequear('15:59 ET sigue siendolo',                   cal.enHorarioDeMercado(enET('2026-09-08', '15:59')) === true);
chequear('16:00 ET ya no',                            cal.enHorarioDeMercado(enET('2026-09-08', '16:00')) === false);
chequear('a las 12:00 de Labor Day no hay mercado',   cal.enHorarioDeMercado(enET('2026-09-07', '12:00')) === false);

// Medio dia: la campana suena a la 1pm, no a las 4. Es un dia ABIERTO.
chequear('2026-11-27 es medio dia y si es dia de mercado',
         cal.esMedioDia('2026-11-27') === true && cal.esDiaDeMercado('2026-11-27') === true);
chequear('en medio dia a las 12:00 hay mercado',  cal.enHorarioDeMercado(enET('2026-11-27', '12:00')) === true);
chequear('en medio dia a las 13:00 ya cerro',     cal.enHorarioDeMercado(enET('2026-11-27', '13:00')) === false);
chequear('en un dia normal a las 13:00 no cerro', cal.enHorarioDeMercado(enET('2026-09-08', '13:00')) === true);

// La ventana propia del gamma_daemon (9:00-16:05 ET) tampoco corre un feriado.
chequear('la ventana del daemon no abre en Labor Day',
         cal.enVentanaET(9 * 60, 16 * 60 + 5, { ahora: enET('2026-09-07', '10:00') }) === false);
chequear('la ventana del daemon abre a las 9:00 de un dia normal',
         cal.enVentanaET(9 * 60, 16 * 60 + 5, { ahora: enET('2026-09-08', '9:00') }) === true);
chequear('la ventana del daemon se recorta sola en medio dia',
         cal.enVentanaET(9 * 60, 16 * 60 + 5, { ahora: enET('2026-11-27', '14:00') }) === false);

// El calendario tiene fecha de caducidad y tiene que fallar RUIDOSAMENTE cuando
// se le acabe, no degradarse a "todos los dias son habiles". Esta prueba se
// pone roja el dia que haya que extender el JSON, que es exactamente el aviso
// que hace falta — no un console.warn que nadie lee.
chequear(`el calendario NYSE todavia cubre hoy (llega a ${cal.HASTA})`,
         cal.fechaET() <= cal.HASTA,
         'hay que extender src/calendario_nyse.json con el año siguiente');

// Nadie puede volver a escribir su propia lista. El gemelo de PowerShell tiene
// que LEER el JSON, no copiarlo: si aparece una fecha suelta ahi dentro, es que
// alguien empezo a duplicar el calendario otra vez.
{
  const fs = require('fs'), path = require('path');
  const ps = fs.readFileSync(path.join(__dirname, 'calendario_nyse.ps1'), 'utf8');
  const fechasSueltas = (ps.match(/"\d{4}-\d{2}-\d{2}"/g) || []);
  chequear('scripts/calendario_nyse.ps1 no tiene fechas escritas a mano',
           fechasSueltas.length === 0, `encontradas: ${fechasSueltas.join(', ')}`);
  chequear('scripts/calendario_nyse.ps1 lee el mismo JSON que Node',
           ps.includes('calendario_nyse.json'));
}

// ── 3. Humo: que TODOS los endpoints respondan ──────────────────────────────
//
// Excluidos a proposito, con su razon. Un GET no deberia tener efectos, pero
// este si los tiene y la prueba no puede spamear notificaciones cada vez.
const EXCLUIDOS = {
  '/api/test-extrinsic': 'dispara checkExtrinsicAndNotify(): manda una notificacion real',
};

// Roturas YA CONOCIDAS, con fecha y diagnostico. No hacen fallar la corrida —el
// trabajo de esta bateria es cazar lo NUEVO— pero se imprimen fuerte en cada
// pasada para que sean deuda visible y no un test silenciado.
//
// Si una entrada lleva semanas aca, el problema ya no es el endpoint: es que
// nadie decidio que hacer con el.
const CONOCIDOS = {
  // Vacio a proposito. La unica entrada que hubo —/api/margin-raw— duro un dia:
  // la bateria la encontro el 2026-08-22 y el endpoint se borro el mismo dia por
  // ser codigo muerto. Que esta lista este vacia es el estado correcto; si algo
  // entra aca, tiene que salir pronto o deja de ser deuda y pasa a ser costumbre.
};

const conocidosVistos = [];

async function humo(base = BASE) {
  seccion(`Humo: todos los GET contra ${base}`);
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const rutas = [...new Set(
    [...src.matchAll(/app\.get\('(\/api\/[^']+)'/g)].map(m => m[1]),
  )].filter(r => !r.includes(':')).sort();

  console.log(`  ${rutas.length} rutas sin parametros` +
              `  (${Object.keys(EXCLUIDOS).length} excluida por efectos secundarios)`);

  for (const ruta of rutas) {
    if (EXCLUIDOS[ruta]) { console.log(`  SALTA  ${ruta} — ${EXCLUIDOS[ruta]}`); continue; }
    let estado = null, err = null;
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 45000);
      const res = await fetch(base + ruta, { signal: ctrl.signal });
      clearTimeout(to);
      estado = res.status;
    } catch (e) { err = e.message; }
    // Un 4xx puede ser legitimo (falta un parametro de query, no hay datos aun).
    // Un 5xx NUNCA lo es: significa que el endpoint se cayo solo.
    const bien = estado !== null && estado < 500;
    if (!bien && CONOCIDOS[ruta]) {
      conocidosVistos.push(ruta);
      console.log(`  DEUDA  ${ruta} -> ${err || 'HTTP ' + estado}`);
      console.log(`         ${CONOCIDOS[ruta]}`);
      continue;
    }
    chequear(`GET ${ruta}`, bien, err ? `sin respuesta: ${err}` : `HTTP ${estado}`);
    if (bien && estado >= 400) console.log(`  aviso  ${ruta} -> HTTP ${estado} (no es 5xx, se acepta)`);
    // Una rotura conocida que se arreglo sola deja de ser conocida: hay que
    // sacarla de la lista o tapara una regresion futura.
    if (bien && CONOCIDOS[ruta]) {
      console.log(`  OJO    ${ruta} ya responde bien: sacalo de CONOCIDOS en scripts/pruebas.js`);
    }
  }

  // El calendario no se rompe con un 500: se rompe callado. Si /api/transactions
  // vuelve a recortar `strategies`, las casillas siguen mostrando P&L y el
  // detalle del dia sale "Sin trades este dia" para todos los meses viejos. Solo
  // se ve contando. (2026-09-05: 304 round-trips, 200 devueltos, 56 dias mudos.)
  try {
    const res = await fetch(base + '/api/transactions');
    const j   = await res.json();
    const m   = j.metrics || {};
    chequear('/api/transactions devuelve TODOS los round-trips, sin recortar',
      m.totalStrategies > 0 && (m.strategies || []).length === m.totalStrategies,
      `dice tener ${m.totalStrategies} y devuelve ${(m.strategies || []).length}`);

    // El sintoma exacto que reporto el usuario: la casilla muestra un numero y al
    // hacer click sale "Sin trades este dia". Pasa cuando un dia tiene P&L en
    // `stratByDay` pero ninguna fila en `strategies`, que es de donde el
    // frontend saca el detalle. Las dos cosas salen del mismo calculo: si se
    // separan, es que algo recorto una y no la otra.
    const conDetalle = new Set((m.strategies || []).map(x => x.closeDate).filter(Boolean));
    const mudos = Object.keys(m.stratByDay || {}).filter(d => !conDetalle.has(d));
    chequear('ningun dia del calendario se queda sin su detalle',
      mudos.length === 0,
      `${mudos.length} dias con P&L y sin trades: ${mudos.slice(0, 5).join(', ')}${mudos.length > 5 ? '...' : ''}`);

    // La curva arrancaba de un 10644 escrito a mano cuando lo depositado eran
    // $10.676,03: $32,03 de desfase en el punto de partida y en el pico contra
    // el que se mide el drawdown. Un numero de capital a mano se queda viejo al
    // primer deposito nuevo, asi que se compara contra el ledger.
    const cur = await (await fetch(base + '/api/curve')).json();
    const primerDia = (cur.curve?.labels || [])[0] || '';
    const aporteHasta = (j.items || [])
      .filter(t => t['transaction-type'] === 'Money Movement' &&
                   /Deposit|Withdrawal/i.test(t['transaction-sub-type'] || '') &&
                   (t['transaction-date'] || '').slice(0, 10) <= primerDia)
      .reduce((a, t) => a + parseFloat(t['net-value'] || t.value || 0) *
              ((t['net-value-effect'] || t['value-effect']) === 'Credit' ? 1 : -1), 0);
    chequear('la curva arranca del capital realmente depositado',
      aporteHasta > 0 && Math.abs((cur.curve?.initial || 0) - aporteHasta) < 0.02,
      `la curva dice ${cur.curve?.initial} y el ledger ${aporteHasta.toFixed(2)}`);

    // /report no empieza por /api/, asi que el barrido de rutas de arriba no lo
    // toca — y es el PDF que el usuario manda para afuera. Tenia el capital
    // escrito a mano; que responda es lo minimo.
    const rep = await fetch(base + '/report');
    chequear('GET /report responde', rep.status < 500, `HTTP ${rep.status}`);
  } catch (e) {
    chequear('/api/transactions se puede leer para revisar el calendario', false, e.message);
  }
}

async function conServidorLocal(fn) {
  const { spawn } = require('child_process');
  // Puerto libre pedido al sistema, no uno fijo. Con 3999 fijo el hook fallo una
  // vez por colision con una corrida anterior que todavia soltaba el puerto, y
  // un guardian que falla al azar es peor que ninguno: enseña a saltarselo con
  // SKIP_PRUEBAS y deja de guardar nada.
  const puerto = await new Promise((resolve, reject) => {
    const srv = require('net').createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
  console.log(`\n  levantando servidor local en MODO_PRUEBAS (puerto ${puerto})...`);
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: { ...process.env, MODO_PRUEBAS: '1', PORT: String(puerto) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let salida = '';
  let murio = null;
  srv.stdout.on('data', d => { salida += d; });
  srv.stderr.on('data', d => { salida += d; });
  // Si el proceso se cae al arrancar, fallar YA con su salida en vez de esperar
  // el minuto completo: un arranque roto y un arranque lento son diagnosticos
  // distintos y no deberian verse igual.
  srv.on('exit', (code) => { murio = code; });
  try {
    // Esperar a que responda, no dormir un rato fijo: si arranca lento la
    // prueba fallaria por impaciencia y no por un defecto.
    const limite = Date.now() + 90000;
    let vivo = false;
    while (Date.now() < limite && murio === null) {
      try {
        const r = await fetch(`http://localhost:${puerto}/api/health`);
        if (r.ok) { vivo = true; break; }
      } catch { /* todavia no levanta */ }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!vivo) {
      console.log(murio !== null
        ? `  FALLA  el servidor local murio al arrancar (codigo ${murio})`
        : '  FALLA  el servidor local no respondio en 90s');
      console.log(salida.split('\n').slice(-15).join('\n'));
      fail++; fallos.push(murio !== null ? `el servidor local murio al arrancar (codigo ${murio})` : 'el servidor local no arranco en 90s');
      return;
    }
    await fn(`http://localhost:${puerto}`);
  } finally {
    srv.kill();
  }
}

// ── Humo de POST (2026-09-06) ───────────────────────────────────────────────
//
// POR QUE EXISTE, con caso y fecha. Esta bateria nacio el 2026-08-22 para cazar
// un ReferenceError que devolvia 500 y que `node -c` no veia. El 2026-09-06 paso
// EXACTAMENTE lo mismo —una funcion a nivel de modulo leyendo `netGex` del cierre
// del handler, 500 en cada request— y la bateria lo dejo pasar: `humo()` enumera
// `app.get(` y nada mas. Ningun POST se probaba nunca.
//
// Y el que se rompio no es uno cualquiera: POST /api/spx/sigma-levels es la UNICA
// puerta por la que el gamma_daemon entrega muros, GEX, DEX y el spot. Con eso en
// 500 el servidor entra a la sesion ciego, cayendo al calculo interno sin que
// nada lo diga. Se descubrio verificando a mano contra produccion un domingo; el
// lunes a las 9:30 lo habria descubierto el mercado.
//
// Los POST no se pueden barrer a ciegas como los GET: escriben. Por eso van uno
// por uno, con su carga minima y su limpieza. Lo que NO se cubre se lista al
// final, para que el hueco se vea en vez de suponerse tapado.
async function humoPost(base = BASE) {
  seccion(`Humo: POST con efectos, contra ${base}`);
  const cubiertos = new Set(['/api/spx/sigma-levels']);

  // Valores realistas a proposito: con basura, el filtro de cordura la rechaza
  // antes de llegar al codigo que se quiere probar y la prueba pasaria en falso.
  const lectura = {
    netGex: -14.81e9, netDex: 7.69e9, netVanna: 64.7e9, regime: 'NEGATIVO',
    callWall: 7825, putWall: 7675, gammaFlip: 7727, mvs: 7720,
    spxPrice: 7718.6, totalGamma: 89.23e9, maxPain: 7705,
    expiry: '2026-09-08', capturadoEn: new Date().toISOString(),
  };
  let estado = null, cuerpo = null, err = null;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 45000);
    const res = await fetch(base + '/api/spx/sigma-levels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lectura), signal: ctrl.signal,
    });
    clearTimeout(to);
    estado = res.status;
    try { cuerpo = await res.json(); } catch { /* no era JSON */ }
  } catch (e) { err = e.message; }

  chequear('POST /api/spx/sigma-levels no se cae (es la unica entrada del daemon)',
    estado !== null && estado < 500,
    err ? `sin respuesta: ${err}` : `HTTP ${estado}`);

  // El contrato con el daemon: la respuesta trae fuerzaMuros con los dos muros.
  // Si esto se rompe, el daemon empuja 0 y los muros pierden la tercera palabra
  // sin que nadie se entere — un fallo callado, que es el peor de todos.
  if (estado !== null && estado < 500) {
    chequear('la respuesta trae fuerzaMuros con call y put (contrato con el daemon)',
      !!(cuerpo && cuerpo.fuerzaMuros && cuerpo.fuerzaMuros.call && cuerpo.fuerzaMuros.put),
      `fuerzaMuros = ${JSON.stringify(cuerpo && cuerpo.fuerzaMuros)}`);

    // maxPainGrafico es lo que el daemon escribe en in_31. Si llega vacio, el
    // grafico se queda SIN linea de max pain (el guard del Pine es
    // max_pain_G > 0) — y es un fallo callado. No puede ser null nunca: el
    // respaldo es el max pain de Sigma, que viene en el mismo POST.
    chequear('la respuesta trae maxPainGrafico (lo que se dibuja en in_31)',
      !!(cuerpo && cuerpo.maxPainGrafico > 0),
      `maxPainGrafico = ${cuerpo && cuerpo.maxPainGrafico}, fuente = ${cuerpo && cuerpo.maxPainFuenteGrafico}`);
  }

  // Limpieza: la lectura de prueba NO puede quedarse en el historial, que es de
  // donde salen las calibraciones.
  const guardada = cuerpo && cuerpo.saved && cuerpo.saved.updatedAt;
  if (guardada) {
    try {
      const del = await fetch(`${base}/api/spx/sigma-levels?updatedAt=${encodeURIComponent(guardada)}`,
                              { method: 'DELETE' });
      const dj = await del.json();
      chequear('la lectura de prueba se borro del historial',
        Number(dj.borradas) >= 1,
        `borradas: ${dj.borradas}`);
    } catch (e) {
      chequear('la lectura de prueba se borro del historial', false, e.message);
    }
  }

  // Censo de lo que sigue sin cubrir. No falla el push: solo lo hace visible,
  // para que manana se sepa cuanto falta en vez de suponer que esta tapado.
  const fs2 = require('fs');
  const src2 = fs2.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const posts = [...new Set([...src2.matchAll(/app\.post\('(\/api\/[^']+)'/g)].map(m => m[1]))]
    .filter(r => !r.includes(':') && !cubiertos.has(r)).sort();
  console.log(`  ${cubiertos.size} POST cubierto(s); ${posts.length} sin cubrir todavia:`);
  for (const p of posts) console.log(`    - ${p}`);
}

(async () => {
  if (LOCAL) await conServidorLocal(async (base) => { await humo(base); await humoPost(base); });
  if (HUMO) await humo();
  console.log('\n' + '='.repeat(70));
  if (fail) {
    console.log(` ${ok} pasaron, ${fail} FALLARON`);
    console.log(' No desplegar hasta resolverlas:');
    for (const f of fallos) console.log(`   - ${f}`);
  } else {
    console.log(` ${ok} pruebas pasaron` + (HUMO ? ' (incluido el humo de endpoints)' : ' (unidad; falta --humo)'));
  }
  if (conocidosVistos.length) {
    console.log(`
 ${conocidosVistos.length} rotura(s) CONOCIDA(S) sin resolver: ${conocidosVistos.join(', ')}`);
    console.log(' No frenan el despliegue, pero siguen rotas. Ver CONOCIDOS en scripts/pruebas.js.');
  }
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
})();
