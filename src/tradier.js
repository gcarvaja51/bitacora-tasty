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
  async closeSpreadOrder({ strategy, underlyingRoot, expiry, shortStrike, longStrike, quantity }) {
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

  // Cotizaciones actuales (mark/bid/ask) para una lista de simbolos OCC — necesario
  // para calcular cuanto costaria cerrar una posicion abierta ahora mismo (no habia
  // ningun metodo de cotizacion en este cliente).
  async getQuotes(symbols) {
    if (!symbols || !symbols.length) return [];
    const data = await this._req(`/markets/quotes?symbols=${encodeURIComponent(symbols.join(','))}`);
    const raw  = data.quotes?.quote;
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    return list.map(q => ({
      symbol: q.symbol,
      mark: q.bid != null && q.ask != null ? (parseFloat(q.bid) + parseFloat(q.ask)) / 2 : parseFloat(q.last || 0),
      bid:  parseFloat(q.bid  || 0),
      ask:  parseFloat(q.ask  || 0),
      last: parseFloat(q.last || 0),
    }));
  }

  // Coloca la orden multi-leg (4 patas) para Iron Condor: short put + long put +
  // short call + long call, todas en la misma orden combinada.
  async placeIronCondorOrder({ underlyingRoot, expiry, putShortStrike, putLongStrike, callShortStrike, callLongStrike, quantity }) {
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
}

module.exports = { TradierClient };
