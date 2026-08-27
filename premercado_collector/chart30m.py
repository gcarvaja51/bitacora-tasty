# -*- coding: utf-8 -*-
"""
Chart de 30 minutos del SPX con los muros de Gamma superpuestos, dibujado con datos
reales de Yahoo Finance.

    python chart30m.py <salida.png> <niveles.json>

POR QUE EXISTE (2026-08-27). La captura del chart por CDP contra TradingView Desktop es
IMPOSIBLE cuando la pestana del SPX no es la activa de su ventana: el layout de una
pestana oculta colapsa a 0x0 y Page.bringToFront() no la despierta (ver el comentario
largo en captureChartPng dentro de collect.js). No es una degradacion temporal que se
arregle sola -- mientras Guillermo tenga el SP500 al frente, que es como trabaja, la
captura no va a volver.

Hasta hoy el chart se rehacia A MANO cada manana con un script de un solo uso
(.scratch_chart30m_0821.py, .scratch_chart30m_0825.py, y asi desde el 4 de agosto: once
dias distintos con once scripts equivalentes). Esto es ese mismo dibujo, una sola vez y
versionado, para que el bundle SIEMPRE tenga su chart_30m.png y el informe no dependa de
que alguien lo improvise.

niveles.json (todas las claves opcionales salvo `niveles`):
{
  "titulo": "SPX - 30 minutos, ultimas 3 sesiones",
  "symbol": "^GSPC",
  "sesiones": 3,
  "cierre_previo": 7675.70,
  "referencia": {"valor": 7697.45, "etiqueta": "apertura implicita 7.697,45 (gap +21,75)"},
  "niveles": [
    {"valor": 7700, "etiqueta": "Call Wall 7.700", "color": "verde",   "trazo": "solido"},
    {"valor": 7695, "etiqueta": "Gamma Flip 7.695", "color": "violeta", "trazo": "guiones"}
  ]
}
"""
import sys
import json
import datetime
import urllib.request
import urllib.parse

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

# Misma paleta que gen_escenarios_chart.py del skill premercado-spx: el chart y el
# diagrama de escenarios viajan en el mismo documento y tienen que leerse como una pieza.
INK = "#0b0b0b"
MUTED = "#898781"
SURFACE = "#fcfcfb"
VERDE = "#008300"
ROJO = "#e34948"

COLORES = {
    "verde": VERDE, "rojo": ROJO, "violeta": "#7a3fa8",
    "ambar": "#b8860b", "tinta": INK, "gris": MUTED,
}
TRAZOS = {"solido": "-", "guiones": "--", "punteado": ":", "mixto": "-."}

# ET fijo en -4 (EDT). Solo se usa para agrupar velas por sesion y rotular el eje; un
# error de una hora no cambia a que dia pertenece una vela de mercado regular.
ET = datetime.timezone(datetime.timedelta(hours=-4))


def velas(symbol, interval="30m", rango="5d"):
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/"
           + urllib.parse.quote(symbol) + f"?interval={interval}&range={rango}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=25) as r:
        data = json.load(r)
    res = data["chart"]["result"][0]
    ts, q = res["timestamp"], res["indicators"]["quote"][0]
    out = []
    for i, t in enumerate(ts):
        if q["close"][i] is None:
            continue
        out.append({"t": t, "o": q["open"][i], "h": q["high"][i],
                    "l": q["low"][i], "c": q["close"][i]})
    if not out:
        raise SystemExit(f"Yahoo no devolvio velas usables para {symbol}")
    return out


def dia_de(bar):
    return datetime.datetime.fromtimestamp(bar["t"], ET).strftime("%Y-%m-%d")


def main():
    if len(sys.argv) < 3:
        raise SystemExit("uso: python chart30m.py <salida.png> <niveles.json>")
    out_path, spec_path = sys.argv[1], sys.argv[2]
    with open(spec_path, encoding="utf-8") as f:
        spec = json.load(f)

    symbol = spec.get("symbol", "^GSPC")
    n_ses = int(spec.get("sesiones", 3))
    niveles = spec.get("niveles", [])

    barras = velas(symbol)
    dias = sorted({dia_de(b) for b in barras})[-n_ses:]
    barras = [b for b in barras if dia_de(b) in dias]

    fig, ax = plt.subplots(figsize=(10.0, 5.4), dpi=200)
    fig.patch.set_facecolor(SURFACE)
    ax.set_facecolor(SURFACE)

    for i, b in enumerate(barras):
        col = VERDE if b["c"] >= b["o"] else ROJO
        ax.plot([i, i], [b["l"], b["h"]], color=col, lw=0.9, solid_capstyle="butt", zorder=3)
        lo, hi = min(b["o"], b["c"]), max(b["o"], b["c"])
        ax.add_patch(Rectangle((i - 0.32, lo), 0.64, max(hi - lo, 0.01),
                               facecolor=col, edgecolor=col, lw=0.5, zorder=4))

    # Los niveles se rotulan a la derecha, fuera de las velas: es la unica forma de que un
    # racimo apretado (los muros suelen caer a pocos puntos entre si) siga siendo legible.
    for niv in niveles:
        color = COLORES.get(niv.get("color", "tinta"), INK)
        ax.axhline(niv["valor"], color=color, lw=1.4,
                   ls=TRAZOS.get(niv.get("trazo", "solido"), "-"), zorder=2, alpha=0.95)
        ax.text(len(barras) - 0.4, niv["valor"], "  " + niv.get("etiqueta", ""),
                color=color, fontsize=8.5, fontweight="bold",
                va="center", ha="left", zorder=6)

    if spec.get("cierre_previo"):
        ax.axhline(spec["cierre_previo"], color=MUTED, lw=0.8, ls=":", zorder=1)

    ref = spec.get("referencia")
    if ref and ref.get("valor"):
        ax.axhline(ref["valor"], color=INK, lw=1.1, ls=(0, (6, 3)), zorder=5)
        if ref.get("etiqueta"):
            ax.text(0.4, ref["valor"], " " + ref["etiqueta"], color=INK, fontsize=8.5,
                    fontweight="bold", va="bottom", ha="left", zorder=6)

    prev = None
    for i, b in enumerate(barras):
        d = dia_de(b)
        if prev and d != prev:
            ax.axvline(i - 0.5, color=MUTED, lw=0.7, alpha=0.5, zorder=1)
        prev = d
    for d in dias:
        idx = [i for i, b in enumerate(barras) if dia_de(b) == d]
        ax.annotate(datetime.datetime.strptime(d, "%Y-%m-%d").strftime("%d-%b"),
                    xy=(sum(idx) / len(idx), 0), xycoords=("data", "axes fraction"),
                    xytext=(0, 4), textcoords="offset points",
                    ha="center", fontsize=8.5, color=MUTED)

    # Margen a la derecha para las etiquetas, y encuadre que incluya SIEMPRE los niveles:
    # un muro que queda fuera del cuadro es justo el que hay que mirar.
    ax.set_xlim(-1, len(barras) + 11)
    valores = [b["l"] for b in barras] + [b["h"] for b in barras]
    valores += [n["valor"] for n in niveles]
    if spec.get("cierre_previo"):
        valores.append(spec["cierre_previo"])
    if ref and ref.get("valor"):
        valores.append(ref["valor"])
    lo, hi = min(valores), max(valores)
    pad = max((hi - lo) * 0.08, 1.0)
    ax.set_ylim(lo - pad, hi + pad)

    ax.set_xticks([])
    ax.tick_params(axis="y", labelsize=8.5, colors=INK)
    for s in ("top", "right", "bottom"):
        ax.spines[s].set_visible(False)
    ax.spines["left"].set_color(MUTED)
    ax.grid(axis="y", color=MUTED, alpha=0.18, lw=0.6)
    ax.set_title(spec.get("titulo", "SPX - 30 minutos"), fontsize=11,
                 fontweight="bold", color=INK, pad=10)

    fig.tight_layout()
    fig.savefig(out_path, facecolor=SURFACE)
    print(f"OK: {out_path} ({len(barras)} velas, sesiones {', '.join(dias)})")


if __name__ == "__main__":
    main()
