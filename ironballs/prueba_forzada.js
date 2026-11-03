// Prueba forzada de punta a punta de la demo de Iron Balls en TastyTrade (2026-11-03).
// Manda al servidor una alerta FALSA con forma de "Options Alert" de Pipe, marcada prueba:true (no cuenta en el
// saldo, nunca va a Tradier), y despues su "⚠️ CLOSED". Cada paso dispara un ntfy.
//
//   node ironballs/prueba_forzada.js abrir <spot>          # Bear Call 0DTE: corta = spot redondeado +15, larga +10
//   node ironballs/prueba_forzada.js cerrar <corta> <larga>
//
// Necesita ironballs/.env (IRONBALLS_TOKEN). Solo en horario de la ventana (9:31-15:15 ET).
const fs = require('fs');
const path = require('path');

const env = {};
for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2];
}
const URL = (env.IRONBALLS_URL || 'https://web-production-23473.up.railway.app') + '/api/ironballs/alerta';
const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const [y, mo, d] = hoy.split('-').map(Number);
const MES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][mo - 1];
const MES_L = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][mo - 1];

async function mandar(texto) {
  const r = await fetch(URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ironballs-token': env.IRONBALLS_TOKEN },
    body: JSON.stringify({ alertId: `PRUEBA-${Date.now()}`, mensajeAt: new Date().toISOString(), texto, prueba: true }),
  });
  console.log(r.status, JSON.stringify(await r.json(), null, 2));
}

(async () => {
  const [accion, a, b] = process.argv.slice(2);
  if (accion === 'abrir') {
    const spot = Number(a);
    if (!(spot > 1000)) throw new Error('falta el spot del SPX: node ironballs/prueba_forzada.js abrir 7610');
    const corta = Math.ceil(spot / 5) * 5 + 15, larga = corta + 10;
    console.log(`PRUEBA: Bear Call ${corta}/${larga} vence ${hoy}`);
    await mandar(`🔔 *Options Alert — Sigma Trade*\n\n📌 *SPX — Bear Call Spread*\n\n──────────\n`
      + `🔴 Sell 1× Call ${corta} (${MES} ${d}, ${y}) @ $1.00\n🟢 Buy 1× Call ${larga} (${MES} ${d}, ${y}) @ $0.50\n\n`
      + `💰 *Net Credit:* $50.00\n\n⏳ *DTE:* 0\n\n🏷️ *Current price of SPX:* $${spot}`);
  } else if (accion === 'cerrar') {
    await mandar(`⚠️ CLOSED\n(Shared on ${MES} ${d})\n\n✅ SPX ${MES_L} ${d} ${a}/${b} Bear Call Spread @ 50.00%\n\nProfit of $25 per position`);
  } else {
    console.log('uso: abrir <spot> | cerrar <corta> <larga>');
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
