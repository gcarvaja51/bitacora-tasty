'use strict';

// ── Indicadores técnicos para SPX Signal Center ───────────────
// Calcula EMAs, MACD, volumen SPY y score del Playbook

// ── EMA ───────────────────────────────────────────────────────
function calcEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return +ema.toFixed(4);
}

// ── MACD (12, 26, 9) ─────────────────────────────────────────
function calcMACD(prices) {
  if (!prices || prices.length < 35) return null;
  
  const ema12 = calcEMAArray(prices, 12);
  const ema26 = calcEMAArray(prices, 26);
  
  const macdLine = ema12.map((v, i) => v !== null && ema26[i] !== null ? +(v - ema26[i]).toFixed(4) : null).filter(v => v !== null);
  const signalLine = calcEMAArray(macdLine, 9);
  
  const last  = macdLine[macdLine.length - 1];
  const prev  = macdLine[macdLine.length - 2];
  const sig   = signalLine[signalLine.length - 1];
  const sigPrev = signalLine[signalLine.length - 2];
  const hist  = last !== null && sig !== null ? +(last - sig).toFixed(4) : null;
  const histPrev = prev !== null && sigPrev !== null ? +(prev - sigPrev).toFixed(4) : null;

  return {
    macd:      last,
    signal:    sig,
    histogram: hist,
    histPrev,
    bullishCross: prev < sigPrev && last > sig,   // cruce alcista
    bearishCross: prev > sigPrev && last < sig,   // cruce bajista
    bullish: last > sig,
    bearish: last < sig,
    slope:   hist !== null && histPrev !== null ? hist - histPrev : 0,
  };
}

function calcEMAArray(prices, period) {
  const result = new Array(prices.length).fill(null);
  if (prices.length < period) return result;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = +ema.toFixed(4);
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    result[i] = +ema.toFixed(4);
  }
  return result;
}

// ── Distancia precio vs EMA (% de extensión) ─────────────────
function priceExtension(price, ema) {
  if (!ema || !price) return null;
  return +((price - ema) / ema * 100).toFixed(2);
}

// ── Volumen SPY relativo ──────────────────────────────────────
function calcRelativeVolume(volumes, currentVol, lookback = 20) {
  if (!volumes || volumes.length < lookback) return null;
  const avg = volumes.slice(-lookback).reduce((a, b) => a + b, 0) / lookback;
  return avg > 0 ? +(currentVol / avg).toFixed(2) : null;
}

// ── Score del Playbook ────────────────────────────────────────
function calcPlaybookScore(indicators, config) {
  const weights = config.weights || {};
  const checks  = [];
  let totalWeight = 0;
  let score = 0;

  const dir = indicators.direction; // BULLISH | BEARISH

  // ── Mundo 1: Dirección ────────────────────────────────────

  // 1. Precio vs EMA 200 diario (Fase Weinstein)
  const w1 = weights.precio_ema200 ?? 15;
  totalWeight += w1;
  const ext200 = indicators.daily?.ext200;
  const precio_ema200_ok = dir === 'BULLISH' ? ext200 > 0 : ext200 < 0;
  checks.push({
    id:      'precio_ema200',
    label:   'Precio vs EMA 200 diario',
    mundo:   1,
    weight:  w1,
    ok:      precio_ema200_ok,
    value:   ext200 !== null ? `${ext200 > 0 ? '+' : ''}${ext200}%` : '—',
    reason:  precio_ema200_ok ? 'Precio sobre EMA 200 ✅' : 'Precio bajo EMA 200 ❌',
  });
  if (precio_ema200_ok) score += w1;

  // 2. EMAs alineadas en diario (10 > 20 > 50 para alcista)
  const w2 = weights.emas_alineadas_diario ?? 15;
  totalWeight += w2;
  const d = indicators.daily || {};
  const emas_diario_ok = dir === 'BULLISH'
    ? d.ema10 > d.ema20 && d.ema20 > d.ema50
    : d.ema10 < d.ema20 && d.ema20 < d.ema50;
  checks.push({
    id:      'emas_alineadas_diario',
    label:   'EMAs alineadas diario (10>20>50)',
    mundo:   1,
    weight:  w2,
    ok:      emas_diario_ok,
    value:   `EMA10:${d.ema10} EMA20:${d.ema20} EMA50:${d.ema50}`,
    reason:  emas_diario_ok ? 'EMAs diario alineadas ✅' : 'EMAs diario no alineadas ❌',
  });
  if (emas_diario_ok) score += w2;

  // 3. EMAs alineadas en 15m
  const w3 = weights.emas_alineadas_15m ?? 15;
  totalWeight += w3;
  const m = indicators.m15 || {};
  const emas_15m_ok = dir === 'BULLISH'
    ? m.ema10 > m.ema20
    : m.ema10 < m.ema20;
  checks.push({
    id:      'emas_alineadas_15m',
    label:   'EMAs alineadas 15m (10 vs 20)',
    mundo:   1,
    weight:  w3,
    ok:      emas_15m_ok,
    value:   `EMA10:${m.ema10} EMA20:${m.ema20}`,
    reason:  emas_15m_ok ? 'EMAs 15m alineadas ✅' : 'EMAs 15m no alineadas ❌',
  });
  if (emas_15m_ok) score += w3;

  // ── Mundo 3: Fuerza ───────────────────────────────────────

  // 4. MACD alineado en 15m
  const w4 = weights.macd_alineado_15m ?? 20;
  totalWeight += w4;
  const macd = indicators.m15?.macd || {};
  const macd_ok = dir === 'BULLISH' ? macd.bullish : macd.bearish;
  checks.push({
    id:      'macd_alineado_15m',
    label:   'MACD alineado 15m',
    mundo:   3,
    weight:  w4,
    ok:      macd_ok,
    value:   `MACD:${macd.macd} Signal:${macd.signal} Hist:${macd.histogram}`,
    reason:  macd_ok
      ? `MACD ${dir === 'BULLISH' ? 'sobre' : 'bajo'} signal ✅`
      : `MACD no alineado con dirección ❌`,
  });
  if (macd_ok) score += w4;

  // 5. Precio cerca de EMA 10 o 20 en 15m (no extendido)
  const w5 = weights.precio_cerca_ema ?? 15;
  totalWeight += w5;
  const ext10_15m = indicators.m15?.ext10;
  const ext20_15m = indicators.m15?.ext20;
  const MAX_EXT = 1.5; // máximo 1.5% de extensión
  const cerca_ema_ok = ext10_15m !== null && ext20_15m !== null &&
    (Math.abs(ext10_15m) <= MAX_EXT || Math.abs(ext20_15m) <= MAX_EXT);
  checks.push({
    id:      'precio_cerca_ema',
    label:   'Precio cerca EMA 10/20 en 15m',
    mundo:   3,
    weight:  w5,
    ok:      cerca_ema_ok,
    value:   `Ext10:${ext10_15m}% Ext20:${ext20_15m}%`,
    reason:  cerca_ema_ok
      ? 'Precio partiendo desde EMAs ✅'
      : `Precio extendido (>${MAX_EXT}%) — esperar retroceso ❌`,
  });
  if (cerca_ema_ok) score += w5;

  // 6. Volumen SPY > 2x promedio
  const w6 = weights.volumen_spy ?? 10;
  totalWeight += w6;
  const relVol = indicators.spy?.relativeVolume;
  const volumen_ok = relVol !== null && relVol >= 2;
  checks.push({
    id:      'volumen_spy',
    label:   'Volumen SPY > 2x promedio',
    mundo:   3,
    weight:  w6,
    ok:      volumen_ok,
    value:   relVol !== null ? `${relVol}x` : '—',
    reason:  volumen_ok
      ? `Volumen institucional confirmado (${relVol}x) ✅`
      : `Volumen insuficiente (${relVol}x < 2x) ❌`,
  });
  if (volumen_ok) score += w6;

  // 7. GEX compatible con dirección
  const w7 = weights.gex_compatible ?? 10;
  totalWeight += w7;
  const regime = indicators.gammaRegime;
  const gammaFlip = indicators.gammaFlip;
  const spxPrice  = indicators.spxPrice;
  let gex_ok = false;
  let gex_reason = '—';

  if (regime === 'POSITIVO') {
    // Gamma positivo: mercado estabilizador — mejor para créditos/Iron Condor
    gex_ok = true;
    gex_reason = 'Gamma positivo — mercado estabilizador ✅';
  } else if (regime === 'NEGATIVO') {
    // Gamma negativo: movimiento explosivo — ok para débitos direccionales
    if (dir === 'BULLISH' && gammaFlip && spxPrice > gammaFlip) {
      gex_ok = true;
      gex_reason = `Precio (${spxPrice}) sobre Gamma Flip (${gammaFlip}) ✅`;
    } else if (dir === 'BEARISH' && gammaFlip && spxPrice < gammaFlip) {
      gex_ok = true;
      gex_reason = `Precio (${spxPrice}) bajo Gamma Flip (${gammaFlip}) ✅`;
    } else {
      gex_reason = `Gamma negativo pero precio no confirmó flip (${gammaFlip}) ❌`;
    }
  }

  checks.push({
    id:      'gex_compatible',
    label:   'GEX compatible con dirección',
    mundo:   3,
    weight:  w7,
    ok:      gex_ok,
    value:   `Regime:${regime} Flip:${gammaFlip}`,
    reason:  gex_reason,
  });
  if (gex_ok) score += w7;

  const pct = totalWeight > 0 ? +(score / totalWeight * 100).toFixed(1) : 0;
  const minScore = config.minScore ?? 75;

  return {
    score: pct,
    passed: pct >= minScore,
    minScore,
    checks,
    mundo1: checks.filter(c => c.mundo === 1),
    mundo3: checks.filter(c => c.mundo === 3),
  };
}

module.exports = { calcEMA, calcEMAArray, calcMACD, priceExtension, calcRelativeVolume, calcPlaybookScore };
