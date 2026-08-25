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
  // COLCHON SOBRE EL NIVEL (anadido 2026-08-25 tras probar con el dia real).
  // Sin esto, el 25-ago el bajista se activaba con un cierre de 7.661,93 contra
  // un nivel de 7.662: SIETE CENTESIMAS. Quince minutos despues el precio ya
  // habia vuelto dentro del corredor. Un roce no es una rotura; se exige que el
  // cierre supere el nivel por este margen antes de contarlo como valido.
  bufferNivelPts: 3,
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
function evaluarCondicion(cond, velas15m, precio, buffer = 0) {
  if (!cond || !cond.tipo) return { ok: false, motivo: 'condicion ausente' };
  const cerradas = velas15m.filter(v => v.cerrada);
  const ult = cerradas[cerradas.length - 1];
  const b = (n) => buffer ? ` [nivel+colchon ${n.toFixed(2)}]` : '';

  switch (cond.tipo) {
    case 'cierre_15m_sobre': {
      if (!ult) return { ok: false, motivo: 'sin velas cerradas' };
      const umbral = cond.nivel + buffer;
      return {
        ok: ult.close > umbral,
        motivo: `cierre 15m ${ult.close.toFixed(2)} vs ${cond.nivel}${b(umbral)} ` +
                `(${ult.close > umbral ? 'POR ENCIMA' : 'no supera'})`,
      };
    }
    case 'cierre_15m_bajo': {
      if (!ult) return { ok: false, motivo: 'sin velas cerradas' };
      const umbral = cond.nivel - buffer;
      return {
        ok: ult.close < umbral,
        motivo: `cierre 15m ${ult.close.toFixed(2)} vs ${cond.nivel}${b(umbral)} ` +
                `(${ult.close < umbral ? 'POR DEBAJO' : 'no rompe'})`,
      };
    }
    case 'dentro_corredor': {
      // El corredor se ENSANCHA por el colchon, no se estrecha. Parece contra
      // intuitivo, pero es lo que evita una zona muerta:
      //   - `cierre_15m_fuera` (la invalidacion) exige superar el borde por
      //     `buffer` para dar la rotura por buena.
      //   - Si la activacion exigiera estar estrictamente dentro, una vela a 1
      //     punto del borde NO invalidaria (no llega al colchon) pero SI
      //     rompería la activacion: el escenario quedaria en un limbo donde ni
      //     activa ni invalida, y la estrategia no operaria nunca.
      // Con la misma tolerancia en ambas, las dos condiciones son
      // complementarias y no queda hueco.
      // Caso real que lo destapo (2026-08-25): una vela cerro en 7.661,93 con
      // el corredor en 7.662-7.690 -- siete centesimas fuera-- y eso mataba el
      // neutral de todo el dia.
      const lo = cond.min - buffer, hi = cond.max + buffer;
      const dentro = cerradas.every(v => v.close >= lo && v.close <= hi);
      const spotDentro = precio >= lo && precio <= hi;
      return {
        ok: dentro && spotDentro,
        motivo: `${cerradas.length} velas ${dentro ? 'todas dentro' : 'alguna fuera'} ` +
                `de ${cond.min}-${cond.max}` + (buffer ? ` (+-${buffer} de tolerancia)` : '') +
                `; spot ${precio.toFixed(2)} ${spotDentro ? 'dentro' : 'FUERA'}`,
      };
    }
    case 'cierre_15m_fuera': {
      if (!ult) return { ok: false, motivo: 'sin velas cerradas' };
      const fuera = ult.close < cond.min - buffer || ult.close > cond.max + buffer;
      return {
        ok: fuera,
        motivo: `cierre 15m ${ult.close.toFixed(2)} vs corredor ${cond.min}-${cond.max}` +
                (buffer ? ` (+-${buffer} de colchon)` : '') +
                ` (${fuera ? 'FUERA' : 'dentro'})`,
      };
    }
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
    const buf = cfg.bufferNivelPts || 0;
    const act = evaluarCondicion(e.activa, mercado.velas15m, mercado.precio, buf);
    const inv = e.invalida
      ? evaluarCondicion(e.invalida, mercado.velas15m, mercado.precio, buf)
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

/**
 * Valida el bloque `escenarios` de una entrada de premercado.
 * Devuelve { ok, errores[], avisos[] }.
 *
 * Existe porque el bloque lo escribe el skill del premercado cada manana, y un
 * error ahi no se nota hasta las 10:00 con el mercado abierto -- momento pesimo
 * para descubrir que falta un nivel. Correr esto al terminar el premercado
 * convierte un fallo silencioso en un aviso a las 9 de la manana.
 */
function validarEscenarios(premercado) {
  const errores = [];
  const avisos = [];
  const esc = premercado && premercado.escenarios;

  if (!esc || typeof esc !== 'object') {
    return { ok: false, errores: ['falta el bloque `escenarios`'], avisos };
  }

  const esperados = ['alcista', 'bajista', 'neutral'];
  for (const n of esperados) {
    if (!esc[n]) errores.push(`falta el escenario "${n}"`);
  }

  const TIPOS = ['cierre_15m_sobre', 'cierre_15m_bajo', 'dentro_corredor', 'cierre_15m_fuera'];
  const chequearCond = (nombre, campo, c) => {
    if (!c) { errores.push(`${nombre}.${campo}: ausente`); return; }
    if (!TIPOS.includes(c.tipo)) {
      errores.push(`${nombre}.${campo}: tipo "${c.tipo}" no reconocido (validos: ${TIPOS.join(', ')})`);
      return;
    }
    if (c.tipo === 'cierre_15m_sobre' || c.tipo === 'cierre_15m_bajo') {
      if (typeof c.nivel !== 'number') errores.push(`${nombre}.${campo}: falta \`nivel\` numerico`);
    } else {
      if (typeof c.min !== 'number' || typeof c.max !== 'number') {
        errores.push(`${nombre}.${campo}: faltan \`min\`/\`max\` numericos`);
      } else if (c.min >= c.max) {
        errores.push(`${nombre}.${campo}: min (${c.min}) >= max (${c.max})`);
      }
    }
  };

  let sumaProb = 0;
  for (const [nombre, e] of Object.entries(esc)) {
    if (!e || typeof e !== 'object') { errores.push(`${nombre}: no es un objeto`); continue; }
    if (typeof e.prob !== 'number') errores.push(`${nombre}: falta \`prob\` numerico`);
    else sumaProb += e.prob;
    chequearCond(nombre, 'activa', e.activa);
    chequearCond(nombre, 'invalida', e.invalida);

    // Los targets solo se exigen a los direccionales: el neutral no compra
    // recorrido, se queda en el corredor.
    if (nombre !== 'neutral') {
      const t = [e.t1, e.t2].flatMap(x => (Array.isArray(x) ? x : [x]))
        .filter(v => typeof v === 'number');
      if (!t.length) errores.push(`${nombre}: sin ningun objetivo (t1/t2) numerico`);
    }
  }

  if (Object.keys(esc).length && Math.abs(sumaProb - 100) > 1) {
    avisos.push(`las probabilidades suman ${sumaProb}, no 100`);
  }

  // Coherencia direccional: comprobar que activa/invalida apuntan al lado que
  // corresponde. Un alcista que se activa cayendo es casi siempre un error de
  // transcripcion, y el motor lo ejecutaria igual sin esto.
  const a = esc.alcista, b = esc.bajista;
  if (a?.activa?.tipo === 'cierre_15m_bajo') {
    avisos.push('alcista se activa con un cierre POR DEBAJO: revisar, parece invertido');
  }
  if (b?.activa?.tipo === 'cierre_15m_sobre') {
    avisos.push('bajista se activa con un cierre POR ENCIMA: revisar, parece invertido');
  }
  if (a?.activa?.nivel && b?.activa?.nivel && a.activa.nivel < b.activa.nivel) {
    avisos.push(`el nivel del alcista (${a.activa.nivel}) esta por DEBAJO del bajista ` +
                `(${b.activa.nivel}): revisar`);
  }

  return { ok: errores.length === 0, errores, avisos };
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
  //
  // OJO con como se elige el target (bug encontrado al probar con el dia real
  // 2026-08-25): medir contra T1 y nada mas es incorrecto. Cuando un escenario
  // ACABA de activarse, el precio esta pegado al nivel de activacion, que a su
  // vez suele estar a pocos puntos de T1 -- asi que el gate saltaba siempre y
  // la estrategia no habria operado ni un solo dia direccional.
  // Lo correcto es quedarse con el objetivo mas LEJANO que siga por delante en
  // el sentido del trade, y exigir la distancia minima contra ese.
  const alcista = direccion === DIRECCIONES.ALCISTA;
  const cand = [escenario.t1, escenario.t2]
    .flatMap(t => (Array.isArray(t) ? t : [t]))
    .filter(v => typeof v === 'number')
    .filter(v => (alcista ? v > mercado.precio : v < mercado.precio));

  if (!cand.length) {
    return { ...base, stage: 'SIN_RECORRIDO', passed: false, operar: false,
      reason: `El precio (${mercado.precio.toFixed(2)}) ya superó todos los objetivos ` +
              `del escenario ${escenario.nombre}: no queda recorrido que comprar`,
      direccion, escenario, motivos };
  }
  const objetivo = alcista ? Math.max(...cand) : Math.min(...cand);
  const dist = Math.abs(objetivo - mercado.precio);
  if (dist < cfg.direccional.minDistanciaTargetPts) {
    return { ...base, stage: 'TARGET_MUY_CERCA', passed: false, operar: false,
      reason: `Objetivo mas lejano (${objetivo}) a solo ${dist.toFixed(1)} pts; ` +
              `minimo ${cfg.direccional.minDistanciaTargetPts}. Recorrido insuficiente ` +
              `para pagar un debit spread`,
      direccion, escenario, motivos };
  }

  return {
    ...base, stage: 'DECISION', passed: true, operar: true,
    direccion, escenario, motivos,
    estructura: {
      tipo: 'DEBIT_VERTICAL',
      sentido: direccion === DIRECCIONES.ALCISTA ? 'CALL' : 'PUT',
      anchoPts: cfg.direccional.anchoSpreadPts,
      objetivo,
      invalidacion: escenario.invalida?.nivel ?? null,
    },
    reason: `Escenario ${escenario.nombre} validado; debit spread hacia ${objetivo} (${dist.toFixed(1)} pts de recorrido)`,
  };
}

module.exports = {
  decidir, evaluarEscenarios, evaluarCondicion, gates, conConfig, validarEscenarios,
  DIRECCIONES, DEFAULTS,
};
