'use strict';

// ── IRON BUTTERFLY ATM de mediodia — MODO SOMBRA (2026-09-25) ──────────────
//
// SOLO ANALISIS. No manda ni una orden. Abre en sombra una mariposa ATM en cada
// hora de entrada candidata y apunta su precio REAL —mid y natural— hasta el
// cierre, para contestar con precios de la cadena lo que el estudio solo pudo
// estimar con un modelo:
//   1. cuanto credito da de verdad una mariposa ATM a las 12:00-13:30
//   2. si el objetivo del 10/15/20/30% se toca, a que hora, y si se puede
//      EJECUTAR (recomprando al natural) o solo aparece en el mid
//   3. cuanto vale a las 15:30 frente a aguantar al vencimiento
//
// POR QUE EXISTE. Estudio del 25-sep (07_pinning, scripts 15-19): con alas de 15
// y entrada a las 12:30 centrada en el precio, el cierre queda dentro de las alas
// 16 de 19 dias, pero el P&L depende de un credito estimado (~10,7 pts, calibrado
// con 6 precios reales) y el margen sobre el equilibrio (9 pts) es del tamano del
// error del modelo. Y Guillermo reporto que, aunque la mariposa toque el 20%, la
// salida "no se da tan rapido como uno espera": el natural es lo que lo mide.
//
// El centro es el strike ATM, NO el MVS: centrada en el MVS de la ultima hora
// perdio en 3 de 4 horarios (script 17). Sin filtro de gamma: no mejoro (§ del 25-sep).
//
// Unidades (gotcha 3): creditos, mid y natural en PRECIO POR ACCION; riesgo en
// DOLARES por contrato.

const { valorAlVencimiento } = require('./pin_dominante');

/**
 * Precio de la mariposa, como precioMariposa() del PIN pero SIN exigir bid > 0 en
 * las alas compradas. A ultima hora el ala lejana suele quedar en bid 0 y la
 * mariposa se cierra igual —se vende el ala a 0 y se recompran las cortas al ask—;
 * exigir bid > 0 dejaba el natural en null justo en la foto de las 15:30, que es lo
 * que se quiere medir. Lo que si hace falta:
 *   apertura: bid de las cortas > 0 y ask de las alas > 0
 *   cierre:   ask de las cortas > 0 y bid de las alas >= 0
 */
function precioMariposa(strikes, centro, ala) {
  const en = (k) => (strikes || []).find((s) => s.strike === k);
  const c0 = en(centro), up = en(centro + ala), dn = en(centro - ala);
  if (!c0 || !up || !dn) return null;
  const sc = c0.call || {}, sp = c0.put || {}, lc = up.call || {}, lp = dn.put || {};
  if (![sc.mark, sp.mark, lc.mark, lp.mark].every((x) => x >= 0)) return null;
  const r2 = (x) => Math.round(x * 100) / 100;
  const abre = sc.bid > 0 && sp.bid > 0 && lc.ask > 0 && lp.ask > 0;
  const cierra = sc.ask > 0 && sp.ask > 0 && lc.bid >= 0 && lp.bid >= 0;
  return {
    centro, ala,
    mid: r2(sc.mark + sp.mark - lc.mark - lp.mark),
    aperturaNatural: abre ? r2(sc.bid + sp.bid - lc.ask - lp.ask) : null,
    cierreNatural:   cierra ? r2(sc.ask + sp.ask - lc.bid - lp.bid) : null,
  };
}

const REGLA = {
  version:     'v0',
  entradasET:  [12 * 60, 12 * 60 + 30, 13 * 60, 13 * 60 + 30], // las cuatro que pidio Guillermo
  toleranciaMin: 15,     // si no hubo lectura justo a la hora, se abre en la primera de los 15 min siguientes
  alas:        [10, 15, 20],
  objetivos:   [0.10, 0.15, 0.20, 0.30], // fraccion del credito mid
  marcaET:     15 * 60 + 30,             // la foto de "salir 30 min antes"
  pasoStrike:  5,
};

const centroATM = (spot, paso = REGLA.pasoStrike) => Math.round(spot / paso) * paso;

/**
 * ¿Toca abrir ahora la entrada `t`? Solo dentro de [t, t + tolerancia]: una
 * entrada de las 12:30 que se abre a las 14:00 porque el servidor estuvo caido
 * no es la misma apuesta, y se pierde en vez de falsearse.
 */
function tocaAbrir(entradaMin, minET, yaAbiertas, regla = REGLA) {
  return !yaAbiertas.includes(entradaMin) && minET >= entradaMin && minET <= entradaMin + regla.toleranciaMin;
}

/**
 * Mariposa recien abierta. `fly` es precioMariposa() en el centro. El objetivo se
 * mide contra el credito MID (lo que se ve en pantalla); el natural dice si se
 * habria podido cobrar.
 */
function abrirMariposa(fly, regla = REGLA) {
  if (!fly || !(fly.mid > 0)) return null;
  const toques = {};
  for (const o of regla.objetivos) toques[String(o)] = { mid: null, natural: null };
  return {
    ala: fly.ala, creditoMid: fly.mid, creditoNatural: fly.aperturaNatural,
    riesgoMaxUSD: Math.round((fly.ala - fly.mid) * 100),
    toques, en1530: null, ultimo: null,
  };
}

/**
 * Una lectura mas. Apunta la PRIMERA vez que se toca cada objetivo:
 *   mid     — creditoMid − mid           >= objetivo × creditoMid
 *   natural — creditoMid − cierreNatural >= objetivo × creditoMid
 * El natural supone que la entrada lleno al mid (orden limite paciente) y que la
 * salida cruza los cuatro spreads: es la ganancia que de verdad se habria cobrado.
 * Muta `m` y la devuelve.
 */
function actualizarMariposa(m, fly, { minET, at, spot }, regla = REGLA) {
  if (!m || !fly || fly.mid == null) return m;
  for (const o of regla.objetivos) {
    const meta = o * m.creditoMid;
    const tq = m.toques[String(o)];
    if (!tq.mid && m.creditoMid - fly.mid >= meta) tq.mid = { at, minET, mid: fly.mid, spot };
    if (!tq.natural && fly.cierreNatural != null && m.creditoMid - fly.cierreNatural >= meta) {
      tq.natural = { at, minET, cierreNatural: fly.cierreNatural, spot };
    }
  }
  const foto = { at, minET, spot, mid: fly.mid, cierreNatural: fly.cierreNatural };
  if (!m.en1530 && minET >= regla.marcaET) m.en1530 = foto;
  m.ultimo = foto;
  return m;
}

/**
 * P&L en dolares por contrato de las tres salidas, con lo que haya:
 *   objetivo    — si toco (al natural) el objetivo `o`, lo que se cobra
 *   a1530       — recomprando a las 15:30 al natural
 *   vencimiento — con el spot de la ultima lectura (>= 15:55) contra el centro
 * null donde falte el dato. Sin comisiones: se restan al analizar, una vez.
 */
function resultados(m, centro, regla = REGLA) {
  if (!m) return null;
  const usd = (x) => (x == null ? null : Math.round(x * 100));
  const out = { objetivo: {} };
  for (const o of regla.objetivos) {
    out.objetivo[String(o)] = m.toques[String(o)]?.natural ? usd(m.creditoMid - m.toques[String(o)].natural.cierreNatural) : null;
  }
  out.a1530 = m.en1530?.cierreNatural != null ? usd(m.creditoMid - m.en1530.cierreNatural) : null;
  out.vencimiento = m.ultimo && m.ultimo.minET >= 15 * 60 + 55
    ? usd(m.creditoMid - valorAlVencimiento(m.ultimo.spot, centro, m.ala)) : null;
  return out;
}

module.exports = { REGLA, centroATM, tocaAbrir, abrirMariposa, actualizarMariposa, resultados, precioMariposa };
