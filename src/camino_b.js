'use strict';

// ── Camino B: puerto fiel de CIARG_V1 (Pine) — a diferencia de Camino A
// (retroceso clasico, entryUpT/entryDnT), Camino B NO exige que el precio haya
// retrocedido bajo la EMA10 — solo exige que la alineacion (Trend Magic +
// SlingShot + estado del MACD + marco 15m) este activa, con un throttle de
// tiempo minimo entre disparos (gapMinutes, default 10 = el input real de Pine)
// para no repetir en cada vela mientras la alineacion se sostenga. Es la unica
// logica de entrada que dispara alert() en Pine hoy (Camino A se desactivo tras
// el backtest de 58 dias: 48.8% WR vs 67.8% WR de Camino B) — ver CLAUDE.md.
//
// Construido 2026-07-24 para eliminar la dependencia de que TradingView mande
// el webhook: este modulo permite que el propio servidor calcule la señal de
// entrada, con los mismos datos frescos de Tradier ya usados para el gate de
// confluencia (ver src/tradier.js:getTimesales).
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
// state: {lastFireBullAt, lastFireBearAt} en ms epoch — SOLO LECTURA aca adentro
// (2026-07-28: la mutacion se movio a markCaminoBFired(), llamada por el caller
// solo cuando la señal se ejecuta de verdad, ver nota mas abajo). Equivalente a
// 'var lastFireBull_B' de Pine, pero por tiempo real en vez de bar_index ya que
// este chequeo no corre exactamente una vez por vela.
// nowMs: opcional, para poder simular/backtestear (el throttle usaria Date.now()
// real, que en un loop de simulacion rapido queda practicamente constante y
// bloquea casi todo despues del primer disparo — bug de arnes de prueba
// encontrado 2026-07-25, no de la logica en si, que en produccion (llamada real
// cada 30-60s) funciona bien con Date.now()).
function calcCaminoB(bars2m, closes15m, state, gapMinutes = 10, nowMs = null) {
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

  const now = nowMs ?? Date.now();
  const gapMs = gapMinutes * 60 * 1000;
  const enoughGapBull = !state.lastFireBullAt || (now - state.lastFireBullAt) >= gapMs;
  const enoughGapBear = !state.lastFireBearAt || (now - state.lastFireBearAt) >= gapMs;

  const bull = coreAlignBull && enoughGapBull;
  const bear = coreAlignBear && enoughGapBear;

  // 2026-07-28: el throttle YA NO se consume aca adentro (bug real encontrado el
  // mismo dia con un caso en vivo: Camino B disparo a las 11:29am, el score dio
  // 75% -- insuficiente, SCORE_FAIL, ningun trade -- pero como el timestamp ya
  // habia quedado marcado, el sistema no pudo reintentar hasta las 11:39am,
  // diez minutos despues, aunque en el medio no hubo ninguna posicion abierta
  // que justificara esa espera. El proposito del throttle es evitar redisparar
  // en cada vela DESPUES de una señal que si se convirtio en operacion, no
  // penalizar un intento que nunca llego a ejecutarse. Ahora el caller decide
  // cuando consumir el throttle, llamando a markCaminoBFired() SOLO si la señal
  // realmente se construyo (ver processDirectionalEntry en server.js).
  return {
    bull, bear, coreAlignBull, coreAlignBear,
    reason: bull ? 'Camino B alcista — alineación fresca (Trend Magic + SlingShot + MACD + 15m)'
      : bear ? 'Camino B bajista — alineación fresca (Trend Magic + SlingShot + MACD + 15m)'
      : (coreAlignBull || coreAlignBear) ? 'Alineación activa pero dentro del gap mínimo entre señales (throttle)'
      : 'Sin alineación Camino B',
  };
}

// Consume el throttle -- llamar SOLO cuando la señal realmente se construyo
// (processDirectionalEntry llego a SIGNAL_BUILT), nunca en un SCORE_FAIL/
// STRATEGY_INVALID/NO_STRIKES. Antes esto vivia como efecto secundario dentro
// de calcCaminoB() y se disparaba con solo detectar la alineacion, sin importar
// si el score despues rechazaba la señal.
function markCaminoBFired(state, direction, nowMs = null) {
  const now = nowMs ?? Date.now();
  if (direction === 'BULLISH') state.lastFireBullAt = now;
  else if (direction === 'BEARISH') state.lastFireBearAt = now;
}

module.exports = { calcCaminoB, calcFase15mSimple, markCaminoBFired };
