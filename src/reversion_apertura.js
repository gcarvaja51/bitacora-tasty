'use strict';

// ── Reversion de APERTURA (2026-09-28, reset de la familia REVERSION) ────────
//
// Estudio completo en `mentoria alejandro/estrategias automatizadas/
// 04_reversion a la media/gap_apertura_ema10_2m/` (LEEME.txt + scripts).
//
// La tesis (del usuario): cuando el SPX abre con gap y lejos de sus EMAs de 15m,
// el precio se estira en la direccion del gap y despues vuelve a buscar la EMA 10
// de 2 minutos. Se entra en el giro y se sale al tocar esa EMA.
//
// Lo que dijo el backtest (14-ago a 25-sep, velas de Yahoo), sin maquillar:
//   - Que el precio toque la EMA10 de 2m NO es ventaja: pasa 30 de 30 dias, con
//     gap o sin el. Lo que cambia con gap es el TAMANO del rebote (mediana 11,8
//     pts contra 8,2).
//   - Con esta regla: 8 trades, 62% de aciertos, +2,1 pts de indice por trade.
//     Muestra insuficiente para afirmar una ventaja. Se opera en el sandbox para
//     juntarla.
//   - El gamma NO filtra: en la muestra coincide 100% con la direccion del gap.
//
// Todo lo de aca es puro (sin red, sin disco, sin reloj salvo el `ahoraMs` que
// se pasa) para poder probarlo en scripts/pruebas.js.

const PASO_2M = 2 * 60 * 1000;
const PASO_15M = 15 * 60 * 1000;

const DEFAULTS = {
  activo: false,
  tradierAutoExecute: false,
  gapMinPct: 0.2,           // |apertura - cierre previo| / cierre previo, en %
  distEmas15mMinPts: 12,    // la apertura, del lado del gap, a >= N pts de la EMA10 Y de la EMA20 de 15m
                            // (15 dejaba fuera el 28-sep, el dia que origino la regla: EMA20 a 12,5)
  soloContraGap: true,      // gap abajo -> solo largos; gap arriba -> solo cortos
  alejamientoMinPts: 15,    // extremo de las ultimas N velas de 2m contra la EMA10 de 2m
  velasAlejamiento: 5,
  stopBufferPts: 2,         // stop = extremo de esas velas +/- esto
  timeStopMin: 30,
  ventanaDesdeMin: 9 * 60 + 30,   // inicio (ET) de la vela de 2m que puede gatillar
  ventanaHastaMin: 10 * 60 + 14,  // ultima vela de 2m (por su hora de inicio) que puede gatillar
  maxTradesDia: 1,
};

function conDefaults(cfg) {
  return { ...DEFAULTS, ...(cfg || {}) };
}

// EMA con el mismo criterio que pandas ewm(span, adjust=False): semilla en el
// primer valor. Es la que uso el backtest; con 120 velas de 2m (o 80 de 15m) la
// semilla ya no pesa nada al final de la serie.
function ema(valores, span) {
  const a = 2 / (span + 1);
  const out = [];
  let prev = null;
  for (const v of valores) {
    prev = prev == null ? v : a * v + (1 - a) * prev;
    out.push(prev);
  }
  return out;
}

function fechaET(t) {
  return new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function minutosET(t) {
  const s = new Date(t).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false });
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

// Solo velas de sesion regular (9:30-16:00 ET), ordenadas y sin nulos.
function velasDeSesion(velas) {
  return (velas || [])
    .filter(v => v && Number.isFinite(v.t) && [v.o, v.h, v.l, v.c].every(Number.isFinite))
    .filter(v => { const m = minutosET(v.t); return m >= 570 && m < 960; })
    .sort((a, b) => a.t - b.t);
}

// ¿Hoy es dia de reversion de apertura? Se decide con las velas de 15m:
// cierre previo = cierre de la ultima vela de la sesion anterior; apertura = open
// de la primera vela de hoy; EMAs = las de 15m al cierre de ayer (lo que habia en
// el grafico a las 9:30).
function evaluarDia(velas15, ahoraMs, cfgIn) {
  const cfg = conDefaults(cfgIn);
  const hoy = fechaET(ahoraMs);
  const v = velasDeSesion(velas15);
  const idxHoy = v.findIndex(x => fechaET(x.t) === hoy);
  if (idxHoy < 0) return { apto: false, motivo: 'todavia no hay vela de 15m de hoy' };
  if (idxHoy < 25) return { apto: false, motivo: `historia de 15m insuficiente (${idxHoy} velas antes de hoy, minimo 25)` };
  const previas = v.slice(0, idxHoy);
  const closes = previas.map(x => x.c);
  const e10 = ema(closes, 10).at(-1);
  const e20 = ema(closes, 20).at(-1);
  const cierrePrev = closes.at(-1);
  const apertura = v[idxHoy].o;
  const gap = apertura - cierrePrev;
  const gapPct = gap / cierrePrev * 100;
  const s = Math.sign(gap);
  const distE10 = (apertura - e10) * s;
  const distE20 = (apertura - e20) * s;
  const r = {
    fecha: hoy,
    cierrePrev: +cierrePrev.toFixed(2), apertura: +apertura.toFixed(2),
    gap: +gap.toFixed(2), gapPct: +gapPct.toFixed(3),
    direccionGap: s > 0 ? 'ARRIBA' : s < 0 ? 'ABAJO' : 'NINGUNA',
    ema10_15m: +e10.toFixed(2), ema20_15m: +e20.toFixed(2),
    distE10: +distE10.toFixed(2), distE20: +distE20.toFixed(2),
  };
  if (Math.abs(gapPct) < cfg.gapMinPct) {
    return { ...r, apto: false, motivo: `gap de ${r.gapPct}% (minimo ${cfg.gapMinPct}%)` };
  }
  if (Math.min(distE10, distE20) < cfg.distEmas15mMinPts) {
    return { ...r, apto: false,
      motivo: `apertura a ${Math.min(distE10, distE20).toFixed(1)} pts de las EMAs de 15m (minimo ${cfg.distEmas15mMinPts})` };
  }
  return { ...r, apto: true, motivo: `gap ${r.direccionGap} de ${r.gapPct}% y apertura a ${r.distE10}/${r.distE20} pts de la EMA10/20 de 15m` };
}

// Velas de 2m ya CERRADAS a `ahoraMs`. Sigma y Yahoo mandan la vela en
// formacion: decidir sobre ella es decidir sobre un precio que todavia se mueve.
function velasCerradas(velas2, ahoraMs) {
  return velasDeSesion(velas2).filter(x => x.t + PASO_2M <= ahoraMs);
}

// EMA10 de 2m de la ultima vela cerrada. Es el objetivo de salida.
function ema10_2m(velas2, ahoraMs) {
  const c = velasCerradas(velas2, ahoraMs);
  if (c.length < 30) return null;
  return ema(c.map(x => x.c), 10).at(-1);
}

// El gatillo, evaluado sobre la ULTIMA vela cerrada — igual que el backtest,
// que recorria las velas y se quedaba con la primera que cumplia.
function evaluarEntrada(velas2, dia, ahoraMs, cfgIn) {
  const cfg = conDefaults(cfgIn);
  const cerradas = velasCerradas(velas2, ahoraMs);
  if (cerradas.length < 30) return { entra: false, motivo: `solo ${cerradas.length} velas de 2m cerradas (minimo 30 para la EMA10)` };
  const e10 = ema(cerradas.map(x => x.c), 10);
  const hoy = fechaET(ahoraMs);
  const iHoy = cerradas.findIndex(x => fechaET(x.t) === hoy);
  if (iHoy < 0) return { entra: false, motivo: 'sin velas de 2m cerradas de hoy' };
  const j = cerradas.length - 1;
  if (j - iHoy < 1) return { entra: false, motivo: 'hace falta una vela de hoy previa a la del gatillo' };
  const b = cerradas[j], pv = cerradas[j - 1];
  const mIni = minutosET(b.t);
  const horaVela = `${Math.floor(mIni / 60)}:${String(mIni % 60).padStart(2, '0')}`;
  if (mIni < cfg.ventanaDesdeMin || mIni > cfg.ventanaHastaMin) {
    return { entra: false, fuera: true, motivo: `vela de las ${horaVela} fuera de la ventana` };
  }
  const ema10 = e10[j];
  const lado = b.c < ema10 ? 'LARGO' : 'CORTO';
  const base = { velaT: b.t, horaVela, ema10: +ema10.toFixed(2), lado };
  if (cfg.soloContraGap && dia) {
    const quiere = dia.direccionGap === 'ABAJO' ? 'LARGO' : dia.direccionGap === 'ARRIBA' ? 'CORTO' : null;
    if (quiere && lado !== quiere) {
      return { ...base, entra: false, motivo: `precio del lado ${lado} de la EMA10 de 2m; con gap ${dia.direccionGap} solo se opera ${quiere}` };
    }
  }
  const desde = Math.max(iHoy, j - (cfg.velasAlejamiento - 1));
  const tramo = cerradas.slice(desde, j + 1);
  const minBajo = Math.min(...tramo.map(x => x.l));
  const maxAlto = Math.max(...tramo.map(x => x.h));
  const alejamiento = lado === 'LARGO' ? ema10 - minBajo : maxAlto - ema10;
  base.alejamiento = +alejamiento.toFixed(2);
  if (alejamiento < cfg.alejamientoMinPts) {
    return { ...base, entra: false, motivo: `alejamiento de ${base.alejamiento} pts de la EMA10 de 2m (minimo ${cfg.alejamientoMinPts})` };
  }
  const giro = lado === 'LARGO' ? b.c > pv.h : b.c < pv.l;
  if (!giro) {
    return { ...base, entra: false, motivo: `sin giro: la vela cerro en ${b.c} sin ${lado === 'LARGO' ? 'superar el maximo' : 'perforar el minimo'} de la anterior (${lado === 'LARGO' ? pv.h : pv.l})` };
  }
  const entrada = b.c;
  const stop = lado === 'LARGO' ? minBajo - cfg.stopBufferPts : maxAlto + cfg.stopBufferPts;
  return {
    ...base, entra: true,
    direction: lado === 'LARGO' ? 'BULLISH' : 'BEARISH',
    entrada: +entrada.toFixed(2),
    stop: +stop.toFixed(2),
    riesgoPts: +Math.abs(entrada - stop).toFixed(2),
    objetivoPts: +Math.abs(ema10 - entrada).toFixed(2),
    motivo: `alejamiento ${base.alejamiento} pts + giro en la vela de las ${horaVela}`,
  };
}

module.exports = {
  DEFAULTS, conDefaults, ema, fechaET, minutosET, velasDeSesion,
  evaluarDia, evaluarEntrada, velasCerradas, ema10_2m, PASO_2M, PASO_15M,
};
