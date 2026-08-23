// Corrida manual unica: replica runCycle() de index.js pero sin el guard de horario,
// para demostrar el pipeline completo funcionando fuera de mercado. No se deja como
// parte del daemon real -- es solo para verificacion en vivo.
import * as sigma from './sigma.js';
import * as tv from './tv.js';

const levels = await sigma.readLevels();
console.log('--- Sigma Terminal ---');
console.log(JSON.stringify(levels, null, 2));

const tvInputs = {
  in_20: true,
  in_21: levels.callWall,
  in_22: levels.putWall,
  in_23: levels.gammaFlip,
  in_24: levels.mvs,
  in_31: levels.maxPain ?? 0,
};
const tvResult = await tv.pushGammaLevels(tvInputs);
console.log('--- TradingView (valores reales) ---');
console.log(JSON.stringify(tvResult, null, 2));

const resp = await fetch('https://web-production-23473.up.railway.app/api/spx/sigma-levels', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(levels),
});
console.log('--- POST /api/spx/sigma-levels ---');
console.log(JSON.stringify(await resp.json(), null, 2));

await sigma.close();
process.exit(0);
