// Flujo Sigma (proyecto Chalito, 2026-11-12) — serie del día y marcas para el indicador
// "Flujo Sigma" de TradingView. Pedido del usuario: ver la prima de calls y puts del SPX
// acumulada desde la apertura, en el mismo grafico del precio, y probar 2-3 semanas si
// gira antes que el MACD.
//
// Este modulo NO toca el navegador: recibe el texto que lee sigma.readFlujo(), lo parsea,
// lo archiva y arma lo que se escribe en el indicador. Asi se puede probar sin Chrome
// (flujo.test.mjs) y un error aca nunca toca la lectura de muros.
//
// Fuente (verificado en vivo el 11 y el 12-nov):
//   Flow Dashboard — "● Calls $302.50 M", "● Puts $253.55 M": prima BRUTA acumulada del
//                    dia de todo el mercado SPX (sin lado de la orden). Da verde/rojo/naranja.
//   Options Flow   — Flow Meter "45% alcista · 55% bajista" y "PRIMA TOTAL $5.61 B": prima
//                    CON DIRECCION. neto con direccion = total × (%alc − %baj). Da la azul.
// Precision: Sigma muestra los montos > $1 B con dos decimales ("$1.12 B" = saltos de 10 M).
//
// Formato que entiende el Pine (pine en 01_Sigma/chalito/pine/flujo_sigma.pine):
//   serie  "<base>|<min>:<calls>:<puts>[:<dir>];..."   base = minuto Unix de las 9:30 ET
//   marcas "<min>:S;<min>:B"                            S subida / B bajada con respaldo
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';

const NL = String.fromCharCode(10);

// Regla de las marcas (v2, 11-nov). Solo "con respaldo": el precio y el neto van para el
// mismo lado en una ventana de 30 min y el neto se movio al menos UMBRAL. Una marca por
// tipo cada 30 min. El umbral de 8,7 M$ es el de ayer llevado a la escala de Sigma; se
// recalibra con datos (FLUJO_UMBRAL_M).
export const REGLA = {
  ventanaMin: Number(process.env.FLUJO_VENTANA_MIN || 30),
  umbralM: Number(process.env.FLUJO_UMBRAL_M || 8.7),
  pausaMin: Number(process.env.FLUJO_PAUSA_MIN || 30),
};
const FIN_SESION_MIN = 390;   // 16:00 ET = 9:30 + 390 min

// "$841.55 M" / "$1.02 B" / "-$8.00 M" / "−$3 K" -> millones de USD
export function aMillones(txt) {
  if (txt == null) return null;
  const m = String(txt).replace(/[​\s,]/g, '').match(/^([+−-]?)\$?([+−-]?)([\d.]+)([KMB])?/);
  if (!m) return null;
  let v = parseFloat(m[3]);
  if (!Number.isFinite(v)) return null;
  if (m[4] === 'B') v *= 1000;
  else if (m[4] === 'K') v /= 1000;
  else if (!m[4]) v /= 1e6;
  const neg = /[−-]/.test(m[1] + m[2]);
  return neg ? -v : v;
}

// Texto de la sub-pestaña Flow Dashboard -> { calls, puts, spx, momentum } en M$ (null si no hay).
export function parseFlujo(t) {
  t = t || '';
  const g = (re) => { const x = t.match(re); return x ? x[1] : null; };
  const calls = aMillones(g(/●\s*Calls\s*(\$[\d.,]+\s*[KMB]?)/));
  const puts = aMillones(g(/●\s*Puts\s*(\$[\d.,]+\s*[KMB]?)/));
  const spx = parseFloat((g(/●\s*SPX\s*\$([\d.,]+)/) || '').replace(/,/g, '')) || null;
  return {
    calls, puts, spx,
    momentum: aMillones(g(/MOMENTUM\s*[▲▼]?\s*([+−-]?\$[\d.,]+\s*[KMB]?)/)),
    capturas: g(/Capturas:\s*([^\n]+)/),
    esperando: /Esperando datos de flujo/.test(t),
  };
}

// Texto de Options Flow -> { pctAlcista, pctBajista, primaTotal, dir } o null si no cargo.
// Con PRIMA TOTAL $0 el panel aun no tiene datos (pasa el primer segundo tras el clic).
export function parseMeter(t) {
  t = t || '';
  const x = t.match(/(\d+(?:\.\d+)?)\s*%\s*alcista\s*·\s*(\d+(?:\.\d+)?)\s*%\s*bajista/);
  const tot = t.match(/PRIMA TOTAL\s*(\$[\d.,]+\s*[KMB]?)/);
  if (!x || !tot) return null;
  const primaTotal = aMillones(tot[1]);
  if (!primaTotal) return null;
  const pa = Number(x[1]), pb = Number(x[2]);
  return { pctAlcista: pa, pctBajista: pb, primaTotal, dir: +(primaTotal * (pa - pb) / 100).toFixed(1) };
}

// ── Tiempo en hora de Nueva York ──
const fmtET = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function partesET(fecha) {
  const p = Object.fromEntries(fmtET.formatToParts(fecha).map((x) => [x.type, x.value]));
  return { dia: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}
export function fechaET(ahora = new Date()) { return partesET(ahora).dia; }

// Minuto Unix (epoch/60) de las 9:30 ET de ese dia, con horario de verano o sin el.
export function baseMinuto(dia) {
  const [y, m, d] = dia.split('-').map(Number);
  for (const off of [4, 5]) {
    const ms = Date.UTC(y, m - 1, d, 9 + off, 30);
    const p = partesET(new Date(ms));
    if (p.dia === dia && p.hm === '09:30') return ms / 60000;
  }
  throw new Error(`no se pudo calcular las 9:30 ET de ${dia}`);
}

// ── Estado del dia (en memoria + archivo) ──
// Una fila por lectura: { min, calls, puts, dir, spx, ts }. min = minutos desde las 9:30 ET.
export function crearFlujo({ dir, log = console } = {}) {
  let dia = null;
  let base = null;
  let filas = [];

  const archivo = (d) => path.join(dir, `flujo_${d}.jsonl`);

  // Al cambiar de dia (o al arrancar el robot) recupera lo ya leido hoy.
  function asegurarDia(d) {
    if (d === dia) return;
    dia = d;
    base = baseMinuto(d);
    filas = [];
    try {
      if (dir && existsSync(archivo(d))) {
        for (const linea of readFileSync(archivo(d), 'utf8').split(NL)) {
          if (!linea.trim()) continue;
          try { filas.push(JSON.parse(linea)); } catch { /* linea rota: se ignora */ }
        }
        filas.sort((a, b) => a.min - b.min);
      }
    } catch (e) {
      log.warn?.(`[flujo] no se pudo recuperar ${archivo(d)} (${e.message}) -- se arranca vacio`);
    }
  }

  // Guarda una lectura. Devuelve la fila o null si no sirve (sin numeros / fuera de sesion).
  function registrar(lectura, { ahora = new Date(), spxRespaldo = null } = {}) {
    if (!lectura || lectura.calls == null || lectura.puts == null) return null;
    asegurarDia(fechaET(ahora));
    const min = Math.floor(ahora.getTime() / 60000) - base;
    if (min < 0 || min > FIN_SESION_MIN) return null;
    const fila = {
      min,
      calls: +lectura.calls.toFixed(2),
      puts: +lectura.puts.toFixed(2),
      dir: lectura.meter?.dir ?? null,
      spx: lectura.spx || spxRespaldo || null,
      ts: ahora.toISOString(),
    };
    // Un mismo minuto se reemplaza (no se duplica).
    if (filas.length && filas[filas.length - 1].min === min) filas.pop();
    filas.push(fila);
    try {
      if (dir) {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(archivo(dia), JSON.stringify(fila) + NL);
      }
    } catch (e) {
      log.warn?.(`[flujo] no se pudo archivar (${e.message}) -- sigue en memoria`);
    }
    return fila;
  }

  return {
    registrar,
    filas: () => filas.slice(),
    dia: () => dia,
    // Lo que se escribe en el indicador. null si hoy todavia no hay nada.
    textoParaTV(ahora = new Date()) {
      asegurarDia(fechaET(ahora));
      if (!filas.length) return null;
      return { serie: armarSerie(base, filas), marcas: calcularMarcas(filas).map((m) => `${m.min}:${m.tipo}`).join(';') };
    },
    marcas: () => calcularMarcas(filas),
  };
}

export function armarSerie(base, filas) {
  const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  return `${base}|` + filas.map((r) => `${r.min}:${f1(r.calls)}:${f1(r.puts)}` + (r.dir != null ? `:${f1(r.dir)}` : '')).join(';');
}

// Regla v2 sobre la serie bruta (neto = calls − puts) y el precio de cada lectura.
export function calcularMarcas(filas, regla = REGLA) {
  const out = [];
  const ultimo = {};
  for (let i = 0; i < filas.length; i++) {
    const r = filas[i];
    let j = -1;
    for (let k = i - 1; k >= 0; k--) if (filas[k].min <= r.min - regla.ventanaMin) { j = k; break; }
    if (j < 0) continue;
    const p0 = filas[j].spx, p1 = r.spx;
    if (!p0 || !p1) continue;
    const dn = (r.calls - r.puts) - (filas[j].calls - filas[j].puts);
    const tipo = (p1 > p0 && dn >= regla.umbralM) ? 'S' : (p1 < p0 && dn <= -regla.umbralM) ? 'B' : null;
    if (tipo && (ultimo[tipo] == null || r.min - ultimo[tipo] >= regla.pausaMin)) {
      ultimo[tipo] = r.min;
      out.push({ min: r.min, tipo, spx: p1, dNeto: +dn.toFixed(1) });
    }
  }
  return out;
}
