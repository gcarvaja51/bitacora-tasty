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
// Promesas de pruebas de unidad asincronas: el resumen final las espera.
const pruebasAsync = [];

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

// ── 1c. Posiciones Tradier: una fila por trade, aunque compartan pata ───────
// Caso real del 2026-10-01: MEDIODIA y TENDENCIA compraron las dos la 7635P y
// la fila del IB salia con la entrada de la otra (premium $470 en vez de $1.200).
seccion('Posiciones Tradier por ejecucion (src/positions_tradier_adapter.js)');
{
  const { groupPositionsTradierPorEjecucion } = require('../src/positions_tradier_adapter');
  const S = k => `SPXW261001${k}000`;
  const ib = { id: 'ib', status: 'filled', timestamp: '2026-10-01T16:30:25Z', contracts: 1,
    strategy: 'IRON_CONDOR', strategyFamily: 'MEDIODIA',
    legs: { putShortSym: S('P07650'), putLongSym: S('P07635'), callShortSym: S('C07650'), callLongSym: S('C07665') },
    paperEntry: { confiable: true, patas: [
      { shortSym: S('P07650'), longSym: S('P07635'), shortBid: 15.9, longAsk: 8.6 },
      { shortSym: S('C07650'), longSym: S('C07665'), shortBid: 8.6, longAsk: 3.9 }] } };
  const bear = { id: 'bear', status: 'filled', timestamp: '2026-10-01T14:30:36Z', contracts: 1,
    strategy: 'BEAR_PUT_SPREAD', strategyFamily: 'TENDENCIA',
    legs: { shortSym: S('P07625'), longSym: S('P07635') },
    paperEntry: { confiable: true, patas: [{ shortSym: S('P07625'), longSym: S('P07635'), shortBid: 11.1, longAsk: 15.9 }] } };
  const q = { [S('P07650')]: { mark: 1 }, [S('P07635')]: { mark: 0.3 }, [S('C07650')]: { mark: 24.9 },
              [S('C07665')]: { mark: 12.2 }, [S('P07625')]: { mark: 0.1 } };
  const base = [
    { symbol: S('P07650'), quantity: -1, cost_basis: -2220 },
    { symbol: S('C07650'), quantity: -1, cost_basis: -610 },
    { symbol: S('C07665'), quantity: 1,  cost_basis: 275 },
  ];
  // Las dos vivas: la 7635P aparece fundida (cantidad 2) en el broker.
  let g = groupPositionsTradierPorEjecucion(base.concat([
    { symbol: S('P07635'), quantity: 2, cost_basis: 2840 },
    { symbol: S('P07625'), quantity: -1, cost_basis: -1190 }]), q, {}, [bear, ib]);
  const fIb = g.find(x => x.execId === 'ib'), fBear = g.find(x => x.execId === 'bear');
  chequear('pata compartida: dos filas, una por trade', g.length === 2 && fIb && fBear, `dio ${g.length}`);
  chequear('el IB cobra su propia prima ($1.200)', fIb && Math.round(fIb.premiumNet) === 1200, `dio ${fIb && fIb.premiumNet}`);
  chequear('el IB se reconoce como mariposa', fIb && fIb.esButterfly === true);
  chequear('la vertical se queda con su entrada', fBear && Math.round(fBear.premiumNet) === -480, `dio ${fBear && fBear.premiumNet}`);
  // TENDENCIA ya cerro en el broker pero el registro sigue 'filled': no reclama nada.
  g = groupPositionsTradierPorEjecucion(base.concat([{ symbol: S('P07635'), quantity: 1, cost_basis: 1420 }]), q, {}, [bear, ib]);
  chequear('un registro sin patas en el broker no inventa fila', g.length === 1 && g[0].execId === 'ib', `dio ${g.length}`);
  chequear('y el IB no hereda la entrada de la otra', Math.round(g[0].premiumNet) === 1200, `dio ${g[0].premiumNet}`);
  // Lo que no tiene registro (La Rueda) sigue saliendo como antes.
  g = groupPositionsTradierPorEjecucion([{ symbol: 'ANET260904P00160000', quantity: -1, cost_basis: -300 }], {}, {}, [ib]);
  chequear('sin registro se agrupa como antes', g.length === 1 && !g[0].execId);
}

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
  if (e.expType === '1DTE') return false;
  if (e.strategyFamily === 'MEDIODIA') return false;
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
// El IC 1DTE no se cruza con nadie (bug del 2026-09-10): vivo hasta las 10:30 del
// dia siguiente frenaba al direccional y al IC 0DTE en la primera hora.
chequear('un IC 1DTE abierto NO bloquea',
  bloquea({ status: 'filled', strategyFamily: 'NEUTRAL', strategy: 'IRON_CONDOR', expType: '1DTE' }) === false);
// ...pero el 0DTE si: neutral y direccional del mismo dia no conviven.
chequear('un IC 0DTE abierto SI bloquea',
  bloquea({ status: 'filled', strategyFamily: 'NEUTRAL', strategy: 'IRON_CONDOR', expType: '0DTE' }) === true);
// MEDIODIA no bloquea a nadie (decision del usuario, 2026-09-28), aunque sea un
// IRON_CONDOR 0DTE para el monitor.
chequear('un MEDIODIA abierto NO bloquea',
  bloquea({ status: 'filled', strategyFamily: 'MEDIODIA', strategy: 'IRON_CONDOR', expType: '0DTE' }) === false);
// El caso de los 61 bloqueos en 10 dias: el cierre ya se mando y la
// reconciliacion (cada 5 min) todavia no cambio la etiqueta.
chequear('con el cierre ya mandado hace rato, deja de bloquear',
  bloquea({ status: 'filled', strategyFamily: 'TENDENCIA', closeOrderSentAt: haceRato }) === false);
// Pero no de inmediato: si no, se apilarian dos posiciones por un cierre que
// todavia no llena.
chequear('con el cierre recien mandado sigue bloqueando (gracia de 90s)',
  bloquea({ status: 'filled', strategyFamily: 'TENDENCIA', closeOrderSentAt: reciente }) === true);

// ── 2b-ter. El liston tras perdida ─────────────────────────────────────────
seccion('El liston tras perdida (evaluarListonTrasPerdida)');

const { evaluarListonTrasPerdida } = require('../src/frenos');
// El caso real del 09-sep 13:06: SL de -$210 contra la cadena real que el
// sandbox anotaba +$50. Con la regla vieja entro un score 85; tenia que pedir 90.
let lt = evaluarListonTrasPerdida([{ status: 'closed', closedAt: '2026-09-09T17:00:00Z', pnl: 50,
  paperPnl: { bruto: -210, neto: -214.2, confiable: true } }]);
chequear('perdida real con el sandbox en verde: sube el liston', lt.alto === true && lt.pnl === -210, JSON.stringify(lt));
// El reves: el sandbox marca perdida y la cadena real gano. No debe frenar.
lt = evaluarListonTrasPerdida([{ status: 'closed', closedAt: '2026-09-09T17:00:00Z', pnl: -40,
  paperPnl: { bruto: 95, neto: 90.8, confiable: true } }]);
chequear('ganancia real con el sandbox en rojo: NO sube el liston', lt.alto === false, JSON.stringify(lt));
chequear('solo mira el ULTIMO cierre del dia',
  evaluarListonTrasPerdida([{ status: 'closed', closedAt: '2026-09-09T18:00:00Z', paperPnl: { bruto: 60, confiable: true } },
                            { status: 'closed', closedAt: '2026-09-09T17:00:00Z', paperPnl: { bruto: -200, confiable: true } }]).alto === false);
// Sin resultado todavia: ante la duda frena, igual que antes.
lt = evaluarListonTrasPerdida([{ status: 'closed', closedAt: '2026-09-09T17:00:00Z' }]);
chequear('sin resultado asentado: frena por precaucion', lt.alto === true && lt.pendiente === true);
chequear('sin cierres hoy: liston base', evaluarListonTrasPerdida([]).alto === false);

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

// ── 2c-bis. La reversion de apertura ───────────────────────────────────────
seccion('La reversion de apertura (src/reversion_apertura.js)');
{
  const RA = require('../src/reversion_apertura');
  // Viernes 25-sep plano en 7700; lunes 28-sep abre 7680 (gap -0,26%, EDT = UTC-4).
  const T = (dia, hh, mm) => Date.parse(`2026-09-${dia}T${String(hh + 4).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  const v15 = [];
  for (let m = 570; m < 960; m += 15) v15.push({ t: T(25, Math.floor(m / 60), m % 60), o: 7700, h: 7701, l: 7699, c: 7700 });
  v15.push({ t: T(28, 9, 30), o: 7680, h: 7682, l: 7668, c: 7672 });
  const ahora = T(28, 9, 31);
  const dia = RA.evaluarDia(v15, ahora, {});
  chequear('gap abajo de 0,26% a 20 pts de las EMAs: dia apto', dia.apto === true && dia.direccionGap === 'ABAJO', JSON.stringify(dia));
  chequear('gap de 0,1%: no apto', RA.evaluarDia(v15.map((v, i) => i === v15.length - 1 ? { ...v, o: 7692 } : v), ahora, {}).apto === false);

  // 2m: viernes plano en 7700 (60 velas) y el lunes cae hasta 7672 y gira.
  const v2 = [];
  for (let m = 840; m < 960; m += 2) v2.push({ t: T(25, Math.floor(m / 60), m % 60), o: 7700, h: 7701, l: 7699, c: 7700 });
  const hoy = [[7680, 7681, 7676, 7677], [7677, 7678, 7672, 7673], [7673, 7674, 7671, 7672], [7672, 7679, 7671, 7678]];
  hoy.forEach(([o, h, l, c], i) => v2.push({ t: T(28, 9, 30 + 2 * i), o, h, l, c }));
  const cierreGiro = T(28, 9, 38);   // la vela de las 9:36 (la del giro) cierra a las 9:38
  const e = RA.evaluarEntrada(v2, dia, cierreGiro, {});
  chequear('alejamiento >=15 + cierre sobre el maximo anterior: entra LARGO', e.entra === true && e.lado === 'LARGO', JSON.stringify(e));
  chequear('stop en el extremo menos 2', e.entra && e.stop === 7669);
  chequear('la vela en formacion NO cuenta', RA.evaluarEntrada(v2, dia, cierreGiro - 1000, {}).entra === false);
  chequear('con gap ARRIBA no se opera el largo', RA.evaluarEntrada(v2, { ...dia, direccionGap: 'ARRIBA' }, cierreGiro, {}).entra === false);
  chequear('fuera de la ventana no entra', RA.evaluarEntrada(v2, dia, cierreGiro, { ventanaHastaMin: 9 * 60 + 34 }).entra === false);
  chequear('alejamiento insuficiente no entra', RA.evaluarEntrada(v2, dia, cierreGiro, { alejamientoMinPts: 40 }).entra === false);
  chequear('la EMA con semilla en el primer valor (como pandas adjust=False)',
    Math.abs(RA.ema([1, 2, 3], 3).at(-1) - 2.25) < 1e-9);

  // El precio en vivo manda sobre la vela cerrada. Caso real del 2-oct-2026: corto
  // de la vela de las 9:52 (EMA10 7734,41, stop 7752,08) mandado con el SPX en 7725.
  const oct2 = { lado: 'CORTO', ema10: 7734.41, stop: 7752.08 };
  chequear('2-oct: con el spot ya bajo la EMA, el corto NO entra',
    RA.validarPrecioVivo(oct2, 7725).ok === false);
  chequear('el mismo corto con el spot todavia sobre la EMA si entra',
    RA.validarPrecioVivo(oct2, 7740).ok === true && RA.validarPrecioVivo(oct2, 7740).restantePts === 5.59);
  chequear('spot justo en la EMA: objetivo alcanzado, no entra', RA.validarPrecioVivo(oct2, 7734.41).ok === false);
  chequear('spot mas alla del stop del corto: no entra', RA.validarPrecioVivo(oct2, 7753).ok === false);
  chequear('largo: spot sobre la EMA no entra', RA.validarPrecioVivo({ lado: 'LARGO', ema10: 7680, stop: 7669 }, 7681).ok === false);
  chequear('largo: spot bajo el stop no entra', RA.validarPrecioVivo({ lado: 'LARGO', ema10: 7680, stop: 7669 }, 7668).ok === false);
  chequear('largo: spot entre el stop y la EMA entra', RA.validarPrecioVivo({ lado: 'LARGO', ema10: 7680, stop: 7669 }, 7675).ok === true);
  chequear('sin spot no se entra a ciegas', RA.validarPrecioVivo(oct2, null).ok === false && RA.validarPrecioVivo(oct2, NaN).ok === false);
  chequear('la entrada real del backtest (largo 7678 vs EMA ~7690) sigue entrando con su propio cierre como spot',
    e.entra && RA.validarPrecioVivo(e, e.entrada).ok === true, JSON.stringify(e));
}

// El candado de una-vuelta-a-la-vez de la apertura. No se puede importar
// server.js sin arrancarlo, asi que se lee la fuente: si alguien quita el candado,
// vuelve el apilamiento del 2-oct-2026 (3 entradas en 1 minuto).
{
  const fuente = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  chequear('checkReversionApertura no corre si la vuelta anterior sigue viva',
    /async function checkReversionApertura\(\) \{\s*if \(aperturaEnCurso\) return;\s*aperturaEnCurso = true;\s*try \{ await checkReversionAperturaVuelta\(\); \} finally \{ aperturaEnCurso = false; \}/.test(fuente));
  const iVuelta = fuente.indexOf('async function checkReversionAperturaVuelta()');
  const iVivo = fuente.indexOf('reversionApertura.validarPrecioVivo(ent, ctx.spxPrice)');
  const iOrden = fuente.indexOf('[Tradier-REV-AP] ');
  chequear('y la apertura confirma el spot en vivo antes de mandar la orden',
    iVuelta > 0 && iVivo > iVuelta && iOrden > iVivo, `vuelta ${iVuelta} vivo ${iVivo} orden ${iOrden}`);
}

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

// Las mariposas (2026-09-15). POR QUE EXISTE: ese dia habia cuatro mariposas de
// puts abiertas en TastyTrade (PFE, PG, SPX, SPY) y las cuatro salian "figura no
// reconocida (3 patas)", sin link. OptionStrat no tiene slug de mariposa que
// funcione por URL: `put-butterfly` da "Error 404 Strategy type not found" y
// `long-put-butterfly` redirige a `/build/custom/` — y ahi SI dibuja la figura
// bien (SPY 752/755/758: debito $30, perdida max $30, ganancia max $270,
// breakevens 752.30-757.70). Comprobado en vivo el 2026-09-15. Por eso se dibuja
// por `custom` y el NOMBRE se pone aqui.
const FLY_SPY = [
  opc('SPY', '2026-09-18', '.SPY260918P752', 'Long',  1, 3.83),
  opc('SPY', '2026-09-18', '.SPY260918P755', 'Short', 2, 4.95),
  opc('SPY', '2026-09-18', '.SPY260918P758', 'Long',  1, 6.36),
];
const flySpy = agruparPosiciones(FLY_SPY);
chequear('la mariposa de puts ya tiene link (antes: figura no reconocida)', !!flySpy[0]?.url, `motivo ${flySpy[0]?.motivoSinUrl}`);
chequear('y se llama Long Put Butterfly', flySpy[0]?.figura === 'Long Put Butterfly', `dio ${flySpy[0]?.figura}`);
chequear('se dibuja por custom, la ruta que OptionStrat acepta, con el precio de cada pata',
  flySpy[0]?.url === 'https://optionstrat.com/build/custom/SPY/.SPY260918P752@3.83,-.SPY260918P755@4.95,-.SPY260918P755@4.95,.SPY260918P758@6.36',
  `dio ${flySpy[0]?.url}`);
chequear('la mariposa de calls tambien se reconoce',
  figuras([opc('X', '2026-09-18', '.X260918C10', 'Long'),
           opc('X', '2026-09-18', '.X260918C11', 'Short', 2),
           opc('X', '2026-09-18', '.X260918C12', 'Long')])[0] === 'Long Call Butterfly');
// Lo que NO es mariposa no se bautiza: una figura inventada es peor que ninguna.
// Desde el mismo dia esas figuras llevan link por custom, pero con el nombre
// neutro "Personalizada", nunca "Butterfly".
chequear('alas desiguales no se llaman mariposa',
  figuras([opc('X', '2026-09-18', '.X260918P10', 'Long'),
           opc('X', '2026-09-18', '.X260918P11', 'Short', 2),
           opc('X', '2026-09-18', '.X260918P13', 'Long')])[0] === 'Personalizada (3 patas)');
chequear('1 / -1 / 1 no es mariposa (la corta tiene que ser el doble)',
  figuras([opc('X', '2026-09-18', '.X260918P10', 'Long'),
           opc('X', '2026-09-18', '.X260918P11', 'Short'),
           opc('X', '2026-09-18', '.X260918P12', 'Long')])[0] === 'Personalizada (3 patas)');

// Tradier (2026-09-15). POR QUE EXISTE: la vista de Tradier guardaba el link a
// mano en el localStorage del navegador, uno por ticker, y ninguno de los 11
// trades abiertos del sandbox tenia link. Ahora sale de las posiciones reales
// con el mismo agrupado que TastyTrade. El precio es el del FILL (cost_basis):
// es lo que de verdad se cobro o pago en esa cuenta.
const { posicionesTradierAOptionStrat } = require('../src/optionstrat');
const hoodTr = agruparPosiciones(posicionesTradierAOptionStrat([
  { symbol: 'HOOD260918C00110000', quantity: -1, cost_basis: -345 },
  { symbol: 'HOOD260918C00112000', quantity: 1,  cost_basis: 258 },
]));
chequear('Tradier: el bear call de HOOD sale con link y el precio del fill',
  hoodTr[0]?.url === 'https://optionstrat.com/build/bear-call-spread/HOOD/-.HOOD260918C110@3.45,.HOOD260918C112@2.58',
  `dio ${hoodTr[0]?.url}`);
const spxTr = agruparPosiciones(posicionesTradierAOptionStrat([
  { symbol: 'SPXW260918P07485000', quantity: 2,  cost_basis: 4180 },
  { symbol: 'SPXW260918P07500000', quantity: -4, cost_basis: -9480 },
  { symbol: 'SPXW260918P07515000', quantity: 2,  cost_basis: 5440 },
]));
chequear('Tradier: la mariposa SPXW va bajo SPX con patas .SPXW, como en TastyTrade',
  spxTr[0]?.url === 'https://optionstrat.com/build/custom/SPX/.SPXW260918P7485@20.9,.SPXW260918P7485@20.9,-.SPXW260918P7500@23.7,-.SPXW260918P7500@23.7,-.SPXW260918P7500@23.7,-.SPXW260918P7500@23.7,.SPXW260918P7515@27.2,.SPXW260918P7515@27.2',
  `dio ${spxTr[0]?.url}`);
// Una figura que no reconocemos (dos verticales de puts del mismo dia, como la
// posicion 0DTE del robot SPX el 2026-09-15) igual lleva link: por custom, con sus
// patas exactas, y SIN nombre inventado.
const rara = agruparPosiciones([
  opc('SPX', '2026-09-15', '.SPXW260915P7570', 'Short', 1, 6.3),
  opc('SPX', '2026-09-15', '.SPXW260915P7580', 'Long',  1, 11.7),
  opc('SPX', '2026-09-15', '.SPXW260915P7600', 'Short', 1, 25.3),
  opc('SPX', '2026-09-15', '.SPXW260915P7610', 'Long',  1, 34),
]);
chequear('una figura desconocida tiene link por custom con sus patas exactas',
  rara[0]?.url === 'https://optionstrat.com/build/custom/SPX/-.SPXW260915P7570@6.3,.SPXW260915P7580@11.7,-.SPXW260915P7600@25.3,.SPXW260915P7610@34',
  `dio ${rara[0]?.url}`);
chequear('y se llama Personalizada, no una figura inventada',
  rara[0]?.figura === 'Personalizada (4 patas)', `dio ${rara[0]?.figura}`);
chequear('Tradier: una accion suelta no rompe el agrupado',
  agruparPosiciones(posicionesTradierAOptionStrat([{ symbol: 'JBLU', quantity: 100, cost_basis: 500 }])).length === 0);

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
seccion('La rejilla absoluta por strike (src/spx.js)');

const { gexAbsPorStrike, dominanciaRejilla } = require('../src/spx');

// El caso que motivo la funcion: un strike con las DOS patas cargadas. Neteado
// desaparece; en absoluto es el mayor de la rejilla. Cifras del 0DTE del
// 8-sep-2026, redondeadas (spot 7690.92): 7700 llevaba 3,74B de calls y 5,88B
// de puts. gexPorStrike lo daba en -2,14B, uno mas del monton.
const rejPrueba = [
  { strike: 7675, call: { gamma: 0.004, oi: 200 }, put: { gamma: 0.004, oi: 200 } },
  { strike: 7700, call: { gamma: 0.010, oi: 500 }, put: { gamma: 0.010, oi: 800 } },
  { strike: 7695, call: { gamma: 0.006, oi: 400 }, put: { gamma: 0.002, oi: 300 } },
];
const abs = gexAbsPorStrike(rejPrueba, 7690.92);
chequear('devuelve un strike por fila, ordenado de menor a mayor',
         abs.length === 3 && abs[0].strike === 7675 && abs[2].strike === 7700,
         `dio ${abs.map(x => x.strike).join(',')}`);
chequear('calls y puts van SEPARADOS, no neteados',
         abs[2].calls > 0 && abs[2].puts > 0 && abs[2].puts > abs[2].calls);
chequear('total es la suma de los dos lados',
         Math.abs(abs[2].total - (abs[2].calls + abs[2].puts)) < 1);
// La razon de ser: un strike simetrico netea cero pero NO desaparece.
const simetrico = gexAbsPorStrike(
  [{ strike: 7700, call: { gamma: 0.01, oi: 500 }, put: { gamma: 0.01, oi: 500 } }], 7700);
chequear('un strike que netea CERO sigue estando, con su gamma bruta',
         simetrico.length === 1 && simetrico[0].total > 0,
         `dio ${JSON.stringify(simetrico)}`);
// Strikes sin gamma ni OI no ensucian la rejilla.
chequear('los strikes vacios se descartan',
         gexAbsPorStrike([{ strike: 5000, call: { gamma: 0, oi: 0 }, put: { gamma: 0, oi: 0 } }], 7700).length === 0);

const dom = dominanciaRejilla(abs);
chequear('la dominancia senala el strike mayor', dom.strike === 7700, `dio ${dom && dom.strike}`);
chequear('dominancia = mayor / segundo', Math.abs(dom.dominancia - abs[2].total / abs[1].total) < 0.01);
chequear('la concentracion es una fraccion del total', dom.concentracion > 0 && dom.concentracion < 1);
// La distincion que evita leer un racimo como un pico: el segundo mayor esta a
// 5 puntos (7695), asi que la relacion "de zona" tiene que mirar mas lejos.
// El segundo mayor (7695) esta pegado al dominante: eso es un racimo, no un
// pico. La relacion "de zona" tiene que saltarselo y medir contra 7675.
chequear('dominanciaZona ignora al vecino contiguo y mira a >10 pts',
         dom.segundo === 7695 && dom.segundoLejano === 7675,
         `segundo ${dom.segundo}, lejano ${dom.segundoLejano}`);
chequear('...y la relacion de zona sale mayor que la del vecino',
         dom.dominanciaZona > dom.dominancia,
         `zona ${dom.dominanciaZona}, vecino ${dom.dominancia}`);
chequear('con menos de dos strikes no inventa dominancia',
         dominanciaRejilla([{ strike: 7700, calls: 1, puts: 1, total: 2 }]) === null);
chequear('con la rejilla vacia devuelve null', dominanciaRejilla([]) === null);

// Muros propios con la regla de Sigma (2026-11-05). El caso que la destapo: el
// 19-ago, spot 7717, habia 12B de puts en 7720 y 2B en 7700, y Sigma marcaba el
// put wall en 7700 — el mayor POR DEBAJO del spot, no el mayor a secas.
seccion('Muros propios, regla de Sigma (src/spx.js murosReglaSigma)');
const { murosReglaSigma } = require('../src/spx');
const cad19ago = [
  { strike: 7700, call: { gamma: 0.010, oi: 300,  delta: 0.6 }, put: { gamma: 0.010, oi: 200,  delta: -0.4 } },
  { strike: 7720, call: { gamma: 0.010, oi: 400,  delta: 0.5 }, put: { gamma: 0.010, oi: 1200, delta: -0.5 } },
  { strike: 7750, call: { gamma: 0.008, oi: 900,  delta: 0.3 }, put: { gamma: 0.004, oi: 100,  delta: -0.7 } },
];
const m19 = murosReglaSigma(cad19ago, 7717, '2026-08-19');
chequear('el put wall es el mayor de puts POR DEBAJO del spot (7700), no el mayor a secas (7720)',
         m19 && m19.putWall === 7700, `dio ${m19 && m19.putWall}`);
chequear('el call wall es el mayor de calls POR ENCIMA del spot',
         m19 && m19.callWall === 7750, `dio ${m19 && m19.callWall}`);
chequear('el MVS es el de mas gamma absoluta, sin importar el lado (7720)',
         m19 && m19.mvs === 7720, `dio ${m19 && m19.mvs}`);
chequear('el regimen sale del signo del GEX neto (aqui puts > calls: NEGATIVO)',
         m19 && m19.regime === 'NEGATIVO' && m19.netGex < 0);
chequear('sin spot no inventa muros', murosReglaSigma(cad19ago, 0) === null);
chequear('con la cadena vacia devuelve null', murosReglaSigma([], 7700) === null);

// El PIN por strike dominante (2026-09-10), en MODO SOMBRA. No opera, pero lo que
// apunta es la muestra con la que se va a decidir si algun dia opera: si la regla
// o el P&L salen mal aqui, la muestra entera nace torcida. Casos con las cifras
// reales del 9 y el 10-sep-2026 (estudio: 07_pinning/README.md §6).
seccion('El PIN por strike dominante, sombra (src/pin_dominante.js)');

const pinD = require('../src/pin_dominante');
const pata = (mark, bid, ask) => ({ mark, bid, ask });
const cadenaFly = [
  { strike: 7585, call: pata(20, 19.8, 20.2), put: pata(3.10, 3.0, 3.2) },
  { strike: 7600, call: pata(10, 9.9, 10.1),  put: pata(8.00, 7.9, 8.1) },
  { strike: 7615, call: pata(3.20, 3.1, 3.3), put: pata(21, 20.8, 21.2) },
];
const fp = pinD.precioMariposa(cadenaFly, 7600, 15);
chequear('mariposa: mid = cortas del centro menos alas', fp && fp.mid === 11.7, `dio ${fp && fp.mid}`);
chequear('mariposa: se cobra MENOS que el mid al abrir cruzando',
         fp.aperturaNatural === 11.3 && fp.aperturaNatural < fp.mid, `dio ${fp.aperturaNatural}`);   // 9,9+7,9-3,3-3,2
chequear('mariposa: se paga MAS que el mid al cerrar cruzando',
         fp.cierreNatural === 12.1 && fp.cierreNatural > fp.mid, `dio ${fp.cierreNatural}`);        // 10,1+8,1-3,1-3,0
chequear('mariposa: sin un ala no se inventa precio', pinD.precioMariposa(cadenaFly, 7600, 20) === null);
const sinPuntas = cadenaFly.map((s) => ({ strike: s.strike, call: { mark: s.call.mark }, put: { mark: s.put.mark } }));
chequear('mariposa: sin bid/ask sale el mid y el natural queda null',
         pinD.precioMariposa(sinPuntas, 7600, 15).mid === 11.7 && pinD.precioMariposa(sinPuntas, 7600, 15).cierreNatural === null);

// 10-sep 10:20 ET: el caso que origino la regla. Tiene que entrar. Desde v0.1 el
// ala principal es 20: credito de la toma real de las 10:40, 14,75 (74% del ala).
chequear('PIN: el ala principal es 20 y se siguen 10, 15 y 20',
         pinD.REGLA.ala === 20 && pinD.REGLA.alasSeguimiento.join() === '10,15,20');
const dom10 = { strike: 7600, dominancia: 1.82, dominanciaZona: 2.65 };
let evp = pinD.evaluarEntrada({ dom: dom10, minEstable: 42, spot: 7596.59, minET: 10 * 60 + 20, fly: { mid: 14.75 } });
chequear('PIN: el 10-sep a las 10:20 entra', evp.ok, evp.motivo);
// El filtro de credito mira el ala PRINCIPAL: el credito del ala 15 (11,81) es
// solo el 59% de 20 y no puede colarse como si fuera el de 20.
evp = pinD.evaluarEntrada({ dom: dom10, minEstable: 42, spot: 7596.59, minET: 10 * 60 + 20, fly: { mid: 11.81 } });
chequear('PIN: un credito de ala 15 no pasa el filtro del ala 20', !evp.ok && !evp.checks.credito, evp.motivo);
// 9-sep manana: el dominante no dominaba (1,04x).
evp = pinD.evaluarEntrada({ dom: { strike: 7650, dominancia: 1.04, dominanciaZona: 1.04 }, minEstable: 60,
                            spot: 7649.7, minET: 10 * 60 + 34, fly: { mid: 13.35 } });
chequear('PIN: el 9-sep por la manana NO entra (sin dominancia)', !evp.ok && !evp.checks.dominancia, evp.motivo);
// 9-sep 15:18: dominaba 1,80x pero la mariposa ya era gamma de ultima hora (ala 20: 6,68 = 33%).
evp = pinD.evaluarEntrada({ dom: { strike: 7650, dominancia: 1.8, dominanciaZona: 2.71 }, minEstable: 32,
                            spot: 7646.18, minET: 15 * 60 + 18, fly: { mid: 6.68 } });
chequear('PIN: el 9-sep a las 15:18 NO entra (tarde y credito del 33%)',
         !evp.ok && !evp.checks.ventana && !evp.checks.credito, evp.motivo);
evp = pinD.evaluarEntrada({ dom: dom10, minEstable: 42, spot: 7606.2, minET: 10 * 60 + 40, fly: { mid: 14.75 } });
chequear('PIN: a 6 pts del dominante NO entra (credito con intrinseco)', !evp.ok && !evp.checks.cerca, evp.motivo);
evp = pinD.evaluarEntrada({ dom: dom10, minEstable: 20, spot: 7600, minET: 10 * 60 + 20, fly: { mid: 14.75 } });
chequear('PIN: con el dominante recien cambiado NO entra', !evp.ok && !evp.checks.estable, evp.motivo);
chequear('PIN: sin rejilla no entra ni revienta', pinD.evaluarEntrada({ dom: null, spot: 7600, minET: 620 }).ok === false);

// Salidas, en dolares por contrato (gotcha 3: el credito va por accion).
const tp = { creditoMid: 11.81, ...pinD.nivelesDeSalida(11.81) };
chequear('PIN: el objetivo es el 10% del credito en dolares', tp.objetivoUSD === 118.1, `dio ${tp.objetivoUSD}`);
let sal = pinD.evaluarSalida(tp, { flyMid: 10.6, minET: 12 * 60 });
chequear('PIN: recomprar a 10,60 toca el objetivo', sal.salir && sal.motivo === 'OBJETIVO' && sal.pnlMid === 121, `dio ${sal.motivo} ${sal.pnlMid}`);
sal = pinD.evaluarSalida(tp, { flyMid: 13.4, minET: 12 * 60 });
chequear('PIN: recomprar a 13,40 salta el stop de $150', sal.salir && sal.motivo === 'STOP', `dio ${sal.motivo} ${sal.pnlMid}`);
sal = pinD.evaluarSalida(tp, { flyMid: 11.5, minET: 15 * 60 });
chequear('PIN: a las 15:00 sale por tiempo', sal.salir && sal.motivo === 'TIEMPO');
sal = pinD.evaluarSalida(tp, { flyMid: 11.5, minET: 12 * 60 });
chequear('PIN: entre medias sigue abierta', !sal.salir && sal.pnlMid === 31, `dio ${sal.pnlMid}`);
chequear('PIN: sin precio de la mariposa no se cierra a ciegas', !pinD.evaluarSalida(tp, { flyMid: null, minET: 15 * 60 }).salir);
chequear('PIN: al vencimiento se paga la distancia al centro',
         Math.abs(pinD.valorAlVencimiento(7636.36, 7650, 15) - 13.64) < 1e-9);
chequear('PIN: ...y nunca mas que el ala', pinD.valorAlVencimiento(7600, 7650, 15) === 15);

// Alas en ATR (2026-09-19). Un ala de 20 puntos valia 0,50 ATR en agosto y 0,31 el
// 17-sep sin que nadie tocara nada: el ATR existe para que la apuesta sea la misma
// en los dos regimenes. Lo que se prueba es que el ATR no se invente con dos dias
// y que el ala caiga siempre en la rejilla de strikes.
const sesATR = [
  { alto: 7700, bajo: 7650, cierre: 7680 },   // sin cierre anterior: su rango no cuenta
  { alto: 7710, bajo: 7660, cierre: 7700 },   // TR = 50
  { alto: 7730, bajo: 7690, cierre: 7720 },   // TR = 40
  { alto: 7740, bajo: 7700, cierre: 7710 },   // TR = 40
  { alto: 7760, bajo: 7730, cierre: 7750 },   // TR = 50
  { alto: 7770, bajo: 7740, cierre: 7760 },   // TR = 30
];
chequear('ATR: promedia los rangos verdaderos y descarta el primer dia',
         pinD.calcularATR(sesATR) === 42, `dio ${pinD.calcularATR(sesATR)}`);
chequear('ATR: con menos de 5 rangos devuelve null, no un ATR de dos dias',
         pinD.calcularATR(sesATR.slice(0, 4)) === null);
chequear('ATR: sin sesiones no revienta', pinD.calcularATR([]) === null && pinD.calcularATR(null) === null);
// El hueco manda cuando es mayor que el rango del dia: cierre 7500 y al dia
// siguiente 7600/7580 -> TR = |7600-7500| = 100, no los 20 del rango.
chequear('ATR: el hueco contra el cierre anterior manda sobre el rango del dia',
         pinD.calcularATR([{ alto: 7510, bajo: 7490, cierre: 7500 },
                           { alto: 7600, bajo: 7580, cierre: 7590 }], 14, 1) === 100);
chequear('ATR: el ala de 0,5x con ATR 50 son 25 puntos', pinD.alaDesdeATR(50, 0.5) === 25);
chequear('ATR: el ala se redondea a la rejilla de 5', pinD.alaDesdeATR(47, 0.25) === 10,
         `dio ${pinD.alaDesdeATR(47, 0.25)}`);   // 11,75 -> 10
chequear('ATR: sin ATR no hay ala dinamica', pinD.alaDesdeATR(null, 0.5) === null && pinD.alaDesdeATR(0, 0.5) === null);
chequear('ATR: un ala que se redondea a 0 no se publica', pinD.alaDesdeATR(4, 0.25) === null);
chequear('PIN: las alas en ATR se siguen ADEMAS de las fijas',
         pinD.REGLA.alasATR.join() === '0.25,0.5' && pinD.REGLA.alasSeguimiento.length === 3);

seccion('Iron Butterfly ATM de mediodia, sombra (src/ib_atm_sombra.js)');

// Estudio del 25-sep (07_pinning, scripts 15-19). Lo que se prueba: que la entrada
// no se abra fuera de su hora, que el objetivo al NATURAL sea mas dificil que en el
// mid (es justo lo que se quiere medir), y que las unidades no se crucen (gotcha 3).
const ibA = require('../src/ib_atm_sombra');
chequear('IB-ATM: entradas a las 12:00, 12:30, 13:00 y 13:30',
         ibA.REGLA.entradasET.join() === '720,750,780,810' && ibA.REGLA.alas.join() === '10,15,20');
chequear('IB-ATM: el centro es el strike de 5 mas cercano', ibA.centroATM(7597.4) === 7595 && ibA.centroATM(7597.6) === 7600);
chequear('IB-ATM: la entrada de las 12:30 se abre a las 12:31', ibA.tocaAbrir(750, 751, []));
chequear('IB-ATM: ...no dos veces', !ibA.tocaAbrir(750, 752, [750]));
chequear('IB-ATM: ...ni antes de su hora', !ibA.tocaAbrir(750, 749, []));
chequear('IB-ATM: ...ni tarde: con el servidor caido se pierde, no se falsea', !ibA.tocaAbrir(750, 766, []));

// Cadena de juguete: la de las pruebas del PIN (ala 15, mid 11,70, cierre natural 12,10).
const mA = ibA.abrirMariposa(pinD.precioMariposa(cadenaFly, 7600, 15));
chequear('IB-ATM: abre con el credito mid y el riesgo en dolares',
         mA.creditoMid === 11.7 && mA.riesgoMaxUSD === 330 && mA.creditoNatural === 11.3, JSON.stringify(mA));
chequear('IB-ATM: sin precio no abre', ibA.abrirMariposa(null) === null);
// A las 14:00 la mariposa vale 9,90 al mid y 10,30 al natural. El 15% de 11,70 son
// 1,755: el mid ya lo toca (11,70-9,90 = 1,80) pero recomprando al natural no (1,40).
ibA.actualizarMariposa(mA, { mid: 9.9, cierreNatural: 10.3 }, { minET: 840, at: 't1', spot: 7601 });
chequear('IB-ATM: el 15% se toca en el mid...', mA.toques['0.15'].mid?.minET === 840);
chequear('IB-ATM: ...pero NO al natural (la salida que no se da)', mA.toques['0.15'].natural === null);
chequear('IB-ATM: el 10% si se toca al natural', mA.toques['0.1'].natural?.cierreNatural === 10.3);
ibA.actualizarMariposa(mA, { mid: 9.0, cierreNatural: 9.4 }, { minET: 900, at: 't2', spot: 7600 });
chequear('IB-ATM: el primer toque no se pisa con uno posterior', mA.toques['0.15'].mid.minET === 840 && mA.toques['0.15'].natural.minET === 900);
chequear('IB-ATM: antes de las 15:30 no hay foto de las 15:30', mA.en1530 === null);
ibA.actualizarMariposa(mA, { mid: 6.0, cierreNatural: 6.5 }, { minET: 931, at: 't3', spot: 7604 });
ibA.actualizarMariposa(mA, { mid: 3.0, cierreNatural: 3.4 }, { minET: 957, at: 't4', spot: 7603 });
chequear('IB-ATM: la foto de las 15:30 es la primera lectura desde esa hora', mA.en1530.minET === 931 && mA.en1530.mid === 6);
const resA = ibA.resultados(mA, 7600);
chequear('IB-ATM: salir a las 15:30 al natural = (11,70 - 6,50) x 100', resA.a1530 === 520, `dio ${resA.a1530}`);
chequear('IB-ATM: al vencimiento paga la distancia al centro = (11,70 - 3) x 100', resA.vencimiento === 870, `dio ${resA.vencimiento}`);
chequear('IB-ATM: el objetivo del 10% cobra lo del natural = (11,70 - 10,30) x 100', resA.objetivo['0.1'] === 140, `dio ${resA.objetivo['0.1']}`);
// A ultima hora el ala lejana queda en bid 0: la mariposa se cierra igual (se vende
// el ala a 0). El precio del PIN exige bid > 0 y dejaba el natural en null.
const cadenaTarde = cadenaFly.map((s) => s.strike === 7600 ? s
  : { strike: s.strike, call: { ...s.call, bid: s.strike > 7600 ? 0 : s.call.bid }, put: { ...s.put, bid: s.strike < 7600 ? 0 : s.put.bid } });
chequear('IB-ATM: con el ala en bid 0 el cierre natural existe (el del PIN no)',
         ibA.precioMariposa(cadenaTarde, 7600, 15).cierreNatural === 18.2 && pinD.precioMariposa(cadenaTarde, 7600, 15).cierreNatural === null,
         `dio ${ibA.precioMariposa(cadenaTarde, 7600, 15).cierreNatural}`);   // 10,1 + 8,1 - 0 - 0
chequear('IB-ATM: sin lectura de las 15:55 no se inventa el vencimiento',
         ibA.resultados({ ...mA, ultimo: { ...mA.ultimo, minET: 940 } }, 7600).vencimiento === null);

seccion('MEDIODIA: IB de las 12:30 en el MVS (src/mediodia.js)');

// Regla del usuario (28-sep): centro = PROMEDIO del MVS de 12:00-12:30, alas 15,
// TP 20% o 15:30, sin stop. Lecturas en UTC como las guarda el historial de Sigma
// (EDT = UTC-4: 16:00Z son las 12:00 ET).
const md = require('../src/mediodia');
chequear('MEDIODIA: entra a las 12:30 con alas 15, TP 20% y cierre 15:30',
         md.REGLA.entradaET === 750 && md.REGLA.ala === 15 && md.REGLA.tpPct === 20 && md.REGLA.cierreForzadoET === '15:30');
const lect = (hhmm, mvs, campo = 'capturadoEn') => ({ [campo]: `2026-09-28T${hhmm}:00.000Z`, mvs });
// El 28-sep real: 39 lecturas en 7700 y una en 7675 dan 7699,4 -> 7700.
const dia28 = [...Array.from({ length: 39 }, (_, i) => lect(`16:${String(i % 30).padStart(2, '0')}`, 7700)), lect('16:06', 7675)];
const c28 = md.centroPorMvs(dia28, '2026-09-28');
chequear('MEDIODIA: el 28-sep el centro es 7700 (promedio 7699,4)', c28.centro === 7700 && c28.n === 40 && c28.promedio === 7699.38, JSON.stringify(c28));
// Es el PROMEDIO, no la moda: 3 en 7700 y 3 en 7725 dan 7712,5 -> 7715.
const mitad = [lect('16:01', 7700), lect('16:05', 7700), lect('16:09', 7700), lect('16:13', 7725), lect('16:17', 7725), lect('16:21', 7725)];
chequear('MEDIODIA: promedia, no toma la moda', md.centroPorMvs(mitad, '2026-09-28').centro === 7715);
chequear('MEDIODIA: la ventana es [12:00, 12:30): fuera no cuenta',
         md.centroPorMvs([...mitad, lect('15:59', 9000), lect('16:30', 9000)], '2026-09-28').centro === 7715);
chequear('MEDIODIA: otro dia no cuenta', md.centroPorMvs(mitad, '2026-09-29').centro === null);
chequear('MEDIODIA: con menos de 5 lecturas no abre', md.centroPorMvs(mitad.slice(0, 4), '2026-09-28').centro === null);
chequear('MEDIODIA: sin capturadoEn usa updatedAt', md.centroPorMvs(mitad.map((l) => ({ updatedAt: l.capturadoEn, mvs: l.mvs })), '2026-09-28').centro === 7715);
chequear('MEDIODIA: la ventana de entrada es 12:30-12:45', md.enVentana(750) && md.enVentana(765) && !md.enVentana(749) && !md.enVentana(766));
const sk = md.strikesMariposa(7700, '2026-09-29');
chequear('MEDIODIA: las dos cortas en el centro y las alas a 15',
         sk.shortStrike === 7700 && sk.callShortStrike === 7700 && sk.longStrike === 7685 && sk.callLongStrike === 7715);

seccion('IRONBALLS: las alertas de Pipe (src/ironballs.js)');

// Mensajes REALES del Canal Oficial de Iron Balls (WhatsApp), copiados tal cual.
const ibm = require('../src/ironballs');
const IB_BPS = '🔔 *Options Alert — Sigma Trade*\n\n📌 *SPX — Bull Put Spread*\n\n──────────\n🟢 Buy 1× Put 7640 (Oct 26, 2026) @ $6.57\n🔴 Sell 1× Put 7645 (Oct 26, 2026) @ $7.77\n\n💰 *Net Credit:* $120.00\n\n──────────\n💵 *Premium per contract:* $1.20 (credit)\n\n🏆 *Max profit:* $120.00\n\n📉 *Max loss (risk):* $380.00\n\n⚖️ *Breakeven:* $7658.70\n\n📊 *Probability of profit:* 96.47%\n\n⏳ *DTE:* 0\n\n──────────\n🔗 View on Sigma Trade:\nhttps://web.sigma.trade/share/5IG8v9E9VQ/\n\n🏷️ *Current price of SPX:* $7692.72';
const IB_ES = '🔔 *Options Alert — Sigma Trade*\n\n📌 *SPX — Bear Call Spread*\n\n──────────\n🟢 Compra 1× Call 7710 (Sep 14, 2026) @ $4.70\n🔴 Venta 1× Call 7700 (Sep 14, 2026) @ $6.15\n\n💰 *Net Credit:* $145.00\n\n──────────\n💵 *Premium per contract:* $1.45 (credit)\n\n⏳ *DTE:* 4';
const IB_IC = '🔔 *Options Alert — Sigma Trade*\n\n📌 *SPX — Iron Condor*\n\n──────────\n🟢 Compra 1× Put 7575 (Sep 10, 2026) @ $1.83\n🔴 Venta 1× Put 7585 (Sep 10, 2026) @ $3.02\n🔴 Venta 1× Call 7625 (Sep 10, 2026) @ $2.58\n🟢 Compra 1× Call 7635 (Sep 10, 2026) @ $1.12\n\n💰 *Net Credit:* $265.00\n\n⏳ *DTE:* 0';
const IB_CLOSED = '⚠️ CLOSED\n(Shared on Oct 26)\n\n✅ SPX October 26 7640/7645 Bull Put Spread @ 83.33%\n\nGain of $100 per position';
const a1 = ibm.parsearAlerta(IB_BPS);
chequear('IRONBALLS: Bull Put 7645/7640 del 26-oct — vende 7645, compra 7640, credito 1.20, 0DTE',
         a1.ok && a1.vertical.strategy === 'BULL_PUT_SPREAD' && a1.vertical.shortStrike === 7645 && a1.vertical.longStrike === 7640 &&
         a1.expiry === '2026-10-26' && a1.prima === 1.2 && a1.netoDolares === 120 && a1.isCredit === true && a1.dte === 0, JSON.stringify(a1));
const a2 = ibm.parsearAlerta(IB_ES);
chequear('IRONBALLS: la alerta en espanol (Compra/Venta) se lee igual — Bear Call vende 7700',
         a2.ok && a2.vertical.strategy === 'BEAR_CALL_SPREAD' && a2.vertical.shortStrike === 7700 && a2.vertical.longStrike === 7710 && a2.expiry === '2026-09-14');
const a3 = ibm.parsearAlerta(IB_IC);
chequear('IRONBALLS: el Iron Condor NO se opera en la v1 (no es vertical)', a3 && !a3.ok && a3.estructura === 'IRON_CONDOR' && /4 verticales/.test(a3.motivo));
const c1 = ibm.parsearCierre(IB_CLOSED, '2026-10-26T14:58:41Z');
chequear('IRONBALLS: el CLOSED trae vencimiento (con el año del mensaje), strikes, % y ganancia',
         c1.ok && c1.expiry === '2026-10-26' && c1.pct === 83.33 && c1.resultadoDolares === 100 && c1.gano === true, JSON.stringify(c1));
chequear('IRONBALLS: la apertura y su CLOSED tienen la MISMA clave (asi se emparejan)', a1.clave === c1.clave && a1.clave === 'BULL_PUT_SPREAD|2026-10-26|7640/7645');
{ // CLOSED real del 2-nov-2026: "Closed at 0.96 debit" + "Profit of $124 per position"
  const c2 = ibm.parsearCierre('⚠️ CLOSED\n(Shared on Nov 2)\n\n✅ SPX November 2 7635/7645 Bear Call Spread @ 56.36%\nClosed at 0.96 debit\n\nProfit of $124 per position', '2026-11-02T17:40:00Z');
  chequear('IRONBALLS: el CLOSED con "Profit of" (2-nov) trae la ganancia', c2.ok && c2.resultadoDolares === 124 && c2.gano === true && c2.clave === 'BEAR_CALL_SPREAD|2026-11-02|7635/7645', JSON.stringify(c2));
}
chequear('IRONBALLS: una perdida sale negativa',ibm.parsearCierre(IB_CLOSED.replace('✅', '❌').replace('Gain of $100', 'Loss of $380'), '2026-10-26T15:00:00Z').resultadoDolares === -380);
chequear('IRONBALLS: un CLOSED de diciembre que nombra enero es del año siguiente',
         ibm.parsearCierre(IB_CLOSED.replace('October 26', 'January 4'), '2026-12-31T15:00:00Z').expiry === '2027-01-04');
chequear('IRONBALLS: mapas, capsulas y enlaces de Zoom no son nada', ibm.parsearMensaje('MAPA INSTITUCIONAL IRON BALLS LUNES 26 DE OCTUBRE, 2026.') === null &&
         ibm.parsearMensaje('Join Zoom Meeting https://us06web.zoom.us/j/868') === null);
chequear('IRONBALLS: si el titulo contradice las patas, no se opera',
         ibm.parsearAlerta(IB_BPS.replace('Bull Put Spread', 'Bear Put Spread')).ok === false);

seccion('IRONBALLS: las entradas de Alejandro (src/ironballs_ale.js, foto OptionStrat)');
{
  const iba = require('../src/ironballs_ale');
  // Lecturas como las devolvio Claude sobre las fotos reales del 10-nov-2026 (13:11 y 13:32 NY)
  const L1 = { es_optionstrat: true, etiquetas: [{ strike: 7495, tipo: 'C', posicion: 'arriba' }, { strike: 7490, tipo: 'C', posicion: 'abajo' }],
               dia_resaltado: 10, mes_resaltado: 'Nov', net_credit: 195, net_debit: null, max_loss: 305, max_profit: 195, chance_of_profit: 63, breakeven: 'Below 7,491.95' };
  const L2 = { ...L1, etiquetas: [{ strike: 7485, tipo: 'P', posicion: 'arriba' }, { strike: 7490, tipo: 'P', posicion: 'abajo' }], net_credit: 205 };
  const f1 = iba.armarDesdeFoto(L1, '2026-11-10');
  chequear('IRONBALLS ALE: 7495C arriba / 7490C abajo = Bear Call que VENDE 7490 y compra 7495, crédito 1.95, vence hoy',
           f1.ok && f1.vertical.strategy === 'BEAR_CALL_SPREAD' && f1.vertical.shortStrike === 7490 && f1.vertical.longStrike === 7495 &&
           f1.expiry === '2026-11-10' && f1.prima === 1.95 && f1.dte === 0 && f1.vertical.direction === 'BEARISH', JSON.stringify(f1));
  const f2 = iba.armarDesdeFoto(L2, '2026-11-10');
  chequear('IRONBALLS ALE: 7485P arriba / 7490P abajo = Bull Put que VENDE 7490 y compra 7485',
           f2.ok && f2.vertical.strategy === 'BULL_PUT_SPREAD' && f2.vertical.shortStrike === 7490 && f2.vertical.longStrike === 7485 && f2.prima === 2.05, JSON.stringify(f2));
  chequear('IRONBALLS ALE: la clave lleva el prefijo ALE| (no se cruza con las de Pipe)', f1.clave === 'ALE|BEAR_CALL_SPREAD|2026-11-10|7490/7495');
  chequear('IRONBALLS ALE: un gráfico de velas no es tarjeta', iba.armarDesdeFoto({ es_optionstrat: false, etiquetas: [] }, '2026-11-10').noEsTarjeta === true);
  chequear('IRONBALLS ALE: si dice NET DEBIT pero las patas arman un crédito, no se opera',
           iba.armarDesdeFoto({ ...L1, net_credit: null, net_debit: 195 }, '2026-11-10').ok === false);
  chequear('IRONBALLS ALE: 3 etiquetas (mariposa) no se opera en la v1',
           iba.armarDesdeFoto({ ...L1, etiquetas: [...L1.etiquetas, { strike: 7500, tipo: 'C', posicion: 'arriba' }] }, '2026-11-10').ok === false);
  chequear('IRONBALLS ALE: un día resaltado de ayer no se opera', iba.armarDesdeFoto({ ...L1, dia_resaltado: 9 }, '2026-11-10').ok === false);
  { const f3 = iba.armarDesdeFoto({ es_optionstrat: true, etiquetas: [{ strike: 7350, tipo: 'C', posicion: 'arriba' }, { strike: 7345, tipo: 'C', posicion: 'abajo' }], dia_resaltado: null, mes_resaltado: null, net_credit: 240, net_debit: null, max_loss: 260, max_profit: 240, chance_of_profit: 56, breakeven: 'Below 7,347.40' }, '2026-11-17');
    chequear('IRONBALLS ALE: captura recortada sin fecha (17-nov) -> 0DTE asumido, Bear Call 7345/7350 a 2.40', f3.ok === true && f3.vencimientoAsumido === true && f3.expiry === '2026-11-17' && f3.dte === 0 && f3.estructura === 'BEAR_CALL_SPREAD' && f3.prima === 2.4); }
  // Textos REALES de Alejandro en el grupo Operaciones
  const t1 = iba.parsearTextoAle('_Fuera +40 x contrato_');
  chequear('IRONBALLS ALE: "Fuera +40 x contrato" es salida de +$40', t1?.salida?.usd === 40 && t1.salida.runners === false, JSON.stringify(t1));
  chequear('IRONBALLS ALE: "Fuera runners +90" es salida de runners', iba.parsearTextoAle('_Fuera runners +90 x contrato_')?.salida?.runners === true);
  const t3 = iba.parsearTextoAle('_*Evalue entrada bajista, sino esta segur@ no entre, controle su riesgo*_\n_Cambie sus strikes como les mencionamos siempre acorde a su operativa; su profit y stoploss lo define usted mismo, debe saberlo gestionar acorde a su cuenta_\n*Nivel de control alrededor del 7486.37 ( No debe traspasar al alza )*');
  chequear('IRONBALLS ALE: "Evalúe entrada bajista… Nivel de control 7486.37" da el nivel y la dirección (y NO es salida)',
           t3?.control?.nivel === 7486.37 && t3.control.direccion === 'BEARISH' && !t3.salida, JSON.stringify(t3));
  chequear('IRONBALLS ALE: "DEntro con 2.05" da el crédito', iba.parsearTextoAle('_DEntro con 2.05_')?.dentro?.credito === 2.05);
  const t5 = iba.parsearTextoAle('_Credito 2.50. Fuera +40 x contrato_');
  chequear('IRONBALLS ALE: "Credito 2.50. Fuera +40" trae crédito y salida', t5?.dentro?.credito === 2.5 && t5?.salida?.usd === 40, JSON.stringify(t5));
  chequear('IRONBALLS ALE: la charla no es nada', iba.parsearTextoAle('Flia como estan todos?') === null &&
           iba.parsearTextoAle('fuera de horario no opero') === null && iba.parsearTextoAle('_Rondando +60 x contrato_') === null);
}

seccion('IRONBALLS: demo propia en TastyTrade (src/ironballs_demo.js, TastyTrade falso)');
{
  let d = {};
  try {
    const out = require('child_process').execFileSync(process.execPath, [require('path').join(__dirname, 'prueba_ironballs_demo.js')], { encoding: 'utf8', timeout: 30000 });
    d = JSON.parse(out.trim().split('\n').pop());
  } catch (e) { d = { error: e.message }; }
  chequear('IRONBALLS demo: NUNCA llama a /orders sin dry-run (no puede mandar una orden real)', d.soloDryRun === true, JSON.stringify(d));
  chequear('IRONBALLS demo: abre al medio - 0.05 en un crédito (2.15) con riesgo de $785', d.abrio && d.precioEntrada === 2.15 && d.riesgo === 785, JSON.stringify(d));
  chequear('IRONBALLS demo: no abre dos veces los mismos strikes', d.duplicada === 'DUPLICADA');
  chequear('IRONBALLS demo: el CLOSED la cierra al medio + 0.05 (1.05), neto de comisiones del dry-run', d.cerro && d.precioSalida === 1.05 && d.pnlBruto === 110 && d.pnlNeto === 106.56, JSON.stringify(d));
  chequear('IRONBALLS demo: un segundo CLOSED no encuentra nada', d.segundoCierre === 'SIN_DEMO');
  chequear('IRONBALLS demo: el saldo arranca en $2.000 y suma el neto', d.saldo === 2106.56, JSON.stringify(d));
  chequear('IRONBALLS demo: ntfy al abrir y al cerrar (2 avisos)', d.avisos === 2, JSON.stringify(d));
}
const fuente = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
chequear('IRONBALLS: el servidor cierra la demo con el CLOSED y la abre antes del kill-switch de Tradier',
         /ironBallsDemo\.cerrar\(\{ clave: p\.clave/.test(fuente) && fuente.indexOf('ironBallsDemo.abrir(') < fuente.indexOf("cfg.tradierAutoExecute === false) {"));

seccion('IRONBALLS: salidas de la demo de Alejandro (TP 50%, stop -$150, "Fuera" solo en positivo)');
{
  let d = {};
  try {
    const out = require('child_process').execFileSync(process.execPath, [require('path').join(__dirname, 'prueba_ironballs_ale_demo.js')], { encoding: 'utf8', timeout: 30000 });
    d = JSON.parse(out.trim().split('\n').pop());
  } catch (e) { d = { error: e.message }; }
  chequear('IRONBALLS ALE: con +$55 (menos del 50% de $205) sigue abierta', d.entrada === 2.05 && d.sigueAbierta === true, JSON.stringify(d));
  chequear('IRONBALLS ALE: al llegar al 50% del crédito cierra por TP aunque Alejandro no diga nada', d.motivoTP === 'TP_50PCT' && d.estadoTP === 'cerrada', JSON.stringify(d));
  chequear('IRONBALLS ALE: con -$155 cierra por stop de $150', d.motivoStop === 'STOP_150', JSON.stringify(d));
  chequear('IRONBALLS: spread de 10 pts → stop proporcional de $300 (con -$165 sigue, con -$305 cierra)',
           d.stop10 === 300 && d.sigue10con165 === true && d.motivoStop10 === 'STOP_300', JSON.stringify(d));
  chequear('IRONBALLS ALE: "Fuera" de Alejandro con nosotros en negativo NO cierra (sigue a TP/stop/15:30)', d.fueraNegativo === 'SIGUE_ABIERTA' && d.siguioAbierta === true, JSON.stringify(d));
  chequear('IRONBALLS ALE: "Fuera" con nosotros en positivo cierra, sin importar el valor', d.fueraPositivo === 'DEMO_CERRADA' && d.netoFuera > 0, JSON.stringify(d));
  chequear('IRONBALLS ALE: el servidor pasa soloSiGana en el "Fuera" y TP 0.5 a la demo de Alejandro',
           /ironBallsAleDemo\.cerrar\(\{ ultima: true, soloSiGana: true/.test(fuente) && /IRONBALLS_ALE_TP_PCT\) \|\| 0\.5/.test(fuente));
  chequear('IRONBALLS PIPE: mismas reglas — TP 50%, stop $150 y el CLOSED solo cierra en positivo',
           /ironBallsDemo\.cerrar\(\{ clave: p\.clave, soloSiGana: true/.test(fuente) && /IRONBALLS_PIPE_TP_PCT\) \|\| 0\.5/.test(fuente) &&
           /IRONBALLS_PIPE_STOP_USD\) \|\| 150/.test(fuente) && /'CLOSED_EN_NEGATIVO'/.test(fuente));
}

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

// ── 2b. Ejecutor del direccional en TastyTrade (2026-11-09) ─────────────────
//
// El direccional deja de mandar ordenes al sandbox de Tradier: valida con el dry-run de TastyTrade y llena cruzando
// el spread con la marca del libro propio. Lo que NO puede romperse: (1) que nunca salga una orden de verdad, (2) que
// el P&L sea el mismo numero que ya mide el libro (serie historica comparable), (3) que con el interruptor en
// 'tradier' nada cambie, y (4) que la conciliacion de Tradier no "cierre" un trade demo por no verlo en el broker.
seccion('Ejecutor del direccional en TastyTrade (src/ejecutor_tasty.js)');
{
  const ejT = require('../src/ejecutor_tasty');
  const { calcularHuella } = require('../src/algo_version');

  chequear('simbolo Tradier -> TastyTrade (raiz padeada a 6)',
    ejT.aSimboloTasty('SPXW261109P07545000') === 'SPXW  261109P07545000');
  chequear('simbolo invalido -> null', ejT.aSimboloTasty('basura') === null);
  chequear('modo desconocido cae a tradier', ejT.modoValido('loquesea') === 'tradier' && ejT.modoValido(undefined) === 'tradier');

  const legsBP = { shortSym: 'SPXW261109P07545000', longSym: 'SPXW261109P07535000' };
  const abreCred = ejT.cuerpoOrden({ legs: legsBP, contratos: 1, credito: true }, 1.55, true);
  chequear('abrir un credito cobra (Credit)', abreCred['price-effect'] === 'Credit' && abreCred.price === '1.55');
  chequear('abrir: vende la corta y compra la larga',
    abreCred.legs[0].action === 'Sell to Open' && abreCred.legs[1].action === 'Buy to Open'
    && abreCred.legs[0].symbol === 'SPXW  261109P07545000');
  const cierraCred = ejT.cuerpoOrden({ legs: legsBP, contratos: 1, credito: true }, 2.30, false);
  chequear('cerrar un credito paga (Debit)', cierraCred['price-effect'] === 'Debit');
  chequear('cerrar: recompra la corta y vende la larga',
    cierraCred.legs[0].action === 'Buy to Close' && cierraCred.legs[1].action === 'Sell to Close');
  chequear('abrir un debito paga (Debit)',
    ejT.cuerpoOrden({ legs: legsBP, contratos: 1, credito: false }, 4.2, true)['price-effect'] === 'Debit');

  // Cliente falso de TastyTrade: registra cada ruta pedida. El ejecutor solo puede tocar /orders/dry-run.
  const fakeTT = (respuesta) => {
    const rutas = [];
    return { rutas, accountNumber: 'CTA', _req: async (ruta) => { rutas.push(ruta); return respuesta(ruta); } };
  };
  const marca = (neto, confiable = true) => async (legs, lado) =>
    ({ lado, confiable, neto, netoAlMedio: neto, costoCruce: 0.08, fuente: 'tasty', at: '2026-11-09T18:49:44.850Z',
       motivo: confiable ? undefined : 'pata vieja' });
  const okFees = () => ({ data: { 'fee-calculation': { 'total-fees': '2.28' }, warnings: [] } });
  const silencioso = { warn: () => {} };

  pruebasAsync.push((async () => {
    const tt1 = fakeTT(okFees);
    let a = await ejT.crearEjecutorTasty({ tt: tt1, marcar: marca(1.55) }).abrirDemo({ legs: legsBP, contratos: 1, credito: true });
    chequear('demo abre un credito al precio cruzando de la marca', a.ok && a.precio === 1.55, JSON.stringify(a).slice(0, 120));
    chequear('demo toma las comisiones reales del dry-run', a.fees === 2.28, `dio ${a.fees}`);
    chequear('demo SOLO usa /orders/dry-run (nunca manda una orden)',
      tt1.rutas.length === 1 && /\/orders\/dry-run$/.test(tt1.rutas[0]), tt1.rutas.join(','));

    a = await ejT.crearEjecutorTasty({ tt: fakeTT(okFees), marcar: marca(1.55, false) })
      .abrirDemo({ legs: legsBP, credito: true });
    chequear('sin marca confiable NO abre', !a.ok && a.etapa === 'marca');
    a = await ejT.crearEjecutorTasty({ tt: fakeTT(okFees), marcar: marca(-0.40) })
      .abrirDemo({ legs: legsBP, credito: true });
    chequear('un credito que pagaria al abrir NO abre (cadena rota)', !a.ok && a.etapa === 'marca');

    const rechazo = () => { throw new Error('TT API 422 /accounts/CTA/orders/dry-run: {"error":{"message":"Insufficient buying power"}}'); };
    a = await ejT.crearEjecutorTasty({ tt: fakeTT(rechazo), marcar: marca(1.55) }).abrirDemo({ legs: legsBP, credito: true });
    chequear('dry-run rechazado -> NO abre (decision de Guillermo)', !a.ok && a.etapa === 'dry-run');
    chequear('el motivo del rechazo llega legible', /Insufficient buying power/.test(a.motivo || ''), a.motivo);
    const caido = () => { throw new Error('TT API 503 /accounts/CTA/orders/dry-run: '); };
    a = await ejT.crearEjecutorTasty({ tt: fakeTT(caido), marcar: marca(1.55) }).abrirDemo({ legs: legsBP, credito: true });
    chequear('TastyTrade caido -> tampoco abre', !a.ok && a.dryRun?.tipo === 'red');

    // Cierre: un dry-run fallido NUNCA deja el trade colgado
    let c = await ejT.crearEjecutorTasty({ tt: fakeTT(rechazo), marcar: marca(-2.30), log: silencioso })
      .cerrarDemo({ legs: legsBP, contratos: 1, credito: true, feesApertura: 2.28 });
    chequear('dry-run de cierre fallido: cierra igual', c.ok === true && c.precio === 2.30);
    chequear('...con la comision de la apertura como estimado', c.fees === 2.28 && c.feesEstimadas === true);
    c = await ejT.crearEjecutorTasty({ tt: fakeTT(okFees), marcar: async () => ({ confiable: false, motivo: 'sin cotizacion' }) })
      .cerrarDemo({ legs: legsBP, credito: true });
    chequear('sin ningun precio de salida no cierra (reintenta)', c.ok === false);

    // El caso real del 9-nov (tex-1794250185147): Bull Put 7545/7535, libro 1.55 -> -2.30 = -$75 en la cadena real.
    const exReal = { broker: 'tasty_demo', status: 'filled', contracts: 1, isCredit: true,
      feesApertura: 2.28, paperEntry: { confiable: true, neto: 1.55, costoCruce: 0.08 },
      strikes: { shortStrike: 7545, longStrike: 7535 }, timestamp: '2026-11-09T18:49:42Z' };
    c = await ejT.crearEjecutorTasty({ tt: fakeTT(okFees), marcar: marca(-2.30) })
      .cerrarDemo({ legs: legsBP, contratos: 1, credito: true, feesApertura: 2.28 });
    Object.assign(exReal, ejT.asentarCierreDemo(exReal, c, '2026-11-09T19:18:47Z'));
    chequear('cierre demo: P&L bruto identico al del libro (-$75)', exReal.paperPnl.bruto === -75, `dio ${exReal.paperPnl.bruto}`);
    chequear('cierre demo: neto con comisiones REALES (2.28 + 2.28)', exReal.paperPnl.neto === -79.56, `dio ${exReal.paperPnl.neto}`);
    chequear('cierre demo: queda cerrado en el acto', exReal.status === 'closed' && exReal.pnlSource === 'tasty_demo');
    const ro = resultadoOficial(exReal);
    chequear('el P&L oficial lo cuenta como cadena real y comparable',
      ro.fuente === 'cadena_real' && ro.comparable && ro.pnl === -75, JSON.stringify(ro));

    const exDeb = { broker: 'tasty_demo', contracts: 1, isCredit: false, feesApertura: 2.28,
      paperEntry: { confiable: true, neto: -4.20, costoCruce: 0.1 } };
    Object.assign(exDeb, ejT.asentarCierreDemo(exDeb, { marca: { confiable: true, neto: 5.45, costoCruce: 0.1 }, fees: 2.28 }));
    chequear('debito: -4.20 -> +5.45 = +$125', exDeb.paperPnl.bruto === 125, `dio ${exDeb.paperPnl.bruto}`);

    // Cuenta demo: $10.000 + netos de los trades de la demo; los de Tradier no cuentan
    const cta = ejT.cuentaDemoTendencia([
      exReal,
      { ...exDeb, closedAt: '2026-11-10T15:00:00Z' },
      { status: 'closed', pnl: 999, paperPnl: { bruto: 999, confiable: true } },                // Tradier
      { broker: 'tasty_demo', status: 'filled', isCredit: true, contracts: 1,
        strikes: { shortStrike: 7600, longStrike: 7590 }, paperEntry: { neto: 1.90 } },        // abierta
    ], { capital: 10000, pnlDe: (e) => resultadoOficial(e).pnl });
    chequear('cuenta demo: saldo = 10000 - 79.56 + 120.44', cta.saldo === 10040.88, `dio ${cta.saldo}`);
    chequear('cuenta demo: ignora los trades de Tradier', cta.cerrados === 2, `dio ${cta.cerrados}`);
    chequear('cuenta demo: reserva el riesgo de la abierta (10 - 1.90)', cta.reservado === 810, `dio ${cta.reservado}`);
    // Fase 2 (2026-11-16): P&L del día, meta de $200 y desglose por estrategia del libro Robot SPX
    const mk = (fam, neto, closedAt) => ({ broker: 'tasty_demo', status: 'closed', strategyFamily: fam, closedAt,
      feesApertura: 1, feesCierre: 1, _bruto: neto + 2 });
    const libro = (lista, extra = {}) => ejT.cuentaDemoTendencia(lista, { capital: 10000, pnlDe: (e) => e._bruto, hoy: '2026-11-17', metaDia: 200, ...extra });
    const l1 = libro([mk('TENDENCIA', 150, '2026-11-17T15:00:00Z'), mk('MEDIODIA', 60, '2026-11-17T17:00:00Z'), mk('TENDENCIA', 500, '2026-11-16T15:00:00Z')]);
    chequear('libro robot: P&L de hoy solo cuenta lo cerrado hoy (150 + 60)', l1.pnlHoy === 210 && l1.cerradosHoy === 2, `dio ${l1.pnlHoy} / ${l1.cerradosHoy}`);
    chequear('libro robot: con $210 cerrados la meta de $200 queda alcanzada', l1.metaAlcanzada === true);
    const l2 = libro([mk('TENDENCIA', 199.99, '2026-11-17T15:00:00Z'), mk('TENDENCIA', 900, '2026-11-16T20:59:00Z')]);
    chequear('libro robot: $199.99 hoy no alcanza la meta (lo de ayer no cuenta)', l2.metaAlcanzada === false && l2.pnlHoy === 199.99, `dio ${l2.pnlHoy}`);
    const l3 = libro([mk('TENDENCIA', 300, '2026-11-18T03:30:00Z')]);
    chequear('libro robot: el día se corta en hora de Nueva York (22:30 ET del 17 cuenta para el 17)', l3.pnlHoy === 300, `dio ${l3.pnlHoy}`);
    const l4 = libro([mk('TENDENCIA', 250, '2026-11-17T15:00:00Z'),
      { broker: 'tasty_demo', status: 'filled', strategyFamily: 'IRON_CONDOR', isCredit: true, contracts: 1, strikes: { shortStrike: 7600, longStrike: 7595 }, paperEntry: { neto: 1.5 } }]);
    chequear('libro robot: lo abierto no suma a la meta, solo lo cerrado', l4.pnlHoy === 250 && l4.abiertos === 1);
    const pe = Object.fromEntries(l1.porEstrategia.map((x) => [x.estrategia, x]));
    chequear('libro robot: desglose por estrategia', pe.TENDENCIA.cerrados === 2 && pe.TENDENCIA.neto === 650 && pe.TENDENCIA.netoHoy === 150 && pe.MEDIODIA.neto === 60,
      JSON.stringify(l1.porEstrategia));
    chequear('libro robot: sin meta configurada nunca frena', libro([mk('TENDENCIA', 5000, '2026-11-17T15:00:00Z')], { metaDia: null }).metaAlcanzada === false);
  })().catch(e => chequear('pruebas del ejecutor sin excepciones', false, e.stack)));

  // Huella: con el interruptor en 'tradier' la version vigente no cambia
  const cfgProd = { entryMode: 'pullback', minScore: 80, minScoreTrasPerdida: 90,
    weights: { fase_weinstein: 45, regimen_institucional: 10, patrones_estructurales: 20, ema_10_20_alineadas: 10,
               volumen_rompimiento: 0, macd_cruce_pendiente: 15, confirmacion_algoritmica: 0 },
    trading: { targetDelta: 0.3, tpPct: 30, slMult: 1.5, debit: { tpPct: 30, slPct: 50 } } };
  const hBase = calcularHuella(cfgProd, 'TENDENCIA');
  chequear('huella vigente intacta (f85c9f8e)', hBase === 'f85c9f8e', `dio ${hBase}`);
  chequear('interruptor en tradier no mueve la huella',
    calcularHuella({ ...cfgProd, trading: { ...cfgProd.trading, ejecutorTendencia: 'tradier' } }, 'TENDENCIA') === hBase);
  chequear('la demo de TastyTrade nace con huella propia',
    calcularHuella({ ...cfgProd, trading: { ...cfgProd.trading, ejecutorTendencia: 'tasty_demo' } }, 'TENDENCIA') !== hBase);

  // Fase 2: el freno del libro (meta y poder de compra) se mira ANTES de abrir en la demo; los clics van sobre $10.000
  {
    const fsF = require('fs'), pathF = require('path');
    const srv = fsF.readFileSync(pathF.join(__dirname, '..', 'server.js'), 'utf8');
    const iFreno = srv.indexOf("frenoLibro = { etapa: 'meta_dia'"), iAbrir = srv.indexOf('await ejecutorTasty.abrirDemo({ legs: legsDemo');
    chequear('direccional demo: la meta del día se revisa antes de abrir', iFreno > 0 && iAbrir > iFreno);
    chequear('direccional demo: el poder de compra del libro se revisa antes de abrir', srv.indexOf("etapa: 'sin_bp'") > 0 && srv.indexOf("etapa: 'sin_bp'") < iAbrir);
    const clic = fsF.readFileSync(pathF.join(__dirname, '..', 'src', 'clic_real.js'), 'utf8');
    chequear('entradas manuales: capital de $10.000 aunque Railway conserve el de $2.000', /Math\.max\(10000, Number\(process\.env\.CLIC_DEMO_CAPITAL \|\| 10000\)\)/.test(clic));
    chequear('entradas manuales: el preview avisa la meta del día (no frena)', (clic.match(/metaDia: metaDia\(\)/g) || []).length === 3);
  }

  // Estaticas sobre el codigo: las puertas por donde un trade demo podia terminar en Tradier
  const fsE = require('fs'), pathE = require('path');
  // Se normalizan los saltos de linea: en Windows git puede dejar el archivo en CRLF al cambiar de rama, y las
  // busquedas de varias lineas fallarian sin que el codigo haya cambiado (paso en el primer push, 2026-11-09).
  const srcS = fsE.readFileSync(pathE.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const srcE = fsE.readFileSync(pathE.join(__dirname, '..', 'src', 'ejecutor_tasty.js'), 'utf8').replace(/\r\n/g, '\n');
  chequear('el ejecutor no tiene ninguna ruta de orden real', !/\/orders(?!\/dry-run)[`'"/]/.test(srcE));
  chequear('la conciliacion de Tradier excluye los trades demo',
    srcS.includes("executions.filter(e => (e.status === 'submitted' || e.status === 'filled') && !esDemoTasty(e))"));
  chequear('la apertura demo no le pregunta a Tradier por la posicion',
    srcS.includes("const tradierDiceAbierto = viaTasty ? false : await tradier.hasOpenPosition('SPXW');"));
  const iDemo = srcS.indexOf('const rc = await ejecutorTasty.cerrarDemo({ legs: ex.legs, contratos: ex.contracts,\n            credito: esCredito');
  chequear('el monitor cierra la demo antes de llegar a Tradier',
    iDemo > 0 && iDemo < srcS.indexOf('const closeResultDir = await tradier.closeSpreadOrder('));
  chequear('cada trade nuevo sella el gamma de entrada', srcS.includes('entryGamma: {'));
}

// ── 2c. Archivo permanente (2026-11-09) ─────────────────────────────────────
// Las lecturas de gamma/muros y el log de decisiones se recortaban solos (10.000 / 5.000 entradas). El archivo
// guarda una copia por dia que nunca se recorta. Lo que no puede romperse: que un dia cerrado se comprima sin
// perder lineas, que se lea igual comprimido o no, y que una ruta maliciosa no escape de la carpeta.
seccion('Archivo permanente (src/archivo.js)');
{
  const osA = require('os'), fsA = require('fs'), pathA = require('path');
  const dirA = fsA.mkdtempSync(pathA.join(osA.tmpdir(), 'archivo-prueba-'));
  const { crearArchivo } = require('../src/archivo');
  const a = crearArchivo({ dataDir: dirA, log: { warn: () => {} } });
  a.archivar('gamma', { n: 1 }, new Date('2026-11-09T15:00:00Z'));
  a.archivar('gamma', { n: 2 }, new Date('2026-11-09T20:59:00Z'));
  a.archivar('gamma', { n: 3 }, new Date('2026-11-10T03:00:00Z'));   // 22:00 ET del 9-nov: sigue siendo el 9
  a.archivar('gamma', { n: 4 }, new Date('2026-11-10T15:00:00Z'));   // dia nuevo: el 9 se comprime
  const inv = a.listar().gamma || [];
  chequear('el dia cerrado queda comprimido', inv.some(f => f.fecha === '2026-11-09' && f.comprimido));
  chequear('el dia en curso queda sin comprimir', inv.some(f => f.fecha === '2026-11-10' && !f.comprimido));
  const dia9 = (a.leerDia('gamma', '2026-11-09') || '').trim().split('\n');
  chequear('comprimir no pierde lineas (y la fecha es la de Nueva York)', dia9.length === 3, `dio ${dia9.length}`);
  chequear('se lee el dia en curso', (a.leerDia('gamma', '2026-11-10') || '').includes('"n":4'));
  chequear('un tipo con ruta maliciosa no se archiva', a.archivar('../fuera', { x: 1 }) === false);
  chequear('una fecha maliciosa no se lee', a.leerDia('gamma', '../../server') === null);
  const srcA = fsA.readFileSync(pathA.join(__dirname, '..', 'server.js'), 'utf8');
  chequear('las lecturas de gamma se archivan', srcA.includes("archivo.archivar('gamma', entry)"));
  chequear('el log de decisiones se archiva', srcA.includes("archivo.archivar('estrategia', fila)"));
}

// ── 2d. Direccional v2: freno del premercado + DIR-5 + salida TP75/SL75 (2026-11-09) ──
seccion('Direccional v2 (src/filtros_v2.js)');
{
  const f = require('../src/filtros_v2');
  const { calcularHuella } = require('../src/algo_version');
  const prem = { fecha: '2026-11-10', probabilidades: { alcista: 27, neutral: 29, bajista: 44 } };
  chequear('frena un alcista cuando el favorito es bajista', f.evaluarFrenoPremercado('BULLISH', prem).bloquea === true);
  chequear('deja pasar un bajista a favor del favorito', f.evaluarFrenoPremercado('BEARISH', prem).bloquea === false);
  chequear('favorito neutral no frena a nadie',
    !f.evaluarFrenoPremercado('BULLISH', { probabilidades: { alcista: 32, neutral: 35, bajista: 33 } }).bloquea);
  chequear('un empate en el favorito no frena',
    !f.evaluarFrenoPremercado('BULLISH', { probabilidades: { alcista: 30, neutral: 25, bajista: 30 } }).bloquea);
  const s30 = f.evaluarFrenoPremercado('BULLISH', { probabilidades: { alcista: 30, neutral: 40, bajista: 30 } });
  chequear('el 30% o menos se anota pero NO frena (decision de Guillermo)', s30.bajo30 === true && s30.bloquea === false);
  chequear('sin premercado cargado deja pasar', f.evaluarFrenoPremercado('BULLISH', null).bloquea === false);
  const sal = f.parametrosSalidaV2(f.configV2({}));
  chequear('salida v2: TP 75% y SL 1.75x en credito', sal.tpPct === 75 && sal.slMult === 1.75);
  chequear('salida v2: TP 75% / SL 75% en debito', sal.debitTpPct === 75 && sal.debitSlPct === 75);
  chequear('v2 nace apagado', f.configV2({}).activo === false && f.configV2({ trading: { direccionalV2: { activo: 'si' } } }).activo === false);
  const veto = { vetaria: true, nota: 'TP del otro lado del Put Wall' };
  let d = f.decidirV2({ v2: f.configV2({}), direction: 'BEARISH', prem, vetoDir5: veto });
  chequear('apagado: DIR-5 queda en sombra, no bloquea', d.bloquea === false && d.bloquearia === true);
  d = f.decidirV2({ v2: f.configV2({ trading: { direccionalV2: { activo: true } } }), direction: 'BEARISH', prem, vetoDir5: veto });
  chequear('encendido: DIR-5 bloquea al bajista', d.bloquea === true && d.motivos.some(m => /DIR-5/.test(m)));
  d = f.decidirV2({ v2: f.configV2({ trading: { direccionalV2: { activo: true } } }), direction: 'BULLISH', prem, vetoDir5: veto });
  chequear('DIR-5 nunca aplica a un alcista', d.dir5.vetaria === false);
  const base = { entryMode: 'pullback', minScore: 80, minScoreTrasPerdida: 90,
    weights: { fase_weinstein: 45, regimen_institucional: 10, patrones_estructurales: 20, ema_10_20_alineadas: 10,
               volumen_rompimiento: 0, macd_cruce_pendiente: 15, confirmacion_algoritmica: 0 },
    trading: { targetDelta: 0.3, tpPct: 30, slMult: 1.5, debit: { tpPct: 30, slPct: 50 } } };
  const h = (t) => calcularHuella({ ...base, trading: { ...base.trading, ...t } }, 'TENDENCIA');
  chequear('v2 apagado no mueve la huella', h({ direccionalV2: { activo: false } }) === 'f85c9f8e');
  chequear('v2 encendido nace con huella propia', h({ direccionalV2: { activo: true } }) !== 'f85c9f8e');
  const srcV = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  chequear('DIR-5 v2 mide contra el TP de referencia, no contra el TP nuevo', srcV.includes('tpPctDebito: v2cfg.dir5TpReferenciaPct'));
  chequear('el bloqueo v2 va antes de abrir', srcV.indexOf('signal.v2?.bloquea') > 0
    && srcV.indexOf('signal.v2?.bloquea') < srcV.indexOf("const tradierDiceAbierto = viaTasty ? false : await tradier.hasOpenPosition('SPXW');"));
  chequear('cada trade guarda lo que dijo cada filtro', srcV.includes('filtrosV2:     signal.v2 ?? null'));
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

// ── Libro Señales Sigma de la Demo Tasty (2026-11-16) ───────────────────────
// ── Espejo del Robot SPX (src/espejo_robot.js, TastyTrade falso) — fase 2, 2026-11-16 ──
seccion('Espejo del Robot SPX: Tradier → Demo Tasty (src/espejo_robot.js)');
{
  const fsX = require('fs'), osX = require('os'), pathX = require('path');
  const { crearEspejoRobot, patasDesdeEjecucion, riesgoMaximo } = require('../src/espejo_robot');
  const IC = { putShortSym: 'SPXW261117P07400000', putLongSym: 'SPXW261117P07385000', callShortSym: 'SPXW261117C07450000', callLongSym: 'SPXW261117C07465000' };
  const pIC = patasDesdeEjecucion({ contracts: 1, legs: IC });
  chequear('espejo: lee las 4 patas del iron condor con su signo', pIC.length === 4 && pIC.filter((p) => p.q < 0).length === 2 && pIC[0].strike === 7400);
  chequear('espejo: riesgo máximo de un IC de 15 de ancho con 4.20 de crédito = $1.080', riesgoMaximo(pIC, 4.2) === 1080, `dio ${riesgoMaximo(pIC, 4.2)}`);
  const pV2 = patasDesdeEjecucion({ contracts: 2, legs: { shortSym: 'SPXW261117P07400000', longSym: 'SPXW261117P07395000' } });
  chequear('espejo: vertical x2 de 5 de ancho con 1.50 c/u arriesga $700', riesgoMaximo(pV2, 3.0) === 700, `dio ${riesgoMaximo(pV2, 3.0)}`);
  chequear('espejo: una call vendida sin cubrir es riesgo ilimitado', riesgoMaximo([{ sym: 'X', q: -1, tipo: 'C', strike: 100 }, { sym: 'Y', q: 1, tipo: 'P', strike: 90 }], 1) === Infinity);
  chequear('espejo: sin patas legibles no arma nada', patasDesdeEjecucion({ legs: { shortSym: 'basura' } }) === null);

  pruebasAsync.push((async () => {
    const dir = fsX.mkdtempSync(pathX.join(osX.tmpdir(), 'espejo-'));
    let reloj = new Date('2026-11-17T15:00:00Z');
    let ejec = [], precios = {}, libro = { metaAlcanzada: false, disponible: 10000, pnlHoy: 0, metaDia: 200 }, dryOk = { ok: true, fees: 5.2 };
    const pedidos = [];
    const E = crearEspejoRobot({
      dataDir: dir, ahora: () => reloj, leerEjecuciones: () => ejec, libro: () => libro, pnlTradier: (ex) => ex.pnl ?? null,
      cotizar: async (syms) => (syms.every((s) => precios[s]) ? { q: precios } : null),
      dryRun: async (c) => { pedidos.push(c); return dryOk; },
    });
    const pone = (bidAsk) => { precios = {}; for (const [s, [b, a]] of Object.entries(bidAsk)) precios[s] = { bid: b, ask: a, mark: (b + a) / 2 }; };
    const mk = (id, extra = {}) => ({ id, strategyFamily: 'MEDIODIA', strategy: 'IRON_CONDOR', contracts: 1, legs: IC, status: 'submitted',
      timestamp: reloj.toISOString(), entryFillPrice: -4.4, ...extra });
    E._estado();                                            // el espejo se enciende a las 15:00:00Z
    ejec = [mk('viejo', { timestamp: '2026-11-17T14:00:00Z', status: 'filled', filledAt: '2026-11-17T14:00:30Z' })];
    chequear('espejo: no copia lo que Tradier abrió antes de encenderse', (await E.tick()).length === 0 && E.registros().length === 0);

    reloj = new Date('2026-11-17T16:30:00Z');
    ejec.push(mk('a'));
    pone({ [IC.putShortSym]: [3.0, 3.2], [IC.putLongSym]: [1.0, 1.1], [IC.callShortSym]: [2.8, 3.0], [IC.callLongSym]: [0.9, 1.0] });
    await E.tick();
    chequear('espejo: una orden que Tradier todavía no llena no se copia', E.registros().length === 0);
    reloj = new Date('2026-11-17T16:30:40Z');
    ejec[1] = { ...ejec[1], status: 'filled', filledAt: '2026-11-17T16:30:35Z' };
    const h1 = await E.tick();
    const g = E.registros()[0];
    // cruzando: vende al bid 3.0 y 2.8, compra al ask 1.1 y 1.0 = +3.70
    chequear('espejo: al llenar Tradier abre el gemelo cruzando el spread (3.0+2.8-1.1-1.0 = 3.70)', g && g.entrada.precio === 3.7 && g.status === 'filled', JSON.stringify(g?.entrada));
    chequear('espejo: el gemelo queda como demo de TastyTrade, con su familia y el retraso', g.broker === 'tasty_demo' && g.espejo === true && g.strategyFamily === 'MEDIODIA' && g.retrasoSeg === 5 && g.tradierEntrada === 4.4);
    chequear('espejo: riesgo del gemelo = (15 - 3.70) x 100', g.riesgoUsd === 1130, `dio ${g.riesgoUsd}`);
    chequear('espejo: valida con dry-run (nunca orden real) a crédito 3.70 y 4 patas', pedidos.length === 1 && pedidos[0]['price-effect'] === 'Credit' && pedidos[0].price === '3.70' && pedidos[0].legs.length === 4 && pedidos[0].legs[0].action === 'Sell to Open');
    chequear('espejo: avisa lo que hizo', h1.length === 1 && /ABIERTA/.test(h1[0]));
    await E.tick();
    chequear('espejo: no abre dos veces el mismo trade', E.registros().length === 1 && pedidos.length === 1);

    // Tradier cierra por TP → el gemelo cierra cruzando: recompra al ask 1.6 y 1.4, vende al bid 0.4 y 0.3 = -2.30
    reloj = new Date('2026-11-17T17:10:00Z');
    ejec[1] = { ...ejec[1], status: 'closed', closeReason: 'TP', pnl: 180 };
    pone({ [IC.putShortSym]: [1.4, 1.6], [IC.putLongSym]: [0.4, 0.5], [IC.callShortSym]: [1.2, 1.4], [IC.callLongSym]: [0.3, 0.4] });
    await E.tick();
    const c = E.registros()[0];
    chequear('espejo: cuando Tradier cierra, el gemelo cierra con el mismo motivo', c.status === 'closed' && c.closeReason === 'TP');
    chequear('espejo: P&L del gemelo = (3.70 - 2.30) x 100 = $140 bruto, $129.60 neto', c.pnlBruto === 140 && c.pnlNeto === 129.6, `dio ${c.pnlBruto} / ${c.pnlNeto}`);
    chequear('espejo: guarda el resultado de Tradier para comparar', c.tradierPnl === 180);
    const rs = E.resumen().porEstrategia[0];
    chequear('espejo: el resumen compara demo contra Tradier', rs.cerrados === 1 && rs.demoNeto === 129.6 && rs.tradierBruto === 180 && rs.comparables === 1);

    // Reglas del libro
    reloj = new Date('2026-11-17T17:30:00Z');
    libro = { metaAlcanzada: true, disponible: 10000, pnlHoy: 230, metaDia: 200 };
    ejec.push(mk('b', { status: 'filled', filledAt: '2026-11-17T17:29:55Z' }));
    await E.tick();
    const nb = E.resumen().registros.find((x) => x.espejoDe === 'b');
    chequear('espejo: con la meta del día alcanzada no copia más entradas', nb.status === 'no_abierta' && /meta del día/.test(nb.motivo));
    libro = { metaAlcanzada: false, disponible: 500, pnlHoy: 0, metaDia: 200 };
    ejec.push(mk('c', { status: 'filled', filledAt: '2026-11-17T17:29:58Z' }));
    pone({ [IC.putShortSym]: [3.0, 3.2], [IC.putLongSym]: [1.0, 1.1], [IC.callShortSym]: [2.8, 3.0], [IC.callLongSym]: [0.9, 1.0] });
    await E.tick();
    chequear('espejo: sin poder de compra en el libro no abre', /sin poder de compra/.test(E.resumen().registros.find((x) => x.espejoDe === 'c').motivo));
    libro = { metaAlcanzada: false, disponible: 10000, pnlHoy: 0, metaDia: 200 };
    dryOk = { ok: false, tipo: 'rechazo', detalle: 'margen insuficiente' };
    ejec.push(mk('d', { status: 'filled', filledAt: '2026-11-17T17:29:59Z' }));
    await E.tick();
    chequear('espejo: si TastyTrade rechaza el dry-run, no hay trade', /rechazó el dry-run: margen insuficiente/.test(E.resumen().registros.find((x) => x.espejoDe === 'd').motivo));
    dryOk = { ok: true, fees: 5.2 };
    reloj = new Date('2026-11-17T17:40:00Z');
    ejec.push(mk('e', { status: 'filled', filledAt: '2026-11-17T17:35:00Z' }));
    await E.tick();
    chequear('espejo: si llega más de 3 minutos tarde, no copia la entrada', /demasiado tarde/.test(E.resumen().registros.find((x) => x.espejoDe === 'e').motivo));
    ejec.push(mk('f', { strategyFamily: 'TENDENCIA', status: 'filled', filledAt: '2026-11-17T17:39:58Z' }));
    await E.tick();
    chequear('espejo: el Direccional no se copia (ya corre nativo en la demo)', !E.resumen().registros.some((x) => x.espejoDe === 'f'));

    // Cierre sin cotización (0DTE vencido): espera y luego asienta con el resultado de Tradier, marcado
    ejec.push(mk('g', { status: 'filled', filledAt: '2026-11-17T17:39:59Z' }));
    await E.tick();
    reloj = new Date('2026-11-17T21:05:00Z'); precios = {};
    ejec[ejec.length - 1] = { ...ejec[ejec.length - 1], status: 'closed', closeReason: 'EXPIRED', pnl: 370 };
    await E.tick();
    chequear('espejo: sin precio para cerrar, espera (no inventa)', E.registros().find((x) => x.espejoDe === 'g').status === 'filled');
    reloj = new Date('2026-11-17T21:30:00Z');
    await E.tick();
    const v = E.registros().find((x) => x.espejoDe === 'g');
    chequear('espejo: tras 20 min sin precio asienta con el resultado de Tradier y lo deja marcado', v.status === 'closed' && v.salidaDeTradier === true && v.pnlBruto === 370);
    chequear('espejo: lo asentado con Tradier no cuenta como comparable', E.resumen().porEstrategia[0].comparables === 1);

    // El libro Robot SPX suma los gemelos
    const ejT2 = require('../src/ejecutor_tasty');
    const cta = ejT2.cuentaDemoTendencia(E.registros(), { capital: 10000, pnlDe: (e) => e.pnlBruto ?? null, hoy: '2026-11-17', metaDia: 200 });
    chequear('libro robot: suma los gemelos por estrategia', cta.cerrados === 2 && cta.porEstrategia[0].estrategia === 'MEDIODIA', JSON.stringify(cta.porEstrategia));
    fsX.rmSync(dir, { recursive: true, force: true });
  })().catch((e) => chequear('pruebas del espejo sin excepciones', false, e.stack)));
}

// ── Informe diario de los 4 libros (src/informe_diario.js) — fase 2 paso 3, 2026-11-16 ──
seccion('Informe diario de los cuatro libros (src/informe_diario.js)');
{
  const { armarDia, textoPatas, fechaET: fET } = require('../src/informe_diario');
  chequear('diario: el día es el de Nueva York (01:30Z del 18 todavía es 17)', fET('2026-11-18T01:30:00Z') === '2026-11-17');
  chequear('diario: resume las patas', textoPatas([{ sym: 'SPXW261117P07400000', q: -1 }, { sym: 'SPXW261117P07385000', q: 1 }]) === '-1 7400P / +1 7385P');
  const F = '2026-11-17';
  const dia = armarDia({
    fecha: F, hoy: F, diaDeMercado: true,
    manual: { capital: 10000, saldo: 9700, pnlAbierto: 12.5, metaDia: { meta: 200, pnlHoy: 100, superada: false }, lista: [
      { abiertaEn: '2026-11-17T15:00:00Z', cerradaEn: '2026-11-17T15:30:00Z', nombre: 'Bull Put', strikes: '7400/7395', entrada: 1.5, salida: 0.5, comisiones: 6.88, pnlNeto: 93.12, estado: 'cerrada', motivo: 'TP' },
      { abiertaEn: '2026-11-17T18:00:00Z', nombre: 'Bear Call', strikes: '7500/7505', entrada: 1.2, comisiones: 3.44, pnlNeto: null, estado: 'abierta' },
      { abiertaEn: '2026-11-16T15:00:00Z', cerradaEn: '2026-11-16T16:00:00Z', nombre: 'Viejo', strikes: '1/2', pnlNeto: 500, estado: 'cerrada' },
    ] },
    senales: { capital: 10000, saldo: 9810, pnlHoy: 20, alertas: [],
      abiertas: [{ profe: 'Luis', activo: 'SPY', estrategia: 'BPS', patas: [], mensajeAt: '2026-11-17T15:00:00Z', entrada: { at: '2026-11-17T15:02:00Z', precio: 0.8, fees: 2 }, estado: 'abierta', latenteCruzando: -15 }],
      pendientes: [],
      historial: [
        { profe: 'Rocío', activo: 'IWM', estrategia: 'Calendario', mensajeAt: '2026-11-10T15:00:00Z', entrada: { at: '2026-11-10T15:01:00Z', precio: 0.6, fees: 1 }, salida: { precio: 0.9, fees: 1 }, estado: 'cerrada', pnlRealizado: 20, cerradaAt: '2026-11-17T17:00:00Z' },
        { profe: 'Facu', activo: 'XSP', estrategia: 'Calendario', mensajeAt: '2026-11-17T16:00:00Z', entrada: null, estado: 'rechazada', motivo: 'Dry-run rechazado', cerradaAt: '2026-11-17T16:00:30Z' },
      ] },
    ejecuciones: [
      { broker: 'tasty_demo', strategyFamily: 'TENDENCIA', strategy: 'BEAR_PUT_SPREAD', strikes: { longStrike: 7495, shortStrike: 7485 }, contracts: 1, status: 'closed',
        timestamp: '2026-11-17T16:00:00Z', closedAt: '2026-11-17T16:40:00Z', entryFillPrice: 3.7, feesApertura: 3.44, feesCierre: 3.44, closeReason: 'TP', bruto: 250 },
      { broker: 'tradier', strategyFamily: 'MEDIODIA', status: 'closed', timestamp: '2026-11-17T16:00:00Z', closedAt: '2026-11-17T17:00:00Z', bruto: 999 },
    ],
    pnlDe: (e) => e.bruto ?? null,
    gemelos: [
      { espejo: true, broker: 'tasty_demo', strategyFamily: 'MEDIODIA', status: 'closed', patas: [{ sym: 'SPXW261117P07400000', q: -1 }], filledAt: '2026-11-17T16:30:40Z', timestamp: '2026-11-17T16:30:40Z',
        closedAt: '2026-11-17T17:10:00Z', closeReason: 'TP', entrada: { precio: 3.7 }, salida: { precio: 2.3 }, feesApertura: 5.2, feesCierre: 5.2, pnlNeto: 129.6, tradierPnl: 180, retrasoSeg: 5 },
      { espejo: true, broker: 'tasty_demo', strategyFamily: 'REVERSION', status: 'no_abierta', motivo: 'meta del día alcanzada', timestamp: '2026-11-17T18:00:00Z', patas: [] },
      { espejo: true, broker: 'tasty_demo', strategyFamily: 'NEUTRAL', status: 'closed', patas: [], filledAt: '2026-11-17T17:00:00Z', timestamp: '2026-11-17T17:00:00Z', closedAt: '2026-11-17T21:30:00Z',
        feesApertura: 5, feesCierre: 5, pnlNeto: 360, tradierPnl: 370, salidaDeTradier: true, retrasoSeg: 9 },
    ],
    robot: { capital: 10000, saldo: 10500, pnlHoy: 732.72, metaDia: 200, metaAlcanzada: true },
    espejo: { desde: '2026-11-17T14:30:00Z' }, espejoActivo: true,
    ironPipe: { lista: [{ prueba: true, estado: 'cerrada', abiertaEn: '2026-11-17T15:00:00Z', cerradaEn: '2026-11-17T15:10:00Z', pnlUsd: -11.88 }] },
    ironAle: { lista: [{ prueba: false, fuenteSenal: 'Alejandro', nombre: 'Bear Call Spread', corto: 7605, largo: 7610, estado: 'cerrada', abiertaEn: '2026-11-17T16:01:00Z', cerradaEn: '2026-11-17T16:10:00Z',
      precioEntrada: 2.8, precioSalida: 2.25, feesApertura: 3.44, feesCierre: 3.44, pnlUsd: 48.12, motivoCierre: 'FUERA_ALEJANDRO' }] },
    ironLibro: { capital: 10000, saldo: 10180.6 },
  });
  const L = Object.fromEntries(dia.libros.map((x) => [x.libro, x]));
  chequear('diario: trae los cuatro libros, en orden y sin sumar saldos', dia.libros.map((x) => x.libro).join('|') === 'Entradas Manuales|Señales Sigma|Robot SPX|Iron Balls' && !('saldoTotal' in dia));
  const m = L['Entradas Manuales'];
  chequear('diario manual: solo cuenta lo cerrado hoy ($93.12), no lo de ayer', m.resultadoHoy === 93.12 && m.cerradosHoy === 1 && m.abiertosHoy === 2 && m.abiertasAhora === 1);
  chequear('diario manual: avisa si el libro reporta otro número del día (cierres parciales)', m.avisos.some((a) => /El libro reporta \$100/.test(a)) && m.latente === 12.5);
  const sg = L['Señales Sigma'];
  chequear('diario señales: cierre de hoy de una posición vieja cuenta; lo abierto hoy aparece', sg.resultadoHoy === 20 && sg.cerradosHoy === 1 && sg.abiertosHoy === 1 && sg.movimientos.length === 2 && sg.avisos.length === 0);
  chequear('diario señales: la rechazada sale en "no entraron" con su motivo y el latente de lo abierto', sg.noEntraron.length === 1 && /rechazado/.test(sg.noEntraron[0].motivo) && sg.latente === -15);
  const rb = L['Robot SPX'];
  chequear('diario robot: Direccional neto de comisiones (250 - 6.88) + gemelos; Tradier puro no entra', rb.resultadoHoy === +(243.12 + 129.6 + 360).toFixed(2) && rb.cerradosHoy === 3, `dio ${rb.resultadoHoy}`);
  chequear('diario robot: separa por estrategia', rb.porEstrategiaHoy.length === 3 && rb.porEstrategiaHoy.find((x) => x.estrategia === 'Mediodía').neto === 129.6);
  chequear('diario robot: espejo compara solo lo comparable (no lo asentado con Tradier)', rb.espejo.comparables === 1 && rb.espejo.demoNeto === 129.6 && rb.espejo.tradierBruto === 180 && rb.espejo.retrasoProm === 7 && rb.espejo.noCopiadosHoy === 1);
  chequear('diario robot: avisa la meta alcanzada', rb.avisos.some((a) => /Meta del día alcanzada/.test(a)));
  const ib = L['Iron Balls'];
  chequear('diario iron balls: ignora las pruebas y trae la fuente', ib.resultadoHoy === 48.12 && ib.movimientos.length === 1 && ib.movimientos[0].grupo === 'Alejandro' && ib.saldo === 10180.6);
  const vacio = armarDia({ fecha: '2026-11-18', hoy: '2026-11-18', errores: { 'Iron Balls': 'caído' } });
  chequear('diario: un día sin trades sale en ceros, y un libro caído no tumba a los otros', vacio.libros[0].resultadoHoy === 0 && vacio.libros[0].movimientos.length === 0 && vacio.libros[3].error === 'caído' && vacio.libros.length === 4);
  const pend = armarDia({ fecha: F, hoy: F, gemelos: [{ espejo: true, strategyFamily: 'NEUTRAL', status: 'closed', patas: [], filledAt: '2026-11-17T17:00:00Z', closedAt: '2026-11-17T21:01:00Z', pnlNeto: null }] });
  chequear('diario: un cierre sin resultado asentado se avisa y no se inventa', pend.libros[2].resultadoHoy === 0 && pend.libros[2].avisos.some((a) => /sin resultado asentado/.test(a)));
  // armarLibros (2026-11-17): todos los trades por libro para las hojas del menú
  const { armarLibros } = require('../src/informe_diario');
  const tl = armarLibros({ hoy: F, errores: { 'Señales Sigma': 'caído' },
    manual: { capital: 10000, saldo: 10050, lista: [
      { nombre: 'Bull Put', strikes: '7400/7395', estado: 'cerrada', abiertaEn: '2026-11-16T15:03:00Z', cerradaEn: '2026-11-16T15:07:00Z', entrada: 2.75, salida: 3, comisiones: 4.88, pnlNeto: 20.12 },
      { nombre: 'Bear Call', strikes: '7485/7490', estado: 'abierta', abiertaEn: '2026-11-17T16:11:00Z' }] },
    ironPipe: { lista: [{ nombre: 'IC', estado: 'cerrada', abiertaEn: '2026-11-17T15:00:00Z', cerradaEn: '2026-11-18T01:30:00Z', pnlUsd: 30 }, { prueba: true, estado: 'cerrada', pnlUsd: 999 }] },
    ironAle: { lista: [] }, ironLibro: { capital: 10000, saldo: 10030 } });
  const TL = Object.fromEntries(tl.libros.map((l) => [l.clave, l]));
  chequear('libros/filas: los cuatro libros con su clave, y uno caído no tumba a los otros', tl.ok && tl.libros.length === 4 && TL.senales.error === 'caído' && TL.manual.filas.length === 2 && TL.robot.filas.length === 0);
  chequear('libros/filas: cada fila trae el día de Nueva York del cierre y de la apertura', TL.manual.filas[0].dia === '2026-11-16' && TL.manual.filas[0].neto === 20.12 && TL.manual.filas[1].dia === null && TL.manual.filas[1].diaApertura === '2026-11-17' && TL.manual.filas[1].estado === 'abierto');
  chequear('libros/filas: el día es el de Nueva York (un cierre a las 01:30 UTC cuenta para el día anterior) y las pruebas no entran', TL.ironballs.filas.length === 1 && TL.ironballs.filas[0].dia === '2026-11-17' && TL.ironballs.saldo === 10030);
}

// ── Puerta de escritura (src/puerta.js) — 2026-11-16 ──
seccion('Puerta de escritura: clave para todo lo que escribe (src/puerta.js)');
{
  const { crearPuerta, patron } = require('../src/puerta');
  const pasa = (P, req) => { let sig = false, cod = 200; P.middleware({ headers: {}, query: {}, ...req }, { status: (c) => { cod = c; return { json: () => {} }; } }, () => { sig = true; }); return { sig, cod }; };
  const env = {};
  const P = crearPuerta({ env });
  chequear('puerta: sin BITACORA_TOKEN está apagada y todo pasa como antes', P.estado() === 'apagada' && pasa(P, { method: 'POST', path: '/api/spx/panic' }).sig && P.lista().length === 0);
  env.BITACORA_TOKEN = 'clave-de-prueba-123';
  chequear('puerta: con token queda en aviso — deja pasar y anota', P.estado() === 'aviso' && pasa(P, { method: 'POST', path: '/api/spx/panic', headers: { 'user-agent': 'curl/8' } }).sig && P.lista().length === 1 && P.lista()[0].ruta === '/api/spx/panic' && P.lista()[0].bloqueado === false);
  chequear('puerta: las lecturas no se anotan ni se frenan', pasa(P, { method: 'GET', path: '/api/spx/config' }).sig && P.lista().length === 1);
  chequear('puerta: quien trae la clave en la cabecera no se anota', pasa(P, { method: 'POST', path: '/api/spx/config', headers: { 'x-bitacora-token': 'clave-de-prueba-123' } }).sig && P.lista().length === 1);
  env.BITACORA_PUERTA = 'cerrada';
  const r = pasa(P, { method: 'DELETE', path: '/api/tradier/executions/tex-1794326510797' });
  chequear('puerta cerrada: sin clave responde 401 y no sigue', P.estado() === 'cerrada' && !r.sig && r.cod === 401);
  chequear('puerta cerrada: clave equivocada o vacía no pasa', !pasa(P, { method: 'POST', path: '/api/spx/panic', headers: { 'x-bitacora-token': 'otra' } }).sig && !pasa(P, { method: 'POST', path: '/api/spx/panic', headers: { 'x-bitacora-token': '' } }).sig);
  chequear('puerta cerrada: pasa con cabecera, con cookie o con ?k= (TradingView)',
    pasa(P, { method: 'POST', path: '/api/spx/panic', headers: { 'x-bitacora-token': 'clave-de-prueba-123' } }).sig
    && pasa(P, { method: 'POST', path: '/api/spx/panic', headers: { cookie: 'a=1; bitacora_token=clave-de-prueba-123' } }).sig
    && pasa(P, { method: 'POST', path: '/api/spx/webhook', query: { k: 'clave-de-prueba-123' } }).sig);
  chequear('puerta cerrada: las direcciones con clave propia siguen con la suya', pasa(P, { method: 'POST', path: '/api/ironballs/alerta' }).sig && pasa(P, { method: 'POST', path: '/api/spx/clic-real' }).sig);
  chequear('puerta cerrada: lo que no es /api y las lecturas siguen abiertas', pasa(P, { method: 'GET', path: '/api/libros' }).sig && pasa(P, { method: 'POST', path: '/otra' }).sig);
  chequear('puerta: agrupa los avisos por dirección sin el identificador', patron('/api/tradier/executions/tex-1794326510797/patch') === '/api/tradier/executions/:x/patch' && patron('/api/spx/strategies/TENDENCIA') === '/api/spx/strategies/TENDENCIA');
  // Ninguna dirección de escritura de server.js queda por fuera: todas viven bajo /api
  const rutasW = [...require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8').matchAll(/^app\.(post|put|delete|patch)\('([^']+)'/gm)].map((m) => m[2]);
  chequear('puerta: todas las direcciones de escritura del servidor están bajo /api (la puerta las cubre)', rutasW.length > 50 && rutasW.every((x) => x.startsWith('/api/')), rutasW.filter((x) => !x.startsWith('/api/')).join(','));
}

seccion('Señales Sigma: lectura de las alertas (src/sigma_senales.js)');
{
  const sg = require('../src/sigma_senales');
  const calS = require('../src/calendario_nyse');
  const ALERTA_FACU = '🔔 *Options Alert — Sigma Trade*\n\n📌 *SPX — Bull Put Spread*\n\n──────────\n🔴 Sell 1× Put 7500 (Dec 18, 2026) @ $132.45\n🟢 Buy 1× Put 7490 (Dec 18, 2026) @ $129.00\n\n💰 *Net Credit:* $345.00\n\n📉 *Max loss (risk):* $655.00\n\n📊 *Probability of profit:* 51.96%';
  let p = sg.parsearSenalSigma(ALERTA_FACU, { mensajeAt: '2026-11-13T16:25:19Z', autorJid: '5491125371038@s.whatsapp.net' });
  chequear('la alerta en inglés se lee como apertura', p.tipo === 'apertura' && p.ok);
  chequear('el número 5491125371038 es Facu (no Gonza)', p.profe === 'Facu', `dio ${p.profe}`);
  chequear('tercer viernes de dic = raíz SPX (mensual)', p.patas[0].sym === 'SPX261218P07500000', p.patas[0].sym);
  chequear('vende la de 7500 y compra la de 7490', p.patas[0].q === -1 && p.patas[1].q === 1);
  chequear('crédito publicado por acción 3.45, riesgo $655, POP 51.96', p.netoPublicado === 3.45 && p.riesgoUsd === 655 && p.pop === 51.96,
    `${p.netoPublicado} ${p.riesgoUsd} ${p.pop}`);
  p = sg.parsearSenalSigma('🚨📢 NUEVA OPERACIÓN DE ROCÍO\n\n🔔 *Alerta de Opción — Sigma Trade*\n\n📌 *IWM — Double Calendar Spread*\n\n🟢 Compra 1× Put 269 (nov 23, 2026) @ $1.34\n🔴 Venta 1× Put 269 (nov 20, 2026) @ $1.035\n\n💰 *Débito Neto:* $30.50', { autorJid: '34605855722@s.whatsapp.net' });
  chequear('en español, con el profe en el encabezado (Rocío)', p.ok && p.profe === 'Rocío' && p.patas.length === 2, JSON.stringify(p).slice(0, 120));
  chequear('un débito sale negativo', p.netoPublicado === -0.305, `dio ${p.netoPublicado}`);
  chequear('SPX que no es tercer viernes = SPXW', sg.simbolo('SPX', 2026, 11, 16, 'P', 7400) === 'SPXW261116P07400000');
  const c = sg.parsearSenalSigma('⚠️ CLOSED\n(Shared on Nov 13)\n\n✅ SPX December 18 7490/7500 Bull Put Spread @ 14.49%\nClosed at 2.95 debit\n\nProfit of $50 per position', { autorJid: '5491125371038@s.whatsapp.net' });
  chequear('el cierre se lee: activo, strikes, fecha, precio y P&L', c.tipo === 'cierre' && c.ok && c.strikes.join('/') === '7490/7500'
    && c.mes === 12 && c.dia === 18 && c.precioCierre === 2.95 && c.pnlPublicadoUsd === 50, JSON.stringify(c).slice(0, 160));
  const trade = { activo: 'SPX', patas: [{ strike: 7500, vto: '2026-12-18' }, { strike: 7490, vto: '2026-12-18' }] };
  chequear('el cierre encuentra su posición', sg.coincideCierre(trade, c));
  chequear('otro vencimiento no coincide', !sg.coincideCierre({ ...trade, patas: trade.patas.map((x) => ({ ...x, vto: '2026-11-20' })) }, c));
  const perd = sg.parsearSenalSigma('⚠️ CERRADO\n\n❌ SPY October 19 772/772/785/785 Double Calendar Spread @ -29.41%\n\nPérdida de $22 por posición');
  chequear('una pérdida publicada sale negativa', perd.pnlPublicadoUsd === -22 && perd.strikes.join('/') === '772/785');
  chequear('30 min: en horario cuentan desde la publicación',
    sg.venceVentana('2026-11-13T16:25:19Z', calS).toISOString() === '2026-11-13T16:55:19.000Z');
  chequear('30 min: antes de la apertura cuentan desde las 9:30 ET',
    sg.venceVentana('2026-11-16T13:00:00Z', calS).toISOString() === '2026-11-16T15:00:00.000Z');
  chequear('30 min: después del cierre cuentan desde la próxima apertura (vie 16:04 → lun 10:00)',
    sg.venceVentana('2026-11-13T21:04:00Z', calS).toISOString() === '2026-11-16T15:00:00.000Z');
}

seccion('Señales Sigma: el libro demo (src/libro_senales.js, TastyTrade falso)');
{
  const ls = require('../src/libro_senales');
  const calS = require('../src/calendario_nyse');
  const fsS = require('fs'), osS = require('os'), pathS = require('path');
  const dir = fsS.mkdtempSync(pathS.join(osS.tmpdir(), 'libro-senales-'));
  const q0 = { SPX261218P07500000: { bid: 132.0, ask: 132.9, mark: 132.45 }, SPX261218P07490000: { bid: 128.6, ask: 129.4, mark: 129.0 } };
  const bp = [{ sym: 'SPX261218P07500000', q: -1 }, { sym: 'SPX261218P07490000', q: 1 }];
  chequear('abrir cruzando: vende al bid, compra al ask', ls.netoCruzando(bp, q0, 'abrir') === 2.6, `dio ${ls.netoCruzando(bp, q0, 'abrir')}`);
  chequear('cerrar cruzando: recompra al ask, vende al bid', ls.netoCruzando(bp, q0, 'cerrar') === -4.3, `dio ${ls.netoCruzando(bp, q0, 'cerrar')}`);
  const body = ls.cuerpoOrden(bp, 2.6, true);
  chequear('la orden del dry-run lleva el símbolo de Tasty y el efecto correcto',
    body.legs[0].symbol === 'SPX   261218P07500000' && body.legs[0].action === 'Sell to Open' && body['price-effect'] === 'Credit');
  let reloj = new Date('2026-11-13T16:27:00Z');                 // 2 min después de la señal de Facu
  const rutas = [];
  const libro = ls.crearLibroSenales({
    dataDir: dir, calendario: calS, ahora: () => reloj,
    cotizar: async () => ({ q: q0 }),
    dryRun: async (b) => { rutas.push(b['price-effect']); return { ok: true, fees: 2.28 }; },
  });
  const ALERTA = '🔔 *Options Alert — Sigma Trade*\n\n📌 *SPX — Bull Put Spread*\n\n🔴 Sell 1× Put 7500 (Dec 18, 2026) @ $132.45\n🟢 Buy 1× Put 7490 (Dec 18, 2026) @ $129.00\n\n💰 *Net Credit:* $345.00\n\n📉 *Max loss (risk):* $655.00';
  pruebasAsync.push((async () => {
    let r = await libro.procesarAlerta({ alertId: 'A1', mensajeAt: '2026-11-13T16:25:19Z', texto: ALERTA, autorJid: '5491125371038@s.whatsapp.net' });
    chequear('señal dentro de los 30 min: abre en el demo', r.estado === 'ABIERTA', JSON.stringify(r));
    r = await libro.procesarAlerta({ alertId: 'A1', mensajeAt: '2026-11-13T16:25:19Z', texto: ALERTA });
    chequear('el mismo mensaje dos veces no duplica', r.repetida === true);
    reloj = new Date('2026-11-13T17:30:00Z');
    r = await libro.procesarAlerta({ alertId: 'A2', mensajeAt: '2026-11-13T16:50:00Z',
      texto: ALERTA.replace(/7500/g, '7400').replace(/7490/g, '7390'), autorJid: '13213201370@s.whatsapp.net' });
    chequear('señal recibida pasados los 30 min: VENCIDA, no se toma', r.estado === 'VENCIDA', JSON.stringify(r));
    reloj = new Date('2026-11-13T18:53:00Z');
    r = await libro.procesarAlerta({ alertId: 'A3', mensajeAt: '2026-11-13T18:52:14Z',
      texto: '⚠️ CLOSED\n\n✅ SPX December 18 7490/7500 Bull Put Spread @ 14.49%\nClosed at 4.00 debit\n\nLoss of $55 per position' });   // 4.30 nuestro vs 4.00: 7.5%, cierra solo
    chequear('el CLOSED del profe cierra la posición del demo', r.estado === 'CIERRE_DEMO', JSON.stringify(r));
    const res = await libro.resumen({ marcar: false });
    // entrada 2.60 crédito, salida -4.30 → (2.60 - 4.30) * 100 - 2.28 - 2.28 = -174.56
    chequear('P&L = (entrada + salida) × 100 − comisiones reales', res.realizado === -174.56, `dio ${res.realizado}`);
    chequear('saldo del libro = $10.000 + realizado', res.saldo === 9825.44, `dio ${res.saldo}`);
    chequear('el libro solo pidió dry-runs (abrir crédito, cerrar débito)', rutas.join(',') === 'Credit,Debit', rutas.join(','));
    chequear('la vencida cuenta en el historial por profe', res.porProfe.some((x) => x.profe === 'Luis' && x.vencidas === 1));
    reloj = new Date('2026-11-14T15:00:00Z');                    // sábado
    r = await libro.procesarAlerta({ alertId: 'A4', mensajeAt: '2026-11-14T15:00:00Z',
      texto: ALERTA.replace(/7500/g, '7600').replace(/7490/g, '7590') });
    chequear('fin de semana: queda pendiente (no abre con mercado cerrado)', r.estado === 'ESPERA', JSON.stringify(r));
    fsS.rmSync(dir, { recursive: true, force: true });
  })());
}

seccion('Señales Sigma: margen, rolls y ajustes (2026-11-18)');
{
  const sg = require('../src/sigma_senales');
  const ls = require('../src/libro_senales');
  const sgG = require('../src/sigma_gestion');
  const calS = require('../src/calendario_nyse');
  const fsS = require('fs'), osS = require('os'), pathS = require('path');

  // Lectura
  const IC = '🔔 *Alerta de Opción — Sigma Trade*\n\n📌 *SPX — SPX Dec 18 AM 7090/7100/7770/7780 Iron Condor*\n\n🟢 Compra 1× Put 7090 (dic 18 AM, 2026) @ $90.40\n🔴 Venta 1× Put 7100 (dic 18 AM, 2026) @ $92.00\n🔴 Venta 1× Call 7770 (dic 18 AM, 2026) @ $25.10\n🟢 Compra 1× Call 7780 (dic 18 AM, 2026) @ $22.50';
  let p = sg.parsearSenalSigma(IC, { autorJid: '13213201370@s.whatsapp.net' });
  chequear('"(dic 18 AM, 2026)" se lee: 4 patas SPX mensual (el IC de Luis del 18-nov)', p.ok && p.patas.length === 4 && p.patas[0].sym === 'SPX261218P07090000', JSON.stringify(p.patas.map((x) => x.sym)));
  const RUEDA = '📊 Roll CSP – AGNC\n\n🔁  Roll Short Put strike 8:\n\n📅 18 diciembre → 15 enero\n🎯 Mantengo strike 8\n💰 Crédito recibido: $12';
  p = sg.parsearSenalSigma(RUEDA, { mensajeAt: '2026-12-10T16:00:00Z', autorJid: '34605855722@s.whatsapp.net' });
  chequear('roll de rueda de Tarri: cierra la put de dic y abre la de enero del año siguiente',
    p.tipo === 'roll' && p.activo === 'AGNC' && p.cerrar[0].strike === 8 && p.cerrar[0].anio === 2026 && p.abrir[0].mes === 1 && p.abrir[0].anio === 2027 && p.netoPublicadoUsd === 12, JSON.stringify(p));
  p = sg.parsearSenalSigma('📊 Roll CC sobre Futuro Sintético – PFE\n\n🔁  Roll Short Call strike 26.5:\n\n📅 25 septiembre → 16 octubre\n🎯 Subo al strike 27\n💰 Débito pagado: $22', { mensajeAt: '2026-09-23T15:06:00Z' });
  chequear('roll de rueda con cambio de strike y débito', p.abrir[0].strike === 27 && p.netoPublicadoUsd === -22);
  p = sg.parsearSenalSigma('🚨📢 GESTIÓN, POSICIÓN DE HENRY\n\n🔔 *Alerta de Opción — Sigma Trade*\n\n📌 *TSM — Bull Put Spread*\nES UN ROLL, NO ES UNA POSICIÓN NUEVA. \n🟢 Compra 1× Put 430 (ene 15, 2027) @ $46.30\n🔴 Venta 1× Put 440 (ene 15, 2027) @ $53.35');
  chequear('alerta con "ES UN ROLL" no es una entrada nueva: roll que cierra todo y abre 2 patas', p.tipo === 'roll' && p.cerrar === null && p.abrir.length === 2 && p.profe === 'Henry');
  chequear('"♻️ Roll de META" sin patas = gestión a interpretar', sg.parsearSenalSigma('♻️ Roll de META').tipo === 'gestion');
  const ag = sgG.aGestion({ es_gestion: true, activo: 'META', accion: 'roll', neto_usd: 153,
    cerrar: [{ tipo: 'P', strike: 640, dia: 20, mes: 11, anio: 2026, cantidad: 1, lado: 'comprada', precio: 24.83 },
             { tipo: 'P', strike: 650, dia: 20, mes: 11, anio: 2026, cantidad: 1, lado: 'vendida', precio: 32.4 }],
    abrir: [{ tipo: 'P', strike: 640, dia: 18, mes: 12, anio: 2026, cantidad: 1, lado: 'comprada', precio: 41.2 },
            { tipo: 'P', strike: 655, dia: 18, mes: 12, anio: 2026, cantidad: 1, lado: 'vendida', precio: 50.3 }] });
  chequear('lectura de la foto de Luis → patas con signo (vendida = -1)', ag.ok && ag.cerrar[1].q === -1 && ag.abrir[0].q === 1 && ag.netoPublicadoUsd === 153);

  // Libro con TastyTrade falso
  const dir = fsS.mkdtempSync(pathS.join(osS.tmpdir(), 'libro-senales-g-'));
  let reloj = new Date('2026-12-10T15:00:00Z');   // jueves 10:00 ET
  const Q = {
    AGNC261218P00008000: { bid: 0.22, ask: 0.24, mark: 0.23 },
    AGNC270115P00008000: { bid: 0.33, ask: 0.36, mark: 0.345 },
    SOFI261218P00016000: { bid: 0.50, ask: 0.54, mark: 0.52 },
  };
  let margenPorOrden = 250;
  const libro = ls.crearLibroSenales({
    dataDir: dir, calendario: calS, ahora: () => reloj, capital: 1000,
    cotizar: async () => ({ q: Q }),
    dryRun: async (b) => ({ ok: true, fees: b.legs.length * 1.13, margen: margenPorOrden }),
    interpretar: async () => ({ ok: true, activo: 'SOFI', accion: 'cierre_parcial', netoPublicadoUsd: null,
                                cerrar: [{ tipo: 'P', strike: 16, dia: 18, mes: 12, anio: 2026, q: -1 }], abrir: [] }),
  });
  const SP = (tk, k, cred, riesgo) => `🔔 *Alerta de Opción — Sigma Trade*\n\n📌 *${tk} — Short Put*\n\n🔴 Venta 1× Put ${k} (dic 18, 2026) @ $${cred}\n\n💰 *Crédito Neto:* $${Math.round(cred * 100)}\n\n📉 *Pérdida máx (riesgo):* $${riesgo}`;
  pruebasAsync.push((async () => {
    let r = await libro.procesarAlerta({ alertId: 'G1', mensajeAt: '2026-12-10T14:59:00Z', texto: SP('AGNC', 8, 0.23, 773), autorJid: '34605855722@s.whatsapp.net' });
    let res = await libro.resumen({ marcar: false });
    chequear('margin: el put vendido aparta el margen de TastyTrade ($250), no la pérdida máxima ($773)',
      r.estado === 'ABIERTA' && res.reservado === 250 && res.abiertas[0].margenFuente === 'tastytrade', `${r.estado} reservado ${res.reservado}`);
    chequear('tope 75%: con $1.000 de saldo se pueden comprometer $750', res.topeMargen === 750 && res.disponible === 500, `${res.topeMargen} ${res.disponible}`);
    margenPorOrden = 600;
    r = await libro.procesarAlerta({ alertId: 'G2', mensajeAt: '2026-12-10T14:59:30Z', texto: SP('SOFI', 16, 0.46, 1554), autorJid: '5491125371038@s.whatsapp.net' });
    chequear('señal que no cabe en el tope: rechazada por poder de compra', r.estado === 'RECHAZADA' && /poder de compra/.test(r.motivo), JSON.stringify(r));
    margenPorOrden = 300;
    r = await libro.procesarAlerta({ alertId: 'G3', mensajeAt: '2026-12-10T15:00:00Z', texto: SP('SOFI', 16, 0.46, 1554), autorJid: '5491125371038@s.whatsapp.net' });
    chequear('la misma señal con margen menor sí entra', r.estado === 'ABIERTA', JSON.stringify(r));

    // Roll de rueda sobre AGNC: cierra la de dic (recompra al ask 0.24) y abre la de ene (vende al bid 0.33)
    reloj = new Date('2026-12-10T16:00:00Z');
    margenPorOrden = 260;
    r = await libro.procesarAlerta({ alertId: 'G4', mensajeAt: '2026-12-10T16:00:00Z', texto: RUEDA, autorJid: '34605855722@s.whatsapp.net' });
    let L = libro._cargar();
    let t = L.trades.find((x) => x.activo === 'AGNC');
    chequear('el roll de Tarri se replica en el demo sobre la misma posición', r.estado === 'AJUSTE_DEMO' && t.patas.length === 1 && t.patas[0].sym === 'AGNC270115P00008000', JSON.stringify(r));
    // entrada 0.22 (bid) - 1.13; ajuste: (-0.24 + 0.33) * 100 - 1.13 - 1.13 = 6.74
    chequear('el ajuste guarda su efectivo (cruzando el spread, con comisiones)', t.ajustes[0].caja === 6.74 && ls.cajaDe(t) === 27.61, `${t.ajustes[0].caja} ${ls.cajaDe(t)}`);
    chequear('después del roll, el margen es el de la estructura nueva', t.margen === 260, `${t.margen}`);

    r = await libro.procesarAlerta({ alertId: 'G5', mensajeAt: '2026-12-10T16:05:00Z', texto: RUEDA.replace(/AGNC/g, 'UBER'), autorJid: '34605855722@s.whatsapp.net' });
    chequear('roll de una posición que no tenemos: se anota y no abre nada (decisión de Guillermo)', r.estado === 'ROLL_SIN_BASE', JSON.stringify(r));
    r = await libro.procesarAlerta({ alertId: 'G6', mensajeAt: '2026-12-10T16:06:00Z', texto: '♻️ Roll de META', imagenB64: 'AAAA', autorJid: '13213201370@s.whatsapp.net' });
    chequear('foto de roll de un activo que no tenemos: no gasta una lectura de Claude', r.estado === 'IGNORADA' || r.estado === 'ROLL_SIN_BASE', JSON.stringify(r));
    r = await libro.procesarAlerta({ alertId: 'G7', mensajeAt: '2026-12-10T16:10:00Z', texto: 'Cerré la put vendida de SOFI 16, ajuste de la posición', autorJid: '5491125371038@s.whatsapp.net' });
    L = libro._cargar();
    t = L.trades.find((x) => x.activo === 'SOFI' && x.estado !== 'rechazada');
    chequear('gestión en texto libre leída por Claude: cierre parcial que deja la posición sin patas = cerrada', r.estado === 'AJUSTE_CIERRA' && t.estado === 'cerrada', JSON.stringify(r));

    // Cierre final de AGNC con el CLOSED del profe: P&L = caja + cierre
    reloj = new Date('2026-12-11T16:00:00Z');
    r = await libro.procesarAlerta({ alertId: 'G8', mensajeAt: '2026-12-11T16:00:00Z', texto: '⚠️ CERRADO\n\n✅ AGNC 15 de enero 8 Short Put @ 50%\nCerrado a 0.30 de débito', autorJid: '34605855722@s.whatsapp.net' });
    L = libro._cargar();
    t = L.trades.find((x) => x.activo === 'AGNC');
    // cierre: recompra al ask 0.36 → 27.61 - 36 - 1.13 = -9.52
    chequear('el CLOSED cierra la posición rolada y el P&L suma entrada + roll + cierre', r.estado === 'CIERRE_DEMO' && t.pnlRealizado === -9.52, `${r.estado} ${t.pnlRealizado}`);

    // Llamada de margen: el margen usado supera el valor de la cuenta
    r = await libro.procesarAlerta({ alertId: 'G9', mensajeAt: '2026-12-11T16:01:00Z', texto: SP('AGNC', 8, 0.23, 773), autorJid: '34605855722@s.whatsapp.net' });
    margenPorOrden = 5000;
    const m = await libro.recalcularMargen();
    chequear('recalcular: si el margen de lo abierto supera el valor de la cuenta hay llamada de margen', m.llamada === true && m.usado === 5000, JSON.stringify(m));
    margenPorOrden = 10;
    r = await libro.procesarAlerta({ alertId: 'G10', mensajeAt: '2026-12-11T16:02:00Z', texto: SP('SOFI', 16, 0.46, 1554), autorJid: '5491125371038@s.whatsapp.net' });
    chequear('con llamada de margen no se abren señales nuevas', r.estado === 'RECHAZADA' && /llamada de margen/.test(r.motivo), JSON.stringify(r));

    // Rolls solo desde las 10:00 ET (cadena estable): uno publicado a las 9:45 espera y lo hace el tick de las 10:01
    reloj = new Date('2026-12-14T14:45:00Z');   // lunes 9:45 ET
    r = await libro.procesarAlerta({ alertId: 'G11', mensajeAt: '2026-12-14T14:45:00Z', texto: RUEDA, autorJid: '34605855722@s.whatsapp.net' });
    chequear('roll antes de las 10:00 ET: queda pendiente', r.estado === 'AJUSTE_PENDIENTE' && /10:00/.test(r.motivo), JSON.stringify(r));
    reloj = new Date('2026-12-14T15:01:00Z');   // 10:01 ET
    await libro.tick();
    L = libro._cargar();
    t = L.trades.find((x) => x.alertId === 'G9');
    chequear('a las 10:01 ET el tick ejecuta el roll pendiente', t.estado === 'abierta' && t.ajustes?.length === 1 && t.patas[0].sym === 'AGNC270115P00008000', `${t.estado} ${JSON.stringify(t.patas)}`);

    // Reprogramar una señal pendiente (el IC de Luis: después de las 10:00 ET)
    reloj = new Date('2026-12-14T22:00:00Z');   // lunes después del cierre
    r = await libro.procesarAlerta({ alertId: 'G12', mensajeAt: '2026-12-14T22:00:00Z', texto: SP('SOFI', 16, 0.46, 1554), autorJid: '5491125371038@s.whatsapp.net' });
    const rp = await libro.reprogramar(r.id, '2026-12-15T15:00:00Z', 'cadena estable');
    chequear('reprogramar: la pendiente queda desde las 10:00 y vence a las 10:30 ET', rp.ok && rp.venceAt === '2026-12-15T15:30:00.000Z', JSON.stringify(rp));
    reloj = new Date('2026-12-15T14:31:00Z');   // 9:31 ET
    await libro.tick();
    chequear('a las 9:31 ET la reprogramada todavía no entra', libro._cargar().trades.find((x) => x.id === r.id).estado === 'pendiente_entrada');
    reloj = new Date('2026-12-15T15:01:00Z');   // 10:01 ET
    await libro.tick();
    chequear('a las 10:01 ET la reprogramada entra', libro._cargar().trades.find((x) => x.id === r.id).estado === 'abierta');
    fsS.rmSync(dir, { recursive: true, force: true });
  })());
}

seccion('Señales Sigma: una foto con varios rolls (2026-11-19, "Gestion SOFI y MARA")');
{
  const sgG = require('../src/sigma_gestion');
  const ls = require('../src/libro_senales');
  const calS = require('../src/calendario_nyse');
  const fsS = require('fs'), osS = require('os'), pathS = require('path');
  const pata = (k, d, m, lado) => ({ tipo: 'P', strike: k, dia: d, mes: m, anio: 2026, cantidad: 1, lado, precio: null });
  const lectura = { gestiones: [
    { es_gestion: true, activo: 'SOFI', accion: 'roll', cerrar: [pata(16, 20, 11, 'vendida')], abrir: [pata(16, 18, 12, 'vendida')], neto_usd: 12 },
    { es_gestion: true, activo: 'MARA', accion: 'roll', cerrar: [pata(7, 20, 11, 'vendida')], abrir: [pata(7, 18, 12, 'vendida')], neto_usd: 41 },
  ] };
  const g = sgG.aGestiones(lectura);
  chequear('el intérprete devuelve las dos gestiones de la foto (SOFI y MARA)', g.ok && g.gestiones.length === 2 && g.gestiones[1].activo === 'MARA' && g.gestiones[1].netoPublicadoUsd === 41, JSON.stringify(g));
  chequear('el esquema pide una lista de gestiones', sgG.ESQUEMA.properties.gestiones.type === 'array');
  chequear('lectura sin gestiones = no es gestión', sgG.aGestiones({ gestiones: [] }).ok === false);
  chequear('la forma vieja (una sola gestión) se sigue aceptando', sgG.aGestiones(lectura.gestiones[0]).gestiones.length === 1);

  const dir = fsS.mkdtempSync(pathS.join(osS.tmpdir(), 'libro-senales-m-'));
  let reloj = new Date('2026-11-12T17:00:00Z');
  const Q = {
    SOFI261120P00016000: { bid: 2.30, ask: 2.36 }, SOFI261218P00016000: { bid: 2.48, ask: 2.52 },
    MARA261120P00007000: { bid: 0.70, ask: 0.72 }, MARA261218P00007000: { bid: 1.13, ask: 1.16 },
  };
  const libro = ls.crearLibroSenales({
    dataDir: dir, calendario: calS, ahora: () => reloj, capital: 10000,
    cotizar: async () => ({ q: Q }),
    dryRun: async (b) => ({ ok: true, fees: b.legs.length * 1.13, margen: 300 }),
    interpretar: async () => sgG.aGestiones(lectura),
  });
  const SP = (tk, k, cred, riesgo) => `🔔 *Alerta de Opción — Sigma Trade*\n\n📌 *${tk} — Short Put*\n\n🔴 Venta 1× Put ${k} (nov 20, 2026) @ $${cred}\n\n💰 *Crédito Neto:* $${Math.round(cred * 100)}\n\n📉 *Pérdida máx (riesgo):* $${riesgo}`;
  pruebasAsync.push((async () => {
    await libro.procesarAlerta({ alertId: 'M1', mensajeAt: '2026-11-12T16:59:00Z', texto: SP('SOFI', 16, 2.30, 1370), autorJid: '5491125371038@s.whatsapp.net' });
    await libro.procesarAlerta({ alertId: 'M2', mensajeAt: '2026-11-12T16:59:30Z', texto: SP('MARA', 7, 0.70, 630), autorJid: '5491125371038@s.whatsapp.net' });
    reloj = new Date('2026-11-19T20:58:00Z');   // jueves 15:58 ET
    const r = await libro.procesarAlerta({ alertId: 'M3', mensajeAt: '2026-11-19T20:57:00Z', texto: 'Gestion SOFI y MARA', imagenB64: 'AAAA', autorJid: '5491125371038@s.whatsapp.net' });
    const res = await libro.resumen({ marcar: false });
    const sofi = res.abiertas.find((t) => t.activo === 'SOFI'), mara = res.abiertas.find((t) => t.activo === 'MARA');
    chequear('foto con dos rolls: se aplican los dos (SOFI y MARA pasan a dic-18)',
      sofi?.patas[0].sym === 'SOFI261218P00016000' && mara?.patas[0].sym === 'MARA261218P00007000', `${r.motivo} | ${sofi?.patas[0].sym} ${mara?.patas[0].sym}`);
    chequear('el resultado detalla cada gestión', Array.isArray(r.gestiones) && r.gestiones.length === 2 && /MARA/.test(r.motivo), JSON.stringify(r));
    chequear('cada roll guarda el neto que publicó el profe', mara?.ajustes?.[0]?.netoPublicadoUsd === 41 && sofi?.ajustes?.[0]?.netoPublicadoUsd === 12);
  })());
}

seccion('Señales Sigma: SPX PM y cierres a decisión de Guillermo (2026-11-19)');
{
  const sg = require('../src/sigma_senales');
  const ls = require('../src/libro_senales');
  const dc = require('../src/decision_cierre');
  const calS = require('../src/calendario_nyse');
  const fsS = require('fs'), osS = require('os'), pathS = require('path');

  // La alerta real del IC de Luis del 19-nov: "Vencimiento PM" y fecha del tercer viernes (nov 20) → SPXW, no SPX AM.
  const IC_PM = '🔔 *Alerta de Opción — Sigma Trade*\n*Vencimiento PM* *Overnight*\n\n📌 *SPX — SPX Nov 20 7385/7395/7035/7025 Iron Condor*\n\n──────────\n🔴 Venta 1× Call 7385 (nov 20, 2026) @ $2.95\n🟢 Compra 1× Call 7395 (nov 20, 2026) @ $2.40\n🔴 Venta 1× Put 7035 (nov 20, 2026) @ $9.35\n🟢 Compra 1× Put 7025 (nov 20, 2026) @ $8.45\n\n💰 *Crédito Neto:* $145.00\n\n📉 *Pérdida máx (riesgo):* $855.00';
  let p = sg.parsearSenalSigma(IC_PM, { autorJid: '13213201370@s.whatsapp.net' });
  chequear('"Vencimiento PM" en el tercer viernes = SPXW (el IC de Luis del 19-nov)', p.ok && p.patas.every((x) => x.sym.startsWith('SPXW261120')), JSON.stringify(p.patas.map((x) => x.sym)));
  chequear('el precio de cada pata se sigue leyendo con el grupo AM/PM nuevo', p.patas[0].precio === 2.95 && p.patas[3].precio === 8.45, JSON.stringify(p.patas.map((x) => x.precio)));
  chequear('"(dic 18 AM, 2026)" sigue siendo SPX mensual', sg.parsearSenalSigma(IC_PM.replace('*Vencimiento PM* *Overnight*\n', '').replace(/\(nov 20, 2026\)/g, '(dic 18 AM, 2026)')).patas[0].sym === 'SPX261218C07385000');
  chequear('"(nov 20 PM, 2026)" en la pata = SPXW', sg.parsearSenalSigma(IC_PM.replace('*Vencimiento PM* *Overnight*\n', '').replace(/\(nov 20, 2026\)/g, '(nov 20 PM, 2026)')).patas[0].sym === 'SPXW261120C07385000');

  // Regla del 30%: solo cuando el nuestro es PEOR que el del profe
  let ev = ls.compararConProfe({ precio: 0.60, efecto: 'debito' }, -1.15);
  chequear('IC SPX: profe débito 0.60, nosotros 1.15 → 92% peor', ev.pct === 0.917 && ev.peor === 0.55, JSON.stringify(ev));
  ev = ls.compararConProfe({ precio: 0.10, efecto: 'debito' }, -0.12);
  chequear('SPY: profe 0.10, nosotros 0.12 → 20%, no llega al 30%', ev.pct === 0.2, JSON.stringify(ev));
  ev = ls.compararConProfe({ precio: 0.58, efecto: 'credito' }, 0.38);
  chequear('WMT: profe cobró 0.58, nosotros 0.38 → 34% peor', ev.pct === 0.345, JSON.stringify(ev));
  chequear('si nuestro cierre es mejor que el del profe, 0%', ls.compararConProfe({ precio: 0.71, efecto: 'credito' }, 0.80).pct === 0);

  const dir = fsS.mkdtempSync(pathS.join(osS.tmpdir(), 'libro-senales-d-'));
  let reloj = new Date('2026-11-19T19:57:54Z');   // jueves 14:57 ET
  const S = (k, t) => `SPXW261120${t}0${k}000`;
  const Q = {
    [S(7385, 'C')]: { bid: 2.90, ask: 3.00 }, [S(7395, 'C')]: { bid: 2.35, ask: 2.45 },
    [S(7035, 'P')]: { bid: 9.30, ask: 9.40 }, [S(7025, 'P')]: { bid: 8.40, ask: 8.50 },
  };
  const pedidas = [];
  const libro = ls.crearLibroSenales({
    dataDir: dir, calendario: calS, ahora: () => reloj,
    cotizar: async () => ({ q: Q }),
    dryRun: async () => ({ ok: true, fees: 6.88, margen: 1000 }),
    pedirDecision: async (t, o) => { pedidas.push({ t, ...o }); },
  });
  pruebasAsync.push((async () => {
    let r = await libro.procesarAlerta({ alertId: 'D1', mensajeAt: '2026-11-19T19:57:22Z', texto: IC_PM, autorJid: '13213201370@s.whatsapp.net' });
    chequear('el IC PM entra al demo con las patas SPXW', r.estado === 'ABIERTA', JSON.stringify(r));
    // Al cierre del profe la cadena se abrió: recomprar cuesta 1.15 (el profe cerró a 0.60)
    Object.assign(Q[S(7385, 'C')], { bid: 0.50, ask: 0.70 }); Object.assign(Q[S(7395, 'C')], { bid: 0.15, ask: 0.20 });
    Object.assign(Q[S(7035, 'P')], { bid: 0.60, ask: 0.90 }); Object.assign(Q[S(7025, 'P')], { bid: 0.30, ask: 0.40 });
    reloj = new Date('2026-11-19T20:59:13Z');
    const CIERRE = '⚠️ CERRADO\n(Compartido en 19 nov)\n\n✅ SPX Nov 20 7385/7395/7035/7025 Iron Condor @ 58.62%\nCerrado a 0.60 de débito\n\nGanancia de $85 por posición';
    r = await libro.procesarAlerta({ alertId: 'D2', mensajeAt: '2026-11-19T20:58:52Z', texto: CIERRE, autorJid: '13213201370@s.whatsapp.net' });
    let t = libro._cargar().trades[0];
    chequear('cierre 92% peor que el del profe: NO cierra, queda a decisión de Guillermo', r.estado === 'CIERRE_A_DECISION' && t.estado === 'pendiente_decision', JSON.stringify(r));
    chequear('se pide la decisión una vez, con la clave del link', pedidas.length === 1 && /^[0-9a-f]{32}$/.test(pedidas[0].clave) && !pedidas[0].t.decision.clave);
    chequear('la decisión guarda los dos precios y el P&L de cada uno', t.decision.profe === -0.6 && t.decision.nuestro === -1.15 && t.decision.pnlProfeUsd === 85, JSON.stringify(t.decision));
    const res = await libro.resumen({ marcar: false });
    chequear('la pantalla pública no muestra la clave del link', !JSON.stringify(res).includes(pedidas[0].clave) && res.decisiones.length === 1);
    chequear('el link mal firmado no ve nada', !(await libro.verDecision(t.id, 'f'.repeat(32))).ok);
    let w = await libro.tomarAvisosWs();
    chequear('la cola de WhatsApp entrega el aviso una sola vez', w.length === 1 && w[0].tipo === 'decision' && (await libro.tomarAvisosWs()).length === 0);
    const txt = dc.textoDecision(w[0].trade, dc.linkDecision('https://x.app', t.id, w[0].clave));
    chequear('el WhatsApp dice profe vs nosotros y lleva el link', /0\.60 de débito/.test(txt) && /1\.15 de débito/.test(txt) && txt.includes(`/api/libros/senales/decidir/${t.id}?c=${w[0].clave}`), txt);
    const pg = dc.paginaDecision(await libro.verDecision(t.id, pedidas[0].clave), { id: t.id, clave: pedidas[0].clave });
    chequear('la página del link trae los botones Cerrar ahora y Mantener (POST)', /method="post"/.test(pg) && /Cerrar ahora/.test(pg) && /Mantener abierta/.test(pg));
    // Tick sin decisión: no cierra solo
    reloj = new Date('2026-11-19T21:00:00Z');
    await libro.tick();
    chequear('sin clic, el tick no la cierra', libro._cargar().trades[0].estado === 'pendiente_decision');
    // Recordatorio: al día siguiente a las 15:30 ET
    reloj = new Date('2026-11-20T15:00:00Z'); await libro.tick();
    chequear('a las 10:00 ET del día siguiente todavía no recuerda', pedidas.length === 1);
    reloj = new Date('2026-11-20T20:31:00Z'); await libro.tick(); await libro.tick();
    chequear('a las 15:31 ET recuerda una sola vez (correo + WhatsApp)', pedidas.length === 2 && pedidas[1].recordatorio === true && (await libro.tomarAvisosWs()).length === 1);
    // Mantener y luego cerrar con el mismo link
    r = await libro.decidir(t.id, pedidas[0].clave, 'mantener');
    chequear('Mantener: la posición vuelve a abierta', r.ok && libro._cargar().trades[0].estado === 'abierta', JSON.stringify(r));
    r = await libro.decidir(t.id, 'a'.repeat(32), 'cerrar');
    chequear('cerrar con otra clave: rechazado', !r.ok);
    r = await libro.decidir(t.id, pedidas[0].clave, 'cerrar');
    t = libro._cargar().trades[0];
    chequear('Cerrar ahora (aunque sea peor): cierra al precio del momento', r.ok && r.estado === 'CERRADA' && t.estado === 'cerrada' && t.salida.precio === -1.15, JSON.stringify(r));
    r = await libro.decidir(t.id, pedidas[0].clave, 'cerrar');
    chequear('el link ya usado no cierra dos veces', !r.ok);

    // SPY: diferencia del 20% → cierra solo, sin preguntar
    const BPS = '🔔 *Alerta de Opción — Sigma Trade*\n\n📌 *SPY — SPY Nov 23 719/718 Bull Put Spread*\n\n🔴 Venta 1× Put 719 (nov 23, 2026) @ $3.285\n🟢 Compra 1× Put 718 (nov 23, 2026) @ $3.065\n\n💰 *Crédito Neto:* $22.00\n\n📉 *Pérdida máx (riesgo):* $78.00';
    Q.SPY261123P00719000 = { bid: 3.25, ask: 3.30 }; Q.SPY261123P00718000 = { bid: 3.05, ask: 3.07 };
    reloj = new Date('2026-11-20T15:10:00Z');
    await libro.procesarAlerta({ alertId: 'D3', mensajeAt: '2026-11-20T15:09:00Z', texto: BPS, autorJid: '13213201370@s.whatsapp.net' });
    Q.SPY261123P00719000 = { bid: 0.20, ask: 0.22 }; Q.SPY261123P00718000 = { bid: 0.10, ask: 0.12 };
    r = await libro.procesarAlerta({ alertId: 'D4', mensajeAt: '2026-11-20T16:00:00Z', texto: '⚠️ CERRADO\n\n✅ SPY Nov 23 719/718 Bull Put Spread @ 54.55%\nCerrado a 0.10 de débito\n\nGanancia de $12 por posición', autorJid: '13213201370@s.whatsapp.net' });
    chequear('diferencia de 20% (SPY): cierra solo, sin pedir decisión', r.estado === 'CIERRE_DEMO' && pedidas.length === 2, JSON.stringify(r));
    fsS.rmSync(dir, { recursive: true, force: true });
  })());
}

(async () => {
  // Pruebas de unidad asincronas (2026-11-09, ejecutor de TastyTrade): se esperan antes del resumen.
  await Promise.all(pruebasAsync);
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
