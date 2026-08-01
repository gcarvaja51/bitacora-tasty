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

// ── POC (Point of Control) de sesion — perfil de volumen en 15m, cubetas de $1.
// Ancla estructural del playbook de Alejandro para la salida, junto al Fractal
// 15m: el nivel de precio donde se concentro mas volumen negociado en la sesion.
// bars: [{high, low, close, volume}] SOLO de la sesion de hoy (ya filtradas por
// el caller), cronologico. Si no hay volumen (null/0 en todas), devuelve null en
// vez de un POC engañoso sobre datos vacios.
function calcPOC(bars) {
  if (!bars || !bars.length) return null;
  const volByBucket = {};
  let totalVol = 0;
  for (const b of bars) {
    if (b.high == null || b.low == null || b.close == null || !b.volume) continue;
    const typical = (b.high + b.low + b.close) / 3;
    const bucket = Math.round(typical);
    volByBucket[bucket] = (volByBucket[bucket] || 0) + b.volume;
    totalVol += b.volume;
  }
  if (totalVol <= 0) return null;
  let poc = null, maxVol = -1;
  for (const [price, vol] of Object.entries(volByBucket)) {
    if (vol > maxVol) { maxVol = vol; poc = +price; }
  }
  return poc;
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
  // 2026-07-27, a pedido explicito del usuario ("que score y entrada miren
  // exactamente lo mismo"): este check ya NO recalcula la fase con
  // calcWeinstein (la funcion vieja, banda +-1% -- bien calibrada en 15m pero
  // rota en 2m, ver git log de esta fecha). En vez de eso lee
  // indicators.m2.caminoBConfirmed, el resultado REAL que ya devolvio Camino B
  // (calcCaminoB, src/camino_b.js) al decidir la entrada -- coreAlignBull/
  // coreAlignBear, que ya incluye el marco 15m (fase15.bull/bear) como parte
  // de su propia formula. No se recalcula una segunda vez con otra fuente de
  // datos (server.js arma esto en processDirectionalEntry, pasando el mismo
  // objeto que calculo checkDirectionalAutonomous, no uno nuevo) para evitar
  // reintroducir el problema que se esta arreglando: dos funciones distintas
  // (o la misma funcion con datos de origen distinto) que pueden discrepar.
  // Si por algun motivo esta invocacion no viene de Camino B, caminoBConfirmed
  // queda undefined y el check no suma puntos (default seguro).
  const w1 = weights.fase_weinstein ?? 40;
  totalWeight += w1;
  const esAlcista = dir === 'BULLISH';
  const confirmado = indicators.m2?.caminoBConfirmed;
  const fase_ok = esAlcista ? !!confirmado?.bull : !!confirmado?.bear;
  checks.push({
    id:      'fase_weinstein',
    label:   'Fase Weinstein (2m + 15m, confirmada por el gate de entrada Camino B)',
    mundo:   1,
    weight:  w1,
    points:  fase_ok ? w1 : 0,
    ok:      fase_ok,
    value:   fase_ok ? `${esAlcista ? 'alcista' : 'bajista'} (Camino B)` : 'no confirmado',
    reason:  fase_ok ? `Alineación ${esAlcista ? 'alcista' : 'bajista'} confirmada por Camino B (2m + marco 15m) ✅` : `Camino B no confirmó la alineación de esta señal ❌`,
  });
  if (fase_ok) score += w1;

  // 2. Régimen Institucional — GEX + DEX (tabla de 4 cuadrantes, playbook
  // Alejandro, Sesión 8: Grind/Rango/Pánico/Short Squeeze — agregado 2026-07-28
  // tras un audit contra la mentoría que señaló que operar solo con GEX es
  // "mirar la mitad del mapa"). netDex viene de Sigma Terminal (mismo loop de
  // 2 min que ya alimenta Call Wall/Put Wall/Gamma Flip/MVS) — si no hay dato
  // fresco (<5 min, mismo criterio que el resto del sistema), cae al
  // comportamiento viejo (solo GEX + Gamma Flip como proxy de flujo), sin
  // romper nada de lo que ya corría en producción.
  //
  // Tabla (para señales direccionales, no aplica igual al Iron Condor):
  //   GEX+/DEX+ Grind alcista       -> BULLISH ok (sube lento, sano)
  //   GEX-/DEX+ Short Squeeze       -> BULLISH ok (rally violento, calls de débito)
  //   GEX+/DEX- Rango lateral       -> NI bullish NI bearish ok — "atrapado sin
  //                                     combustible", es tesis de Iron Condor,
  //                                     no de spread direccional
  //   GEX-/DEX- Pánico/Crash        -> BEARISH ok (única combinación que la
  //                                     tabla describe como "Estrategias
  //                                     Direccionales")
  // Asimétrico a propósito: "Short Squeeze" es un fenómeno inherentemente
  // alcista, no hay un cuadrante espejo bajista en la tabla de la mentoría.
  const w2 = weights.regimen_institucional ?? 10;
  totalWeight += w2;
  const regime    = indicators.gammaRegime;
  const gammaFlip = indicators.gammaFlip;
  const spxPrice  = indicators.spxPrice;
  const netDex    = indicators.netDex;
  let regimen_ok = false;
  let regimen_points = 0;
  let regimen_reason = '—';
  if (netDex != null && regime != null) {
    // Cuadrante real primero (independiente de la direccion de la señal), y
    // recien despues se decide el puntaje segun esa direccion -- evita el bug
    // de un primer intento (2026-07-28) donde el texto del cuadrante en el
    // caso BEARISH-no-pasa quedaba mal etiquetado (asumia el cuadrante por la
    // rama en vez de calcularlo de los signos reales de GEX/DEX).
    //
    // Puntaje parcial (2026-07-28, ajuste tras revisar la sugerencia del
    // audit de la mentoria): el cuadrante Rango Lateral (+/-) da MEDIO peso
    // en vez de cero, en las dos direcciones -- la propia tabla de Alejandro
    // lo describe como "Medio/Alerta", no "Evitar" como Panico. Se descarto
    // a proposito graduar tambien Short Squeeze (el audit sugeria "7-10 pts"
    // sin una regla exacta de que determina el valor dentro de ese rango, y
    // no hay datos historicos de DEX para calibrar un umbral de magnitud sin
    // inventarlo a ojo) -- se mantiene binario (10 o 0) fuera de Rango.
    const dexPos = netDex > 0;
    const gexPos = regime === 'POSITIVO';
    const quadrant = gexPos && dexPos  ? 'Grind alcista'
                    : !gexPos && dexPos  ? 'Short Squeeze'
                    : gexPos && !dexPos  ? 'Rango lateral'
                    : 'Pánico/Crash';
    const esRango = gexPos && !dexPos;
    const fullMatch = dir === 'BULLISH' ? dexPos : (!gexPos && !dexPos);
    regimen_points = fullMatch ? w2 : (esRango ? w2 / 2 : 0);
    regimen_ok = fullMatch; // Rango queda "no ok" para visualizacion (❌), aunque sume medio puntaje
    const signos = `GEX${gexPos ? '+' : '-'}/DEX${dexPos ? '+' : '-'} (${netDex})`;
    regimen_reason = fullMatch
      ? `${quadrant} — ${signos} ✅ (${regimen_points}/${w2} pts)`
      : esRango
        ? `${quadrant} — ${signos}, sin combustible claro para ${dir === 'BULLISH' ? 'alcista' : 'bajista'} — medio puntaje (${regimen_points}/${w2} pts) ⚠️`
        : `${quadrant} — ${signos}, no confirma ${dir === 'BULLISH' ? 'alcista' : 'bajista'} ❌ (0/${w2} pts)`;
  } else if (regime === 'POSITIVO') {
    regimen_ok = true;
    regimen_points = w2;
    regimen_reason = 'Gamma positivo — mercado estabilizador ✅ (sin DEX fresco, fallback GEX-solo)';
  } else if (regime === 'NEGATIVO') {
    if (dir === 'BULLISH' && gammaFlip && spxPrice > gammaFlip) {
      regimen_ok = true;
      regimen_points = w2;
      regimen_reason = `Precio (${spxPrice}) sobre Gamma Flip (${gammaFlip}) ✅ (sin DEX fresco, fallback GEX-solo)`;
    } else if (dir === 'BEARISH' && gammaFlip && spxPrice < gammaFlip) {
      regimen_ok = true;
      regimen_points = w2;
      regimen_reason = `Precio (${spxPrice}) bajo Gamma Flip (${gammaFlip}) ✅ (sin DEX fresco, fallback GEX-solo)`;
    } else {
      regimen_reason = `Gamma negativo pero precio no confirmó flip (${gammaFlip}) ❌ (sin DEX fresco, fallback GEX-solo)`;
    }
  }
  checks.push({
    id:      'regimen_institucional',
    label:   'Régimen Institucional (GEX + DEX)',
    mundo:   1,
    weight:  w2,
    points:  regimen_points,
    ok:      regimen_ok,
    value:   `Regime:${regime} Flip:${gammaFlip} DEX:${netDex ?? 'sin dato'}`,
    reason:  regimen_reason,
  });
  score += regimen_points;

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
    points:  swing.ok ? w3 : 0,
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
    points:  ema_ok ? w4 : 0,
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
    points:  volumen_ok ? w5 : 0,
    ok:      volumen_ok,
    value:   relVol !== null ? `${relVol}x` : '—',
    reason:  volumen_ok
      ? `Volumen institucional confirmado (${relVol}x) ✅`
      : `Volumen insuficiente (${relVol}x < 2x) ❌`,
  });
  if (volumen_ok) score += w5;

  // 6. MACD — cruce/estado + pendiente a favor de la dirección
  // Pendiente medida sobre la LINEA del MACD (EMA12-EMA26, mas suave) contra
  // 3 velas atras (linePrev3) — no el histograma vela-a-vela (macd.slope),
  // que es muy ruidoso: puede dar negativo en una sola vela suelta aunque la
  // linea siga claramente en ascenso (confirmado 2026-07-08 contra un caso
  // real donde el MACD se veia alcista en el grafico pero el histograma
  // vela-a-vela decía lo contrario).
  const w6 = weights.macd_cruce_pendiente ?? 5;
  totalWeight += w6;
  const macd = indicators.m15?.macd || {};
  const macdLine = macd.line ?? macd.macd;
  const macd_ok = macd.linePrev3 != null && macdLine != null && (dir === 'BULLISH'
    ? macd.bullish && macdLine > macd.linePrev3
    : macd.bearish && macdLine < macd.linePrev3);
  checks.push({
    id:      'macd_cruce_pendiente',
    label:   'MACD cruce + pendiente (15m)',
    mundo:   3,
    weight:  w6,
    points:  macd_ok ? w6 : 0,
    ok:      macd_ok,
    value:   `MACD:${macdLine} Signal:${macd.signal} (3 velas atrás: ${macd.linePrev3 ?? '—'})`,
    reason:  macd_ok
      ? `MACD ${dir === 'BULLISH' ? 'sobre' : 'bajo'} signal, línea en ${dir === 'BULLISH' ? 'ascenso' : 'descenso'} vs 3 velas atrás ✅`
      : 'MACD no alineado o sin pendiente sostenida a favor ❌',
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
    points:  algo_ok ? w7 : 0,
    ok:      algo_ok,
    value:   caminoA.reason || '—',
    reason:  algo_ok ? 'Camino A confirma la dirección ✅' : 'Camino A no confirma ❌',
  });
  if (algo_ok) score += w7;

  // 8. MACD doble marco (15m + 2m) — SOLO INFORMATIVO, peso 0 (2026-07-28).
  // Validado contra 42 trades reales de Camino B: cuando NI el MACD de 15m NI
  // el de 2m confirman la dirección, el resultado es consistentemente malo
  // (mediana -$340, 1 de 7 ganadoras — la mediana coincide con el promedio,
  // no es un caso arrastrado por un outlier como sí lo fue la idea descartada
  // de gradiente por pendiente de EMA20). Las otras 3 combinaciones (15m solo,
  // 2m solo, ambos confirman) NO mostraron una diferencia confiable entre sí
  // con esta muestra. A pedido explícito del usuario: se deja en observación
  // (peso 0, se calcula y se guarda en cada señal vía checksSnapshot) sin
  // bloquear ni restar puntos todavía — la muestra del caso "ambos fallan"
  // es de solo 7 trades, poca para justificar un gate que bloquee operaciones
  // reales. Revisar de nuevo cuando se acumulen más señales.
  const w8 = weights.macd_doble_marco ?? 0;
  totalWeight += w8;
  const macd2 = indicators.m2?.macd || {};
  const macd2Line = macd2.line ?? macd2.macd;
  const macd2_ok = macd2.linePrev3 != null && macd2Line != null && (dir === 'BULLISH'
    ? macd2.bullish && macd2Line > macd2.linePrev3
    : macd2.bearish && macd2Line < macd2.linePrev3);
  const ningunoConfirma = !macd_ok && !macd2_ok;
  checks.push({
    id:      'macd_doble_marco',
    label:   'MACD 15m + 2m (alerta si ninguno confirma — informativo)',
    mundo:   3,
    weight:  w8,
    points:  0, // w8 default 0 — nunca afecta el score mientras siga en observación
    ok:      !ningunoConfirma,
    value:   `15m:${macd_ok ? 'confirma' : 'no'} 2m:${macd2_ok ? 'confirma' : 'no'}`,
    reason:  ningunoConfirma
      ? 'Ni 15m ni 2m confirman — patrón históricamente malo (mediana -$340, 1/7 ganadoras en validación de 42 trades) ⚠️ (informativo, no afecta el score)'
      : 'Al menos un marco (15m o 2m) confirma la dirección ✅',
  });

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

  // 1. Alejamiento de SMA8 — extensión del precio respecto a la media (el "imán").
  // Funcion ESCALONADA (no lineal). Recalibrada 2026-07-23 (a pedido del usuario,
  // documentado y validado en Word antes de aplicar): las bandas originales
  // (0.10%-0.35%, decididas el 2026-07-09 contra un solo caso anecdotico del 8 de
  // julio) resultaron estar calibradas muy por encima de como se mueve realmente
  // el SPX. Analisis del log de estrategia (385 evaluaciones reales, dias 16/21/22
  // jul): mediana real de extension = 0.02%, p90 = 0.06%, maximo observado = 0.25%.
  // Con las bandas viejas, 0 de 385 evaluaciones pasaron el 75% minimo — coincide
  // exactamente con la ausencia total de trades de Reversion hasta la fecha (el
  // peso de este check, 45%, hace que sea matematicamente imposible llegar a 75%
  // sin el). Bandas nuevas ancladas a los percentiles reales en vez de un ejemplo
  // unico: <0.02% ruido, 0.02-0.04% leve, 0.04-0.07% tension, 0.07-0.14% optimo
  // (antes 0.15-0.20%), 0.14-0.20% alejandose, >0.20% extremo. Simulado contra los
  // mismos 385 registros: 14 evaluaciones habrian pasado el minimo (vs 0 antes).
  const ext8 = indicators.ext8;
  const extAbs = ext8 != null ? Math.abs(ext8) : null;
  const direccionCorrecta = ext8 != null && (dir === 'BULLISH' ? ext8 < 0 : ext8 > 0);
  const w1 = weights.alejamiento_sma8 ?? 35;
  totalWeight += w1;
  let banda = 'ninguna', fracAlejamiento = 0;
  if (direccionCorrecta) {
    if      (extAbs < 0.02) { banda = 'ruido (insuficiente)';         fracAlejamiento = 0;   }
    else if (extAbs < 0.04) { banda = 'leve';                         fracAlejamiento = 0.5; }
    else if (extAbs < 0.07) { banda = 'tensión';                      fracAlejamiento = 0.8; }
    else if (extAbs < 0.14) { banda = 'óptimo';                       fracAlejamiento = 1.0; }
    else if (extAbs < 0.20) { banda = 'alejándose del óptimo';        fracAlejamiento = 0.6; }
    else                     { banda = 'extremo (riesgo de tendencia)'; fracAlejamiento = 0;   }
  }
  const alejamiento_ok = fracAlejamiento > 0;
  checks.push({
    id:      'alejamiento_sma8',
    label:   'Alejamiento de SMA8',
    weight:  w1,
    ok:      alejamiento_ok,
    value:   ext8 != null ? `${ext8 > 0 ? '+' : ''}${ext8}% (${banda})` : '—',
    reason:  alejamiento_ok ? `Precio estirado ${ext8}% de la SMA8 — ${banda} (${(fracAlejamiento*100).toFixed(0)}% del peso) ✅` : `Estiramiento fuera del rango útil 0.02%-0.20% (${ext8 ?? '—'}%) ❌`,
  });
  score += w1 * fracAlejamiento;

  // 2. Patrón de Confirmación (Vela García / Tiburón / Vela 9) — ya calculado.
  // Ajuste 2026-07-23: Vela Tiburón ahora viene graduada (patron.frac: 0.78/
  // 0.88/0.91 según variante, ver sma_reversion.js) en vez de sumar el peso
  // completo con cualquier confirmación — García y Vela 9 siguen en 1.0 (binarias).
  const w2 = weights.patron_confirmacion ?? 25;
  totalWeight += w2;
  const patron = indicators.patronReversion || {};
  const patronFrac = patron.ok ? (patron.frac ?? 1) : 0;
  checks.push({
    id:      'patron_confirmacion',
    label:   'Patrón de Confirmación (García/Tiburón/9)',
    weight:  w2,
    ok:      !!patron.ok,
    value:   patron.pattern ? `${patron.pattern} (${(patronFrac*100).toFixed(0)}%)` : '—',
    reason:  patron.reason || 'Sin datos de patrón',
  });
  score += w2 * patronFrac;

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

  // 4. Fase Weinstein 5m a favor de la reversión (2 para compras, 4 para ventas)
  // Movida de 15m a 5m (2026-08-01, a pedido explicito del usuario, citando a
  // Luis Sigma: "5 minutos decide, 2 minutos afina" — el marco de 5m es el
  // que valida si hay una reversion real, no el de 15m). Ya se habia
  // investigado antes (2026-07-09, caso real del rebote en V del 8-jul) si 5m
  // llegaba a tiempo donde 15m no — confirmaba solo 5 min antes que 15m para
  // ESE caso puntual (11:25 vs 13:30), no una solucion garantizada, pero el
  // usuario decidio el cambio igual tras revisar la evidencia. NOTA: solo se
  // cambio este check — alejamiento_sma8 (el disparador de la senal en si)
  // sigue midiendose en 2m, ese es un cambio de arquitectura mas grande,
  // todavia no implementado, discutido por separado. Antes este check leia
  // indicators.m15.weinstein.fase.
  const w4 = weights.fase_weinstein ?? 15;
  totalWeight += w4;
  const fase5m = indicators.weinstein5m?.fase;
  const faseObjetivo = dir === 'BULLISH' ? 2 : 4;
  const fase_ok = fase5m === faseObjetivo;
  checks.push({
    id:      'fase_weinstein',
    label:   'Fase Weinstein 5m a favor',
    weight:  w4,
    ok:      fase_ok,
    value:   `Fase${fase5m ?? '—'}`,
    reason:  fase_ok ? `Fase ${faseObjetivo} confirma la tendencia de fondo ✅` : `Fase 5m (${fase5m ?? '—'}) no favorece esta reversión ❌`,
  });
  if (fase_ok) score += w4;

  // 5. Régimen GEX + Confluencia con Muro de Gamma — el "setup dorado" de Luis
  // Silva es estiramiento extremo + gamma positivo + precio cerca del muro
  // (Call/Put Wall) que frena el movimiento contrario.
  // Ajuste 2026-07-21 (a pedido del usuario): el signo del régimen HABÍA vuelto a
  // ser código muerto acá (eliminado 2026-07-14) porque checkAlejamientoSMA tenía
  // un gate duro aparte que ya cortaba antes de llegar a este score si era
  // negativo — pero ese gate duro bloqueó los 4 días completos del 17-20 jul sin
  // una sola señal, por una discrepancia conocida entre nuestro cálculo de GEX y
  // Sigma Terminal (ver CLAUDE.md). Se quitó el gate duro y el signo del régimen
  // vuelve a vivir ACÁ, como penalización suave: GEX negativo resta el peso
  // completo de este check (ok:false, 0 de w5) pero YA NO anula la entrada — el
  // resto del score (90% del peso) puede compensar si es lo bastante fuerte.
  const w5 = weights.regimen_gex ?? 10;
  totalWeight += w5;
  const regimenPositivo = indicators.gammaRegime === 'POSITIVO';
  const muroRelevante = dir === 'BULLISH' ? indicators.putWall : indicators.callWall;
  const distanciaMuro = (muroRelevante != null && indicators.spxPrice != null)
    ? Math.abs(indicators.spxPrice - muroRelevante) : null;
  const wallProximityPts = indicators.wallProximityPts ?? 15;
  const cercaDelMuro = distanciaMuro != null && distanciaMuro <= wallProximityPts;
  // Ajuste 2026-07-23 (a pedido del usuario): GEX Negativo pasa de 0 a 0.5 (piso de 5pts
  // sobre 10) — sigue restando frente a Positivo, pero deja de ser un 0 absoluto dentro
  // del propio check. Positivo+lejos del muro tambien sube de 0.5 a 0.8 (8pts).
  const fracRegimen = regimenPositivo ? (cercaDelMuro ? 1.0 : 0.8) : 0.5;
  checks.push({
    id:      'regimen_gex',
    label:   'Régimen GEX + Confluencia con Muro de Gamma',
    weight:  w5,
    ok:      regimenPositivo,
    value:   `${indicators.gammaRegime || 'desconocido'}${cercaDelMuro ? ` + muro a ${distanciaMuro.toFixed(1)}pts` : ''}`,
    reason:  !regimenPositivo
      ? `GEX ${indicators.gammaRegime || 'desconocido'} — la reversión pierde su hábitat, resta puntos (5/10) pero ya no bloquea la entrada ❌`
      : cercaDelMuro
        ? `Precio a ${distanciaMuro.toFixed(1)}pts del muro relevante — confluencia fuerte (setup dorado) ✅`
        : `Sin muro de gamma cerca (${distanciaMuro != null ? distanciaMuro.toFixed(1) + 'pts' : 'sin datos'}) — confluencia parcial ⚠️`,
  });
  score += w5 * fracRegimen;

  // 6. Compás de Medias 8/20 en 5m — v2 (2026-07-14, a pedido del usuario): las
  // medias no deben estar "trenzadas" (cruzandose seguido, sin ritmo claro) y el
  // compas debe favorecer la direccion de la reversion — mismo rol que
  // fase_weinstein pero en el marco de 5m que pide el material de Luis Silva
  // ("las medias no deben estar trenzadas... ritmo direccional claro"). Se recibe
  // YA CALCULADO en indicators.compasMedias5m (mismo patron que patronReversion,
  // calculado afuera con calcCompasMedias5m para evitar un fetch adicional dentro
  // de esta funcion pura).
  const w6 = weights.compas_medias_5m ?? 15;
  totalWeight += w6;
  const compas = indicators.compasMedias5m || {};
  checks.push({
    id:      'compas_medias_5m',
    label:   'Compás de Medias 8/20 (5m)',
    weight:  w6,
    ok:      !!compas.ok,
    value:   compas.value || '—',
    reason:  compas.reason || 'Sin datos de compás 5m',
  });
  if (compas.ok) score += w6;

  const pct = totalWeight > 0 ? +(score / totalWeight * 100).toFixed(1) : 0;
  const minScore = config.minScore ?? 70;

  return { score: pct, passed: pct >= minScore, minScore, checks };
}

// bars/closes: cierres cronologicos de 5m, idealmente >=25 barras (poco mas de
// 2h). direction: 'BULLISH' | 'BEARISH' (la direccion de la reversion candidata).
function calcCompasMedias5m(closes, direction) {
  const n = closes ? closes.length : 0;
  if (n < 25) return { ok: false, trenzadas: null, crossCount: null, value: '—', reason: 'Historial 5m insuficiente para el compás de medias' };

  const sma8  = calcSMAArray(closes, 8);
  const sma20 = calcSMAArray(closes, 20);

  // Cruces de SMA8/SMA20 en las ultimas 15 barras (75 min) — 2 o mas cruces en
  // ese tramo indica medias "trenzadas" (sin ritmo direccional confiable).
  const lookback = 15;
  let crossCount = 0, prevSign = null;
  for (let i = Math.max(0, n - lookback); i < n; i++) {
    if (sma8[i] == null || sma20[i] == null) continue;
    const sign = sma8[i] > sma20[i] ? 1 : (sma8[i] < sma20[i] ? -1 : 0);
    if (prevSign !== null && sign !== 0 && sign !== prevSign) crossCount++;
    if (sign !== 0) prevSign = sign;
  }
  const trenzadas = crossCount >= 2;

  const last8 = sma8[n - 1], last20 = sma20[n - 1];
  if (last8 == null || last20 == null) return { ok: false, trenzadas, crossCount, value: '—', reason: 'SMA 5m sin datos suficientes' };

  const alineado = direction === 'BULLISH' ? last8 > last20 : last8 < last20;
  const ok = alineado && !trenzadas;
  const value = `SMA8${last8 > last20 ? '>' : '<'}SMA20 (5m), ${crossCount} cruces/75min`;
  const reason = trenzadas
    ? `Medias 5m trenzadas (${crossCount} cruces en 75min) — sin ritmo direccional claro ❌`
    : alineado
      ? `Compás 5m limpio y a favor de la reversión ✅`
      : `Compás 5m limpio pero en contra de la reversión (SMA8 ${last8 > last20 ? 'arriba' : 'abajo'} de SMA20) ❌`;

  return { ok, trenzadas, crossCount, value, reason };
}

module.exports = { calcEMA, calcEMAArray, calcMACD, priceExtension, calcRelativeVolume, calcPlaybookScore, calcSwingStructure, calcSMA, calcSMAArray, calcRSI, calcReversionScore, calcCompasMedias5m, calcPOC };
