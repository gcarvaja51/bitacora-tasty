# -*- coding: utf-8 -*-
"""
Genera el diagrama vertical de niveles clave / 3 escenarios para el premercado SPX.
Uso: python gen_escenarios_chart.py <output_png_path> <spec.json>

spec.json:
{
  "fecha": "lunes 20 de julio de 2026",
  "spot_referencia": 7457.69,
  "niveles": {"put_wall": 7450, "gamma_flip": 7484, "call_wall": 7500, "mvs": 7400},
  "escenarios": {
    "alcista":  {"prob": 32, "t1": 7510, "t2": 7575},
    "bajista":  {"prob": 44, "t1": 7400, "t2": 7300, "invalidacion": 7430},
    "neutral":  {"prob": 24}
  },
  "y_min": 7280, "y_max": 7590
}

Umbrales (2026-09-25, OBLIGATORIOS de ahora en mas): cada direccional lleva
"activa" e "invalida" (numeros, los mismos del bloque `escenarios` del log) y el
neutral "corredor": [min, max]. Con eso se dibujan todas las activaciones e
invalidaciones rotuladas por escenario, y las zonas de color pasan a ser las del
corredor, no las de los muros. Sin ellos se dibuja como antes (solo
"invalidacion" del bajista, rotulada a secas, que se prestaba a confusion).

Cada target admite un valor (7510, lo normal desde 2026-09-17: el premercado da
referencias redondas, no franjas) o un par [7491, 7510] (formato viejo).

y_min/y_max: fijar manualmente cubriendo todos los niveles/targets con margen --
no se auto-calculan, para tener control total del layout dia a dia.
"""
import sys, json
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# -- paleta (repurposed del categorico validado del skill dataviz: green/red,
#    WARN CVD 7.2 en el rango 6-8 -- mitigado con etiquetas directas en cada
#    zona/nivel, nunca color solo, per la regla de secondary encoding) --
GREEN       = "#008300"
GREEN_WASH  = "#e3f2df"
GREEN_BAND  = "#bfe6b7"
RED         = "#e34948"
RED_WASH    = "#fbe9e9"
RED_BAND    = "#f5c2c1"
GRAY_WASH   = "#f0efec"
INK         = "#0b0b0b"
INK_SEC     = "#52514e"
INK_MUTED   = "#898781"
SURFACE     = "#fcfcfb"

def _par(t):
    """Target como (bajo, alto): un valor suelto es una franja de ancho cero."""
    return (t[0], t[1]) if isinstance(t, (list, tuple)) else (t, t)

def _banda(ax, t, color):
    lo, hi = _par(t)
    if hi - lo < 3:  # valor unico: franja fina alrededor para que se vea
        lo, hi = (lo + hi) / 2 - 1.5, (lo + hi) / 2 + 1.5
    ax.axhspan(lo, hi, color=color, zorder=1)

def _rotulo(nombre, t):
    lo, hi = _par(t)
    txt = f"{lo:,.0f}" if lo == hi else f"{lo:,.0f}-{hi:,.0f}"
    return f"{nombre} {txt}".replace(",", ".")

def main():
    out_path = sys.argv[1]
    spec = json.load(open(sys.argv[2], encoding="utf-8"))

    niveles = spec["niveles"]
    esc = spec["escenarios"]
    y_min, y_max = spec["y_min"], spec["y_max"]
    spot = spec["spot_referencia"]

    fig, ax = plt.subplots(figsize=(6.0, 8.5), dpi=200)
    fig.patch.set_facecolor(SURFACE)
    ax.set_facecolor(SURFACE)

    ax.set_xlim(0, 10)
    ax.set_ylim(y_min, y_max)

    put_wall = niveles["put_wall"]
    call_wall = niveles["call_wall"]

    # -- Washes de fondo (3 zonas) --
    # Con corredor en el spec (2026-09-25) las zonas son las del escenario, no las de
    # los muros: el gris es donde vive el Neutral y el verde/rojo empieza donde se
    # activa cada direccional. Sin corredor, como siempre (muros).
    corr = esc["neutral"].get("corredor")
    z_lo, z_hi = (corr[0], corr[1]) if corr else (put_wall, call_wall)
    ax.axhspan(y_min, z_lo, color=RED_WASH, zorder=0)
    ax.axhspan(z_lo, z_hi, color=GRAY_WASH, zorder=0)
    ax.axhspan(z_hi, y_max, color=GREEN_WASH, zorder=0)

    # -- Bandas de target (mas saturadas) --
    a = esc["alcista"]
    _banda(ax, a["t1"], GREEN_BAND)
    _banda(ax, a["t2"], GREEN_BAND)

    b = esc["bajista"]
    _banda(ax, b["t2"], RED_BAND)

    # -- Lineas de niveles clave (solidas, con etiqueta a la derecha) --
    def level_line(price, label, color=INK, lw=1.6, ls="-", label_color=None):
        ax.axhline(price, color=color, linewidth=lw, linestyle=ls, zorder=3, xmax=0.86)
        ax.text(8.9, price, f"{label}  {price:,.0f}".replace(",", "."), va="center",
                 fontsize=9.5, color=label_color or color, fontweight="bold",
                 fontfamily="sans-serif")

    # Si el MVS cae en el mismo strike que el Call Wall, se rotulan juntos en una sola
    # linea -- si no, la rama de abajo omite el MVS por completo y el nivel desaparece
    # del diagrama sin dejar rastro (bug real, 2026-08-04).
    # Etiquetas opcionales (2026-09-08): los cuatro niveles del diagrama son
    # POSICIONALES -- put_wall y call_wall son los bordes de las tres zonas, no
    # necesariamente los muros. Hay dias en que el corredor operativo lo fijan otros
    # niveles (p.ej. el Gamma Flip y el disparador bajista, con los muros reales a 150
    # puntos de distancia): rotularlos "Put Wall"/"Call Wall" seria mentir en el
    # grafico. Con label_* en el spec se rotula lo que de verdad es cada linea; sin
    # ellos el comportamiento es identico al de siempre.
    lbl_cw = niveles.get("label_call_wall")
    lbl_pw = niveles.get("label_put_wall")
    lbl_gf = niveles.get("label_gamma_flip", "Gamma Flip")
    lbl_mvs = niveles.get("label_mvs", "MVS")

    call_wall_label = lbl_cw or ("Call Wall / MVS" if abs(call_wall - niveles["mvs"]) < 1 else "Call Wall")
    level_line(call_wall, call_wall_label, color=GREEN)
    level_line(niveles["gamma_flip"], lbl_gf, color=INK_SEC, ls="--", lw=1.3)
    if lbl_pw:
        level_line(put_wall, lbl_pw, color=RED)
        if abs(niveles["mvs"] - put_wall) >= 1 and abs(niveles["mvs"] - call_wall) >= 1:
            level_line(niveles["mvs"], lbl_mvs, color=RED, ls=":", lw=1.4)
    elif abs(put_wall - niveles["mvs"]) < 1:
        # Put Wall y MVS cayeron en el mismo strike hoy -- una sola linea/etiqueta
        # combinada en vez de dos superpuestas e ilegibles (bug real, 2026-07-21).
        level_line(put_wall, "Put Wall / MVS", color=RED)
    elif abs(call_wall - niveles["mvs"]) < 1:
        # Mismo caso que arriba pero con el Call Wall (visto 2026-07-23) -- combinar
        # en vez de superponer dos lineas identicas en el mismo strike.
        pass
    else:
        level_line(put_wall, "Put Wall", color=RED)
        level_line(niveles["mvs"], lbl_mvs, color=RED, ls=":", lw=1.4)
    if not lbl_pw and abs(put_wall - niveles["mvs"]) >= 1 and abs(call_wall - niveles["mvs"]) < 1:
        level_line(put_wall, "Put Wall", color=RED)

    # -- Spot de referencia (linea solida gruesa + marcador) --
    ax.axhline(spot, color=INK, linewidth=2.0, linestyle="-", zorder=4, xmax=0.86)
    ax.plot([0.3], [spot], marker="o", markersize=7, color=INK, zorder=5)
    # Si el spot de referencia abre pegado a un nivel ya rotulado (caso tipico: gap que
    # deja el precio a pocos puntos del Call Wall), su etiqueta se desplaza para no
    # quedar tachada por la del nivel -- la linea sigue en el precio real
    # (bug real, 2026-08-04: spot 7627.47 vs Call Wall 7630, textos superpuestos).
    # El desplazamiento va SIEMPRE en direccion contraria al nivel que estorba: antes
    # era un "- _sep" fijo, que con el spot POR ENCIMA del nivel lo empujaba justo
    # encima de la etiqueta que trataba de esquivar (bug real, 2026-08-14: spot
    # 7804.00 vs Call Wall 7800 -- la etiqueta aterrizaba en 7799.93, ilegible).
    _rotulados = (put_wall, call_wall, niveles["gamma_flip"], niveles["mvs"])
    _sep = (y_max - y_min) * 0.022
    _choca = [lvl for lvl in _rotulados if abs(spot - lvl) < _sep]
    if _choca:
        _cerca = min(_choca, key=lambda lvl: abs(spot - lvl))
        spot_label_y = spot + _sep if spot >= _cerca else spot - _sep
    else:
        spot_label_y = spot
    ax.text(8.9, spot_label_y, f"Spot ref.  {spot:,.0f}".replace(",", "."), va="center",
             fontsize=9.5, color=INK, fontweight="bold", fontfamily="sans-serif")

    # -- Umbrales de los 3 escenarios (2026-09-25, pedido de Guillermo: "marca las
    #    invalidaciones para que se vea mejor") --
    # Antes solo se dibujaba la invalidacion del bajista, rotulada "Invalidacion" a
    # secas: el 25-sep leyo esa linea (7.720) como el borde del Neutral, que en
    # realidad era 7.700-7.735. Si el spec trae activa/invalida por escenario, se
    # dibujan TODOS los umbrales, cada uno diciendo de que escenario es, en una
    # columna propia a la izquierda (x=2.4) para no chocar con T1/T2 (x=0.4) ni con
    # los niveles de Sigma (derecha).
    n = esc["neutral"]
    umbrales = []   # (precio, texto, color, estilo_linea)
    for clave, nombre, color in (("alcista", "ALCISTA", GREEN), ("bajista", "BAJISTA", RED)):
        e = esc[clave]
        if e.get("activa") is not None:
            flecha = "↑" if clave == "alcista" else "↓"
            umbrales.append((e["activa"], f"{flecha} activa {nombre}", color, "-."))
        if e.get("invalida") is not None:
            umbrales.append((e["invalida"], f"✕ invalida {nombre}", color, ":"))
    if n.get("corredor"):
        lo_n, hi_n = n["corredor"]
        umbrales.append((lo_n, "✕ invalida NEUTRAL ↓", INK_SEC, ":"))
        umbrales.append((hi_n, "✕ invalida NEUTRAL ↑", INK_SEC, ":"))

    if umbrales:
        # Linea: una por precio, salvo que ya haya un nivel rotulado ahi (el umbral
        # se lee igual por su etiqueta de la izquierda).
        ya_linea = set()
        for precio, _, color, ls in umbrales:
            if precio in ya_linea or any(abs(precio - lvl) < 1 for lvl in _rotulados):
                continue
            ya_linea.add(precio)
            ax.axhline(precio, color=color, linewidth=1.2, linestyle=ls, zorder=2, xmax=0.86, alpha=0.85)
        # Etiquetas: apiladas sin encimarse (varias pueden caer en el mismo precio:
        # activar el alcista ES invalidar el neutral por arriba).
        sep = (y_max - y_min) * 0.021
        ordenados = sorted(umbrales, key=lambda u: (u[0], u[1]))
        grupos = {}
        for u in ordenados:
            grupos.setdefault(u[0], []).append(u)
        ultimo_y = None
        for precio in sorted(grupos):
            g = grupos[precio]
            # el bloque del precio se centra en el precio, y se empuja hacia arriba
            # si choca con el bloque anterior
            y0 = precio - sep * (len(g) - 1) / 2
            if ultimo_y is not None and y0 < ultimo_y + sep:
                y0 = ultimo_y + sep
            for i, (_, texto, color, _ls) in enumerate(g):
                y = y0 + i * sep
                etiqueta = f"{texto} {precio:,.0f}".replace(",", ".")
                ax.text(2.4, y, etiqueta, va="center", fontsize=7.8, color=color,
                        fontweight="bold", fontfamily="sans-serif", zorder=6,
                        bbox=dict(boxstyle="round,pad=0.15", fc=SURFACE, ec="none", alpha=0.85))
                ultimo_y = y

    # -- Invalidacion bajista (formato viejo, solo si el spec no trae umbrales) --
    inv = None if umbrales else b.get("invalidacion")
    # Si la invalidacion cae en el mismo strike que un nivel ya rotulado (Put Wall,
    # Gamma Flip, etc.) se omite la linea/etiqueta para no superponer texto -- bug
    # real visto 2026-07-23 (invalidacion == put_wall del dia, texto ilegible).
    ya_rotulado = any(abs(inv - lvl) < 1 for lvl in (put_wall, call_wall, niveles["gamma_flip"], niveles["mvs"])) if inv else False
    if inv and not ya_rotulado:
        ax.axhline(inv, color=RED, linewidth=1.0, linestyle=":", zorder=2, xmax=0.86, alpha=0.7)
        ax.text(8.9, inv, f"Invalidacion  {inv:,.0f}".replace(",", "."), va="center",
                 fontsize=7.8, color=RED, style="italic", fontfamily="sans-serif")

    # -- Etiquetas de targets (dentro de las bandas -- desplazadas si coinciden
    #    con una linea de nivel nombrada, para no superponerse -- ver gotcha abajo) --
    t1_mid = sum(_par(a["t1"])) / 2
    t1_label_y = _par(a["t1"])[1] + 3 if abs(t1_mid - call_wall) < 6 else t1_mid
    ax.text(0.4, t1_label_y, _rotulo("T1", a["t1"]),
             fontsize=8, color=GREEN, fontweight="bold", va="bottom", fontfamily="sans-serif")
    ax.text(0.4, sum(_par(a["t2"])) / 2, _rotulo("T2", a["t2"]),
             fontsize=8, color=GREEN, fontweight="bold", va="center", fontfamily="sans-serif")
    b_t1 = sum(_par(b["t1"])) / 2
    if all(abs(b_t1 - lvl) >= 3 for lvl in (niveles["mvs"], put_wall, niveles["gamma_flip"])):
        # Solo dibujar la etiqueta T1 si es un nivel distinto de MVS, Put Wall o Gamma
        # Flip (este ultimo agregado 2026-08-04, mismo sintoma con el target bajista
        # apoyado justo en el flip) --
        # si coincide con cualquiera de los dos (caso tipico: el primer target bajista
        # ES el Put Wall), la etiqueta de la derecha ya lo cubre y dibujar T1 encima
        # de la linea de nivel deja el texto tachado e ilegible (bug real, 2026-08-01).
        ax.text(0.4, b_t1, _rotulo("T1", b["t1"]),
                 fontsize=8, color=RED, fontweight="bold", va="center", fontfamily="sans-serif")
    ax.text(0.4, sum(_par(b["t2"])) / 2, _rotulo("T2", b["t2"]),
             fontsize=8, color=RED, fontweight="bold", va="center", fontfamily="sans-serif")

    # -- Rotulo grande de escenario + probabilidad, centrado en cada zona --
    y_alcista_center = (call_wall + y_max) / 2 + 15
    y_bajista_center = (y_min + put_wall) / 2 - 15
    y_neutral_center = (put_wall + call_wall) / 2

    # Con la columna de umbrales a la izquierda, los rotulos grandes se corren a la
    # derecha para no taparla.
    if umbrales:
        x_box = 7.0
        margen = (y_max - y_min) * 0.07
        y_alcista_center = y_max - margen
        y_bajista_center = y_min + margen
        if corr:
            # El rotulo NEUTRAL va en el hueco mas grande del corredor, para no
            # tapar ninguna linea (umbrales, niveles o spot).
            marcas = sorted({corr[0], corr[1], spot, *(u[0] for u in umbrales), *(
                l for l in _rotulados if corr[0] <= l <= corr[1])})
            marcas = [m for m in marcas if corr[0] <= m <= corr[1]]
            a_, b_ = max(zip(marcas, marcas[1:]), key=lambda p: p[1] - p[0])
            y_neutral_center = (a_ + b_) / 2
    else:
        x_box = 5.3
    ax.text(x_box, y_alcista_center, f"ALCISTA {esc['alcista']['prob']}%", fontsize=15,
             color=GREEN, fontweight="bold", ha="center", va="center", fontfamily="sans-serif",
             bbox=dict(boxstyle="round,pad=0.35", fc=SURFACE, ec=GREEN, lw=1.2, alpha=0.92))
    ax.text(x_box, y_neutral_center, f"NEUTRAL {esc['neutral']['prob']}%", fontsize=13,
             color=INK_SEC, fontweight="bold", ha="center", va="center", fontfamily="sans-serif",
             bbox=dict(boxstyle="round,pad=0.35", fc=SURFACE, ec=INK_MUTED, lw=1.0, alpha=0.92))
    ax.text(x_box, y_bajista_center, f"BAJISTA {esc['bajista']['prob']}%", fontsize=15,
             color=RED, fontweight="bold", ha="center", va="center", fontfamily="sans-serif",
             bbox=dict(boxstyle="round,pad=0.35", fc=SURFACE, ec=RED, lw=1.2, alpha=0.92))

    # -- Chrome --
    ax.set_xticks([])
    ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_visible(False)

    ax.set_title(f"Los 3 Escenarios — Niveles Clave\n{spec['fecha']}", fontsize=13,
                 color=INK, fontweight="bold", fontfamily="sans-serif", pad=14)

    plt.tight_layout()
    plt.savefig(out_path, facecolor=SURFACE, bbox_inches="tight")
    print("OK:", out_path)

if __name__ == "__main__":
    main()
