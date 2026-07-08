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

// ── SMA (media simple, sin suavizado exponencial) — setup Alejamiento de SMA ──
function calcSMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const slice = prices.slice(prices.length - period);
  return +(slice.reduce((a, b) => a + b, 0) / period).toFixed(4);
}

function calcSMAArray(prices, period) {
  const result = new Array(prices.length).fill(null);
  if (!prices || prices.length < period) return result;
  let sum = prices.slice(0, period).reduce((a, b) => a + b, 0);
  result[period - 1] = +(sum / period).toFixed(4);
  for (let i = period; i < prices.length; i++) {
    sum += prices[i] - prices[i - period];
    result[i] = +(sum / period).toFixed(4);
  }
  return result;
}

// ── RSI (Wilder, 14 periodos por defecto) — antes vivia duplicado 3 veces
// como funcion local en server.js (screener de acciones), movido aca para
// reusarlo tambien en el score de Alejamiento de SMA sin reescribirlo.
function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (period-1) + Math.max(d, 0)) / period;
    al = (al * (period-1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return 100;
  return Math.round((100 - 100 / (1 + ag/al)) * 10) / 10;
}

// ── Volumen SPY relativo ──────────────────────────────────────
function calcRelativeVolume(volumes, currentVol, lookback = 20) {
  if (!volumes || volumes.length < lookback) return null;
  const avg = volumes.slice(-lookback).reduce((a, b) => a + b, 0) / lookback;
  return avg > 0 ? +(currentVol / avg).toFixed(2) : null;
}

// ── Score del Playbook ────────────────────────────────────────
// ── Patrones estructurales: Higher-Low (alcista) / Lower-High (bajista) ──
// A partir del historial de fractales de Williams (15m) — necesita al menos
// 2 fractales confirmados del tipo relevante para poder comparar.
function calcSwingStructure(dir, lowsHistory, highsHistory) {
  if (dir === 'BULLISH') {
    const lows = (lowsHistory || []).filter(v => v != null);
    if (lows.length < 2) return { ok: false, reason: 'Historial de fractales insuficiente para confirmar Higher-Low' };
    const [prev, last] = lows.slice(-2);
    const ok = last > prev;
    return { ok, reason: ok ? `Higher-Low confirmado (${prev} → ${last}) ✅` : `Sin Higher-Low (${prev} → ${last}) ❌`, value: `${prev} → ${last}` };
  }
  if (dir === 'BEARISH') {
    const highs = (highsHistory || []).filter(v => v != null);
    if (highs.length < 2) return { ok: false, reason: 'Historial de fractales insuficiente para confirmar Lower-High' };
    const [prev, last] = highs.slice(-2);
    const ok = last < prev;
    return { ok, reason: ok ? `Lower-High confirmado (${prev} → ${last}) ✅` : `Sin Lower-High (${prev} → ${last}) ❌`, value: `${prev} → ${last}` };
  }
  return { ok: false, reason: 'Sin dirección', value: '—' };
}

function calcPlaybookScore(indicators, config) {
  const weights = config.weights || {};
  const checks  = [];
  let totalWeight = 0;
  let score = 0;

  const dir = indicators.direction; // BULLISH | BEARISH

  // ── Mundo 1: Dirección ────────────────────────────────────

  // 1. Fase Weinstein — 2m y 15m coinciden con la dirección (booleano, todo o nada)
  const w1 = weights.fase_weinstein ?? 40;
  totalWeight += w1;
  const fase2m  = indicators.m2?.weinstein?.fase;
  const fase15m = indicators.m15?.weinstein?.fase;
  const faseObjetivo = dir === 'BULLISH' ? 2 : 4;
  const fase_ok = fase2m === faseObjetivo && fase15m === faseObjetivo;
  checks.push({
    id:      'fase_weinstein',
    label:   'Fase Weinstein (2m + 15m)',
    mundo:   1,
    weight:  w1,
    ok:      fase_ok,
    value:   `2m:Fase${fase2m ?? '—'} 15m:Fase${fase15m ?? '—'}`,
    reason:  fase_ok ? `Fase ${faseObjetivo} confirmada en 2m y 15m ✅` : `Fase Weinstein no confirmada (2m:${fase2m ?? '—'} 15m:${fase15m ?? '—'}) ❌`,
  });
  if (fase_ok) score += w1;

  // 2. Régimen Institucional — GEX compatible con la dirección
  // (DEX pendiente: los datos de delta ya están disponibles en la cadena de
  // opciones pero falta validar en qué dirección favorece cada régimen antes
  // de sumarlo al score de un sistema que ejecuta órdenes reales)
  const w2 = weights.regimen_institucional ?? 10;
  totalWeight += w2;
  const regime    = indicators.gammaRegime;
  const gammaFlip = indicators.gammaFlip;
  const spxPrice  = indicators.spxPrice;
  let regimen_ok = false;
  let regimen_reason = '—';
  if (regime === 'POSITIVO') {
    regimen_ok = true;
    regimen_reason = 'Gamma positivo — mercado estabilizador ✅';
  } else if (regime === 'NEGATIVO') {
    if (dir === 'BULLISH' && gammaFlip && spxPrice > gammaFlip) {
      regimen_ok = true;
      regimen_reason = `Precio (${spxPrice}) sobre Gamma Flip (${gammaFlip}) ✅`;
    } else if (dir === 'BEARISH' && gammaFlip && spxPrice < gammaFlip) {
      regimen_ok = true;
      regimen_reason = `Precio (${spxPrice}) bajo Gamma Flip (${gammaFlip}) ✅`;
    } else {
      regimen_reason = `Gamma negativo pero precio no confirmó flip (${gammaFlip}) ❌`;
    }
  }
  checks.push({
    id:      'regimen_institucional',
    label:   'Régimen Institucional (GEX)',
    mundo:   1,
    weight:  w2,
    ok:      regimen_ok,
    value:   `Regime:${regime} Flip:${gammaFlip}`,
    reason:  regimen_reason,
  });
  if (regimen_ok) score += w2;

  // ── Mundo 2: Trigger ──────────────────────────────────────

  // 3. Patrones estructurales — Higher-Low / Lower-High (fractales 15m)
  const w3 = weights.patrones_estructurales ?? 20;
  totalWeight += w3;
  const swing = calcSwingStructure(dir, indicators.fractal15m?.lowsHistory, indicators.fractal15m?.highsHistory);
  checks.push({
    id:      'patrones_estructurales',
    label:   'Patrón Estructural (HL/LH)',
    mundo:   2,
    weight:  w3,
    ok:      swing.ok,
    value:   swing.value ?? '—',
    reason:  swing.reason,
  });
  if (swing.ok) score += w3;

  // 4. EMAs 10/20 alineadas en 15m y precio no extendido
  const w4 = weights.ema_10_20_alineadas ?? 10;
  totalWeight += w4;
  const m = indicators.m15 || {};
  const emas_15m_ok = dir === 'BULLISH' ? m.ema10 > m.ema20 : m.ema10 < m.ema20;
  const MAX_EXT = 1.5; // máximo 1.5% de extensión
  const cerca_ema_ok = m.ext10 != null && m.ext20 != null &&
    (Math.abs(m.ext10) <= MAX_EXT || Math.abs(m.ext20) <= MAX_EXT);
  const ema_ok = emas_15m_ok && cerca_ema_ok;
  checks.push({
    id:      'ema_10_20_alineadas',
    label:   'EMAs 10/20 alineadas y no extendidas (15m)',
    mundo:   2,
    weight:  w4,
    ok:      ema_ok,
    value:   `EMA10:${m.ema10} EMA20:${m.ema20} Ext10:${m.ext10}% Ext20:${m.ext20}%`,
    reason:  ema_ok
      ? 'EMAs alineadas y precio partiendo desde EMAs ✅'
      : !emas_15m_ok ? 'EMAs 15m no alineadas con la dirección ❌' : `Precio extendido (>${MAX_EXT}%) — esperar retroceso ❌`,
  });
  if (ema_ok) score += w4;

  // ── Mundo 3: Fuerza ───────────────────────────────────────

  // 5. Volumen SPY > 2x promedio
  const w5 = weights.volumen_rompimiento ?? 10;
  totalWeight += w5;
  const relVol = indicators.spy?.relativeVolume;
  const volumen_ok = relVol !== null && relVol >= 2;
  checks.push({
    id:      'volumen_rompimiento',
    label:   'Volumen de Rompimiento > 2x',
    mundo:   3,
    weight:  w5,
    ok:      volumen_ok,
    value:   relVol !== null ? `${relVol}x` : '—',
    reason:  volumen_ok
      ? `Volumen institucional confirmado (${relVol}x) ✅`
      : `Volumen insuficiente (${relVol}x < 2x) ❌`,
  });
  if (volumen_ok) score += w5;

  // 6. MACD — cruce/estado + pendiente a favor de la dirección
  const w6 = weights.macd_cruce_pendiente ?? 5;
  totalWeight += w6;
  const macd = indicators.m15?.macd || {};
  const macd_ok = dir === 'BULLISH'
    ? macd.bullish && macd.slope > 0
    : macd.bearish && macd.slope < 0;
  checks.push({
    id:      'macd_cruce_pendiente',
    label:   'MACD cruce + pendiente (15m)',
    mundo:   3,
    weight:  w6,
    ok:      macd_ok,
    value:   `MACD:${macd.line ?? macd.macd} Signal:${macd.signal} Slope:${macd.slope}`,
    reason:  macd_ok
      ? `MACD ${dir === 'BULLISH' ? 'sobre' : 'bajo'} signal con pendiente a favor ✅`
      : 'MACD no alineado o sin pendiente a favor ❌',
  });
  if (macd_ok) score += w6;

  // 7. Confirmación algorítmica — Camino A (Trend Magic + SlingShot + MACD)
  const w7 = weights.confirmacion_algoritmica ?? 5;
  totalWeight += w7;
  const caminoA = indicators.m2?.caminoA || {};
  const algo_ok = dir === 'BULLISH' ? !!caminoA.bullish : !!caminoA.bearish;
  checks.push({
    id:      'confirmacion_algoritmica',
    label:   'Confirmación Algorítmica (Camino A)',
    mundo:   3,
    weight:  w7,
    ok:      algo_ok,
    value:   caminoA.reason || '—',
    reason:  algo_ok ? 'Camino A confirma la dirección ✅' : 'Camino A no confirma ❌',
  });
  if (algo_ok) score += w7;

  const pct = totalWeight > 0 ? +(score / totalWeight * 100).toFixed(1) : 0;
  const minScore = config.minScore ?? 75;

  return {
    score: pct,
    passed: pct >= minScore,
    minScore,
    checks,
    mundo1: checks.filter(c => c.mundo === 1),
    mundo2: checks.filter(c => c.mundo === 2),
    mundo3: checks.filter(c => c.mundo === 3),
  };
}

// ── Score de Alejamiento de SMA (reversión a la media, playbook Luis Silva) ──
// Contrato de salida igual a calcPlaybookScore ({score, passed, minScore, checks})
// pero con los 5 checks propios de este setup. El patrón de confirmación
// (García/Tiburón/9) se recibe YA CALCULADO en `indicators.patronReversion`
// (no se llama a evaluateReversionPattern acá adentro) para evitar un
// require circular: src/sma_reversion.js ya importa calcSMAArray de este
// mismo archivo.
function calcReversionScore(indicators, config) {
  const weights = config.weights || {};
  const checks  = [];
  let totalWeight = 0;
  let score = 0;

  const dir = indicators.direction; // BULLISH | BEARISH

  // 1. Alejamiento de SMA8 — extensión del precio respecto a la media (el "imán")
  const w1 = weights.alejamiento_sma8 ?? 35;
  totalWeight += w1;
  const MIN_EXT = 0.15; // % minimo de estiramiento — estimacion inicial, ajustar tras el curso
  const ext8 = indicators.ext8;
  const alejamiento_ok = ext8 != null && (dir === 'BULLISH' ? ext8 <= -MIN_EXT : ext8 >= MIN_EXT);
  checks.push({
    id:      'alejamiento_sma8',
    label:   'Alejamiento de SMA8',
    weight:  w1,
    ok:      alejamiento_ok,
    value:   ext8 != null ? `${ext8 > 0 ? '+' : ''}${ext8}%` : '—',
    reason:  alejamiento_ok ? `Precio estirado ${ext8}% de la SMA8 ✅` : `Estiramiento insuficiente (${ext8 ?? '—'}%, mínimo ${MIN_EXT}%) ❌`,
  });
  if (alejamiento_ok) score += w1;

  // 2. Patrón de Confirmación (Vela García / Tiburón / Vela 9) — ya calculado
  const w2 = weights.patron_confirmacion ?? 25;
  totalWeight += w2;
  const patron = indicators.patronReversion || {};
  checks.push({
    id:      'patron_confirmacion',
    label:   'Patrón de Confirmación (García/Tiburón/9)',
    weight:  w2,
    ok:      !!patron.ok,
    value:   patron.pattern || '—',
    reason:  patron.reason || 'Sin datos de patrón',
  });
  if (patron.ok) score += w2;

  // 3. RSI sobrecompra/sobreventa — agotamiento
  const w3 = weights.rsi ?? 15;
  totalWeight += w3;
  const rsi = indicators.rsi;
  const rsi_ok = rsi != null && (dir === 'BULLISH' ? rsi < 30 : rsi > 70);
  checks.push({
    id:      'rsi',
    label:   'RSI sobrecompra/sobreventa',
    weight:  w3,
    ok:      rsi_ok,
    value:   rsi != null ? `${rsi}` : '—',
    reason:  rsi_ok ? `RSI en ${dir === 'BULLISH' ? 'sobreventa' : 'sobrecompra'} (${rsi}) ✅` : `RSI sin agotamiento (${rsi ?? '—'}) ❌`,
  });
  if (rsi_ok) score += w3;

  // 4. Fase Weinstein 15m a favor de la reversión (2 para compras, 4 para ventas)
  const w4 = weights.fase_weinstein ?? 15;
  totalWeight += w4;
  const fase15m = indicators.m15?.weinstein?.fase;
  const faseObjetivo = dir === 'BULLISH' ? 2 : 4;
  const fase_ok = fase15m === faseObjetivo;
  checks.push({
    id:      'fase_weinstein',
    label:   'Fase Weinstein 15m a favor',
    weight:  w4,
    ok:      fase_ok,
    value:   `Fase${fase15m ?? '—'}`,
    reason:  fase_ok ? `Fase ${faseObjetivo} confirma la tendencia de fondo ✅` : `Fase 15m (${fase15m ?? '—'}) no favorece esta reversión ❌`,
  });
  if (fase_ok) score += w4;

  // 5. Régimen Institucional — GEX Positivo (dealers estabilizan, favorece reversión)
  const w5 = weights.regimen_gex ?? 10;
  totalWeight += w5;
  const regimen_ok = indicators.gammaRegime === 'POSITIVO';
  checks.push({
    id:      'regimen_gex',
    label:   'Régimen Institucional (GEX Positivo)',
    weight:  w5,
    ok:      regimen_ok,
    value:   indicators.gammaRegime || '—',
    reason:  regimen_ok ? 'GEX positivo — mercado estabilizador, favorece reversión ✅' : `GEX ${indicators.gammaRegime || 'desconocido'} — no favorece reversión ❌`,
  });
  if (regimen_ok) score += w5;

  const pct = totalWeight > 0 ? +(score / totalWeight * 100).toFixed(1) : 0;
  const minScore = config.minScore ?? 70;

  return { score: pct, passed: pct >= minScore, minScore, checks };
}

module.exports = { calcEMA, calcEMAArray, calcMACD, priceExtension, calcRelativeVolume, calcPlaybookScore, calcSwingStructure, calcSMA, calcSMAArray, calcRSI, calcReversionScore };
