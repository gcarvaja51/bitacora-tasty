'use strict';

// ── Rueda automatizada — Fase 1: Screener + Señales ──────────────
// Funciones puras de cálculo/scoring para el motor de sugerencias de la
// Rueda automatizada en Tradier. No hace I/O (fetch/fs) — eso vive en
// server.js (mismo split que src/spx.js vs buildSPXContext).
// Esta fase NO coloca ninguna orden — solo genera señales de entrada.

const { calcGEX } = require('./spx');

const WHEEL_TRADING_CONFIG_DEFAULTS = {
  minScore: 70,
  weights: {
    fase_weinstein:      40, // Fase Weinstein diaria Y semanal en acumulación/avance (1 o 2)
    regimen_gex:         15, // GEX positivo del subyacente
    trigger_ema_fractal: 25, // precio rebotando en EMA10/20 diaria o en fractal de soporte
    macd_pendiente:      20, // MACD diario alineado + pendiente a favor
  },
  screener: {
    // Universo de candidatos = union de dos fuentes (2026-07-10):
    // 1) finvizScreenerId: el screener de Finviz "🔄 La Rueda" ya existente en
    //    SCREENERS (server.js) — mismo checklist que el usuario ya usaba a mano
    //    (cap_midover, div>1%, P/E<28, beta<1.3, sobre SMA200 — muy parecido al
    //    checklist cuantitativo de Alejandro). null/'' = no usar Finviz.
    // 2) tickers: sugerencias manuales del trader, siempre se suman aparte (no se
    //    pierden aunque Finviz falle o no devuelva nada) — separado del watchlist
    //    general (que no tiene NU/JBLU) y de wheel_config.json (Rueda pasiva).
    // Si ambas fuentes quedan vacías, cae al watchlist completo (comportamiento
    // original de la Fase 1).
    finvizScreenerId: 'rueda',
    tickers:          ['SOFI', 'NU', 'JBLU'],
    deltaMin:         0.15,
    deltaMax:         0.30,
    dteMin:           30,
    dteMax:           45,
    ivRankMin:        30,
    ivRankMax:        60,
    bidAskMaxPct:     5,
    openInterestMin:  500,
    riskPctPorActivo: 2,   // tope de riesgo por activo (% del capital) — decidido con el usuario
    capitalTotalPct:  50,  // tope de capital total destinado a la Rueda automatizada
  },
};

// ── EMA (array completo, mismo estilo que src/spx_indicators.js) ────
function calcEMAArray(prices, period) {
  const result = new Array(prices.length).fill(null);
  if (!prices || prices.length < period) return result;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = +ema.toFixed(4);
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    result[i] = +ema.toFixed(4);
  }
  return result;
}

function calcEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const arr = calcEMAArray(prices, period);
  const last = arr[arr.length - 1];
  return last != null ? last : null;
}

// ── MACD (12,26,9) — línea de 3 barras atrás para el check de pendiente,
// mismo criterio anti-ruido que ya usa SPX (comparar la línea, no el
// histograma vela-a-vela) ──
function calcMACD(prices) {
  if (!prices || prices.length < 35) {
    return { line: null, signal: null, hist: null, linePrev3: null, bullish: false, bearish: false };
  }
  const ema12 = calcEMAArray(prices, 12);
  const ema26 = calcEMAArray(prices, 26);
  const macdLine = prices.map((_, i) => (ema12[i] != null && ema26[i] != null) ? +(ema12[i] - ema26[i]).toFixed(4) : null);
  const macdClean = macdLine.filter(v => v != null);
  const signalArr = calcEMAArray(macdClean, 9);

  const line   = macdClean.length ? macdClean[macdClean.length - 1] : null;
  const signal = signalArr.length ? signalArr[signalArr.length - 1] : null;
  const hist   = (line != null && signal != null) ? +(line - signal).toFixed(4) : null;
  const linePrev3 = macdClean.length >= 4 ? macdClean[macdClean.length - 4] : null;

  return {
    line, signal, hist, linePrev3,
    bullish: signal != null ? line > signal : false,
    bearish: signal != null ? line < signal : false,
  };
}

// ── Fase Weinstein — misma lógica que la función local de server.js
// (buildSPXContext), extraída aquí para reuso. Timeframe-agnóstica: recibe
// un array plano de closes cronológico; se llama con velas diarias Y
// semanales (confluencia exigida por el gate, ver calcWheelEntryScore). ──
function calcWeinstein(closes) {
  if (!closes || closes.length < 30) return { fase: null, label: '—' };
  const price = closes[closes.length - 1];
  const ema10 = calcEMA(closes, 10);
  const ema20 = calcEMA(closes, 20);
  const ema10prev = calcEMA(closes.slice(0, -1), 10);
  const ema20prev = calcEMA(closes.slice(0, -1), 20);
  const ema20Rising = ema20 != null && ema20prev != null && ema20 > ema20prev;
  if (ema10 == null || ema20 == null) return { fase: null, label: '—' };
  if (price > ema20 && ema10 > ema20 && ema20Rising) return { fase: 2, label: 'Fase 2 ▲', price, ema10, ema20 };
  if (price < ema20 && ema10 < ema20 && !ema20Rising) return { fase: 4, label: 'Fase 4 ▼', price, ema10, ema20 };
  if (price >= ema20 * 0.99 && price <= ema20 * 1.01) return { fase: 1, label: 'Fase 1 ◆', price, ema10, ema20 };
  return { fase: 3, label: 'Fase 3 ●', price, ema10, ema20 };
}

// ── Fractal de Williams (5 barras) — extraído del inline de server.js
// (buildSPXContext), genérico para cualquier par highs/lows cronológico. ──
function calcFractals(highs, lows) {
  let lastLow = null, lastHigh = null;
  const lowsHistory = [], highsHistory = [];
  for (let i = 2; i < highs.length - 2; i++) {
    if (highs[i] == null || lows[i] == null) continue;
    const isHigh = highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2];
    const isLow  = lows[i]  < lows[i-1]  && lows[i]  < lows[i-2]  && lows[i]  < lows[i+1]  && lows[i]  < lows[i+2];
    if (isHigh) { lastHigh = highs[i]; highsHistory.push(+highs[i].toFixed(2)); }
    if (isLow)  { lastLow  = lows[i];  lowsHistory.push(+lows[i].toFixed(2)); }
  }
  return {
    low:  lastLow  != null ? +lastLow.toFixed(2)  : null,
    high: lastHigh != null ? +lastHigh.toFixed(2) : null,
    lowsHistory:  lowsHistory.slice(-3),
    highsHistory: highsHistory.slice(-3),
  };
}

// ── Score de entrada del CSP — mismo contrato que calcPlaybookScore/
// calcReversionScore de src/spx_indicators.js: {score, passed, minScore, checks}.
// La Rueda solo evalúa la tesis de COMPRA (vender un Put para adquirir la
// acción a descuento) — no hay tesis bajista acá, a diferencia de SPX.
//
// indicators esperado:
//   { daily: {closes, highs, lows}, weekly: {closes}, gex: {regime} }
function calcWheelEntryScore(indicators, config) {
  const weights = config.weights || {};
  const checks = [];
  let totalWeight = 0, score = 0;

  const dailyCloses  = indicators.daily?.closes  || [];
  const weeklyCloses = indicators.weekly?.closes || [];
  const weinsteinD = calcWeinstein(dailyCloses);
  const weinsteinW = calcWeinstein(weeklyCloses);

  // 1. Fase Weinstein — diario Y semanal, ambos en acumulación (1) o avance (2)
  const w1 = weights.fase_weinstein ?? 40;
  totalWeight += w1;
  const faseOk = [1, 2].includes(weinsteinD.fase) && [1, 2].includes(weinsteinW.fase);
  checks.push({
    id: 'fase_weinstein', label: 'Fase Weinstein (diario y semanal)', weight: w1, ok: faseOk,
    value: `Diario: ${weinsteinD.label} | Semanal: ${weinsteinW.label}`,
    reason: faseOk ? 'Ambos marcos en acumulación/avance ✅' : 'Marcos no confirman acumulación/avance ❌',
  });
  if (faseOk) score += w1;

  // 2. Régimen GEX positivo del subyacente
  const w2 = weights.regimen_gex ?? 15;
  totalWeight += w2;
  const gexOk = indicators.gex?.regime === 'POSITIVO';
  checks.push({
    id: 'regimen_gex', label: 'GEX positivo', weight: w2, ok: gexOk,
    value: `GEX: ${indicators.gex?.regime || '—'}`,
    reason: gexOk ? 'Régimen GEX positivo, dealers estabilizan ✅' : 'GEX negativo o sin datos ❌',
  });
  if (gexOk) score += w2;

  // 3. Trigger — precio rebotando en EMA10/20 diaria O en un fractal de soporte diario
  const w3 = weights.trigger_ema_fractal ?? 25;
  totalWeight += w3;
  const priceD = dailyCloses[dailyCloses.length - 1];
  const ema10D = calcEMA(dailyCloses, 10);
  const ema20D = calcEMA(dailyCloses, 20);
  const fractalD = calcFractals(indicators.daily?.highs || [], indicators.daily?.lows || []);
  const cercaEMA = (priceD && ema10D && Math.abs(priceD - ema10D) / priceD < 0.015)
                 || (priceD && ema20D && Math.abs(priceD - ema20D) / priceD < 0.015);
  const cercaFractal = priceD && fractalD.low != null && Math.abs(priceD - fractalD.low) / priceD < 0.02;
  const triggerOk = !!(cercaEMA || cercaFractal);
  checks.push({
    id: 'trigger_ema_fractal', label: 'Rebote en EMA10/20 o fractal de soporte', weight: w3, ok: triggerOk,
    value: `Precio ${priceD ?? '—'}, EMA10 ${ema10D ?? '—'}, EMA20 ${ema20D ?? '—'}, Fractal low ${fractalD.low ?? '—'}`,
    reason: triggerOk ? 'Precio cerca de un soporte técnico ✅' : 'Precio lejos de EMA10/20 y del último fractal ❌',
  });
  if (triggerOk) score += w3;

  // 4. MACD diario con pendiente positiva (misma lógica anti-ruido que SPX:
  // línea vs 3 barras atrás, no histograma vela-a-vela)
  const w4 = weights.macd_pendiente ?? 20;
  totalWeight += w4;
  const macdD = calcMACD(dailyCloses);
  const macdOk = macdD.linePrev3 != null && macdD.line != null && macdD.bullish && macdD.line > macdD.linePrev3;
  checks.push({
    id: 'macd_pendiente', label: 'MACD diario alineado + pendiente', weight: w4, ok: macdOk,
    value: `MACD ${macdD.line ?? '—'} vs Signal ${macdD.signal ?? '—'} (3 velas atrás: ${macdD.linePrev3 ?? '—'})`,
    reason: macdOk ? 'MACD alcista con pendiente a favor ✅' : 'MACD no confirma ❌',
  });
  if (macdOk) score += w4;

  const pct = totalWeight > 0 ? +(score / totalWeight * 100).toFixed(1) : 0;
  const minScore = config.minScore ?? 70;

  return { score: pct, passed: pct >= minScore, minScore, checks };
}

// ── Selección de strike/fecha del CSP inicial — mejor "crédito por día"
// dentro de la ventana de DTE y delta configurados, ya filtrando liquidez
// (bid/ask %, open interest). Análogo en espíritu a findStrikesByDelta de
// src/spx.js, pero para un Put suelto de acciones (no una vertical SPXW). ──
function findBestCSPStrike(expirations, screenerCfg) {
  const { deltaMin, deltaMax, dteMin, dteMax, bidAskMaxPct, openInterestMin } = screenerCfg;
  let best = null;

  for (const exp of expirations) {
    if (exp.dte == null || exp.dte < dteMin || exp.dte > dteMax) continue;

    const candidates = (exp.strikes || [])
      .filter(s => s.put && s.put.delta != null)
      .filter(s => { const d = Math.abs(s.put.delta); return d >= deltaMin && d <= deltaMax; })
      .filter(s => (s.put.oi || 0) >= openInterestMin)
      .filter(s => {
        const bid = s.put.bid || 0, ask = s.put.ask || 0;
        const mid = (bid + ask) / 2;
        if (!mid) return false;
        return ((ask - bid) / mid * 100) <= bidAskMaxPct;
      });
    if (!candidates.length) continue;

    // El de mayor delta dentro del rango permitido = más prima
    const s = candidates.sort((a, b) => Math.abs(b.put.delta) - Math.abs(a.put.delta))[0];
    const premium = s.put.mark || 0;
    if (premium <= 0) continue;

    const creditPerDay = +(premium / exp.dte).toFixed(4);
    if (!best || creditPerDay > best.creditPerDay) {
      best = {
        expiry: exp.expiry, dte: exp.dte, strike: s.strike, delta: s.put.delta,
        premium, creditPerDay, bid: s.put.bid, ask: s.put.ask, oi: s.put.oi,
      };
    }
  }
  return best;
}

// ── Piso de prima mínima — 2% de rentabilidad mensual sobre el NOCIONAL
// COMPLETO (strike×100), no sobre el requisito real de margin (decisión del
// usuario: la vara se mide como si fuera cash-secured, aunque la cuenta
// operativa sea margin, para no inflar artificialmente el % de retorno). ──
function minPremiumFor(strike, dte, minMonthlyPct = 2) {
  return strike * 100 * (minMonthlyPct / 100) * (dte / 30);
}

// ── Selección de strike inicial anclada al Fair Value (Fase 3, 2026-07-10) —
// reemplaza la selección por rango de delta cuando hay un fair value válido:
// el strike inicial es el más alto posible ENTRE el spot y el fair value que
// todavía supere el piso de prima mínima (minPremiumFor). Si no hay ningún
// strike en ese rango que lo supere, no hay entrada válida para ese ticker
// hoy (no se fuerza una prima insuficiente). Si fairValue es null/inválido
// (filtro de sanidad falló en el caller), usar findBestCSPStrike en su lugar. ──
function findAnchoredCSPStrike(expirations, spotPrice, fairValue, screenerCfg) {
  const { dteMin, dteMax, bidAskMaxPct, openInterestMin, riskPctPorActivo } = screenerCfg;
  const minMonthlyPct = riskPctPorActivo ?? 2; // reutiliza el mismo campo de config que el piso de riesgo
  let best = null;

  for (const exp of expirations) {
    if (exp.dte == null || exp.dte < dteMin || exp.dte > dteMax) continue;

    const candidates = (exp.strikes || [])
      .filter(s => s.put && s.strike <= spotPrice && s.strike >= fairValue)
      .filter(s => (s.put.oi || 0) >= openInterestMin)
      .filter(s => {
        const bid = s.put.bid || 0, ask = s.put.ask || 0;
        const mid = (bid + ask) / 2;
        if (!mid) return false;
        return ((ask - bid) / mid * 100) <= bidAskMaxPct;
      })
      .filter(s => (s.put.mark || 0) >= minPremiumFor(s.strike, exp.dte, minMonthlyPct) / 100);
    if (!candidates.length) continue;

    // El strike más alto (más cerca del spot) dentro de los que superan el piso —
    // "el más alto posible entre spot y fair value que todavía pague prima razonable"
    const s = candidates.sort((a, b) => b.strike - a.strike)[0];
    const premium = s.put.mark || 0;
    const creditPerDay = +(premium / exp.dte).toFixed(4);
    if (!best || s.strike > best.strike || (s.strike === best.strike && creditPerDay > best.creditPerDay)) {
      best = {
        expiry: exp.expiry, dte: exp.dte, strike: s.strike, delta: s.put.delta,
        premium, creditPerDay, bid: s.put.bid, ask: s.put.ask, oi: s.put.oi,
      };
    }
  }
  return best;
}

// ── Mejor fecha para un ROLL a un strike ya elegido — crédito por día, SIN
// restringir a la ventana 30-45 DTE de la entrada (decisión del usuario:
// "la evaluacion si el roll es a 1 semana, 15 dias, 3 semanas o un mes lo
// podemos analizar dividiendo el dinero que me dan por rollear sobre los
// dias" — se compara contra TODOS los vencimientos disponibles). optType
// generalizado en la Fase 4 (antes hardcodeado a Put) para reutilizar la misma
// función al rolar la Covered Call. ──
function findBestRollDate(expirations, targetStrike, optType = 'P') {
  const key = optType === 'C' ? 'call' : 'put';
  let best = null;
  for (const exp of expirations) {
    if (!exp.dte || exp.dte <= 0) continue;
    const s = (exp.strikes || []).find(s => s.strike === targetStrike);
    if (!s || !s[key]) continue;
    const premium = s[key].mark || 0;
    if (premium <= 0) continue;
    const creditPerDay = +(premium / exp.dte).toFixed(4);
    if (!best || creditPerDay > best.creditPerDay) {
      best = { expiry: exp.expiry, dte: exp.dte, strike: targetStrike, delta: s[key].delta, premium, creditPerDay };
    }
  }
  return best;
}

// ── Selección del strike de la Covered Call inicial — Fase 4 del playbook
// Alejandro (decidido con el usuario, ver memoria del proyecto punto 7):
// SIEMPRE por encima del costo base real (regla sagrada, sin excepción). Si
// la Fase Weinstein (diaria+semanal) es 4 (bajista): vencimientos semanales
// (5-10 DTE), strike cerca del precio (delta 0.25-0.35) — prima agresiva
// mientras la acción cae. Si no (fases 1/2/3): vencimientos 30-45 DTE, strike
// bien OTM (delta ~0.15) — deja correr la revalorización antes de entregar
// las acciones. Si ningún strike en esas ventanas supera el costBasis, se
// relaja al strike más bajo disponible que sí lo supere (siempre hay que
// respetar la regla del break-even, pero no hay por qué exigir además la
// ventana de DTE/delta ideal si el costo base ya bajó mucho por primas). ──
function findCoveredCallStrike(expirations, spotPrice, costBasis, weinsteinPhase, screenerCfg) {
  const esBajista = weinsteinPhase === 4;
  const dteMin = esBajista ? 5 : 30;
  const dteMax = esBajista ? 10 : 45;
  const targetDelta = esBajista ? 0.30 : 0.15; // punto medio de 0.25-0.35, o ~bien OTM
  const deltaMin = esBajista ? 0.25 : 0.05;
  const deltaMax = esBajista ? 0.35 : 0.20;

  const buscar = (dMin, dMax, tMin, tMax) => {
    let best = null;
    for (const exp of expirations) {
      if (exp.dte == null || exp.dte < tMin || exp.dte > tMax) continue;
      const candidates = (exp.strikes || [])
        .filter(s => s.call && s.strike > costBasis)
        .filter(s => { const d = Math.abs(s.call.delta || 0); return d >= dMin && d <= dMax; })
        .filter(s => (s.call.oi || 0) >= (screenerCfg?.openInterestMin ?? 0))
        .filter(s => {
          const bid = s.call.bid || 0, ask = s.call.ask || 0;
          const mid = (bid + ask) / 2;
          if (!mid) return false;
          return ((ask - bid) / mid * 100) <= (screenerCfg?.bidAskMaxPct ?? 100);
        })
        .sort((a, b) => Math.abs(Math.abs(a.call.delta||0) - targetDelta) - Math.abs(Math.abs(b.call.delta||0) - targetDelta));
      const s = candidates[0];
      if (!s) continue;
      const premium = s.call.mark || 0;
      const creditPerDay = +(premium / exp.dte).toFixed(4);
      if (!best || creditPerDay > best.creditPerDay) {
        best = { expiry: exp.expiry, dte: exp.dte, strike: s.strike, delta: s.call.delta, premium, creditPerDay, bid: s.call.bid, ask: s.call.ask, oi: s.call.oi };
      }
    }
    return best;
  };

  const preciso = buscar(deltaMin, deltaMax, dteMin, dteMax);
  if (preciso) return preciso;

  // Relajado: se queda en la MISMA ventana de DTE (fase bajista o no) y elige el strike
  // más cercano al delta objetivo, pero sin exigir el rango de delta ni el filtro de
  // bid/ask — opciones OTM baratas suelen tener spreads %grandes aunque sean liquidas en
  // términos absolutos (ej. bid $0.70/ask $1.00 = spread de 35%, normal para un contrato
  // de menos de $1). Sigue exigiendo strike > costBasis y open interest mínimo, para no
  // caer en un strike profundamente ITM ni en un contrato sin nadie operándolo.
  let best = null;
  for (const exp of expirations) {
    if (exp.dte == null || exp.dte < dteMin || exp.dte > dteMax) continue;
    const candidates = (exp.strikes || [])
      .filter(s => s.call && s.strike > costBasis)
      .filter(s => (s.call.oi || 0) >= (screenerCfg?.openInterestMin ?? 0))
      .sort((a, b) => Math.abs(Math.abs(a.call.delta||0) - targetDelta) - Math.abs(Math.abs(b.call.delta||0) - targetDelta));
    const s = candidates[0];
    if (!s) continue;
    const premium = s.call.mark || 0;
    if (premium <= 0) continue;
    const creditPerDay = +(premium / exp.dte).toFixed(4);
    if (!best || creditPerDay > best.creditPerDay) {
      best = { expiry: exp.expiry, dte: exp.dte, strike: s.strike, delta: s.call.delta, premium, creditPerDay, bid: s.call.bid, ask: s.call.ask, oi: s.call.oi, relajado: true };
    }
  }
  return best;
}

module.exports = {
  WHEEL_TRADING_CONFIG_DEFAULTS,
  calcEMA, calcEMAArray, calcMACD, calcWeinstein, calcFractals,
  calcWheelEntryScore, findBestCSPStrike, findAnchoredCSPStrike, findBestRollDate,
  findCoveredCallStrike, minPremiumFor,
  calcGEX, // re-exportado por comodidad (mismo que src/spx.js)
};
