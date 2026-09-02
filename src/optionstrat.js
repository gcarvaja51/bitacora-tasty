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
function expDe(pos)   { return (pos['expires-at'] || '').slice(0, 10); }

/*
 * Nombre para pantalla. El slug es lo que entiende OptionStrat en la URL; esto es
 * lo que se lee en la bitácora. Se separan porque NO siempre coinciden: OptionStrat
 * no tiene figura "Poor Man's Covered Call" —`/build/poor-mans-covered-call/...`
 * devuelve "Error 404 Strategy type not found", comprobado en vivo el 2026-09-02—
 * y hay que dibujarlo como `diagonal-call-spread`. En la hoja de posiciones, en
 * cambio, queremos leer PMCC, que es como se pidió el trade.
 */
const NOMBRE_FIGURA = {
  'long-call':            'Long Call',
  'long-put':             'Long Put',
  'short-call':           'Short Call',
  'cash-secured-put':     'Cash-Secured Put',
  'covered-call':         'Covered Call',
  'bull-put-spread':      'Bull Put Spread',
  'bear-put-spread':      'Bear Put Spread',
  'bull-call-spread':     'Bull Call Spread',
  'bear-call-spread':     'Bear Call Spread',
  'iron-condor':          'Iron Condor',
  'iron-butterfly':       'Iron Butterfly',
  'calendar-call-spread': 'Calendar Call Spread',
  'calendar-put-spread':  'Calendar Put Spread',
  'diagonal-call-spread': 'Diagonal Call Spread',
  'diagonal-put-spread':  'Diagonal Put Spread',
};

/*
 * PMCC = covered call sintética. La LEAPS comprada hace de acciones y contra ella
 * se vende la call corta. Formalmente es una diagonal de calls con dos rasgos:
 * la comprada VENCE DESPUÉS y su strike es MÁS BAJO (está dentro de dinero).
 *
 * Al revés —comprar la cercana y vender la lejana— también es una diagonal, pero
 * NO es un PMCC y llamarla así sería mentir sobre el riesgo.
 */
function esPMCC(patas) {
  if (patas.length !== 2 || !patas.every(esCall)) return false;
  const corta = patas.find(esCorta), larga = patas.find(p => !esCorta(p));
  if (!corta || !larga) return false;
  return expDe(larga) > expDe(corta) && strikeDe(larga) < strikeDe(corta);
}

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
    // Dos vencimientos = calendario/diagonal. La vertical es el caso de vencimiento
    // ÚNICO, y aplicarle su fórmula a una diagonal es lo que hacía que la posición
    // saliera como "beneficio máximo 0" (ver `esPMCC`).
    if (expDe(corta) !== expDe(larga)) {
      // La larga tiene que vivir MÁS que la corta. Al revés no sabemos nombrarlo.
      if (expDe(larga) < expDe(corta)) return null;
      return strikeDe(corta) === strikeDe(larga) ? 'calendar-put-spread' : 'diagonal-put-spread';
    }
    // Vender el strike ALTO y comprar el bajo = crédito alcista.
    return strikeDe(corta) > strikeDe(larga) ? 'bull-put-spread' : 'bear-put-spread';
  }

  if (n === 2 && calls.length === 2) {
    const corta = calls.find(esCorta), larga = calls.find(p => !esCorta(p));
    if (!corta || !larga) return null;
    if (expDe(corta) !== expDe(larga)) {
      if (expDe(larga) < expDe(corta)) return null;
      return strikeDe(corta) === strikeDe(larga) ? 'calendar-call-spread' : 'diagonal-call-spread';
    }
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
 * Vuelve a coser las figuras que viven en DOS vencimientos.
 *
 * El agrupado por `SUBYACENTE|VENCIMIENTO` parte un PMCC en dos mitades sueltas, y
 * la mitad corta acaba etiquetada `short-call`: la bitácora dibujaba una call
 * DESNUDA —pérdida ilimitada— para una pata que en realidad está cubierta por la
 * LEAPS. Ese fue el fallo del 2026-09-02 con el PMCC de F (10 dic-27 / 14.5 sep-26).
 *
 * Se fusiona con la mano MUY quieta, porque el broker no dice qué patas pertenecen
 * al mismo trade y una figura inventada es peor que dos mitades honestas:
 *
 *   - solo grupos de UNA pata (los de dos ya son una figura cerrada),
 *   - mismo tipo (call con call, put con put), una larga y una corta,
 *   - EXACTAMENTE una candidata de cada lado; con más de una la pareja es
 *     ambigua y se dejan todas como estaban,
 *   - y nunca si hay 100+ acciones del subyacente: ahí la call corta es una
 *     covered call de verdad y la larga es otro trade distinto.
 */
function fusionarDiagonales(grupos, acciones = {}) {
  const porSubyacente = new Map();
  for (const g of grupos) {
    if (!porSubyacente.has(g.underlying)) porSubyacente.set(g.underlying, []);
    porSubyacente.get(g.underlying).push(g);
  }

  const fusionados = [];
  const consumidos = new Set();

  for (const [und, delTicker] of porSubyacente) {
    if ((acciones[und] || 0) >= 100) continue;
    const sueltos = delTicker.filter(g => g.patas.length === 1);

    for (const esDelTipo of [esCall, esPut]) {
      const delTipo = sueltos.filter(g => esDelTipo(g.patas[0]));
      const largos  = delTipo.filter(g => !esCorta(g.patas[0]));
      const cortos  = delTipo.filter(g =>  esCorta(g.patas[0]));
      if (largos.length !== 1 || cortos.length !== 1) continue;

      const larga = largos[0].patas[0], corta = cortos[0].patas[0];
      if (expDe(larga) === expDe(corta)) continue;  // misma fecha: es vertical, ya la ve detectarSlug
      if (expDe(larga) <  expDe(corta)) continue;   // la larga muere antes: no sabemos nombrarlo

      consumidos.add(largos[0].clave);
      consumidos.add(cortos[0].clave);
      const expiries = [expDe(corta), expDe(larga)];
      fusionados.push({
        // La clave lleva los DOS vencimientos: es lo que indexa el link puesto a
        // mano en `optionstrat_links.json`, y tiene que ser estable y distinta de
        // las de las dos mitades viejas.
        clave: `${und}|${expiries.join('+')}`,
        underlying: und,
        expiry: expiries[0],   // la CERCANA: es la que hay que gestionar
        expiries,
        patas: [larga, corta],
      });
    }
  }

  return [...grupos.filter(g => !consumidos.has(g.clave)), ...fusionados];
}

/*
 * Agrupa las posiciones de opciones por subyacente + vencimiento.
 *
 * El vencimiento entra en la clave a propósito: GAP tiene HOY una covered call a
 * 25-sep y un bull put spread a 4-sep. Agrupar solo por ticker los fundiría en una
 * figura que no existe, y el popup actual —que guarda un link por ticker— ya no
 * puede representar los dos.
 *
 * Después pasa por `fusionarDiagonales`, que rehace las figuras de dos vencimientos
 * (PMCC, calendarios) que este mismo agrupado parte por la mitad.
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
    const exp = expDe(p);
    if (!und || !exp) continue;
    const clave = `${und}|${exp}`;
    if (!grupos.has(clave)) grupos.set(clave, { clave, underlying: und, expiry: exp, expiries: [exp], patas: [] });
    grupos.get(clave).patas.push(p);
  }

  return fusionarDiagonales([...grupos.values()], acciones).map(g => {
    const slug = detectarSlug(g.patas, acciones[g.underlying] || 0);
    const pmcc = esPMCC(g.patas);
    // Orden estable: puts antes que calls y por strike. Sin esto la URL cambia
    // según el orden en que TastyTrade devuelva las posiciones, y un link que
    // cambia solo deja de ser comparable con el que ya estaba guardado. En un
    // calendario los dos strikes son iguales, así que desempata el vencimiento —
    // la lejana primero, que es el orden verificado en vivo.
    const ordenadas = [...g.patas].sort((a, b) =>
      (esPut(a) !== esPut(b)) ? (esPut(a) ? -1 : 1)
      : (strikeDe(a) !== strikeDe(b)) ? strikeDe(a) - strikeDe(b)
      : expDe(b).localeCompare(expDe(a))
    );
    const porPata = ordenadas.map(legToken);
    // Una pata sin streamer-symbol rompería la figura en silencio: mejor sin link.
    const completo = porPata.every(Boolean);
    const tokens = completo ? porPata.flat() : [];
    return {
      ...g,
      slug,
      // Lo que se lee en pantalla. Un PMCC se DIBUJA como diagonal porque es lo
      // único que OptionStrat entiende, pero se NOMBRA PMCC.
      figura: pmcc ? 'PMCC' : (NOMBRE_FIGURA[slug] || null),
      esPMCC: pmcc,
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

module.exports = { agruparPosiciones, detectarSlug, legToken, esPMCC, fusionarDiagonales };
