'use strict';

// ── Camino A: retroceso clásico (Trend Magic CCI+ATR + SlingShot EMA10/20 +
// pendiente MACD), igual que la lógica de CIARG_V1 en Pine. Puerto de la
// misma logica que ya vive en el backtester (public/index.html, btCCI/btATR/
// magicTrend/longConditionA/shortConditionA) para poder usarla server-side
// como una confirmación más del score (no como gatillo — el backtest de 58
// dias mostro que Camino A solo, como gatillo, es perdedor neto: 48.8% WR,
// -$130 en 41 señales, por eso esta desactivado como disparador en Pine).
const { calcEMAArray } = require('./spx_indicators');

function calcCCI(bars, period) {
  const tp = bars.map(b => (b.high + b.low + b.close) / 3);
  const out = new Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i++) {
    if (i < period - 1) continue;
    const slice = tp.slice(i - period + 1, i + 1);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    const meanDev = slice.reduce((a, b) => a + Math.abs(b - sma), 0) / period;
    out[i] = meanDev === 0 ? 0 : (tp[i] - sma) / (0.015 * meanDev);
  }
  return out;
}

function calcATR(bars, period) {
  const tr = bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
  const out = new Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i++) {
    if (i < period - 1) continue;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += tr[j];
    out[i] = sum / period;
  }
  return out;
}

function calcMagicTrend(bars, cciArr, atrArr) {
  const magicTrend = new Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i++) {
    if (cciArr[i] == null || atrArr[i] == null) continue;
    const upT   = bars[i].low  - atrArr[i];
    const downT = bars[i].high + atrArr[i];
    const prev  = magicTrend[i - 1];
    if (cciArr[i] >= 0) magicTrend[i] = (prev != null && upT   < prev) ? prev : upT;
    else                magicTrend[i] = (prev != null && downT > prev) ? prev : downT;
  }
  return magicTrend;
}

// bars: [{high, low, close}, ...] cronológico (2m), idealmente >=40 barras de warmup
function calcCaminoA(bars) {
  if (!bars || bars.length < 35) return { bullish: false, bearish: false, reason: 'Historial insuficiente para Camino A' };

  const closes = bars.map(b => b.close);
  const ema10  = calcEMAArray(closes, 10);
  const ema20  = calcEMAArray(closes, 20);
  const cciArr = calcCCI(bars, 20);
  const atrArr = calcATR(bars, 5);
  const magicTrend = calcMagicTrend(bars, cciArr, atrArr);

  const ema12 = calcEMAArray(closes, 12);
  const ema26 = calcEMAArray(closes, 26);
  const macdLineFull = ema12.map((v, i) => (v != null && ema26[i] != null) ? +(v - ema26[i]).toFixed(4) : null);
  const firstValid = macdLineFull.findIndex(v => v != null);
  const macdSignalFull = new Array(macdLineFull.length).fill(null);
  if (firstValid >= 0) {
    const valid = macdLineFull.slice(firstValid);
    const sig   = calcEMAArray(valid, 9);
    sig.forEach((v, j) => { macdSignalFull[firstValid + j] = v; });
  }

  const i = bars.length - 1, prev = i - 1;
  if (ema10[i] == null || ema20[i] == null || ema10[prev] == null || magicTrend[i] == null ||
      macdLineFull[i] == null || macdSignalFull[i] == null || macdLineFull[prev] == null) {
    return { bullish: false, bearish: false, reason: 'Datos insuficientes para Camino A (warmup)' };
  }

  const entryUp = ema10[i] > ema20[i] && closes[prev] < ema10[prev] && closes[i] > ema10[i];
  const entryDn = ema10[i] < ema20[i] && closes[prev] > ema10[prev] && closes[i] < ema10[i];
  const emaSlope  = ema10[i] - ema10[prev];
  const macdSlope = macdLineFull[i] - macdLineFull[prev];

  const bullish = emaSlope > 0 && closes[i] > magicTrend[i] && entryUp && macdSlope > 0 && macdLineFull[i] > macdSignalFull[i];
  const bearish = emaSlope < 0 && closes[i] < magicTrend[i] && entryDn && macdSlope < 0 && macdLineFull[i] < macdSignalFull[i];

  return {
    bullish, bearish,
    reason: bullish ? 'Retroceso clásico alcista (Trend Magic + SlingShot + MACD) ✅'
      : bearish ? 'Retroceso clásico bajista (Trend Magic + SlingShot + MACD) ✅'
      : 'Camino A no confirma retroceso clásico',
  };
}

module.exports = { calcCaminoA, calcCCI, calcATR, calcMagicTrend };
