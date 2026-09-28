'use strict';

// ── MEDIODIA — Iron Butterfly de las 12:30 centrado en el MVS (2026-09-28) ──
//
// Regla de Guillermo (28-sep-2026): "un trade neutral a las 12:30 pm en el MVS que
// me marque los ultimos 30 minutos del SPX, con alas de 15 puntos". Opera en el
// SANDBOX de Tradier ("solo demo por ahora").
//
//   Entrada   12:30 ET (se acepta hasta las 12:45; mas tarde no es la misma apuesta)
//   Centro    PROMEDIO del MVS de Sigma entre las 12:00 y las 12:30, redondeado a 5
//   Alas      15 puntos: vende call y put en el centro, compra centro ± 15
//   Salida    objetivo del 20% del credito, o cierre a las 15:30 ET. SIN stop.
//   Convive   con todo: no bloquea a ninguna estrategia ni lo bloquea ninguna.
//
// POR QUE EL MVS Y NO EL ATM. La sombra del IB ATM (src/ib_atm_sombra.js) centra en
// el strike del precio a la hora de entrada. El 28-sep eso lo puso en 7715 —el SPX
// estaba en pleno pico de 12:25— mientras el MVS llevaba 30 min en 7700, que es
// donde volvio el precio. El estudio del 25-sep (07_pinning §11a) midio algo
// PARECIDO y le fue mal: la MODA del MVS de la ULTIMA HORA perdio contra el spot en
// 3 de 4 horarios. Esto es otra regla (promedio, 30 min) y todavia no tiene muestra:
// para eso se opera en demo.
//
// Solo decision, sin red ni broker: server.js lee las lecturas y manda la orden.

const REGLA = {
  version:        'v1',
  entradaET:      12 * 60 + 30,
  toleranciaMin:  15,
  ventanaMvsET:   [12 * 60, 12 * 60 + 30],   // [desde, hasta)
  minLecturas:    5,                         // Sigma lee cada ~1-2 min: 30 min dan ~15-40
  ala:            15,
  pasoStrike:     5,
  tpPct:          20,
  cierreForzadoET: '15:30',
};

// Minutos desde medianoche en Nueva York, para cualquier instante.
function minutosET(fecha) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(fecha));
  const h = Number(p.find((x) => x.type === 'hour').value), m = Number(p.find((x) => x.type === 'minute').value);
  return h * 60 + m;
}
const fechaET = (fecha) => new Date(fecha).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/**
 * Centro a partir de las lecturas de Sigma (historial de /api/spx/sigma-levels).
 * Cada lectura: { mvs, capturadoEn | updatedAt }. Se usa capturadoEn (cuando el
 * daemon leyo la pantalla) y solo si falta, updatedAt (cuando llego al servidor).
 * Devuelve { centro, promedio, n, min, max } o { centro: null, motivo }.
 */
function centroPorMvs(lecturas, fecha, regla = REGLA) {
  const [desde, hasta] = regla.ventanaMvsET;
  const mvs = [];
  for (const l of lecturas || []) {
    const t = l?.capturadoEn || l?.updatedAt;
    const v = Number(l?.mvs);
    if (!t || !(v > 1000)) continue;
    if (fechaET(t) !== fecha) continue;
    const m = minutosET(t);
    if (m >= desde && m < hasta) mvs.push(v);
  }
  if (mvs.length < regla.minLecturas) {
    return { centro: null, n: mvs.length, motivo: `solo ${mvs.length} lecturas del MVS entre 12:00 y 12:30 (minimo ${regla.minLecturas})` };
  }
  const promedio = mvs.reduce((a, b) => a + b, 0) / mvs.length;
  return {
    centro:   Math.round(promedio / regla.pasoStrike) * regla.pasoStrike,
    promedio: Math.round(promedio * 100) / 100,
    n:        mvs.length,
    min:      Math.min(...mvs),
    max:      Math.max(...mvs),
  };
}

// ¿Toca abrir? Solo dentro de [12:30, 12:45]. Con el servidor caido se pierde el
// dia, no se abre tarde fingiendo ser la entrada de las 12:30.
function enVentana(minET, regla = REGLA) {
  return minET >= regla.entradaET && minET <= regla.entradaET + regla.toleranciaMin;
}

// Strikes de la mariposa, con los nombres que usa el Iron Condor del robot: asi el
// monitor de TP/SL, el cierre en dos verticales y la bitacora la tratan igual.
function strikesMariposa(centro, expiry, regla = REGLA) {
  return {
    expiry,
    shortStrike:     centro,
    longStrike:      centro - regla.ala,
    callShortStrike: centro,
    callLongStrike:  centro + regla.ala,
  };
}

module.exports = { REGLA, centroPorMvs, enVentana, strikesMariposa, minutosET, fechaET };
