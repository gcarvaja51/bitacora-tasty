# Reel vertical 1080x1920 del trade de Emerson del 23-nov-2026 (mismo esquema que el reel del 22-nov).
# Datos: SPX 1 min e HIRO (bitácora /api/hiro), Bola 8 (historial del canal), Gamma Flip GB
# reconstruido de la captura de GexBot Classic de las 15:57 (trae la línea de todo el día) y lectura GexBot de las 9:31.
# Entrada (≈11:16) y salida (≈11:36) de Emerson ESTIMADAS (sin grabación todavía). Uso: python render.py [voz]  (PRUEBA=1 → PNG)
import json, subprocess, sys, os, shutil, datetime as dt
from zoneinfo import ZoneInfo
import numpy as np, matplotlib
from PIL import Image as _Img0
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle, Polygon

V = os.path.dirname(os.path.abspath(__file__)); S = os.path.dirname(V)
VOZ = sys.argv[1] if len(sys.argv) > 1 else 'es-CO-GonzaloNeural'
FPS = 24
G = json.load(open(os.path.join(V, 'guion.json'), encoding='utf-8'))
m = lambda hm: int(hm[:2]) * 60 + int(hm[3:5])
filas = json.load(open(os.path.join(S, 'hiro.json'), encoding='utf-8'))['filas']
SPX = {f['hora']: f['spx'] for f in filas}
# HIRO ORIGINAL de SpotGamma (Discord Iron Balls), curva del día digitalizada de la captura de las 15:55 (pedido de Guillermo)
_hc = [r for r in json.load(open(os.path.join(S, 'capas.json'), encoding='utf-8'))['registros'] if (r.get('hiro') or {}).get('curva')][-1]['hiro']['curva']
def _limpia(col):
    # mediana de 7 min: quita los picos de las líneas verticales "HIRO Flow" de la pantalla original; rellena huecos
    pts = [(m(x[0]), x[col]) for x in _hc if x[col] is not None]; d = dict(pts); out = {}
    t0, t1 = pts[0][0], pts[-1][0]
    for t in range(t0, t1 + 1):
        v = [d[u] for u in range(t - 3, t + 4) if u in d]
        if v: out[f'{t // 60:02d}:{t % 60:02d}'] = float(np.median(v))
    return out
CALLS = _limpia(1); PUTS = _limpia(2)
FLIP = json.load(open(os.path.join(S, 'gexbot_flip_historia.json')))
NY = ZoneInfo('America/New_York')
MU = {}
for e in sorted(json.load(open(os.path.join(S, 'muros.json'), encoding='utf-8'))['entries'], key=lambda e: e['updatedAt']):
    MU[dt.datetime.fromisoformat(e['updatedAt'].replace('Z', '+00:00')).astimezone(NY).strftime('%H:%M')] = e
def serie(d, a, b):
    xs, ys = [], []
    for t in range(m(a), m(b) + 1):
        hm = f'{t // 60:02d}:{t % 60:02d}'
        if hm in d: xs.append(t); ys.append(d[hm])
    return np.array(xs), np.array(ys)

BG, NAVY, CARD, ROJO, VERDE, ORO, GRIS, NAR = '#d9e1ea', '#0d1f3c', '#f3f5f8', '#b91c1c', '#15803d', '#d4a017', '#8a97a8', '#ea7a00'
plt.rcParams.update({'font.family': 'Bahnschrift'})
W, H = 1080, 1920

# ---------- audio ----------
AUD = os.path.join(V, 'audio'); os.makedirs(AUD, exist_ok=True)
dur = {}
for e in G:
    f = os.path.join(AUD, f"{e['id']}_{VOZ}.mp3")
    if not os.path.exists(f) or os.path.getsize(f) == 0:
        for _ in range(3):
            subprocess.run([sys.executable, '-m', 'edge_tts', '--voice', VOZ, '--text', e['voz'], '--write-media', f], capture_output=True)
            if os.path.exists(f) and os.path.getsize(f) > 0: break
    d = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], capture_output=True, text=True).stdout)
    dur[e['id']] = d + 0.45

dur['repro'] = dur.get('repro', 0) + 1.5   # 23-nov: la voz ya es ~9 s más larga; +1,5 s para ver el cierre

# ---------- lienzo ----------
LOGO_IB = np.asarray(_Img0.open(r'C:/Users/gcarv/Documents/CARPETA PERSONAL/01. guillermo carvajal/01. Trading/01. Pipe/IRON BALLS - informes/informes emerson/scripts/marca/ironballs-traders-logo-web.png').convert('RGBA'))
def lienzo():
    fig = plt.figure(figsize=(W / 100, H / 100), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1]); ax.set_xlim(0, W); ax.set_ylim(0, H); ax.axis('off')
    fig.patch.set_facecolor(BG)
    ax.add_patch(Rectangle((0, H - 130), W, 130, color=NAVY))
    ax.text(60, H - 65, 'BITÁCORA SPX', color='white', fontsize=26, fontweight='bold', va='center')
    ax.text(W - 195, H - 65, 'TRADE · 23 NOV.', color='#9fb3d1', fontsize=24, va='center', ha='right')
    lg = fig.add_axes([(W - 172) / W, (H - 124) / H, 132 / W, 118 / H]); lg.imshow(LOGO_IB); lg.axis('off')   # logo Iron Balls
    ax.text(W / 2, 92, 'Contenido educativo, no consejo de inversión.', color=GRIS, fontsize=18, ha='center')
    ax.text(W / 2, 58, 'Horas de entrada y salida aproximadas · datos: GexBot, HIRO y Bola 8 (Discord Iron Balls)', color=GRIS, fontsize=14, ha='center')
    return fig, ax
def kicker(ax, t): ax.text(W / 2, H - 215, f'—  {t}  —', color=NAVY, fontsize=24, ha='center', fontweight='bold')
def titular(ax, t, a=1.0, color=NAVY): ax.text(W / 2, 330, t, color=color, fontsize=58, ha='center', va='center', fontweight='bold', alpha=a, linespacing=1.05)
def tarjeta(ax, x, y, w, h): ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle='round,pad=0,rounding_size=18', fc=CARD, ec='#c3ccd8', lw=2))
def sub(fig, x, y, w, h):
    a = fig.add_axes([x / W, y / H, w / W, h / H]); a.set_facecolor(CARD)
    for s in a.spines.values(): s.set_visible(False)
    a.tick_params(colors=GRIS, labelsize=15); return a
def top(fig):
    a = fig.add_axes([0, 0, 1, 1]); a.set_xlim(0, W); a.set_ylim(0, H); a.axis('off'); a.patch.set_alpha(0); return a
def ease(t): t = min(max(t, 0), 1); return 1 - (1 - t) ** 3
def hhmm(t): return f'{t // 60}:{t % 60:02d}'
def ejes_tiempo(a, a0, b0, paso):
    tk = list(range(m(a0) - m(a0) % paso + paso, m(b0) + 1, paso)); a.set_xticks(tk); a.set_xticklabels([hhmm(t) for t in tk], fontsize=16, color=NAVY)
def etiqueta(ax, x, y, txt, col, w=250, h=70, fs=26):
    ax.add_patch(FancyBboxPatch((x - w / 2, y - h / 2), w, h, boxstyle='round,pad=0,rounding_size=10', color=col))
    ax.text(x, y, txt, color='white', fontsize=fs, fontweight='bold', ha='center', va='center')

# gráfico de precio reutilizable (en píxeles de la tarjeta: x 120..990, y 640..1380)
def grafico(fig, a0, b0, hasta, ylim, flip=True, muros=True, extras=None, paso=30):
    a = sub(fig, 150, 650, 830, 760)
    xs, ys = serie(SPX, a0, b0); k = xs <= m(hasta)
    a.plot(xs[k], ys[k], color=NAVY, lw=3.2, zorder=3)
    if flip:
        fx, fy = serie(FLIP, a0, b0); kf = fx <= m(hasta); a.plot(fx[kf], fy[kf], color=NAR, lw=2.6, zorder=2)
    if muros:
        a.axhline(7250, color='#c026d3', ls=':', lw=2.6, zorder=1)   # Bola 8: cierre previsto 7.250 (sin muros Sigma: pedido de Guillermo)
    a.set_xlim(m(a0), m(b0)); a.set_ylim(*ylim); ejes_tiempo(a, a0, b0, paso)
    a.yaxis.tick_right(); a.tick_params(axis='y', labelsize=16, colors=NAVY); a.grid(axis='y', color='#dde3ea', lw=1)
    if extras: extras(a)
    return a
def leyenda(ax, items, y=1428):
    x = 130
    for txt, col, est in items:
        ax.plot([x, x + 40], [y, y], color=col, lw=4, ls=est); ax.text(x + 50, y, txt, color=NAVY, fontsize=17, va='center'); x += 60 + len(txt) * 10.5

# ---------- escenas ----------
def intro(fig, ax, p):
    tarjeta(ax, 60, 620, 960, 860)
    ax.text(W / 2, 1380, 'S&P 500 · lunes 23 de noviembre', color=NAVY, fontsize=30, fontweight='bold', ha='center')
    pasos = [('1', 'LA LECTURA', 'antes de abrir'), ('2', 'LA DECISIÓN', '11:16 aprox.'), ('3', 'LA ESPERA', '20 minutos'), ('4', 'EL CIERRE', '11:36 aprox.')]
    for i, (n, t, s) in enumerate(pasos):
        a = ease((p - i * .15) / .3); y = 1220 - i * 150
        if a <= 0: continue
        ax.add_patch(plt.Circle((190, y), 42 * a, color=NAVY)); ax.text(190, y, n, color='white', fontsize=30, fontweight='bold', ha='center', va='center', alpha=a)
        ax.text(260, y + 12, t, color=NAVY, fontsize=32, fontweight='bold', va='center', alpha=a); ax.text(260, y - 30, s, color=GRIS, fontsize=22, va='center', alpha=a)

def apertura(fig, ax, p):
    tarjeta(ax, 60, 600, 960, 900)
    ax.text(100, 1440, 'GEXBOT CLASSIC · 9:31 a. m.', color=NAVY, fontsize=30, fontweight='bold')
    ax.text(100, 1400, 'la primera lectura con el mercado abierto', color=GRIS, fontsize=18)
    datos = [('IMÁN + GB', '7.255', VERDE, 'atrae y frena'), ('GAMMA FLIP GB', '7.244', NAR, 'cambio de gamma'), ('IMÁN - GB', '7.130', ROJO, 'acelera si se rompe')]
    for i, (t, v, col, s) in enumerate(datos):
        a = ease((p - i * .18) / .3); y = 1230 - i * 190
        ax.add_patch(FancyBboxPatch((120, y - 70), 840 * a + 1, 140, boxstyle='round,pad=0,rounding_size=14', fc='white', ec=col, lw=4))
        if a > .9:
            ax.text(160, y + 18, t, color=col, fontsize=28, fontweight='bold', va='center'); ax.text(160, y - 30, s, color=GRIS, fontsize=19, va='center')
            ax.text(920, y, v, color=NAVY, fontsize=50, fontweight='bold', ha='right', va='center')
    if p > .6:
        etiqueta(ax, W / 2, 700, 'SPX ABRE EN 7.240  ·  +300 PTS', NAVY, w=720, h=80, fs=28)

def manana(fig, ax, p):
    tarjeta(ax, 60, 560, 960, 960)
    ax.text(100, 1470, 'SPX 1 MIN · 10:00 – 11:12', color=NAVY, fontsize=28, fontweight='bold')
    hasta = hhmm(m('10:00') + int((m('11:12') - m('10:00')) * ease(p / .8))).zfill(5)
    grafico(fig, '10:00', '11:12', hasta, (7205, 7300))
    leyenda(ax, [('SPX', NAVY, '-'), ('Gamma Flip GB', NAR, '-'), ('Bola 8: cierre 7.250', '#c026d3', ':')])
    if p > .82:
        a2 = top(fig); etiqueta(a2, 560, 760, 'GAMMA POSITIVA: SE FRENA', VERDE, w=560, h=70, fs=26)

def hiro(fig, ax, p):
    tarjeta(ax, 60, 560, 960, 960)
    ax.text(100, 1470, 'PRECIO vs. HIRO (SPOTGAMMA)', color=NAVY, fontsize=28, fontweight='bold')
    hasta_t = m('10:15') + int((m('11:16') - m('10:15')) * ease(p / .8)); hasta = f'{hasta_t // 60:02d}:{hasta_t % 60:02d}'
    a = grafico(fig, '10:15', '11:16', hasta, (7205, 7300), flip=False, muros=False)
    b = a.twinx(); cx, cy = serie(CALLS, '10:15', '11:16'); k = cx <= hasta_t
    b.plot(cx[k], cy[k], color='#2563eb', lw=3.4); px_, py_ = serie(PUTS, '10:15', '11:16'); kp = px_ <= hasta_t
    b.plot(px_[kp], py_[kp], color=NAR, lw=3.0); b.set_ylim(-3.3, 1.9); b.yaxis.tick_left()
    b.tick_params(axis='y', labelsize=15, colors='#2563eb'); b.set_yticks([1, 0, -1, -2, -3]); b.set_yticklabels(['1 B', '0', '-1 B', '-2 B', '-3 B'])
    for s in b.spines.values(): s.set_visible(False)
    leyenda(ax, [('SPX (der.)', NAVY, '-'), ('HIRO calls', '#2563eb', '-'), ('HIRO puts (izq.)', NAR, '-')])
    if p > .82:
        a2 = top(fig); etiqueta(a2, 640, 1010, 'CALLS: -1,1 B  a  -2,8 B', '#2563eb', w=560, h=72, fs=28)

def ex_decision(a):
    a.axhspan(7260, 7265, color='#fecaca', alpha=.7, zorder=0); a.axhline(7262.8, color=ROJO, ls='--', lw=1.6)
    a.text(m('10:51'), 7266.5, 'vende 7260 / compra 7265', color=ROJO, fontsize=15, fontweight='bold')
def decision(fig, ax, p):
    tarjeta(ax, 60, 560, 960, 960)
    ax.text(100, 1470, 'EL PICO Y EL RECHAZO', color=NAVY, fontsize=28, fontweight='bold')
    hasta_t = m('10:50') + int((m('11:17') - m('10:50')) * ease(p / .6)); hasta = f'{hasta_t // 60:02d}:{hasta_t % 60:02d}'
    a = grafico(fig, '10:50', '11:20', hasta, (7235, 7280), extras=ex_decision if p > .6 else None, paso=10)
    if hasta_t >= m('11:12'): a.scatter([m('11:12')], [7270.6], s=160, color=ROJO, zorder=5); a.annotate('7.270,6', (m('11:12'), 7270.6), xytext=(8, 8), textcoords='offset points', color=ROJO, fontsize=17, fontweight='bold')
    if p > .6:
        a.scatter([m('11:16')], [7252], marker='v', s=420, color=ORO, zorder=6, edgecolors=NAVY)
        a2 = top(fig); etiqueta(a2, 560, 760, 'ENTRADA 11:16 APROX. · CRÉDITO 2,80', NAVY, w=680, h=72, fs=26)
    leyenda(ax, [('Bola 8: cierre 7.250', '#c026d3', ':'), ('Breakeven 7262,8', ROJO, '--'), ('Gamma Flip GB', NAR, '-')])

def espera(fig, ax, p):
    tarjeta(ax, 60, 560, 960, 960)
    ax.text(100, 1470, 'DENTRO DEL TRADE · 11:16 – 11:36', color=NAVY, fontsize=28, fontweight='bold')
    hasta_t = m('11:16') + int((m('11:35') - m('11:16')) * ease(p / .75)); hasta = f'{hasta_t // 60:02d}:{hasta_t % 60:02d}'
    a = grafico(fig, '11:10', '11:40', hasta, (7235, 7280), extras=ex_decision, paso=10)
    a.scatter([m('11:16')], [7252], marker='v', s=420, color=ORO, zorder=6, edgecolors=NAVY)
    if hasta_t >= m('11:20'):
        a.scatter([m('11:20')], [7266.98], s=180, color=ROJO, zorder=5)
        a2 = top(fig); etiqueta(a2, 560, 760, '11:20 · 7.267: SOBRE EL BREAKEVEN', ROJO, w=700, h=72, fs=26)
    leyenda(ax, [('Breakeven 7262,8', ROJO, '--'), ('Gamma Flip GB', NAR, '-'), ('Bola 8: cierre 7.250', '#c026d3', ':')])

def cierre(fig, ax, p):
    tarjeta(ax, 60, 560, 960, 960)
    ax.text(100, 1470, 'LA SALIDA', color=NAVY, fontsize=28, fontweight='bold')
    hasta_t = m('11:30') + int((m('11:45') - m('11:30')) * ease(p / .7)); hasta = f'{hasta_t // 60:02d}:{hasta_t % 60:02d}'
    a = grafico(fig, '11:10', '11:46', hasta, (7200, 7280), extras=ex_decision, paso=10)
    a.scatter([m('11:16')], [7252], marker='v', s=420, color=ORO, zorder=6, edgecolors=NAVY)
    if hasta_t >= m('11:36'):
        a.scatter([m('11:36')], [7244.8], marker='^', s=420, color=VERDE, zorder=6, edgecolors=NAVY)
        a2 = top(fig); etiqueta(a2, 560, 760, 'SALIDA 11:36 APROX. · +55 USD / CONTRATO', VERDE, w=720, h=72, fs=26)
    if hasta_t >= m('11:42'): a.annotate('7.208', (m('11:42'), 7208), xytext=(6, -4), textcoords='offset points', color=NAVY, fontsize=17, fontweight='bold')
    leyenda(ax, [('entrada', ORO, '-'), ('salida', VERDE, '-'), ('Breakeven', ROJO, '--')])

def resultados(fig, ax, p):
    datos = [('25', 'PERSONAS\nREPORTARON', NAVY), ('$1.324', 'TOTAL USD', VERDE), ('$53', 'PROMEDIO\nPOR PERSONA', VERDE), ('20 min', 'EN POSICIÓN', NAVY)]
    for i, (v, t, col) in enumerate(datos):
        a = ease((p - i * .15) / .3); x0 = 90 + (i % 2) * 460; y0 = 1060 - (i // 2) * 380
        if a <= 0: continue
        ax.add_patch(FancyBboxPatch((x0, y0), 440 * a, 330, boxstyle='round,pad=0,rounding_size=18', fc=CARD, ec='#c3ccd8', lw=2))
        if a > .9:
            ax.text(x0 + 220, y0 + 200, v, color=col, fontsize=64, fontweight='bold', ha='center', va='center')
            ax.text(x0 + 220, y0 + 80, t, color=NAVY, fontsize=24, ha='center', va='center', fontweight='bold')
    ax.text(W / 2, 600, 'resultados del chat de Zoom y del chat VIP · $ por contrato, sin comisiones', color=GRIS, fontsize=17, ha='center')

def leccion(fig, ax, p):
    piezas = [('GAMMA POSITIVA', 'el precio se frena', NAR), ('HIRO BAJISTA', 'el dinero no acompaña', ROJO), ('BOLA 8: CIERRE 7.250', 'el imán estaba abajo', '#c026d3'), ('NIVEL + PLAN', 'entrada, stop y salida', NAVY)]
    for i, (t, s, col) in enumerate(piezas):
        a = ease((p - i * .14) / .28); y = 1260 - i * 175
        if a <= 0: continue
        ax.add_patch(FancyBboxPatch((140, y - 65), 800 * a, 130, boxstyle='round,pad=0,rounding_size=16', fc=col, alpha=.92))
        if a > .9:
            ax.text(190, y + 14, t, color='white', fontsize=34, fontweight='bold', va='center'); ax.text(190, y - 32, s, color='white', fontsize=20, va='center', alpha=.9)
    if p > .7: ax.text(W / 2, 545, 'Sígueme para más lecturas del SPX en vivo', color=NAVY, fontsize=26, ha='center', fontweight='bold')


B8 = json.load(open(os.path.join(S, 'bola8', 'bola8_predicciones.json')))
from PIL import Image as _Img
B8IMG = np.asarray(_Img.open(os.path.join(S, 'bola8', 'bola8_1051_1.png')).convert('RGB').crop((140, 425, 585, 720)))
def bola8(fig, ax, p):
    tarjeta(ax, 60, 560, 960, 960)
    ax.text(100, 1470, 'BOLA 8 · UN INFORME CADA 15 MIN', color=NAVY, fontsize=28, fontweight='bold')
    a = sub(fig, 150, 1010, 830, 400)
    pts = [x for x in B8 if '10:00' <= x[0] <= '11:10']
    k = max(1, int(len(pts) * ease(p / .6)))
    xs = [m(x[0]) for x in pts[:k]]
    a.plot(xs, [x[1] for x in pts[:k]], color='#c026d3', lw=3, marker='o', ms=8, zorder=3)
    a.plot([m('10:00'), m('11:10')], [7250, 7250], color=NAR, lw=3.5, zorder=2)
    a.text(m('10:01'), 7252.5, 'cierre previsto: 7.250', color=NAR, fontsize=17, fontweight='bold')
    a.set_xlim(m('10:00'), m('11:12')); a.set_ylim(7222, 7292); ejes_tiempo(a, '10:00', '11:12', 15)
    a.yaxis.tick_right(); a.tick_params(axis='y', labelsize=15, colors=NAVY); a.grid(axis='y', color='#dde3ea', lw=1)
    leyenda(ax, [('precio en cada informe', '#c026d3', '-'), ('cierre previsto', NAR, '-')])
    if p > .55:
        b = sub(fig, 170, 640, 520, 345); b.imshow(B8IMG); b.set_xticks([]); b.set_yticks([])
        ax.text(720, 900, 'Panel de gamma\n10:50', color=NAVY, fontsize=22, fontweight='bold', va='center')
        ax.text(720, 800, 'calls y puts\nconcentrados\nen 7.250', color=GRIS, fontsize=19, va='center')


# 23-nov: reproducción real de la hoja Hiro (cuadros de grabar_repro.mjs --vertical: 11:14 a 11:42, 1 vela por cuadro).
# Pedido de Guillermo: "esta parte es fundamental": +10 s, velas más lentas y zoom que sigue a la última vela.
import glob as _glob
REPRO = [np.asarray(_Img.open(f).convert('RGB').crop((0, 400, 1079, 1300))) for f in sorted(_glob.glob(os.path.join(S, 'clips', 'cuadros_v', '*.png')))]
def _ultima_vela(img):
    """(x, y) de la vela más a la derecha del panel de precio (rojo #ef5350 / verde #26a69a), en píxeles del recorte."""
    zona = img[0:590, 0:930].astype(int); R, G, B = zona[..., 0], zona[..., 1], zona[..., 2]
    vela = ((R > 200) & (G < 110) & (B < 110)) | ((G > 140) & (R < 70) & (B > 120) & (B < 180))
    cols = np.where(vela.sum(axis=0) >= 4)[0]
    if not len(cols): return (540, 300)
    x1 = cols.max(); xs = cols[cols >= x1 - 12]; ys = np.where(vela[:, xs].any(axis=1))[0]
    return (float(xs.mean()), float(ys.mean()))
CENTROS = [_ultima_vela(im) for im in REPRO]
EXTRA_REPRO = 10.0   # segundos extra de la escena (las velas van más despacio)
def repro(fig, ax, p):
    ax.add_patch(FancyBboxPatch((32, 596), 1016, 888, boxstyle='round,pad=0,rounding_size=14', fc='#141414', ec='#c3ccd8', lw=2))
    if not REPRO: return
    T = dur['repro']; t = p * T; fin_velas = T - 4.5          # las 15 velas en T-4,5 s; luego se queda la última
    kf = min(len(REPRO) - 1, t / fin_velas * (len(REPRO) - 1)); k = int(kf)
    img = REPRO[k]; H0, W0 = img.shape[:2]
    # zoom: completo → acercarse siguiendo la vela (desde el 25 % de la escena) → abrir al final para ver el HIRO
    z = 1.0
    if p > .25: z = 1 + 0.7 * ease((p - .25) / .40)
    if p > .86: z = 1 + 0.7 * (1 - ease((p - .86) / .12))
    c0, c1 = CENTROS[k], CENTROS[min(k + 1, len(REPRO) - 1)]; fr = kf - k
    cx = c0[0] + (c1[0] - c0[0]) * fr; cy = c0[1] + (c1[1] - c0[1]) * fr
    w, h = W0 / z, H0 / z
    x0 = min(max(0, cx - w * 0.68), W0 - w); y0 = min(max(0, cy - h * 0.45), H0 - h)   # la vela queda a la derecha del centro
    sub = img[int(y0):int(y0 + h), int(x0):int(x0 + w)]
    a = fig.add_axes([40 / W, 604 / H, 1000 / W, 872 / H]); a.imshow(sub, interpolation='bilinear', aspect='auto'); a.axis('off')
    ax.text(W / 2, 555, 'Reproducción de la hoja Hiro · velas de 2 min' + (' · zoom al precio' if z > 1.05 else ''), color=GRIS, fontsize=17, ha='center')
    # 23-nov (Guillermo: "marcar con un círculo el movimiento del precio y lo relevante")
    aa = top(fig)
    def a_fig(ix, iy): return 40 + (ix - x0) / w * 1000, 604 + 872 - (iy - y0) / h * 872
    vx, vy = a_fig(cx, cy); hora = 14 + 2 * k   # minutos después de las 11:00
    def etiqueta_hoja(txt, col, x, y):
        an = max(460, len(txt) * 12 + 50); x = min(max(x, an / 2 + 20), W - an / 2 - 20); y = min(max(y, 640), 1440)
        aa.add_patch(FancyBboxPatch((x - an / 2, y - 26), an, 52, boxstyle='round,pad=0,rounding_size=10', fc=col, ec='white', lw=1.5, alpha=.95))
        aa.text(x, y, txt, color='white', fontsize=19, fontweight='bold', ha='center', va='center')
    if p <= .86:
        r = 46 if z < 1.2 else 60
        col = ROJO if (18 <= hora <= 22 or hora >= 36) else ORO
        aa.add_patch(plt.Circle((vx, vy), r, fill=False, ec=col, lw=4.5)); aa.add_patch(plt.Circle((vx, vy), r + 9, fill=False, ec='white', lw=1.5, alpha=.7))
        if 18 <= hora <= 22: etiqueta_hoja('11:20 · rebote sobre el breakeven', ROJO, vx - 120, vy + 105)
        elif hora >= 36: etiqueta_hoja('Caída hacia el Target 2 (7.200)', ROJO, vx - 170, vy - 110)
        elif hora >= 26: etiqueta_hoja('El precio pierde fuerza', ORO, vx - 150, vy + 100)
    else:   # al abrir el zoom: el HIRO
        hx0, hy0 = a_fig(0, 900); hx1, hy1 = a_fig(965, 628)
        aa.add_patch(Rectangle((hx0 + 6, hy0 + 6), hx1 - hx0 - 12, hy1 - hy0 - 12, fill=False, ec=ROJO, lw=4))
        etiqueta_hoja('HIRO: calls, puts y neto bajan con el precio', ROJO, W / 2, hy1 - 40)

ESC = dict(intro=intro, apertura=apertura, manana=manana, hiro=hiro, bola8=bola8, decision=decision, repro=repro, espera=espera, cierre=cierre, resultados=resultados, leccion=leccion)
COLOR_TIT = dict(cierre=VERDE, decision=ROJO)

if os.environ.get('PRUEBA'):
    os.makedirs(os.path.join(V, 'prueba'), exist_ok=True)
    for e in G:
        fig, ax = lienzo(); kicker(ax, e['kicker']); ESC[e['id']](fig, ax, 1.0); titular(ax, e['titular'], 1, COLOR_TIT.get(e['id'], NAVY))
        fig.savefig(os.path.join(V, 'prueba', e['id'] + '.png'), dpi=50); plt.close(fig)
    print('prueba ok', {k: round(v, 1) for k, v in dur.items()}, 'total', round(sum(dur.values()), 1)); sys.exit()
FR = os.path.join(V, 'frames'); shutil.rmtree(FR, ignore_errors=True); os.makedirs(FR)
k = 0
for e in G:
    n = int(dur[e['id']] * FPS)
    for i in range(n):
        p = i / max(1, n - 1)
        fig, ax = lienzo(); kicker(ax, e['kicker']); ESC[e['id']](fig, ax, p)
        titular(ax, e['titular'], ease(p / .15), COLOR_TIT.get(e['id'], NAVY))
        fig.savefig(os.path.join(FR, f'{k:05d}.png'), dpi=100); plt.close(fig); k += 1
print('frames', k)
lista = os.path.join(V, 'lista_audio.txt'); partes = []
for e in G:
    f = os.path.join(AUD, f"{e['id']}_{VOZ}.mp3"); o = os.path.join(AUD, f"{e['id']}_{VOZ}_pad.wav")
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', f, '-af', f"apad=whole_dur={int(dur[e['id']] * FPS) / FPS}", '-ar', '44100', '-ac', '2', o]); partes.append(o)
open(lista, 'w').write(''.join(f"file '{x}'\n" for x in partes))
aud = os.path.join(V, f'voz_{VOZ}.wav')
subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lista, aud])
out = os.path.join(V, f'reel_trade_emerson_2026-11-23.mp4')
subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-framerate', str(FPS), '-i', os.path.join(FR, '%05d.png'), '-i', aud,
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', out])
shutil.rmtree(FR, ignore_errors=True)
print('ok', out)
