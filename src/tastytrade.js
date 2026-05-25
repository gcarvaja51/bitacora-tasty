'use strict';

const fs   = require('fs');
const path = require('path');
const ENV_PATH = path.join(__dirname, '..', '.env');

const BASE = 'https://api.tastytrade.com';
const HEADERS_BASE = {
  'Content-Type': 'application/json',
  'User-Agent':   'python-requests/2.28.2',
  Accept:         '*/*',
};

class TastytradeClient {
  constructor({ username, password, rememberToken, sessionToken, accountNumber }) {
    this.username      = username;
    this.password      = password;
    this.rememberToken = rememberToken;
    this.accountNumber = accountNumber;
    this.sessionToken  = sessionToken || null;
    this._authPromise  = null;
  }

  async authenticate() {
    if (this.sessionToken) {
      console.log('[TT] Usando session token existente');
      return this.sessionToken;
    }
    if (this._authPromise) return this._authPromise;
    this._authPromise = this._doAuth().finally(() => { this._authPromise = null; });
    return this._authPromise;
  }

  _saveToken(token) {
    try {
      let env = fs.readFileSync(ENV_PATH, 'utf8');
      if (env.includes('TT_SESSION_TOKEN=')) {
        env = env.replace(/TT_SESSION_TOKEN=.*/m, `TT_SESSION_TOKEN=${token}`);
      } else {
        env += `\nTT_SESSION_TOKEN=${token}`;
      }
      fs.writeFileSync(ENV_PATH, env, 'utf8');
      console.log('[TT] ✅ Token guardado automáticamente en .env');
    } catch(e) {
      console.log('[TT] No se pudo guardar token:', e.message);
    }
  }

  async _doAuth() {
    if (this.username && this.password) {
      try {
        const res = await fetch(`${BASE}/sessions`, {
          method:  'POST',
          headers: { ...HEADERS_BASE },
          body:    JSON.stringify({ login: this.username, password: this.password, 'remember-me': true }),
        });
        if (res.ok) {
          const json = await res.json();
          this.sessionToken = json.data?.['session-token'];
          console.log('[TT] Auth via usuario/contraseña OK');
          this._saveToken(this.sessionToken); // guardar para próximo reinicio
          return this.sessionToken;
        }
        const errText = await res.text().catch(()=>'');
        console.log('[TT] Login falló:', res.status, errText.slice(0,200));
      } catch(e) {
        console.log('[TT] Error de red en auth:', e.message);
      }
    }
    throw new Error('No se pudo autenticar. Actualiza TT_SESSION_TOKEN manualmente.');
  }

  async _req(path, opts = {}, isRetry = false) {
    if (!this.sessionToken) await this.authenticate();

    const res = await fetch(`${BASE}${path}`, {
      ...opts,
      headers: { ...HEADERS_BASE, Authorization: this.sessionToken, ...opts.headers },
    });

    if (res.status === 401 && !isRetry) {
      console.log('[TT] 401 — reautenticando...');
      this.sessionToken = null;
      await this._doAuth();
      return this._req(path, opts, true);
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`TT API ${res.status} ${path}: ${txt}`);
    }
    return res.json();
  }

  async getBalances() {
    const d = await this._req(`/accounts/${this.accountNumber}/balances`);
    return d.data;
  }

  async getPositions() {
    const d = await this._req(`/accounts/${this.accountNumber}/positions`);
    return d.data?.items ?? [];
  }

  async getGreeks(symbols = []) {
    if (!symbols.length) return {};
    // TastyTrade market data endpoint para Greeks
    const params = symbols.map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
    try {
      const d = await this._req(`/market-data/options?${params}`);
      const items = d.data?.items ?? [];
      const map = {};
      items.forEach(item => {
        map[item.symbol] = {
          delta:       parseFloat(item.delta      || 0),
          theta:       parseFloat(item.theta      || 0),
          gamma:       parseFloat(item.gamma      || 0),
          vega:        parseFloat(item.vega       || 0),
          iv:          parseFloat(item['implied-volatility'] || item.iv || 0),
          mark:        parseFloat(item.mark       || item['mid-price'] || 0),
        };
      });
      return map;
    } catch(e) {
      console.log('[TT] Greeks no disponibles:', e.message);
      return {};
    }
  }

  async getTransactions({ startDate, endDate, perPage = 250, pageOffset = 0 } = {}) {
    let url = `/accounts/${this.accountNumber}/transactions?per-page=${perPage}&page-offset=${pageOffset}&sort=Desc`;
    if (startDate) url += `&start-date=${startDate}`;
    if (endDate)   url += `&end-date=${endDate}`;
    const d = await this._req(url);
    // Paginación está en la raíz de la respuesta, no dentro de data
    return { items: d.data?.items ?? [], pagination: d.pagination };
  }

  async getAllTransactions(startDate, endDate) {
    const all = [];
    let offset = 0, totalPages = 1;
    do {
      const d = await this.getTransactions({ startDate, endDate, pageOffset: offset });
      all.push(...d.items);
      totalPages = d.pagination?.['total-pages'] ?? 1;
      offset++;
      if (offset % 10 === 0) console.log(`[TT] Cargando transacciones... página ${offset}/${totalPages}`);
    } while (offset < totalPages);
    console.log(`[TT] Total transacciones cargadas: ${all.length}`);
    return all;
  }

  async getNLVHistory(timeBack = '1y') {
    const d = await this._req(`/accounts/${this.accountNumber}/net-liquidating-value-history?time-back=${timeBack}`);
    return d.data?.items ?? [];
  }
}

module.exports = { TastytradeClient };
