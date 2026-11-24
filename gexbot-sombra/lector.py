# -*- coding: utf-8 -*-
"""
Lector de las capturas del barrido (19-nov-2026): saca números de las imágenes de GexBot Classic/State,
Tradytics, HIRO y la Bola 8 con Tesseract (gratis, local) y mide el histograma de GexBot Classic por píxel.

Todas las funciones reciben la ruta de un PNG y devuelven un dict (o None si no pudieron leer).
"""
import re
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

TESS = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
NUM = r"-?\d[\d,]*\.?\d*"


def _prep(im, escala=3, umbral=70):
    """Texto claro (de cualquier color) sobre fondo oscuro -> negro sobre blanco, agrandado."""
    im = im.convert("RGB")
    g = Image.eval(im.split()[0], lambda v: v)
    r, gg, b = im.split()
    mx = Image.merge("RGB", (r, gg, b)).point(lambda v: v)
    px = im.load()
    out = Image.new("L", im.size, 255)
    po = out.load()
    for y in range(im.size[1]):
        for x in range(im.size[0]):
            if max(px[x, y]) > umbral:
                po[x, y] = 0
    return out.resize((im.size[0] * escala, im.size[1] * escala), Image.LANCZOS)


def _prep_claro(im, escala=3):
    """Fondo claro (Bola 8, Tradytics): solo gris + agrandar."""
    return im.convert("L").resize((im.size[0] * escala, im.size[1] * escala), Image.LANCZOS)


def ocr(im, psm=6):
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        im.save(f.name)
        r = subprocess.run([TESS, f.name, "-", "--psm", str(psm)], capture_output=True, timeout=30, text=True, encoding="utf-8", errors="replace")
    Path(f.name).unlink(missing_ok=True)
    return r.stdout


def _num(s):
    try:
        return float(s.replace(",", ""))
    except Exception:
        return None


def _rel(im, x0, y0, x1, y1):
    """Recorte con coordenadas relativas a un cuadro de 1280x716 (el tamaño de la transmisión)."""
    W, H = im.size
    return im.crop((int(x0 * W / 1280), int(y0 * H / 716), int(x1 * W / 1280), int(y1 * H / 716)))


# ------------------------------------------------------------------ GexBot Classic
def gexbot_classic(ruta):
    im = Image.open(ruta).convert("RGB")
    t = ocr(_prep(_rel(im, 1005, 100, 1270, 480))).lower()
    d = {"texto": t}

    def busca(pat):
        m = re.search(pat + r"\s*(" + NUM + ")", t)
        return _num(m.group(1)) if m else None
    vol, _, oi = t.partition("open interest")
    oi, _, mc = oi.partition("max change")
    d["gamma_flip_gb"] = (lambda m: _num(m.group(1)) if m else None)(re.search(r"zero gamma\s*(" + NUM + ")", vol))
    def filas_major(sec):
        """Filas con número entre 'zero gamma' y 'net gex': 1.ª = major positive, 2.ª = major negative."""
        out = []
        for l in sec.splitlines():
            if "zero" in l or "net" in l:
                continue
            m = re.search(r"(\d{4}\.\d{2})\s*$", l.strip())
            if m:
                out.append(_num(m.group(1)))
        return out + [None, None]
    d["iman_pos_gb"], d["iman_neg_gb"] = filas_major(vol)[:2]
    d["iman_pos_gb_oi"], d["iman_neg_gb_oi"] = filas_major(oi)[:2]
    # 23-nov: el "major negative" va en rojo oscuro sobre negro y el OCR leyó 7200 como 4200. Si un imán queda a más de
    # 600 puntos del Gamma Flip GB se prueba cambiando el primer dígito por el del flip; si tampoco cuadra, se descarta.
    ref = d["gamma_flip_gb"]
    if ref:
        for c in ("iman_pos_gb", "iman_neg_gb", "iman_pos_gb_oi", "iman_neg_gb_oi"):
            v = d[c]
            if v is None or abs(v - ref) <= 600:
                continue
            arreglo = float(str(int(ref))[0] + f"{v:.2f}"[1:]) if v >= 1000 else None
            d[c] = arreglo if arreglo and abs(arreglo - ref) <= 600 else None
    d["cambio_gamma"] = _cambio_gamma(im)
    d.update(histograma(im, d.get("gamma_flip_gb")))
    d.pop("texto")
    return d


def _cambio_gamma(im):
    """'max change gex' de GexBot Classic (1, 5, 10, 15 y 30 min): strike y cambio en Bn.
    21-nov: el SIGNO sale del COLOR de la fila (verde = positivo, rojo = negativo), no del OCR, que perdía el '-' o lo leía
    como '~'. Cada celda se lee aparte con el canal más brillante (en gris el rojo queda tenue y el 5 salía 9)."""
    W, H = im.size
    X = lambda x: int(x * W / 1280)
    Y = lambda y: int(y * H / 716)
    px = im.load()
    verde = lambda R, G, B: G > R + 40 and G > B
    rojo = lambda R, G, B: R > G + 50 and R > B + 30
    # filas = franjas con texto de color en la columna del strike
    marcas = [any(verde(*px[x, y]) or rojo(*px[x, y]) for x in range(X(1085), X(1140))) for y in range(Y(360), Y(480))]
    filas, ini = [], None
    for i, on in enumerate(marcas + [False]):
        y = Y(360) + i
        if on and ini is None:
            ini = y
        elif not on and ini is not None:
            if y - ini >= Y(5):
                filas.append((ini, y))
            ini = None
    out = {}
    filas = filas[-5:]
    for ventana, (a, b) in zip((1, 5, 10, 15, 30)[5 - len(filas):], filas):
        ya, yb = a * 716 / H - 3, b * 716 / H + 3
        s = _ocr_celda(im, (X(1085), Y(ya), X(1140), Y(yb)), lista="0123456789", canal_max=True)
        v = _ocr_celda(im, (X(1160), Y(ya), X(1262), Y(yb)), lista="0123456789.-Bn", canal_max=True)
        ms, mv = re.search(r"\d{4}", s), re.search(r"(\d+\.\d{4})", v)
        g = r = 0
        for y in range(Y(ya), Y(yb)):
            for x in range(X(1160), X(1262)):
                c = px[x, y]
                g += verde(*c)
                r += rojo(*c)
        if ms and mv and (g or r):
            out[f"{ventana}m"] = {"strike": float(ms.group(0)), "valor_bn": float(mv.group(1)) * (-1 if r > g else 1)}
    return out


def _eje_precios(im, flip=None):
    """precio = a*y + b.
    El OCR de los dígitos del eje es malo, pero la POSICIÓN de las etiquetas sí es fiable: la separación entre
    etiquetas = 10 puntos (escala). El ancla es la caja celeste del spot a la izquierda (p. ej. '7177.56'),
    cuyo número sí se lee bien."""
    W, H = im.size
    px = im.load()
    y_ini = int(80 * H / 716)
    franja = im.crop((0, y_ini, int(62 * W / 1280), int(690 * H / 716)))
    esc = 3
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        _prep(franja, esc).save(f.name)
        r = subprocess.run([TESS, f.name, "-", "--psm", "6", "tsv"], capture_output=True, timeout=30, text=True, encoding="utf-8", errors="replace")
    Path(f.name).unlink(missing_ok=True)
    ys = []
    for linea in r.stdout.splitlines()[1:]:
        c = linea.split("\t")
        if len(c) >= 12 and c[11].strip() and int(c[9]) < 45 * esc / 3 * 2:
            ys.append((int(c[7]) + int(c[9]) / 2) / esc + y_ini)
    ys.sort()
    difs = sorted(b - a for a, b in zip(ys, ys[1:]) if b - a > 15)
    if not difs:
        return None
    px_por_10 = difs[len(difs) // 2]
    # caja celeste del spot (cian brillante) pegada al borde izquierdo
    cian = [(x, y) for y in range(y_ini, int(690 * H / 716)) for x in range(0, int(70 * W / 1280))
            if px[x, y][0] < 80 and px[x, y][1] > 200 and px[x, y][2] > 200]
    if not cian:
        return None
    yc = sorted(c[1] for c in cian)[len(cian) // 2]
    xs = [c[0] for c in cian]
    m9 = max(9, round(9 * H / 716))   # 23-nov: recorte en proporción al alto (capturas de 992 px cortaban los dígitos)
    caja = im.crop((min(xs), yc - m9, max(xs) + 2, yc + m9))
    inv = Image.eval(caja.convert("L"), lambda v: 255 - v).resize((caja.size[0] * 4, caja.size[1] * 4), Image.LANCZOS)
    m = re.search(r"(\d{4}\.?\d*)", ocr(inv, psm=7).replace(",", "."))
    a = -10.0 / px_por_10
    spot = float(m.group(1)) if m else None
    if spot and spot > 100000:
        spot /= 100
    # 20-nov: el OCR leyó 7107 como 1107; 21-nov: sin flip ese 1107 pasaba (histograma ~6000 puntos corrido): rango del SPX
    if spot and 3000 < spot < 15000 and (not flip or abs(spot - flip) < 300):
        return a, spot - a * yc
    # 20-nov: si el número del spot no se lee, ancla en la caja naranja del Gamma Flip GB (a la derecha del gráfico)
    if flip:
        nar = [y for y in range(y_ini, int(690 * H / 716)) for x in range(int(900 * W / 1280), int(985 * W / 1280))
               if px[x, y][0] > 220 and 130 < px[x, y][1] < 200 and px[x, y][2] < 60]
        if len(nar) > 20:
            return a, flip - a * sorted(nar)[len(nar) // 2]
    return None


def histograma(im, flip=None):
    """Barras rojas (gamma negativa, crecen a la izquierda del cero) y verdes (positiva, a la derecha)."""
    W, H = im.size
    px = im.load()
    eje = _eje_precios(im, flip)
    if not eje:
        return {"barras": []}
    a, b = eje
    xmax = int(990 * W / 1280)

    def rojo(p): return p[0] > 190 and p[1] < 120 and p[2] < 120
    def verde(p): return p[1] > 150 and p[0] < 130 and p[2] < 160 and p[1] - p[0] > 60
    filas = {}
    for y in range(int(85 * H / 716), int(690 * H / 716)):
        rx = [x for x in range(int(60 * W / 1280), xmax) if rojo(px[x, y])]
        gx = [x for x in range(int(60 * W / 1280), xmax) if verde(px[x, y])]
        filas[y] = (rx, gx)
    # el cero: donde terminan (a la derecha) las rachas rojas largas / empiezan las verdes.
    # 23-nov: con la racha CONTIGUA más larga de cada fila, no con el primer/último píxel: GexBot dibuja en el gráfico de
    # precios una línea verde fina del major positive (vertical entre strikes) y el mínimo de la fila caía en ella; el
    # cero se corría a la izquierda y todas las barras salían mal (8 barras diminutas, ninguna roja).
    def racha(xs):
        mejor, ini, prev = (0, None, None), None, None
        for x in xs:
            if prev is None or x - prev > 2:
                ini = x
            if x - ini + 1 > mejor[0]:
                mejor = (x - ini + 1, ini, x)
            prev = x
        return mejor
    LIM = int(470 * W / 1280)   # 23-nov: tope de largo en proporción al ancho (capturas de 1772 px recortaban la barra mayor)
    finales = []
    for rx, gx in filas.values():
        lr, _, fr = racha(rx)
        lg, ig, _ = racha(gx)
        if lr > 6:
            finales.append(fr)
        if lg > 6:
            finales.append(ig)
    if not finales:
        return {"barras": []}
    finales.sort()
    x0 = finales[len(finales) // 2]
    barras, filas_k = {}, {}
    for y, (rx, gx) in filas.items():
        # 20-nov: largo = de punta a punta (los puntos azules interrumpen la barra y contar píxeles la acortaba)
        rr = [x for x in rx if x0 - LIM <= x <= x0 + 2]
        largo_r = (x0 - min(rr)) if len(rr) >= 4 else 0
        # solo píxeles con grosor (verde también arriba o abajo): la línea del spot mide 1 px y no es barra
        gg = [x for x in gx if x0 - 2 <= x <= x0 + LIM and (verde(px[x, y - 1]) or verde(px[x, y + 1]))]
        largo_g = (max(gg) - x0) if len(gg) >= 4 else 0
        if max(largo_r, largo_g) < 4:
            continue
        k = round((a * y + b) / 5) * 5
        valor = -largo_r if largo_r >= largo_g else largo_g
        filas_k.setdefault(k, []).append(y)
        if abs(valor) > abs(barras.get(k, 0)):
            barras[k] = valor

    # Sombra (barra oscura debajo de cada barra, pegada al cero) y puntos azules de "max change" (20-nov, control de
    # calidad contra el original: GexBot los dibuja y la capa debe verse igual)
    # 23-nov: la barra oscura es la gamma por OPEN INTEREST (comprobado con la captura del 20-nov 9:45: verdes claras
    # por volumen con oscuras ROJAS al otro lado, net gex OI -15,6, la más larga en el major negative OI 7100). Puede ir
    # al lado CONTRARIO de la barra clara, así que se busca a los dos lados: roja oscura a la izquierda, verde oscura a
    # la derecha. Antes solo se miraba del lado de la clara y se perdían justo los casos de flujo contra posicionamiento.
    def oscuro_r(p): return 90 < p[0] <= 190 and p[1] < 60 and p[2] < 60
    def oscuro_v(p): return 35 < p[1] <= 150 and p[0] < 50 and p[2] < 90 and p[1] > p[0] + 25
    def azul(p): return p[2] > 100 and p[2] > p[0] + 40 and p[0] < 160 and not rojo(p)
    sombras, puntos = {}, {}

    def largo_oscuro(y, paso, color):
        x, hueco, ext = x0 + (0 if paso < 0 else 1), 0, 0
        while 0 < x < W - 1 and abs(x - x0) < LIM and hueco <= 3:
            if color(px[x, y]):
                ext, hueco = abs(x - x0), 0
            else:
                hueco += 1
            x += paso
        return ext

    for k, ys in filas_k.items():
        y1, y2 = min(ys), max(ys)
        neg = barras[k] < 0
        izq, der = [], []
        for y in range(y2 + 1, min(H - 1, y2 + 11)):
            izq.append(largo_oscuro(y, -1, oscuro_r))
            der.append(largo_oscuro(y, 1, oscuro_v))
        # la sombra tiene varias filas de grosor; una sola fila larga es la línea punteada de major negative/positive
        izq.sort(reverse=True); der.sort(reverse=True)
        mi = izq[1] if len(izq) > 1 else 0
        md = der[1] if len(der) > 1 else 0
        if max(mi, md) >= 3:
            sombras[k] = -mi if mi > md else md
        vistos = []
        for y in range(max(0, y1 - 3), min(H - 1, y2 + 7)):
            xs = [x for x in range(max(0, x0 - LIM), min(W - 1, x0 + LIM)) if azul(px[x, y])]
            grupos, g = [], []
            for x in xs:
                if g and x - g[-1] > 2:
                    grupos.append(g); g = []
                g.append(x)
            if g:
                grupos.append(g)
            for g in grupos:
                if len(g) < 2:
                    continue
                cx = sum(g) // len(g)
                if any(abs(cx - v[0]) <= 3 for v in vistos):
                    continue
                c = px[cx, y]
                vistos.append((cx, [c[0], c[1], c[2]]))
        # solo los puntos del lado de su barra y dentro de su largo (+20 px): fuera de eso son la línea de la hora o velas
        tope = max(abs(barras[k]), abs(sombras.get(k, 0))) + 90
        pts = [[cx - x0, col] for cx, col in sorted(vistos) if (cx - x0 <= 3 if neg else cx - x0 >= -3) and abs(cx - x0) <= tope]
        if pts:
            puntos[k] = pts
    return {"barras": sorted(barras.items()), "sombras": sorted(sombras.items()),
            "puntos": sorted(puntos.items()), "cero_x": x0}


# ------------------------------------------------------------------ GexBot State
def histograma_state(im, acel=None):
    """Histograma de GexBot State (20-nov): barras CIAN (long gamma) hacia la derecha del cero y VIOLETAS (short gamma)
    hacia la izquierda, cada una en su strike. Escala con la separación de etiquetas del eje; ancla = recuadro violeta
    del acelerador (en State hay dos recuadros cian, el del precio y el del freno, y se confunden)."""
    W, H = im.size
    px = im.load()
    eje = _eje_precios(im)
    if not eje or not acel:
        return {"barras": []}
    a = eje[0]
    y_ini, y_fin = int(80 * H / 716), int(690 * H / 716)
    viol_caja = [y for y in range(y_ini, y_fin) for x in range(int(68 * W / 1280), int(135 * W / 1280))
                 if px[x, y][0] > 110 and px[x, y][1] < 100 and px[x, y][2] > 130]
    if len(viol_caja) >= 20:
        yv = sorted(viol_caja)[len(viol_caja) // 2]
        b = acel - a * yv
    else:
        # el acelerador quedó fuera del gráfico (sin recuadro violeta): se usa el ancla del eje (auditoría 20-nov:
        # 9 de 31 capturas salían sin barras por esto)
        b = eje[1]

    def cian(p): return p[0] < 90 and p[1] > 170 and p[2] > 190
    def viol(p): return p[0] > 120 and p[1] < 120 and p[2] > 160
    x0 = int(520 * W / 1280)

    def extension(y, es, paso):
        x, hueco, ext = x0 + (1 if paso > 0 else 0), 0, 0
        while 0 < x < int(985 * W / 1280) and hueco <= 10:   # los puntos de cambio (hasta ~8 px) interrumpen la barra
            if es(px[x, y]):
                ext, hueco = abs(x - x0), 0
            elif ext and (cian(px[x, y]) or viol(px[x, y])):   # un punto del otro color no corta la barra, pero tampoco la alarga
                hueco = 0
            else:
                hueco += 1
            x += paso
        return ext
    barras, filas_k = {}, {}
    for y in range(y_ini, y_fin):
        c, v = extension(y, cian, 1), extension(y, viol, -1)
        if max(c, v) < 4:
            continue
        # grosor: la misma barra también en la fila de arriba o de abajo (descarta líneas de 1 px)
        if c >= 4 and not (cian(px[x0 + 2, y - 1]) or cian(px[x0 + 2, y + 1])):
            c = 0
        if v >= 4 and not (viol(px[x0 - 2, y - 1]) or viol(px[x0 - 2, y + 1])):
            v = 0
        if max(c, v) < 4:
            continue
        k = round((a * y + b) / 5) * 5
        cc, vv = barras.get(k, (0, 0))
        barras[k] = (max(cc, c), max(vv, v))
        filas_k.setdefault(k, []).append(y)
    # Puntos de cambio (como en Classic): racimos cortos cian/violeta/azules que no son parte de la barra
    def color_punto(p): return cian(p) or viol(p) or (p[2] > 110 and p[2] > p[0] + 40 and p[1] < 200)
    puntos = {}
    for k, ys in filas_k.items():
        c_len, v_len = barras[k]
        vistos = []
        for y in range(min(ys) - 3, max(ys) + 4):
            if not (0 <= y < H):
                continue
            g = []
            for x in list(range(max(1, x0 - 470), min(W - 1, x0 + 470))) + [None]:
                if x is not None and color_punto(px[x, y]):
                    g.append(x); continue
                if 2 <= len(g) <= 10:
                    cx = sum(g) // len(g)
                    # fuera del cuerpo de su barra (o más allá de su punta) y no pegado al cero
                    en_barra = (x0 < cx <= x0 + c_len - 3) or (x0 - v_len + 3 <= cx < x0)
                    # un punto es REDONDO: 3-9 filas de alto (la raya del freno/acelerador mide 1-2; las velas, más)
                    alto = 1
                    for d_ in (-1, 1):
                        yy = y + d_
                        while 0 <= yy < H and color_punto(px[cx, yy]) and alto < 14:
                            alto += 1; yy += d_
                    if 3 <= alto <= 9 and abs(cx - x0) > 3 and not en_barra and not any(abs(cx - v[0]) <= 3 for v in vistos):
                        q = px[cx, y]; vistos.append((cx, [q[0], q[1], q[2]]))
                g = []
        tope = max(c_len, v_len) + 90
        pts = [[cx - x0, col] for cx, col in sorted(vistos) if abs(cx - x0) <= tope]
        if pts:
            puntos[k] = pts
    # Columnas del "options profile" (20-nov, control de calidad): un punto ROJO y uno VERDE por strike a la derecha;
    # se guarda su desplazamiento en px respecto del centro de las columnas (x = 895 en una captura de 1280 de ancho)
    rojo_p = lambda p: p[0] > 180 and p[1] < 80 and p[2] < 80
    verde_p = lambda p: p[1] > 180 and p[0] < 150 and p[2] < 120
    xc = int(895 * W / 1280); xa_, xb_ = int(840 * W / 1280), int(965 * W / 1280)
    perfil = {}
    for y in range(y_ini, y_fin):
        r_ = [x for x in range(xa_, xb_) if rojo_p(px[x, y])]
        g_ = [x for x in range(xa_, xb_) if verde_p(px[x, y])]
        if len(r_) < 2 and len(g_) < 2:
            continue
        k = round((a * y + b) / 5) * 5
        d_ = perfil.setdefault(k, {"r": [], "g": []})
        if len(r_) >= 2: d_["r"].append(sum(r_) / len(r_) - xc)
        if len(g_) >= 2: d_["g"].append(sum(g_) / len(g_) - xc)
    perfil_l = [[k, round(sum(v["r"]) / len(v["r"]), 1) if v["r"] else None, round(sum(v["g"]) / len(v["g"]), 1) if v["g"] else None]
                for k, v in sorted(perfil.items())]
    return {"barras": [[k, cv[0], -cv[1]] for k, cv in sorted(barras.items())], "puntos": sorted(puntos.items()), "perfil": perfil_l}


def _rel_panel(im, x0, y0, x1, y1):
    """24-nov: recorte del PANEL DERECHO de State. Cuando la ventana es más alta que 16:9 (1772x1042) el panel no se
    estira: le sale una fila extra arriba ("next (11/25)") y todo baja la diferencia de alto. Las coordenadas son las
    del cuadro de 1280x716 a la altura 'normal' (W*716/1280) más ese corrimiento."""
    W, H = im.size
    hb = W * 716 / 1280
    dy = max(0, H - hb)
    return im.crop((int(x0 * W / 1280), int(y0 * hb / 716 + dy), int(x1 * W / 1280), int(y1 * hb / 716 + dy)))


def gexbot_state(ruta):
    im = Image.open(ruta).convert("RGB")
    _rel = _rel_panel   # en State todos los recortes de esta función son del panel derecho
    crudo = ocr(_prep(_rel(im, 1005, 320, 1270, 480))).lower()
    t = crudo.replace(" ", "")
    d = {}
    # 20-nov: por ORDEN de filas (el OCR destroza "gamma"/"short": "gamwna", "shori"): 1.ª fila "major" = long gamma
    # (freno), 2.ª = short gamma (acelerador); el número es el último de la fila
    mayores = []
    for l in crudo.splitlines():
        if "maj" in l or "gam" in l:
            m = re.search(r"(\d{4}\.\d+)\s*$", l.strip())
            if m:
                mayores.append(_num(m.group(1)))
    mayores += [None, None]
    d["freno_gamma"], d["acelerador_gamma"] = mayores[0], mayores[1]
    # Lectura principal: solo la columna de valores, ampliada y con dígitos (el OCR de la fila completa se come un
    # dígito: "7100.000" -> "700.000"). Control de calidad 20-nov: 31/31 capturas correctas.
    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            _prep(_rel(im, 1140, 437, 1272, 478), 4).save(f.name)
            r = subprocess.run([TESS, f.name, "-", "--psm", "6", "-c", "tessedit_char_whitelist=0123456789."],
                               capture_output=True, timeout=30, text=True, encoding="utf-8", errors="replace")
        Path(f.name).unlink(missing_ok=True)
        vals = [_num(x) for x in re.findall(r"\d{4}\.\d+", r.stdout)]
        if len(vals) >= 2 and all(1000 < v < 20000 for v in vals[:2]):
            d["freno_gamma"], d["acelerador_gamma"] = vals[0], vals[1]
    except Exception:
        pass
    try:
        d.update(histograma_state(im, d.get("acelerador_gamma")))
    except Exception:
        d["barras"] = []
    m = re.search(r"spot(" + NUM + ")", t)
    d["spot"] = _num(m.group(1)) if m else None
    if d["spot"] and d["spot"] > 100000:   # el OCR a veces se come el punto: 717756 -> 7177.56
        d["spot"] /= 100
    return d


# ------------------------------------------------------------------ Tradytics (página "Options market")
def tradytics(ruta):
    im = Image.open(ruta).convert("RGB")
    t = ocr(_prep_claro(im, 2), psm=3).lower()
    d = {"sentimiento": None}
    m = re.search(r"leaning\s+(bullish|bearish)", t) or re.search(r"\b(bullish|bearish|neutral)\b", t)
    if m:
        d["sentimiento"] = m.group(1)
    m = re.search(r"spent\s*\$?\s*(" + NUM + r")\s*([mb])\s*more on (puts|calls)", t)
    if m:
        d["exceso_prima"] = {"monto": _num(m.group(1)), "unidad": m.group(2), "lado": m.group(3)}
    # 20-nov (control de calidad): las tres tarjetas de arriba, igual que en la página original
    try:
        W, H = im.size
        tc = ocr(_prep_claro(im.crop((int(W * .148), int(H * .138), int(W * .992), int(H * .342))), 2), psm=6)
        tl = tc.lower()
        m = re.search(r"\b(bullish|bearish|neutral)\b", tl)
        if m:
            d["sentimiento"] = m.group(1)
        m = re.search(r"spent\s*\$?\s*(\d+(?:\.\d+)?)\s*([mb])\s*more on (puts|calls)", tl)
        if m:
            d["exceso_prima"] = {"monto": float(m.group(1)), "unidad": m.group(2), "lado": m.group(3)}
        m = re.search(r"\$\s*(\d{3}\.\d{2})\s*[-–]\s*\$\s*(\d{3}\.\d{2})", tc)
        if m:
            d["spy_rango"] = [float(m.group(1)), float(m.group(2))]
        m = re.search(r"spy is at \$\s*(\d{3}\.\d{2})", tl)
        if m:
            d["spy"] = float(m.group(1))
        m = re.search(r"\b(iv (?:near|above|below|elevated|cheap|rich|in line)[a-z ]*?)(?:\n|$|  )", tl)
        if m:
            d["vol"] = m.group(1).strip()
        m = re.search(r"options price ([\d.]+)% daily swings, ([a-z ]+?) the ([\d.]+)%", tl)
        if m:
            d["vol_detalle"] = {"implicita": float(m.group(1)), "relacion": m.group(2).strip(), "realizada": float(m.group(3))}
    except Exception:
        pass
    return d


# ------------------------------------------------------------------ HIRO
def _eje_hiro(im):
    """Escala del eje derecho de HIRO: valor (miles de millones) = a*y + b, leyendo las etiquetas (200M, -400M, -1B...).
    Devuelve (a, b, paso_entre_etiquetas) o None."""
    W, H = im.size
    x_a, x_b, y_a, y_b = int(W * 0.926), int(W * 0.977), int(H * 0.2), int(H * 0.92)
    c = im.crop((x_a, y_a, x_b, y_b))
    g = c.convert("L").point(lambda v: 0 if v > 120 else 255).resize((c.width * 3, c.height * 3), Image.LANCZOS)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        g.save(f.name)
        r = subprocess.run([TESS, f.name, "-", "--psm", "6", "tsv"], capture_output=True, timeout=30, text=True, encoding="utf-8", errors="replace")
    Path(f.name).unlink(missing_ok=True)
    pts = []
    for l in r.stdout.splitlines()[1:]:
        q = l.split("	")
        if len(q) < 12 or not q[11].strip():
            continue
        tok = q[11].strip().replace("O", "0").replace("D", "0").replace("o", "0")
        m = re.match(r"^[-“”~—–]?\s*(\d+(?:\.\d+)?)\s*([MB])$", tok)
        if not m:
            continue
        mag = float(m.group(1)) / (1000 if m.group(2) == "M" else 1)
        y = (int(q[7]) + int(q[9]) / 2) / 3 + y_a
        pts.append((y, mag))
    if len(pts) < 3:
        return None
    # el signo: el eje baja hacia abajo; se prueba dónde está el cero (entre etiquetas) y se queda el mejor ajuste lineal
    pts.sort()
    mejor = None
    for corte in range(len(pts) + 1):
        vals = [(y, m if i < corte else -m) for i, (y, m) in enumerate(pts)]
        n = len(vals); my = sum(y for y, _ in vals) / n; mv = sum(v for _, v in vals) / n
        sxx = sum((y - my) ** 2 for y, _ in vals)
        if not sxx:
            continue
        a = sum((y - my) * (v - mv) for y, v in vals) / sxx
        b = mv - a * my
        err = sum((v - (a * y + b)) ** 2 for y, v in vals)
        if a < 0 and (mejor is None or err < mejor[0]):
            mejor = (err, a, b)
    if not mejor:
        return None
    _, a, b = mejor
    difs = sorted(abs(a) * (pts[i + 1][0] - pts[i][0]) for i in range(len(pts) - 1) if pts[i + 1][0] - pts[i][0] > 15)
    paso = difs[len(difs) // 4] if difs else 0.1   # cuartil bajo: entre etiquetas vecinas (hay saltos por etiquetas no leídas)
    # confiable si las etiquetas caen sobre la recta (error medio < 1/4 de paso) y hay al menos 4
    rms = (mejor[0] / len(pts)) ** 0.5
    return a, b, paso, len(pts) >= 4 and rms < 0.25 * paso


def _empieza_con_menos(caja):
    """¿El primer carácter blanco del recuadro es una raya horizontal corta (signo menos)?"""
    W, H = caja.size
    px = caja.load()
    cols = [x for x in range(W) if any(px[x, y] > 185 for y in range(H))]
    if not cols:
        return False
    seg = [cols[0]]
    for x in cols[1:]:
        if x - seg[-1] > 1:
            break
        seg.append(x)
    filas = [y for y in range(H) if any(px[x, y] > 185 for x in seg)]
    alto, ancho = (max(filas) - min(filas) + 1) if filas else 99, len(seg)
    return alto <= max(3, H // 5) and ancho >= 3


def _hiro_caja(im, azul):
    """Valor de la etiqueta azul del eje derecho (HIRO total acumulado), p. ej. 2.71B.
    La caja es un RELLENO azul horizontal (la línea azul del gráfico es fina): se buscan filas con una racha
    larga de azul en la franja del eje (~90-98 % del ancho)."""
    W, H = im.size
    px = im.load()
    x0, x1 = int(W * 0.90), int(W * 0.975)
    filas = []
    for y in range(int(H * 0.05), int(H * 0.95)):
        # 20-nov: se CUENTAN los píxeles del color (el texto blanco parte el relleno en rachas cortas, p. ej. "707M");
        # la línea del gráfico mide 1-2 px y no llega a 12
        xs = [x for x in range(x0, x1) if azul(px[x, y])]
        if len(xs) >= 12:
            filas.append((y, min(xs), max(xs) + 1))
    if not filas:
        return {"hiro_bn": None}
    bloques, cur = [], [filas[0]]
    for f in filas[1:]:
        if f[0] - cur[-1][0] > 2:
            bloques.append(cur); cur = []
        cur.append(f)
    bloques.append(cur)
    def blancos(b):   # la caja del valor tiene texto blanco adentro; el botón/línea no
        ya, yb = b[0][0], b[-1][0]
        xa, xb = min(f[1] for f in b), max(f[2] for f in b)
        return sum(1 for y in range(ya, yb + 1) for x in range(xa, xb) if min(px[x, y]) > 180)
    cand = [b for b in bloques if 6 <= b[-1][0] - b[0][0] <= 22]
    if not cand:
        return {"hiro_bn": None}
    b = max(cand, key=blancos)
    ya, yb = b[0][0], b[-1][0]
    xa, xb = min(f[1] for f in b), max(f[2] for f in b)
    from PIL import ImageOps
    caja = im.crop((xa - 4, ya - 3, xb + 10, yb + 4)).convert("L")   # 20-nov: más ancho (la M quedaba cortada)
    import os
    if os.environ.get("DEBUG_HIRO"): print("caja", xa, ya, xb, yb, [ (b[0][0], b[-1][0]) for b in cand])
    t = ""
    cands = []
    # Mejor variante medida (19-nov): gris invertido x10 + borde blanco, psm 7. El punto decimal casi siempre
    # se pierde ("271B" = 2.71B): HIRO muestra 2 decimales, asi que se repone.
    for esc, umbral in ((6, 200), (10, 200), (10, None), (8, 170), (6, None)):   # (6/10, 200) = solo el texto blanco
        g = Image.eval(caja, (lambda v: 255 - v) if umbral is None else (lambda v, u=umbral: 0 if v > u else 255))
        g = ImageOps.expand(g.resize((caja.size[0] * esc, caja.size[1] * esc), Image.LANCZOS), border=20, fill=255)
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            g.save(f.name)
            r = subprocess.run([TESS, f.name, "-", "--psm", "7", "-c", "tessedit_char_whitelist=0123456789.-BMK"],
                               capture_output=True, timeout=30, text=True, encoding="utf-8", errors="replace")
        Path(f.name).unlink(missing_ok=True)
        t = r.stdout.strip()
        if os.environ.get("DEBUG_HIRO"): print("variante", esc, umbral, repr(t))
        # la "B" final se lee muchas veces como "8": "2718" = 2.71B
        if re.fullmatch(r"-?\d{3,}8", t) or re.fullmatch(r"-?\d+\.\d\d8", t):   # también "-1.498" = -1.49B
            t = t[:-1] + "B"
        # una B EN MEDIO del número es un 8 ("-1B4M" = -184M, "-B06M" = -806M): solo la última letra es la unidad
        if len(t) > 1 and t[-1] in "MBK":
            t = t[:-1].replace("B", "8") + t[-1]
        m = re.search(r"(-?)(\d+)(\.\d+)?\s*([MBK])", t)
        if m:
            entero, dec = m.group(2), m.group(3)
            u = m.group(4)
            # 20-nov: HIRO muestra 2 decimales SOLO en B ("2.62B"); en M va entero ("803M"): si no, 803M salía 0,008 B
            if not dec and len(entero) >= 3 and u == "B":
                entero, dec = entero[:-2], "." + entero[-2:]
            v = float(m.group(1) + entero + (dec or ""))
            # 20-nov: el OCR se come el signo menos ("-482M" -> "482M"): se mira la forma del primer carácter blanco
            if v > 0 and _empieza_con_menos(caja):
                v = -v
            u = m.group(4)
            cands.append((v / 1000 if u == "M" else v / 1e6 if u == "K" else v, t))
    # 20-nov: se elige la lectura que coincide con la ALTURA del recuadro en el eje (el OCR a veces lee mal:
    # "-184M" salía "-1.0B"); si ninguna coincide, se usa el valor que da el eje en esa altura
    yc = (ya + yb) / 2
    eje = _eje_hiro(im)
    if not cands:
        return {"hiro_bn": None, "texto": t}
    if eje and len({round(c[0], 4) for c in cands}) > 1:
        a_, b_, paso, ok = eje
        if ok:   # el eje solo ELIGE entre lecturas del OCR (la más cercana a la altura del recuadro); nunca las reemplaza
            est = a_ * yc + b_
            c = min(cands, key=lambda c: abs(c[0] - est))
            return {"hiro_bn": c[0], "texto": c[1]}
    return {"hiro_bn": cands[0][0], "texto": cands[0][1]}



def hiro(ruta):
    """HIRO real (modo Put/Call): recuadro AZUL = calls, NARANJA = puts, en miles de millones.
    hiro_bn se mantiene (= el azul) por compatibilidad con la confluencia."""
    im = Image.open(ruta).convert("RGB")
    c = _hiro_caja(im, lambda p: p[2] > 170 and p[2] - p[0] > 90 and p[1] > 70)
    p = _hiro_caja(im, lambda q: q[0] > 180 and 80 < q[1] < 160 and q[2] < 100 and q[0] - q[2] > 100)
    try:   # 20-nov: la curva COMPLETA del día (la imagen la trae dibujada entera)
        curva = hiro_curva(im, c.get("hiro_bn"), p.get("hiro_bn"))
    except Exception:
        curva = []
    return {"hiro_bn": c.get("hiro_bn"), "calls_bn": c.get("hiro_bn"), "puts_bn": p.get("hiro_bn"),
            "texto": c.get("texto"), "texto_puts": p.get("texto"), "curva": curva}


# ------------------------------------------------------------------ Bola 8 (Sonar)
def _fuerza01(v):
    """La fuerza se usa en escala 0-1 (umbral 0.6 en confluencia). Si llega como porcentaje (72 o 72%) se pasa a 0.72;
    un valor fuera de 0-100 se descarta (lectura mala) en vez de votar con él."""
    if v is None:
        return None
    if 1 < v <= 100:
        v = v / 100
    return v if 0 <= v <= 1 else None


def bola8_sonar(ruta):
    im = Image.open(ruta).convert("RGB")
    W, H = im.size
    t = ocr(_prep_claro(im.crop((int(W * 0.6), 0, W, int(H * 0.45))), 3)).lower()
    d = {}
    m = re.search(r"bias:?\s*(bullish|bearish|neutral)", t)
    d["sesgo"] = m.group(1) if m else None
    m = re.search(r"strength:?\s*(" + NUM + ")", t)
    d["fuerza"] = _fuerza01(_num(m.group(1))) if m else None
    m = re.search(r"target\s*1:?\s*(" + NUM + ")", t)
    d["objetivo1"] = _num(m.group(1)) if m else None
    m = re.search(r"target\s*2:?\s*(" + NUM + ")", t)
    d["objetivo2"] = _num(m.group(1)) if m else None
    m = re.search(r"price:?\s*(" + NUM + ")", t)
    d["precio"] = _num(m.group(1)) if m else None
    try:
        d["curva"] = sonar_curva(im)
    except Exception:
        d["curva"] = []
    return d


def sonar_curva(im):
    """Curva 'Sonar' de la Bola 8 (20-nov, control de calidad): [[strike, valor 0-1], ...].
    Gráfico de matplotlib: marco negro (x = 0..1 entre sus bordes), eje de strikes a la derecha (etiquetas OCR)."""
    W, H = im.size
    px = im.load()
    negro = lambda p: max(p) < 60
    # bordes del marco: columnas con una línea negra vertical larga
    cols = [x for x in range(W) if sum(1 for y in range(int(H * .15), int(H * .85)) if negro(px[x, y])) > H * .5]
    if len(cols) < 2:
        return []
    xa, xb = min(cols), max(cols)
    filas = [y for y in range(H) if sum(1 for x in range(xa, xb) if negro(px[x, y])) > (xb - xa) * .8]
    ya, yb = min(filas), max(filas)
    # eje de strikes: etiquetas a la derecha del marco
    c = im.crop((xb + 4, ya - 10, min(W, xb + 60), yb + 10))
    g = c.convert("L").resize((c.width * 3, c.height * 3), Image.LANCZOS)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        g.save(f.name)
        r = subprocess.run([TESS, f.name, "-", "--psm", "6", "tsv", "-c", "tessedit_char_whitelist=0123456789"],
                           capture_output=True, timeout=30, text=True, encoding="utf-8", errors="replace")
    Path(f.name).unlink(missing_ok=True)
    pts = []
    for l in r.stdout.splitlines()[1:]:
        q = l.split("	")
        if len(q) >= 12 and re.fullmatch(r"\d{4}", q[11].strip() or "x"):
            pts.append(((int(q[7]) + int(q[9]) / 2) / 3 + ya - 10, int(q[11])))
    if len(pts) < 3:
        return []
    n = len(pts); my = sum(y for y, _ in pts) / n; mk = sum(k for _, k in pts) / n
    a = sum((y - my) * (k - mk) for y, k in pts) / sum((y - my) ** 2 for y, _ in pts)
    b = mk - a * my
    y_de = lambda k: (k - b) / a
    azul = lambda p: p[2] > 200 and p[2] - p[0] > 40 and p[0] < 200 and p[1] < 200
    # fuera de la leyenda (arriba a la derecha del marco: tiene una rayita azul "Sonar")
    leyenda = lambda x, y: x > xa + 0.78 * (xb - xa) and y < ya + 0.22 * (yb - ya)
    xs_fila = lambda y: [x for x in range(xa + 1, xb - 1) if azul(px[x, int(round(y))]) and not leyenda(x, y)]
    k_ini, k_fin = int(round(min(a * ya + b, a * yb + b) / 5) * 5), int(round(max(a * ya + b, a * yb + b) / 5) * 5)
    vert, tapados = {}, []
    for k in range(k_ini, k_fin + 1, 5):
        y = y_de(k)
        if not (ya + 2 < y < yb - 2):
            continue
        xs = xs_fila(y)
        if not xs:   # vértice tapado (p. ej. por la línea gruesa del objetivo): se proyecta después
            tapados.append(k); continue
        arriba, abajo = xs_fila(y - 3), xs_fila(y + 3)
        mx = sum(xs) / len(xs)
        ma = sum(arriba) / len(arriba) if arriba else mx
        mb = sum(abajo) / len(abajo) if abajo else mx
        if ma < mx and mb < mx:      # pico: la punta es fina, se busca el máximo en ±2 filas
            x = max(xx for dy in (-2, -1, 0, 1, 2) for xx in (xs_fila(y + dy) or [0]))
        elif ma > mx and mb > mx:    # valle
            x = min(xx for dy in (-2, -1, 0, 1, 2) for xx in (xs_fila(y + dy) or [10 ** 6]))
        else:
            # vértice en un tramo que sigue de largo: está entre los píxeles de la fila de arriba y los de la de abajo
            # (con un tramo casi horizontal la mediana se corre; 7105 daba 0,34 y el original es 0,26)
            # el eje tiene ~2 px de imprecisión: se busca en ±4 filas la fila donde la línea CAMBIA de dirección
            cen = {}
            for r_ in range(int(round(y)) - 6, int(round(y)) + 7):
                q_ = xs_fila(r_)
                if q_:
                    cen[r_] = sum(q_) / len(q_)
            mejor_r, mejor_c = None, -1
            for r_ in range(int(round(y)) - 4, int(round(y)) + 5):
                if r_ - 1 in cen and r_ in cen and r_ + 1 in cen:
                    curv = abs((cen[r_ + 1] - cen[r_]) - (cen[r_] - cen[r_ - 1]))
                    if curv > mejor_c:
                        mejor_r, mejor_c = r_, curv
            x = cen[mejor_r] if mejor_r is not None else sorted(xs)[len(xs) // 2]
        vert[k] = x
    # vértices tapados: se proyecta cada tramo (desde el vértice vecino, pasando por el último píxel visible) hasta la fila
    for k in tapados:
        y = y_de(k); est = []
        for vec, paso in ((k - 5, 1), (k + 5, -1)):
            if vec not in vert:
                continue
            yv = y_de(vec)
            for dy in range(1, 15):
                yy = y + (dy if yv > y else -dy)
                if (yy - y) * (yv - y) <= 0 or abs(yy - y) >= abs(yv - y):
                    break
                xs = xs_fila(yy)
                if xs:
                    xp = min(xs, key=lambda x: abs(x - (vert[vec] + (x - vert[vec]))))   # el píxel del tramo
                    xp = max(xs) if vert[vec] < max(xs) else min(xs)
                    est.append(vert[vec] + (xp - vert[vec]) * (y - yv) / (yy - yv))
                    break
        if est:
            vert[k] = sum(est) / len(est)
    return [[k, round(min(1.0, max(0.0, (vert[k] - xa) / (xb - xa))), 3)] for k in sorted(vert)]


def bola8_texto(ruta):
    """Bola 8 en texto (desde 20-nov, v1.0.37). Sesgo = 'Trend' (Up/Down), con su 'Strength', como el Sonar."""
    t = Path(ruta).read_text(encoding="utf-8").lower()

    def num(pat):
        m = re.search(pat + r":?\s*\$?(" + NUM + ")", t)
        return _num(m.group(1)) if m else None
    m = re.search(r"(?m)^trend:?\s*(up|down|neutral|sideways)", t)
    sesgo = {"up": "bullish", "down": "bearish"}.get(m.group(1), "neutral") if m else None
    bias = lambda pat: (lambda x: x.group(1) if x else None)(re.search(pat + r":?\s*(bullish|bearish|neutral)", t))
    return {"sesgo": sesgo, "fuerza": _fuerza01(num(r"strength")), "objetivo1": num(r"target 1"), "objetivo2": num(r"target 2"),
            "precio": num(r"(?m)^price"), "cierre_previsto": num(r"predicted close"), "calls": num(r"(?m)^calls"),
            "puts": num(r"(?m)^puts"), "sesgo_corto": bias(r"short term bias"), "sesgo_largo": bias(r"long term bias")}


# ------------------------------------------------------------------ Quant Data (escenario "option flow")
def _ocr_celda(im, caja, lista=None, psm=7, esc=4, umbral=None, canal_max=False):
    """OCR de una celda: por defecto gris invertido x4 con borde (control de calidad 20-nov: lee bien 119, 9, 7040,
    2:13:52, $46.50K que en blanco/negro salían 19, vacío, 7046, 2:43:52, $48.5K); umbral=N para letras grises."""
    from PIL import ImageOps
    c = im.crop(caja)
    c = Image.fromarray(np.asarray(c.convert("RGB")).max(axis=2)) if canal_max else c.convert("L")
    g = ImageOps.invert(c) if umbral is None else c.point(lambda v, u=umbral: 0 if v > u else 255)
    g = ImageOps.expand(g.resize((c.width * esc, c.height * esc), Image.LANCZOS), border=10, fill=255)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        g.save(f.name)
        cmd = [TESS, f.name, "-", "--psm", str(psm)] + (["-c", "tessedit_char_whitelist=" + lista] if lista else [])
        r = subprocess.run(cmd, capture_output=True, timeout=30, text=True, encoding="utf-8", errors="replace")
    Path(f.name).unlink(missing_ok=True)
    return r.stdout.strip()


def quantdata(ruta):
    """Quant Data 'Consolidated Order Flow' (20-nov): resumen de arriba y una fila por orden.
    Columnas en proporción al ancho (captura de 1920). El sentimiento sale del COLOR del punto (verde/rojo)."""
    im = Image.open(ruta).convert("RGB")
    W, H = im.size
    px = im.load()
    sx = lambda x: int(x * W / 1920)
    sy = lambda y: int(y * H / 1034)
    d = {"resumen": {}, "filas": []}
    t = _ocr_celda(im, (sx(30), sy(148), sx(800), sy(190)), psm=6, esc=2, umbral=110)
    d["resumen"]["texto"] = t
    m = re.search(r"(Bullish|Bearish|Neutral)", t)
    d["resumen"]["sentimiento"] = m.group(1).lower() if m else None
    m = re.search(r"(\d+(?:\.\d+)?)\s*%", t)
    d["resumen"]["put_call_ratio"] = float(m.group(1)) if m else None
    m = re.search(r"(\d+(?:\.\d+)?)\s*K\s*/\s*(\d+(?:\.\d+)?)\s*K", t)
    if m:
        d["resumen"]["vol_puts_k"], d["resumen"]["vol_calls_k"] = float(m.group(1)), float(m.group(2))
    m = re.search(r"\$\s*(\d+(?:\.\d+)?)\s*([KMB])\s*/\s*\$\s*(\d+(?:\.\d+)?)\s*([KMB])", t)
    mult = {"K": 1e3, "M": 1e6, "B": 1e9}
    if m:
        d["resumen"]["prima_puts"] = float(m.group(1)) * mult[m.group(2)]
        d["resumen"]["prima_calls"] = float(m.group(3)) * mult[m.group(4)]
    # filas: renglones con texto en la columna Date
    act = [y for y in range(sy(245), sy(1000)) if sum(1 for x in range(sx(40), sx(160)) if max(px[x, y]) > 150) > 3]
    grupos, g = [], []
    for y in act:
        if g and y - g[-1] > 3:
            grupos.append(g); g = []
        g.append(y)
    if g:
        grupos.append(g)
    # renglones pegados (el borde de la fila resaltada junta dos): se parten con el paso típico entre filas
    centros = [(a[0] + a[-1]) / 2 for a in grupos]
    pasos = sorted(b - a for a, b in zip(centros, centros[1:]) if 25 < b - a < 50)
    paso = pasos[len(pasos) // 2] if pasos else 36.7 * H / 1034
    partidos = []
    for a in grupos:
        alto = a[-1] - a[0]
        n = max(1, round(alto / paso + 0.4)) if alto > paso * 0.6 else 1
        if n == 1:
            partidos.append(a)
        else:
            for i in range(n):
                c0 = a[0] + i * paso
                partidos.append([int(c0), int(c0 + 11 * H / 1034)])
    grupos = partidos
    # 24-nov: fecha de la tabla (columna Date de la 1.ª fila). Antes de la apertura Quant Data muestra la sesión
    # anterior y esas filas se tomaban como de hoy; confluencia.py descarta la lectura si la fecha no es la del día.
    d["fecha"] = None
    for g in grupos[:3]:
        txt = _ocr_celda(im, (sx(30), g[0] - 4, sx(175), g[-1] + 4), psm=7, esc=3)
        m = re.search(r"([A-Za-z]{3})\w*\s+(\d{1,2}),?\s*(\d{4})", txt or "")
        if m:
            try:
                import datetime as _dt
                d["fecha"] = _dt.datetime.strptime(f"{m.group(1).title()} {m.group(2)} {m.group(3)}", "%b %d %Y").date().isoformat()
                break
            except ValueError:
                pass
    def color(x, yc):
        p = px[x, yc]
        return "bullish" if p[1] > 180 and p[0] < 120 else "bearish" if p[0] > 180 and p[1] < 100 else None
    for g in grupos:
        y1, y2 = g[0] - 4, g[-1] + 4
        if y2 - y1 < 8:
            continue
        yc = (g[0] + g[-1]) // 2
        hora = _ocr_celda(im, (sx(185), y1, sx(320), y2), "0123456789:APM ")
        strike = _ocr_celda(im, (sx(500), y1, sx(600), y2), "0123456789$,")
        tipo = _ocr_celda(im, (sx(600), y1, sx(690), y2), "PutCal")
        cant = _ocr_celda(im, (sx(845), y1, sx(990), y2), "0123456789,")
        precio = _ocr_celda(im, (sx(995), y1, sx(1105), y2), "0123456789$.,")
        lado = ""
        for u_ in (90, 70, 110, 55):   # letras grises: se prueban varios umbrales
            lado = _ocr_celda(im, (sx(1108), y1, sx(1148), y2), "AB", umbral=u_)
            if lado in ("A", "B", "AA", "BB"):
                break
        prima = _ocr_celda(im, (sx(1402), y1, sx(1545), y2), "0123456789$.KMB ")
        sent = color(sx(1572), yc) or color(sx(1392), yc)
        num = lambda s: _num(re.sub(r"[^\d.]", "", s)) if re.search(r"\d", s or "") else None
        mp = re.search(r"(\d+(?:\.\d+)?)\s*([KMB])", prima.replace(" ", ""))
        dig = re.sub(r"[^0-9]", "", strike or "")
        # el "$" se lee como 6 ("$7,040" -> 67040): el strike son los últimos 4 dígitos
        fila = {"hora": (re.search(r"\d{1,2}:\d{2}:\d{2}\s*[AP]M", hora) or [None])[0], "strike": float(dig[-4:]) if len(dig) >= 4 else None,
                "tipo": "call" if "C" in tipo else "put" if "P" in tipo else None, "cantidad": num(cant),
                "precio": num(precio), "lado": lado or None,
                "prima": float(mp.group(1)) * mult[mp.group(2)] if mp else None, "sentimiento": sent}
        # validación exacta (como en el original): prima = cantidad x precio x 100. Se elige la lectura de la cantidad
        # que cuadra; si ninguna cuadra, se calcula (la fila resaltada leía 119 como 19)
        if fila["prima"] and fila["precio"]:
            cands = [fila["cantidad"]] + [num(_ocr_celda(im, (sx(845), y1, sx(990), y2), "0123456789,", umbral=u_)) for u_ in (120, 90, 150)]
            ok = [c_ for c_ in cands if c_ and abs(c_ * fila["precio"] * 100 - fila["prima"]) <= max(0.02 * fila["prima"], 60)]
            fila["cantidad"] = ok[0] if ok else round(fila["prima"] / (fila["precio"] * 100))
        if fila["strike"] and fila["hora"]:
            d["filas"].append(fila)
    return d


def hiro_curva(im, calls_bn, puts_bn):
    """Curva COMPLETA del HIRO real (20-nov): la imagen trae todo el día dibujado. Devuelve [[hh:mm, calls, puts], ...]
    de 9:30 a la última vela. Tiempo: etiquetas del eje inferior (medianoche, 1am, ..., 2pm). Valor: se calibra con el
    FINAL de cada curva, que coincide con su recuadro (azul = calls, naranja = puts)."""
    W, H = im.size
    px = im.load()
    # eje de tiempo
    c = im.crop((int(W * .07), int(H * .86), int(W * .955), int(H * .905)))
    g = c.convert("L").point(lambda v: 0 if v > 110 else 255).resize((c.width * 3, c.height * 3))
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        g.save(f.name)
        r = subprocess.run([TESS, f.name, "-", "--psm", "6", "tsv"], capture_output=True, timeout=30, text=True, encoding="utf-8", errors="replace")
    Path(f.name).unlink(missing_ok=True)
    pts = []
    for l in r.stdout.splitlines()[1:]:
        q = l.split("\t")
        if len(q) < 12 or not q[11].strip():
            continue
        tok = q[11].strip().lower()
        x = int(q[6]) / 3 + int(W * .07) + int(q[8]) / 6
        m = re.fullmatch(r"(\d{1,2})(am|pm)", tok)
        if m:
            h = int(m.group(1)) % 12 + (12 if m.group(2) == "pm" else 0)
            pts.append((h * 60, x))
        elif re.fullmatch(r"\d{1,2}", tok) and x < W * .15:   # el número del día = medianoche
            pts.append((0, x))
    if len(pts) < 3:
        return []
    # ajuste robusto (auditoría 20-nov: un "10am" leído como "16am" arruinaba el ajuste y la curva salía vacía):
    # se ajusta, se quita la etiqueta que más se aparta (si se aparta más de media hora) y se repite
    def ajuste(ps):
        n = len(ps); mt = sum(t for t, _ in ps) / n; mx = sum(x for _, x in ps) / n
        den = sum((t - mt) ** 2 for t, _ in ps)
        if not den:
            return None
        a = sum((t - mt) * (x - mx) for t, x in ps) / den
        return a, mx - a * mt
    while True:
        fit = ajuste(pts)
        if not fit:
            return []
        a_t, b_t = fit
        res = [abs(x - (a_t * t + b_t)) for t, x in pts]
        peor = max(range(len(pts)), key=lambda i: res[i])
        if res[peor] > abs(a_t) * 30 and len(pts) > 3:
            pts.pop(peor); continue
        break
    if a_t <= 0:
        return []
    # x = a_t * minutos + b_t
    azul = lambda p: p[2] - p[0] > 50 and p[2] > 110
    nar = lambda p: p[0] - p[2] > 35 and p[0] > 95 and p[1] < p[0]
    y_top, y_bot = int(H * .26), int(H * .87)
    x_max = int(W * .913)        # a la derecha están los recuadros de valor
    col_a, col_n = {}, {}
    x_ini = int(a_t * 570 + b_t)
    for x in range(max(0, x_ini), x_max):
        ya = [y for y in range(y_top, y_bot) if azul(px[x, y])]
        yn = [y for y in range(y_top, y_bot) if nar(px[x, y])]
        if ya:
            col_a[x] = sorted(ya)[len(ya) // 2]
        if yn:
            col_n[x] = sorted(yn)[len(yn) // 2]
    if not col_a or not col_n or calls_bn is None or puts_bn is None:
        return []
    ya_fin, yn_fin = col_a[max(col_a)], col_n[max(col_n)]
    if abs(ya_fin - yn_fin) >= 15:
        a_v = (calls_bn - puts_bn) / (ya_fin - yn_fin); b_v = calls_bn - a_v * ya_fin
    else:
        eje = _eje_hiro(im)
        if not eje:
            return []
        a_v, b_v = eje[0], eje[1]
    por_min = {}
    for x in sorted(set(col_a) | set(col_n)):
        mins = int(round((x - b_t) / a_t))
        if mins < 570 or mins > 960:
            continue
        hm = f"{mins // 60:02d}:{mins % 60:02d}"
        e = por_min.setdefault(hm, [[], []])
        if x in col_a: e[0].append(a_v * col_a[x] + b_v)
        if x in col_n: e[1].append(a_v * col_n[x] + b_v)
    return [[hm, round(sum(e[0]) / len(e[0]), 3) if e[0] else None, round(sum(e[1]) / len(e[1]), 3) if e[1] else None]
            for hm, e in sorted(por_min.items())]


if __name__ == "__main__":
    import json
    import sys
    tipo, ruta = sys.argv[1], sys.argv[2]
    print(json.dumps(globals()[tipo](ruta), ensure_ascii=False, indent=1))
