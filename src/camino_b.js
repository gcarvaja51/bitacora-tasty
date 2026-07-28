'use strict';

// ── Camino B: puerto fiel de CIARG_V1 (Pine) — a diferencia de Camino A
// (retroceso clasico, entryUpT/entryDnT), Camino B NO exige que el precio haya
// retrocedido bajo la EMA10 — solo exige que la alineacion (Trend Magic +
// SlingShot + estado del MACD + marco 15m) este activa. Es la unica logica de
// entrada que dispara alert() en Pine hoy (Camino A se desactivo tras el
// backtest de 58 dias: 48.8% WR vs 67.8% WR de Camino B) — ver CLAUDE.md.
//
// Construido 2026-07-24 para eliminar la dependencia de que TradingView mande
// el webhook: este modulo permite que el propio servidor calcule la señal de
// entrada, con los mismos datos frescos de Tradier ya usados para el gate de
// confluencia (ver src/tradier.js:getTimesales).
//
// 2026-07-28: se elimino el throttle de tiempo (gapMinutes_B en Pine, 10 min
// entre disparos de la misma direccion) que este modulo tenia al principio —
// a pedido explicito del usuario, la unica razon real para no evaluar de nuevo
// es que YA hay una posicion SPXW abierta/en curso (chequeo que ahora corre al
// inicio de checkDirectionalAutonomous(), server.js, antes de llamar aca). Un
// timer fijo en paralelo a ese chequeo de posicion podia bloquear minutos de
// mas incluso cuando NINGUNA posicion real estaba abierta (señal rechazada por
// score, error al enviar la orden, orden que nunca llego a llenarse) — bug
// real encontrado ese mismo dia, primero a nivel de throttle-vs-SCORE_FAIL,
// despues (esta vuelta) a nivel de throttle-vs-posicion-realmente-abierta.
const { calcMagicTrend, calcCCI, calcATR } = require('./camino_a');
const { calcEMAArray } = require('./spx_indicators');

// Marco maestro 15m — misma formula que fase2_15m_B/fase4_15m_B en Pine: EMA10 >
// EMA20, precio > EMA20, EMA20 subiendo (o el espejo bajista). Sin banda de
// "neutral" — a diferencia de calcWeinstein() de server.js, que SI tiene una banda
// ±1% pensada para clasificar 4 fases; esa banda es la causa del bug documentado
// el 2026-07-24 en 2 minutos (el precio casi nunca se aleja 1% de su propia EMA20
// de 40min, tienda o no, asi que quedaba "atascado" en Fase 1 con el mercado
// realmente en tendencia). Pine nunca tuvo ese problema porque nunca clasifico un
// estado "neutral" — solo pregunta si la alineacion alcista/bajista esta activa.
function calcFase15mSimple(closes15) {
  if (!closes15 || closes15.length < 21) return { bull: false, bear: false };
  const ema10 = calcEMAArray(closes15, 10);
  const ema20 = calcEMAArray(closes15, 20);
  const i = closes15.length - 1, prev = i - 1;
  if (ema10[i] == null || ema20[i] == null || ema20[prev] == null) return { bull: false, bear: false };
  const price = closes15[i];
  const ema20Rising = ema20[i] > ema20[prev];
  return {
    bull: price > ema20[i] && ema10[i] > ema20[i] && ema20Rising,
    bear: price < ema20[i] && ema10[i] < ema20[i] && !ema20Rising,
  };
}

// bars2m: [{high,low,close}, ...] cronologico, ideal 40+ barras de warmup.
// closes15m: array de cierres de 15m, cronologico.
function calcCaminoB(bars2m, closes15m) {
  if (!bars2m || bars2m.length < 35) {
    return { bull: false, bear: false, coreAlignBull: false, coreAlignBear: false, reason: 'Historial insuficiente (2m)' };
  }

  const closes2m = bars2m.map(b => b.close);
  const ema10_2m = calcEMAArray(closes2m, 10);
  const ema20_2m = calcEMAArray(closes2m, 20);
  const cciArr   = calcCCI(bars2m, 20);
  const atrArr   = calcATR(bars2m, 5);
  const magicTrend = calcMagicTrend(bars2m, cciArr, atrArr);

  const ema12 = calcEMAArray(closes2m, 12);
  const ema26 = calcEMAArray(closes2m, 26);
  const macdLineFull = ema12.map((v, i) => (v != null && ema26[i] != null) ? +(v - ema26[i]).toFixed(4) : null);
  const firstValid = macdLineFull.findIndex(v => v != null);
  const macdSignalFull = new Array(macdLineFull.length).fill(null);
  if (firstValid >= 0) {
    const valid = macdLineFull.slice(firstValid);
    const sig = calcEMAArray(valid, 9);
    sig.forEach((v, j) => { macdSignalFull[firstValid + j] = v; });
  }

  const i = bars2m.length - 1;
  if (ema10_2m[i] == null || ema20_2m[i] == null || magicTrend[i] == null ||
      macdLineFull[i] == null || macdSignalFull[i] == null) {
    return { bull: false, bear: false, coreAlignBull: false, coreAlignBear: false, reason: 'Datos insuficientes (warmup 2m)' };
  }

  const fase15 = calcFase15mSimple(closes15m);
  const close2m = closes2m[i];

  // coreAlign_bull_B / coreAlign_bear_B — identico a Pine: precio vs MagicTrend,
  // alineacion EMA10/EMA20 (sin retroceso), ESTADO del MACD (linea vs señal, no
  // pendiente bar-a-bar — Pine lo cambio a proposito por ser demasiado ruidosa),
  // y marco maestro 15m.
  const coreAlignBull = close2m > magicTrend[i] && ema10_2m[i] > ema20_2m[i] && macdLineFull[i] > macdSignalFull[i] && fase15.bull;
  const coreAlignBear = close2m < magicTrend[i] && ema10_2m[i] < ema20_2m[i] && macdLineFull[i] < macdSignalFull[i] && fase15.bear;

  // bull/bear = coreAlignBull/coreAlignBear directo -- sin throttle de tiempo
  // (ver nota arriba). El unico gate real contra redisparar en cada vela
  // mientras la alineacion se sostiene es la exclusividad de posicion
  // (checkDirectionalAutonomous en server.js): una vez que una señal se
  // convierte en operacion real, esa posicion abierta bloquea cualquier nueva
  // evaluacion hasta que cierre -- no hace falta un timer aparte.
  return {
    bull: coreAlignBull, bear: coreAlignBear, coreAlignBull, coreAlignBear,
    reason: coreAlignBull ? 'Camino B alcista — alineación activa (Trend Magic + SlingShot + MACD + 15m)'
      : coreAlignBear ? 'Camino B bajista — alineación activa (Trend Magic + SlingShot + MACD + 15m)'
      : 'Sin alineación Camino B',
  };
}

module.exports = { calcCaminoB, calcFase15mSimple };
