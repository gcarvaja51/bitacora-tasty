'use strict';

// ── SPX Signal Engine ─────────────────────────────────────────
// Analiza contexto de mercado y genera sugerencias de entrada
// para estrategias de opciones en SPX

// Siguiente dia de TRADING (no solo +1 dia calendario) — usado para 1DTE, que
// entra un viernes por la tarde y debe apuntar al lunes, no al sabado. No
// maneja feriados (igual que el resto del sistema, ver nota de calendario
// economico manual en CLAUDE.md) pero al menos salta fin de semana, que antes
// causaba que findStrikesByDelta buscara una expiracion de sabado inexistente
// y cayera al fallback (la primera expiracion disponible, sin relacion con
// "el dia siguiente real").
function nextTradingDateET() {
  let d = new Date(Date.now() + 86400000);
  let dateStr = d.toLocaleString('en-CA', { timeZone: 'America/New_York' }).slice(0, 10);
  let dow = new Date(dateStr + 'T12:00:00Z').getDay(); // 0=domingo, 6=sabado
  while (dow === 0 || dow === 6) {
    d = new Date(d.getTime() + 86400000);
    dateStr = d.toLocaleString('en-CA', { timeZone: 'America/New_York' }).slice(0, 10);
    dow = new Date(dateStr + 'T12:00:00Z').getDay();
  }
  return dateStr;
}

function getETHour() {
  // Usa la zona horaria real de Nueva York (America/New_York) en vez de un
  // offset fijo, para que ajuste solo con el horario de verano (EDT/EST).
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  let [hour, min] = etStr.split(':').map(Number);
  if (hour === 24) hour = 0;
  return { hour, min, time: `${hour}:${String(min).padStart(2,'0')}` };
}

// ── Ancho de spread dinamico segun capital y riesgo objetivo ──
// Antes selectStrategy() usaba un ancho fijo de 20 puntos sin importar el
// capital real de la cuenta — coincidia con el 2% de riesgo solo porque el
// balance de Tradier ronda los $100k ahora mismo, por casualidad, no por
// diseno. Misma logica de niveles que ya usaba el Backtester (frontend).
function spreadWidthFor(capital, riesgoPct = 2) {
  const tiers = [[5000,5],[10000,5],[15000,10],[20000,15],[Infinity,15]];
  let spM = 5;
  for (const [lim, sp] of tiers) { if (capital <= lim) { spM = sp; break; } }
  const spR = Math.max(5, Math.floor(capital * (riesgoPct / 100) / 100) * 5);
  return Math.min(spM, spR, 20);
}

// ── Black-Scholes gamma puntual — usada por el sweep de Gamma Flip de abajo ──
function bsGammaAt(S, K, T, sigma) {
  if (!S || !K || T <= 0 || !sigma) return 0;
  const d1 = (Math.log(S / K) + (0.0525 + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const nd1 = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  return nd1 / (S * sigma * Math.sqrt(T));
}

// ── Gamma Flip real: barre precios hipotéticos del subyacente y recalcula la
// gamma de cada strike via Black-Scholes en cada uno (no la gamma ya fijada al
// spot actual) — el precio donde el GEX neto total cruza de negativo a
// positivo, igual que lo calculan las terminales de flujo de opciones (Sigma,
// SpotGamma, etc). El método viejo (acumular el GEX ya evaluado al spot real,
// recorriendo strikes de menor a mayor) puede no cruzar NUNCA si el open
// interest esta muy sesgado hacia un lado cerca del dinero — confirmado con
// datos reales del 2026-07-08: los puts dominan tanto el OI cerca del spot
// que el acumulado se hunde y nunca vuelve a cruzar cero, aunque haya calls
// con GEX positivo mas arriba. El sweep evita esto porque la gamma de CADA
// strike cambia con el precio hipotetico (no es un valor fijo por strike).
function calcGammaFlipSweep(expirations, spxPrice) {
  const legs = [];
  for (const exp of expirations) {
    const T = Math.max((new Date(exp.expiry) - Date.now()) / (365.25 * 86400000), 0.001);
    for (const s of (exp.strikes || [])) {
      const c = s.call || {}, p = s.put || {};
      if (c.oi) legs.push({ strike: s.strike, T, iv: (c.iv || 0) / 100 || 0.175, oi: c.oi, isCall: true });
      if (p.oi) legs.push({ strike: s.strike, T, iv: (p.iv || 0) / 100 || 0.175, oi: p.oi, isCall: false });
    }
  }
  if (!legs.length) return null;

  const step  = 5; // resolucion = espaciado tipico de strikes SPX cerca del dinero
  const range = Math.round(spxPrice * 0.07 / step) * step; // +/-7% alrededor del spot
  let prevNet = null, prevPrice = null, flip = null;
  for (let price = spxPrice - range; price <= spxPrice + range; price += step) {
    let net = 0;
    for (const leg of legs) {
      const gamma = bsGammaAt(price, leg.strike, leg.T, leg.iv);
      const gex   = gamma * leg.oi * 100 * price * price * 0.01;
      net += leg.isCall ? gex : -gex;
    }
    if (prevNet != null && prevNet !== 0 && prevNet * net < 0) {
      // Interpolacion lineal entre los dos precios evaluados para afinar el cruce
      const frac = Math.abs(prevNet) / (Math.abs(prevNet) + Math.abs(net));
      flip = Math.round((prevPrice + frac * (price - prevPrice)) / 5) * 5;
      break;
    }
    prevNet = net; prevPrice = price;
  }
  return flip;
}

// ── Calcula GEX por strike ────────────────────────────────────
function calcGEX(expirations, spxPrice) {
  const gexByStrike = {};

  for (const exp of expirations) {
    for (const s of (exp.strikes || [])) {
      const strike = s.strike;
      const c = s.call || {};
      const p = s.put  || {};

      const callGex = (c.gamma||0) * (c.oi||0) * 100 * spxPrice * spxPrice * 0.01;
      const putGex  = (p.gamma||0) * (p.oi||0) * 100 * spxPrice * spxPrice * 0.01 * -1;

      gexByStrike[strike] = (gexByStrike[strike] || 0) + callGex + putGex;
    }
  }

  const sorted   = Object.entries(gexByStrike).map(([k,v]) => ({ strike: +k, gex: v })).sort((a,b) => a.strike - b.strike);
  const netGex   = sorted.reduce((s, x) => s + x.gex, 0);
  const callWall = sorted.reduce((best, x) => x.gex > best.gex ? x : best, { strike: 0, gex: -Infinity }).strike;
  const putWall  = sorted.reduce((best, x) => x.gex < best.gex ? x : best, { strike: 0, gex: Infinity }).strike;

  return {
    netGex,
    regime:    netGex > 0 ? 'POSITIVO' : 'NEGATIVO',
    callWall,
    putWall,
    gammaFlip: calcGammaFlipSweep(expirations, spxPrice),
    levels:    sorted.filter(x => Math.abs(x.gex) > Math.abs(netGex) * 0.05), // niveles significativos
  };
}

// ── Calcula Max Pain — strike donde el payout total a tenedores de
// opciones (calls+puts ITM por OI) se minimiza al vencimiento ────
function calcMaxPain(strikes) {
  if (!strikes || !strikes.length) return null;

  let maxPainStrike = null;
  let minPain = Infinity;

  for (const candidate of strikes) {
    let totalPain = 0;
    for (const s of strikes) {
      const callOi = s.call?.oi || 0;
      const putOi  = s.put?.oi  || 0;
      if (candidate.strike > s.strike) totalPain += (candidate.strike - s.strike) * callOi * 100;
      if (candidate.strike < s.strike) totalPain += (s.strike - candidate.strike) * putOi  * 100;
    }
    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = candidate.strike;
    }
  }

  return maxPainStrike;
}

// ── Ventanas horarias del playbook (ET) ───────────────────────
// 9:45-10:00  → apertura, recién habilitado (evitar fintas de los primeros min)
// 10:00-13:00 → favorable para Iron Condor (si Gamma+ y rango de apertura respetado)
// 13:00-13:30 → ventana frecuente de impulsos/direccionales fuertes
// 13:30-15:00 → general, sin sesgo horario particular
// 15:40-15:50 → cierre intradía / evaluar 1DTE (ampliada de 15:45 a 15:40 el 2026-07-10,
// a pedido del usuario, tras ver que a las 15:50 en punto el gate ya se cerraba por 1-2
// minutos aunque el resto de las condiciones — GEX+, VIX bajo, gamma flip lejos, sin
// eventos macro de alto impacto mañana — pasaban limpio)
function classifyWindow(etMins) {
  if (etMins >= 9 * 60 + 45 && etMins < 10 * 60)          return 'APERTURA';
  if (etMins >= 10 * 60     && etMins < 13 * 60)          return 'IC_FAVORABLE';
  if (etMins >= 13 * 60     && etMins < 13 * 60 + 30)     return 'IMPULSO';
  if (etMins >= 13 * 60 + 30 && etMins < 15 * 60)         return 'GENERAL';
  if (etMins >= 15 * 60 + 40 && etMins < 15 * 60 + 50)    return 'CIERRE_1DTE';
  return 'FUERA_VENTANA';
}

// ── Gate de Alejamiento de SMA (reversión a la media, playbook Luis Silva) ──
// Ventana propia (9:45am-2pm ET), deliberadamente standalone y NO integrada a
// classifyWindow: ese rango cruza varios buckets existentes (APERTURA,
// IC_FAVORABLE, IMPULSO, parte de GENERAL) que ya usan el Iron Condor y el
// direccional — tocar classifyWindow para agregar este bucket rompería esa
// lógica compartida en vez de sumar una ventana nueva.
// Ventana 9:45am-12pm ET — la "Ventana Prime" del playbook de Luis Silva es
// 10-11:30am (compas mas limpio, mayor fiabilidad de reversion); 12pm-3pm es
// "la siesta institucional" (sin compas claro, evitar) por lo que se excluye
// del gate aunque el resto del sistema (IC, direccionales) siga operando ahi.
function evaluateReversionGate(etHour, etMin) {
  const etMins = etHour * 60 + etMin;
  if (etMins < 9 * 60 + 45 || etMins >= 12 * 60) {
    return { valid: false, reason: `Alejamiento de SMA solo opera 9:45am-12pm ET, fuera de la siesta institucional (ahora ${etHour}:${String(etMin).padStart(2,'0')}).` };
  }
  return { valid: true };
}

// ── Gate del Iron Condor (0DTE y 1DTE) — playbook profesor Alejandro ──
// Gate PROPIO, en paralelo a selectStrategy() (no lo reemplaza): el Iron Condor no
// depende de una alerta direccional de Pine — se evalúa de forma periódica
// server-side buscando condiciones de rango/no-tendencia, no de tendencia.
function evaluateIronCondorGate(ctx, dte, icConfig = {}) {
  const { spxPrice, vix, gex, indicators, openingRangeRespected, etHour, etMin, highImpactEventsTomorrow } = ctx;
  const etMins = etHour * 60 + etMin;
  const gammaFlipBufferPts = icConfig.gammaFlipBufferPts || 20;
  let spreadWidth = icConfig.spreadWidth || 10;

  // ── Checks compartidos (0DTE y 1DTE) ──
  if (gex?.regime !== 'POSITIVO') {
    return { valid: false, reason: `Gamma régimen ${gex?.regime || 'desconocido'} — Iron Condor requiere GEX POSITIVO.` };
  }
  if (gex?.gammaFlip != null && Math.abs(spxPrice - gex.gammaFlip) < gammaFlipBufferPts) {
    return { valid: false, reason: `Precio (${spxPrice}) a menos de ${gammaFlipBufferPts}pts del Gamma Flip (${gex.gammaFlip}) — el régimen puede cambiar de golpe.` };
  }

  if (dte === '1DTE') {
    if (classifyWindow(etMins) !== 'CIERRE_1DTE') {
      return { valid: false, reason: `Iron Condor 1DTE solo en ventana 3:40-3:50pm ET (ahora ${etHour}:${String(etMin).padStart(2,'0')}).` };
    }
    if (vix > 24) {
      return { valid: false, reason: `VIX ${vix} > 24 — el playbook 1DTE indica NO entrar (riesgo overnight demasiado alto).` };
    }
    // Calendario economico de EE.UU. para el proximo dia de mercado (automatizado
    // 2026-07-09, via el endpoint publico de Investing.com — antes esto era una nota
    // manual, "revisar antes de confirmar", sin chequeo real). highImpactEventsTomorrow
    // es null si el chequeo fallo (red/endpoint caido) — se trata como bloqueo, no
    // como luz verde, mismo criterio conservador que el resto del sistema ante datos
    // faltantes. [] (array vacio) significa que si se pudo verificar y no hay nada de
    // alto impacto.
    if (highImpactEventsTomorrow === null || highImpactEventsTomorrow === undefined) {
      return { valid: false, reason: 'No se pudo verificar el calendario económico de mañana (Investing.com) — por seguridad, no se entra sin confirmar.' };
    }
    if (highImpactEventsTomorrow.length > 0) {
      const nombres = highImpactEventsTomorrow.map(e => e.name).join(', ');
      return { valid: false, reason: `Evento(s) de alto impacto en EE.UU. mañana: ${nombres} — riesgo overnight demasiado alto para 1DTE.` };
    }
    return {
      valid: true,
      dte: '1DTE',
      spreadWidth,
      note: 'Calendario económico de mañana verificado automáticamente (Investing.com, EE.UU., alto impacto) — sin eventos.',
    };
  }

  // ── 0DTE ──
  if (classifyWindow(etMins) !== 'IC_FAVORABLE') {
    return { valid: false, reason: `Iron Condor 0DTE solo en ventana 10:00am-1:00pm ET (ahora ${etHour}:${String(etMin).padStart(2,'0')}).` };
  }
  if (openingRangeRespected === false) {
    return { valid: false, reason: 'Rango de apertura (9:30-10:00) roto — Iron Condor no recomendado, esperar nueva estructura.' };
  }
  if (openingRangeRespected == null) {
    return { valid: false, reason: 'No se pudo determinar si el rango de apertura fue respetado — sin datos suficientes para Iron Condor.' };
  }
  const fase15m = indicators?.m15?.weinstein?.fase;
  if (fase15m !== 1 && fase15m !== 3) {
    return { valid: false, reason: `Fase Weinstein 15m = ${fase15m ?? '—'} — Iron Condor requiere Fase 1 o 3 (consolidación/rango, sin tendencia clara).` };
  }
  const macdHist = indicators?.m15?.macd?.hist;
  const flatThreshold = spxPrice * 0.0005;
  if (macdHist == null || Math.abs(macdHist) >= flatThreshold) {
    return { valid: false, reason: `MACD 15m no está aplanado (hist=${macdHist ?? '—'}, umbral ±${flatThreshold.toFixed(2)}) — todavía hay momentum direccional, Mundo 3 no cumplido.` };
  }
  if (vix > 24) spreadWidth = Math.min(spreadWidth, 10); // playbook: alas mas ajustadas, no bloquea

  return { valid: true, dte: '0DTE', spreadWidth };
}

// ── Selecciona estrategia según contexto ──────────────────────
function selectStrategy(context) {
  const { direction, ivRank, vix, gammaRegime, etHour, etMin, capital, openingRangeRespected } = context;
  const etMins = etHour * 60 + etMin;

  // 1. Validar ventana horaria ET — cierre 2:30pm ET (confirmado con el usuario
  // 2026-07-15): antes el gate timeOK_1DTE dejaba entrar direccionales por
  // alerta hasta las 3:50pm ET, y eso produjo entradas mal gestionadas cerca
  // del cierre (ej. orden 35218867, entro 3:58pm ET, cerro en -$80 — los
  // ultimos minutos antes del cierre son complejos por la gamma). Se elimina
  // por completo la ventana 1DTE de este flujo; el Iron Condor 1DTE sigue
  // existiendo como sugerencia manual aparte (ver checkIronCondor... en
  // server.js, ventana CIERRE_1DTE 3:40-3:50pm), que no pasa por selectStrategy.
  const timeOK_0DTE = (etHour > 9 || (etHour === 9 && etMin >= 45)) && (etHour < 14 || (etHour === 14 && etMin < 30));

  if (!timeOK_0DTE) {
    return { valid: false, reason: `Fuera de ventana horaria (${etHour}:${String(etMin).padStart(2,'0')} ET). Entrada válida entre 9:45am y 2:30pm ET.` };
  }

  const expType = '0DTE';
  const window  = classifyWindow(etMins);

  // 2. Decidir crédito o débito
  // Gamma NEGATIVO fuerza débito para direccionales, sin importar IV Rank/VIX —
  // vender crédito en un régimen "motor" (movimiento explosivo) es la combinación
  // más peligrosa según el playbook de Alejandro: el precio puede volar el SL de
  // un crédito antes de que el paso del tiempo compense nada. Confirmado con el
  // usuario (2026-07-08): antes, con IV Rank/VIX altos, el sistema vendía crédito
  // direccional igual aunque el gamma fuera negativo — justo la combinación que
  // el playbook marca como no sostenible. Gamma POSITIVO sigue decidiéndose por
  // IV Rank/VIX como antes (ahí sí conviene cobrar prima, el mercado tiene frenos).
  const gammaForcesDebit = gammaRegime === 'NEGATIVO' && (direction === 'BULLISH' || direction === 'BEARISH');
  const isCredit = !gammaForcesDebit && (ivRank > 30 || vix > 20);
  const creditReason = ivRank > 30 ? `IV Rank ${ivRank}% > 30%` : `VIX ${vix} > 20`;
  const debitReason  = gammaForcesDebit
    ? `Gamma NEGATIVO — movimiento explosivo, evitar vender crédito (playbook Alejandro)`
    : `IV Rank ${ivRank}% ≤ 30% y VIX ${vix} ≤ 20 — primas baratas`;

  // 3. Seleccionar estrategia
  let strategy, legs;

  if (isCredit) {
    // Crédito: vender primas infladas
    if (gammaRegime === 'POSITIVO') {
      // Gamma positivo + crédito = Iron Condor (rango) — solo en ventana favorable (10am+)
      // y con el rango de apertura (9:30-10:00) respetado, según el playbook
      if (!direction || direction === 'NEUTRAL') {
        if (etMins < 10 * 60) {
          return { valid: false, reason: `Iron Condor requiere ventana ≥10:00am ET (ahora ${etHour}:${String(etMin).padStart(2,'0')}). Esperando confirmación del rango de apertura.` };
        }
        if (openingRangeRespected === false) {
          return { valid: false, reason: `Rango de apertura (9:30-10:00) roto — Iron Condor no recomendado, esperar nueva estructura.` };
        }
        if (openingRangeRespected == null) {
          return { valid: false, reason: `No se pudo determinar si el rango de apertura fue respetado — sin datos suficientes para Iron Condor.` };
        }
        strategy = 'IRON_CONDOR';
      } else if (direction === 'BULLISH') {
        strategy = 'BULL_PUT_SPREAD';
      } else {
        strategy = 'BEAR_CALL_SPREAD';
      }
    } else {
      // Con gammaForcesDebit de arriba, BULLISH/BEARISH + gamma no-positivo ya no
      // llegan acá (se van por débito) — el único caso que sigue siendo posible es
      // NEUTRAL con IV/VIX alto y gamma no-positivo (sin dirección para un IC).
      return { valid: false, reason: 'Gamma no-positivo + señal neutral: no operar crédito sin dirección clara.' };
    }
  } else {
    // Débito: comprar movimiento rápido
    if (direction === 'BULLISH') {
      strategy = 'BULL_CALL_SPREAD';
    } else if (direction === 'BEARISH') {
      strategy = 'BEAR_PUT_SPREAD';
    } else {
      return { valid: false, reason: 'IV baja + señal neutral: no hay estrategia de débito aplicable.' };
    }
  }

  // 4. Calcular contratos según 2% del capital
  const maxRisk    = capital * 0.02;
  const spreadWidth = spreadWidthFor(capital, 2); // puntos, dinamico segun capital real
  const maxContracts = Math.max(1, Math.floor(maxRisk / (spreadWidth * 100)));

  return {
    valid: true,
    strategy,
    isCredit,
    expType,
    window,
    spreadWidth,
    contracts: maxContracts,
    maxRisk:   maxContracts * spreadWidth * 100,
    creditReason: isCredit ? creditReason : null,
    debitReason:  !isCredit ? debitReason : null,
  };
}

// ── Encuentra strikes por delta objetivo ─────────────────────
// targetDelta/spreadWidth: el llamador (server.js) ya los pasaba, pero esta funcion
// los ignoraba y usaba 0.10-0.14/20pts fijos — bug real que hacia que la config de
// produccion (delta, ancho) no se aplicara nunca a las señales en vivo.
function findStrikesByDelta(expirations, strategy, spxPrice, expType, targetDelta = 0.12, spreadWidth = 20, bodyWidth = null) {
  // Seleccionar expiración — para 1DTE, el "dia siguiente" debe saltar fin de
  // semana (viernes -> lunes, no sabado, que no existe como expiracion).
  const today = new Date().toISOString().slice(0, 10);
  const targetDate = expType === '0DTE' ? today : nextTradingDateET();

  let exp = expirations.find(e => e.expiry === targetDate);
  if (!exp) exp = expirations[0]; // fallback
  if (!exp) return null;

  const strikes = exp.strikes || [];
  const TARGET_DELTA_MIN = Math.max(0.02, targetDelta - 0.02);
  const TARGET_DELTA_MAX = targetDelta + 0.02;

  // Para cada tipo de estrategia, buscar strikes apropiados
  if (strategy === 'BULL_PUT_SPREAD' || strategy === 'IRON_CONDOR') {
    // Pata corta put: delta entre targetDelta-0.02 y targetDelta+0.02 (OTM bajista)
    const shortPut = strikes
      .filter(s => {
        const d = Math.abs(s.put?.delta || 0);
        return d >= TARGET_DELTA_MIN && d <= TARGET_DELTA_MAX;
      })
      .sort((a, b) => Math.abs(Math.abs(a.put?.delta||0) - targetDelta) - Math.abs(Math.abs(b.put?.delta||0) - targetDelta))[0];

    if (!shortPut) return null;

    const shortStrike = shortPut.strike;
    const longStrike  = shortStrike - spreadWidth;
    const premium     = (shortPut.put?.mark || 0) - ((strikes.find(s => s.strike === longStrike)?.put?.mark) || 0);

    const result = {
      expiry: exp.expiry || targetDate,
      shortStrike,
      longStrike,
      shortDelta: +(Math.abs(shortPut.put?.delta || 0)).toFixed(3),
      premium:    +premium.toFixed(2),
    };

    if (strategy === 'IRON_CONDOR') {
      // Agregar pata call
      const shortCall = strikes
        .filter(s => {
          const d = Math.abs(s.call?.delta || 0);
          return d >= TARGET_DELTA_MIN && d <= TARGET_DELTA_MAX;
        })
        .sort((a, b) => Math.abs(Math.abs(a.call?.delta||0) - targetDelta) - Math.abs(Math.abs(b.call?.delta||0) - targetDelta))[0];

      if (shortCall) {
        const shortCallStrike = shortCall.strike;
        const longCallStrike  = shortCallStrike + spreadWidth;
        const callPremium     = (shortCall.call?.mark || 0) - ((strikes.find(s => s.strike === longCallStrike)?.call?.mark) || 0);
        result.callShortStrike = shortCallStrike;
        result.callLongStrike  = longCallStrike;
        result.callDelta       = +(Math.abs(shortCall.call?.delta || 0)).toFixed(3);
        result.callPremium     = +callPremium.toFixed(2);
        result.premium         = +((premium + callPremium)).toFixed(2);
      }
    }

    return result;
  }

  if (strategy === 'DEBIT_PUT_CONDOR') {
    // Long Put Condor (4 patas, todas puts, DEBITO) — alternativa al Iron Condor de
    // credito cuando el IV Rank esta bajo (2026-07-09, playbook: vender prima barata
    // "es operar sin ventaja", esta estructura tiene Vega positiva en vez de negativa).
    // Construccion: innerHigh (vendida, cerca del precio) e innerLow (vendida, mas OTM)
    // definen el "techo plano" de ganancia; outerHigh/outerLow (compradas) son las alas
    // de proteccion. De mayor a menor strike: outerHigh > innerHigh > innerLow > outerLow.
    const bodyW = bodyWidth ?? spreadWidth; // si no se pasa por separado, reusa el ancho del ala
    const innerHigh = strikes
      .filter(s => {
        const d = Math.abs(s.put?.delta || 0);
        return d >= TARGET_DELTA_MIN && d <= TARGET_DELTA_MAX;
      })
      .sort((a, b) => Math.abs(Math.abs(a.put?.delta||0) - targetDelta) - Math.abs(Math.abs(b.put?.delta||0) - targetDelta))[0];

    if (!innerHigh) return null;

    const innerHighStrike = innerHigh.strike;
    const outerHighStrike = innerHighStrike + spreadWidth;
    const innerLowStrike  = innerHighStrike - bodyW;
    const outerLowStrike  = innerLowStrike - spreadWidth;

    const markAt = k => strikes.find(s => s.strike === k)?.put?.mark || 0;
    const outerHighMark = markAt(outerHighStrike);
    const innerLowMark  = markAt(innerLowStrike);
    const outerLowMark  = markAt(outerLowStrike);
    const innerHighMark = innerHigh.put?.mark || 0;

    // Debito neto = lo que se paga por las alas menos lo que se recibe por el cuerpo
    const debit = (outerHighMark + outerLowMark) - (innerHighMark + innerLowMark);

    return {
      expiry: exp.expiry || targetDate,
      outerHighStrike, innerHighStrike, innerLowStrike, outerLowStrike,
      innerHighDelta: +(Math.abs(innerHigh.put?.delta || 0)).toFixed(3),
      debit: +debit.toFixed(2),
    };
  }

  if (strategy === 'BEAR_CALL_SPREAD') {
    const shortCall = strikes
      .filter(s => {
        const d = Math.abs(s.call?.delta || 0);
        return d >= TARGET_DELTA_MIN && d <= TARGET_DELTA_MAX;
      })
      .sort((a, b) => Math.abs(Math.abs(a.call?.delta||0) - targetDelta) - Math.abs(Math.abs(b.call?.delta||0) - targetDelta))[0];

    if (!shortCall) return null;

    const shortStrike = shortCall.strike;
    const longStrike  = shortStrike + spreadWidth;
    const premium     = (shortCall.call?.mark || 0) - ((strikes.find(s => s.strike === longStrike)?.call?.mark) || 0);

    return {
      expiry: exp.expiry || targetDate,
      shortStrike,
      longStrike,
      shortDelta: +(Math.abs(shortCall.call?.delta || 0)).toFixed(3),
      premium:    +premium.toFixed(2),
    };
  }

  if (strategy === 'BULL_CALL_SPREAD') {
    // Débito: comprar call ATM, vender call OTM
    const longCall = strikes
      .filter(s => {
        const d = Math.abs(s.call?.delta || 0);
        return d >= 0.40 && d <= 0.60; // cerca ATM
      })
      .sort((a, b) => Math.abs(a.strike - spxPrice) - Math.abs(b.strike - spxPrice))[0];

    if (!longCall) return null;

    const longStrike  = longCall.strike;
    const shortStrike = longStrike + spreadWidth;
    const debit       = (longCall.call?.mark || 0) - ((strikes.find(s => s.strike === shortStrike)?.call?.mark) || 0);

    return {
      expiry: exp.expiry || targetDate,
      longStrike,
      shortStrike,
      longDelta: +(Math.abs(longCall.call?.delta || 0)).toFixed(3),
      premium:   +(-debit).toFixed(2), // negativo = pago
    };
  }

  if (strategy === 'BEAR_PUT_SPREAD') {
    const longPut = strikes
      .filter(s => {
        const d = Math.abs(s.put?.delta || 0);
        return d >= 0.40 && d <= 0.60;
      })
      .sort((a, b) => Math.abs(a.strike - spxPrice) - Math.abs(b.strike - spxPrice))[0];

    if (!longPut) return null;

    const longStrike  = longPut.strike;
    const shortStrike = longStrike - spreadWidth;
    const debit       = (longPut.put?.mark || 0) - ((strikes.find(s => s.strike === shortStrike)?.put?.mark) || 0);

    return {
      expiry: exp.expiry || targetDate,
      longStrike,
      shortStrike,
      longDelta: +(Math.abs(longPut.put?.delta || 0)).toFixed(3),
      premium:   +(-debit).toFixed(2),
    };
  }

  return null;
}

// ── Genera descripción legible de la sugerencia ──────────────
function buildSignalSummary(strategy, strikes, sel, context) {
  const names = {
    BULL_PUT_SPREAD:  'Bull Put Spread (BPS)',
    BEAR_CALL_SPREAD: 'Bear Call Spread (BCS)',
    IRON_CONDOR:      'Iron Condor (IC)',
    BULL_CALL_SPREAD: 'Bull Call Spread (débito)',
    BEAR_PUT_SPREAD:  'Bear Put Spread (débito)',
  };

  const credit    = sel.isCredit ? strikes.premium * 100 * sel.contracts : null;
  const debit     = !sel.isCredit ? Math.abs(strikes.premium) * 100 * sel.contracts : null;
  const maxRisk   = sel.isCredit
    ? (sel.spreadWidth * 100 * sel.contracts) - (credit || 0)
    : debit;
  const maxProfit = sel.isCredit ? credit : (sel.spreadWidth * 100 * sel.contracts) - (debit || 0);
  const probSuccess = strikes.shortDelta ? +((1 - strikes.shortDelta) * 100).toFixed(1) : null;
  const riskReward  = maxProfit && maxRisk ? +(maxProfit / maxRisk).toFixed(2) : null;

  // Nota de R:R — el playbook espera ~1:3-1:4 (reward/risk 0.20-0.35) en las
  // verticales OTM de crédito (Bull Put/Bear Call), y ~1:1 en las ATM de débito.
  let rrNote = null;
  if (riskReward != null) {
    if (strategy === 'BULL_PUT_SPREAD' || strategy === 'BEAR_CALL_SPREAD') {
      rrNote = riskReward >= 0.20 && riskReward <= 0.35
        ? `R:R ${riskReward} — dentro del rango OTM esperado (1:3-1:4)`
        : `R:R ${riskReward} — fuera del rango OTM esperado (1:3-1:4), revisar antes de ejecutar`;
    } else if (strategy === 'BULL_CALL_SPREAD' || strategy === 'BEAR_PUT_SPREAD') {
      rrNote = riskReward >= 0.80 && riskReward <= 1.20
        ? `R:R ${riskReward} — dentro del rango ATM esperado (~1:1)`
        : `R:R ${riskReward} — fuera del rango ATM esperado (~1:1), revisar antes de ejecutar`;
    }
  }

  return {
    id:          `spx-${Date.now()}`,
    timestamp:   new Date().toISOString(),
    symbol:      'SPX',
    strategy:    strategy,
    strategyName: names[strategy] || strategy,
    direction:   context.direction,
    expType:     sel.expType,
    expiry:      strikes.expiry,
    contracts:   sel.contracts,
    spreadWidth: sel.spreadWidth,
    strikes,
    isCredit:    sel.isCredit,
    credit:      credit ? +credit.toFixed(2) : null,
    debit:       debit  ? +debit.toFixed(2)  : null,
    maxRisk:     +maxRisk.toFixed(2),
    maxProfit:   maxProfit ? +maxProfit.toFixed(2) : null,
    probSuccess,
    riskReward,
    rrNote,
    context: {
      spxPrice:    context.spxPrice,
      vix:         context.vix,
      ivRank:      context.ivRank,
      gammaRegime: context.gammaRegime,
      callWall:    context.callWall,
      putWall:     context.putWall,
      gammaFlip:   context.gammaFlip,
      technicalStop:       context.technicalStop,
      technicalStopSource: context.technicalStopSource,
      maxPain:     context.maxPain,
      etTime:      context.etTime,
    },
    status: 'PENDING', // PENDING | EXECUTED | REJECTED
  };
}

module.exports = { calcGEX, calcGammaFlipSweep, calcMaxPain, selectStrategy, evaluateIronCondorGate, evaluateReversionGate, findStrikesByDelta, buildSignalSummary, getETHour, classifyWindow };
