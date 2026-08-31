/*
 * Genera links de OptionStrat para las posiciones ABIERTAS de TastyTrade.
 *
 * Por qué esto es solo texto y no un robot de navegador (verificado 2026-08-31):
 *
 *   1. TastyTrade ya devuelve `streamer-symbol` con el formato EXACTO que pide
 *      OptionStrat — `.SOFI260925P17.5`. No hay que parsear el símbolo OCC.
 *
 *   2. La URL `/build/<slug>/<TICKER>/<patas>` carga la estrategia SIN cuenta ni
 *      login. Probado en vivo con bull put (PG), iron condor (SPX y SPXW) y CSP
 *      con strike decimal (SOFI): el título renderizado sale correcto
 *      ("PG Oct 16th 145/140 Bull Put Spread").
 *
 * OJO — esto NO es lo mismo que un link corto tipo `optionstrat.com/pz1tNiT3J07e`.
 * Ese es una estrategia GUARDADA en la cuenta de OptionStrat (page `/[code]`, con
 * `savedStrategy` y descripción propia). Guardarla exige credenciales, así que el
 * autómata no las crea: crea el link de construcción, que se ve igual y sale de la
 * posición real. Un link puesto a mano SIEMPRE gana sobre el generado.
 */

/*
 * Signo: corto va con '-'. La CANTIDAD se codifica REPITIENDO la pata.
 *
 * Verificado en vivo (2026-08-31): `-2x.NU261120C14` NO se parsea —OptionStrat
 * cae a la página genérica— pero `-.NU261120C14,-.NU261120C14` sí, y el título
 * pasa a "NU Nov 20th 14 Short Calls", en plural. Devuelve un ARRAY.
 *
 * Lo que NO se pone: la pata de ACCIONES de una covered call. El ticker suelto
 * (`JBLU,-.JBLU260925C5`) se parsea, pero OptionStrat degrada la figura a
 * "Custom" y no hay forma de confirmar si ese token vale 1 acción o 100
 * (`200xNU` tampoco se parsea). Con la duda, un gráfico de pérdidas equivocado
 * es peor que uno incompleto: la covered call se dibuja solo con la call.
 */
function legToken(pos) {
  const sym = pos['streamer-symbol'];
  if (!sym) return null;
  const corta = String(pos['quantity-direction'] || '').toLowerCase() === 'short';
  const n = Math.max(1, Math.round(Math.abs(parseFloat(pos.quantity || 1))));
  return Array(n).fill((corta ? '-' : '') + sym);
}

function esPut(pos)  { return /P[\d.]+$/.test(pos['streamer-symbol'] || ''); }
function esCall(pos) { return /C[\d.]+$/.test(pos['streamer-symbol'] || ''); }
function strikeDe(pos) {
  const m = (pos['streamer-symbol'] || '').match(/[CP]([\d.]+)$/);
  return m ? parseFloat(m[1]) : NaN;
}
function esCorta(pos) { return String(pos['quantity-direction'] || '').toLowerCase() === 'short'; }

/*
 * Deduce el slug de OptionStrat a partir de la COMPOSICIÓN de las patas.
 * Devuelve null cuando no reconoce la figura — preferimos no inventar un nombre
 * antes que etiquetar mal un trade de cuenta real.
 */
function detectarSlug(patas, accionesDelSubyacente = 0) {
  const puts  = patas.filter(esPut);
  const calls = patas.filter(esCall);
  const n = patas.length;

  if (n === 1) {
    const p = patas[0];
    if (esCorta(p)) {
      // Con 100+ acciones detrás, una call corta es una covered call, no una desnuda.
      if (esCall(p)) return accionesDelSubyacente >= 100 ? 'covered-call' : 'short-call';
      return 'cash-secured-put';
    }
    return esCall(p) ? 'long-call' : 'long-put';
  }

  if (n === 2 && puts.length === 2) {
    const corta = puts.find(esCorta), larga = puts.find(p => !esCorta(p));
    if (!corta || !larga) return null;
    // Vender el strike ALTO y comprar el bajo = crédito alcista.
    return strikeDe(corta) > strikeDe(larga) ? 'bull-put-spread' : 'bear-put-spread';
  }

  if (n === 2 && calls.length === 2) {
    const corta = calls.find(esCorta), larga = calls.find(p => !esCorta(p));
    if (!corta || !larga) return null;
    // Vender el strike BAJO = crédito bajista. Comprarlo = débito alcista.
    return strikeDe(corta) < strikeDe(larga) ? 'bear-call-spread' : 'bull-call-spread';
  }

  if (n === 4 && puts.length === 2 && calls.length === 2) {
    const strikesCortos = patas.filter(esCorta).map(strikeDe);
    // Mismo strike corto en put y call = mariposa de hierro; distintos = cóndor.
    return new Set(strikesCortos).size === 1 ? 'iron-butterfly' : 'iron-condor';
  }

  return null;
}

/*
 * Agrupa las posiciones de opciones por subyacente + vencimiento.
 *
 * El vencimiento entra en la clave a propósito: GAP tiene HOY una covered call a
 * 25-sep y un bull put spread a 4-sep. Agrupar solo por ticker los fundiría en una
 * figura que no existe, y el popup actual —que guarda un link por ticker— ya no
 * puede representar los dos.
 */
function agruparPosiciones(positions = []) {
  const opciones = positions.filter(p => p['instrument-type'] === 'Equity Option');
  const acciones = {};
  for (const p of positions) {
    if (p['instrument-type'] === 'Equity') {
      acciones[p['underlying-symbol']] = Math.abs(parseFloat(p.quantity || 0));
    }
  }

  const grupos = new Map();
  for (const p of opciones) {
    const und = p['underlying-symbol'];
    const exp = (p['expires-at'] || '').slice(0, 10);
    if (!und || !exp) continue;
    const clave = `${und}|${exp}`;
    if (!grupos.has(clave)) grupos.set(clave, { clave, underlying: und, expiry: exp, patas: [] });
    grupos.get(clave).patas.push(p);
  }

  return [...grupos.values()].map(g => {
    const slug = detectarSlug(g.patas, acciones[g.underlying] || 0);
    // Orden estable: puts antes que calls y por strike. Sin esto la URL cambia
    // según el orden en que TastyTrade devuelva las posiciones, y un link que
    // cambia solo deja de ser comparable con el que ya estaba guardado.
    const ordenadas = [...g.patas].sort((a, b) =>
      (esPut(a) === esPut(b)) ? strikeDe(a) - strikeDe(b) : (esPut(a) ? -1 : 1)
    );
    const porPata = ordenadas.map(legToken);
    // Una pata sin streamer-symbol rompería la figura en silencio: mejor sin link.
    const completo = porPata.every(Boolean);
    const tokens = completo ? porPata.flat() : [];
    return {
      ...g,
      slug,
      // El gráfico de una covered call sale SIN las acciones (ver legToken), así
      // que no es el P&L de la posición completa. Se marca para que la bitácora
      // lo diga en pantalla en vez de dejar que parezca un dibujo fiel.
      sinPataAcciones: slug === 'covered-call',
      acciones: acciones[g.underlying] || 0,
      contratos: g.patas.reduce((s, p) => s + Math.abs(parseFloat(p.quantity || 0)), 0),
      url: (slug && completo)
        ? `https://optionstrat.com/build/${slug}/${g.underlying}/${tokens.join(',')}`
        : null,
      motivoSinUrl: !completo ? 'una pata sin streamer-symbol'
                   : !slug    ? `figura no reconocida (${g.patas.length} patas)`
                   : null,
    };
  }).sort((a, b) => a.clave.localeCompare(b.clave));
}

module.exports = { agruparPosiciones, detectarSlug, legToken };
