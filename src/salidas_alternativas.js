'use strict';

// ── Trazabilidad de salidas alternativas (2026-08-04) ───────────────────────
//
// Por que existe: el TP real cierra al 30% y a partir de ahi el monitor deja de
// mirar esa posicion. Sin esto es imposible responder "¿convenia aguantar mas?"
// — la informacion simplemente no se guarda en ningun lado.
//
// Decision del usuario: mejorar la ENTRADA ahora y dejar el TP como esta,
// acumulando en paralelo la evidencia para decidir el cambio de salida mas
// adelante con datos propios en vez de con simulaciones.
//
// Corre DESPUES del cierre, no en el loop de 30s: necesita ver el dia completo,
// incluido lo que paso despues de que el trade real cerro. Solo lee velas y
// escribe un informe en el registro; no coloca ordenes ni cambia decisiones.
//
// Limitacion conocida: el valor del spread se reconstruye con Black-Scholes
// (IV fija 17.5%, mismo modelo del backtester). Sirve para COMPARAR reglas
// entre si sobre el mismo trade — no para afirmar el P&L absoluto de cada una.
// Los puntos de SPX (MFE/MAE) si son exactos: salen de las velas reales.

const erf = x => {
  const a = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - a * (0.254829592 + a * (-0.284496736 + a * (1.421413741 + a * (-1.453152027 + a * 1.061405429)))) * Math.exp(-x * x);
  return x >= 0 ? y : -y;
};
const N = x => 0.5 * (1 + erf(x / Math.SQRT2));
function bs(S, K, T, opt, iv = 0.175, r = 0.045) {
  if (T <= 0) return opt === 'call' ? Math.max(S - K, 0) : Math.max(K - S, 0);
  const d1 = (Math.log(S / K) + (r + .5 * iv * iv) * T) / (iv * Math.sqrt(T)), d2 = d1 - iv * Math.sqrt(T);
  return opt === 'call' ? S * N(d1) - K * Math.exp(-r * T) * N(d2) : K * Math.exp(-r * T) * N(-d2) - S * N(-d1);
}

const minutosET = iso => {
  const h = new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
  return +h.slice(0, 2) * 60 + +h.slice(3, 5);
};
const CIERRE_MERCADO = 16 * 60 + 15;   // expiracion 0DTE del SPXW
const ULTIMA_SALIDA  = 15 * 60 + 45;   // el sistema no aguanta despues de esto

// ex: registro de tradier_executions.json (TENDENCIA, ya cerrado)
// bars2m: velas {timestamp, open, high, low, close} del dia, cronologicas
// atrPorBarra: array de ATR alineado a bars2m (opcional; para el trailing)
function evaluarSalidasAlternativas(ex, bars2m, atrPorBarra = null) {
  if (!ex.filledAt || !ex.strikes || typeof ex.entryFillPrice !== 'number') return null;
  const esAlcista = ex.direction === 'BULLISH';
  const opt = esAlcista ? 'call' : 'put';
  const contratos = ex.contracts || 1;
  const deb = Math.abs(ex.entryFillPrice);
  if (!(deb > 0)) return null;

  // En una vertical de debito la pata comprada esta mas cerca del dinero.
  const s = ex.strikes;
  const kL = esAlcista ? Math.min(s.longStrike, s.shortStrike) : Math.max(s.longStrike, s.shortStrike);
  const kS = esAlcista ? Math.max(s.longStrike, s.shortStrike) : Math.min(s.longStrike, s.shortStrike);

  const tEntrada = minutosET(ex.filledAt);
  const idx = bars2m.findIndex(b => minutosET(new Date(b.timestamp * 1000).toISOString()) >= tEntrada);
  if (idx < 0) return null;
  const spxEntrada = ex.entrySpx != null ? ex.entrySpx : bars2m[idx].close;

  const camino = [];
  for (let i = idx; i < bars2m.length; i++) {
    const b = bars2m[i];
    const min = minutosET(new Date(b.timestamp * 1000).toISOString());
    if (min > ULTIMA_SALIDA) break;
    const T = Math.max(1e-6, (CIERRE_MERCADO - min) / (365 * 24 * 60));
    const valor = bs(b.close, kL, T, opt) - bs(b.close, kS, T, opt);
    camino.push({
      min, spx: b.close,
      favPts: +(esAlcista ? b.high - spxEntrada : spxEntrada - b.low).toFixed(2),
      advPts: +(esAlcista ? spxEntrada - b.low : b.high - spxEntrada).toFixed(2),
      gan: +((valor - deb) / deb).toFixed(4),
      pnl: +((valor - deb) * 100 * contratos).toFixed(2),
      atr: atrPorBarra ? atrPorBarra[i] : null,
    });
  }
  if (camino.length < 2) return null;

  const alcanza = umbral => {
    const p = camino.find(c => c.gan >= umbral);
    return p ? { pnl: p.pnl, minutos: p.min - tEntrada, gan: p.gan } : null;
  };
  const salidaTrailing = (colchonATR = 2.5, activaPts = 10) => {
    let pico = -Infinity;
    for (const c of camino) {
      if (c.favPts > pico) pico = c.favPts;
      const atr = c.atr || (ex.entryAtr2m || 0);
      if (!atr) continue;
      if (pico >= activaPts && c.favPts <= pico - colchonATR * atr) {
        return { pnl: c.pnl, minutos: c.min - tEntrada, picoPts: pico };
      }
    }
    return null;
  };
  const salidaMuro = () => {
    const muro = esAlcista ? ex.entryCallWall : ex.entryPutWall;
    if (muro == null) return null;
    const c = camino.find(x => esAlcista ? x.spx >= muro : x.spx <= muro);
    return c ? { pnl: c.pnl, minutos: c.min - tEntrada, muro } : { pnl: null, minutos: null, muro, alcanzado: false };
  };

  const pico = camino.reduce((a, c) => c.gan > a.gan ? c : a, camino[0]);
  const valle = camino.reduce((a, c) => c.gan < a.gan ? c : a, camino[0]);
  const ultimo = camino[camino.length - 1];

  return {
    calculadoEl: new Date().toISOString(),
    modelo: 'black-scholes IV 17.5% — sirve para comparar reglas entre si, no como P&L absoluto',
    spxEntrada, debito: +(deb * 100 * contratos).toFixed(2),
    // Excursiones en PUNTOS de SPX: estas si son exactas, salen de las velas.
    mfePts: +Math.max(...camino.map(c => c.favPts)).toFixed(2),
    maePts: +Math.max(...camino.map(c => c.advPts)).toFixed(2),
    minutosHastaMFE: (camino.find(c => c.favPts === Math.max(...camino.map(x => x.favPts))) || {}).min - tEntrada,
    picoGanPct: pico.gan, minutosHastaPico: pico.min - tEntrada,
    peorGanPct: valle.gan,
    alternativas: {
      tp30:  alcanza(0.30),
      tp50:  alcanza(0.50),
      tp80:  alcanza(0.80),
      tp100: alcanza(1.00),
      tp150: alcanza(1.50),
      trailing25ATR: salidaTrailing(2.5, 10),
      muro: salidaMuro(),
      aguantarAlCierre: { pnl: ultimo.pnl, minutos: ultimo.min - tEntrada },
    },
    real: { pnl: typeof ex.pnl === 'number' ? ex.pnl : null, motivo: ex.closeReason || null,
            minutos: ex.closedAt ? minutosET(ex.closedAt) - tEntrada : null },
  };
}

module.exports = { evaluarSalidasAlternativas };
