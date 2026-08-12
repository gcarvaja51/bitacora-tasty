// Devuelve, por stdout y en JSON, el bloque "chart" listo para meter en una
// seccion del spec de render_informe.py.
//
// Uso:  node velas_trade.mjs <executionId>
//       node velas_trade.mjs <executionId> --minutos 2
//
// Nace del pedido del usuario (2026-08-10): "necesito validar el momento de
// entrada y el momento de salida... hay algo que no me cuadra". Sin ver donde
// cayeron entrada y salida sobre el precio real, el informe no permitia auditar
// el timing — que es justo donde estaban los problemas.
//
// Las velas salen de Sigma (I:SPX via su proxy de Polygon), la misma fuente con
// la que el sistema decide. Usar Yahoo aca mostraria un grafico distinto del que
// vio el algoritmo, que es exactamente la confusion que esto viene a evitar.
import * as sigma from 'file:///C:/Users/gcarv/bitacora-tasty/gamma_daemon/sigma.js';

const P = 'https://web-production-23473.up.railway.app';
const execId = process.argv[2];
const minutos = parseInt((process.argv.find(a => a.startsWith('--minutos=')) || '--minutos=2').split('=')[1], 10) || 2;
if (!execId) { console.error('falta el executionId'); process.exit(1); }

const j = await (await fetch(P + '/api/tradier/executions')).json();
const t = (j.executions || []).find(e => e.id === execId || e.orderId == execId);
if (!t) { console.error('no encontre la ejecucion ' + execId); process.exit(1); }

const tEnt = new Date(t.filledAt || t.timestamp).getTime();
const tSal = t.closedAt ? new Date(t.closedAt).getTime() : null;

await sigma.ensurePage();
await new Promise(r => setTimeout(r, 9000));
const pedir = async () => sigma.readCandles5m({ velas: 4000, diasAtras: 6, minutos });
let velas = await pedir();
if (!velas) { await new Promise(r => setTimeout(r, 8000)); velas = await pedir(); }
if (!velas) { console.error('sin velas de Sigma'); process.exit(1); }

const dia  = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const hhmm = ts => new Date(ts).toLocaleTimeString('es', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
const delDia = velas.filter(v => dia(v.t) === dia(tEnt));

const paso = minutos * 60000;
const iE = delDia.findIndex(v => v.t + paso > tEnt);
const iS = tSal ? delDia.findIndex(v => v.t + paso > tSal) : -1;
if (iE < 0) { console.error('la entrada cae fuera de las velas del dia'); process.exit(1); }

// Contexto: 10 velas antes de entrar y 10 despues de salir. Suficiente para ver
// de donde venia el precio y hacia donde siguio, sin comprimir el trade.
const desde = Math.max(0, iE - 10);
const hasta = Math.min(delDia.length, (iS < 0 ? iE : iS) + 11);
const vis = delDia.slice(desde, hasta);

const precioEn = ts => { const v = delDia.filter(x => x.t <= ts).pop(); return v ? v.c : null; };
const pEnt = t.entrySpx ?? precioEn(tEnt);
const pSal = tSal ? precioEn(tSal) : null;
const alcista = t.direction === 'BULLISH';
const mov = (pEnt != null && pSal != null) ? pSal - pEnt : null;
const aFavor = mov == null ? null : (alcista ? mov : -mov);

const nota = (pEnt == null || pSal == null) ? '' :
  `Entra ${pEnt.toFixed(2)} a las ${hhmm(tEnt)}. Sale ${pSal.toFixed(2)} a las ${hhmm(tSal)}. `
  + `El SPX se movio ${mov >= 0 ? '+' : ''}${mov.toFixed(2)} pts, `
  + `${aFavor >= 0 ? 'A FAVOR' : 'EN CONTRA'} de la posicion. Velas de ${minutos} min (I:SPX, Sigma).`;

console.log(JSON.stringify({
  candles: vis.map(v => ({ t: v.t, o: v.o, h: v.h, l: v.l, c: v.c, hora: hhmm(v.t) })),
  entry: { t: tEnt, price: pEnt, label: alcista ? 'BUY' : 'SELL' },
  ...(pSal != null ? { exit: { t: tSal, price: pSal } } : {}),
  gano: (t.pnl ?? 0) >= 0,
  nota,
}, null, 2));
process.exit(0);
