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
// 1.8x ATR), con cuerpo sólido (mechas chicas) cerrando a favor de la
// reversión — indica fuerza institucional real, no solo volatilidad.
// Ajuste 2026-07-23 (a pedido del usuario, tras revisar el concepto ampliado
// de Luis Sigma): antes solo exigiamos "cierre en la mitad a favor", lo que
// dejaba pasar velas de mecha larga (rechazo) que el propio material dice que
// INVALIDAN el patron. Ahora se exige cuerpo >= 60% del rango (mecha chica) Y
// se gradua la confianza en 3 niveles en vez de un solo si/no:
//   - Base (78%): cuerpo solido + rango amplio + cierre a favor.
//   - + rompe SMA20 (88%): ademas el cierre cruza la SMA20 a favor de la reversion.
//   - Martillo escondido (91%): patron alternativo -- cuerpo CHICO con mecha
//     larga de rechazo (lo opuesto al Tiburon "elefante"), pero lejos de la
//     SMA8 (>=1.5x ATR) -- Luis lo llama "Tiburon escondida", la probabilidad
//     mas alta de las tres variantes.
// Requiere `open` en las barras (agregado en buildSPXContext, server.js) para
// medir el cuerpo real -- si falta (dato viejo/incompleto), no se puede medir
// solidez y el patron base no dispara (fallo seguro, no se inventa un cuerpo).
function detectVelaTiburon(bars, atrArr, sma8, sma20, direction) {
  const i = bars.length - 1;
  const atr = atrArr[i];
  if (!atr) return { ok: false };
  const bar = bars[i];
  const range = bar.high - bar.low;
  if (range <= 0) return { ok: false };
  const mid = (bar.high + bar.low) / 2;
  const cierreAFavor = direction === 'BULLISH' ? bar.close > mid : bar.close < mid;
  if (!cierreAFavor) return { ok: false };

  const tieneOpen = bar.open != null;
  const body = tieneOpen ? Math.abs(bar.close - bar.open) : null;
  const bodyRatio = body != null ? body / range : null;
  const upperWick = tieneOpen ? bar.high - Math.max(bar.open, bar.close) : null;
  const lowerWick = tieneOpen ? Math.min(bar.open, bar.close) - bar.low : null;

  // Variante 1: Tiburon "elefante" -- rango amplio + cuerpo solido
  const rangoAmplio = range > atr * 1.8;
  const cuerpoSolido = bodyRatio != null && bodyRatio >= 0.6;
  if (rangoAmplio && cuerpoSolido) {
    const sma20Actual = sma20[i];
    const rompeSMA20 = sma20Actual != null &&
      (direction === 'BULLISH' ? bar.close > sma20Actual : bar.close < sma20Actual);
    return rompeSMA20
      ? { ok: true, pattern: 'VELA_TIBURON_SMA20', frac: 0.88, reason: 'Vela Tiburón — rango amplio, cuerpo sólido y rompe SMA20 a favor (88%) ✅' }
      : { ok: true, pattern: 'VELA_TIBURON', frac: 0.78, reason: 'Vela Tiburón — rango amplio con cuerpo sólido, rechazo a favor de la reversión (78%) ✅' };
  }

  // Variante 2: "Tiburon escondida" -- martillo (cuerpo chico, mecha larga de
  // rechazo) lejos de la SMA8. Forma opuesta al elefante, mismo espiritu:
  // rechazo fuerte, pero se detecta por la mecha en vez del cuerpo.
  if (tieneOpen && sma8[i] != null && bodyRatio != null && bodyRatio <= 0.3) {
    const wickFavor = direction === 'BULLISH'
      ? (lowerWick > body * 2 && lowerWick > upperWick)
      : (upperWick > body * 2 && upperWick > lowerWick);
    const distSMA8 = Math.abs(bar.close - sma8[i]);
    const lejosSMA8 = distSMA8 > atr * 1.5;
    if (wickFavor && lejosSMA8) {
      return { ok: true, pattern: 'VELA_TIBURON_MARTILLO', frac: 0.91, reason: 'Martillo alejado de la SMA8 — "Tiburón escondida" (91%) ✅' };
    }
  }

  return { ok: false };
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

// bars: [{high, low, close, open}, ...] cronologico, 2m, idealmente >=35 barras.
// `frac` en el resultado (2026-07-23): antes patron_confirmacion era puro si/no;
// ahora Vela Tiburon viene graduada en 3 niveles de confianza (78/88/91%, segun
// el material de Luis Sigma) y ese `frac` se usa en calcReversionScore para
// pesar el check en vez de sumar el 100% del peso siempre que pase. Garcia y
// Vela 9 se mantienen binarias (frac 1.0) -- el usuario no pidio graduarlas.
function evaluateReversionPattern(bars, direction) {
  if (!bars || bars.length < 25) return { ok: false, pattern: null, frac: 0, reason: 'Historial insuficiente para detectar patrón' };

  const closes = bars.map(b => b.close);
  const sma8  = calcSMAArray(closes, 8);
  const sma20 = calcSMAArray(closes, 20);
  const atr   = calcATR(bars, 14);

  if (detectVelaGarcia(sma8, sma20, direction)) {
    return { ok: true, pattern: 'VELA_GARCIA', frac: 1.0, reason: 'Vela García — SMA8 aplanándose y enganchando hacia SMA20 ✅' };
  }
  const tiburon = detectVelaTiburon(bars, atr, sma8, sma20, direction);
  if (tiburon.ok) return tiburon;
  if (detectVela9(bars, direction)) {
    return { ok: true, pattern: 'VELA_9', frac: 1.0, reason: 'Vela 9 Secuencial — agotamiento confirmado (9 cierres) ✅' };
  }
  return { ok: false, pattern: null, frac: 0, reason: 'Ningún patrón de confirmación (García/Tiburón/9) presente ❌' };
}

module.exports = { evaluateReversionPattern, detectVelaGarcia, detectVelaTiburon, detectVela9 };
