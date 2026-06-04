'use strict';

const fs   = require('fs');
const path = require('path');
const ENV_PATH = path.join(__dirname, '..', '.env');

// â”€â”€ Black-Scholes helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function bsN(x) {
  // AproximaciÃ³n de la CDF normal estÃ¡ndar
  const a1= 0.254829592, a2=-0.284496736, a3= 1.421413741,
        a4=-1.453152027, a5= 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t) * Math.exp(-x*x);
  return 0.5 * (1 + sign * y);
}
function bsPDF(x) { return Math.exp(-0.5*x*x) / Math.sqrt(2*Math.PI); }

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
      console.log('[TT] âœ… Token guardado automÃ¡ticamente en .env');
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
          console.log('[TT] Auth via usuario/contraseÃ±a OK');
          this._saveToken(this.sessionToken); // guardar para prÃ³ximo reinicio
          return this.sessionToken;
        }
        const errText = await res.text().catch(()=>'');
        console.log('[TT] Login fallÃ³:', res.status, errText.slice(0,200));
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
      console.log('[TT] 401 â€” reautenticando...');
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

    // Intento 1: TastyTrade REST (solo mercado abierto)
    const params = symbols.map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
    try {
      const d     = await this._req(`/market-data/options?${params}`);
      const items = d.data?.items ?? [];
      if (items.length > 0) {
        const map = {};
        items.forEach(item => {
          map[item.symbol] = {
            delta: parseFloat(item.delta || 0),
            theta: parseFloat(item.theta || 0),
            gamma: parseFloat(item.gamma || 0),
            vega:  parseFloat(item.vega  || 0),
            iv:    parseFloat(item['implied-volatility'] || item.iv || 0),
            mark:  parseFloat(item.mark  || item['mid-price'] || 0),
            src:   'tt',
          };
        });
        console.log(`[Greeks] TastyTrade: ${items.length} opciones`);
        return map;
      }
    } catch(e) {}

    // Intento 2: Black-Scholes con IV de Yahoo Finance (funciona 24/7)
    console.log('[Greeks] Usando Black-Scholes + Yahoo Finance...');
    try {
      // Extraer subyacentes Ãºnicos
      const underlyings = [...new Set(symbols.map(s => {
        const m = s.match(/^([A-Z]+)\s/);
        return m ? m[1] : s.replace(/\s.*/,'').replace(/\d.*/,'');
      }))];

      // Obtener precio actual + IV de Yahoo Finance
      const priceMap = {};
      const ivMap    = {};
      for (const und of underlyings) {
        try {
          // Precio actual
          const qR = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${und}?interval=1d&range=1d`,
            { headers: { 'User-Agent': 'Mozilla/5.0' } }
          );
          const qJ  = await qR.json();
          const cls = qJ.chart?.result?.[0]?.meta?.regularMarketPrice;
          if (cls) priceMap[und] = cls;

          // IV de la cadena de opciones (primer vencimiento disponible)
          const oR = await fetch(
            `https://query1.finance.yahoo.com/v7/finance/options/${und}`,
            { headers: { 'User-Agent': 'Mozilla/5.0' } }
          );
          const oJ  = await oR.json();
          const opts = [
            ...(oJ.optionChain?.result?.[0]?.options?.[0]?.calls || []),
            ...(oJ.optionChain?.result?.[0]?.options?.[0]?.puts  || []),
          ];
          // Promedio IV de opciones ATM
          if (opts.length > 0) {
            const ivs = opts.map(o => o.impliedVolatility).filter(v => v > 0 && v < 5);
            ivMap[und] = ivs.length > 0 ? ivs.reduce((a,b)=>a+b,0)/ivs.length : 0.4;
          }
        } catch(e) {}
      }

      // Calcular Greeks con Black-Scholes para cada sÃ­mbolo
      const map = {};
      const R   = 0.0525; // tasa libre de riesgo ~5.25%

      for (const sym of symbols) {
        // Parsear sÃ­mbolo TastyTrade: "HOOD  260618C00076000"
        const m = sym.match(/^([A-Z]+)\s+(\d{2})(\d{2})(\d{2})([CP])(\d+)/);
        if (!m) continue;
        const und    = m[1];
        const yr     = parseInt('20' + m[2]);
        const mo     = parseInt(m[3]) - 1;
        const dy     = parseInt(m[4]);
        const isCall = m[5] === 'C';
        const K      = parseInt(m[6]) / 1000;

        const S  = priceMap[und];
        if (!S) continue;

        const T  = Math.max((new Date(yr, mo, dy) - Date.now()) / (365.25 * 86400000), 0.001);
        const Ïƒ  = ivMap[und] || 0.35;

        // Black-Scholes
        const d1  = (Math.log(S/K) + (R + Ïƒ*Ïƒ/2) * T) / (Ïƒ * Math.sqrt(T));
        const d2  = d1 - Ïƒ * Math.sqrt(T);
        const Nd1 = bsN(d1);
        const Nd2 = bsN(d2);
        const nd1 = bsPDF(d1);

        const delta = isCall ? Nd1 : Nd1 - 1;
        const gamma = nd1 / (S * Ïƒ * Math.sqrt(T));
        const vega  = S * nd1 * Math.sqrt(T) / 100;
        const theta = isCall
          ? (-(S * nd1 * Ïƒ) / (2 * Math.sqrt(T)) - R * K * Math.exp(-R*T) * Nd2) / 365
          : (-(S * nd1 * Ïƒ) / (2 * Math.sqrt(T)) + R * K * Math.exp(-R*T) * bsN(-d2)) / 365;

        map[sym] = {
          delta: Math.round(delta * 1000) / 1000,
          theta: Math.round(theta * 10000) / 10000,
          gamma: Math.round(gamma * 10000) / 10000,
          vega:  Math.round(vega  * 1000) / 1000,
          iv:    Math.round(Ïƒ * 100 * 10) / 10,
          mark:  0,
          src:   'bs',
        };
      }
      console.log(`[Greeks] Black-Scholes: ${Object.keys(map).length}/${symbols.length} opciones`);
      return map;
    } catch(e) {
      console.log('[Greeks] Error Black-Scholes:', e.message);
      return {};
    }
  }

  async getTransactions({ startDate, endDate, perPage = 250, pageOffset = 0 } = {}) {
    let url = `/accounts/${this.accountNumber}/transactions?per-page=${perPage}&page-offset=${pageOffset}&sort=Desc`;
    if (startDate) url += `&start-date=${startDate}`;
    if (endDate)   url += `&end-date=${endDate}`;
    const d = await this._req(url);
    // PaginaciÃ³n estÃ¡ en la raÃ­z de la respuesta, no dentro de data
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
      if (offset % 10 === 0) console.log(`[TT] Cargando transacciones... pÃ¡gina ${offset}/${totalPages}`);
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
