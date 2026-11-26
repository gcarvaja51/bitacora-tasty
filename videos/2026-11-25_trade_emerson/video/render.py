# Reel vertical 1080x1920 del trade de Emerson del 25-nov-2026 (mismo esquema que el del 24-nov) + aprendizajes (stop loss).
# Diferencias con el 23-nov: datos de Discord COMPLETOS del bot (GexBot Classic/State, HIRO, Bola 8, Tradytics, Option Flow),
# horas EXACTAS de entrada y TP (grabación propia del Zoom, reloj real) y dos clips con la voz y la pantalla de Emerson.
# Uso: python render.py [voz]   (PRUEBA=1 → un PNG por escena en video/prueba)
import json, subprocess, sys, os, shutil, glob
import numpy as np, matplotlib
from PIL import Image
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle

V = os.path.dirname(os.path.abspath(__file__)); S = os.path.dirname(V)
VOZ = sys.argv[1] if len(sys.argv) > 1 else 'es-CO-GonzaloNeural'
FPS = 24
G = json.load(open(os.path.join(V, 'guion.json'), encoding='utf-8'))
D = json.load(open(os.path.join(S, 'datos.json'), encoding='utf-8'))
m = lambda hm: int(hm[:2]) * 60 + int(hm[3:5])
def hhmm(t): return f'{t // 60}:{t % 60:02d}'
def hm2(t): return f'{t // 60:02d}:{t % 60:02d}'
SPX = {k: v[3] for k, v in D['spx'].items()}
CALLS = {x[0]: x[1] for x in D['hiro_curva'] if x[1] is not None}
PUTS = {x[0]: x[2] for x in D['hiro_curva'] if x[2] is not None}
# Gamma Flip GB: una lectura por ciclo del bot (cada ~6 min); se sostiene hasta la siguiente
_fl = sorted(D['flip'].items()); FLIP = {}
for i, (h, v) in enumerate(_fl):
    fin = m(_fl[i + 1][0]) if i + 1 < len(_fl) else m('12:30')
    for t in range(m(h), fin): FLIP[hm2(t)] = v
def serie(d, a, b):
    xs, ys = [], []
    for t in range(m(a), m(b) + 1):
        if hm2(t) in d: xs.append(t); ys.append(d[hm2(t)])
    return np.array(xs), np.array(ys)

BG, NAVY, CARD, ROJO, VERDE, ORO, GRIS, NAR, VIO = '#d9e1ea', '#0d1f3c', '#f3f5f8', '#b91c1c', '#15803d', '#d4a017', '#8a97a8', '#ea7a00', '#c026d3'
plt.rcParams.update({'font.family': 'Bahnschrift', 'axes.unicode_minus': False})
W, H = 1080, 1920
ENTRADA, SALIDA, BE = ('11:12', 6994.55), ('11:26', 7024.28), 6997.60

# ---------- audio: voz sintética por escena; las escenas de clip usan el audio original de la grabación ----------
AUD = os.path.join(V, 'audio'); os.makedirs(AUD, exist_ok=True)
CL = os.path.join(S, 'clips')
dur, archivo = {}, {}
for e in G:
    if e.get('clip'):
        f = os.path.join(CL, f"clip_{e['clip']}.wav")
    else:
        f = os.path.join(AUD, f"{e['id']}_{VOZ}.mp3")
        if not os.path.exists(f) or os.path.getsize(f) == 0:
            for _ in range(3):
                subprocess.run([sys.executable, '-m', 'edge_tts', '--voice', VOZ, '--text', e['voz'], '--write-media', f], capture_output=True)
                if os.path.exists(f) and os.path.getsize(f) > 0: break
    d = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], capture_output=True, text=True).stdout)
    dur[e['id']] = d + (0.35 if e.get('clip') else 0.55); archivo[e['id']] = f
CLIP = {n: sorted(glob.glob(os.path.join(CL, f'c_{n}', '*.png'))) for n in ('entrada', 'stop')}

# ---------- lienzo ----------
LOGO_IB = np.asarray(Image.open(r'C:/Users/gcarv/Documents/CARPETA PERSONAL/01. guillermo carvajal/01. Trading/01. Pipe/IRON BALLS - informes/informes emerson/scripts/marca/ironballs-traders-logo-web.png').convert('RGBA'))
def lienzo():
    fig = plt.figure(figsize=(W / 100, H / 100), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1]); ax.set_xlim(0, W); ax.set_ylim(0, H); ax.axis('off')
    fig.patch.set_facecolor(BG)
    ax.add_patch(Rectangle((0, H - 130), W, 130, color=NAVY))
    ax.text(60, H - 65, 'BITÁCORA SPX', color='white', fontsize=26, fontweight='bold', va='center')
    ax.text(W - 195, H - 65, 'TRADE · 25 NOV.', color='#9fb3d1', fontsize=24, va='center', ha='right')
    lg = fig.add_axes([(W - 172) / W, (H - 124) / H, 132 / W, 118 / H]); lg.imshow(LOGO_IB); lg.axis('off')
    ax.text(W / 2, 92, 'Contenido educativo, no consejo de inversión.', color=GRIS, fontsize=18, ha='center')
    ax.text(W / 2, 58, 'Datos: GexBot, HIRO, Bola 8, Tradytics y Quant Data (Discord Iron Balls) · grabación del Zoom', color=GRIS, fontsize=14, ha='center')
    return fig, ax
def kicker(ax, t): ax.text(W / 2, H - 215, f'—  {t}  —', color=NAVY, fontsize=24, ha='center', fontweight='bold')
def titular(ax, t, a=1.0, color=NAVY): ax.text(W / 2, 330, t, color=color, fontsize=56, ha='center', va='center', fontweight='bold', alpha=a, linespacing=1.05)
def tarjeta(ax, x, y, w, h): ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle='round,pad=0,rounding_size=18', fc=CARD, ec='#c3ccd8', lw=2))
def sub(fig, x, y, w, h):
    a = fig.add_axes([x / W, y / H, w / W, h / H]); a.set_facecolor(CARD)
    for s in a.spines.values(): s.set_visible(False)
    a.tick_params(colors=GRIS, labelsize=15); return a
def top(fig):
    a = fig.add_axes([0, 0, 1, 1]); a.set_xlim(0, W); a.set_ylim(0, H); a.axis('off'); a.patch.set_alpha(0); return a
def ease(t): t = min(max(t, 0), 1); return 1 - (1 - t) ** 3
def ejes_tiempo(a, a0, b0, paso):
    tk = list(range(m(a0) - m(a0) % paso + paso, m(b0) + 1, paso)); a.set_xticks(tk); a.set_xticklabels([hhmm(t) for t in tk], fontsize=16, color=NAVY)
def etiqueta(ax, x, y, txt, col, w=250, h=70, fs=26):
    ax.add_patch(FancyBboxPatch((x - w / 2, y - h / 2), w, h, boxstyle='round,pad=0,rounding_size=10', color=col))
    ax.text(x, y, txt, color='white', fontsize=fs, fontweight='bold', ha='center', va='center')
def avance(p, a, b, frac=.8):
    return hm2(m(a) + int((m(b) - m(a)) * ease(p / frac)))

def grafico(fig, a0, b0, hasta, ylim, flip=True, imanes=False, extras=None, paso=30):
    a = sub(fig, 150, 650, 830, 760)
    xs, ys = serie(SPX, a0, b0); k = xs <= m(hasta)
    a.plot(xs[k], ys[k], color=NAVY, lw=3.2, zorder=3)
    if flip:
        fx, fy = serie(FLIP, a0, b0); kf = fx <= m(hasta); a.plot(fx[kf], fy[kf], color=NAR, lw=2.8, zorder=2)
    if imanes:
        a.axhline(7000, color=ROJO, ls='-.', lw=2, zorder=1); a.axhline(7010.6, color=VIO, ls=':', lw=2.2, zorder=1)
    a.set_xlim(m(a0), m(b0)); a.set_ylim(*ylim); ejes_tiempo(a, a0, b0, paso)
    a.yaxis.tick_right(); a.tick_params(axis='y', labelsize=16, colors=NAVY); a.grid(axis='y', color='#dde3ea', lw=1)
    if extras: extras(a)
    return a
def leyenda(ax, items, y=1428):
    x = 130
    for txt, col, est in items:
        ax.plot([x, x + 40], [y, y], color=col, lw=4, ls=est); ax.text(x + 50, y, txt, color=NAVY, fontsize=17, va='center'); x += 60 + len(txt) * 10.5

# ---------- escenas (25-nov) ----------
def intro(fig, ax, p):
    tarjeta(ax, 60, 620, 960, 860)
    ax.text(W / 2, 1380, 'S&P 500 · miércoles 25 de noviembre', color=NAVY, fontsize=30, fontweight='bold', ha='center')
    pasos = [('1', 'LA LECTURA', 'casi todo bajista… menos el HIRO'), ('2', 'LA DECISIÓN', '11:12 · en vivo'), ('3', 'EL STOP', '11:26 · -75 USD'), ('4', 'EL APRENDIZAJE', 'qué nos enseñó')]
    for i, (n, t, s) in enumerate(pasos):
        a = ease((p - i * .15) / .3); y = 1220 - i * 150
        if a <= 0: continue
        ax.add_patch(plt.Circle((190, y), 42 * a, color=NAVY)); ax.text(190, y, n, color='white', fontsize=30, fontweight='bold', ha='center', va='center', alpha=a)
        ax.text(260, y + 12, t, color=NAVY, fontsize=32, fontweight='bold', va='center', alpha=a); ax.text(260, y - 30, s, color=GRIS, fontsize=22, va='center', alpha=a)

def apertura(fig, ax, p):
    tarjeta(ax, 60, 600, 960, 900)
    ax.text(100, 1440, 'GEXBOT CLASSIC · MAÑANA', color=NAVY, fontsize=30, fontweight='bold')
    ax.text(100, 1400, 'niveles del bot con el mercado abierto', color=GRIS, fontsize=18)
    datos = [('IMÁN + GB', '7.100', VERDE, 'atrae y frena'), ('GAMMA FLIP GB', '7.020', NAR, 'cambio de gamma (11:09)'), ('IMÁN - GB', '7.000', ROJO, 'acelera si se rompe')]
    for i, (t, v, col, s) in enumerate(datos):
        a = ease((p - i * .18) / .3); y = 1230 - i * 190
        ax.add_patch(FancyBboxPatch((120, y - 70), 840 * a + 1, 140, boxstyle='round,pad=0,rounding_size=14', fc='white', ec=col, lw=4))
        if a > .9:
            ax.text(160, y + 18, t, color=col, fontsize=28, fontweight='bold', va='center'); ax.text(160, y - 30, s, color=GRIS, fontsize=19, va='center')
            ax.text(920, y, v, color=NAVY, fontsize=50, fontweight='bold', ha='right', va='center')
    if p > .6:
        etiqueta(ax, W / 2, 700, 'ABRE 7.060 · -140 PTS · MÍN. 6.970 · REBOTE 7.063', ROJO, w=900, h=80, fs=25)

PISOS = [('10:29', 6993.66), ('10:45', 6994.48), ('11:02', 6998.94), ('11:10', 6995.08)]
def manana(fig, ax, p):
    tarjeta(ax, 60, 560, 960, 960)
    ax.text(100, 1470, 'SPX 1 MIN · 9:30 – 11:12', color=NAVY, fontsize=28, fontweight='bold')
    hasta = avance(p, '09:30', '11:12')
    def ex(a):
        if p > .5: a.axhspan(6990, 6996, color='#bbf7d0', alpha=.8, zorder=0)
    a = grafico(fig, '09:30', '11:12', hasta, (6960, 7075), extras=ex)
    leyenda(ax, [('SPX', NAVY, '-'), ('Gamma Flip GB (bot)', NAR, '-'), ('piso 6.990–6.995', '#86efac', '-')])
    if p > .3: a.annotate('6.970', (m('09:45'), 6970.11), xytext=(4, -20), textcoords='offset points', color=ROJO, fontsize=17, fontweight='bold')
    if p > .45: a.annotate('7.063', (m('10:06'), 7063.54), xytext=(6, 4), textcoords='offset points', color=NAVY, fontsize=17, fontweight='bold')
    for i, (h, v) in enumerate(PISOS):
        if m(hasta) >= m(h) and p > .5:
            a.scatter([m(h)], [v], s=150, color=VERDE, zorder=6, edgecolors=NAVY)
            a.annotate(str(i + 1), (m(h), v), xytext=(-4, -24), textcoords='offset points', color=VERDE, fontsize=17, fontweight='bold')
    if p > .85:
        a2 = top(fig); etiqueta(a2, 560, 590, '4 VECES PROBADO · 4 REBOTES', VERDE, w=620, h=70, fs=26)

SONAR = np.asarray(Image.open(r'C:/Users/gcarv/Documents/CARPETA PERSONAL/01. guillermo carvajal/01. Trading/01. Pipe/gexbot-sombra/capturas/2026-11-25/bola8_202611251601_sonar.png').convert('RGB'))
def herramientas(fig, ax, p):
    tarjeta(ax, 60, 560, 960, 960)
    ax.text(100, 1470, 'LO QUE MOSTRABA EL DISCORD · 11:10', color=NAVY, fontsize=28, fontweight='bold')
    filas = [('BOLA 8', 'bajista · fuerza 0,82 · obj. 7.000 / 6.950', VIO), ('TRADYTICS', r'bearish · +\$49 M en puts', ROJO),
             ('QUANT DATA', r'bearish · prima puts \$267 M vs. calls \$85 M', ROJO), ('GEXBOT', 'gamma negativa · debajo del flip 7.020', NAR),
             ('FASES 5m / 2m', 'fase 4 y fase 4 (bajistas)', NAVY)]
    for i, (t, s, col) in enumerate(filas):
        a = ease((p - i * .11) / .22); y = 1365 - i * 100
        if a <= 0: continue
        ax.add_patch(FancyBboxPatch((100, y - 43), 880 * a, 86, boxstyle='round,pad=0,rounding_size=12', fc='white', ec=col, lw=3.5))
        if a > .9:
            ax.text(130, y + 12, t, color=col, fontsize=25, fontweight='bold', va='center'); ax.text(130, y - 22, s, color=NAVY, fontsize=19, va='center')
            ax.scatter([945], [y], marker='v', s=480, color=ROJO, zorder=6)
    if p > .6:
        b = sub(fig, 350, 600, 380, 255); b.imshow(SONAR[60:720, 140:1090], aspect='auto'); b.set_xticks([]); b.set_yticks([])
        ax.text(W / 2, 868, 'Bola 8 · Sonar de las 11:01 (Bias: Bearish · Strength 0,82)', color=GRIS, fontsize=16, ha='center')

def hiro(fig, ax, p):
    tarjeta(ax, 60, 560, 960, 960)
    ax.text(100, 1470, 'PRECIO vs. HIRO (SPOTGAMMA)', color=NAVY, fontsize=28, fontweight='bold')
    hasta = avance(p, '09:30', '11:26'); ht = m(hasta)
    a = grafico(fig, '09:30', '11:26', hasta, (6960, 7075), flip=False)
    b = a.twinx(); cx, cy = serie(CALLS, '09:30', '11:26'); k = cx <= ht
    b.plot(cx[k], cy[k], color='#2563eb', lw=3.4); px_, py_ = serie(PUTS, '09:30', '11:26'); kp = px_ <= ht
    b.plot(px_[kp], py_[kp], color=NAR, lw=3.0); b.set_ylim(-0.6, 2.4); b.yaxis.tick_left(); b.axhline(0, color=GRIS, lw=1, ls=':')
    b.tick_params(axis='y', labelsize=15, colors='#2563eb'); b.set_yticks([2, 1.5, 1, .5, 0]); b.set_yticklabels(['2 B', '1,5 B', '1 B', '0,5 B', '0'])
    for s in b.spines.values(): s.set_visible(False)
    a.yaxis.tick_right()
    if ht >= m('11:12'): a.axvline(m('11:12'), color=ORO, lw=2.5, ls='--'); a.text(m('11:12') - 1, 7068, 'entrada', color=ORO, fontsize=16, fontweight='bold', ha='right')
    leyenda(ax, [('SPX (der.)', NAVY, '-'), ('HIRO calls', '#2563eb', '-'), ('HIRO puts (izq.)', NAR, '-')])
    if p > .82:
        a2 = top(fig); etiqueta(a2, 600, 590, 'CALLS 0,3 A 1,6 B · PUTS EN POSITIVO', VERDE, w=780, h=72, fs=25)

def ex_trade(a):
    a.axhspan(6995, 7000, color='#fecaca', alpha=.7, zorder=0); a.axhline(BE, color=ROJO, ls='--', lw=1.8)
    a.axhline(7017, color='#7f1d1d', ls='-', lw=2.2)
    a.text(a.get_xlim()[0] + 1, 6985.5, 'vende 6995 / compra 7000', color=ROJO, fontsize=15, fontweight='bold')
    a.text(a.get_xlim()[0] + 1, 7018.5, 'stop 7.017', color='#7f1d1d', fontsize=15, fontweight='bold')
def decision(fig, ax, p):
    tarjeta(ax, 60, 560, 960, 960)
    ax.text(100, 1470, 'ESPERÓ LA RUPTURA DE 6.995', color=NAVY, fontsize=28, fontweight='bold')
    hasta = avance(p, '10:55', '11:12', .65)
    a = grafico(fig, '10:55', '11:30', hasta, (6980, 7032), imanes=True, extras=ex_trade if p > .65 else None, paso=5)
    if m(hasta) >= m('11:12'):
        a.scatter([m(ENTRADA[0])], [ENTRADA[1]], marker='v', s=420, color=ORO, zorder=6, edgecolors=NAVY)
    leyenda(ax, [('Gamma Flip GB', NAR, '-'), ('Imán - 7.000', ROJO, '-.'), ('Acelerador 7.010', VIO, ':')])
    if p > .7:
        a2 = top(fig); etiqueta(a2, 560, 1335, 'ENTRADA 11:12 · CRÉDITO 2,60', NAVY, w=640, h=72, fs=26)

def clip(fig, ax, p, nombre, cita):
    cuadros = CLIP[nombre]
    ax.add_patch(FancyBboxPatch((30, 742), 1020, 600, boxstyle='round,pad=0,rounding_size=14', fc='#141414', ec='#c3ccd8', lw=2))
    if cuadros:
        k = min(len(cuadros) - 1, int(p * (len(cuadros) - 1)))
        a = fig.add_axes([40 / W, 752 / H, 1000 / W, 580 / H]); a.imshow(np.asarray(Image.open(cuadros[k]).convert('RGB')), aspect='auto'); a.axis('off')
    ax.add_patch(plt.Circle((80, 1390), 12, color=ROJO, alpha=.5 + .5 * (int(p * 20) % 2)))
    ax.text(105, 1390, 'EN VIVO · pantalla de Emerson · audio original del Zoom', color=NAVY, fontsize=19, va='center', fontweight='bold')
    ax.text(W / 2, 640, cita, color=NAVY, fontsize=23, ha='center', va='center', style='italic', wrap=True)
def clip_entrada(fig, ax, p): clip(fig, ax, p, 'entrada', '«…de hecho ya entré con 2,60, ahí estoy con 2,60»')
def clip_stop(fig, ax, p): clip(fig, ax, p, 'stop', '«…salí con 75 dólares de stop loss.\nEl día de hoy no tuvo la fuerza para venir a romper»')

def espera(fig, ax, p):
    tarjeta(ax, 60, 560, 960, 960)
    ax.text(100, 1470, 'DENTRO DEL TRADE · 11:12 – 11:20', color=NAVY, fontsize=28, fontweight='bold')
    hasta = avance(p, '11:12', '11:20', .75)
    a = grafico(fig, '10:55', '11:30', hasta, (6980, 7032), imanes=True, extras=ex_trade, paso=5)
    a.scatter([m(ENTRADA[0])], [ENTRADA[1]], marker='v', s=420, color=ORO, zorder=6, edgecolors=NAVY)
    a.axhline(6980, color=VERDE, ls=':', lw=2); a.text(m('11:22'), 6981, 'objetivo 6.980', color=VERDE, fontsize=15, fontweight='bold')
    if m(hasta) >= m('11:17'):
        a.scatter([m('11:17')], [6989.52], s=180, color=VERDE, zorder=5)
        a2 = top(fig); etiqueta(a2, 560, 1335, '11:17 · 6.989 · +20/25 USD Y REBOTA', VERDE, w=740, h=72, fs=25)
    leyenda(ax, [('Breakeven 6.997,60', ROJO, '--'), ('objetivo 6.980', VERDE, ':'), ('entrada 2,60', ORO, '-')])

def cierre(fig, ax, p):
    tarjeta(ax, 60, 560, 960, 960)
    ax.text(100, 1470, 'ROMPE EL ACELERADOR DE GAMMA', color=NAVY, fontsize=28, fontweight='bold')
    hasta = avance(p, '11:20', '11:27', .7)
    a = grafico(fig, '10:55', '11:30', hasta, (6980, 7032), imanes=True, extras=ex_trade, paso=5)
    a.scatter([m(ENTRADA[0])], [ENTRADA[1]], marker='v', s=420, color=ORO, zorder=6, edgecolors=NAVY)
    if m(hasta) >= m('11:25'):
        a.annotate('7.027', (m('11:25'), 7027.48), xytext=(-62, 4), textcoords='offset points', color=ROJO, fontsize=17, fontweight='bold')
    if m(hasta) >= m('11:26'):
        a.scatter([m(SALIDA[0])], [SALIDA[1]], marker='X', s=380, color=ROJO, zorder=6, edgecolors=NAVY)
        a2 = top(fig); etiqueta(a2, 560, 1335, 'STOP 11:26 · -75 USD / CONTRATO', ROJO, w=720, h=72, fs=26)
    leyenda(ax, [('entrada 11:12', ORO, '-'), ('stop 7.017', '#7f1d1d', '-'), ('Acelerador 7.010', VIO, ':')])

def despues(fig, ax, p):
    tarjeta(ax, 60, 560, 960, 960)
    ax.text(100, 1470, 'SPX 1 MIN · 11:00 – 14:10', color=NAVY, fontsize=28, fontweight='bold')
    hasta = avance(p, '11:12', '14:10', .8)
    def ex(a):
        a.axhspan(6995, 7000, color='#fecaca', alpha=.7, zorder=0); a.axhline(7017, color='#7f1d1d', lw=2)
    a = grafico(fig, '11:00', '14:10', hasta, (6975, 7215), flip=False, extras=ex, paso=30)
    a.scatter([m(ENTRADA[0])], [ENTRADA[1]], marker='v', s=300, color=ORO, zorder=6, edgecolors=NAVY)
    if m(hasta) >= m('11:26'): a.scatter([m(SALIDA[0])], [SALIDA[1]], marker='X', s=300, color=ROJO, zorder=6, edgecolors=NAVY)
    if m(hasta) >= m('11:38'): a.annotate('11:38 · 6.993', (m('11:38'), 6992.77), xytext=(8, -22), textcoords='offset points', color=NAVY, fontsize=16, fontweight='bold')
    if m(hasta) >= m('14:06'): a.annotate('7.197', (m('14:06'), 7196.78), xytext=(-60, 2), textcoords='offset points', color=VERDE, fontsize=18, fontweight='bold')
    leyenda(ax, [('SPX', NAVY, '-'), ('strikes 6995/7000', '#fca5a5', '-'), ('stop 7.017', '#7f1d1d', '-')])
    if p > .85:
        a2 = top(fig); etiqueta(a2, 560, 590, 'SIN STOP: -240 USD · CON STOP: -75', VERDE, w=760, h=70, fs=25)

def resultados(fig, ax, p):
    datos = [('34', 'PERSONAS\nREPORTARON', NAVY), ('-$865', 'TOTAL USD', ROJO),
             ('14', 'GANARON · +$630\nsalieron en el piso 6.990', VERDE), ('19', 'PERDIERON · -$1.495\nesperaron y salieron por stop', ROJO),
             ('+$45', 'PROMEDIO\nGANADOR', VERDE), ('-$79', 'PROMEDIO\nPERDEDOR', ROJO)]
    for i, (v, t, col) in enumerate(datos):
        a = ease((p - i * .11) / .25); x0 = 70 + (i % 2) * 480; y0 = 1150 - (i // 2) * 290
        if a <= 0: continue
        ax.add_patch(FancyBboxPatch((x0, y0), 460 * a, 260, boxstyle='round,pad=0,rounding_size=18', fc=CARD, ec=col if i in (2, 3) else '#c3ccd8', lw=4 if i in (2, 3) else 2))
        if a > .9:
            ax.text(x0 + 230, y0 + 168, v, color=col, fontsize=58, fontweight='bold', ha='center', va='center')
            ax.text(x0 + 230, y0 + 62, t, color=NAVY, fontsize=21, ha='center', va='center', fontweight='bold', linespacing=1.15)
    ax.text(W / 2, 530, 'chat de Zoom y chat VIP · $ por contrato, sin comisiones · 1 en cero', color=GRIS, fontsize=17, ha='center')

def error(fig, ax, p):
    piezas = [('1 · HIRO EN CONTRA', 'el dinero compraba; el 24-nov acompañaba la venta', '#2563eb'),
              ('2 · MALA UBICACIÓN', 'call vendido sobre un piso con 4 rebotes,\ny debajo del acelerador de gamma 7.010', NAR),
              ('3 · OBJETIVO DETRÁS DEL PISO', '6.980 exigía romper 6.990; cobrar en el piso pagaba', VIO)]
    for i, (t, s, col) in enumerate(piezas):
        a = ease((p - i * .2) / .3); y = 1250 - i * 215
        if a <= 0: continue
        ax.add_patch(FancyBboxPatch((90, y - 85), 900 * a, 170, boxstyle='round,pad=0,rounding_size=16', fc='white', ec=col, lw=4))
        if a > .9:
            ax.text(125, y + 40, t, color=col, fontsize=30, fontweight='bold', va='center'); ax.text(125, y - 22, s, color=NAVY, fontsize=20, va='center', linespacing=1.2)
    if p > .75:
        etiqueta(ax, W / 2, 640, 'LO QUE EL PROFE HIZO BIEN: EL STOP', VERDE, w=780, h=74, fs=27)

def leccion(fig, ax, p):
    piezas = [('TODO DEL MISMO LADO', 'HIRO incluido', '#2563eb'), ('NO VENDER EN EL PISO', 'si aguanta, espera que se rompa de verdad', NAR),
              ('COBRAR EN EL NIVEL', 'el piso también es objetivo', VIO), ('EL STOP SE RESPETA', 'salvó 165 USD por contrato', VERDE)]
    for i, (t, s, col) in enumerate(piezas):
        a = ease((p - i * .14) / .28); y = 1260 - i * 175
        if a <= 0: continue
        ax.add_patch(FancyBboxPatch((140, y - 65), 800 * a, 130, boxstyle='round,pad=0,rounding_size=16', fc=col, alpha=.92))
        if a > .9:
            ax.text(190, y + 14, t, color='white', fontsize=34, fontweight='bold', va='center'); ax.text(190, y - 32, s, color='white', fontsize=20, va='center', alpha=.9)
    if p > .7: ax.text(W / 2, 545, 'Sígueme para más lecturas del SPX en vivo', color=NAVY, fontsize=26, ha='center', fontweight='bold')

ESC = dict(intro=intro, apertura=apertura, manana=manana, herramientas=herramientas, hiro=hiro, decision=decision, clip_entrada=clip_entrada,
           espera=espera, cierre=cierre, clip_stop=clip_stop, despues=despues, resultados=resultados, error=error, leccion=leccion)
COLOR_TIT = dict(cierre=ROJO, clip_stop=ROJO, hiro='#2563eb', despues=VERDE, error='#2563eb')

if os.environ.get('PRUEBA'):
    os.makedirs(os.path.join(V, 'prueba'), exist_ok=True)
    for e in G:
        fig, ax = lienzo(); kicker(ax, e['kicker']); ESC[e['id']](fig, ax, .97); titular(ax, e['titular'], 1, COLOR_TIT.get(e['id'], NAVY))
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
    o = os.path.join(AUD, f"{e['id']}_pad.wav")
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', archivo[e['id']], '-af', f"apad=whole_dur={int(dur[e['id']] * FPS) / FPS}", '-ar', '44100', '-ac', '2', o]); partes.append(o)
open(lista, 'w').write(''.join(f"file '{x}'\n" for x in partes))
aud = os.path.join(V, f'voz_{VOZ}.wav')
subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lista, aud])
out = os.path.join(V, 'reel_trade_emerson_2026-11-25_cuerpo.mp4')  # luego envolver_marca.py pone la marca Iron Balls
subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-framerate', str(FPS), '-i', os.path.join(FR, '%05d.png'), '-i', aud,
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', out])
shutil.rmtree(FR, ignore_errors=True)
print('ok', out)
