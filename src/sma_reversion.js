'use strict';

// ── Alejamiento de SMA — setup de reversión a la media (playbook Luis Silva,
// Sigma Trade). El precio se estira lejos de la SMA8 ("el imán técnico") y
// se opera el regreso. Tres patrones de confirmación posibles — basta con
// que UNO confirme, no hace falta que los tres coincidan a la vez.
const { calcSMAArray } = require('./spx_indicators');
const { calcATR } = require('./camino_a');

// ── Vela García: SMA8 se aplana y "engancha" curvando hacia un cruce con
// SMA20 — se detecta comparando la pendiente de SMA8 barra a barra (se
// desacelera y cambia de sentido) mientras la distancia SMA8-SMA20 se achica.
function detectVelaGarcia(sma8, sma20, direction) {
  const i = sma8.length - 1;
  if (i < 3) return false;
  if ([sma8[i], sma8[i-1], sma8[i-2], sma20[i], sma20[i-2]].some(v => v == null)) return false;

  const slopeNow  = sma8[i]   - sma8[i-1];
  const slopePrev = sma8[i-1] - sma8[i-2];
  const distNow  = Math.abs(sma8[i]   - sma20[i]);
  const distPrev = Math.abs(sma8[i-2] - sma20[i-2]);
  const converging = distNow < distPrev;

  if (direction === 'BULLISH') {
    // Veniamos cayendo (slopePrev<0) y el "ganchito" gira hacia arriba
    return slopePrev < 0 && slopeNow > slopePrev && converging;
  }
  return slopePrev > 0 && slopeNow < slopePrev && converging;
}

// ── Vela Tiburón: rango de la vela muy por encima del ATR reciente (rango >
// 1.8x ATR), cerrando en la mitad de la vela a favor de la reversión —
// indica capitulación/rechazo, no solo volatilidad.
function detectVelaTiburon(bars, atrArr, direction) {
  const i = bars.length - 1;
  if (atrArr[i] == null || !atrArr[i]) return false;
  const range = bars[i].high - bars[i].low;
  if (range <= atrArr[i] * 1.8) return false;
  const mid = (bars[i].high + bars[i].low) / 2;
  return direction === 'BULLISH' ? bars[i].close > mid : bars[i].close < mid;
}

// ── Vela 9 Secuencial: version simplificada del conteo TD Sequential — 9
// cierres consecutivos comparados contra el cierre 4 barras atras, todos en
// la misma direccion de agotamiento (sugiere que la tendencia previa ya dio
// todo lo que tenia y esta lista para revertir).
function detectVela9(bars, direction) {
  const closes = bars.map(b => b.close);
  const n = closes.length;
  if (n < 13) return false;
  for (let i = n - 9; i < n; i++) {
    const exhausted = direction === 'BULLISH' ? closes[i] < closes[i-4] : closes[i] > closes[i-4];
    if (!exhausted) return false;
  }
  return true;
}

// bars: [{high, low, close}, ...] cronologico, 2m, idealmente >=35 barras
function evaluateReversionPattern(bars, direction) {
  if (!bars || bars.length < 25) return { ok: false, pattern: null, reason: 'Historial insuficiente para detectar patrón' };

  const closes = bars.map(b => b.close);
  const sma8  = calcSMAArray(closes, 8);
  const sma20 = calcSMAArray(closes, 20);
  const atr   = calcATR(bars, 14);

  if (detectVelaGarcia(sma8, sma20, direction)) {
    return { ok: true, pattern: 'VELA_GARCIA', reason: 'Vela García — SMA8 aplanándose y enganchando hacia SMA20 ✅' };
  }
  if (detectVelaTiburon(bars, atr, direction)) {
    return { ok: true, pattern: 'VELA_TIBURON', reason: 'Vela Tiburón — rango amplio con rechazo a favor de la reversión ✅' };
  }
  if (detectVela9(bars, direction)) {
    return { ok: true, pattern: 'VELA_9', reason: 'Vela 9 Secuencial — agotamiento confirmado (9 cierres) ✅' };
  }
  return { ok: false, pattern: null, reason: 'Ningún patrón de confirmación (García/Tiburón/9) presente ❌' };
}

module.exports = { evaluateReversionPattern, detectVelaGarcia, detectVelaTiburon, detectVela9 };
