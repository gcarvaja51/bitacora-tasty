'use strict';

const DEFAULT_BASE = 'https://sandbox.tradier.com/v1';

class TradierClient {
  constructor({ accessToken, accountNumber, baseUrl } = {}) {
    this.accessToken   = accessToken   || process.env.TRADIER_ACCESS_TOKEN   || null;
    this.accountNumber = accountNumber || process.env.TRADIER_ACCOUNT_NUMBER || null;
    this.baseUrl       = baseUrl       || process.env.TRADIER_BASE_URL       || DEFAULT_BASE;
  }

  async _req(path, opts = {}) {
    if (!this.accessToken) throw new Error('Falta TRADIER_ACCESS_TOKEN en .env');
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
        ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch(e) { json = { raw: text }; }
    if (!res.ok) throw new Error(`Tradier API ${res.status} ${path}: ${text.slice(0, 300)}`);
    return json;
  }

  // Simbolo OCC: {root, pad a 6 con espacios}{YYMMDD}{C|P}{strike*1000, 8 digitos}
  buildOccSymbol(root, expiryISO, optType, strike) {
    const [y, m, d] = expiryISO.split('-');
    const yymmdd = y.slice(2) + m + d;
    const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0');
    return `${root}${yymmdd}${optType}${strikeStr}`;
  }

  // ── Chequeo de capacidad de ORDENAR (2026-08-03) ───────────────────
  // Valida la ruta completa de colocacion de ordenes SIN colocar ninguna,
  // usando el modo `preview=true` de Tradier (valida y devuelve el costo
  // estimado, pero no ejecuta). Nace de un incidente real: el 3-ago el
  // sandbox empezo a rechazar TODA orden con "Application key is not defined
  // or does not exist" mientras las lecturas seguian dando 200 -- se
  // descubrio recien con el mercado abierto, tras 50 señales perdidas,
  // porque nada verificaba la capacidad de ESCRIBIR (el unico health check
  // que existia, checkDirectionalMonitorHealth, solo mira que el proceso
  // monitor este vivo).
  //
  // Devuelve { ok:true } si Tradier acepta la orden de prueba, o
  // { ok:false, status, error } con el detalle para poder alertar.
  // IMPORTANTE (aprendido en el mismo incidente): Tradier puede devolver
  // HTTP 200 con el error adentro del cuerpo (`{"errors":{"error":"..."}}`),
  // asi que NO alcanza con que _req() no tire excepcion -- hay que inspeccionar
  // la respuesta. Un primer intento de este chequeo daba falso OK por eso.
  //
  // Tambien prueba el SPREAD de 2 patas (lo que realmente operan las
  // estrategias), no una pata suelta: un `sell_to_open` solo es una call
  // desnuda y exige el nivel de permiso de opciones mas alto de la cuenta, asi
  // que podia fallar por permisos aunque el spread (riesgo definido, nivel mas
  // bajo) funcionara perfecto -- otro falso positivo evitado.
  async checkOrderCapability() {
    if (!this.accountNumber) return { ok: false, status: 0, error: 'Falta TRADIER_ACCOUNT_NUMBER en .env' };
    // Vencimiento de prueba: el proximo viernes (siempre existe en SPXW).
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7 || 7));
    const expiry = d.toISOString().slice(0, 10);

    // Los strikes NO se inventan: se toman dos consecutivos reales de la
    // cadena. Un primer intento hardcodeaba 9000/9010 y fallaba con
    // "Undefined symbol" -- lejos del dinero SPX no usa incrementos de 10, asi
    // que el chequeo reportaba un problema que no existia (falso negativo, tan
    // malo como el falso positivo que ya se corrigio arriba).
    let shortSym, longSym;
    try {
      const chain = await this._req(`/markets/options/chains?symbol=SPX&expiration=${expiry}`);
      const opts = (chain?.options?.option || []).filter(o => o.option_type === 'call' && o.symbol?.startsWith('SPXW'));
      if (opts.length < 2) return { ok: false, status: 0, error: `Cadena de SPXW vacia para ${expiry} — no se pudo armar la orden de prueba` };
      opts.sort((a, b) => a.strike - b.strike);
      const i = Math.max(0, opts.length - 2); // dos strikes reales consecutivos, bien OTM
      shortSym = opts[i].symbol;
      longSym  = opts[i + 1].symbol;
    } catch (e) {
      return { ok: false, status: 0, error: `No se pudo leer la cadena para armar la prueba: ${e.message}` };
    }

    const body = new URLSearchParams({
      class: 'multileg', symbol: 'SPXW', type: 'market', duration: 'day',
      'option_symbol[0]': shortSym, 'side[0]': 'sell_to_open', 'quantity[0]': '1',
      'option_symbol[1]': longSym,  'side[1]': 'buy_to_open',  'quantity[1]': '1',
      preview: 'true', // <- valida y devuelve costo estimado, NO coloca nada
    });

    try {
      const data = await this._req(`/accounts/${this.accountNumber}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      // Error embebido en un 200
      const err = data?.errors?.error;
      if (err) return { ok: false, status: 200, error: Array.isArray(err) ? err.join(' | ') : String(err) };
      if (data?.order?.status !== 'ok') {
        return { ok: false, status: 200, error: `Respuesta inesperada: ${JSON.stringify(data).slice(0, 200)}` };
      }
      return { ok: true };
    } catch (e) {
      const m = /Tradier API (\d+)/.exec(e.message || '');
      return { ok: false, status: m ? Number(m[1]) : 0, error: e.message };
    }
  }

  // Balance real de la cuenta (Net Liq, cash, buying power)
  async getBalances() {
    if (!this.accountNumber) throw new Error('Falta TRADIER_ACCOUNT_NUMBER en .env');
    const data = await this._req(`/accounts/${this.accountNumber}/balances`);
    return data.balances || null;
  }

  // Lista de posiciones abiertas de la cuenta (array normalizado, nunca null)
  async getPositions() {
    if (!this.accountNumber) throw new Error('Falta TRADIER_ACCOUNT_NUMBER en .env');
    const data = await this._req(`/accounts/${this.accountNumber}/positions`);
    const raw  = data.positions?.position;
    return Array.isArray(raw) ? raw : (raw ? [raw] : []);
  }

  // Lista de ordenes de la cuenta (array normalizado, nunca null)
  async getOrders() {
    if (!this.accountNumber) throw new Error('Falta TRADIER_ACCOUNT_NUMBER en .env');
    const data = await this._req(`/accounts/${this.accountNumber}/orders`);
    const raw  = data.orders?.order;
    return Array.isArray(raw) ? raw : (raw ? [raw] : []);
  }

  // Detalle de una orden puntual (fills por pata incluidos)
  async getOrder(orderId) {
    if (!this.accountNumber) throw new Error('Falta TRADIER_ACCOUNT_NUMBER en .env');
    const data = await this._req(`/accounts/${this.accountNumber}/orders/${orderId}`);
    return data.order || null;
  }

  // Cancela una orden pendiente (limpieza de pruebas — las ordenes de prueba en
  // sandbox a veces quedan 'pending' indefinidamente y bloquean hasOpenPosition)
  async cancelOrder(orderId) {
    if (!this.accountNumber) throw new Error('Falta TRADIER_ACCOUNT_NUMBER en .env');
    const data = await this._req(`/accounts/${this.accountNumber}/orders/${orderId}`, { method: 'DELETE' });
    return data.order || null;
  }

  // P&L realizado de posiciones ya cerradas, desde una fecha (YYYY-MM-DD).
  // Devuelve null si Tradier no trae el dato limpio — nunca inventa un numero.
  async getClosedPnl(sinceDate) {
    if (!this.accountNumber) throw new Error('Falta TRADIER_ACCOUNT_NUMBER en .env');
    try {
      const data = await this._req(`/accounts/${this.accountNumber}/gainloss?start=${sinceDate}`);
      const raw  = data.gainloss?.closed_position;
      const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      return list;
    } catch(e) {
      console.error('[Tradier] getClosedPnl error:', e.message);
      return null;
    }
  }

  // Revisa si ya hay una posicion abierta o una orden en curso para el root dado
  // (ej. "SPXW") — evita apilar un trade nuevo antes de que el anterior cierre.
  async hasOpenPosition(root) {
    const posList = await this.getPositions();
    const hasPosition = posList.some(p => (p.symbol || '').startsWith(root));

    const ordList = await this.getOrders();
    const openStates = ['open', 'pending', 'partially_filled'];
    const hasOpenOrder = ordList.some(o => {
      if (!openStates.includes((o.status || '').toLowerCase())) return false;
      const legs = Array.isArray(o.leg) ? o.leg : (o.leg ? [o.leg] : []);
      return (o.symbol || '').startsWith(root) || legs.some(l => (l.option_symbol || '').startsWith(root));
    });

    return hasPosition || hasOpenOrder;
  }

  // Coloca la orden multi-leg (2 patas) para las 4 verticales direccionales —
  // credito (Bull Put/Bear Call) y debito (Bull Call/Bear Put). shortStrike
  // siempre es la pata que se vende, longStrike la que se compra, consistente
  // en las 4 estrategias (ver findStrikesByDelta en src/spx.js) — lo unico que
  // cambia es el tipo de opcion. Bug corregido 2026-07-08: el ternario viejo
  // solo distinguia BULL_PUT_SPREAD, así que BEAR_PUT_SPREAD (que necesita
  // puts) caia al default 'C' e intentaba operar calls por error.
  async placeSpreadOrder({ strategy, underlyingRoot, expiry, shortStrike, longStrike, quantity }) {
    if (!this.accountNumber) throw new Error('Falta TRADIER_ACCOUNT_NUMBER en .env');
    const optType  = (strategy === 'BULL_PUT_SPREAD' || strategy === 'BEAR_PUT_SPREAD') ? 'P' : 'C';
    const shortSym = this.buildOccSymbol(underlyingRoot, expiry, optType, shortStrike);
    const longSym  = this.buildOccSymbol(underlyingRoot, expiry, optType, longStrike);

    const body = new URLSearchParams({
      class:    'multileg',
      symbol:   underlyingRoot,
      type:     'market',
      duration: 'day',
      'option_symbol[0]': shortSym,
      'side[0]':          'sell_to_open',
      'quantity[0]':      String(quantity),
      'option_symbol[1]': longSym,
      'side[1]':          'buy_to_open',
      'quantity[1]':      String(quantity),
    });

    const data = await this._req(`/accounts/${this.accountNumber}/orders`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    });

    return {
      orderId: data.order?.id ?? null,
      status:  data.order?.status ?? 'unknown',
      legs:    { shortSym, longSym },
      raw:     data,
    };
  }

  // Cierra el spread direccional (2 patas) — orden inversa a placeSpreadOrder:
  // buy_to_close la corta, sell_to_close la larga. No existia — el auto-cierre
  // de direccionales dependia de que el usuario cerrara a mano en Tradier.
  //
  // worstNetPrice (2026-07-20, a pedido del usuario tras un caso real): antes esta
  // orden siempre iba 'type: market', sin ningun piso/techo de precio neto — un
  // Bear Put Spread (7460/7470, 2 contratos, $860 de debito pagado) se cerro por
  // TECHNICAL_STOP en un movimiento rapido de 0DTE y termino costando $1,640 para
  // cerrar (reconstruido con el gain_loss real de Tradier: pata larga vendida en
  // $1,620 tras haber costado $3,160 al abrir, pata corta recomprada en $2,320 tras
  // haber dado $2,220 al abrir) — muy por encima del "maximo teorico" de perdida de
  // un debito ($860), porque ese limite solo aplica a un precio neto limpio, no a
  // dos patas ejecutadas a mercado con el spread bid/ask cruzado en cada una. Mismo
  // criterio de cautela que minCreditPrice en placeIronCondorOrder: si se pasa
  // worstNetPrice (convencion: positivo = credito minimo aceptado al cerrar,
  // negativo = -1 * debito maximo aceptado), la orden se manda como 'credit'/'debit'
  // con ese precio como piso/techo en vez de 'market'. Sin este parametro, se
  // comporta igual que antes (market, sin proteccion) — no rompe nada existente.
  async closeSpreadOrder({ strategy, underlyingRoot, expiry, shortStrike, longStrike, quantity, worstNetPrice }) {
    if (!this.accountNumber) throw new Error('Falta TRADIER_ACCOUNT_NUMBER en .env');
    const optType  = (strategy === 'BULL_PUT_SPREAD' || strategy === 'BEAR_PUT_SPREAD') ? 'P' : 'C';
    const shortSym = this.buildOccSymbol(underlyingRoot, expiry, optType, shortStrike);
    const longSym  = this.buildOccSymbol(underlyingRoot, expiry, optType, longStrike);

    const body = new URLSearchParams({
      class:    'multileg',
      symbol:   underlyingRoot,
      type:     worstNetPrice == null ? 'market' : (worstNetPrice >= 0 ? 'credit' : 'debit'),
      duration: 'day',
      ...(worstNetPrice == null ? {} : { price: String(Math.abs(worstNetPrice)) }),
      'option_symbol[0]': shortSym,
      'side[0]':          'buy_to_close',
      'quantity[0]':      String(quantity),
      'option_symbol[1]': longSym,
      'side[1]':          'sell_to_close',
      'quantity[1]':      String(quantity),
    });

    const data = await this._req(`/accounts/${this.accountNumber}/orders`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    });

    return {
      orderId: data.order?.id ?? null,
      status:  data.order?.status ?? 'unknown',
      legs:    { shortSym, longSym },
      raw:     data,
    };
  }

  // Cierra UNA sola pata (orden simple, no multileg) — para el caso de emergencia
  // donde un multileg quedo parcialmente lleno (ej. solo la corta llenó, la larga
  // de proteccion no) y hay que aplanar cada pata llenada individualmente en vez
  // de la reversa combinada (que asume que TODAS las patas originales siguen abiertas).
  async closeSingleLeg({ underlyingRoot, optionSymbol, side, quantity }) {
    if (!this.accountNumber) throw new Error('Falta TRADIER_ACCOUNT_NUMBER en .env');
    const body = new URLSearchParams({
      class:          'option',
      symbol:         underlyingRoot,
      option_symbol:  optionSymbol,
      side,           // 'buy_to_close' o 'sell_to_close'
      quantity:       String(quantity),
      type:           'market',
      duration:       'day',
    });
    const data = await this._req(`/accounts/${this.accountNumber}/orders`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    });
    return {
      orderId: data.order?.id ?? null,
      status:  data.order?.status ?? 'unknown',
      raw:     data,
    };
  }

  // Abre UNA sola pata (orden simple, no multileg) — contraparte de closeSingleLeg,
  // que solo cierra. Usado por la Rueda automatizada para vender el CSP inicial
  // (sell_to_open) y, mas adelante, la Covered Call. limitPrice opcional: si se
  // pasa, manda una orden limit a ese precio en vez de a mercado (mismo criterio
  // de cautela que minCreditPrice en placeIronCondorOrder — no aceptar un fill
  // peor al que se vio al momento de colocar la orden).
  async placeSingleLegOrder({ underlyingRoot, optionSymbol, side, quantity, limitPrice }) {
    if (!this.accountNumber) throw new Error('Falta TRADIER_ACCOUNT_NUMBER en .env');
    const params = {
      class:          'option',
      symbol:         underlyingRoot,
      option_symbol:  optionSymbol,
      side,           // 'sell_to_open' | 'buy_to_open' | 'sell_to_close' | 'buy_to_close'
      quantity:       String(quantity),
      duration:       'day',
    };
    if (limitPrice != null) { params.type = 'limit'; params.price = String(limitPrice); }
    else                    { params.type = 'market'; }
    const body = new URLSearchParams(params);
    const data = await this._req(`/accounts/${this.accountNumber}/orders`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    });
    return {
      orderId: data.order?.id ?? null,
      status:  data.order?.status ?? 'unknown',
      raw:     data,
    };
  }

  // ── Roll ATOMICO (2026-08-03) ──────────────────────────────────────────────
  // Tradier no tiene un tipo de orden "roll", pero SI soporta multileg — y un
  // roll es exactamente eso: cerrar la pata vieja y abrir la nueva EN LA MISMA
  // orden. O llenan las dos, o no llena ninguna.
  //
  // Por que existe: hasta ahora el roll de la Rueda se mandaba como DOS ordenes
  // separadas (closeSingleLeg y despues placeSingleLegOrder). Cuando la segunda
  // fallaba o no llenaba, la posicion quedaba FLAT y sin proteccion, con el
  // registro marcado 'ROLL_REAPERTURA_FALLIDA'. Le paso a 7 posiciones (RIO,
  // NBIS, HOOD, RKLB, BE, IBIT y ANET) — no era un caso raro, era el modo de
  // falla dominante del pipeline. El usuario lo detecto mirando Tradier: "el
  // roll es automatico, cierra posicion y abre posicion... la veo abierta".
  //
  // netCreditMin: crédito neto mínimo aceptado (>=0 = nunca pagar por rolar).
  // Si el mercado no lo da, la orden no llena y la posicion vieja sigue INTACTA
  // — que es justamente el punto de hacerlo atomico.
  async placeRollOrder({ underlyingRoot, oldOptionSymbol, newOptionSymbol, quantity, optType = 'P', netCreditMin = 0 }) {
    if (!this.accountNumber) throw new Error('Falta TRADIER_ACCOUNT_NUMBER en .env');
    const params = {
      class:              'multileg',
      symbol:             underlyingRoot,
      type:               'credit',
      duration:           'day',
      price:              String(Math.max(0, netCreditMin).toFixed(2)),
      'option_symbol[0]': oldOptionSymbol,
      'side[0]':          'buy_to_close',
      'quantity[0]':      String(quantity),
      'option_symbol[1]': newOptionSymbol,
      'side[1]':          'sell_to_open',
      'quantity[1]':      String(quantity),
    };
    const data = await this._req(`/accounts/${this.accountNumber}/orders`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams(params).toString(),
    });
    return { orderId: data.order?.id ?? null, status: data.order?.status ?? 'unknown', raw: data };
  }

  // Cotizaciones actuales (mark/bid/ask) para una lista de simbolos OCC — necesario
  // para calcular cuanto costaria cerrar una posicion abierta ahora mismo (no habia
  // ningun metodo de cotizacion en este cliente).
  // greeks (2026-08-03): Tradier devuelve delta/theta/gamma/vega/IV en el MISMO
  // endpoint de cotizaciones con `greeks=true` -- no hace falta traer la cadena
  // completa por vencimiento (que era la alternativa, mucho mas pesada). Se pide
  // siempre: para acciones el campo simplemente no viene y queda en null, no
  // rompe a ningun consumidor existente.
  async getQuotes(symbols) {
    if (!symbols || !symbols.length) return [];
    const data = await this._req(`/markets/quotes?greeks=true&symbols=${encodeURIComponent(symbols.join(','))}`);
    const raw  = data.quotes?.quote;
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    return list.map(q => {
      const g = q.greeks || null;
      return {
        symbol: q.symbol,
        mark: q.bid != null && q.ask != null ? (parseFloat(q.bid) + parseFloat(q.ask)) / 2 : parseFloat(q.last || 0),
        bid:  parseFloat(q.bid  || 0),
        ask:  parseFloat(q.ask  || 0),
        last: parseFloat(q.last || 0),
        delta: g && g.delta != null ? parseFloat(g.delta) : null,
        theta: g && g.theta != null ? parseFloat(g.theta) : null,
        gamma: g && g.gamma != null ? parseFloat(g.gamma) : null,
        vega:  g && g.vega  != null ? parseFloat(g.vega)  : null,
        iv:    g && g.mid_iv != null ? parseFloat(g.mid_iv) : null,
      };
    });
  }

  // Velas intradia (timesales) para un simbolo — usado para reemplazar el feed de
  // Yahoo Finance en buildSPXContext() (server.js): Yahoo demostro servir datos
  // congelados/cacheados en vivo el 2026-07-24 (SPX se movio ~54pts en 2h44min
  // mientras Yahoo devolvia el mismo precio exacto en cada llamada), probablemente
  // por caching/rate-limit silencioso de su CDN ante requests repetidos desde la
  // misma IP. Tradier es el mismo broker que ya usamos para ejecutar ordenes reales
  // (misma cuenta, mismo SLA del que ya depende todo el sistema) y expone velas
  // intradia reales via /markets/timesales. interval: '1min'|'2min'|'5min'|'15min'.
  // start/end: 'YYYY-MM-DD HH:MM' (hora del servidor de Tradier, ET).
  async getTimesales(symbol, interval, start, end) {
    const params = new URLSearchParams({ symbol, interval });
    if (start) params.set('start', start);
    if (end)   params.set('end', end);
    const data = await this._req(`/markets/timesales?${params.toString()}`);
    const rows = data.series?.data;
    const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
    return list.map(r => ({
      timestamp: r.timestamp,
      open:  r.open  != null ? parseFloat(r.open)  : null,
      high:  r.high  != null ? parseFloat(r.high)  : null,
      low:   r.low   != null ? parseFloat(r.low)   : null,
      close: r.close != null ? parseFloat(r.close) : null,
      volume: r.volume != null ? parseFloat(r.volume) : 0,
    }));
  }

  // Coloca la orden multi-leg (4 patas) para Iron Condor: short put + long put +
  // short call + long call, todas en la misma orden combinada.
  // minCreditPrice (2026-07-09, a pedido del usuario): si se pasa, la orden se manda
  // como limit de credito neto ('type: credit', 'price') en vez de 'market' — si el
  // mercado no da ese credito minimo, la orden simplemente no llena (no se abre) en vez
  // de ejecutar a mercado y despues tener que cerrarla por no cumplir el gate del 25%,
  // pagando comisiones de apertura Y cierre por una posicion que nunca deberia haber
  // entrado. Sin este parametro, se comporta igual que antes (market).
  async placeIronCondorOrder({ underlyingRoot, expiry, putShortStrike, putLongStrike, callShortStrike, callLongStrike, quantity, minCreditPrice }) {
    if (!this.accountNumber) throw new Error('Falta TRADIER_ACCOUNT_NUMBER en .env');
    const putShortSym  = this.buildOccSymbol(underlyingRoot, expiry, 'P', putShortStrike);
    const putLongSym   = this.buildOccSymbol(underlyingRoot, expiry, 'P', putLongStrike);
    const callShortSym = this.buildOccSymbol(underlyingRoot, expiry, 'C', callShortStrike);
    const callLongSym  = this.buildOccSymbol(underlyingRoot, expiry, 'C', callLongStrike);

    const body = new URLSearchParams({
      class:    'multileg',
      symbol:   underlyingRoot,
      type:     minCreditPrice != null ? 'credit' : 'market',
      duration: 'day',
      ...(minCreditPrice != null ? { price: String(minCreditPrice) } : {}),
      'option_symbol[0]': putShortSym,  'side[0]': 'sell_to_open', 'quantity[0]': String(quantity),
      'option_symbol[1]': putLongSym,   'side[1]': 'buy_to_open',  'quantity[1]': String(quantity),
      'option_symbol[2]': callShortSym, 'side[2]': 'sell_to_open', 'quantity[2]': String(quantity),
      'option_symbol[3]': callLongSym,  'side[3]': 'buy_to_open',  'quantity[3]': String(quantity),
    });

    const data = await this._req(`/accounts/${this.accountNumber}/orders`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    });

    return {
      orderId: data.order?.id ?? null,
      status:  data.order?.status ?? 'unknown',
      legs:    { putShortSym, putLongSym, callShortSym, callLongSym },
      raw:     data,
    };
  }

  // Cierra las 4 patas del Iron Condor — orden inversa (buy_to_close en las cortas,
  // sell_to_close en las largas).
  async closeIronCondorOrder({ underlyingRoot, expiry, putShortStrike, putLongStrike, callShortStrike, callLongStrike, quantity }) {
    if (!this.accountNumber) throw new Error('Falta TRADIER_ACCOUNT_NUMBER en .env');
    const putShortSym  = this.buildOccSymbol(underlyingRoot, expiry, 'P', putShortStrike);
    const putLongSym   = this.buildOccSymbol(underlyingRoot, expiry, 'P', putLongStrike);
    const callShortSym = this.buildOccSymbol(underlyingRoot, expiry, 'C', callShortStrike);
    const callLongSym  = this.buildOccSymbol(underlyingRoot, expiry, 'C', callLongStrike);

    const body = new URLSearchParams({
      class:    'multileg',
      symbol:   underlyingRoot,
      type:     'market',
      duration: 'day',
      'option_symbol[0]': putShortSym,  'side[0]': 'buy_to_close',  'quantity[0]': String(quantity),
      'option_symbol[1]': putLongSym,   'side[1]': 'sell_to_close', 'quantity[1]': String(quantity),
      'option_symbol[2]': callShortSym, 'side[2]': 'buy_to_close',  'quantity[2]': String(quantity),
      'option_symbol[3]': callLongSym,  'side[3]': 'sell_to_close', 'quantity[3]': String(quantity),
    });

    const data = await this._req(`/accounts/${this.accountNumber}/orders`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    });

    return {
      orderId: data.order?.id ?? null,
      status:  data.order?.status ?? 'unknown',
      legs:    { putShortSym, putLongSym, callShortSym, callLongSym },
      raw:     data,
    };
  }

  // Long Put Condor (4 patas, todas puts, DEBITO) — alternativa al Iron Condor cuando
  // el IV Rank esta bajo (ver evaluateIronCondorGate/checkIronCondor). Compra las dos
  // alas externas, vende las dos internas (el "cuerpo").
  // maxDebitPrice (mismo criterio que minCreditPrice en placeIronCondorOrder): si se
  // pasa, manda la orden como limit de debito neto maximo en vez de a mercado.
  async placeDebitCondorOrder({ underlyingRoot, expiry, outerHighStrike, innerHighStrike, innerLowStrike, outerLowStrike, quantity, maxDebitPrice }) {
    if (!this.accountNumber) throw new Error('Falta TRADIER_ACCOUNT_NUMBER en .env');
    const outerHighSym = this.buildOccSymbol(underlyingRoot, expiry, 'P', outerHighStrike);
    const innerHighSym = this.buildOccSymbol(underlyingRoot, expiry, 'P', innerHighStrike);
    const innerLowSym  = this.buildOccSymbol(underlyingRoot, expiry, 'P', innerLowStrike);
    const outerLowSym  = this.buildOccSymbol(underlyingRoot, expiry, 'P', outerLowStrike);

    const body = new URLSearchParams({
      class:    'multileg',
      symbol:   underlyingRoot,
      type:     maxDebitPrice != null ? 'debit' : 'market',
      duration: 'day',
      ...(maxDebitPrice != null ? { price: String(maxDebitPrice) } : {}),
      'option_symbol[0]': outerHighSym, 'side[0]': 'buy_to_open',  'quantity[0]': String(quantity),
      'option_symbol[1]': innerHighSym, 'side[1]': 'sell_to_open', 'quantity[1]': String(quantity),
      'option_symbol[2]': innerLowSym,  'side[2]': 'sell_to_open', 'quantity[2]': String(quantity),
      'option_symbol[3]': outerLowSym,  'side[3]': 'buy_to_open',  'quantity[3]': String(quantity),
    });

    const data = await this._req(`/accounts/${this.accountNumber}/orders`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    });

    return {
      orderId: data.order?.id ?? null,
      status:  data.order?.status ?? 'unknown',
      legs:    { outerHighSym, innerHighSym, innerLowSym, outerLowSym },
      raw:     data,
    };
  }

  // Cierra las 4 patas del Long Put Condor — inverso: vender las alas compradas,
  // recomprar el cuerpo vendido.
  async closeDebitCondorOrder({ underlyingRoot, expiry, outerHighStrike, innerHighStrike, innerLowStrike, outerLowStrike, quantity }) {
    if (!this.accountNumber) throw new Error('Falta TRADIER_ACCOUNT_NUMBER en .env');
    const outerHighSym = this.buildOccSymbol(underlyingRoot, expiry, 'P', outerHighStrike);
    const innerHighSym = this.buildOccSymbol(underlyingRoot, expiry, 'P', innerHighStrike);
    const innerLowSym  = this.buildOccSymbol(underlyingRoot, expiry, 'P', innerLowStrike);
    const outerLowSym  = this.buildOccSymbol(underlyingRoot, expiry, 'P', outerLowStrike);

    const body = new URLSearchParams({
      class:    'multileg',
      symbol:   underlyingRoot,
      type:     'market',
      duration: 'day',
      'option_symbol[0]': outerHighSym, 'side[0]': 'sell_to_close', 'quantity[0]': String(quantity),
      'option_symbol[1]': innerHighSym, 'side[1]': 'buy_to_close',  'quantity[1]': String(quantity),
      'option_symbol[2]': innerLowSym,  'side[2]': 'buy_to_close',  'quantity[2]': String(quantity),
      'option_symbol[3]': outerLowSym,  'side[3]': 'sell_to_close', 'quantity[3]': String(quantity),
    });

    const data = await this._req(`/accounts/${this.accountNumber}/orders`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    });

    return {
      orderId: data.order?.id ?? null,
      status:  data.order?.status ?? 'unknown',
      legs:    { outerHighSym, innerHighSym, innerLowSym, outerLowSym },
      raw:     data,
    };
  }
}

module.exports = { TradierClient };
