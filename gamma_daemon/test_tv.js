import * as tv from './tv.js';

console.log('--- healthCheck ---');
const health = await tv.healthCheck().catch((e) => ({ error: e.message }));
console.log(JSON.stringify(health, null, 2));

console.log('--- pushGammaLevels (valores de prueba) ---');
const push = await tv.pushGammaLevels({
  in_21: 9999, // call wall (valor de prueba, facil de reconocer/revertir)
}).catch((e) => ({ error: e.message }));
console.log(JSON.stringify(push, null, 2));

process.exit(0);
