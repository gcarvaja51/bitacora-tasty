/**
 * ESTRATEGIA PREMERCADO -- motor de decision
 * =========================================
 *
 * Idea (Guillermo, 2026-08-25): el premercado ya escribe cada manana tres
 * escenarios con sus niveles. Entre las 10 y las 11 ET se compara lo que el
 * mercado ESTA haciendo contra esos tres escenarios, se determina cual valido,
 * y se ejecuta la estructura que corresponda. Lo que aporta el algoritmo es la
 * decision de entrada y la eleccion de strikes; la mecanica de ejecucion es la
 * misma que ya usan TENDENCIA y NEUTRAL sobre Tradier.
 *
 * Este modulo es SOLO la decision. No toca el broker ni lee la red: recibe el
 * premercado del dia y una foto del mercado, y devuelve que hacer. Esa
 * separacion es deliberada -- permite correr el motor sobre historico sin
 * ejecutar nada, que es como se va a validar antes de dejarlo suelto.
 *
 * POR QUE LA ESTRUCTURA POR DEFECTO NO ES VENDER PRIMA
 * ----------------------------------------------------
 * Medicion del 2026-08-25 con precios reales de cadena 0DTE sobre 59 sesiones:
 * el straddle ATM costaba 13,25 pts y el movimiento real medio de 12:00 al
 * cierre fue 25,56. Vendiendo a ciegas, el Iron Butterfly perdia 5,49 pts/dia
 * y el Iron Condor 4,39. Los spreads no lo explican (cruzar cuesta 0,30).
 * Conclusion aplicada aqui: con un escenario direccional validado se COMPRA un
 * debit spread; la neutral solo se arma cuando el pin es fuerte de verdad y el
 * credito supera el umbral medido. Si esa medicion cambia con mas muestra,
 * cambia esta regla -- por eso los umbrales viven en config, no en el codigo.
 */

'use strict';

const DIRECCIONES = { ALCISTA: 'ALCISTA', BAJISTA: 'BAJISTA', NEUTRAL: 'NEUTRAL' };

const DEFAULTS = {
  ventanaInicioET: 10.0,
  ventanaFinET: 11.0,
  // Un escenario solo cuenta como validado con CUERPO de vela cerrada, nunca
  // con una mecha: es la regla que el propio premercado repite cada dia y la
  // que evita comprar la finta de apertura.
  requiereCuerpo15m: true,
  minVelas15mCerradas: 2,
  // Neutral: exigencias extra, por la medicion de prima citada arriba.
  neutral: {
    maxDistPinPts: 8,          // el precio tiene que estar pegado al pin
    minCreditoAnchoPct: 35,    // credito minimo como % del ancho del ala
    requiereGammaPositivo: true,
    maxRangoDesdeAperturaPts: 40,
  },
  direccional: {
    minDistanciaTargetPts: 12, // si el T1 esta muy cerca, no compensa
    anchoSpreadPts: 25,
  },
};

/** Une config de usuario sobre los defaults, un nivel de profundidad. */
function conConfig(cfg = {}) {
  return {
    ...DEFAULTS, ...cfg,
    neutral: { ...DEFAULTS.neutral, ...(cfg.neutral || {}) },
    direccional: { ...DEFAULTS.direccional, ...(cfg.direccional || {}) },
  };
}

/**
 * Evalua una condicion del premercado contra las velas de 15m ya cerradas.
 * Tipos soportados (los que el premercado escribe):
 *   cierre_15m_sobre  { nivel }
 *   cierre_15m_bajo   { nivel }
 *   dentro_corredor   { min, max }
 *   cierre_15m_fuera  { min, max }
 */
function evaluarCondicion(cond, velas15m, precio) {
  if (!cond || !cond.tipo) return { ok: false, motivo: 'condicion ausente' };
  const cerradas = velas15m.filter(v => v.cerrada);
  const ult = cerradas[cerradas.length - 1];

  switch (cond.tipo) {
    case 'cierre_15m_sobre':
      if (!ult) return { ok: false, motivo: 'sin velas cerradas' };
      return {
        ok: ult.close > cond.nivel,
        motivo: `cierre 15m ${ult.close.toFixed(2)} vs ${cond.nivel} ` +
                `(${ult.close > cond.nivel ? 'POR ENCIMA' : 'por debajo'})`,
      };
    case 'cierre_15m_bajo':
      if (!ult) return { ok: false, motivo: 'sin velas cerradas' };
      return {
        ok: ult.close < cond.nivel,
        motivo: `cierre 15m ${ult.close.toFixed(2)} vs ${cond.nivel} ` +
                `(${ult.close < cond.nivel ? 'POR DEBAJO' : 'por encima'})`,
      };
    case 'dentro_corredor': {
      const dentro = cerradas.every(v => v.close >= cond.min && v.close <= cond.max);
      const spotDentro = precio >= cond.min && precio <= cond.max;
      return {
        ok: dentro && spotDentro,
        motivo: `${cerradas.length} velas ${dentro ? 'todas dentro' : 'alguna fuera'} ` +
                `de ${cond.min}-${cond.max}; spot ${precio.toFixed(2)} ` +
                `${spotDentro ? 'dentro' : 'FUERA'}`,
      };
    }
    case 'cierre_15m_fuera':
      if (!ult) return { ok: false, motivo: 'sin velas cerradas' };
      return {
        ok: ult.close < cond.min || ult.close > cond.max,
        motivo: `cierre 15m ${ult.close.toFixed(2)} vs corredor ${cond.min}-${cond.max}`,
      };
    default:
      return { ok: false, motivo: `tipo desconocido: ${cond.tipo}` };
  }
}

/**
 * Decide que escenario del premercado valido.
 * Devuelve { direccion, escenario, motivos[] } o direccion null si ninguno.
 *
 * Regla de desempate: si validan dos a la vez (puede pasar si el precio se
 * mueve mucho dentro de la ventana), gana el de MAYOR probabilidad asignada en
 * el premercado. No se promedia ni se inventa un cuarto escenario.
 */
function evaluarEscenarios(premercado, mercado, cfg) {
  const esc = premercado.escenarios || {};
  const motivos = [];
  const validados = [];

  for (const [nombre, e] of Object.entries(esc)) {
    if (!e || !e.activa) continue;
    const act = evaluarCondicion(e.activa, mercado.velas15m, mercado.precio);
    const inv = e.invalida
      ? evaluarCondicion(e.invalida, mercado.velas15m, mercado.precio)
      : { ok: false, motivo: 'sin invalidacion definida' };

    motivos.push(`${nombre}: activa=${act.ok ? 'SI' : 'no'} (${act.motivo}); ` +
                 `invalida=${inv.ok ? 'SI' : 'no'} (${inv.motivo})`);

    if (act.ok && !inv.ok) validados.push({ nombre, e, prob: e.prob || 0 });
  }

  if (!validados.length) return { direccion: null, escenario: null, motivos };
  validados.sort((a, b) => b.prob - a.prob);
  const g = validados[0];
  if (validados.length > 1) {
    motivos.push(`validaron ${validados.length}; gana "${g.nombre}" por mayor ` +
                 `probabilidad (${g.prob}%)`);
  }
  return {
    direccion: g.nombre.toUpperCase() === 'ALCISTA' ? DIRECCIONES.ALCISTA
             : g.nombre.toUpperCase() === 'BAJISTA' ? DIRECCIONES.BAJISTA
             : DIRECCIONES.NEUTRAL,
    escenario: { nombre: g.nombre, ...g.e },
    motivos,
  };
}

/** Gates duros previos a cualquier decision. Devuelve null si todo pasa. */
function gates(premercado, mercado, cfg) {
  if (!premercado || !premercado.escenarios) {
    return { stage: 'SIN_PREMERCADO', reason: 'No hay premercado con escenarios estructurados para hoy' };
  }
  const h = mercado.horaET;
  if (h < cfg.ventanaInicioET || h >= cfg.ventanaFinET) {
    return {
      stage: 'FUERA_DE_VENTANA',
      reason: `Hora ET ${h.toFixed(2)} fuera de la ventana ` +
              `${cfg.ventanaInicioET}-${cfg.ventanaFinET}`,
    };
  }
  const cerradas = (mercado.velas15m || []).filter(v => v.cerrada).length;
  if (cerradas < cfg.minVelas15mCerradas) {
    return {
      stage: 'POCAS_VELAS',
      reason: `Solo ${cerradas} velas de 15m cerradas; se exigen ${cfg.minVelas15mCerradas} ` +
              `antes de decidir (regla de no operar la apertura)`,
    };
  }
  if (mercado.yaOperadoHoy) {
    return { stage: 'YA_OPERADO', reason: 'Ya hay un trade de PREMERCADO hoy; solo se permite uno' };
  }
  return null;
}

/**
 * Decision completa. No ejecuta: describe.
 * @param {object} premercado  entrada del dia de premercado_hipotesis_log.json
 * @param {object} mercado     { horaET, precio, velas15m[], gamma{}, aperturaHoy, yaOperadoHoy }
 * @param {object} cfgUsuario  overrides de config
 */
function decidir(premercado, mercado, cfgUsuario = {}) {
  const cfg = conConfig(cfgUsuario);
  const base = {
    strategyFamily: 'PREMERCADO',
    etTime: typeof mercado.horaET === 'number'
      ? `${String(Math.floor(mercado.horaET)).padStart(2, '0')}:` +
        `${String(Math.round((mercado.horaET % 1) * 60)).padStart(2, '0')}`
      : null,
  };

  const bloqueo = gates(premercado, mercado, cfg);
  if (bloqueo) return { ...base, ...bloqueo, passed: false, operar: false };

  const { direccion, escenario, motivos } = evaluarEscenarios(premercado, mercado, cfg);

  if (!direccion) {
    return {
      ...base, stage: 'NINGUN_ESCENARIO', passed: false, operar: false,
      reason: 'Ningun escenario del premercado valido su condicion de activacion',
      motivos,
    };
  }

  if (direccion === DIRECCIONES.NEUTRAL) {
    const n = cfg.neutral;
    const pin = premercado.niveles_clave?.max_pain ?? premercado.niveles_clave?.mvs;
    const g = mercado.gamma || {};
    if (n.requiereGammaPositivo && g.regime !== 'POSITIVO') {
      return { ...base, stage: 'NEUTRAL_GAMMA', passed: false, operar: false,
        reason: `Neutral exige gamma POSITIVO; regimen actual ${g.regime || 'desconocido'}`, motivos };
    }
    if (pin && Math.abs(mercado.precio - pin) > n.maxDistPinPts) {
      return { ...base, stage: 'NEUTRAL_LEJOS_DEL_PIN', passed: false, operar: false,
        reason: `Precio a ${Math.abs(mercado.precio - pin).toFixed(1)} pts del pin ${pin}; ` +
                `maximo ${n.maxDistPinPts}`, motivos };
    }
    return {
      ...base, stage: 'DECISION', passed: true, operar: true,
      direccion, escenario, motivos,
      estructura: { tipo: 'NEUTRAL', pin, anchoAla: cfg.direccional.anchoSpreadPts,
                    minCreditoAnchoPct: n.minCreditoAnchoPct },
      reason: `Neutral validado con gamma positivo y precio a ` +
              `${Math.abs(mercado.precio - pin).toFixed(1)} pts del pin`,
    };
  }

  // Direccional: se compra debit spread en la direccion validada.
  const t1 = Array.isArray(escenario.t1) ? escenario.t1[0] : escenario.t1;
  const dist = t1 ? Math.abs(t1 - mercado.precio) : null;
  if (dist !== null && dist < cfg.direccional.minDistanciaTargetPts) {
    return { ...base, stage: 'TARGET_MUY_CERCA', passed: false, operar: false,
      reason: `T1 a solo ${dist.toFixed(1)} pts; minimo ${cfg.direccional.minDistanciaTargetPts}`,
      direccion, escenario, motivos };
  }

  return {
    ...base, stage: 'DECISION', passed: true, operar: true,
    direccion, escenario, motivos,
    estructura: {
      tipo: 'DEBIT_VERTICAL',
      sentido: direccion === DIRECCIONES.ALCISTA ? 'CALL' : 'PUT',
      anchoPts: cfg.direccional.anchoSpreadPts,
      objetivo: t1,
      invalidacion: escenario.invalida?.nivel ?? null,
    },
    reason: `Escenario ${escenario.nombre} validado; debit spread hacia T1 ${t1}`,
  };
}

module.exports = {
  decidir, evaluarEscenarios, evaluarCondicion, gates, conConfig,
  DIRECCIONES, DEFAULTS,
};
