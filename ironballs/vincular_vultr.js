// Vincula las lineas de WhatsApp (usa / colombia) al GOWA de Vultr escaneando el QR desde el PC.
// Uso: node ironballs/vincular_vultr.js   → abre http://127.0.0.1:3010 (tunel SSH a 64.176.24.14:3001)
// El QR dura 30 s: la pagina pide uno nuevo cada 25 s y muestra el estado de cada dispositivo.
const { spawn, execSync } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');

const LLAVE = path.join(os.homedir(), '.ssh', 'oracle_bot');
const VULTR = 'ubuntu@64.176.24.14';
const PUERTO_TUNEL = 3002;
const auth = 'Basic ' + Buffer.from('ib:' + execSync(`ssh -i "${LLAVE}" ${VULTR} "grep -o 'basic-auth=ib:[^ ]*' /etc/systemd/system/gowa.service | cut -d: -f2"`).toString().trim()).toString('base64');
const tunel = spawn('ssh', ['-i', LLAVE, '-N', '-L', `${PUERTO_TUNEL}:127.0.0.1:3001`, VULTR], { stdio: 'ignore' });
process.on('exit', () => tunel.kill());
process.on('SIGINT', () => process.exit(0));

const gowa = (ruta, dev) => fetch(`http://127.0.0.1:${PUERTO_TUNEL}${ruta}`, { headers: { Authorization: auth, ...(dev ? { 'X-Device-Id': dev } : {}) } });

const HTML = `<!doctype html><meta charset="utf-8"><title>Vincular WhatsApp a Vultr</title>
<style>body{font-family:Arial;background:#111;color:#eee;text-align:center}img{width:300px;height:300px;background:#fff;margin:8px}
.c{display:inline-block;margin:20px;padding:16px;border:1px solid #444;border-radius:12px}b{font-size:20px}</style>
<h2>Vincular WhatsApp al servidor de Vultr</h2>
<p>En cada teléfono: WhatsApp → Dispositivos vinculados → Vincular un dispositivo → escanear.</p>
<div class="c"><b>Línea USA (+1 770…)</b><br><img id="usa"><div id="eusa"></div></div>
<div class="c"><b>Línea COLOMBIA (+57 318…)</b><br><img id="colombia"><div id="ecolombia"></div></div>
<script>
async function tick(){const e=await (await fetch('/estado')).json();
 for(const d of ['usa','colombia']){const st=(e[d]||'?');document.getElementById('e'+d).textContent='Estado: '+st;
  if(st!=='logged_in') document.getElementById(d).src='/qr?dev='+d+'&t='+Date.now();
  else document.getElementById(d).src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><text x="40" y="160" font-size="40" fill="green">VINCULADA ✓</text></svg>');}}
tick();setInterval(tick,25000);
</script>`;

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/estado') {
      const j = await (await gowa('/devices')).json();
      const out = {};
      for (const d of j.results || []) out[d.id] = d.state;
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(out));
    }
    if (u.pathname === '/qr') {
      const dev = u.searchParams.get('dev');
      const j = await (await gowa('/app/login', dev)).json();
      const link = j?.results?.qr_link;
      if (!link) { res.statusCode = 500; return res.end(JSON.stringify(j)); }
      const img = await gowa(new URL(link).pathname, dev);
      res.setHeader('Content-Type', 'image/png'); return res.end(Buffer.from(await img.arrayBuffer()));
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(HTML);
  } catch (e) { res.statusCode = 500; res.end(e.message); }
}).listen(3010, '127.0.0.1', () => console.log('Abre http://127.0.0.1:3010  (Ctrl+C para cerrar)'));
