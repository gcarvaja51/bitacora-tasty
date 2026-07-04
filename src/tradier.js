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

  // Revisa si ya hay una posicion abierta o una orden en curso para el root dado
  // (ej. "SPXW") — evita apilar un trade nuevo antes de que el anterior cierre.
  async hasOpenPosition(root) {
    if (!this.accountNumber) throw new Error('Falta TRADIER_ACCOUNT_NUMBER en .env');

    const posData = await this._req(`/accounts/${this.accountNumber}/positions`);
    const posRaw  = posData.positions?.position;
    const posList = Array.isArray(posRaw) ? posRaw : (posRaw ? [posRaw] : []);
    const hasPosition = posList.some(p => (p.symbol || '').startsWith(root));

    const ordData = await this._req(`/accounts/${this.accountNumber}/orders`);
    const ordRaw  = ordData.orders?.order;
    const ordList = Array.isArray(ordRaw) ? ordRaw : (ordRaw ? [ordRaw] : []);
    const openStates = ['open', 'pending', 'partially_filled'];
    const hasOpenOrder = ordList.some(o => {
      if (!openStates.includes((o.status || '').toLowerCase())) return false;
      const legs = Array.isArray(o.leg) ? o.leg : (o.leg ? [o.leg] : []);
      return (o.symbol || '').startsWith(root) || legs.some(l => (l.option_symbol || '').startsWith(root));
    });

    return hasPosition || hasOpenOrder;
  }

  // Coloca la orden multi-leg (2 patas) para Bull Put Spread / Bear Call Spread
  async placeSpreadOrder({ strategy, underlyingRoot, expiry, shortStrike, longStrike, quantity }) {
    if (!this.accountNumber) throw new Error('Falta TRADIER_ACCOUNT_NUMBER en .env');
    const optType  = strategy === 'BULL_PUT_SPREAD' ? 'P' : 'C';
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
}

module.exports = { TradierClient };
