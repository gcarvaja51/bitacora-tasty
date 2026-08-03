import { findMonacoTarget, getSource, setSource, getErrors } from './pine_edit.js';
import { writeFileSync } from 'fs';

const { client, targetId } = await findMonacoTarget();
console.log('target:', targetId);

const src = await getSource(client);

const OLD = 'indicator("CIARG_V1 — Combined Indicator with MACD Slope + Weinstein 15m", shorttitle="CIARG_V1", overlay=true, format=format.price, precision=2)';
const NEW = 'indicator("CIARG_V3 — Combined Indicator with MACD Slope + Weinstein 15m", shorttitle="CIARG_V3", overlay=true, format=format.price, precision=2)';

if (!src.includes(OLD)) {
  console.log('NO SE ENCONTRO la linea esperada -- abortando sin tocar nada.');
  writeFileSync('rename_v3_source_dump.txt', src, 'utf8');
  console.log('Fuente actual volcada en rename_v3_source_dump.txt para revisar a mano.');
  await client.close();
  process.exit(1);
}

const newSrc = src.replace(OLD, NEW);
await setSource(client, newSrc);
console.log('titulo actualizado a CIARG_V3, esperando compile...');
await new Promise((r) => setTimeout(r, 2500));

const errors = await getErrors(client);
console.log('errores:', JSON.stringify(errors));

await client.close();
process.exit(0);
