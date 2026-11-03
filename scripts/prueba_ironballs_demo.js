// Prueba de src/ironballs_demo.js con un TastyTrade FALSO (sin red). La corre scripts/pruebas.js.
// Imprime una linea JSON con los resultados y sale con 0.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { crearIronBallsDemo } = require('../src/ironballs_demo');
const ib = require('../src/ironballs');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibdemo-'));
  const llamadas = [];
  let precios = { 'SPXW  261102C07635000': [4.6, 4.8], 'SPXW  261102C07645000': [2.4, 2.6] };   // short / long
  const tt = {
    accountNumber: 'TEST',
    async _req(ruta, opt = {}) {
      llamadas.push(`${opt.method || 'GET'} ${ruta.split('?')[0]}`);
      if (ruta.startsWith('/market-data')) {
        const syms = [...ruta.matchAll(/symbols\[\]=([^&]+)/g)].map((m) => decodeURIComponent(m[1]));
        return { data: { items: syms.map((s) => s === 'SPX' ? { symbol: 'SPX', last: 7610 }
          : { symbol: s, bid: precios[s][0], ask: precios[s][1] }) } };
      }
      if (ruta.endsWith('/orders/dry-run')) return { data: { 'fee-calculation': { 'total-fees': '1.72' }, warnings: [] } };
      throw new Error('ruta no permitida en la prueba: ' + ruta);
    },
  };
  const avisos = [];
  const demo = crearIronBallsDemo({ tt, dataDir: dir, horaETmin: () => 600, avisar: (t, ti) => avisos.push(ti) });
  const alerta = ib.parsearAlerta(`🔔 *Options Alert — Sigma Trade*
📌 *SPX — Bear Call Spread*
🔴 Sell 1× Call 7635 (Nov 2, 2026) @ $4.70
🟢 Buy 1× Call 7645 (Nov 2, 2026) @ $2.50
💰 *Net Credit:* $220.00
⏳ *DTE:* 0`);
  const a = await demo.abrir(alerta, { alertId: 't1', edadMin: 0.5 });
  const dup = await demo.abrir(alerta, { alertId: 't2' });
  precios = { 'SPXW  261102C07635000': [1.9, 2.1], 'SPXW  261102C07645000': [0.9, 1.1] };
  const c = await demo.cerrar({ clave: alerta.clave, pipe: { pct: 56.36, resultadoDolares: 124 } });
  const otra = await demo.cerrar({ clave: alerta.clave });
  const r = demo.resumen();
  console.log(JSON.stringify({
    abrio: a.ok && a.estado === 'DEMO_ABIERTA',
    precioEntrada: a.registro?.precioEntrada,          // medio 2.20 - 0.05 = 2.15 (natural 2.00)
    riesgo: a.registro?.riesgoMaxUsd,                  // (10 - 2.15) * 100 = 785
    duplicada: dup.estado,
    cerro: c.ok && c.estado === 'DEMO_CERRADA',
    precioSalida: c.registro?.precioSalida,            // medio 1.00 + 0.05 = 1.05 (natural 1.20)
    pnlBruto: c.registro?.pnlBrutoUsd,                 // (2.15 - 1.05) * 100 = 110
    pnlNeto: c.registro?.pnlUsd,                       // 110 - 1.72 - 1.72 = 106.56
    segundoCierre: otra.estado,
    saldo: r.saldo,
    avisos: avisos.length,
    soloDryRun: llamadas.filter((x) => /\/orders/.test(x)).every((x) => /\/orders\/dry-run$/.test(x)),
  }));
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.log(JSON.stringify({ error: e.message })); });
