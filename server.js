'use strict';
require('dotenv').config();
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { TastytradeClient }                              = require('./src/tastytrade');
const { buildMetrics, buildEquityCurve, buildCalendar } = require('./src/metrics');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── NLV History ────────────────────────────────────────────────
// Snapshots históricos obtenidos de TastyTrade (fin de mes)
const NLV_FILE = path.join(__dirname, 'nlv_history.json');
const NLV_SEED = {
  '2026-02-13': 10644.00,   // depósito inicial
  '2026-02-28': 11328.69,
  '2026-03-30': 9730.48,
  '2026-04-30': 9208.64,
};

function loadNlvHistory() {
  try {
    if (fs.existsSync(NLV_FILE)) {
      return { ...NLV_SEED, ...JSON.parse(fs.readFileSync(NLV_FILE, 'utf8')) };
    }
  } catch(e) { /* ignorar */ }
  return { ...NLV_SEED };
}

function saveNlvSnapshot(dateStr, nlv) {
  const history = loadNlvHistory();
  history[dateStr] = nlv;
  fs.writeFileSync(NLV_FILE, JSON.stringify(history, null, 2), 'utf8');
}

function computeWeeklyNlv(nlvHistory, currentNlv) {
  const entries = Object.entries(nlvHistory).sort((a,b) => a[0].localeCompare(b[0]));
  const today = new Date().toISOString().slice(0,10);
  const allEntries = [...entries, [today, currentNlv]];

  const byWeek = {};
  for (let i = 1; i < allEntries.length; i++) {
    const [prevDate, prevNlv] = allEntries[i-1];
    const [curDate,  curNlv]  = allEntries[i];
    const prevWk = weekKey(prevDate);
    const curWk  = weekKey(curDate);
    if (prevWk !== curWk) {
      // Cruce de semana — asignar el cambio completo a la semana actual
      if (!byWeek[curWk]) byWeek[curWk] = 0;
      byWeek[curWk] += curNlv - prevNlv;
    } else {
      // Misma semana
      if (!byWeek[curWk]) byWeek[curWk] = 0;
      byWeek[curWk] += curNlv - prevNlv;
    }
  }
  // Redondear
  Object.keys(byWeek).forEach(k => { byWeek[k] = +byWeek[k].toFixed(2); });
  return byWeek;
}

function computeMonthlyNlv(nlvHistory, currentNlv) {
  const entries = Object.entries(nlvHistory).sort((a,b) => a[0].localeCompare(b[0]));
  // Agregar snapshot de hoy
  const today = new Date().toISOString().slice(0,10);
  const allEntries = [...entries, [today, currentNlv]];

  const byMonth = {};
  for (let i = 1; i < allEntries.length; i++) {
    const [prevDate, prevNlv] = allEntries[i-1];
    const [curDate,  curNlv]  = allEntries[i];
    const mo = curDate.slice(0, 7);
    // Si están en meses distintos, calcular el cambio
    if (prevDate.slice(0,7) !== mo) {
      // El inicio de este mes = valor al final del mes anterior
      byMonth[mo] = (byMonth[mo] || 0) + curNlv - prevNlv;
    } else {
      byMonth[mo] = (byMonth[mo] || 0) + curNlv - prevNlv;
    }
  }
  // Simplificar: mes = último valor del mes - primer valor del mes
  const monthlyMap = {};
  const prevNlvByMonth = {};
  for (let i = 0; i < allEntries.length; i++) {
    const [date, nlv] = allEntries[i];
    const mo = date.slice(0, 7);
    if (!prevNlvByMonth[mo]) {
      // Primer dato de este mes: start = último valor del mes anterior
      const prevMoEntries = allEntries.filter(([d]) => d.slice(0,7) < mo);
      const prevVal = prevMoEntries.length ? prevMoEntries[prevMoEntries.length-1][1] : nlv;
      prevNlvByMonth[mo] = prevVal;
    }
    monthlyMap[mo] = +(nlv - prevNlvByMonth[mo]).toFixed(2);
  }
  return monthlyMap;
}

// ── Cliente TastyTrade ─────────────────────────────────────────
const tt = new TastytradeClient({
  clientSecret:  process.env.TT_CLIENT_SECRET,
  refreshToken:  process.env.TT_REFRESH_TOKEN,
  // legacy fallback por si acaso
  sessionToken:  process.env.TT_SESSION_TOKEN,
  accountNumber: process.env.TT_ACCOUNT_NUMBER,
});
tt.startAutoRefresh();

const _cache = new Map();
function cached(k, s, fn) {
  const h = _cache.get(k);
  if (h && Date.now() < h.exp) return Promise.resolve(h.v);
  return fn().then(v => { _cache.set(k, { v, exp: Date.now() + s * 1000 }); return v; });
}
function bustCache() { _cache.clear(); }

const todayStr = () => new Date().toISOString().slice(0, 10);
const daysAgo  = n  => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Balance + posiciones + Greeks
app.get('/api/overview', async (req, res) => {
  try {
    const data = await cached('overview', 60, async () => {
      const [balances, positions] = await Promise.all([tt.getBalances(), tt.getPositions()]);
      // Obtener Greeks + mark en tiempo real para posiciones de opciones
      const optionSymbols = positions
        .filter(p => p['instrument-type'] === 'Equity Option')
        .map(p => p.symbol);
      const greeks = await tt.getGreeks(optionSymbols);

      // Obtener mark-price en tiempo real via /market-data
      const markMap = {};
      try {
        const BATCH = 50;
        for (let i = 0; i < optionSymbols.length; i += BATCH) {
          const batch = optionSymbols.slice(i, i + BATCH);
          const params = batch.map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
          const d = await tt._req(`/market-data?${params}`);
          for (const item of (d.data?.items || [])) {
            const mk = parseFloat(item.mark || item.mid || 0);
            if (mk > 0) markMap[item.symbol] = mk;
          }
        }
      } catch(e) { /* si falla, usará average-daily como fallback */ }

      // Adjuntar Greeks y mark-price a cada posición
      const posWithGreeks = positions.map(p => ({
        ...p,
        greeks: greeks[p.symbol] || null,
        'mark-price': markMap[p.symbol] || null,
      }));
      return { balances, positions: posWithGreeks, ts: new Date().toISOString() };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Curva de capital desde transacciones
// Solo incluye trades reales (excluye Money Movement = depósitos/retiros)
function weekKey(dateStr) {
  if (!dateStr) return '';
  const d    = new Date(dateStr + 'T12:00:00Z');
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - jan1) / 86400000) + jan1.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

app.get('/api/curve', async (req, res) => {
  try {
    const data = await cached('curve', 300, async () => {
      const allItems = await tt.getAllTransactions('2026-02-01', todayStr());

      // Excluir depósitos, retiros y movimientos de dinero
      // Curva mensual: Trade + Receive Deliver (incluye liquidaciones de asignaciones)
      const curveItems = allItems.filter(tx =>
        tx['transaction-type'] === 'Trade' ||
        tx['transaction-type'] === 'Receive Deliver' ||
        tx['transaction-type'] === 'Fee'
      );
      // Calendario diario: solo Trade (evita ruido de settlements en días sueltos)
      const calItems = allItems.filter(tx => tx['transaction-type'] === 'Trade');

      const byDay = {};
      curveItems.forEach(tx => {
        const d = (tx['transaction-date'] || '').slice(0, 10);
        if (!d) return;
        const val    = parseFloat(tx['net-value'] || tx['value'] || 0);
        const effect = tx['net-value-effect'] || tx['value-effect'] || 'Debit';
        byDay[d] = (byDay[d] || 0) + val * (effect === 'Credit' ? 1 : -1);
      });

      const calByDay = {};
      calItems.forEach(tx => {
        const d = (tx['transaction-date'] || '').slice(0, 10);
        if (!d) return;
        const v = parseFloat(tx['net-value'] || 0) * (tx['net-value-effect'] === 'Credit' ? 1 : -1);
        calByDay[d] = (calByDay[d] || 0) + v;
      });

      // NLV real (fuente de verdad) — obtener primero
      const currentNlv = await tt.getBalances().then(b => parseFloat(b?.['net-liquidating-value']||0)).catch(()=>0);
      const nlvHistory = loadNlvHistory();

      const initial = 10644;
      const labels  = Object.keys(byDay).sort();
      let running   = initial;
      const values  = labels.map(d => {
        running += byDay[d];
        return +running.toFixed(2);
      });
      if (values.length > 0 && currentNlv > 0) {
        values[values.length - 1] = +currentNlv.toFixed(2);
      }

      const calendar = {};
      Object.keys(calByDay).forEach(d => { calendar[d] = +calByDay[d].toFixed(2); });

      // Calcular drawdown sobre Net Liq real (snapshots), no sobre P&L acumulado
      let peak = initial, maxDD = 0, maxDDPct = 0;
      const nlvPoints = Object.entries(nlvHistory).sort((a,b)=>a[0].localeCompare(b[0])).map(([,v])=>v);
      if (currentNlv > 0) nlvPoints.push(currentNlv);
      const ddSource = nlvPoints.length >= 2 ? nlvPoints : values;
      ddSource.forEach(v => {
        if (v > peak) peak = v;
        const dd = peak - v;
        if (dd > maxDD) { maxDD = dd; maxDDPct = dd / peak * 100; }
      });

      // byMonth y byWeek desde datos completos (Trade + Receive Deliver)
      const byMonth = {};
      const byWeek  = {};
      Object.keys(byDay).forEach(d => {
        const mo = d.slice(0, 7);
        byMonth[mo] = (byMonth[mo] || 0) + byDay[d];
        const wk = weekKey(d);
        byWeek[wk]  = (byWeek[wk]  || 0) + byDay[d];
      });

      // NLV-based monthly P&L (fuente de verdad = Net Liq real)
      const nlvByMonth = computeMonthlyNlv(nlvHistory, currentNlv);

      const nlvByWeek = computeWeeklyNlv(nlvHistory, currentNlv);

      return {
        curve: { labels, values, initial, maxDD: +maxDD.toFixed(2), maxDDPct: +maxDDPct.toFixed(2) },
        calendar, byMonth, byWeek,
        nlvByMonth, nlvByWeek,
        nlvSnapshots: Object.entries(nlvHistory).sort((a,b)=>a[0].localeCompare(b[0])).concat([[todayStr(), currentNlv]]),
        ts: new Date().toISOString()
      };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Transacciones + métricas (solo Trade para métricas)
app.get('/api/transactions', async (req, res) => {
  try {
    const sd = req.query.startDate || '2026-02-01';
    const ed = req.query.endDate   || todayStr();
    const ck = `txns_${sd}_${ed}`;
    const data = await cached(ck, 120, async () => {
      const allItems = await tt.getAllTransactions(sd, ed);
      // Pasar Trade + Receive Deliver al metrics (cash settlements, assignments, exercises)
      const tradeItems = allItems.filter(tx =>
        tx['transaction-type'] === 'Trade' ||
        tx['transaction-type'] === 'Receive Deliver'
      );
      const metrics = buildMetrics(tradeItems);
      return { items: allItems, metrics, ts: new Date().toISOString() };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Operaciones de hoy
app.get('/api/today', async (req, res) => {
  try {
    const data = await cached('today', 30, async () => {
      const d = todayStr();
      return { items: await tt.getAllTransactions(d, d), ts: new Date().toISOString() };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/refresh', (req, res) => { bustCache(); res.json({ ok: true }); });

// La Rueda — configuración de activos
const WHEEL_CFG = path.join(__dirname, 'wheel_config.json');

function loadWheelConfig() {
  try {
    if (fs.existsSync(WHEEL_CFG)) return JSON.parse(fs.readFileSync(WHEEL_CFG,'utf8'));
  } catch(e) {}
  return { underlyings: ['JBLU','NU'] };
}
function saveWheelConfig(cfg) {
  fs.writeFileSync(WHEEL_CFG, JSON.stringify(cfg, null, 2), 'utf8');
}

app.get('/api/wheel-config', (req, res) => res.json(loadWheelConfig()));

app.post('/api/wheel-config', (req, res) => {
  const { action, underlying, startDate } = req.body;
  const cfg = loadWheelConfig();
  const sym = (underlying||'').toUpperCase().trim();
  if (!sym) return res.status(400).json({ error: 'Ticker requerido' });
  if (action === 'add') {
    const exists = cfg.underlyings.find(u => (typeof u === 'string' ? u : u.symbol) === sym);
    if (!exists) cfg.underlyings.push(startDate ? { symbol: sym, startDate } : sym);
    else if (startDate && typeof exists === 'string') {
      const idx = cfg.underlyings.indexOf(exists);
      cfg.underlyings[idx] = { symbol: sym, startDate };
    }
  }
  if (action === 'remove') cfg.underlyings = cfg.underlyings.filter(u => (typeof u === 'string' ? u : u.symbol) !== sym);
  if (action === 'setStartDate') {
    const idx = cfg.underlyings.findIndex(u => (typeof u === 'string' ? u : u.symbol) === sym);
    if (idx >= 0) cfg.underlyings[idx] = { symbol: sym, startDate: startDate || null };
  }
  saveWheelConfig(cfg);
  bustCache();
  res.json(cfg);
});

// La Rueda — datos
app.get('/api/wheel', async (req, res) => {
  try {
    const data = await cached('wheel', 120, async () => {
      const { buildWheelData } = require('./src/wheel');
      const cfg = loadWheelConfig();
      const [items, positions] = await Promise.all([
        tt.getAllTransactions('2026-02-01', todayStr()),
        tt.getPositions(),
      ]);
      const underlyingSymbols = cfg.underlyings.map(u => typeof u === 'string' ? u : u.symbol);
      return { wheels: buildWheelData(items, positions, cfg.underlyings), underlyings: underlyingSymbols, ts: new Date().toISOString() };
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// NLV History — snapshots diarios
app.get('/api/nlv-history', (req, res) => {
  try {
    const history = loadNlvHistory();
    res.json({ history });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug-src', (req, res) => {
  try {
    const src = fs.readFileSync(path.join(__dirname, 'src/metrics.js'), 'utf8');
    res.type('text/plain').send(src);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', (req, res) => res.json({
  ok: true, auth: !!tt.accessToken,
  tokenLen: (tt.accessToken || '').length,
  account: tt.accountNumber,
  ts: new Date().toISOString()
}));

// ── Reporte PDF ───────────────────────────────────────────────
app.get('/report', async (req, res) => {
  try {
    const [bal, positions, txData] = await Promise.all([
      tt.getBalances(),
      tt.getPositions(),
      tt.getAllTransactions('2026-02-01', todayStr()),
    ]);
    const { buildMetrics } = require('./src/metrics');
    const m        = buildMetrics(txData);
    const nlv      = parseFloat(bal?.['net-liquidating-value'] || 0);
    const initial  = 10644;
    const totalRet = ((nlv - initial) / initial * 100).toFixed(2);
    const nlvHist  = loadNlvHistory();
    const nlvByMonth = computeMonthlyNlv(nlvHist, nlv);
    const today    = todayStr();

    // Consolidar estrategias
    // Para spreads multi-pata, agrupamos de a 2 legs consecutivas con el mismo baseKey.
    // Esto permite separar múltiples trades del mismo subyacente/día/estrategia.
    const allLegs  = m.strategies || [];
    const spreadMap = new Map();
    const spreadCounters = {};

    for (let i = 0; i < allLegs.length; i++) {
      const leg = allLegs[i];
      const isSpread = /Spread|Condor|Strangle/i.test(leg.stratType||'');

      let key;
      if (!isSpread) {
        key = leg.key || `single_${i}`;
      } else if (leg.openOrderId) {
        key = `${leg.underlying}_${leg.openDate}_${leg.closeDate}_${leg.stratType}_${leg.openOrderId}`;
      } else {
        const baseKey = `${leg.underlying}_${leg.openDate}_${leg.closeDate}_${leg.stratType}`;
        if (!(baseKey in spreadCounters)) spreadCounters[baseKey] = { idx: 0, legs: 0 };
        const sc = spreadCounters[baseKey];
        if (sc.legs > 0 && sc.legs % 2 === 0) sc.idx++;
        key = `${baseKey}_${sc.idx}`;
        sc.legs++;
      }

      if (!spreadMap.has(key)) spreadMap.set(key, { ...leg, pnl: 0, openValue: 0, closeValue: 0 });
      const s = spreadMap.get(key);
      s.pnl        += leg.pnl        || 0;
      s.openValue  += leg.openValue  || 0;
      s.closeValue += leg.closeValue || 0;
    }
    const trades = [...spreadMap.values()].sort((a,b) => new Date(b.closeDate)-new Date(a.closeDate));
    const recentTrades = trades.slice(0, 10);

    // Stats por estrategia
    const byStrat = {};
    trades.forEach(t => {
      const k = t.stratType || 'Otro';
      if (!byStrat[k]) byStrat[k] = { trades:0, wins:0, pnl:0 };
      byStrat[k].trades++;
      if (t.pnl > 0) byStrat[k].wins++;
      byStrat[k].pnl += t.pnl;
    });

    // Posiciones consolidadas
    const posMap = new Map();
    positions.filter(p => p['instrument-type'] !== 'Unknown').forEach(p => {
      const und = p['underlying-symbol'];
      if (!posMap.has(und)) posMap.set(und, { underlying:und, legs:[], pnlNoReal:0 });
      const op  = parseFloat(p['average-open-price']||0);
      const cp  = parseFloat(p['mark-price'] || p['average-daily-market-close-price'] || p['close-price']||0);
      const qty = parseFloat(p.quantity||0);
      const mul = parseFloat(p.multiplier||1);
      const dir = p['quantity-direction']==='Short' ? -1 : 1;
      const pnl = dir*(cp-op)*qty*mul;
      posMap.get(und).pnlNoReal += pnl;
      posMap.get(und).legs.push(p);
    });
    const openPositions = [...posMap.values()];
    const totalPnlNoReal = openPositions.reduce((a,b)=>a+b.pnlNoReal,0);

    const fa$ = n => '$' + Math.abs(parseFloat(n)||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    const f$  = n => { const v=parseFloat(n)||0; return (v>=0?'+':'')+v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); };
    const cc  = n => parseFloat(n)>=0?'pos':'neg';

    const monthRows = Object.entries(nlvByMonth).sort().map(([mo,pnl]) => {
      const label = new Date(+mo.slice(0,4), +mo.slice(5,7)-1).toLocaleDateString('es-CO',{month:'long',year:'numeric'});
      return `<tr>
        <td>${label.charAt(0).toUpperCase()+label.slice(1)}</td>
        <td class="${cc(pnl)}">${f$(pnl)}</td>
        <td class="${cc(pnl)}">${initial?(pnl/initial*100).toFixed(2)+'%':'—'}</td>
      </tr>`;
    }).join('');

    const stratRows = Object.entries(byStrat)
      .sort((a,b)=>b[1].pnl-a[1].pnl)
      .map(([k,v]) => `<tr>
        <td>${k}</td>
        <td>${v.trades}</td>
        <td>${v.trades?Math.round(v.wins/v.trades*100):0}%</td>
        <td class="${cc(v.pnl)}">${f$(v.pnl)}</td>
      </tr>`).join('');

    const tradeRows = recentTrades.map(t => `<tr>
      <td>${t.closeDate}</td>
      <td><strong>${t.underlying}</strong></td>
      <td>${t.stratType||'—'}</td>
      <td>${t.durationDays===0?'Intradía':t.durationDays+'d'}</td>
      <td class="pos">${t.openValue?'+'+fa$(Math.abs(t.openValue)):'—'}</td>
      <td class="${cc(t.pnl)}"><strong>${f$(t.pnl)}</strong></td>
    </tr>`).join('');

    const posRows = openPositions.map(p => {
      const mainLeg = p.legs[0];
      return `<tr>
        <td><strong>${p.underlying}</strong></td>
        <td>${p.legs.length > 1 ? 'Spread/Multi' : mainLeg['instrument-type']==='Equity'?'Acciones':'Opción'}</td>
        <td>${p.legs.length}</td>
        <td class="${cc(p.pnlNoReal)}">${f$(p.pnlNoReal)}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Bitácora Tasty — Informe ${today}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color:#1a1a2e; background:#fff; font-size:13px; }

  /* PORTADA */
  .cover { height:100vh; display:flex; flex-direction:column; justify-content:center; align-items:center;
    background:linear-gradient(135deg,#0d1117 0%,#161b27 50%,#0d1117 100%); color:#fff; text-align:center; page-break-after:always; }
  .cover-logo { font-size:48px; margin-bottom:20px; }
  .cover-title { font-size:36px; font-weight:700; letter-spacing:2px; color:#13d68f; margin-bottom:8px; }
  .cover-sub { font-size:18px; color:#8892a4; margin-bottom:40px; }
  .cover-trader { font-size:22px; font-weight:600; color:#f5c842; margin-bottom:8px; }
  .cover-date { font-size:14px; color:#4e5a70; }
  .cover-divider { width:80px; height:3px; background:linear-gradient(90deg,#13d68f,#5b82e6); margin:24px auto; border-radius:2px; }

  /* CONTENIDO */
  .page { padding:40px 48px; page-break-after:always; }
  .page:last-child { page-break-after:auto; }

  h1 { font-size:22px; color:#0d1117; border-bottom:2px solid #13d68f; padding-bottom:8px; margin-bottom:24px; }
  h2 { font-size:16px; color:#161b27; margin:24px 0 12px; font-weight:600; }

  /* KPI CARDS */
  .kpi-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin-bottom:32px; }
  .kpi-card { background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:18px; text-align:center; }
  .kpi-label { font-size:10px; color:#64748b; text-transform:uppercase; letter-spacing:.08em; margin-bottom:6px; }
  .kpi-value { font-size:24px; font-weight:700; color:#0d1117; }
  .kpi-sub { font-size:11px; color:#94a3b8; margin-top:4px; }
  .kpi-card.green .kpi-value { color:#059669; }
  .kpi-card.red .kpi-value { color:#dc2626; }
  .kpi-card.blue .kpi-value { color:#2563eb; }
  .kpi-card.gold .kpi-value { color:#d97706; }

  /* TABLAS */
  table { width:100%; border-collapse:collapse; margin-bottom:24px; font-size:12px; }
  th { background:#0d1117; color:#fff; padding:10px 12px; text-align:left; font-size:11px; font-weight:600; letter-spacing:.05em; }
  td { padding:9px 12px; border-bottom:1px solid #f1f5f9; }
  tr:hover td { background:#f8fafc; }
  .pos { color:#059669; font-weight:600; }
  .neg { color:#dc2626; font-weight:600; }

  /* FIRMA */
  .footer { margin-top:40px; padding-top:16px; border-top:1px solid #e2e8f0; display:flex; justify-content:space-between;
    font-size:10px; color:#94a3b8; }

  @media print {
    .cover { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    .kpi-card { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    th { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  }
</style>
</head>
<body>

<!-- PORTADA -->
<div class="cover">
  <div class="cover-logo">📊</div>
  <div class="cover-title">BITÁCORA TASTY</div>
  <div class="cover-sub">Informe de Trading — Opciones sobre Acciones</div>
  <div class="cover-divider"></div>
  <div class="cover-trader">Guillermo Carvajal</div>
  <div class="cover-date">Generado: ${today} · Período: Feb 2026 — ${today}</div>
</div>

<!-- PAG 1: RESUMEN EJECUTIVO -->
<div class="page">
  <h1>📈 Resumen Ejecutivo</h1>
  <div class="kpi-grid">
    <div class="kpi-card ${nlv>=initial?'green':'red'}">
      <div class="kpi-label">Net Liquidating Value</div>
      <div class="kpi-value">${fa$(nlv)}</div>
      <div class="kpi-sub">Capital actual</div>
    </div>
    <div class="kpi-card ${parseFloat(totalRet)>=0?'green':'red'}">
      <div class="kpi-label">Retorno Total</div>
      <div class="kpi-value">${totalRet}%</div>
      <div class="kpi-sub">vs capital inicial ${fa$(initial)}</div>
    </div>
    <div class="kpi-card ${m.totalPnL>=0?'green':'red'}">
      <div class="kpi-label">P&L Realizado</div>
      <div class="kpi-value">${f$(m.totalPnL)}</div>
      <div class="kpi-sub">Trades cerrados</div>
    </div>
    <div class="kpi-card blue">
      <div class="kpi-label">Win Rate</div>
      <div class="kpi-value">${m.winRate}%</div>
      <div class="kpi-sub">${m.totalStrategies} trades totales</div>
    </div>
    <div class="kpi-card gold">
      <div class="kpi-label">Profit Factor</div>
      <div class="kpi-value">${m.profitFactor}x</div>
      <div class="kpi-sub">Ganancia/Pérdida ratio</div>
    </div>
    <div class="kpi-card red">
      <div class="kpi-label">Comisiones Pagadas</div>
      <div class="kpi-value">-${fa$(m.totalComm)}</div>
      <div class="kpi-sub">Al broker</div>
    </div>
  </div>

  <h2>Resultados Mensuales (Net Liq Real)</h2>
  <table>
    <thead><tr><th>Mes</th><th>P&L</th><th>% Retorno</th></tr></thead>
    <tbody>${monthRows}</tbody>
  </table>

  <div class="footer">
    <span>Bitácora Tasty — Guillermo Carvajal</span>
    <span>Generado ${today}</span>
  </div>
</div>

<!-- PAG 2: ESTRATEGIAS -->
<div class="page">
  <h1>🎯 Análisis por Estrategia</h1>
  <table>
    <thead><tr><th>Estrategia</th><th>Trades</th><th>Win Rate</th><th>P&L</th></tr></thead>
    <tbody>${stratRows}</tbody>
  </table>

  <h2>Últimos 10 Trades Cerrados</h2>
  <table>
    <thead><tr><th>Cierre</th><th>Símbolo</th><th>Estrategia</th><th>Duración</th><th>Prima</th><th>P&L</th></tr></thead>
    <tbody>${tradeRows}</tbody>
  </table>

  <div class="footer">
    <span>Bitácora Tasty — Guillermo Carvajal</span>
    <span>Generado ${today}</span>
  </div>
</div>

<!-- PAG 3: POSICIONES ABIERTAS -->
<div class="page">
  <h1>📋 Posiciones Abiertas</h1>
  <div class="kpi-grid" style="grid-template-columns:repeat(2,1fr);margin-bottom:24px;">
    <div class="kpi-card ${totalPnlNoReal>=0?'green':'red'}">
      <div class="kpi-label">P&L No Realizado Total</div>
      <div class="kpi-value">${f$(totalPnlNoReal)}</div>
      <div class="kpi-sub">${openPositions.length} subyacentes</div>
    </div>
    <div class="kpi-card blue">
      <div class="kpi-label">Posiciones Abiertas</div>
      <div class="kpi-value">${positions.length}</div>
      <div class="kpi-sub">patas individuales</div>
    </div>
  </div>
  <table>
    <thead><tr><th>Subyacente</th><th>Tipo</th><th>Patas</th><th>P&L No Real</th></tr></thead>
    <tbody>${posRows}</tbody>
  </table>

  <div class="footer">
    <span>Bitácora Tasty — Guillermo Carvajal</span>
    <span>Confidencial · Generado ${today}</span>
  </div>
</div>

</body>
</html>`;

    res.send(html);
  } catch(e) {
    res.status(500).send(`<pre>Error generando reporte: ${e.message}</pre>`);
  }
});
// ── Trade Journal ─────────────────────────────────────────────
const TN_FILE = path.join(__dirname, 'trade_notes.json');
const WL_FILE = path.join(__dirname, 'watchlist.json');
function loadNotes()  { try { return JSON.parse(fs.readFileSync(TN_FILE,'utf8')); } catch(e) { return {}; } }
function saveNotes(d) { fs.writeFileSync(TN_FILE, JSON.stringify(d,null,2),'utf8'); }

app.get('/api/trade-notes', (req, res) => res.json(loadNotes()));

app.post('/api/trade-notes/:key', (req, res) => {
  const notes = loadNotes();
  const key   = decodeURIComponent(req.params.key);
  notes[key]  = { ...(notes[key]||{}), ...req.body, updatedAt: new Date().toISOString() };
  saveNotes(notes);
  res.json(notes[key]);
});

app.delete('/api/trade-notes/:key', (req, res) => {
  const notes = loadNotes();
  delete notes[decodeURIComponent(req.params.key)];
  saveNotes(notes);
  res.json({ ok:true });
});

// ── TradingView Screenshot via CDP ────────────────────────────
app.post('/api/tv-screenshot', async (req, res) => {
  try {
    const CDP_PORT = 9223;
    const listResp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const targets  = await listResp.json();
    const tv = targets.find(t => t.type==='page' && t.url.includes('tradingview.com/chart'));
    if (!tv) return res.status(404).json({ error:'TradingView no está abierto en Edge (puerto 9223). Ábrelo con el bot.' });

    const WebSocket = require('ws');
    const screenshot = await new Promise((resolve, reject) => {
      const ws = new WebSocket(tv.webSocketDebuggerUrl);
      let done = false;
      ws.on('open', () => {
        ws.send(JSON.stringify({ id:1, method:'Page.enable' }));
        ws.send(JSON.stringify({ id:2, method:'Page.captureScreenshot',
          params:{ format:'jpeg', quality:80 } }));
      });
      ws.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        if (msg.id===2 && msg.result?.data && !done) {
          done = true; ws.close(); resolve(msg.result.data);
        }
      });
      ws.on('error', reject);
      setTimeout(() => { if(!done){ ws.close(); reject(new Error('Timeout')); } }, 10000);
    });

    res.json({ screenshot:`data:image/jpeg;base64,${screenshot}`, symbol:tv.title });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Watchlist ─────────────────────────────────────────────────
function loadWatchlist() {
  try { return JSON.parse(fs.readFileSync(WL_FILE,'utf8')); }
  catch(e) { return { stocks:[] }; }
}
function saveWatchlist(d) { fs.writeFileSync(WL_FILE, JSON.stringify(d,null,2),'utf8'); }

app.get('/api/watchlist', (req, res) => res.json(loadWatchlist()));

app.post('/api/watchlist', (req, res) => {
  try {
    const wl = loadWatchlist();
    const { symbol, name, status, screener } = req.body;
    if (!symbol) return res.status(400).json({ error:'Symbol requerido' });
    const sym = symbol.toUpperCase();
    if (wl.stocks.find(s => s.symbol === sym)) return res.status(409).json({ error:'Ya existe' });
    const stock = { symbol:sym, name:name||sym, status:status||'orange', screener:screener||'', addedDate:todayStr(), notes:[] };
    wl.stocks.push(stock);
    saveWatchlist(wl);
    res.json(stock);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.put('/api/watchlist/:symbol', (req, res) => {
  const wl = loadWatchlist();
  const s  = wl.stocks.find(s => s.symbol === req.params.symbol.toUpperCase());
  if (!s) return res.status(404).json({ error:'No encontrado' });
  if (req.body.status) s.status = req.body.status;
  if (req.body.name)   s.name   = req.body.name;
  saveWatchlist(wl);
  res.json(s);
});

app.delete('/api/watchlist/:symbol', (req, res) => {
  const wl = loadWatchlist();
  wl.stocks = wl.stocks.filter(s => s.symbol !== req.params.symbol.toUpperCase());
  saveWatchlist(wl);
  res.json({ ok:true });
});

app.post('/api/watchlist/:symbol/note', (req, res) => {
  const wl  = loadWatchlist();
  const s   = wl.stocks.find(s => s.symbol === req.params.symbol.toUpperCase());
  if (!s) return res.status(404).json({ error:'No encontrado' });
  const note = {
    id:     `n${Date.now()}`,
    date:   todayStr(),
    status: req.body.status || s.status,
    text:   req.body.text   || '',
    image:  req.body.image  || null,
  };
  s.notes.unshift(note);
  if (req.body.status) s.status = req.body.status;
  saveWatchlist(wl);
  res.json(note);
});

app.delete('/api/watchlist/:symbol/note/:noteId', (req, res) => {
  const wl = loadWatchlist();
  const s  = wl.stocks.find(s => s.symbol === req.params.symbol.toUpperCase());
  if (!s) return res.status(404).json({ error:'No encontrado' });
  s.notes  = s.notes.filter(n => n.id !== req.params.noteId);
  saveWatchlist(wl);
  res.json({ ok:true });
});

app.get('/api/watchlist/:symbol/fundamentals', async (req, res) => {
  try {
    const sym   = req.params.symbol.toUpperCase();
    const yhSym = sym === 'SPX' ? '%5EGSPC' : encodeURIComponent(sym);

    // Precio + datos básicos de Yahoo Finance
    const [prR, earR, vixR] = await Promise.all([
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yhSym}?interval=1d&range=45d`, { headers:{'User-Agent':'Mozilla/5.0'} }),
      fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yhSym}?modules=summaryDetail,defaultKeyStatistics,calendarEvents,assetProfile`, { headers:{'User-Agent':'Mozilla/5.0'} }),
      fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1y', { headers:{'User-Agent':'Mozilla/5.0'} }),
    ]);

    const prJ  = await prR.json();
    const earJ = await earR.json();
    const vixJ = await vixR.json();

    // Precio e histórico
    const closes = prJ.chart.result[0].indicators.quote[0].close.filter(v=>v!=null);
    const price  = Math.round(closes.at(-1) * 100) / 100;
    const prev   = closes.at(-2) || price;
    const chg    = Math.round((price - prev) * 100) / 100;
    const chgPct = Math.round((chg/prev)*10000)/100;
    const rsi    = calcRSI(closes);
    const hi52   = Math.round(Math.max(...closes) * 100) / 100;
    const lo52   = Math.round(Math.min(...closes) * 100) / 100;

    // Fundamentales
    const sd  = earJ.quoteSummary?.result?.[0]?.summaryDetail || {};
    const ap  = earJ.quoteSummary?.result?.[0]?.assetProfile || {};
    const ks  = earJ.quoteSummary?.result?.[0]?.defaultKeyStatistics || {};
    const cal = earJ.quoteSummary?.result?.[0]?.calendarEvents || {};
    const pe       = sd.trailingPE?.raw  || sd.forwardPE?.raw  || null;
    const mktCap   = sd.marketCap?.raw   || null;
    const divYield = sd.dividendYield?.raw || null;
    const beta     = sd.beta?.raw || null;
    const shortFloat = ks.shortPercentOfFloat?.raw || null;

    // Earnings
    let earningsDays = 999;
    const eTs = cal.earnings?.earningsDate?.[0]?.raw;
    if (eTs) earningsDays = Math.round((eTs*1000 - Date.now()) / 86400000);

    // IV Rank via VIX
    const vixPrices = vixJ.chart.result[0].indicators.quote[0].close.filter(v=>v!=null);
    const vix    = Math.round(vixPrices.at(-1) * 100) / 100;
    const ivRank = Math.round((vix - Math.min(...vixPrices)) / (Math.max(...vixPrices) - Math.min(...vixPrices)) * 100);

    // Opción Sigma FMP (fundamentales adicionales)
    let fmp = {};
    try {
      const fmpR = await fetch(
        `https://jrcdslfwrasitrvjboho.supabase.co/functions/v1/proxy/fmp/quote?symbol=${sym}`,
        { headers:{'origin':'https://www.opcionsigma.com','referer':'https://www.opcionsigma.com/'} }
      );
      const fmpJ = await fmpR.json();
      if (Array.isArray(fmpJ) && fmpJ[0]) fmp = fmpJ[0];
    } catch(e) {}

    res.json({
      symbol: sym, price, chg, chgPct, rsi, vix, ivRank,
      sector: ap.sector||null, industry: ap.industry||null,
      hi52, lo52, earningsDays,
      pe:        pe        ? Math.round(pe*10)/10   : null,
      mktCap:    mktCap    ? (mktCap/1e9).toFixed(1)+'B' : null,
      beta:      beta      ? Math.round(beta*100)/100 : null,
      divYield:  divYield  ? Math.round(divYield*1000)/10+'%' : null,
      shortFloat:shortFloat? Math.round(shortFloat*1000)/10+'%' : null,
      fmpPrice:  fmp.price || null,
      fmpAvg50:  fmp.priceAvg50 || null,
      fmpAvg200: fmp.priceAvg200 || null,
      fmpYearHigh: fmp.yearHigh || null,
      fmpYearLow:  fmp.yearLow  || null,
    });
  } catch(e) { res.status(500).json({ error:e.message }); }
});
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i]*k + ema*(1-k);
  return +ema.toFixed(4);
}

function calcMACD(closes) {
  if (closes.length < 35) return { line: null, signal: null, hist: null };
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const line  = +(ema12 - ema26).toFixed(4);
  // Signal: EMA9 de los últimos valores MACD
  const macdSeries = [];
  for (let i = 25; i < closes.length; i++) {
    const e12 = calcEMA(closes.slice(0, i+1), 12);
    const e26 = calcEMA(closes.slice(0, i+1), 26);
    macdSeries.push(e12 - e26);
  }
  const signal = macdSeries.length >= 9 ? +calcEMA(macdSeries, 9).toFixed(4) : null;
  const hist   = signal !== null ? +(line - signal).toFixed(4) : null;
  return { line, signal, hist };
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (period-1) + Math.max(d, 0)) / period;
    al = (al * (period-1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return 100;
  return Math.round((100 - 100 / (1 + ag/al)) * 10) / 10;
}

app.get('/api/market-data/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const isIndex = ['SPX','SPY','QQQ','IWM','NDX','RUT'].includes(symbol);
    const yhSym = symbol === 'SPX' ? '%5EGSPC'
                : symbol === 'NDX' ? '%5EIXIC'
                : symbol === 'RUT' ? '%5ERUT'
                : encodeURIComponent(symbol);

    // VIX actual + historial 1 año (para IV Rank)
    const vixR = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1y',
      { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const vixJ = await vixR.json();
    const vixPrices = vixJ.chart.result[0].indicators.quote[0].close.filter(v => v != null);
    const vix      = Math.round(vixPrices.at(-1) * 100) / 100;
    const vix52H   = Math.round(Math.max(...vixPrices) * 100) / 100;
    const vix52L   = Math.round(Math.min(...vixPrices) * 100) / 100;
    const ivRank   = Math.round((vix - vix52L) / (vix52H - vix52L) * 100);

    // RSI, EMA, MACD — 90 días para tener suficiente historia
    const prR = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yhSym}?interval=1d&range=6mo`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const prJ = await prR.json();
    const result0    = prJ.chart.result[0];
    const timestamps = result0.timestamp;
    const quote      = result0.indicators.quote[0];
    const rawCloses  = quote.close;
    const closes     = rawCloses.filter(v => v != null);
    // OHLC para candlestick chart
    const priceHistory = timestamps.map((t, i) => ({
      time:  t,
      open:  quote.open[i]  ? +quote.open[i].toFixed(2)  : null,
      high:  quote.high[i]  ? +quote.high[i].toFixed(2)  : null,
      low:   quote.low[i]   ? +quote.low[i].toFixed(2)   : null,
      close: quote.close[i] ? +quote.close[i].toFixed(2) : null,
    })).filter(d => d.close !== null);
    const rsi       = calcRSI(closes);
    const price     = Math.round(closes.at(-1) * 100) / 100;
    const prev      = closes.at(-2) || price;
    const chg       = Math.round((price - prev) * 100) / 100;
    const chgPct    = Math.round((chg / prev) * 10000) / 100;
    const ema10     = calcEMA(closes, 10);
    const ema20     = calcEMA(closes, 20);
    const macd      = calcMACD(closes);

    // Earnings + Sector — solo acciones individuales
    let earningsDays = 999;
    let sector = null, industry = null;
    if (!isIndex) {
      try {
        // Earnings desde calendarEvents
        const eR = await fetch(
          `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yhSym}?modules=calendarEvents`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const eJ  = await eR.json();
        const eTs = eJ.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate?.[0]?.raw;
        if (eTs) earningsDays = Math.round((eTs * 1000 - Date.now()) / 86400000);
      } catch(e) {}
      try {
        // Sector e Industry desde search endpoint (más confiable)
        const sR = await fetch(
          `https://query1.finance.yahoo.com/v1/finance/search?q=${yhSym}&quotesCount=1&newsCount=0`,
          { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com' } });
        const sJ = await sR.json();
        const sq = sJ.quotes?.[0];
        if (sq?.quoteType === 'EQUITY') {
          sector   = sq.sector   || null;
          industry = sq.industry || null;
        }
      } catch(e) {}
    }

    res.json({
      symbol, price, chg, chgPct, vix, ivRank, rsi, earningsDays,
      ema10, ema20, priceHistory, sector, industry,
      macdLine: macd.line, macdSignal: macd.signal, macdHist: macd.hist,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Playbooks ────────────────────────────────────────────────
const PB_FILE2 = path.join(__dirname, 'playbooks.json');
function loadPlaybooksData() {
  try { return JSON.parse(fs.readFileSync(PB_FILE2,'utf8')); }
  catch(e) { return { playbooks:[] }; }
}
function savePlaybooksData(data) { fs.writeFileSync(PB_FILE2, JSON.stringify(data,null,2),'utf8'); }

app.get('/api/playbooks', (req, res) => res.json(loadPlaybooksData()));
app.post('/api/playbooks', (req, res) => {
  const data = loadPlaybooksData();
  const pb = req.body;
  pb.id = pb.id || `pb-${Date.now()}`;
  const idx = data.playbooks.findIndex(p=>p.id===pb.id);
  if (idx>=0) data.playbooks[idx]=pb; else data.playbooks.push(pb);
  savePlaybooksData(data);
  res.json(pb);
});
app.delete('/api/playbooks/:id', (req, res) => {
  const data = loadPlaybooksData();
  data.playbooks = data.playbooks.filter(p=>p.id!==req.params.id);
  savePlaybooksData(data);
  res.json({ok:true});
});

// ── Screeners Paradigma (Finviz scraping) ────────────────────
const SCREENERS = {
  fuerza: {
    label: '💪 Fuerza',
    desc:  'Mercado baja pero estos suben hoy',
    url:   'https://finviz.com/screener.ashx?v=111&f=an_recom_buybetter,sh_avgvol_o500,sh_price_o20,ta_perf2_dp&ft=4',
  },
  x2: {
    label: '🚀 X2',
    desc:  'Doblan en el año (+100% YTD)',
    url:   'https://finviz.com/screener.ashx?v=111&f=sh_avgvol_o500,sh_price_o20,ta_perf_ytd100o&ft=4',
  },
  maximos: {
    label: '📈 Máximos Anuales',
    desc:  'Nuevos máximos de 52 semanas',
    url:   'https://finviz.com/screener.ashx?v=111&f=sh_avgvol_o500,sh_price_o20,ta_highlow52w_nh&ft=4',
  },
  gangas: {
    label: '🎯 Gangas',
    desc:  'P/E bajo, dividendo, oversold',
    url:   'https://finviz.com/screener.ashx?v=111&f=fa_div_o1,fa_pe_u25,op_option_optionshort,sh_opt_option,sh_price_u30,ta_beta_u1,ta_rsi_os40&ft=4',
  },
  volumazo: {
    label: '💥 Volumazo',
    desc:  'Volumen relativo +5x en alza',
    url:   'https://finviz.com/screener.ashx?v=111&f=sh_avgvol_o1000,sh_price_o10,sh_relvol_o5,ta_perf2_dp&ft=4',
  },
  gapeadoras: {
    label: '⚡ Gapeadoras',
    desc:  'Gap up +3% con volumen',
    url:   'https://finviz.com/screener.ashx?v=111&f=sh_avgvol_o500,sh_gap_u3,sh_price_o20,sh_relvol_o3,ta_perf2_dp&ft=4',
  },
  cercaemas: {
    label: '📍 Cerca EMAs',
    desc:  'Precio cruzando SMA20 | Beta >1.5 | Vol >1M | RelVol >1',
    url:   'https://finviz.com/screener.ashx?v=111&f=op_option_optionshort,sh_avgvol_o1000,sh_relvol_o1,ta_beta_o1.5,ta_sma20_cross&ft=4',
  },
};

const _screenerCache = {};
const CACHE_TTL = 15 * 60 * 1000; // 15 min

app.get('/api/screeners', (req, res) => {
  const info = Object.entries(SCREENERS).map(([id, s]) => ({
    id, label: s.label, desc: s.desc, url: s.url,
    cached: !!(_screenerCache[id] && Date.now() - _screenerCache[id].ts < CACHE_TTL),
  }));
  res.json(info);
});

app.get('/api/screener/:id', async (req, res) => {
  const id = req.params.id;
  const sc = SCREENERS[id];
  if (!sc) return res.status(404).json({ error: 'Screener no encontrado' });

  // Caché válida
  if (_screenerCache[id] && Date.now() - _screenerCache[id].ts < CACHE_TTL) {
    return res.json(_screenerCache[id].data);
  }

  try {
    const tickers = [];
    for (let page = 1; page <= 3; page++) {
      const pageUrl = sc.url + `&r=${(page-1)*20+1}`;
      const r = await fetch(pageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        }
      });
      const html = await r.text();
      // Extraer tickers del HTML de Finviz
      const matches = [...html.matchAll(/data-boxover-ticker="([A-Z]+)"/g)];
      const pageTickers = [...new Set(matches.map(m => m[1]))];
      if (!pageTickers.length) break;
      tickers.push(...pageTickers);
      if (pageTickers.length < 20) break; // última página
    }
    const unique = [...new Set(tickers)].slice(0, 60);
    _screenerCache[id] = { ts: Date.now(), data: unique };
    res.json(unique);
  } catch(e) {
    console.error(`[Screener ${id}]`, e.message);
    res.json([]);
  }
});

// ── Fase preliminar por ticker ───────────────────────────────
app.get('/api/watchlist/:symbol/fase-preliminar', async (req, res) => {
  try {
    const sym   = req.params.symbol.toUpperCase();
    const yhSym = sym === 'SPX' ? '%5EGSPC' : encodeURIComponent(sym);

    // Precio + EMAs + MACD desde Yahoo Finance (90 días)
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${yhSym}?interval=1d&range=90d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const j = await r.json();
    const result = j.chart?.result?.[0];
    if (!result) return res.json({ fase: null, razon: 'Sin datos' });

    const closes = result.indicators.quote[0].close.filter(v => v != null);
    if (closes.length < 30) return res.json({ fase: null, razon: 'Insuficientes datos' });

    // Calcular EMA
    const ema = (data, period) => {
      const k = 2/(period+1); let e = null;
      for (let i=0;i<data.length;i++) {
        if (i<period-1) continue;
        if (i===period-1) e=data.slice(0,period).reduce((a,b)=>a+b,0)/period;
        else e=data[i]*k+e*(1-k);
      }
      return +e.toFixed(4);
    };

    // Calcular MACD
    const macdCalc = (data) => {
      const k12=2/13, k26=2/27, k9=2/10;
      let e12=null,e26=null,sig=null;
      for (let i=0;i<data.length;i++) {
        const c=data[i];
        e12=e12===null?c:c*k12+e12*(1-k12);
        e26=e26===null?c:c*k26+e26*(1-k26);
        if (i<25) continue;
        const m=e12-e26;
        sig=sig===null?m:m*k9+sig*(1-k9);
      }
      return { line: e12-e26, signal: sig, hist: (e12-e26)-sig };
    };

    const precio = closes.at(-1);
    const ema10  = ema(closes, 10);
    const ema20  = ema(closes, 20);
    const macd   = macdCalc(closes);

    // CIAR v3 — señal activa para este ticker
    const signals = loadSignals();
    const ciar    = signals[sym];
    const ciarAge = ciar ? Math.floor((Date.now() - new Date(ciar.receivedAt).getTime()) / 60000) : null;
    const ciarFresh = ciarAge !== null && ciarAge < 1440; // señal del día (24h)

    // Determinar fase
    const sobreEma20  = precio > ema20;
    const bajoEma20   = precio < ema20;
    const ema10Alc    = ema10 > ema20;
    const ema10Baj    = ema10 < ema20;
    const macdAlc     = macd.line > 0 && macd.hist > 0;
    const macdBaj     = macd.line < 0 && macd.hist < 0;
    const macdNeutro  = Math.abs(macd.line) < Math.abs(precio) * 0.003;
    const ciarBuy     = ciarFresh && ciar.signal === 'BUY';
    const ciarSell    = ciarFresh && ciar.signal === 'SELL';

    let fase, color, icono, razon, confirmado;

    // Score de confirmaciones: EMA cruce, Precio vs EMA20, MACD, CIAR
    const scores = {
      emaCruce:  ema10Alc ? 'alc' : ema10Baj ? 'baj' : 'neu',
      precioEma: sobreEma20 ? 'alc' : bajoEma20 ? 'baj' : 'neu',
      macd:      macdAlc ? 'alc' : macdBaj ? 'baj' : 'neu',
      ciar:      ciarFresh ? ciar.signal : null,
    };

    const alcCount = [
      scores.emaCruce==='alc', scores.precioEma==='alc',
      scores.macd==='alc',     scores.ciar==='BUY'
    ].filter(Boolean).length;

    const bajCount = [
      scores.emaCruce==='baj', scores.precioEma==='baj',
      scores.macd==='baj',     scores.ciar==='SELL'
    ].filter(Boolean).length;

    // Determinar fase
    if (alcCount >= 2) {
      fase = alcCount === 4 ? 'F2' : 'F2~';
      color = '#13d68f';
    } else if (bajCount >= 2) {
      fase = bajCount === 4 ? 'F4' : 'F4~';
      color = '#f04f5a';
    } else if (alcCount === 1 && bajCount === 0) {
      fase = 'F1'; color = '#6b7280'; // saliendo hacia F2
    } else if (bajCount === 1 && alcCount === 0) {
      fase = 'F3'; color = '#6b7280'; // saliendo hacia F4
    } else {
      fase = 'F1'; color = '#6b7280';
    }

    // Razon
    const tags = [
      scores.emaCruce==='alc'?'EMA✓':scores.emaCruce==='baj'?'EMA✗':'EMA~',
      scores.precioEma==='alc'?'P>EMA20':scores.precioEma==='baj'?'P<EMA20':'P≈EMA20',
      scores.macd==='alc'?'MACD+':scores.macd==='baj'?'MACD-':'MACD~',
      scores.ciar ? `CIAR ${scores.ciar}✅` : 'CIAR—',
    ];
    razon = tags.join(' · ');
    confirmado = ciarFresh;

    // Confirmaciones para los dots (4 dots = EMA cruce, Precio, MACD, CIAR)
    const dots = [
      { ok: scores.emaCruce!=='neu',  alc: scores.emaCruce==='alc',  label:'EMA' },
      { ok: scores.precioEma!=='neu', alc: scores.precioEma==='alc', label:'Precio' },
      { ok: scores.macd!=='neu',      alc: scores.macd==='alc',      label:'MACD' },
      { ok: !!scores.ciar,            alc: scores.ciar==='BUY',      label:'CIAR' },
    ];

    res.json({
      fase, color, razon, confirmado, dots,
      datos: { precio, ema10, ema20, macdLine: +macd.line.toFixed(4), macdHist: +macd.hist.toFixed(4) },
      ciar: ciarFresh ? { signal: ciar.signal, age: ciarAge } : null,
    });
  } catch(e) {
    res.json({ fase: null, razon: e.message });
  }
});

// ── Playbook score por ticker ─────────────────────────────────
// playbook-score movido después de loadChecklists

// ── Price History para chart de evaluaciones ────────────────
app.get('/api/price-history/:symbol', async (req, res) => {
  try {
    const sym      = req.params.symbol.toUpperCase();
    const interval = req.query.interval || '1d';
    const range    = req.query.range    || '6mo';
    const yhSym    = sym === 'SPX' ? '%5EGSPC' : encodeURIComponent(sym);
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${yhSym}?interval=${interval}&range=${range}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const j      = await r.json();
    const result = j.chart?.result?.[0];
    if (!result) return res.json([]);
    const ts    = result.timestamp;
    const quote = result.indicators.quote[0];
    const data  = ts.map((t, i) => ({
      time:  t,
      open:  quote.open[i]  ? +quote.open[i].toFixed(2)  : null,
      high:  quote.high[i]  ? +quote.high[i].toFixed(2)  : null,
      low:   quote.low[i]   ? +quote.low[i].toFixed(2)   : null,
      close: quote.close[i] ? +quote.close[i].toFixed(2) : null,
    })).filter(d => d.close !== null);
    res.json(data);
  } catch(e) {
    res.json([]);
  }
});

// ── Algo Signals (CIAR v3 webhook) ───────────────────────────
const ALGO_FILE = path.join(__dirname, 'algo_signals.json');
function loadSignals() {
  try { return JSON.parse(fs.readFileSync(ALGO_FILE,'utf8')); } catch(e) { return {}; }
}
function saveSignals(data) { fs.writeFileSync(ALGO_FILE, JSON.stringify(data,null,2),'utf8'); }

app.post('/api/algo-signal', (req, res) => {
  const { ticker, signal, price, time } = req.body;
  if (!ticker || !signal) return res.status(400).json({ error: 'ticker y signal requeridos' });
  const signals = loadSignals();
  signals[ticker.toUpperCase()] = { signal, price, time, receivedAt: new Date().toISOString() };
  saveSignals(signals);
  console.log(`[CIAR v3] ${ticker} ${signal} @ $${price}`);
  res.json({ ok: true, ticker, signal });
});

app.get('/api/algo-signals', (req, res) => res.json(loadSignals()));

// ── Alejandro Checklists ──────────────────────────────────────
const CL_FILE = path.join(__dirname, 'alejandro_checklists.json');
function loadChecklists() {
  try { return JSON.parse(fs.readFileSync(CL_FILE,'utf8')); } catch(e) { return []; }
}
function saveChecklists(data) { fs.writeFileSync(CL_FILE, JSON.stringify(data,null,2),'utf8'); }

app.get('/api/watchlist/:symbol/playbook-score', (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const checklists = loadChecklists();
  const entries = checklists.filter(c => c.ticker === sym);
  if (!entries.length) return res.json(null);
  const parseDate = d => {
    if (!d) return 0;
    const p = d.split('/');
    return p.length===3 ? new Date(+p[2],+p[1]-1,+p[0]).getTime() : new Date(d).getTime();
  };
  entries.sort((a,b) => parseDate(b.date) - parseDate(a.date));
  const last = entries[0];
  const fase = last.checks?.['ciclo_tm']
    ? last.checks['ciclo_tm'].toUpperCase()
    : (['ciclo_f1','ciclo_f2','ciclo_f3','ciclo_f4']
        .find(f => last.checks?.[f]==='si')?.replace('ciclo_f','F') || '—');
  // Devolver checks al frontend para que calcule el score con su lógica actual
  res.json({
    score:     last.score,  // score original guardado (referencia)
    checks:    last.checks || {},
    fase,
    direction: last.direction || last.tesis || '',
    date:      last.date,
  });
});

app.get('/api/alejandro-checklists', (req, res) => res.json(loadChecklists()));

app.post('/api/alejandro-checklists', (req, res) => {
  const checklists = loadChecklists();
  const nowCOL = new Date().toLocaleString('sv-SE', {timeZone:'America/Bogota'}).replace(' ','T') + '-05:00';
  const item = { ...req.body, id: `cl-${Date.now()}`, createdAt: nowCOL };
  checklists.unshift(item);
  saveChecklists(checklists.slice(0, 200));
  res.json(item);
});

app.put('/api/alejandro-checklists/:id', (req, res) => {
  const checklists = loadChecklists();
  const idx = checklists.findIndex(c => c.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'No encontrado' });
  const updCOL = new Date().toLocaleString('sv-SE', {timeZone:'America/Bogota'}).replace(' ','T') + '-05:00';
  checklists[idx] = { ...checklists[idx], ...req.body, updatedAt: updCOL };
  saveChecklists(checklists);
  res.json(checklists[idx]);
});

app.delete('/api/alejandro-checklists/:id', (req, res) => {
  const checklists = loadChecklists();
  saveChecklists(checklists.filter(c => c.id !== req.params.id));
  res.json({ ok: true });
});


// ── Cadena de Opciones ────────────────────────────────────────
app.get('/api/option-chain/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const expiry = req.query.expiry || null;

    // 1. Cadena de strikes/vencimientos desde TastyTrade
    const chainData = await tt._req(`/option-chains/${symbol}/nested`);
    const expirations = chainData.data?.items?.[0]?.expirations || [];
    if (!expirations.length) return res.status(404).json({ error: 'No se encontró cadena de opciones' });

    const expList = expiry
      ? expirations.filter(e => e['expiration-date'] === expiry)
      : expirations.slice(0, 6);

    // 2. Precio actual del subyacente desde Yahoo Finance (v8 no requiere crumb)
    let underlyingPrice = 0;
    let ivBase = 0.40;
    try {
      const qR = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const qJ = await qR.json();
      underlyingPrice = parseFloat(qJ.chart?.result?.[0]?.meta?.regularMarketPrice || 0);
    } catch(e) {}

    // 3. Precios/Greeks reales desde TastyTrade /market-data en lotes de 50
    const pricingMap = {};
    const allSymbols = [];
    for (const exp of expList) {
      for (const s of (exp.strikes || [])) {
        if (s.call) allSymbols.push(s.call);
        if (s.put)  allSymbols.push(s.put);
      }
    }

    const BATCH = 50;
    for (let i = 0; i < allSymbols.length; i += BATCH) {
      try {
        const batch = allSymbols.slice(i, i + BATCH);
        const params = batch.map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
        const d = await tt._req(`/market-data?${params}`);
        for (const item of (d.data?.items || [])) {
          const iv = parseFloat(item.volatility || 0) * 100;
          if (iv > 0) ivBase = Math.max(ivBase, iv / 100);
          pricingMap[item.symbol] = {
            iv:     +iv.toFixed(1),
            mark:   parseFloat(item.mark   || item.mid || 0),
            bid:    parseFloat(item.bid    || 0),
            ask:    parseFloat(item.ask    || 0),
            volume: parseInt(item.volume   || 0),
            oi:     parseInt(item['open-interest'] || 0),
            delta:  parseFloat(item.delta  || 0),
            theta:  parseFloat(item.theta  || 0),
            gamma:  parseFloat(item.gamma  || 0),
            vega:   parseFloat(item.vega   || 0),
          };
        }
      } catch(e) {}
    }

    try {

      // 4. Construir respuesta con Black-Scholes para strikes sin datos de Yahoo
      const R = 0.0525;
      function bsN(x) {
        const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
        const sign=x<0?-1:1; x=Math.abs(x)/Math.sqrt(2);
        const t=1/(1+p*x);
        return 0.5*(1+sign*(1-(((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t)*Math.exp(-x*x)));
      }
      function bsPDF(x){return Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI);}
      function calcGreeks(S,K,T,sigma,isCall){
        if(!S||!K||T<=0||!sigma) return {};
        const d1=(Math.log(S/K)+(R+sigma*sigma/2)*T)/(sigma*Math.sqrt(T));
        const d2=d1-sigma*Math.sqrt(T);
        const Nd1=bsN(d1),Nd2=bsN(d2),nd1=bsPDF(d1);
        const delta=isCall?Nd1:Nd1-1;
        const gamma=nd1/(S*sigma*Math.sqrt(T));
        const theta=isCall
          ?(-(S*nd1*sigma)/(2*Math.sqrt(T))-R*K*Math.exp(-R*T)*Nd2)/365
          :(-(S*nd1*sigma)/(2*Math.sqrt(T))+R*K*Math.exp(-R*T)*bsN(-d2))/365;
        return {
          delta: +delta.toFixed(3),
          gamma: +gamma.toFixed(4),
          theta: +theta.toFixed(4),
        };
      }

      const result = expList.map(exp => {
        const expDate = exp['expiration-date'];
        const T = Math.max((new Date(expDate) - Date.now()) / (365.25*86400000), 0.001);

        return {
          expiry: expDate,
          dte:    exp['days-to-expiration'],
          type:   exp['expiration-type'],
          strikes: (exp.strikes || []).map(s => {
            const strike = parseFloat(s['strike-price']);
            const atm = underlyingPrice > 0 && Math.abs(strike - underlyingPrice) / underlyingPrice < 0.03;

            // Buscar datos directamente por símbolo TastyTrade
            const cData = pricingMap[s.call] || {};
            const pData = pricingMap[s.put]  || {};

            const cIv = (cData.iv||0) > 0 ? cData.iv/100 : ivBase;
            const pIv = (pData.iv||0) > 0 ? pData.iv/100 : ivBase;

            // Greeks: usar reales de TastyTrade si disponibles, sino Black-Scholes
            const cGreeksBS = calcGreeks(underlyingPrice, strike, T, cIv, true);
            const pGreeksBS = calcGreeks(underlyingPrice, strike, T, pIv, false);

            return {
              strike,
              atm,
              call: {
                symbol: s.call,
                iv:     +((cData.iv||0) > 0 ? cData.iv : ivBase*100).toFixed(1),
                mark:   cData.mark   || 0,
                bid:    cData.bid    || 0,
                ask:    cData.ask    || 0,
                volume: cData.volume || 0,
                oi:     cData.oi     || 0,
                delta:  cData.delta  || cGreeksBS.delta || 0,
                theta:  cData.theta  || cGreeksBS.theta || 0,
                gamma:  cData.gamma  || cGreeksBS.gamma || 0,
                vega:   cData.vega   || 0,
              },
              put: {
                symbol: s.put,
                iv:     +((pData.iv||0) > 0 ? pData.iv : ivBase*100).toFixed(1),
                mark:   pData.mark   || 0,
                bid:    pData.bid    || 0,
                ask:    pData.ask    || 0,
                volume: pData.volume || 0,
                oi:     pData.oi     || 0,
                delta:  pData.delta  || pGreeksBS.delta || 0,
                theta:  pData.theta  || pGreeksBS.theta || 0,
                gamma:  pData.gamma  || pGreeksBS.gamma || 0,
                vega:   pData.vega   || 0,
              },
            };
          }),
        };
      });

      return res.json({ symbol, underlyingPrice, expirations: result });
    } catch(e2) {
      return res.status(500).json({ error: e2.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ══════════════════════════════════════════════════════════════
// ── SPX Signal Center ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
const { calcGEX, selectStrategy, findStrikesByDelta, buildSignalSummary, getETHour } = require('./src/spx');
const { calcPlaybookScore, calcRelativeVolume, priceExtension } = require('./src/spx_indicators');

// ── SPX Config (pesos ajustables) ─────────────────────────────
const SPX_CONFIG_FILE = path.join(__dirname, 'spx_config.json');
const SPX_CONFIG_DEFAULTS = {
  minScore: 75,
  weights: {
    precio_ema200:         5,
    emas_alineadas_diario: 5,
    emas_alineadas_15m:   22,
    macd_alineado_15m:    28,
    precio_cerca_ema:     20,
    volumen_spy:          12,
    gex_compatible:        8,
  },
  // Parámetros de trading (compartidos con backtester)
  trading: {
    capital:     10000,   // Capital de la cuenta
    experiencia: 'intermedio', // principiante / intermedio / avanzado
    riesgoPct:   2,       // % máximo de riesgo por operación
    targetDelta: 0.40,    // Delta objetivo para el strike short
    tpPct:       50,      // Take Profit % del crédito
    slMult:      1.0,     // Stop Loss multiplicador del crédito
    spreadWidth: 10,      // Puntos del spread (calculado automático)
  }
};
function loadSPXConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(SPX_CONFIG_FILE, 'utf8'));
    // Si los pesos son los viejos (precio_ema200=15), usar defaults actualizados
    if (saved?.weights?.precio_ema200 === 15) {
      console.log('[SPX] Config antigua detectada, usando defaults Propuesta C');
      saveSPXConfig(SPX_CONFIG_DEFAULTS);
      return SPX_CONFIG_DEFAULTS;
    }
    return saved;
  } catch(e) {
    return SPX_CONFIG_DEFAULTS;
  }
}
function saveSPXConfig(cfg) { fs.writeFileSync(SPX_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); }

// GET /api/spx/config
app.get('/api/spx/config', (req, res) => res.json(loadSPXConfig()));

// POST /api/spx/config
app.post('/api/spx/config', (req, res) => {
  const cfg = loadSPXConfig();
  const { minScore, weights, trading } = req.body;
  if (minScore !== undefined) cfg.minScore = minScore;
  if (weights)  cfg.weights  = { ...cfg.weights,  ...weights  };
  if (trading)  cfg.trading  = { ...(cfg.trading||{}), ...trading };
  saveSPXConfig(cfg);
  res.json(cfg);
});
const SPX_SIGNALS_FILE = path.join(__dirname, 'spx_signals.json');
const SPX_15M_FILE     = path.join(__dirname, 'spx_15m_context.json');

function loadSPXSignals() {
  try { return JSON.parse(fs.readFileSync(SPX_SIGNALS_FILE, 'utf8')); } catch(e) { return []; }
}
function saveSPXSignals(signals) {
  fs.writeFileSync(SPX_SIGNALS_FILE, JSON.stringify(signals, null, 2), 'utf8');
}
function load15mContext() {
  try { return JSON.parse(fs.readFileSync(SPX_15M_FILE, 'utf8')); } catch(e) { return null; }
}
function save15mContext(ctx) {
  try { fs.writeFileSync(SPX_15M_FILE, JSON.stringify(ctx, null, 2), 'utf8'); } catch(e) {}
}

// GET /api/spx/context — contexto completo del mercado
app.get('/api/spx/context', async (req, res) => {
  try {
    // 1. Cadena SPX para GEX y precio
    const chainData = await tt._req('/option-chains/SPX/nested');
    const expirations = chainData.data?.items?.[0]?.expirations || [];

    // 2. Precio SPX desde Yahoo
    let spxPrice = 5530;
    try {
      const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=1d',
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const j = await r.json();
      spxPrice = parseFloat(j.chart?.result?.[0]?.meta?.regularMarketPrice || spxPrice);
    } catch(e) {}

    // 3. VIX desde Yahoo
    let vix = 20;
    try {
      const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d',
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const j = await r.json();
      vix = parseFloat(j.chart?.result?.[0]?.meta?.regularMarketPrice || vix);
    } catch(e) {}

    // 4. IV Rank SPX desde TastyTrade
    let ivRank = 30;
    try {
      const mktData = await tt._req('/market-data/volatility?symbols[]=SPX');
      ivRank = parseFloat(mktData.data?.items?.[0]?.['iv-rank'] || 30) * 100;
    } catch(e) {}

    // 5. Calcular GEX
    // Necesitamos precios/greeks de la cadena — usar los que ya vienen en nested
    const allStrikes = [];
    for (const exp of expirations.slice(0, 4)) {
      for (const s of (exp.strikes || [])) {
        allStrikes.push(s.call, s.put);
      }
    }

    // Usar cadena interna /api/option-chain/SPX que ya tiene gamma/oi correctos
    let enrichedExps = [];
    try {
      const chainRes = await fetch(`http://localhost:${process.env.PORT||3000}/api/option-chain/SPX`);
      const chainJson = await chainRes.json();
      // Actualizar spxPrice si vino como 0
      if (!spxPrice || spxPrice < 1000) spxPrice = chainJson.underlyingPrice || spxPrice;
      enrichedExps = (chainJson.expirations || []).slice(0, 4).map(exp => ({
        expiry: exp.expiry,
        dte:    exp.dte,
        strikes: (exp.strikes || []).map(s => ({
          strike: s.strike,
          call: {
            delta: s.call?.delta || 0,
            gamma: s.call?.gamma || 0,
            oi:    s.call?.oi    || 0,
            mark:  s.call?.mark  || 0,
          },
          put: {
            delta: s.put?.delta || 0,
            gamma: s.put?.gamma || 0,
            oi:    s.put?.oi    || 0,
            mark:  s.put?.mark  || 0,
          },
        }))
      }));
    } catch(e) {
      console.error('[SPX] Error obteniendo cadena para GEX:', e.message);
    }

    // 6. GEX
    const gex = calcGEX(enrichedExps, spxPrice);

    // Calcular Gamma Flip si no viene de calcGEX (interpolación entre levels)
    if (!gex.gammaFlip && gex.levels && gex.levels.length > 1) {
      const sorted = [...gex.levels].sort((a, b) => a.strike - b.strike);
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i-1], curr = sorted[i];
        if (prev.gex < 0 && curr.gex > 0) {
          const ratio = Math.abs(prev.gex) / (Math.abs(prev.gex) + Math.abs(curr.gex));
          gex.gammaFlip = Math.round(prev.strike + ratio * (curr.strike - prev.strike));
          break;
        } else if (prev.gex > 0 && curr.gex < 0) {
          const ratio = Math.abs(prev.gex) / (Math.abs(prev.gex) + Math.abs(curr.gex));
          gex.gammaFlip = Math.round(prev.strike + ratio * (curr.strike - prev.strike));
          break;
        }
      }
    }

    // 7. Indicadores técnicos — diario y 15m
    let indicators = { daily: {}, m15: {}, spy: {} };
    try {
      // Diario SPX
      const rD = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=1y',
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const jD = await rD.json();
      const closesD = jD.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null) || [];
      if (closesD.length >= 50) {
        const price = closesD[closesD.length - 1];
        const ema10D  = calcEMA(closesD, 10);
        const ema20D  = calcEMA(closesD, 20);
        const ema50D  = calcEMA(closesD, 50);
        const ema200D = calcEMA(closesD, 200);
        indicators.daily = {
          price, ema10: ema10D, ema20: ema20D, ema50: ema50D, ema200: ema200D,
          ext10:  priceExtension(price, ema10D),
          ext20:  priceExtension(price, ema20D),
          ext50:  priceExtension(price, ema50D),
          ext200: priceExtension(price, ema200D),
          macd:   calcMACD(closesD),
        };
      }

      // 15m SPX (últimos 5 días)
      const r15 = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=15m&range=5d',
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const j15 = await r15.json();
      const closes15 = j15.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null) || [];
      if (closes15.length >= 30) {
        const price15 = closes15[closes15.length - 1];
        const ema10_15  = calcEMA(closes15, 10);
        const ema20_15  = calcEMA(closes15, 20);
        indicators.m15 = {
          price: price15, ema10: ema10_15, ema20: ema20_15,
          ext10: priceExtension(price15, ema10_15),
          ext20: priceExtension(price15, ema20_15),
          macd:  calcMACD(closes15),
        };
      }

      // Volumen SPY — intraday vs promedio 20d
      try {
        // 1. Promedio diario histórico (20 días)
        const rSPYd = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=3mo',
          { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const jSPYd = await rSPYd.json();
        const volsD = jSPYd.chart?.result?.[0]?.indicators?.quote?.[0]?.volume?.filter(v => v != null) || [];
        const avg20d = volsD.length >= 20
          ? volsD.slice(-20).reduce((a, b) => a + b, 0) / 20
          : 0;

        // 2. Volumen acumulado del día actual (velas 1m)
        const rSPY1m = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1m&range=1d',
          { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const jSPY1m = await rSPY1m.json();
        const vols1m  = jSPY1m.chart?.result?.[0]?.indicators?.quote?.[0]?.volume || [];
        const volHoy  = vols1m.filter(v => v != null).reduce((a, b) => a + b, 0);

        if (avg20d > 0 && volHoy > 0) {
          indicators.spy = {
            volume:         volHoy,
            avg20d:         Math.round(avg20d),
            relativeVolume: +( volHoy / avg20d ).toFixed(2),
          };
        }
      } catch(eSpy) { console.error('[SPX] volumen SPY error:', eSpy.message); }
    } catch(e) { console.error('[SPX] indicators error:', e.message); }

    // 7. Hora ET
    const et = getETHour();

    // 8. EMAs SPX (20 y 50 periodos diarios)
    let ema20 = null, ema50 = null;
    try {
      const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=3mo',
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const j = await r.json();
      const closes = j.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
      if (closes.length >= 50) {
        const calcEMA = (prices, period) => {
          const k = 2 / (period + 1);
          let ema = prices.slice(0, period).reduce((a,b) => a+b, 0) / period;
          for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
          return +ema.toFixed(2);
        };
        ema20 = calcEMA(closes, 20);
        ema50 = calcEMA(closes, 50);
      }
    } catch(e) {}

    // Score del playbook (dirección neutral por defecto en contexto)
    const spxConfig = loadSPXConfig();

    res.json({
      spxPrice: +spxPrice.toFixed(2),
      vix:      +vix.toFixed(2),
      ivRank:   +ivRank.toFixed(1),
      isCredit: ivRank > 30 || vix > 20,
      gex,
      ema20,
      ema50,
      indicators,
      config:   spxConfig,
      etTime:   et.time,
      etHour:   et.hour,
      etMin:    et.min,
      windowOK: (et.hour > 9 || (et.hour === 9 && et.min >= 0)) && et.hour < 16,  // desde 09:00 ET (evita apertura 08:30)
      ts:       new Date().toISOString(),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Estado de contexto 15min en memoria ──────────────────────
let spx15mContext = load15mContext(); // persiste entre reinicios

// POST /api/spx/webhook — recibe señal de TradingView
app.post('/api/spx/webhook', async (req, res) => {
  try {
    let { direction, timeframe = '2m', source = 'TradingView', playbook_score = null, price, time } = req.body;

    // Normalizar direction (TradingView manda 'buy'/'sell' en strategies)
    if (direction === 'buy'  || direction === 'long')  direction = 'BULLISH';
    if (direction === 'sell' || direction === 'short') direction = 'BEARISH';
    direction = (direction || '').toUpperCase();
    if (!['BULLISH','BEARISH','NEUTRAL'].includes(direction))
      return res.status(400).json({ error: `direction inválido: ${direction}. Usar BULLISH|BEARISH|NEUTRAL` });

    // ── SEÑAL 15min: guardar como contexto direccional ────────
    if (timeframe === '15m' || timeframe === '15') {
      spx15mContext = { direction, timestamp: new Date().toISOString(), price };
      save15mContext(spx15mContext);
      console.log(`[SPX] Contexto 15m actualizado y persistido: ${direction}`);
      return res.json({ signal: false, saved: true, message: `Contexto 15m guardado: ${direction}` });
    }

    // ── SEÑAL 2min: verificar alineación con 15min ────────────
    if (timeframe === '2m' || timeframe === '2') {
      if (!spx15mContext) {
        return res.json({ signal: false, reason: 'Sin contexto 15m. Espera que llegue primero la señal de 15 minutos.' });
      }

      // Verificar que el contexto 15m no sea demasiado viejo (máx 4 horas)
      const age = Date.now() - new Date(spx15mContext.timestamp).getTime();
      if (age > 8 * 3600 * 1000) {
        spx15mContext = null;
        save15mContext(null);
        return res.json({ signal: false, reason: 'Contexto 15m expirado (>8h). Espera nueva señal de 15m.' });
      }

      // Verificar alineación
      if (spx15mContext.direction !== direction) {
        return res.json({ 
          signal: false, 
          reason: `Divergencia temporal: 15m dice ${spx15mContext.direction} pero 2m dice ${direction}. Sin entrada.` 
        });
      }

      console.log(`[SPX] Señal confirmada — 15m: ${spx15mContext.direction} | 2m: ${direction}`);
    }

    // ── RESPONDER INMEDIATAMENTE para evitar timeout en TradingView ──
    res.json({ signal: 'processing', message: 'Señal recibida, procesando en background...' });

    // ── GENERAR SUGERENCIA (en background) ───────────────────────────
    // Obtener contexto de mercado
    const ctxRes = await fetch(`http://localhost:${process.env.PORT||3000}/api/spx/context`);
    const ctx    = await ctxRes.json();

    // Capital de la cuenta
    let capital = 10000;
    try {
      const acc = await tt._req(`/accounts/${process.env.TASTY_ACCOUNT}/balances`);
      capital = parseFloat(acc.data?.['net-liquidating-value'] || capital);
    } catch(e) {}

    // Calcular score del playbook
    const spxConfig = loadSPXConfig();
    // Asegurar defaults para evitar undefined en calcPlaybookScore
    const safeDaily = ctx.indicators?.daily || {};
    const safeM15   = ctx.indicators?.m15   || {};
    const safeSpy   = ctx.indicators?.spy   || {};
    if (!safeDaily.macd) safeDaily.macd = { line: null, signal: null, hist: null };
    if (!safeM15.macd)   safeM15.macd   = { line: null, signal: null, hist: null };

    // Calcular criterios de EMAs diarias con datos reales
    const spxPrice   = ctx.spxPrice || 0;
    const ema10d     = safeDaily.ema10  || 0;
    const ema20d     = safeDaily.ema20  || 0;
    const ema200d    = safeDaily.ema200 || 0;
    const isBearish  = direction === 'BEARISH';

    // Inyectar criterios calculados directamente en el objeto daily
    // para que calcPlaybookScore los use si los soporta
    safeDaily.precio_ema200_cumple        = ema200d > 0 ? (isBearish ? spxPrice < ema200d : spxPrice > ema200d) : false;
    safeDaily.emas_alineadas_diario_cumple = (ema10d > 0 && ema20d > 0) ? (isBearish ? ema10d < ema20d : ema10d > ema20d) : false;

    const playbookResult = calcPlaybookScore({
      direction,
      spxPrice:    ctx.spxPrice,
      gammaRegime: ctx.gex?.regime,
      gammaFlip:   ctx.gex?.gammaFlip,
      daily:       safeDaily,
      m15:         safeM15,
      spy:         safeSpy,
    }, spxConfig);

    // Parche: si calcPlaybookScore no usa los campos calculados,
    // recalculamos el score manualmente sumando los criterios reales
    const W = spxConfig.weights || SPX_CONFIG_DEFAULTS.weights;
    let scoreManual = playbookResult.score || 0;

    // Verificar si precio_ema200 y emas_alineadas_diario ya fueron evaluados correctamente
    // Si el score original los tiene como false cuando deberían ser true, corregir
    const criteriosReales = {
      precio_ema200:         safeDaily.precio_ema200_cumple,
      emas_alineadas_diario: safeDaily.emas_alineadas_diario_cumple,
    };
    // Reconstruir score con criterios reales
    const scoreCorregido = Object.keys(W).reduce((acc, k) => {
      if (k === 'precio_ema200' || k === 'emas_alineadas_diario') {
        return acc + (criteriosReales[k] ? (W[k] || 0) : 0);
      }
      // Para el resto usar el resultado original del playbook
      const criterioOriginal = playbookResult.criteria?.[k] ?? playbookResult.criterios?.[k];
      if (criterioOriginal !== undefined) return acc + (criterioOriginal ? (W[k] || 0) : 0);
      return acc;
    }, 0);

    // Solo corregir si la diferencia existe (el módulo no evaluó EMAs reales)
    if (scoreCorregido > 0 && scoreCorregido !== playbookResult.score) {
      playbookResult.score = scoreCorregido;
      playbookResult.passed = scoreCorregido >= (spxConfig.minScore || 75);
      playbookResult.minScore = spxConfig.minScore || 75;
      console.log(`[SPX] Score corregido con EMAs reales: ${scoreCorregido}% (original: ${playbookResult.score || 0}%)`);
    }

    if (!playbookResult.passed) {
      console.log(`[SPX] ❌ Score insuficiente: ${playbookResult.score}% (mínimo ${playbookResult.minScore}%)`);
      return;
    }

    // Seleccionar estrategia
    const sel = selectStrategy({
      direction,
      ivRank:      ctx.ivRank,
      vix:         ctx.vix,
      gammaRegime: ctx.gex?.regime,
      etHour:      ctx.etHour,
      etMin:       ctx.etMin,
      capital,
    });

    if (!sel.valid) {
      console.log(`[SPX] ❌ Estrategia inválida: ${sel.reason}`);
      return;
    }

    // Parámetros de trading desde config
    const tradingCfg = spxConfig.trading || SPX_CONFIG_DEFAULTS.trading;
    const targetDelta = tradingCfg.targetDelta || 0.40;
    const tpPct       = (tradingCfg.tpPct || 50) / 100;
    const slMult      = tradingCfg.slMult || 1.0;
    const spreadWidth = tradingCfg.spreadWidth || 10;

    // Buscar strikes con delta configurable
    const chainRes = await fetch(`http://localhost:${process.env.PORT||3000}/api/option-chain/SPX`);
    const chainData = await chainRes.json();
    const strikes = findStrikesByDelta(chainData.expirations || [], sel.strategy, ctx.spxPrice, sel.expType, targetDelta, spreadWidth);

    if (!strikes) {
      console.log(`[SPX] ❌ No se encontraron strikes con delta ${targetDelta}`);
      return;
    }

    // Construir señal
    const signal = buildSignalSummary(sel.strategy, strikes, sel, {
      ...ctx,
      direction,
      gammaRegime: ctx.gex?.regime,
      callWall:    ctx.gex?.callWall,
      putWall:     ctx.gex?.putWall,
      gammaFlip:   ctx.gex?.gammaFlip,
      etTime:      ctx.etTime,
    });

    signal.playbook  = playbookResult;
    signal.source    = source;
    signal.timeframe = timeframe;
    signal.tf15m     = spx15mContext?.direction || direction;

    // Agregar parámetros de trading y TP/SL calculados
    const credito = signal.credit || signal.maxProfit || 0;
    signal.trading = {
      delta:      targetDelta,
      tpPct:      Math.round(tpPct * 100),
      slMult:     slMult,
      spreadWidth: spreadWidth,
      tpTarget:   credito > 0 ? Math.round(credito * tpPct * 100) : null,
      slTarget:   credito > 0 ? Math.round(credito * slMult * 100) : null,
      breakeven:  signal.strikes ? (
        sel.strategy === 'BEAR_CALL'
          ? signal.strikes.shortStrike + credito
          : signal.strikes.shortStrike - credito
      ) : null,
    };

    // Guardar
    const signals = loadSPXSignals();
    signals.unshift(signal);
    saveSPXSignals(signals.slice(0, 50));

    console.log(`[SPX] ✅ Señal generada: ${signal.strategyName} | ${signal.strikes?.shortStrike}/${signal.strikes?.longStrike}`);
    // Nota: res ya fue enviado inmediatamente arriba para evitar timeout

  } catch(e) {
    console.error('[SPX] webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/spx/15m — estado del contexto 15min
app.get('/api/spx/15m', (req, res) => {
  res.json(spx15mContext || { direction: null, message: 'Sin contexto 15m activo' });
});

// GET /api/spx/signals — lista de señales pendientes/historial
app.get('/api/spx/signals', (req, res) => {
  res.json(loadSPXSignals());
});

// POST /api/spx/signals/:id/action — ejecutar o rechazar
app.post('/api/spx/signals/:id/action', async (req, res) => {
  try {
    const { action, notes = '' } = req.body; // action: EXECUTED | REJECTED
    const signals = loadSPXSignals();
    const idx = signals.findIndex(s => s.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Señal no encontrada' });

    signals[idx].status    = action;
    signals[idx].notes     = notes;
    signals[idx].actionAt  = new Date().toISOString();
    saveSPXSignals(signals);

    res.json({ ok: true, signal: signals[idx] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Guardado automático diario de NLV ─────────────────────────
async function snapshotNlv() {
  try {
    const bal = await tt.getBalances();
    const nlv = parseFloat(bal?.['net-liquidating-value'] || 0);
    if (nlv > 0) {
      const date = todayStr();
      saveNlvSnapshot(date, nlv);
      console.log(`[NLV] Snapshot guardado: ${date} = $${nlv.toFixed(2)}`);
    }
  } catch(e) { console.log('[NLV] Error guardando snapshot:', e.message); }
}

function scheduleDaily() {
  // Calcular milisegundos hasta las 4:35 PM ET (20:35 UTC)
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(20, 35, 0, 0);
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
  const ms = target - now;
  console.log(`[NLV] Próximo snapshot automático en ${Math.round(ms/60000)} minutos`);
  setTimeout(async () => {
    await snapshotNlv();
    scheduleDaily(); // reprogramar para mañana
  }, ms);
}

app.listen(PORT, async () => {
  console.log(`\n🚀  Bitácora Tasty → http://localhost:${PORT}`);
  console.log(`[ENV] Token length: ${(process.env.TT_SESSION_TOKEN || '').length}`);
  try {
    await tt.authenticate();
    const bal = await tt.getBalances();
    const nlv = parseFloat(bal?.['net-liquidating-value'] || 0);
    console.log(`✅  Conectado — Cuenta: ${tt.accountNumber} | Net Liq: $${nlv.toFixed(2)}\n`);
    // Guardar snapshot de hoy al arrancar
    saveNlvSnapshot(todayStr(), nlv);
    // Programar guardado diario a las 4:35 PM ET
    scheduleDaily();
  } catch (e) {
    console.error(`⚠️   Auth falló: ${e.message}\n`);
  }
});

// ── Playbooks ────────────────────────────────────────────────
const PB_FILE = path.join(__dirname, 'playbooks.json');
function loadPlaybooks() {
  try { return JSON.parse(fs.readFileSync(PB_FILE,'utf8')); }
  catch(e) { return { playbooks:[] }; }
}
function savePlaybooks(data) { fs.writeFileSync(PB_FILE, JSON.stringify(data,null,2),'utf8'); }

app.get('/api/playbooks', (req, res) => res.json(loadPlaybooks()));

app.post('/api/playbooks', (req, res) => {
  const data = loadPlaybooks();
  const pb = req.body;
  pb.id = pb.id || `pb-${Date.now()}`;
  const idx = data.playbooks.findIndex(p=>p.id===pb.id);
  if (idx>=0) data.playbooks[idx]=pb; else data.playbooks.push(pb);
  savePlaybooks(data);
  res.json(pb);
});

app.delete('/api/playbooks/:id', (req, res) => {
  const data = loadPlaybooks();
  data.playbooks = data.playbooks.filter(p=>p.id!==req.params.id);
  savePlaybooks(data);
  res.json({ok:true});
});
app.post('/api/ai-chat', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'ANTHROPIC_API_KEY no configurada' });

    const { question, history = [], startDate = '2026-02-01', endDate = todayStr() } = req.body;

    // Obtener métricas del período + posiciones abiertas
    const [items, positions] = await Promise.all([
      tt.getAllTransactions(startDate, endDate),
      tt.getPositions(),
    ]);
    const { buildMetrics } = require('./src/metrics');
    const m = buildMetrics(items);
    const bal = await tt.getBalances();
    const nlv = parseFloat(bal?.['net-liquidating-value'] || 0);
    const nlvHistory = loadNlvHistory();
    const nlvByMonth = computeMonthlyNlv(nlvHistory, nlv);

    // Calcular P&L no realizado por posición
    const openPositions = positions
      .filter(p => p['instrument-type'] === 'Equity Option' || p['instrument-type'] === 'Equity')
      .map(p => {
        const op  = parseFloat(p['average-open-price'] || 0);
        const cp  = parseFloat(p['mark-price'] || p['average-daily-market-close-price'] || p['close-price'] || 0);
        const qty = parseFloat(p.quantity || 0);
        const mul = parseFloat(p.multiplier || 1);
        const dir = p['quantity-direction'] === 'Short' ? -1 : 1;
        const pnl = dir * (cp - op) * qty * mul;
        return {
          sym:    p['underlying-symbol'],
          tipo:   (p.symbol||'').match(/P\d{8}$/) ? 'Put' : (p.symbol||'').match(/C\d{8}$/) ? 'Call' : 'Stock',
          dir:    p['quantity-direction'],
          strike: p['strike-price'],
          expiry: (p['expires-at']||'').slice(0,10),
          qty,
          openPrice: op,
          currentPrice: cp,
          pnlNoReal: +pnl.toFixed(2),
        };
      });

    const context = `Eres un coach experto en trading de opciones. Tienes acceso a los datos reales del trader para el período ${startDate} al ${endDate}.

DATOS DEL PERÍODO:
- Net Liq actual: $${nlv.toFixed(2)}
- Capital inicial: $10,644
- Retorno total: ${(((nlv-10644)/10644)*100).toFixed(2)}%
- Total trades: ${m.totalStrategies}
- Win Rate: ${m.winRate}%
- Profit Factor: ${m.profitFactor}x
- P&L Realizado: $${m.totalPnL}
- Comisiones pagadas: $${m.totalComm}

P&L MENSUAL (Net Liq):
${Object.entries(nlvByMonth).sort().map(([mo,v])=>`- ${mo}: $${v.toFixed(2)}`).join('\n')}

POSICIONES ABIERTAS AHORA:
${openPositions.map(p=>`- ${p.sym} ${p.tipo} ${p.dir} Strike:${p.strike} Exp:${p.expiry} Qty:${p.qty} P&L No Real: $${p.pnlNoReal}`).join('\n')}

POR ESTRATEGIA:
${Object.entries(m.byStrategy||{}).slice(0,6).map(([t,d])=>`- ${t}: ${d.trades} trades, Win ${d.winRate}%, P&L $${d.pnl.toFixed(2)}`).join('\n')}

POR SUBYACENTE:
${Object.entries(m.byUnderlying||{}).sort((a,b)=>Math.abs(b[1].pnl)-Math.abs(a[1].pnl)).slice(0,6).map(([s,d])=>`- ${s}: ${d.trades} trades, P&L $${d.pnl.toFixed(2)}`).join('\n')}

HORARIO:
${Object.entries(m.byTimeSlot||{}).map(([sl,d])=>`- ${sl}: ${d.trades} trades, Win ${d.trades?((d.wins/d.trades)*100).toFixed(1):0}%, P&L $${d.pnl.toFixed(2)}`).join('\n')}

DURACIÓN:
${Object.entries(m.byDuration||{}).map(([dur,d])=>`- ${dur}: ${d.trades} trades, Win ${d.trades?((d.wins/d.trades)*100).toFixed(1):0}%, P&L $${d.pnl.toFixed(2)}`).join('\n')}

Responde en español, de forma concisa y directa. Usa bullet points cuando sea útil. Sé específico con números de los datos reales. Máximo 300 palabras.`;

    const messages = [
      ...history.slice(-8).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: question }
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        system: context,
        messages,
      }),
    });

    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const data = await response.json();
    const reply = data.content?.[0]?.text || 'Sin respuesta';
    res.json({ reply });

  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/ai-analysis', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'ANTHROPIC_API_KEY no configurada' });

    // Obtener datos frescos
    const [txData, overview, curveData] = await Promise.all([
      cached('transactions', 120, async () => {
        const { buildMetrics } = require('./src/metrics');
        const items = await tt.getAllTransactions('2026-02-01', todayStr());
        return { items, metrics: buildMetrics(items) };
      }),
      cached('overview', 60, async () => {
        const [balances, positions] = await Promise.all([tt.getBalances(), tt.getPositions()]);
        return { balances, positions };
      }),
      cached('curve', 300, async () => {
        const nlvHistory = loadNlvHistory();
        const bal = await tt.getBalances();
        const currentNlv = parseFloat(bal?.['net-liquidating-value'] || 0);
        return { nlvByMonth: computeMonthlyNlv(nlvHistory, currentNlv) };
      }),
    ]);

    const m   = txData.metrics;
    const nlv = parseFloat(overview.balances?.['net-liquidating-value'] || 0);
    const nlvByMonth = curveData.nlvByMonth || {};

    // Construir resumen para Claude
    const summary = {
      cuenta: { netLiq: nlv, capitalInicial: 10644, retornoTotal: +((nlv - 10644) / 10644 * 100).toFixed(2) },
      rendimiento: { winRate: m.winRate, profitFactor: m.profitFactor, totalTrades: m.totalStrategies, totalPnL: m.totalPnL, comisiones: m.totalComm },
      mensual: Object.entries(nlvByMonth).sort().map(([mo, pnl]) => ({ mes: mo, pnl: +pnl.toFixed(2) })),
      porEstrategia: Object.entries(m.byStrategy || {}).sort((a,b) => b[1].trades - a[1].trades).slice(0, 8).map(([tipo, d]) => ({ tipo, trades: d.trades, winRate: d.winRate, pnl: +d.pnl.toFixed(2), promGan: d.avgWin, promPer: d.avgLoss })),
      porSubyacente: Object.entries(m.byUnderlying || {}).sort((a,b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl)).slice(0, 8).map(([sym, d]) => ({ sym, trades: d.trades, pnl: +d.pnl.toFixed(2) })),
      horario: Object.entries(m.byTimeSlot || {}).map(([slot, d]) => ({ slot, trades: d.trades, winRate: d.trades ? +((d.wins/d.trades)*100).toFixed(1) : 0, pnl: +d.pnl.toFixed(2) })),
      duracion: Object.entries(m.byDuration || {}).map(([dur, d]) => ({ dur, trades: d.trades, winRate: d.trades ? +((d.wins/d.trades)*100).toFixed(1) : 0, pnl: +d.pnl.toFixed(2) })),
      posicionesAbiertas: overview.positions.filter(p => p['instrument-type'] === 'Equity Option').map(p => ({ sym: p['underlying-symbol'], tipo: (p.symbol||'').match(/P\d{8}$/) ? 'Put' : 'Call', dir: p['quantity-direction'], strike: p['strike-price'], expiry: (p['expires-at']||'').slice(0,10), qty: p.quantity })),
    };

    const prompt = `Eres un coach experto en trading de opciones. Analiza estos datos reales de un trader y da recomendaciones específicas y accionables en español.

DATOS DEL TRADER:
${JSON.stringify(summary, null, 2)}

Responde SOLO en JSON con esta estructura exacta (sin markdown, sin texto extra):
{
  "diagnostico": "2-3 frases resumiendo la situación actual del trader",
  "patrones": [
    {"titulo": "...", "detalle": "...", "impacto": "positivo|negativo|neutral"},
    {"titulo": "...", "detalle": "...", "impacto": "positivo|negativo|neutral"},
    {"titulo": "...", "detalle": "...", "impacto": "positivo|negativo|neutral"}
  ],
  "recomendaciones": [
    {"prioridad": "alta|media|baja", "titulo": "...", "accion": "...", "razon": "..."},
    {"prioridad": "alta|media|baja", "titulo": "...", "accion": "...", "razon": "..."},
    {"prioridad": "alta|media|baja", "titulo": "...", "accion": "...", "razon": "..."},
    {"prioridad": "alta|media|baja", "titulo": "...", "accion": "...", "razon": "..."}
  ],
  "riesgos": [
    {"titulo": "...", "detalle": "..."},
    {"titulo": "...", "detalle": "..."}
  ],
  "metaProximos30dias": "Una meta específica y medible para los próximos 30 días"
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: `Claude API error: ${err.slice(0, 200)}` });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const analysis = JSON.parse(clean);
    res.json({ analysis, generatedAt: new Date().toISOString() });

  } catch(e) { res.status(500).json({ error: e.message }); }
});
