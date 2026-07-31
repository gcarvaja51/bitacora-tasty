import * as sigma from './sigma.js';

const levels = await sigma.readLevels().catch((e) => ({ error: e.message }));
console.log(JSON.stringify(levels, null, 2));

await sigma.close();
process.exit(0);
