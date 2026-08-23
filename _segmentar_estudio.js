'use strict';
// Segmenta el estudio de Max Pain para ver DONDE funciona la imantacion y donde no.
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('_estudio_completo.json', 'utf8'));

// Deduplicar cuando un subyacente trae dos raices el mismo dia (SPX/SPXW, NDX/NDXP).
//
// NO se elige por open interest. Las opciones de indice AM-settled LIQUIDAN CON LA
// APERTURA del dia de vencimiento: su Max Pain describe donde deberia abrir, no donde
// deberia cerrar. Compararlas contra el cierre de las 16:00 es un error de medicion
// -- y era el que tenia este script: para SPX se quedaba con la mensual AM (2,47 M de
// OI, Max Pain 7425, ya liquidada a las 09:30) en vez de la SPXW PM (748 K, Max Pain
// 7670), que es la que de verdad vencia al cierre. Se prefiere SIEMPRE la PM.
const porSym = new Map();
for (const o of d) {
  const prev = porSym.get(o.sym);
  if (!prev) { porSym.set(o.sym, o); continue; }
  const oPM = o.settle === 'PM', pPM = prev.settle === 'PM';
  if (oPM && !pPM) porSym.set(o.sym, o);              // la PM manda
  else if (oPM === pPM && o.oi > prev.oi) porSym.set(o.sym, o);   // a igual tipo, mas OI
}
const U = [...porSym.values()].filter(o => o.settle === 'PM');
const descartadasAM = [...porSym.values()].filter(o => o.settle !== 'PM');
if (descartadasAM.length) console.log('descartadas por ser AM-settled (liquidan en la apertura): ' +
  descartadasAM.map(o => o.sym + '/' + o.root).join(', ') + '\n');

const INDICES = new Set(['SPX','SPY','QQQ','NDX','IWM','DIA','RUT','VIX','GLD','SLV','TLT','HYG','XLF','XLE','XLK','EEM','FXI','ARKK','IBIT']);

function stats(nombre, arr) {
  if (!arr.length) return null;
  const n = arr.length;
  const conv = arr.filter(o => o.convergio).length;
  const abs = arr.map(o => Math.abs(o.distCierrePct)).sort((a,b)=>a-b);
  const med = abs[Math.floor(n/2)];
  const d1 = arr.filter(o => Math.abs(o.distCierrePct) <= 1).length;
  const d2 = arr.filter(o => Math.abs(o.distCierrePct) <= 2).length;
  const acerc = arr.reduce((a,o)=>a+o.acercamientoPct,0)/n;
  const r = { nombre, n, convPct: conv/n*100, med, d1Pct: d1/n*100, d2Pct: d2/n*100, acerc };
  console.log(`${nombre.padEnd(34)} n=${String(n).padStart(3)}  converge ${r.convPct.toFixed(1).padStart(5)}%  ` +
              `|dist| med ${r.med.toFixed(2).padStart(6)}%  <=1% ${r.d1Pct.toFixed(1).padStart(5)}%  ` +
              `<=2% ${r.d2Pct.toFixed(1).padStart(5)}%  acerc ${r.acerc.toFixed(2).padStart(6)}pp`);
  return r;
}

console.log(`universo deduplicado: ${U.length} subyacentes\n`);
console.log('=== GLOBAL ===');
const g = stats('TODOS', U);

console.log('\n=== POR TIPO ===');
const idx = U.filter(o => INDICES.has(o.sym));
const acc = U.filter(o => !INDICES.has(o.sym));
const sIdx = stats('Indices y ETF', idx);
const sAcc = stats('Acciones individuales', acc);

console.log('\n=== POR OPEN INTEREST (cuartiles) ===');
const porOI = [...U].sort((a,b) => b.oi - a.oi);
const q = Math.ceil(U.length/4);
const cuartiles = [];
for (let i = 0; i < 4; i++) {
  const arr = porOI.slice(i*q, (i+1)*q);
  if (arr.length) cuartiles.push(stats(`Q${i+1} OI (${arr[0].oi.toLocaleString()} - ${arr[arr.length-1].oi.toLocaleString()})`, arr));
}

console.log('\n=== POR ANCHO DEL PISO PLANO (que tan definido esta el minimo) ===');
const conPiso = U.filter(o => o.pisoAnchoPct != null).sort((a,b) => a.pisoAnchoPct - b.pisoAnchoPct);
const mitad = Math.ceil(conPiso.length/2);
const sPisoEstrecho = stats('Piso ESTRECHO (min. definido)', conPiso.slice(0, mitad));
const sPisoAncho    = stats('Piso ANCHO (min. difuso)', conPiso.slice(mitad));

console.log('\n=== POR MAGNITUD DEL MOVIMIENTO DEL DIA ===');
const tranquilos = U.filter(o => Math.abs(o.varDiaPct) <= 1);
const movidos    = U.filter(o => Math.abs(o.varDiaPct) > 1);
stats('Movio <=1% en el dia', tranquilos);
stats('Movio >1% en el dia', movidos);

fs.writeFileSync('_segmentos.json', JSON.stringify({
  global: g, indices: sIdx, acciones: sAcc, cuartilesOI: cuartiles,
  pisoEstrecho: sPisoEstrecho, pisoAncho: sPisoAncho,
  universo: U.length,
}, null, 2));
fs.writeFileSync('_universo_dedup.json', JSON.stringify(U, null, 2));
