// Restaura SPX en Sigma Terminal. La captura del 25-ago murio a mitad del
// recorrido y dejo el terminal en ADBE; el daemon exige SPX y por eso lleva
// horas fallando con "Sigma Terminal no esta en SPX".
import * as sigma from './sigma.js';

const p = await sigma.ensurePage();
const antes = await sigma.readSymbol(p);
console.log('  simbolo antes :', antes);

if (String(antes).toUpperCase() === 'SPX') {
  console.log('  ya estaba en SPX, no se toca.');
} else {
  await sigma.seleccionarSimbolo(p, 'SPX');
  const despues = await sigma.readSymbol(p);
  console.log('  simbolo ahora :', despues);
}

const lv = await sigma.readLevels().catch(e => ({ error: e.message }));
console.log('  lectura de prueba:', JSON.stringify(lv.error ? lv : {
  spx: lv.spxPrice, regime: lv.regime, call: lv.callWall, put: lv.putWall, flip: lv.gammaFlip
}));
await sigma.close();
process.exit(0);
