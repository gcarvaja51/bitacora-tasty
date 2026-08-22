#!/usr/bin/env node
'use strict';

// Simulacro de frenos — probar que el freno frena.
//
//   node scripts/simulacro_frenos.js
//
// Por que existe: hasta hoy el circuito diario estaba configurado y nunca se
// habia disparado ni una vez. Decir que estaba "verificado" habria sido peor
// que no revisarlo, porque un freno que nadie probo es un freno que no existe
// — y se toman decisiones creyendo que hay una proteccion puesta.
//
// Esto no espera a perder 3.5% en un dia real. Le mete al freno situaciones
// construidas y comprueba que hace lo que dice, incluidos los bordes, que es
// donde los frenos suelen fallar.
//
// Ademas corre el caso REAL de los ultimos dias con las DOS reglas del dinero,
// para medir cuanto se corre el disparo por usar una o la otra.

const { evaluarCircuitoDiario, frenosDeclarados } = require('../src/frenos');

const PROD = 'https://web-production-23473.up.railway.app';
const CAPITAL = 100000;      // equity tipico de la cuenta sandbox
const LIMITE = 3.5;          // % de drawdown diario
const HOY = '2026-08-22';

let fallos = 0, corridos = 0;

function trade(pnlBruto, { conLibro = true, familia = 'REVERSION', fecha = HOY } = {}) {
  const e = {
    id: `sim-${Math.abs(pnlBruto)}-${Math.random().toString(36).slice(2, 7)}`,
    strategyFamily: familia, status: 'closed', closedAt: `${fecha}T18:00:00.000Z`,
    pnl: pnlBruto,
  };
  if (conLibro) e.paperPnl = { bruto: pnlBruto, neto: pnlBruto - 4.2, confiable: true };
  else e.pnlSource = 'ordenes_reales';
  return e;
}

function caso(nombre, ejecuciones, esperado, opts = {}) {
  corridos++;
  const r = evaluarCircuitoDiario(ejecuciones, {
    familia: 'REVERSION', fecha: HOY, capital: CAPITAL, maxDrawdownPct: LIMITE, ...opts,
  });
  const ok = r.bloquea === esperado;
  if (!ok) fallos++;
  const marca = ok ? '  OK  ' : ' FALLA';
  console.log(`[${marca}] ${nombre}`);
  console.log(`         pnl ${r.pnlHoy} · drawdown ${r.drawdownPct}% · limite -${r.limitePct}%` +
              ` · bloquea=${r.bloquea} (esperado ${esperado}) · fuente ${r.fuente}`);
  return r;
}

console.log('='.repeat(74));
console.log(` SIMULACRO DE FRENOS — capital $${CAPITAL.toLocaleString('en-US')}, limite ${LIMITE}%`);
console.log(` El umbral en dolares es $${(CAPITAL * LIMITE / 100).toLocaleString('en-US')}`);
console.log('='.repeat(74));
console.log();

console.log('--- 1. El circuito diario, en sus bordes ---');
caso('dia sin trades', [], false);
caso('dia ganador', [trade(300), trade(150)], false);
caso('perdida chica (-1%)', [trade(-1000)], false);
caso('justo por encima del limite (-3.49%)', [trade(-3490)], false);
// El borde exacto: la condicion es <= -limite, asi que -3.5% DEBE frenar. Si
// alguien la cambia a < por accidente, este caso lo caza.
caso('EXACTO en el limite (-3.50%)', [trade(-3500)], true);
caso('pasado el limite (-4%)', [trade(-4000)], true);
caso('varios trades que suman el limite', [trade(-1200), trade(-1200), trade(-1200)], true);
caso('perdidas grandes compensadas por ganancias', [trade(-4000), trade(1000)], false);

console.log();
console.log('--- 2. Lo que NO debe contar ---');
const fantasma = { id: 'sim-fantasma', strategyFamily: 'REVERSION', status: 'closed',
                   closedAt: `${HOY}T18:00:00.000Z`, pnl: 0,
                   pnlSource: 'sandbox_orden_fantasma', closeReason: 'SANDBOX_GLITCH_SIN_POSICION' };
caso('orden fantasma del sandbox no consume riesgo', [trade(-3400), fantasma], false);
caso('trades de OTRA familia no frenan a Reversion',
     [trade(-5000, { familia: 'TENDENCIA' })], false);
caso('trades de OTRO dia no cuentan',
     [trade(-5000, { fecha: '2026-08-21' })], false);

console.log();
console.log('--- 3. Capital: el mismo dolar duele distinto ---');
caso('-$3500 con capital de 100k (=3.5%)', [trade(-3500)], true);
caso('-$3500 con capital de 200k (=1.75%)', [trade(-3500)], false, { capital: 200000 });
// Sin capital no se puede calcular un porcentaje. Se frena por precaucion — es
// la falla segura — pero con un motivo propio, no disfrazado de drawdown.
const sinCap = caso('sin capital: frena por precaucion, no por perdida', [trade(-3500)], true, { capital: 0 });
if (sinCap.fuente !== 'sin_capital') { console.log('         FALLA: deberia decir fuente=sin_capital'); fallos++; }
else console.log(`         motivo: ${sinCap.motivo}`);

console.log();
console.log('--- 4. La regla del dinero mueve el disparo ---');
console.log('    Mismo dia, medido de las dos formas. Es el punto de todo esto:');
console.log('    el broker deja los resultados mas cerca de cero, asi que subestima');
console.log('    la perdida y el freno dispara mas tarde de lo que deberia.');
console.log();
// Un dia como los reales: la cadena real reporta mas perdida que el broker.
const diaReal = [
  { id: 's1', strategyFamily: 'REVERSION', status: 'closed', closedAt: `${HOY}T14:00:00Z`,
    pnl: -1200, paperPnl: { bruto: -1600, confiable: true } },
  { id: 's2', strategyFamily: 'REVERSION', status: 'closed', closedAt: `${HOY}T15:00:00Z`,
    pnl: -1100, paperPnl: { bruto: -1500, confiable: true } },
  { id: 's3', strategyFamily: 'REVERSION', status: 'closed', closedAt: `${HOY}T16:00:00Z`,
    pnl: -900, paperPnl: { bruto: -1300, confiable: true } },
];
const conCadena = caso('medido contra la cadena real', diaReal, true);
const soloBroker = diaReal.map(e => ({ ...e, paperPnl: undefined, pnlSource: 'ordenes_reales' }));
const conBroker = caso('el MISMO dia medido con el broker', soloBroker, false);
console.log();
console.log(`         diferencia: $${(conCadena.pnlHoy - conBroker.pnlHoy).toFixed(2)} ` +
            `(${(conCadena.drawdownPct - conBroker.drawdownPct).toFixed(2)} puntos de drawdown)`);
console.log('         Con la regla vieja el robot habria SEGUIDO OPERANDO ese dia.');

console.log();
console.log('--- 5. Los frenos que la config declara ---');
(async () => {
  let cfgRev = {};
  try {
    const r = await fetch(`${PROD}/api/spx/config`);
    const d = await r.json();
    cfgRev = ((d.config || d).trading || {}).smaReversion || {};
  } catch (e) {
    console.log('    (no se pudo leer produccion, se usan los valores por defecto)');
  }
  for (const f of frenosDeclarados(cfgRev)) {
    const marca = f.activo ? '  ACTIVO   ' : ' DECORATIVO';
    console.log(`[${marca}] ${f.clave} = ${JSON.stringify(f.valor)}`);
    if (f.nota) console.log(`             ${f.nota}`);
    if (f.donde) console.log(`             ${f.donde}`);
  }

  console.log();
  console.log('='.repeat(74));
  console.log(` ${corridos - fallos} de ${corridos} casos pasaron` +
              (fallos ? ` — ${fallos} FALLARON` : ' — el circuito diario frena cuando debe'));
  console.log('='.repeat(74));
  process.exit(fallos ? 1 : 0);
})();
