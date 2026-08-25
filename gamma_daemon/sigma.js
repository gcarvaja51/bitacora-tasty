// Scraping de Sigma Terminal via un Chromium dedicado con perfil persistente propio
// (login manual una sola vez, sesion guardada en sigma_profile/, gitignored). Selectores
// CSS calibrados en vivo el 2026-07-30 contra la pagina real -- son clases de CSS Modules
// con sufijo hasheado (ej. "greeks_metricCard__GHfHB"), por eso se usa [class*="prefijo__"]
// en vez del nombre completo: sobrevive a que el hash cambie en un redeploy de Sigma
// Terminal, pero si el prefijo mismo cambia (rediseño real de la UI) esto se rompe y hace
// falta recalibrar a mano -- limitacion conocida y aceptada (ver diseño del daemon).
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Perfil de Chromium. Por defecto el del daemon; SIGMA_PROFILE_DIR deja que otro
// proceso use este modulo con un perfil PROPIO y no se peleen (2026-08-24).
//
// POR QUE. limpiarChromiumHuerfano() mata el Chromium que retiene el perfil antes de
// lanzar. Con un solo perfil, la captura de la watchlist "arroz en bajo" y el daemon
// se mataban mutuamente: el 24-ago a las 12:00 ET la captura murio con
// "TargetCloseError: Protocol error (Page.navigate): Target closed" — el primer dia
// que corrio en horario de mercado, cuando el daemon cicla cada 2 minutos.
//
// El daemon no pasa la variable, asi que su comportamiento no cambia en nada.
//
// AVISO: el filtro de limpiarChromiumHuerfano() compara por SUBCADENA contra el
// ultimo segmento de la ruta. Un perfil llamado "sigma_profile_algo" lo mataria el
// filtro del daemon ('*sigma_profile*'). Cualquier perfil alternativo debe tener un
// nombre que NO contenga "sigma_profile" — el de la captura se llama "captura_profile".
const PROFILE_DIR = process.env.SIGMA_PROFILE_DIR || path.join(__dirname, 'sigma_profile');
const TERMINAL_URL = 'https://web.sigma.trade/terminal/?tab=greeks';

// El panel de Greeks Exposure expone DOCE metricas; se leian ocho (2026-08-09).
// Las cuatro que faltaban:
//   Total Gamma  — |calls|+|puts|, lo que Luis llama "gama absoluto" y dice
//                  preferir sobre el neto ("el strike con mayor gama total es la
//                  zona de atraccion, el iman del precio").
//   Max Pain     — nivel de maximo dolor, contexto hacia el cierre.
//   P/C (OI)     — put/call ratio por open interest, sesgo del posicionamiento.
//   IV Promedio  — volatilidad implicita ATM de la cadena del SPX. Es la que mas
//                  falta hacia: hoy los spreads se valuan con el VIX, que es del
//                  indice entero y no de la cadena que realmente se opera.
//
// 2026-08-22 — DOS CAMBIOS, y el segundo evito un apagon el lunes.
//
// 1) ALIAS. Sigma renombro "IV Promedio" a "Average IV" durante el fin de
//    semana: el viernes a las 20:05 la lectura entro normal y el sabado el panel
//    ya decia otra cosa. Cada etiqueta acepta ahora varios nombres.
//
// 2) OBLIGATORIAS vs OPCIONALES. Antes CUALQUIER etiqueta faltante tumbaba la
//    lectura completa. O sea que el rename de una metrica que NINGUNA estrategia
//    usa habria dejado el lunes sin muros, sin gamma flip y sin max pain — el
//    daemon fallando en cada ciclo por un dato decorativo.
//
//    Ahora solo abortan las que de verdad deciden. Si falta una opcional se
//    avisa por stderr y la lectura sigue: es mejor operar sin la IV promedio que
//    no operar.
const LABEL_MAP = {
  // El spot lleva el ticker en la etiqueta: 'Spot SPX', 'Spot NFLX'. Con el
  // capturador recorriendo otros activos, un alias fijo solo servia para SPX.
  spxPrice:   { alias: ['Spot SPX'], prefijo: 'Spot', obligatoria: true },
  netGex:     { alias: ['Net GEX'], obligatoria: true },
  gammaFlip:  { alias: ['Gamma Flip'], obligatoria: true },
  maxPain:    { alias: ['Max Pain'], obligatoria: true },
  putWall:    { alias: ['Put Wall'], obligatoria: true },
  callWall:   { alias: ['Call Wall'], obligatoria: true },
  mvs:        { alias: ['MVS'], obligatoria: true },
  // De aca abajo: se guardan para poder medirlas, pero ninguna estrategia
  // decide con ellas todavia. Que falte una no puede costar una sesion.
  totalGamma: { alias: ['Total Gamma'], obligatoria: false },
  netDex:     { alias: ['Net DEX'], obligatoria: false },
  netVanna:   { alias: ['Net Vanna'], obligatoria: false },
  putCallOi:  { alias: ['P/C (OI)', 'P/C (OI) '], obligatoria: false },
  ivPromedio: { alias: ['IV Promedio', 'Average IV', 'Avg IV'], obligatoria: false },
};

let browser = null;
let page = null;

// Mata los Chromium que esten reteniendo el perfil del daemon. Solo esos: el
// filtro va contra la ruta del userDataDir, que aparece en la linea de comando.
// Nunca toca el Chrome del usuario ni ninguna otra instancia.
function limpiarChromiumHuerfano() {
  try {
    const ruta = PROFILE_DIR.replace(/\\/g, '\\\\');
    const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" `
      + `| Where-Object { $_.CommandLine -like '*${PROFILE_DIR.split(path.sep).pop()}*' } `
      + `| ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
                 { timeout: 20000, stdio: 'ignore' });
    // SingletonLock/SingletonCookie sobreviven a un kill y bloquean el arranque
    // siguiente igual que el proceso vivo.
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { fs.rmSync(path.join(PROFILE_DIR, f), { force: true }); } catch { /* noop */ }
    }
    // A stderr, no a stdout: hay scripts que consumen la salida de este modulo
    // como JSON puro (ver velas_trade.mjs del skill informe-trade) y un
    // diagnostico en stdout les rompe el parseo.
    console.error('[sigma] perfil liberado antes de lanzar');
  } catch (e) {
    // Que falle la limpieza no puede impedir el intento de lanzar.
    console.warn('[sigma] no se pudo limpiar el perfil (%s) -- se intenta lanzar igual', e.message);
  }
}

// Token del proxy de datos de Sigma (ver readCandles5m). No esta en localStorage
// ni embebido en el bundle: solo viaja en la cabecera `authorization` de las
// llamadas que hace la propia pagina. Se captura al vuelo. Medido el 2026-08-09:
// la pestaña de greeks —la que el daemon deja abierta— lo re-emite sola 8 veces
// en 75s (/health/sources y /gex/snapshot/SPX), asi que no hace falta navegar a
// ningun lado ni cablear la clave en el codigo.
let apiToken = null;
let listenerPuesto = null;   // la pagina a la que ya se le engancho el listener

function engancharCapturaToken(p) {
  if (listenerPuesto === p) return;
  listenerPuesto = p;
  p.on('request', (r) => {
    if (!r.url().includes('opcionsigma.com')) return;
    const a = r.headers()['authorization'];
    if (a) apiToken = a;
  });
}

export async function ensurePage() {
  // isClosed() NO alcanza: una pagina puede quedar con su frame "detached"
  // (renderer recargado/navegado por fuera) y seguir reportando isClosed()
  // === false -- ahi cada evaluate() tira "Attempted to use detached Frame" y
  // el daemon se queda reintentando con la misma referencia rota para siempre.
  // Caso real: 2026-08-03, el daemon acumulo fallos consecutivos toda la
  // apertura sin recuperarse solo. Se prueba la pagina con un evaluate()
  // trivial; si falla, se descarta y se reconstruye.
  if (browser && page && !page.isClosed()) {
    try {
      await page.evaluate(() => true);
      engancharCapturaToken(page);
      return page;
    } catch (e) {
      console.error('[sigma] Pagina cacheada invalida (%s) -- reconstruyendo', e.message);
      try { await page.close(); } catch { /* noop */ }
      page = null;
      // Si el browser sigue vivo, se reusa abriendo una pestaña nueva (mas
      // barato que relanzar Chrome y re-loguear).
      if (browser && browser.connected) {
        try {
          page = await browser.newPage();
          await page.goto(TERMINAL_URL, { waitUntil: 'domcontentloaded' });
          await new Promise((r) => setTimeout(r, 6000));
          engancharCapturaToken(page);
          return page;
        } catch (e2) {
          console.error('[sigma] No se pudo abrir pestaña nueva (%s) -- relanzando browser', e2.message);
          try { await browser.close(); } catch { /* noop */ }
          browser = null;
          page = null;
        }
      } else {
        browser = null;
      }
    }
  }
  // Antes de lanzar: matar cualquier Chromium que este reteniendo ESTE perfil.
  //
  // El 2026-08-10 el daemon perdio el dia entero por esto. A las 09:32
  // puppeteer.launch() supero los 30s esperando el WS endpoint y se dio por
  // vencido — pero el navegador SI habia arrancado. Quedo huerfano tomando el
  // perfil, y los 40 intentos siguientes fallaron todos con el mismo timeout,
  // porque un userDataDir no admite dos instancias. Resultado: cero lecturas de
  // Sigma en toda la sesion, con las tres estrategias corriendo en respaldo.
  //
  // El filtro es por la RUTA DEL PERFIL, no por nombre de proceso: matar
  // "chrome.exe" a secas se llevaria por delante el navegador del usuario.
  limpiarChromiumHuerfano();

  // HEADLESS (2026-08-11, a pedido del usuario: "hay algo que es un flasheo del
  // sigma terminal... se abre y molesta cada 2 o 3 minutos").
  //
  // Con headless:false + --start-maximized, cada ciclo del daemon abria una
  // ventana de Chromium a pantalla completa, leia, y la cerraba. Como el ciclo
  // es de ~2 min, eso es una ventana robando el foco cada 2 min durante toda la
  // sesion de mercado — encima de la pantalla donde se opera.
  //
  // Un intento anterior de headless fallo con "Timed out waiting for the WS
  // endpoint" y parecio que headless no servia. NO era eso: el perfil estaba
  // tomado por un Chromium huerfano. Con el perfil libre lanza en ~16s y la
  // sesion del perfil sigue siendo valida (verificado: web.sigma.trade carga sin
  // pedir login).
  //
  // SIGMA_HEADFUL=1 devuelve la ventana visible, para depurar a ojo cuando haga
  // falta ver que esta mostrando la pagina.
  const headful = process.env.SIGMA_HEADFUL === '1';
  browser = await puppeteer.launch({
    headless: headful ? false : 'new',
    userDataDir: PROFILE_DIR,
    // --start-maximized solo tiene sentido con ventana; headless necesita que el
    // tamano se declare, o el layout se renderiza angosto y los paneles del
    // terminal no llegan a montarse.
    args: headful ? ['--start-maximized'] : ['--window-size=1920,1080', '--no-first-run', '--no-default-browser-check'],
    defaultViewport: headful ? null : { width: 1920, height: 1080 },
    // 30s (el default) resulto ser justo cuando el perfil viene de un cierre
    // sucio y Chromium tiene que recuperarlo al arrancar.
    timeout: 90000,
  });
  const pages = await browser.pages();
  page = pages[0] || (await browser.newPage());
  engancharCapturaToken(page);
  await page.goto(TERMINAL_URL, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 6000));
  return page;
}

function parseMoney(str) {
  if (str == null) return null;
  const s = String(str).replace(/,/g, '').trim();
  const m = s.match(/(-)?\$?(-)?([\d.]+)\s*(B|M|K)?/i);
  if (!m) return null;
  const neg = !!(m[1] || m[2]);
  let num = parseFloat(m[3]);
  if (Number.isNaN(num)) return null;
  const suffix = (m[4] || '').toUpperCase();
  if (suffix === 'B') num *= 1e9;
  else if (suffix === 'M') num *= 1e6;
  else if (suffix === 'K') num *= 1e3;
  return neg ? -num : num;
}

export async function readSymbol(p) {
  return p.evaluate(() => {
    const el = document.querySelector('[class*="greeks_sym__"]');
    return el ? el.textContent.trim() : null;
  });
}

// El toggle "MVS Neto" / "MVS Abs" (seccion del grafico "Net GEX por strike")
// tambien controla el valor de la tarjeta principal "MVS" -- confirmado en vivo
// el 2026-07-31 (Neto y Abs dieron strikes distintos, 7400 vs 7450). A pedido
// del usuario se usa SIEMPRE el Absoluto -- se fuerza el click en cada lectura
// en vez de confiar en que el toggle haya quedado asi (puede resetear solo en
// un reload de la pagina, o si el usuario clickea el otro modo a mano mirando
// el chart).
async function ensureMvsAbsolute(p) {
  await p.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'MVS Abs');
    if (btn && !btn.className.includes('active')) btn.click();
  });
  await new Promise((r) => setTimeout(r, 500));
}

async function readRawMetrics(p) {
  return p.evaluate(() => {
    const cards = document.querySelectorAll('[class*="greeks_metricCard__"]');
    const out = {};
    for (const card of cards) {
      const labelEl = card.querySelector('[class*="greeks_metricLabel__"]');
      const valueEl = card.querySelector('[class*="greeks_metricValue__"]');
      if (!labelEl || !valueEl) continue;
      const textNode = Array.from(labelEl.childNodes).find((n) => n.nodeType === 3);
      const label = (textNode ? textNode.textContent : labelEl.textContent).trim();
      out[label] = valueEl.textContent.trim();
    }
    return out;
  });
}

// No intenta autocorregir el simbolo (a diferencia del agente viejo, que sabia clickear
// el dropdown de FAVORITOS) -- si el usuario cambio el activo en Sigma Terminal, se
// prefiere fallar con un error claro antes que simular UI a ciegas sin poder confirmar
// visualmente el resultado. Recalibrar/ampliar esto si se vuelve frecuente en la practica.
// ── El VENCIMIENTO al que pertenece la lectura (2026-08-22) ────────────────
//
// Hasta hoy el daemon leia los 12 numeros del panel y los mandaba sin decir de
// que expiracion eran. El panel SIEMPRE muestra uno concreto —lo rotula como
// "SPX — Exp 2026-08-24"— y los chips de arriba permiten cambiarlo.
//
// Sin ese dato, un max pain guardado es inservible para analisis: el 21-ago la
// serie de la semana (7755, 7755, 7725, 7720, 7675) podia ser el max pain del
// vencimiento del viernes migrando dia a dia, o el 0DTE de cada jornada, y no
// habia forma de distinguirlo. Son dos cosas distintas y solo una sostiene un
// setup.
async function readExpiry(p) {
  return p.evaluate(() => {
    const txt = (e) => (e && e.textContent || '').trim().replace(/\s+/g, ' ');
    // "SPX — Exp 2026-08-24" en el subtitulo de un panel.
    for (const el of document.querySelectorAll('[class*="greeks_panelSub__"]')) {
      const m = txt(el).match(/Exp\s+(\d{4}-\d{2}-\d{2})/);
      if (m) return m[1];
    }
    return null;
  });
}

// Los chips de vencimiento: [{ etiqueta: "28 (6d)", dia: 28, dte: 6, activo }]
export async function readExpiryChips(p) {
  return p.evaluate(() => {
    const out = [];
    for (const b of document.querySelectorAll('[class*="greeks_expBtn__"]')) {
      const t = (b.textContent || '').trim().replace(/\s+/g, ' ');
      const m = t.match(/^(\d{1,2})\s*\((\d+)d\)$/);
      if (!m) continue;
      out.push({ etiqueta: t, dia: +m[1], dte: +m[2],
                 activo: /greeks_active__/.test(b.className || '') });
    }
    return out;
  });
}

// Cambia de vencimiento y ESPERA a que el panel confirme el cambio.
// Devuelve la fecha nueva, o lanza si no cambio: un click que no toma efecto
// dejaria leyendo el vencimiento anterior y creyendo que es otro, que es peor
// que no leer nada.
export async function seleccionarExpiry(p, etiqueta) {
  const antes = await readExpiry(p);
  const ok = await p.evaluate((et) => {
    for (const b of document.querySelectorAll('[class*="greeks_expBtn__"]')) {
      if ((b.textContent || '').trim().replace(/\s+/g, ' ') === et) { b.click(); return true; }
    }
    return false;
  }, etiqueta);
  if (!ok) throw new Error(`no existe el chip de vencimiento "${etiqueta}"`);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const ahora = await readExpiry(p);
    if (ahora && ahora !== antes) return ahora;
  }
  throw new Error(`el panel no cambio de vencimiento tras clickear "${etiqueta}" (seguia en ${antes})`);
}

// Cambia el simbolo del panel. Sigma no tiene lista fija: hay un buscador
// ("Search symbol (e.g. GOOG, PLTR, COIN...)"), asi que se abre el desplegable,
// se escribe el ticker y se toma el primer resultado.
//
// Verifica el cambio leyendo: un click que no toma efecto dejaria leyendo el
// simbolo anterior y guardandolo con el nombre nuevo, que es peor que fallar.
export async function seleccionarSimbolo(p, ticker) {
  const actual = await readSymbol(p);
  if (actual && actual.toUpperCase() === ticker.toUpperCase()) return actual;

  await p.click('[class*="greeks_tickerBtn__"]');
  await new Promise((r) => setTimeout(r, 1200));

  const campo = await p.$('input[placeholder*="Search symbol"]');
  if (!campo) throw new Error('no aparecio el buscador de simbolo tras abrir el desplegable');
  await campo.click({ clickCount: 3 });
  await campo.type(ticker, { delay: 60 });
  await new Promise((r) => setTimeout(r, 1800));

  // Los resultados son `div.greeks_ddItem__`, y dentro traen el ticker y el
  // nombre en spans separados. El texto del item viene pegado ("NFLYYieldMax
  // NFLX Option Income Strategy ETFETS"), asi que comparar contra el item entero
  // no sirve: hay que buscar el hijo cuyo texto ES el ticker, exacto.
  //
  // Importa la exactitud: buscar "NFLX" tambien devuelve NFLY y NFX, dos ETF que
  // lo mencionan en el nombre. Elegir por coincidencia parcial capturaria los
  // niveles del activo equivocado y los guardaria con el ticker pedido.
  const clicado = await p.evaluate((tk) => {
    const norm = (e) => (e.textContent || '').trim().replace(/\s+/g, ' ').toUpperCase();
    for (const item of document.querySelectorAll('[class*="greeks_ddItem__"]')) {
      for (const hijo of item.querySelectorAll('*')) {
        if (hijo.children.length) continue;
        if (norm(hijo) === tk) { item.click(); return tk; }
      }
    }
    return null;
  }, ticker.toUpperCase());
  if (!clicado) {
    await p.keyboard.press('Escape');
    throw new Error(`Sigma no ofrecio "${ticker}" en el buscador`);
  }

  // No basta con que cambie el BOTON del ticker: las tarjetas de metricas siguen
  // cargando unos segundos mas. Si se lee en ese hueco, readRawMetrics devuelve
  // un objeto vacio o a medias y la lectura muere con "faltan metricas
  // obligatorias" — un mensaje que apunta a sesion expirada o cambio de UI, dos
  // causas que no tienen nada que ver.
  //
  // Se espera a que la etiqueta del spot nombre al ticker nuevo: es el propio
  // panel confirmando que ya recargo, no un sleep a ojo.
  // 90 segundos, no 15: recargar la cadena de un subyacente liquido tarda, y un
  // presupuesto corto hace fallar por impaciencia algo que iba a funcionar.
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 500));
    // La comparacion se hace AFUERA a proposito: el evaluate solo LEE la
    // etiqueta y la devuelve.
    //
    // Pasandole el ticker como argumento y comparando adentro daba `false` con
    // etiqueta "Spot BA" y ticker "BA" — imposible, o sea que el argumento no
    // llegaba al contexto de la pagina. Costo una hora de depuracion porque el
    // sintoma ("el panel no termino de cargar en 90s") apuntaba a lentitud y el
    // problema era el paso de parametros.
    //
    // Un evaluate que solo lee, y nunca decide, no puede volver a hacer esto.
    const etiquetaSpot = await p.evaluate(() =>
      [...document.querySelectorAll('[class*="greeks_metricLabel__"]')]
        .map((e) => (e.textContent || '').trim())
        .find((t) => /^Spot/.test(t)) || null);
    const listo = !!etiquetaSpot && etiquetaSpot.toUpperCase().includes(ticker.toUpperCase());
    if (listo) {
      const ahora = await readSymbol(p);
      if (ahora && ahora.toUpperCase() === ticker.toUpperCase()) return ahora;
    }
  }
  throw new Error(`el panel no termino de cargar "${ticker}" en 90s (ticker actual: ${await readSymbol(p)})`);
}

export async function readLevels({ exigirSPX = true } = {}) {
  const p = await ensurePage();

  // El simbolo tambien necesita paciencia en frio (2026-08-11). La espera activa
  // que se agrego ayer cubria las METRICAS, pero este chequeo va antes y no la
  // tenia: en el primer ciclo de las 09:00 la pagina recien lanzada devolvio
  // symbol=null y el ciclo murio con "no esta en SPX", que es el mismo mensaje
  // que daria un usuario que cambio el activo a mano. Dos causas muy distintas
  // bajo un solo error — y solo una se arregla esperando.
  //
  // No es grave (el ciclo siguiente lo levanta), pero ensucia el diagnostico
  // justo en el arranque, que es cuando mas se mira.
  let symbol = null;
  for (let intento = 1; intento <= 5; intento++) {
    symbol = await readSymbol(p);
    if (symbol) break;
    if (intento < 5) await new Promise((r) => setTimeout(r, 2000));
  }
  // `exigirSPX` (2026-08-22): el daemon SIEMPRE exige SPX —si Sigma quedo en otro
  // activo, sus muros no son los del SPX y empujarlos a TradingView seria peor
  // que no empujar nada—. El capturador de niveles historicos pasa false a
  // proposito, porque su trabajo es justamente recorrer otros simbolos.
  if (!symbol) {
    throw new Error('Sigma Terminal no devolvio el simbolo tras 10s -- la pagina no termino de cargar');
  }
  // ── SE RECUPERA SOLO DEL SIMBOLO EQUIVOCADO (2026-08-25) ──────────────────
  //
  // Antes esto tiraba "cambiar a mano y reintentar" y se rendia. El 25-ago Sigma
  // amanecio en ADBE y el daemon estuvo 5 HORAS fallando cada 2 minutos con ese
  // mensaje —sin muros en TradingView y sin niveles para las tres estrategias—
  // hasta que un humano lo miro. La funcion para arreglarlo (seleccionarSimbolo)
  // ya estaba en este mismo archivo y la usa el capturador desde el 22-ago;
  // simplemente nadie la habia conectado a este chequeo.
  //
  // Se intenta UNA vez y se verifica leyendo. Si no cede, se tira el error de
  // siempre: la diferencia es que ahora dice que ya se intento, para que el log
  // distinga "estaba mal y lo arregle" de "esta mal y no puedo".
  //
  // POR QUE NO ES INVASIVO: el daemon ya exige SPX para operar, asi que llevar el
  // terminal a SPX es restaurar su propia precondicion, no imponerle nada al
  // usuario. Y solo corre con exigirSPX (el capturador pasa false a proposito,
  // porque su trabajo es justamente recorrer otros simbolos).
  if (exigirSPX && !/^SPX$/i.test(symbol)) {
    console.error(`[sigma] Sigma esta en "${symbol}" y se necesita SPX — restaurando`);
    try {
      await seleccionarSimbolo(p, 'SPX');
      symbol = await readSymbol(p);
      if (/^SPX$/i.test(symbol || '')) {
        console.error('[sigma] restaurado a SPX solo, sin intervencion');
      }
    } catch (e) {
      console.error(`[sigma] no se pudo restaurar SPX: ${e.message.slice(0, 80)}`);
    }
  }
  if (exigirSPX && !/^SPX$/i.test(symbol || '')) {
    throw new Error(`Sigma Terminal no esta en SPX (simbolo actual: "${symbol}") -- ` +
                    `se intento restaurar automaticamente y no cedio, hay que mirarlo a mano`);
  }

  await ensureMvsAbsolute(p);

  // Espera ACTIVA a que aparezcan las metricas, en vez de confiar en el timeout
  // fijo de 6s de ensurePage (2026-08-10). Tras un arranque en frio —Chromium
  // recien lanzado, SPA cargando, sesion revalidandose— 6s se quedan cortos y la
  // lectura moria con "faltan metricas esperadas", que es el mismo mensaje que da
  // una sesion caducada o un cambio de UI. Tres causas distintas bajo un solo
  // error, y solo una de ellas necesitaba paciencia.
  //
  // Reproducido: con el perfil recien liberado, el primer intento llega con el
  // panel a medio pintar. Al segundo o tercero ya esta.
  // Un alias puede ser texto exacto o una expresion regular (para etiquetas que
  // llevan el ticker dentro, como "Spot NFLX").
  // Un alias es texto exacto, o un patron para las etiquetas que llevan el
  // ticker dentro ('Spot SPX', 'Spot NFLX').
  //
  // Se comprueba por `typeof === string` y NO por `instanceof RegExp`: con el
  // segundo, un /^Spot/ que existia en el mapa y casaba contra una clave que
  // estaba en el objeto devolvia undefined igual. Sea cual sea la causa (realm,
  // transpilacion), no vale la pena pelearla: preguntar que ES algo es mas
  // fragil que preguntar que NO es.
  // Busca por alias exacto y, si el descriptor lo declara, por prefijo.
  const buscar = (raw, d) => {
    for (const a of d.alias || []) if (a in raw) return raw[a];
    if (d.prefijo) {
      const clave = Object.keys(raw).find((k) => k.startsWith(d.prefijo));
      if (clave) return raw[clave];
    }
    return undefined;
  };
  let raw = {}, faltanObl = [], faltanOpc = [];
  for (let intento = 1; intento <= 6; intento++) {
    raw = await readRawMetrics(p);
    faltanObl = Object.entries(LABEL_MAP)
      .filter(([, d]) => d.obligatoria && buscar(raw, d) === undefined)
      .map(([k]) => k);
    if (!faltanObl.length) break;
    if (intento < 6) await new Promise((r) => setTimeout(r, 2500));
  }
  faltanOpc = Object.entries(LABEL_MAP)
    .filter(([, d]) => !d.obligatoria && buscar(raw, d) === undefined)
    .map(([k]) => k);
  if (faltanObl.length > 0) {
    throw new Error(`Sigma Terminal: faltan metricas OBLIGATORIAS tras 15s (${faltanObl.join(', ')}) -- etiquetas vistas: ${JSON.stringify(Object.keys(raw))}. Si alguna es la que falta pero con otro nombre, agregarla a los alias de LABEL_MAP.`);
  }
  if (faltanOpc.length) {
    // A stderr, no a stdout: hay scripts que consumen este modulo como JSON puro.
    console.error(`[sigma] faltan metricas opcionales (${faltanOpc.join(', ')}) -- se sigue igual, ninguna estrategia decide con ellas. Si persiste, revisar si Sigma renombro la etiqueta.`);
  }

  const levels = {};
  for (const [key, d] of Object.entries(LABEL_MAP)) {
    const v = buscar(raw, d);
    levels[key] = v === undefined ? null : parseMoney(v);
  }
  levels.regime = levels.netGex > 0 ? 'POSITIVO' : 'NEGATIVO';
  // A que expiracion pertenecen estos numeros. Va con cada lectura, siempre.
  levels.expiry = await readExpiry(p);
  levels.symbol = symbol;
  return levels;
}

// ── Velas de 5m del SPX, de la misma fuente que el gamma ──────────────────
// De donde sale esto (2026-08-09): el usuario pregunto como hace Sigma Terminal
// para mostrar los indicadores completos en la primera hora, si nosotros
// necesitabamos 45 min de sesion para juntar 8 velas. La respuesta es que Sigma
// NO acumula nada: le pide el historico a Polygon a traves de su propio proxy, y
// lo dibuja entero de una. Nuestra reconstruccion a partir del spot que empuja el
// daemon era una limitacion autoimpuesta.
//
// Verificado contra el endpoint real: /v2/aggs/ticker/I:SPX/range/5/minute/...
// devolvio 159 velas cubriendo 6-ago 09:30 a 7-ago 16:00, o sea el indice de
// verdad (I:SPX, no el ETF) con la reticula alineada a las 09:30 en punto. Con
// eso la SMA8 esta lista en la primera vela del dia.
//
// Es best-effort: si falla, devuelve null y el que llama sigue sin velas. NUNCA
// debe tumbar el push de niveles, que es lo critico.
//
// 2026-08-23: el default sube de 30 a 60. Polygon ya devuelve ~390 velas (5 dias
// de 5m con limit=50000) y las tirabamos en el slice de abajo, dejando la serie
// al ras. calcWeinstein (src/wheel_trading.js) exige 30 cierres y le llegaban
// 25, asi que devolvia {fase: null} SIEMPRE: 117 de 117 evaluaciones de
// Reversion registraron "Fase 5m (—)" entre el 11 y el 21 de agosto. Son 10 de
// los 55 puntos del score en cero fijo, sin error ni aviso.
//
// Es la MISMA limitacion autoimpuesta que sacamos el 9-ago al dejar de
// reconstruir la serie desde el spot: el historico esta, solo habia que no
// recortarlo. La de 2m ya se baja con 120 y la de 15m con 80 — la de 5m era la
// unica sin aire, y es justo la que decide la Reversion ("5 minutos decide").
//
// 60 y no 120 a proposito: velas5mDeSigma rechaza la serie ENTERA si encuentra
// un hueco dentro de una sesion, asi que cada vela de mas es superficie extra
// para caerse al respaldo. 60 cubre los 30 de Weinstein con el doble de margen.
export async function readCandles5m({ velas = 60, diasAtras = 5, minutos = 5 } = {}) {
  const p = await ensurePage();
  if (!apiToken) return null;              // todavia no se capturo; el proximo ciclo lo tendra

  const hoy = new Date();
  const desde = new Date(hoy.getTime() - diasAtras * 24 * 3600 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const ruta = `/v2/aggs/ticker/I:SPX/range/${minutos}/minute/${iso(desde)}/${iso(hoy)}`
             + `?adjusted=true&sort=asc&limit=50000`;

  // El fetch va DENTRO de la pagina: el proxy valida el Origin, desde Node daria CORS.
  const bars = await p.evaluate(async (ruta, tok) => {
    try {
      const r = await fetch('https://market.opcionsigma.com/api/v1/polygon-proxy' + ruta,
                            { headers: { authorization: tok } });
      if (!r.ok) return { error: 'HTTP ' + r.status };
      const j = await r.json();
      return { results: j?.results || [] };
    } catch (e) { return { error: String(e).slice(0, 120) }; }
  }, ruta, apiToken);

  if (!bars || bars.error || !bars.results?.length) {
    if (bars?.error === 'HTTP 401') apiToken = null;   // caduco: que lo recapture
    return null;
  }
  // `t` es el ARRANQUE de la vela (misma convencion que Yahoo, que es contra lo
  // que estaba calibrada la reversion). No se re-etiqueta.
  return bars.results.slice(-velas).map((b) => ({
    t: b.t, o: b.o, h: b.h, l: b.l, c: b.c,
  }));
}

// ── VIX y su rango de 52 semanas, del mismo proxy ─────────────────────────
// Directriz del usuario (2026-08-09): "creamosle a sigma terminal y tomemos ese
// dato como opcion 1". El VIX de Sigma y el de Yahoo son el MISMO numero —
// verificado: 14.9 y 14.9, con la misma marca de tiempo al segundo (7-ago
// 16:15:01)— asi que esto no cambia ningun valor. Lo que gana es dejar de
// depender de Yahoo, donde un fallo silencioso dejaba el VIX en 20 fijo.
//
// El rango de 52 semanas se pide una vez por dia: son 257 velas diarias y no se
// mueve entre ciclos. Sirve para calcular el IV Rank sin preguntarle a
// TastyTrade, que es la cuenta REAL y no tiene por que estar en el camino de una
// decision del sandbox.
let vix52Cache = null;   // { dia, high, low }

export async function readVix() {
  const p = await ensurePage();
  if (!apiToken) return null;

  const hoy = new Date();
  const diaET = hoy.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const necesitaRango = !vix52Cache || vix52Cache.dia !== diaET;

  const desde = new Date(hoy.getTime() - 372 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const hasta = hoy.toISOString().slice(0, 10);

  const r = await p.evaluate(async (tok, necesitaRango, desde, hasta) => {
    const base = 'https://market.opcionsigma.com/api/v1/polygon-proxy';
    const get = async (ruta) => {
      const res = await fetch(base + ruta, { headers: { authorization: tok } });
      if (!res.ok) return { error: res.status };
      return res.json();
    };
    const out = {};
    const snap = await get('/v3/snapshot/indices?ticker.any_of=I:VIX');
    out.vix = snap?.results?.[0]?.value ?? null;
    out.err = snap?.error ?? null;
    if (necesitaRango) {
      const d = await get(`/v2/aggs/ticker/I:VIX/range/1/day/${desde}/${hasta}?adjusted=true&sort=asc&limit=1000`);
      out.cierres = (d?.results || []).map((b) => b.c).filter((c) => c != null);
    }
    return out;
  }, apiToken, necesitaRango, desde, hasta);

  if (r?.err === 401) { apiToken = null; return null; }
  if (!r || r.vix == null) return null;

  if (necesitaRango && r.cierres?.length > 200) {
    // Ventana movil de 252 ruedas, que es como se calcula un IV Rank de verdad.
    const ventana = r.cierres.slice(-252);
    vix52Cache = { dia: diaET, high: Math.max(...ventana), low: Math.min(...ventana) };
  }
  return {
    vix: r.vix,
    vix52High: vix52Cache?.high ?? null,
    vix52Low: vix52Cache?.low ?? null,
  };
}

export async function close() {
  if (browser) {
    try { await browser.close(); } catch { /* noop */ }
    browser = null;
    page = null;
  }
}
