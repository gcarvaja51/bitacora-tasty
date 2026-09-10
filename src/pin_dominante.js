'use strict';

// ── PIN POR STRIKE DOMINANTE — detector en MODO SOMBRA (2026-09-10) ─────────
//
// SOLO ANALISIS. Esto no manda ni una orden: decide si el setup habria entrado,
// y a partir de ahi apunta el precio real de la mariposa hasta la salida. Existe
// para juntar muestra con precios de la cadena en vez de con un modelo.
//
// POR QUE EXISTE. El 10-sep-2026 el strike 7600 domino toda la manana en el 0DTE
// (1,8-2,1x el segundo en gamma ABSOLUTA, ver gexAbsPorStrike en src/spx.js) y el
// precio se quedo pegado a el. Ninguna pieza del sistema podia operarlo: el Iron
// Condor por PIN y la neutral del premercado exigen gamma POSITIVO (fue NEGATIVO),
// y la neutral se centra en el Max Pain, que estaba a 65 pts.
//
// LA REGLA SALE DE TRES DIAS (8, 9 y 10-sep): esta escrita para que el 9-sep no
// dispare y el 10-sep si. Eso es como se construyo, no una validacion. Los
// umbrales son un punto de partida y viven aca, no en spx_config, precisamente
// porque no deciden dinero. Estudio completo:
//   mentoria alejandro/estrategias automatizadas/07_pinning/README.md §6
//
// Unidades (gotcha 3): creditos y marks de la mariposa en PRECIO POR ACCION;
// objetivo, stop y P&L en DOLARES por contrato.

const REGLA = {
  version:          'v0',
  ventanaEntradaET: [10 * 60, 13 * 60 + 30], // antes: apertura. Despues: gamma de ultima hora (9-sep)
  minDominancia:    1.8,   // mayor / segundo strike
  minDomZona:       2.5,   // mayor / primero a >10 pts — descarta racimos de strikes contiguos
  minMinEstable:    30,    // el mismo strike manda desde hace al menos N minutos
  maxDistPts:       5,     // spot pegado al dominante: el credito es valor temporal, no intrinseco
  ala:              15,
  minCreditoAla:    0.70,  // credito >= 70% del ala => riesgo max <= 30% del ala. Filtra lo tardio
  tpPct:            0.10,  // objetivo: 10% del credito (Guillermo)
  stopUSD:          150,
  salidaET:         15 * 60,
};

// Precio de un Iron Butterfly: vende call y put del centro, compra las alas.
//   mid            — credito al medio
//   aperturaNatural— lo que se cobraria vendiendo a bid y comprando a ask
//   cierreNatural  — lo que costaria recomprarla cruzando los cuatro spreads
// null si falta una pata. Las puntas (bid/ask) son opcionales: sin ellas sale
// solo el mid, y el natural queda en null en vez de inventarse.
function precioMariposa(strikes, centro, ala = REGLA.ala) {
  const en = (k) => (strikes || []).find((s) => s.strike === k);
  const c0 = en(centro), up = en(centro + ala), dn = en(centro - ala);
  if (!c0 || !up || !dn) return null;
  const sc = c0.call || {}, sp = c0.put || {}, lc = up.call || {}, lp = dn.put || {};
  if (![sc.mark, sp.mark, lc.mark, lp.mark].every((x) => x >= 0)) return null;
  const r2 = (x) => Math.round(x * 100) / 100;
  const puntas = [sc, sp, lc, lp].every((x) => x.bid > 0 && x.ask > 0);
  return {
    centro, ala,
    mid: r2(sc.mark + sp.mark - lc.mark - lp.mark),
    aperturaNatural: puntas ? r2(sc.bid + sp.bid - lc.ask - lp.ask) : null,
    cierreNatural:   puntas ? r2(sc.ask + sp.ask - lc.bid - lp.bid) : null,
  };
}

/**
 * ¿Entraria ahora?
 *   dom        — salida de dominanciaRejilla() sobre la rejilla del 0DTE
 *   minEstable — minutos que lleva ese mismo strike como dominante
 *   spot, minET, fly (precioMariposa en el strike dominante)
 * Devuelve { ok, checks, motivo }. `checks` viaja entero al registro: sirve para
 * saber despues POR QUE no disparo un dia, no solo que no disparo.
 */
function evaluarEntrada({ dom, minEstable, spot, minET, fly }, regla = REGLA) {
  if (!dom || !(spot > 1000)) return { ok: false, checks: null, motivo: 'sin rejilla o sin spot' };
  const checks = {
    ventana:    minET >= regla.ventanaEntradaET[0] && minET <= regla.ventanaEntradaET[1],
    dominancia: dom.dominancia >= regla.minDominancia,
    zona:       (dom.dominanciaZona ?? 0) >= regla.minDomZona,
    estable:    (minEstable ?? 0) >= regla.minMinEstable,
    cerca:      Math.abs(spot - dom.strike) <= regla.maxDistPts,
    credito:    fly?.mid != null && fly.mid / regla.ala >= regla.minCreditoAla,
  };
  const fallan = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  return { ok: fallan.length === 0, checks, motivo: fallan.length ? `falla: ${fallan.join(', ')}` : 'entra' };
}

// Objetivo y stop en dolares por contrato, fijados al abrir.
function nivelesDeSalida(creditoMid, regla = REGLA) {
  return {
    objetivoUSD: Math.round(regla.tpPct * creditoMid * 100 * 100) / 100,
    stopUSD: regla.stopUSD,
    salidaET: regla.salidaET,
  };
}

/**
 * ¿Sale ahora? trade = { creditoMid, objetivoUSD, stopUSD, salidaET }.
 * El P&L que decide es el del MID —el mismo criterio del estudio—; el natural se
 * apunta al lado para saber cuanto se come el cruce.
 */
function evaluarSalida(trade, { flyMid, minET }) {
  if (flyMid == null) return { salir: false, pnlMid: null, motivo: 'sin precio de la mariposa' };
  const pnlMid = Math.round((trade.creditoMid - flyMid) * 100 * 100) / 100;
  if (pnlMid <= -trade.stopUSD)     return { salir: true, pnlMid, motivo: 'STOP' };
  if (pnlMid >= trade.objetivoUSD)  return { salir: true, pnlMid, motivo: 'OBJETIVO' };
  if (minET >= trade.salidaET)      return { salir: true, pnlMid, motivo: 'TIEMPO' };
  return { salir: false, pnlMid, motivo: null };
}

// Valor al vencimiento, por si una mariposa llegara abierta a la campana (no
// deberia: la salida por tiempo es a las 15:00). Por accion.
function valorAlVencimiento(spot, centro, ala) {
  return Math.min(Math.abs(spot - centro), ala);
}

module.exports = { REGLA, precioMariposa, evaluarEntrada, nivelesDeSalida, evaluarSalida, valorAlVencimiento };
