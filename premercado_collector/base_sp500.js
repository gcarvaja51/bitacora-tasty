// Mide la BASE entre el CFD del SP500 que Guillermo tiene en pantalla y el SPX de
// contado (SPCFD:SPX), leyendo las barras de AMBAS ventanas de TradingView.
//
// POR QUE EXISTE (2026-08-31). Guillermo trabaja con el SP500 al frente, pero todo el
// premercado esta calculado en SPX de contado (^GSPC en Yahoo, y los estudios del pane
// SPCFD:SPX). Cuando el informe dice "cierre de 15m bajo 7.671", en su pantalla ese
// nivel esta ~8 puntos mas arriba. Cada disparador del dia esta desplazado.
//
// Y NO ES UNA CONSTANTE. Medido sobre un mes de barras de 15m pareadas entre ES=F y
// ^GSPC (Yahoo), la base de futuros cayo de +28,18 el 31-jul a +12,85 el 28-ago:
// -0,77 puntos por sesion habil. Es la convergencia al vencimiento. Llega a ~0 el
// 18-sep (quad witching) y al dia siguiente SALTA de vuelta a ~+28 cuando el contrato
// rueda a diciembre. Cualquier numero fijo que se memorice caduca en dias y se INVIERTE
// despues del roll.
//
// Por eso esto se mide, no se asume. Y se mide sobre SU instrumento: su +8 observado no
// cuadra con el +13 del futuro, asi que su CFD no sigue al front month -- esta entre el
// contado y el futuro, y hay que leerlo de su propia ventana.
//
// SOLO LECTURA. No cambia simbolo, no cambia resolucion, no llama bringToFront ni roba
// foco, no toca la ventana del daemon mas alla de leerle las barras. Es el mismo patron
// que connectToSpxWindow() ya ejecuta en cada ciclo del gamma_daemon. Cambiarle el
// simbolo a la ventana de SPCFD:SPX es lo que dispara el taskkill del daemon (ver
// CLAUDE.md) -- este script nunca escribe nada en TradingView.
//
//     node base_sp500.js [--json <ruta>] [--quiet]

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

// chrome-remote-interface vive en gamma_daemon/node_modules, no aqui. collect.js lo
// resuelve de rebote porque importa ../gamma_daemon/tv.js; este script no necesita
// nada de tv.js, asi que resuelve el paquete desde esa carpeta y ya.
const CDP = createRequire(new URL('../gamma_daemon/', import.meta.url))('chrome-remote-interface');

const CDP_PORT = Number(process.env.TV_CDP_PORT || 9223);
const SPX_MATCH = /^SPCFD:SPX$/i;
// El CFD que mira Guillermo. Deliberadamente ancho: VANTAGE:SP500, OANDA:SPX500USD,
// FOREXCOM:SPXUSD y demas variantes de broker. Se excluye SPCFD:SPX aparte, porque
// /SPX/ suelto tambien lo matchea.
const CFD_MATCH = /(SP500|SPX500|SPXUSD|US500)/i;
const MAX_BARRAS = 500;

const REGISTRO_POR_DEFECTO = path.join(
  'C:', 'Users', 'gcarv', 'Documents', 'CARPETA PERSONAL', '01. guillermo carvajal',
  '01_Sigma', 'mentoria alejandro', 'premercados alejandro', 'control premercado',
  'base_sp500_vs_spx.json',
);

const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');
const RUTA_JSON = args.includes('--json')
  ? args[args.indexOf('--json') + 1]
  : REGISTRO_POR_DEFECTO;

const log = (...a) => { if (!QUIET) console.log(...a); };

// ─────────────────────────────────────────────────────────── lectura de TradingView

async function listChartTargets() {
  const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
  if (!resp.ok) throw new Error(`CDP no responde en el puerto ${CDP_PORT} (status ${resp.status})`);
  const targets = await resp.json();
  return targets.filter((t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
}

async function evalOn(client, expression) {
  const { result, exceptionDetails } = await client.Runtime.evaluate({
    expression, returnByValue: true, awaitPromise: false,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text || 'error evaluando en la pagina');
  return result.value;
}

// Devuelve, por cada chart widget de cada ventana, su simbolo/resolucion y las
// ultimas MAX_BARRAS barras como [tiempo, cierre]. Nada mas: no se tocan setters.
async function leerSeries() {
  const targets = await listChartTargets();
  if (targets.length === 0) throw new Error('No hay ninguna ventana de TradingView con un chart abierto');

  const series = [];
  for (const t of targets) {
    let client;
    try {
      client = await CDP({ port: CDP_PORT, target: t.id });
      await client.Runtime.enable();
      const panes = await evalOn(client, `
        (function() {
          var all = window.TradingViewApi._chartWidgetCollection.getAll();
          return all.map(function(c, i) {
            try {
              var ms = c.model().mainSeries();
              var bars = ms.bars();
              var first = bars.firstIndex(), last = bars.lastIndex();
              var desde = Math.max(first, last - ${MAX_BARRAS} + 1);
              var out = [];
              for (var k = desde; k <= last; k++) {
                var v = bars.valueAt(k);
                if (v && v[0] != null && v[4] != null) out.push([v[0], v[4]]);
              }
              return { index: i, symbol: ms.symbol(), resolution: ms.interval(), barras: out };
            } catch (e) { return { index: i, error: e.message }; }
          });
        })()
      `);
      if (Array.isArray(panes)) {
        for (const p of panes) if (p.symbol && p.barras?.length) series.push({ target: t.id, ...p });
      }
    } catch (e) {
      log(`  [aviso] ventana ${t.id.slice(0, 8)} no respondio: ${e.message}`);
    } finally {
      if (client) { try { await client.close(); } catch { /* noop */ } }
    }
  }
  return series;
}

// ─────────────────────────────────────────────────────────────────────── estadistica

const mediana = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Solo horario regular: fuera de el, el contado no imprime y la "diferencia" seria el
// movimiento overnight contra un precio muerto, no la base. Ese fue el error que casi
// se comete el 31-ago comparando ES a las 09:16 ET contra el cierre del viernes.
function enRTH(tsSeg) {
  const d = new Date(tsSeg * 1000);
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dia = et.getDay();
  if (dia === 0 || dia === 6) return null;
  const min = et.getHours() * 60 + et.getMinutes();
  if (min < 9 * 60 + 30 || min >= 16 * 60) return null;
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

// Empareja exacto por timestamp. Si las dos ventanas estan en resoluciones distintas
// casi no habra coincidencias, asi que se cae a "el mas cercano dentro de tol".
function emparejar(spx, cfd, tolSeg = 150) {
  const mapa = new Map(spx.map(([t, c]) => [t, c]));
  let pares = cfd.map(([t, c]) => (mapa.has(t) ? [t, mapa.get(t), c] : null)).filter(Boolean);
  if (pares.length >= 5) return { pares, modo: 'exacto' };

  const ts = spx.map(([t]) => t).sort((a, b) => a - b);
  pares = [];
  for (const [t, c] of cfd) {
    let mejor = null, dist = Infinity;
    for (const s of ts) {
      const d = Math.abs(s - t);
      if (d < dist) { dist = d; mejor = s; }
      if (s > t + tolSeg) break;
    }
    if (mejor != null && dist <= tolSeg) pares.push([t, mapa.get(mejor), c]);
  }
  return { pares, modo: `cercano (<=${tolSeg}s)` };
}

// Pendiente por minimos cuadrados: cuanto se mueve la base por sesion habil.
function pendiente(ys) {
  const n = ys.length;
  if (n < 3) return null;
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - mx) * (ys[i] - my); den += (i - mx) ** 2; }
  return den ? num / den : null;
}

// ──────────────────────────────────────────────────────────────────────────── main

async function main() {
  log(`[tv] leyendo ventanas por CDP en el puerto ${CDP_PORT} (solo lectura)...`);
  const series = await leerSeries();
  log(`[tv] ${series.length} serie(s) con barras:`);
  for (const s of series) log(`      ${s.symbol}  res=${s.resolution}  ${s.barras.length} barras`);

  const spxs = series.filter((s) => SPX_MATCH.test(s.symbol));
  const cfds = series.filter((s) => !SPX_MATCH.test(s.symbol) && CFD_MATCH.test(s.symbol));

  if (spxs.length === 0) throw new Error('No se encontro ninguna ventana con SPCFD:SPX cargado.');
  if (cfds.length === 0) {
    throw new Error(
      'No se encontro ninguna ventana con un CFD del SP500. Simbolos vistos: '
      + series.map((s) => s.symbol).join(', ')
      + '. Si el simbolo es otro, ampliar CFD_MATCH en este archivo.',
    );
  }

  // 🚨 LAS DOS SERIES TIENEN QUE ESTAR EN LA MISMA RESOLUCION (arreglado 2026-08-31,
  // el mismo dia que se escribio esto).
  //
  // La primera version cogia la PRIMERA serie de cada simbolo sin mirar la resolucion.
  // Por la manana las dos ventanas estaban en 30m y salio bien (+7,47, banda 4,15-9,32).
  // Por la tarde Guillermo habia pasado la del SPX a 15m y la del CFD seguia en 30m: el
  // script emparejo por timestamp -- y emparejo "exacto", porque todo timestamp de 30m
  // existe tambien en la serie de 15m -- restando el cierre de una vela de 30 minutos
  // contra el de una de 15 que termina QUINCE MINUTOS ANTES. La banda se fue a -11/+21:
  // eso no es la base, es el recorrido del precio en ese cuarto de hora. La mediana
  // apenas se movio (+7,37), que es justo lo que hace peligroso el bug: el numero
  // principal parece sano mientras el dato esta roto.
  //
  // Se eligen las dos series con resolucion COMUN que mas barras de RTH dejen pareadas.
  const comunes = [...new Set(spxs.map((s) => String(s.resolution)))]
    .filter((r) => cfds.some((c) => String(c.resolution) === r));
  if (comunes.length === 0) {
    throw new Error(
      'Las ventanas de SPX y del CFD no comparten ninguna resolucion '
      + `(SPX: ${spxs.map((s) => s.resolution).join('/')} | CFD: ${cfds.map((c) => c.resolution).join('/')}). `
      + 'No se mide nada: emparejar resoluciones distintas da un numero que parece sano y no lo es.',
    );
  }

  let mejor = null;
  for (const r of comunes) {
    const a = spxs.find((s) => String(s.resolution) === r);
    const b = cfds.find((c) => String(c.resolution) === r);
    const par = emparejar(a.barras, b.barras);
    const enRango = par.pares.filter(([t]) => enRTH(t)).length;
    if (!mejor || enRango > mejor.enRango) mejor = { r, spx: a, cfd: b, ...par, enRango };
  }
  const { spx, cfd, pares, modo } = mejor;

  log(`[par] SPX = ${spx.symbol} (res ${spx.resolution})  vs  CFD = ${cfd.symbol} (res ${cfd.resolution})`);
  log(`[par] resoluciones comunes: ${comunes.join(', ')} -- se usa ${mejor.r}`);
  log(`[par] ${pares.length} barras pareadas, modo ${modo}`);

  const porDia = new Map();
  for (const [t, cSpx, cCfd] of pares) {
    const dia = enRTH(t);
    if (!dia) continue;
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(cCfd - cSpx);
  }
  if (porDia.size === 0) {
    throw new Error('Ninguna barra pareada cae en horario regular. Fuera de RTH la diferencia no es base.');
  }

  const nuevas = [...porDia.keys()].sort().map((f) => {
    const v = porDia.get(f);
    return {
      fecha: f,
      n: v.length,
      // Se guarda la resolucion con la que se midio: una fila de 30m y una de 15m no son
      // comparables, y sin este campo el merge no puede saberlo (ver el bug del 31-ago).
      resolucion: String(mejor.r),
      base_mediana: +mediana(v).toFixed(2),
      base_min: +Math.min(...v).toFixed(2),
      base_max: +Math.max(...v).toFixed(2),
      // Una sesion a medias (el chart todavia no tiene el dia entero, o se corrio a
      // media manana) no es comparable con una completa: se marca para no ensuciar la
      // mediana movil ni la pendiente.
      parcial: v.length < 5,
    };
  });

  // MERGE, no overwrite. El chart solo retiene ~300 barras: con resolucion de 30m son
  // unas 6 sesiones, asi que cada corrida ve una ventana que se va corriendo. Si se
  // reescribiera el archivo, la serie nunca pasaria de 6 dias y el historico se
  // perderia en silencio. Un dia ya guardado se REEMPLAZA solo si la lectura nueva
  // tiene al menos tantas barras como la vieja (la de hoy a media sesion no debe pisar
  // la de hoy completa de una corrida posterior).
  let previas = [];
  try {
    const antes = JSON.parse(fs.readFileSync(RUTA_JSON, 'utf8'));
    if (Array.isArray(antes?.series)) previas = antes.series;
  } catch { /* primera corrida */ }

  // Una fila solo se reemplaza por otra medida en la MISMA resolucion y con al menos
  // tantas barras. Sin la condicion de resolucion, la corrida rota del 31-ago (15m
  // contra 30m, mismo n=13) piso seis dias de datos buenos sin que nada lo notara.
  const porFecha = new Map(previas.map((f) => [f.fecha, f]));
  let nuevos = 0, actualizados = 0, rechazados = 0;
  for (const f of nuevas) {
    const vieja = porFecha.get(f.fecha);
    if (!vieja) { porFecha.set(f.fecha, f); nuevos++; continue; }
    const mismaRes = String(vieja.resolucion ?? f.resolucion) === String(f.resolucion);
    if (mismaRes && f.n >= (vieja.n ?? 0)) { porFecha.set(f.fecha, f); actualizados++; }
    else { rechazados++; }
  }
  if (rechazados) log(`[reg] ${rechazados} fila(s) NO se pisaron (otra resolucion o menos barras)`);
  const filas = [...porFecha.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
  log(`[reg] ${nuevos} sesion(es) nueva(s), ${actualizados} actualizada(s), ${filas.length} en total`);

  const completas = filas.filter((f) => !f.parcial);
  const pend = pendiente(completas.map((f) => f.base_mediana));
  // La base vigente es la mediana de las ultimas 5 sesiones COMPLETAS, no la del ultimo
  // dia: el dia a dia se mueve +-1 punto y quedarse con el ultimo es tomar ruido por
  // senal. Si algun dia esa mediana empieza a derivar de verdad, la pendiente lo dira.
  const ventana = completas.slice(-5);
  const hoy = filas[filas.length - 1];

  const registro = {
    generado: new Date().toISOString(),
    simbolo_pantalla: cfd.symbol,
    simbolo_analisis: spx.symbol,
    resolucion_pantalla: cfd.resolution,
    resolucion_analisis: spx.resolution,
    modo_emparejado: modo,
    base_vigente: ventana.length ? +mediana(ventana.map((f) => f.base_mediana)).toFixed(2) : null,
    base_vigente_n_sesiones: ventana.length,
    base_vigente_desde: ventana.length ? ventana[0].fecha : null,
    base_vigente_hasta: ventana.length ? ventana[ventana.length - 1].fecha : null,
    base_banda_barra: completas.length
      ? [+Math.min(...completas.map((f) => f.base_min)).toFixed(2),
         +Math.max(...completas.map((f) => f.base_max)).toFixed(2)]
      : null,
    ultima_sesion: hoy,
    deriva_pts_por_sesion: pend == null ? null : +pend.toFixed(3),
    nota: 'base = precio del CFD menos SPX de contado. Sumar al nivel del informe para '
        + 'leerlo en la pantalla del CFD; restar para ir de la pantalla al informe. '
        + 'Solo barras de horario regular (09:30-16:00 ET): fuera de RTH el contado no '
        + 'imprime y la diferencia seria el movimiento overnight, no la base. '
        + 'MEDIDO 2026-08-31: este CFD sigue al CONTADO con un spread casi constante '
        + '(deriva -0,07 pts/sesion). NO confundir con la base del futuro ES=F, que cae '
        + '0,77 pts/sesion, llega a ~0 en el vencimiento y salta de vuelta en el roll '
        + 'trimestral -- ese comportamiento NO aplica aqui. Si algun dia la deriva de '
        + 'este archivo se acerca a -0,7, es que el bróker cambio de instrumento base.',
    series: filas,
  };

  fs.mkdirSync(path.dirname(RUTA_JSON), { recursive: true });
  fs.writeFileSync(RUTA_JSON, JSON.stringify(registro, null, 1), 'utf8');

  log('');
  log('fecha         n    mediana     min      max');
  for (const f of filas) {
    log(`${f.fecha}  ${String(f.n).padStart(3)}   ${f.base_mediana >= 0 ? '+' : ''}${f.base_mediana.toFixed(2).padStart(6)}  ${f.base_min.toFixed(2).padStart(7)}  ${f.base_max.toFixed(2).padStart(7)}${f.parcial ? '   (parcial)' : ''}`);
  }
  log('');
  if (registro.base_vigente != null) {
    log(`[base] VIGENTE ${registro.base_vigente >= 0 ? '+' : ''}${registro.base_vigente.toFixed(2)} pts`
      + ` (mediana de ${ventana.length} sesiones completas, ${registro.base_vigente_desde} a ${registro.base_vigente_hasta})`);
    log(`[base] banda por barra: ${registro.base_banda_barra[0].toFixed(2)} a ${registro.base_banda_barra[1].toFixed(2)}`);
  }
  if (pend != null) log(`[base] deriva ${pend >= 0 ? '+' : ''}${pend.toFixed(2)} pts por sesion (sobre ${completas.length} completas)`);
  log(`[done] registro escrito en ${RUTA_JSON}`);
}

main().catch((e) => { console.error('[FALLO]', e.message); process.exit(1); });
