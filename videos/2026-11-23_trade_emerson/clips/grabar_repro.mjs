// Clip de la REPRODUCCIÓN de la hoja Hiro (bitácora en producción) en el tramo del trade del 23-nov.
// Pedido de Guillermo (23-nov): "escoge tú la velocidad, que se vea bien el movimiento y sea didáctico".
// Elegido: velas de 2 min a 1x (1 vela por segundo), de 11:08 a 11:44 → ~19 s. Se avanza VELA POR VELA con irA()
// (la grabación en vivo de la pestaña colgaba el render) y se captura cada paso; ffmpeg arma el video a 1 vela/s.
// Uso: node grabar_repro.mjs   → cuadros/*.png y clip_trade_23nov.mp4
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire('C:/Users/gcarv/bitacora-tasty/gamma_daemon/package.json');
const puppeteer = require('puppeteer');
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const m = (hm) => +hm.slice(0, 2) * 60 + +hm.slice(3, 5);
const VERT = process.argv.includes('--vertical');   // para el reel (9:16)
const DESDE = VERT ? '11:14' : '11:08', HASTA = VERT ? '11:42' : '11:44', TF = 2, VER = VERT ? ['10:56', '11:50'] : ['10:40', '11:56'];
const CU = path.join(AQUI, VERT ? 'cuadros_v' : 'cuadros'); fs.rmSync(CU, { recursive: true, force: true }); fs.mkdirSync(CU);

const b = await puppeteer.launch({ headless: 'new', userDataDir: path.join(AQUI, 'perfil'), defaultViewport: VERT ? { width: 760, height: 1000, deviceScaleFactor: 1.42 } : { width: 1280, height: 860, deviceScaleFactor: 1.5 } });
const p = (await b.pages())[0];
await p.goto('https://web-production-23473.up.railway.app/hiro.html?fecha=2026-11-23', { waitUntil: 'networkidle2', timeout: 90000 });
await new Promise((r) => setTimeout(r, 6000));
await p.evaluate((TF) => {
  est.sigma.on = false; est.gbs.on = false; est.trad.on = false; est.flow.on = false; est.conf.on = false; est.kgs.on = false;
  est.gbc.on = true; est.gbc.hist = false; est.gbc.flip = true;   // sin histograma: el de la mañana es de 9:35 (las lecturas reconstruidas no traen barras)
  est.bola8.on = true; est.bola8.curva = true; est.bola8.obj = true; est.bola8.rec = true;
  est.hiro.on = true; est.hiro.sel = 'ambos'; est.hiro.real = true; est.hiro.propio = false; est.hiro.invertir = false;
  tf = TF; armarBarra(); aplicarTf(); modoRepro(true);
}, TF);
let n = 0;
for (let t = m(DESDE); t <= m(HASTA); t += TF) {
  await p.evaluate((t, VER) => { irA(t); gM.timeScale().setVisibleRange({ from: ts(fecha, VER[0]), to: ts(fecha, VER[1]) }); }, t, VER);
  await new Promise((r) => setTimeout(r, 900));
  await p.screenshot({ path: path.join(CU, `${String(n++).padStart(3, '0')}.png`) });
}
await b.close();
if (VERT) { console.log('cuadros', n, '→', CU); process.exit(0); }
// 1 vela por segundo (1x) + 1,5 s de pausa al final
const out = path.join(AQUI, 'clip_trade_23nov.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', path.join(CU, '%03d.png'), '-vf', 'tpad=stop_mode=clone:stop_duration=1.5,fps=24,scale=1920:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', out]);
console.log('cuadros', n, '→', out);
