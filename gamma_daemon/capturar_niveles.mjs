// Captura de niveles por SIMBOLO y VENCIMIENTO — el registro que pidio el usuario
// el 2026-08-22: el max pain del dia y el del viernes siguiente, no solo del SPX
// sino de los activos abiertos, para buscar una regla del movimiento esperado.
//
//   node gamma_daemon/capturar_niveles.mjs              # SPX, dia + viernes
//   node gamma_daemon/capturar_niveles.mjs --todos      # + los activos abiertos
//   node gamma_daemon/capturar_niveles.mjs --simbolos NU,BA
//
// ⚠️ LA REGLA QUE MANDA SOBRE TODO LO DEMAS: al terminar, Sigma Terminal TIENE
// que quedar en SPX y en el vencimiento del dia.
//
// El daemon exige SPX y falla en cada ciclo si encuentra otra cosa ("Sigma
// Terminal no esta en SPX"). Dejarlo mal significa lunes sin muros en
// TradingView y sin niveles para las tres estrategias. Por eso la restauracion
// va en un `finally`, se VERIFICA leyendo, y si no se logra el script grita y
// sale con codigo distinto de cero.
import { ensurePage, readLevels, readExpiryChips, seleccionarExpiry,
         seleccionarSimbolo, readSymbol, close,
         pestanaAuxiliar, cerrarAuxiliar } from './sigma.js';

// EL PANEL TIENE QUE ESTAR MONTADO ANTES DE EMPEZAR (portado de
// 06_vencimiento de opciones/scripts/28_captura_sigma.mjs, 2026-08-26).
//
// Del 24 al 26-ago esta captura saco 0 de 11 en las SEIS corridas, y las seis
// murieron en menos de un minuto con "No element found for selector:
// [class*=greeks_tickerBtn__]". No era Sigma caido ni la UI rediseñada: es la
// misma carrera de arranque en frio que mato a la captura de los 69.
// `pestanaAuxiliar()` hace goto(domcontentloaded) y despues espera 8 SEGUNDOS
// FIJOS; medido el 26-ago con el perfil caliente, el panel de greeks tarda 6,8s
// en montarse, y en frio mas. Los 8s no son un margen, son una moneda al aire.
//
// Y como "No element found for selector" no lo reconocia nadie como "la pagina
// todavia no esta", el bucle lo contaba como fallo DEL SIMBOLO: quemaba los 11
// a toda velocidad y salia con codigo 1 sin haber leido nada.
//
// Se espera al panel de verdad, no a un reloj.
const SEL_PANEL       = '[class*="greeks_tickerBtn__"]';
const PANEL_SIN_MONTAR = /No element found for selector: \[class\*="greeks_(tickerBtn|expBtn)__"\]/i;
const ESPERA_PANEL    = +(process.env.ESPERA_PANEL_MS || 60000);

// Espera a que el panel de greeks exista de verdad. Si no monta, recarga la
// pestaña una vez y vuelve a esperar; si tampoco, se propaga (sin panel no hay
// nada que capturar y es mejor decirlo que devolver 11 fallos de simbolo).
async function esperarPanel(p) {
  try {
    await p.waitForSelector(SEL_PANEL, { timeout: ESPERA_PANEL });
    return;
  } catch (e) {
    console.error(`[captura] el panel de greeks no monto en ${ESPERA_PANEL / 1000}s (${e.message.slice(0, 60)}) -- recargando`);
  }
  await p.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForSelector(SEL_PANEL, { timeout: ESPERA_PANEL });
  console.log('[captura] el panel monto tras recargar');
}

const PROD = process.env.PROD_BASE || 'https://web-production-23473.up.railway.app';
const args = process.argv.slice(2);
const TODOS = args.includes('--todos');
const iSim = args.indexOf('--simbolos');
const SIMBOLOS_ARG = iSim >= 0 ? (args[iSim + 1] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : [];

let fallos = 0;

async function underlyingsAbiertos() {
  try {
    const r = await fetch(`${PROD}/api/overview`);
    const d = await r.json();
    const u = new Set();
    for (const p of d.positions || []) {
      const s = p['underlying-symbol'] || p.underlyingSymbol || p.symbol;
      if (s) u.add(String(s).toUpperCase());
    }
    return [...u];
  } catch (e) {
    console.error('[captura] no se pudieron leer las posiciones abiertas:', e.message);
    return [];
  }
}

// El viernes siguiente entre los chips disponibles. Si hoy ES viernes, se toma
// el de la semana que viene: el del dia ya lo cubre la lectura normal.
function chipDelViernes(chips, hoy = new Date()) {
  const candidatos = chips
    .map(c => {
      const d = new Date(hoy);
      d.setDate(d.getDate() + c.dte);
      return { ...c, fecha: d, esViernes: d.getDay() === 5 };
    })
    .filter(c => c.esViernes && c.dte > 0)
    .sort((a, b) => a.dte - b.dte);
  return candidatos[0] || null;
}

async function guardar(symbol, levels, dte) {
  const r = await fetch(`${PROD}/api/spx/niveles-historicos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, expiry: levels.expiry, dte, levels,
                           capturadoEn: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`POST devolvio ${r.status}`);
  console.log(`   guardado  ${symbol.padEnd(6)} exp=${levels.expiry}  maxPain=${levels.maxPain}  MVS=${levels.mvs}  cw=${levels.callWall}  pw=${levels.putWall}`);
}

// Lee los niveles DE ESTA pestana y se niega a devolverlos si el panel no esta
// mostrando el simbolo que se pidio.
//
// El 26-ago se guardaron nueve filas con los niveles del SPX bajo el nombre de
// otros tickers: readLevels leia de la pestana PRINCIPAL mientras el cambio de
// simbolo pasaba en la AUXILIAR. Ya esta arreglado de raiz (readLevels recibe la
// pagina), pero la comprobacion se queda: el dia que algo vuelva a desalinear la
// lectura, esto lo convierte en un fallo ruidoso en vez de en dato falso, que es
// lo unico que no se puede detectar despues.
async function nivelesVerificados(p, symbol) {
  const antes = await readSymbol(p);
  if (!antes || antes.toUpperCase() !== symbol.toUpperCase()) {
    throw new Error(`el panel muestra "${antes}" y se pidio "${symbol}" -- no se guarda`);
  }
  const lv = await readLevels({ exigirSPX: false, pagina: p });
  const despues = await readSymbol(p);
  if (!despues || despues.toUpperCase() !== symbol.toUpperCase()) {
    throw new Error(`el simbolo cambio a "${despues}" durante la lectura de "${symbol}" -- no se guarda`);
  }
  return lv;
}

async function capturarSimbolo(p, symbol) {
  console.log(`\n[${symbol}]`);
  if (symbol !== 'SPX') {
    await seleccionarSimbolo(p, symbol);
  }
  const chips = await readExpiryChips(p);
  const activo = chips.find(c => c.activo);

  // 1. El vencimiento del dia (el que ya esta activo).
  const hoy = await nivelesVerificados(p, symbol);
  await guardar(symbol, hoy, activo?.dte ?? null);

  // 2. El viernes siguiente.
  const vie = chipDelViernes(chips);
  if (!vie) {
    console.log('   (sin chip de viernes disponible)');
  } else if (activo && vie.etiqueta === activo.etiqueta) {
    console.log('   (el vencimiento del dia YA es el viernes: no se duplica)');
  } else {
    await seleccionarExpiry(p, vie.etiqueta);
    const lv = await nivelesVerificados(p, symbol);
    await guardar(symbol, lv, vie.dte);
    if (activo) await seleccionarExpiry(p, activo.etiqueta);   // volver al del dia
  }
}

// PESTAÑA PROPIA, NO la del daemon (2026-08-25).
//
// Antes esto corria sobre `ensurePage()` -- la misma pestaña que el daemon usa
// para leer SPX cada 2 min. Rotar 11 simbolos ahi dejaba al daemon leyendo el
// ticker equivocado o saltandose ciclos, y si la captura moria a mitad el
// terminal se quedaba en otro simbolo hasta que alguien lo arreglara a mano.
// Paso el 25-ago: la captura fallo a las 15:40 y el historico de muros se corto
// a las 10:57 -- media sesion perdida.
//
// Sigma mantiene el simbolo independiente por pestaña (verificado ese dia), asi
// que con una pestaña propia el daemon ni se entera. Y por eso la restauracion
// de abajo ya no es critica: aunque falle, la pestaña se cierra y se la lleva
// puesta.
const p = await pestanaAuxiliar();
try {
  // Antes de tocar nada: que el panel exista. Los 8s fijos de pestanaAuxiliar()
  // no alcanzan en frio, y arrancar sin panel es lo que producia los 0 de 11.
  await esperarPanel(p);
  const lista = SIMBOLOS_ARG.length ? SIMBOLOS_ARG
              : TODOS ? ['SPX', ...(await underlyingsAbiertos()).filter(s => s !== 'SPX')]
              : ['SPX'];
  console.log('a capturar:', lista.join(', '));
  for (const s of lista) {
    try { await capturarSimbolo(p, s); }
    catch (e) {
      // "selector no encontrado" sobre los elementos ESTRUCTURALES del panel no
      // es "este simbolo no existe", es "la pagina todavia no esta". Se espera al
      // panel y se reintenta UNA vez antes de darlo por perdido; asi un arranque
      // lento cuesta un reintento y no la lista entera.
      if (PANEL_SIN_MONTAR.test(e.message)) {
        console.error(`   ${s}: el panel no estaba montado -- esperandolo y reintentando`);
        try {
          await esperarPanel(p);
          await capturarSimbolo(p, s);
          continue;
        } catch (e2) {
          fallos++; console.error(`   FALLO ${s}: ${e2.message}`);
          continue;
        }
      }
      fallos++; console.error(`   FALLO ${s}: ${e.message}`);
    }
  }
} finally {
  // ── RESTAURACION (ya NO es critica: la pestaña es de usar y tirar) ──────
  let restaurado = false;
  for (let i = 1; i <= 3 && !restaurado; i++) {
    try {
      const sim = await readSymbol(p);
      if (!/^SPX$/i.test(sim || '')) await seleccionarSimbolo(p, 'SPX');
      const chips = await readExpiryChips(p);
      const primero = chips[0];                       // el mas cercano = el del dia
      if (primero && !primero.activo) await seleccionarExpiry(p, primero.etiqueta);
      const final = await readSymbol(p);
      restaurado = /^SPX$/i.test(final || '');
    } catch (e) {
      console.error(`[captura] intento ${i} de restaurar fallo: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (restaurado) {
    console.log('\n[captura] Sigma restaurado a SPX + vencimiento del dia');
  } else {
    // Ya NO es fatal. Antes esto dejaba la pestaña del DAEMON en otro simbolo y
    // habia que arreglarlo a mano (paso el 25-ago: media sesion de muros
    // perdida). Ahora la pestaña es de usar y tirar: como mucho se cierra sucia
    // y no afecta a nadie. Se avisa, sin penalizar el codigo de salida.
    console.warn('\n[captura] no se pudo devolver la pestaña auxiliar a SPX;');
    console.warn('[captura] no importa: se cierra igual y el daemon no se entera.');
  }
  // Cerrar SOLO la pestaña auxiliar. NUNCA close(), que cierra el navegador
  // ENTERO y se llevaria por delante la pestaña del daemon -- dejandolo sin
  // lecturas hasta el siguiente arranque.
  await cerrarAuxiliar(p);
}

process.exit(fallos ? 1 : 0);
