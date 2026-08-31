/**
 * PERFIL DE GEX POR STRIKE -- captura y persistencia
 * ==================================================
 *
 * POR QUE EXISTE (2026-08-25)
 * ---------------------------
 * Guillermo observo que el 25-ago el strike 7665 acumulo mas de 5 B de GEX todo
 * el dia, en momentos 2x el resto, y que ESA es la ventaja estadistica para
 * centrar un butterfly -- no donde anduvo el precio.
 *
 * Al ir a validarlo aparecio el problema: NO HAY HISTORICO. `calcGEX` calcula
 * `gexByStrike` y el monitor lo pinta, pero se descarta. `spx_strategy_log.json`
 * guarda solo agregados (callWall, putWall, gammaFlip, maxPain) -- que strike es
 * el muro, nunca CUANTO GEX tiene. Y esa magnitud es justo lo que distingue un
 * dia de pin de verdad de un dia simplemente tranquilo.
 *
 * Este script arranca esa serie. Cada corrida anade una linea a un JSONL con el
 * perfil completo y sus medidas de dominancia.
 *
 * NOTA que confirmo Guillermo y conviene tener presente al leer los datos:
 *   el Call Wall ES el strike de mayor GEX en CALLS
 *   el Put Wall  ES el strike de mayor GEX en PUTS
 * Verificado contra la cadena real del 25-ago 12:02 ET: pico de calls 7665
 * (4,06 B) = Call Wall que reportaba el daemon; pico de puts 7650 (1,60 B) =
 * Put Wall. Asi que estas columnas son comparables con el historico de muros que
 * ya existe, solo que ademas traen la magnitud.
 *
 * Uso:
 *   node gex_perfil.cjs                    # captura y anade al historico
 *   node gex_perfil.cjs --expiry AAAA-MM-DD
 *   node gex_perfil.cjs --resumen          # lee lo acumulado
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = path.join('C:', 'Users', 'gcarv', 'Documents', 'CARPETA PERSONAL',
  '01. guillermo carvajal', '01_Sigma', 'mentoria alejandro',
  'premercados alejandro', 'control premercado');
const DIR_CADENAS = path.join(BASE, 'neutrales', 'cadenas');
const HIST = path.join(BASE, 'neutrales', 'gex_perfil_historico.jsonl');

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const hoyET = () => new Intl.DateTimeFormat('en-CA',
  { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** GEX por strike en dolares por 1% de movimiento. */
function perfil(snap) {
  const S = snap.spot;
  return snap.filas.map(f => {
    const c = f.call || {}, p = f.put || {};
    const cg = (c.gamma || 0) * (c.oi || 0) * 100 * S * S * 0.01;
    const pg = (p.gamma || 0) * (p.oi || 0) * 100 * S * S * 0.01;
    return { strike: f.strike, gexCall: cg, gexPut: pg, gex: cg + pg,
             oiCall: c.oi || 0, oiPut: p.oi || 0 };
  });
}

function resumir(snap) {
  const P = perfil(snap);
  if (!P.length) return null;
  const porTotal = [...P].sort((a, b) => b.gex - a.gex);
  const porCall = [...P].sort((a, b) => b.gexCall - a.gexCall);
  const porPut = [...P].sort((a, b) => b.gexPut - a.gexPut);
  const vals = P.map(x => x.gex).sort((a, b) => a - b);
  const mediana = vals[Math.floor(vals.length / 2)] || 0;
  const pico = porTotal[0], segundo = porTotal[1] || { gex: 0 };
  return {
    ts: new Date().toISOString(),
    fechaET: snap.fechaET || hoyET(),
    horaET: snap.horaET,
    expiry: snap.expiry,
    spot: snap.spot,
    // El pico total y CUANTO domina -- esto es lo que no existia.
    picoStrike: pico.strike,
    picoGex: +(pico.gex / 1e9).toFixed(3),
    dominanciaSegundo: segundo.gex > 0 ? +(pico.gex / segundo.gex).toFixed(2) : null,
    dominanciaMediana: mediana > 0 ? +(pico.gex / mediana).toFixed(2) : null,
    distPicoSpot: +(pico.strike - snap.spot).toFixed(2),
    // Muros = picos por lado (regla de Guillermo, verificada 2026-08-25).
    callWall: porCall[0].strike,
    callWallGex: +(porCall[0].gexCall / 1e9).toFixed(3),
    putWall: porPut[0].strike,
    putWallGex: +(porPut[0].gexPut / 1e9).toFixed(3),
    gexTotal: +(P.reduce((a, b) => a + b.gex, 0) / 1e9).toFixed(3),
    // Dominancia POR LADO -- es la comparativa del 2x que pidio Guillermo:
    // cuanto GEX tiene el muro frente al SIGUIENTE strike del mismo lado.
    callWall2x: porCall[1] && porCall[1].gexCall > 0
      ? +(porCall[0].gexCall / porCall[1].gexCall).toFixed(2) : null,
    callWallSegundo: porCall[1] ? porCall[1].strike : null,
    putWall2x: porPut[1] && porPut[1].gexPut > 0
      ? +(porPut[0].gexPut / porPut[1].gexPut).toFixed(2) : null,
    putWallSegundo: porPut[1] ? porPut[1].strike : null,
    // 20 STRIKES ALREDEDOR DEL SPOT, en DOLARES, ordenados por strike.
    //
    // Pedido de Guillermo (2026-08-25) para poder analizar la regla del 2x. Tres
    // decisiones deliberadas:
    //   - 20 y no el perfil entero: a 5 min durante meses el perfil completo son
    //     cientos de MB. 20 strikes (+-50 pts con el paso de 5) cubren de sobra
    //     donde viven los muros -- el 25-ago el call wall estaba a 27 pts del
    //     spot.
    //   - Ordenados POR STRIKE, no por GEX: asi se conserva la FORMA del perfil.
    //     Ordenado por GEX se pierde saber si el pico esta aislado o rodeado de
    //     strikes gordos, que es justo lo que distingue un muro de verdad.
    //   - En DOLARES enteros, no en miles de millones: sin redondeos que
    //     estropeen un ratio cuando los dos strikes son pequeños.
    strikes: P.slice()
      .sort((a, b) => Math.abs(a.strike - snap.spot) - Math.abs(b.strike - snap.spot))
      .slice(0, 20)
      .sort((a, b) => a.strike - b.strike)
      .map(x => ({ k: x.strike,
                   c: Math.round(x.gexCall), p: Math.round(x.gexPut),
                   oiC: x.oiCall, oiP: x.oiPut })),
  };
}

function ultimaCadena(expiry) {
  const tag = expiry.replace(/-/g, '');
  let mejor = null;
  try {
    for (const f of fs.readdirSync(DIR_CADENAS)) {
      if (!f.startsWith(`spx_0dte_${tag}`)) continue;
      const p = path.join(DIR_CADENAS, f), st = fs.statSync(p);
      if (!mejor || st.mtimeMs > mejor.mtimeMs) mejor = { p, mtimeMs: st.mtimeMs };
    }
  } catch (e) { /* no existe aun */ }
  return mejor;
}

if (process.argv.includes('--resumen')) {
  if (!fs.existsSync(HIST)) { console.log('todavia no hay historico'); process.exit(0); }
  const L = fs.readFileSync(HIST, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  console.log(`capturas: ${L.length}   dias: ${new Set(L.map(x => x.fechaET)).size}`);
  console.log();
  console.log(`${'fecha'.padEnd(11)} ${'hora'.padEnd(6)} ${'spot'.padStart(9)} ${'pico'.padStart(7)} ` +
              `${'GEX B'.padStart(7)} ${'domMed'.padStart(7)} ${'CallW'.padStart(7)} ${'PutW'.padStart(7)}`);
  for (const r of L.slice(-40)) {
    console.log(`${r.fechaET.padEnd(11)} ${String(r.horaET).padEnd(6)} ${r.spot.toFixed(2).padStart(9)} ` +
                `${String(r.picoStrike).padStart(7)} ${String(r.picoGex).padStart(7)} ` +
                `${String(r.dominanciaMediana).padStart(7)} ${String(r.callWall).padStart(7)} ` +
                `${String(r.putWall).padStart(7)}`);
  }
  process.exit(0);
}

// ---- modo bucle: captura cada N minutos mientras el mercado este abierto ----
if (process.argv.includes('--loop')) {
  const cadaMin = parseFloat(arg('cada', '5'));
  const horaDec = () => {
    const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York',
      hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).split(':').map(Number);
    return h + m / 60;
  };
  const { spawnSync } = require('child_process');
  console.log(`[loop] capturando cada ${cadaMin} min hasta las 16:05 ET`);
  const tick = () => {
    const h = horaDec();
    if (h >= 16.09) { console.log('[loop] cierre de mercado, fin'); process.exit(0); }
    if (h >= 9.5) {
      const r = spawnSync(process.execPath, [__filename], { stdio: 'inherit' });
      if (r.status !== 0) console.error('[loop] la captura fallo, se sigue');
    } else {
      console.log('[loop] antes de la apertura, esperando');
    }
  };
  tick();
  setInterval(tick, cadaMin * 60 * 1000);
  return;
}

const expiry = arg('expiry', hoyET());
let c = ultimaCadena(expiry);
const edadMin = c ? (Date.now() - c.mtimeMs) / 60000 : Infinity;
if (!c || edadMin > 5) {
  console.log(`[cadena] capturando ${expiry}...`);
  execFileSync(process.execPath,
    [path.join(__dirname, 'capturar_cadena_0dte.cjs'), '--expiry', expiry, '--rango', '80'],
    { stdio: 'inherit' });
  c = ultimaCadena(expiry);
}
if (!c) { console.error('[FALLO] sin cadena'); process.exit(2); }

const snap = JSON.parse(fs.readFileSync(c.p, 'utf8'));
const r = resumir(snap);
if (!r) { console.error('[FALLO] perfil vacio'); process.exit(2); }

fs.mkdirSync(path.dirname(HIST), { recursive: true });
fs.appendFileSync(HIST, JSON.stringify(r) + '\n');

console.log(`${r.fechaET} ${r.horaET} ET   SPX ${r.spot}   exp ${r.expiry}`);
console.log(`  pico GEX      : ${r.picoStrike}  con ${r.picoGex} B`);
console.log(`  dominancia    : ${r.dominanciaSegundo}x sobre el 2o   |   ${r.dominanciaMediana}x sobre la mediana`);
console.log(`  distancia spot: ${r.distPicoSpot > 0 ? '+' : ''}${r.distPicoSpot} pts`);
console.log(`  Call Wall     : ${r.callWall} (${r.callWallGex} B)   ${r.callWall2x}x sobre ${r.callWallSegundo}`);
console.log(`  Put Wall      : ${r.putWall} (${r.putWallGex} B)   ${r.putWall2x}x sobre ${r.putWallSegundo}`);
console.log(`  strikes guardados: ${r.strikes.length} (${r.strikes[0].k} a ${r.strikes[r.strikes.length-1].k})`);
const cerca = r.strikes.filter(x => Math.abs(x.k - r.spot) <= 20);
console.log(`  perfil cerca del spot (call / put, en M USD):`);
for (const x of cerca) {
  console.log(`     ${x.k}  call ${(x.c/1e6).toFixed(0).padStart(6)}  put ${(x.p/1e6).toFixed(0).padStart(6)}` +
              (x.k === r.callWall ? '   <- CALL WALL' : '') + (x.k === r.putWall ? '   <- PUT WALL' : ''));
}
console.log(`[hist] -> ${HIST}`);
