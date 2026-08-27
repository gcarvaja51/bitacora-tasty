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
