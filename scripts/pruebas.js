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

(async () => {
  if (LOCAL) await conServidorLocal(base => humo(base));
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
