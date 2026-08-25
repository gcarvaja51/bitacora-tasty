/**
 * SELECTOR DE STRIKES -- Estrategia Premercado
 * ============================================
 *
 * Traduce la decision de `estrategia_premercado.js` en strikes concretos sobre
 * la cadena real, con su precio limite.
 *
 * POR QUE NO ELIGE POR DELTA FIJO
 * -------------------------------
 * Las otras estrategias del sistema (TENDENCIA, NEUTRAL) buscan un delta
 * objetivo -- 0,30 para direccional, 0,10 para el condor -- y de ahi salen los
 * strikes. Aqui NO, y es deliberado: el premercado ya dijo por escrito hacia
 * donde espera que vaya el precio y donde se invalida su tesis. Un delta fijo
 * ignora eso y arma la misma estructura tenga el objetivo a 15 o a 60 puntos.
 *
 * El criterio aqui es: la pata LARGA se compra donde arranca el movimiento (el
 * nivel de activacion, o el spot si ya lo dejo atras) y la pata CORTA se vende
 * en el OBJETIVO del escenario. Asi el spread paga su maximo exactamente si el
 * precio llega donde el informe dijo que llegaria -- la estructura y la tesis
 * son la misma cosa. Si el premercado se equivoca de objetivo, el trade lo
 * refleja; eso es una virtud, no un defecto: hace medible la calidad del
 * analisis en vez de esconderla detras de un delta generico.
 *
 * Para el neutral el criterio es el corredor del escenario, no un delta: los
 * cortos van en los bordes que el premercado declaro.
 */

'use strict';

const DEFAULTS = {
  incrementoStrike: 5,       // SPX cotiza de 5 en 5 en los vencimientos diarios
  maxDebitoPctAncho: 55,     // un debit spread que cuesta mas de esto no compensa
  minCreditoPctAncho: 35,    // credito minimo del neutral (medicion 2026-08-25)
  maxSpreadPorPata: 3.0,     // bid/ask mas ancho que esto = pata ilíquida
  minBid: 0.05,

  // SUELO DE PROBABILIDAD (anadido 2026-08-25 al probar con la cadena real).
  // `maxDebitoPctAncho` solo frena los spreads CAROS; no habia nada que frenara
  // los baratisimos. La primera prueba armo un 7690/7715 por 1,40 con un R:R de
  // 1:16,86 -- que parece extraordinario hasta que se mira el delta de la pata
  // larga: 0,158. Un 16% de probabilidad. El R:R alto no era una ganga, era el
  // precio justo de un billete de loteria. Se exige que la larga tenga cuerpo.
  minDeltaLarga: 0.30,

  // COHERENCIA DE LA CADENA. Si el snapshot se tomo con un spot muy distinto
  // del precio con el que se decidio, los precios no valen: una pata que la
  // cadena da como OTM puede estar ITM ahora. Mejor no operar que operar con
  // precios de otro momento.
  maxDesfaseSpotPts: 10,
};

const redondear = (x, inc) => Math.round(x / inc) * inc;

/** Busca una fila de strike exacta en la cadena. */
function fila(strikes, k) {
  return strikes.find(s => Number(s.strike) === Number(k)) || null;
}

/** Precio de ejecucion realista: se compra al ask, se vende al bid. */
function precioPata(op, comprar) {
  if (!op) return null;
  const v = comprar ? op.ask : op.bid;
  return (typeof v === 'number' && v > 0) ? v : null;
}

/** Comprueba que una pata sea operable. Devuelve motivo del rechazo o null. */
function pataUsable(op, etiqueta, cfg) {
  if (!op) return `${etiqueta}: no existe en la cadena`;
  if (!(op.bid > 0)) return `${etiqueta}: sin bid (ilíquida)`;
  if (op.bid < cfg.minBid) return `${etiqueta}: bid ${op.bid} por debajo del minimo ${cfg.minBid}`;
  const ancho = (op.ask || 0) - (op.bid || 0);
  if (ancho > cfg.maxSpreadPorPata) {
    return `${etiqueta}: spread ${ancho.toFixed(2)} supera ${cfg.maxSpreadPorPata}`;
  }
  return null;
}

/**
 * Debit vertical alineado con el escenario.
 * @param {object} dec  decision de estrategia_premercado.decidir()
 * @param {object} exp  { expiry, strikes[] }  cadena del vencimiento elegido
 * @param {number} spot
 */
function seleccionarDebitVertical(dec, exp, spot, cfgUsuario = {}) {
  const cfg = { ...DEFAULTS, ...cfgUsuario };
  const inc = cfg.incrementoStrike;
  const esCall = dec.estructura.sentido === 'CALL';
  const objetivo = dec.estructura.objetivo;
  const activacion = dec.escenario?.activa?.nivel ?? spot;

  // La larga: donde arranca el movimiento. Si el precio ya paso el nivel de
  // activacion, se ancla en el spot -- comprar por detras del precio seria
  // pagar intrinseco de mas sin comprar recorrido.
  const anclaLarga = esCall ? Math.min(activacion, spot) : Math.max(activacion, spot);
  let kLarga = redondear(anclaLarga, inc);
  let kCorta = redondear(objetivo, inc);

  // El ancho no puede pasarse del tope configurado ni ser cero.
  const anchoPedido = Math.abs(kCorta - kLarga);
  const tope = dec.estructura.anchoPts || 25;
  if (anchoPedido === 0) {
    return { ok: false, motivo: `larga y corta caen en el mismo strike (${kLarga}) tras redondear` };
  }
  if (anchoPedido > tope) {
    kCorta = esCall ? kLarga + tope : kLarga - tope;
  }

  const fL = fila(exp.strikes, kLarga);
  const fC = fila(exp.strikes, kCorta);
  const opL = esCall ? fL?.call : fL?.put;
  const opC = esCall ? fC?.call : fC?.put;

  for (const [op, et] of [[opL, `larga ${kLarga}`], [opC, `corta ${kCorta}`]]) {
    const mal = pataUsable(op, et, cfg);
    if (mal) return { ok: false, motivo: mal };
  }

  const dLarga = Math.abs(opL.delta || 0);
  if (dLarga && dLarga < cfg.minDeltaLarga) {
    return {
      ok: false,
      motivo: `pata larga ${kLarga} con delta ${dLarga.toFixed(3)}; minimo ` +
              `${cfg.minDeltaLarga}. Un R:R alto con delta baja no es una ganga, ` +
              `es un billete de loteria correctamente valorado`,
    };
  }

  const pagaL = precioPata(opL, true);
  const cobraC = precioPata(opC, false);
  if (pagaL === null || cobraC === null) {
    return { ok: false, motivo: 'alguna pata sin precio ejecutable' };
  }

  const debito = pagaL - cobraC;
  const ancho = Math.abs(kCorta - kLarga);
  const pct = (debito / ancho) * 100;

  if (debito <= 0) {
    return { ok: false, motivo: `debito no positivo (${debito.toFixed(2)}): cadena incoherente` };
  }
  if (pct > cfg.maxDebitoPctAncho) {
    return {
      ok: false,
      motivo: `debito ${debito.toFixed(2)} es el ${pct.toFixed(0)}% del ancho ${ancho}; ` +
              `maximo ${cfg.maxDebitoPctAncho}%. Riesgo/beneficio insuficiente`,
    };
  }

  const maxGanancia = ancho - debito;
  return {
    ok: true,
    tipo: 'DEBIT_VERTICAL',
    sentido: esCall ? 'CALL' : 'PUT',
    expiry: exp.expiry,
    largaStrike: kLarga,
    cortaStrike: kCorta,
    ancho,
    debito: +debito.toFixed(2),
    limite: +debito.toFixed(2),
    maxGanancia: +maxGanancia.toFixed(2),
    maxPerdida: +debito.toFixed(2),
    rr: +(maxGanancia / debito).toFixed(2),
    breakeven: +(esCall ? kLarga + debito : kLarga - debito).toFixed(2),
    pctDelAncho: +pct.toFixed(1),
    razon: `Larga ${kLarga} (arranque) / corta ${kCorta} (objetivo del escenario ` +
           `${dec.escenario?.nombre}). Paga maximo si el precio llega a ${kCorta}.`,
  };
}

/**
 * Iron Condor sobre el corredor declarado por el escenario neutral.
 * No usa delta: los cortos van en los bordes del corredor.
 */
function seleccionarNeutral(dec, exp, spot, cfgUsuario = {}) {
  const cfg = { ...DEFAULTS, ...cfgUsuario };
  const inc = cfg.incrementoStrike;
  const ala = dec.estructura.anchoAla || 25;
  const corr = dec.escenario?.corredor
    || (dec.escenario?.activa?.min != null
        ? [dec.escenario.activa.min, dec.escenario.activa.max] : null);
  if (!corr) return { ok: false, motivo: 'el escenario neutral no declara corredor' };

  const kPutCorto = redondear(corr[0], inc);
  const kCallCorto = redondear(corr[1], inc);
  const kPutLargo = kPutCorto - ala;
  const kCallLargo = kCallCorto + ala;

  const legs = [
    ['put', kPutCorto, false, `put corto ${kPutCorto}`],
    ['put', kPutLargo, true, `put largo ${kPutLargo}`],
    ['call', kCallCorto, false, `call corto ${kCallCorto}`],
    ['call', kCallLargo, true, `call largo ${kCallLargo}`],
  ];

  let neto = 0;
  for (const [tipo, k, comprar, et] of legs) {
    const f = fila(exp.strikes, k);
    const op = tipo === 'put' ? f?.put : f?.call;
    const mal = pataUsable(op, et, cfg);
    if (mal) return { ok: false, motivo: mal };
    const p = precioPata(op, comprar);
    if (p === null) return { ok: false, motivo: `${et}: sin precio ejecutable` };
    neto += comprar ? -p : p;
  }

  const pct = (neto / ala) * 100;
  if (neto <= 0) {
    return { ok: false, motivo: `credito no positivo (${neto.toFixed(2)})` };
  }
  const minPct = dec.estructura.minCreditoAnchoPct ?? cfg.minCreditoPctAncho;
  if (pct < minPct) {
    return {
      ok: false,
      motivo: `credito ${neto.toFixed(2)} es el ${pct.toFixed(0)}% del ala ${ala}; ` +
              `minimo ${minPct}%. Vender esto es regalar prima ` +
              `(medicion 0DTE del 2026-08-25)`,
    };
  }

  return {
    ok: true,
    tipo: 'IRON_CONDOR',
    expiry: exp.expiry,
    putCortoStrike: kPutCorto, putLargoStrike: kPutLargo,
    callCortoStrike: kCallCorto, callLargoStrike: kCallLargo,
    ala,
    credito: +neto.toFixed(2),
    limite: +neto.toFixed(2),
    maxGanancia: +neto.toFixed(2),
    maxPerdida: +(ala - neto).toFixed(2),
    rr: +(neto / (ala - neto)).toFixed(2),
    breakevens: [+(kPutCorto - neto).toFixed(2), +(kCallCorto + neto).toFixed(2)],
    pctDelAla: +pct.toFixed(1),
    razon: `Cortos en los bordes del corredor ${corr[0]}-${corr[1]} que declaro el ` +
           `premercado; alas de ${ala}.`,
  };
}

/** Punto de entrada: enruta segun el tipo de estructura de la decision. */
function seleccionarStrikes(dec, exp, spot, cfg = {}) {
  if (!dec || !dec.operar || !dec.estructura) {
    return { ok: false, motivo: 'la decision no pide operar' };
  }
  if (!exp || !Array.isArray(exp.strikes) || !exp.strikes.length) {
    return { ok: false, motivo: 'cadena vacia o no disponible' };
  }
  const c = { ...DEFAULTS, ...cfg };
  if (typeof exp.spot === 'number' && typeof spot === 'number') {
    const desfase = Math.abs(exp.spot - spot);
    if (desfase > c.maxDesfaseSpotPts) {
      return {
        ok: false,
        motivo: `la cadena se capturo con spot ${exp.spot} y se esta decidiendo con ` +
                `${spot} (${desfase.toFixed(1)} pts de desfase, maximo ` +
                `${c.maxDesfaseSpotPts}): precios de otro momento, no se opera`,
      };
    }
  }
  return dec.estructura.tipo === 'NEUTRAL'
    ? seleccionarNeutral(dec, exp, spot, cfg)
    : seleccionarDebitVertical(dec, exp, spot, cfg);
}

module.exports = {
  seleccionarStrikes, seleccionarDebitVertical, seleccionarNeutral,
  pataUsable, precioPata, redondear, DEFAULTS,
};
