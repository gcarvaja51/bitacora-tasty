// Crea la clave IRONBALLS_TOKEN: la guarda en ironballs/.env (no versionado) y la
// pone en Railway (servicio de la Bitacora, entorno production). Lo corre Guillermo:
//   node ironballs/crear_token.js
// Si ya existe ironballs/.env con clave, la reutiliza (no rota la de Railway sin querer).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ENV = path.join(__dirname, '.env');
let tok = null;
try { tok = (fs.readFileSync(ENV, 'utf8').match(/^IRONBALLS_TOKEN=(\S+)/m) || [])[1] || null; } catch (e) {}
if (!tok) {
  tok = require('crypto').randomBytes(24).toString('hex');
  fs.writeFileSync(ENV, `IRONBALLS_TOKEN=${tok}\nIRONBALLS_URL=https://web-production-23473.up.railway.app\n`, 'utf8');
  console.log('ironballs/.env creado');
} else {
  console.log('ironballs/.env ya tenia clave: se reutiliza');
}
execFileSync('railway', ['variables', '--set', `IRONBALLS_TOKEN=${tok}`],
  { cwd: path.join(__dirname, '..'), stdio: 'inherit', shell: true });
console.log('IRONBALLS_TOKEN puesto en Railway (reinicia el servicio una vez).');
