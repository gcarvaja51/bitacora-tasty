#!/usr/bin/env python
"""
Renderiza un informe de trade en PDF a partir de un JSON de especificacion.
Uso: python render_informe.py <spec.json>

El JSON de entrada (ver SKILL.md para el contrato completo) tiene esta forma:
{
  "output_path": "C:\\...\\archivo.pdf",
  "title": "...",
  "subtitle": "...",
  "result_banner": {"label": "GANANCIA", "value": "+$115.00", "positive": true},
  "meta": [["Estrategia", "BULL_PUT_SPREAD"], ...],
  "sections": [
    {"heading": "...", "table": [["k","v"], ...], "text": "..."},
    ...
  ]
}

No usa fuentes unicode embebidas (mas simple, sin dependencias de archivos de
fuente) -- los emoji/checks (✅❌⚠️) del JSON de entrada se reemplazan por
equivalentes en texto plano antes de escribir, ya que las fuentes core de
fpdf2 (Helvetica) son solo Latin-1.
"""
import sys
import json
from fpdf import FPDF

NAVY = (30, 41, 59)
LIGHT_GRAY = (241, 245, 249)
GREEN = (22, 101, 52)
GREEN_BG = (220, 252, 231)
RED = (153, 27, 27)
RED_BG = (254, 226, 226)
BORDER = (203, 213, 225)
TEXT = (30, 41, 59)
MUTED = (100, 116, 139)

EMOJI_MAP = {
    "✅": "[OK]",
    "❌": "[NO]",
    "⚠️": "[!]",
    "⚠": "[!]",
    "⬆": "^",
    "⬇": "v",
    # Puntuacion tipografica fuera de Latin-1 (fuentes core de fpdf2) —
    # sin este paso, encode('latin-1','ignore') las borra en silencio.
    "—": "-",
    "–": "-",
    "•": "-",
    "→": "->",
    "←": "<-",
    "‘": "'", "’": "'",
    "“": '"', "”": '"',
    "…": "...",
}


def sanitize(s):
    if s is None:
        return ""
    s = str(s)
    for k, v in EMOJI_MAP.items():
        s = s.replace(k, v)
    # fallback: strip any remaining non-latin-1 char (evita crash de fpdf2)
    return s.encode("latin-1", "ignore").decode("latin-1")


class InformePDF(FPDF):
    def header(self):
        pass

    def footer(self):
        self.set_y(-12)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(*MUTED)
        self.cell(0, 8, sanitize(f"Bitacora Tasty - Informe de Trade - Pagina {self.page_no()}"), align="C")


def draw_title(pdf, title, subtitle):
    pdf.set_fill_color(*NAVY)
    pdf.rect(0, 0, pdf.w, 28, style="F")
    pdf.set_xy(15, 6)
    pdf.set_text_color(255, 255, 255)
    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(0, 8, sanitize(title))
    pdf.set_xy(15, 16)
    pdf.set_font("Helvetica", "", 10)
    pdf.cell(0, 6, sanitize(subtitle))
    pdf.set_y(31)
    pdf.set_text_color(*TEXT)


def draw_banner(pdf, banner):
    if not banner:
        return
    positive = banner.get("positive")
    bg = GREEN_BG if positive else RED_BG
    fg = GREEN if positive else RED
    pdf.set_fill_color(*bg)
    pdf.set_draw_color(*bg)
    pdf.rect(15, pdf.get_y(), pdf.w - 30, 13, style="F")
    pdf.set_xy(20, pdf.get_y() + 2)
    pdf.set_text_color(*fg)
    pdf.set_font("Helvetica", "B", 13)
    pdf.cell(0, 9, sanitize(f"{banner.get('label','')}: {banner.get('value','')}"))
    pdf.set_y(pdf.get_y() + 13)
    pdf.set_text_color(*TEXT)
    pdf.ln(2)


def draw_meta(pdf, meta):
    if not meta:
        return
    col_w = (pdf.w - 30) / 2
    pdf.set_font("Helvetica", "", 9)
    for i in range(0, len(meta), 2):
        pair = meta[i:i + 2]
        pdf.set_x(15)
        for k, v in pair:
            pdf.set_font("Helvetica", "B", 9)
            pdf.set_text_color(*MUTED)
            pdf.cell(28, 6, sanitize(k) + ":")
            pdf.set_font("Helvetica", "", 9)
            pdf.set_text_color(*TEXT)
            pdf.cell(col_w - 28, 5.5, sanitize(v))
        pdf.ln(5.5)
    pdf.ln(1)


def draw_heading(pdf, text):
    pdf.set_fill_color(*LIGHT_GRAY)
    pdf.set_x(15)
    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(*NAVY)
    pdf.cell(pdf.w - 30, 8, sanitize("  " + text), fill=True)
    pdf.ln(9)
    pdf.set_text_color(*TEXT)


def draw_table(pdf, rows):
    if not rows:
        return
    col1_w = 62
    col2_w = pdf.w - 30 - col1_w
    pdf.set_font("Helvetica", "", 9)
    for idx, row in enumerate(rows):
        k = row[0] if len(row) > 0 else ""
        v = row[1] if len(row) > 1 else ""
        x0, y0 = 15, pdf.get_y()
        pdf.set_font("Helvetica", "B", 9)
        pdf.set_xy(x0, y0)
        pdf.multi_cell(col1_w, 5.5, sanitize(k), border=0)
        y1 = pdf.get_y()
        pdf.set_font("Helvetica", "", 9)
        pdf.set_xy(x0 + col1_w, y0)
        pdf.multi_cell(col2_w, 5.5, sanitize(v), border=0)
        y2 = pdf.get_y()
        row_h = max(y1, y2) - y0
        pdf.set_draw_color(*BORDER)
        pdf.line(x0, y0 + row_h, x0 + col1_w + col2_w, y0 + row_h)
        pdf.set_y(y0 + row_h)
    pdf.ln(2)


def draw_text(pdf, text):
    if not text:
        return
    pdf.set_x(15)
    pdf.set_font("Helvetica", "", 9.5)
    pdf.multi_cell(pdf.w - 30, 5.5, sanitize(text))
    pdf.ln(2)


def draw_checks_table(pdf, checks):
    if not checks:
        return
    # Filtra los checks de peso 0 (no puntuan, no aportan nada a la decision
    # real) -- a pedido del usuario (2026-07-21), deja la tabla mas limpia y
    # ayuda a que el informe entre en una sola pagina.
    checks = [c for c in checks if (c.get("weight") or 0) > 0]
    if not checks:
        return
    col_w = [9, 62, 13, 15, 55]
    total_w = sum(col_w)
    scale = (pdf.w - 30) / total_w
    col_w = [c * scale for c in col_w]
    headers = ["", "Check", "Peso", "Pts", "Valor"]
    pdf.set_font("Helvetica", "B", 8.5)
    pdf.set_fill_color(*LIGHT_GRAY)
    x0 = 15
    pdf.set_x(x0)
    for w, h in zip(col_w, headers):
        pdf.cell(w, 6, sanitize(h), border=0, fill=True)
    pdf.ln(6)
    pdf.set_font("Helvetica", "", 8.5)
    total_peso, total_pts = 0, 0
    for c in checks:
        ok = c.get("ok")
        weight = c.get("weight") or 0
        pts = weight if ok else 0
        total_peso += weight
        total_pts += pts
        mark = "OK" if ok else "NO"
        color = GREEN if ok else RED
        y0 = pdf.get_y()
        pdf.set_x(x0)
        pdf.set_text_color(*color)
        pdf.cell(col_w[0], 5.5, mark)
        pdf.set_text_color(*TEXT)
        label = c.get("label", c.get("id", ""))
        pdf.set_xy(x0 + col_w[0], y0)
        pdf.multi_cell(col_w[1], 5.5, sanitize(label))
        y_label_end = pdf.get_y()
        pdf.set_xy(x0 + col_w[0] + col_w[1], y0)
        pdf.cell(col_w[2], 5.5, sanitize(str(weight)))
        pdf.set_xy(x0 + col_w[0] + col_w[1] + col_w[2], y0)
        pdf.set_text_color(*(GREEN if ok else MUTED))
        pdf.cell(col_w[3], 5.5, sanitize(str(pts)))
        pdf.set_text_color(*TEXT)
        pdf.set_xy(x0 + col_w[0] + col_w[1] + col_w[2] + col_w[3], y0)
        pdf.multi_cell(col_w[4], 5.5, sanitize(c.get("value", "")))
        y_value_end = pdf.get_y()
        row_h = max(y_label_end, y_value_end) - y0
        pdf.set_draw_color(*BORDER)
        pdf.line(x0, y0 + row_h, x0 + sum(col_w), y0 + row_h)
        pdf.set_y(y0 + row_h)
    # Fila de sumatoria -- a pedido del usuario, deja ver el puntaje real
    # (puntos ganados / peso total posible) sin tener que sumarlo a mano.
    pct = round(100 * total_pts / total_peso) if total_peso else 0
    pdf.set_x(x0)
    pdf.set_font("Helvetica", "B", 8.5)
    pdf.set_fill_color(*LIGHT_GRAY)
    pdf.cell(col_w[0] + col_w[1], 6, sanitize("  TOTAL"), fill=True)
    pdf.cell(col_w[2], 6, sanitize(str(total_peso)), fill=True)
    pdf.cell(col_w[3], 6, sanitize(str(total_pts)), fill=True)
    pdf.cell(col_w[4], 6, sanitize(f"Score: {total_pts}/{total_peso} = {pct}%"), fill=True)
    pdf.ln(7)
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(*TEXT)
    pdf.ln(2)


# Colores del grafico de velas (mismo lenguaje visual que TradingView, que es
# contra lo que el usuario compara).
VELA_SUBE = (38, 166, 154)
VELA_BAJA = (239, 83, 80)
CAJA_GANA = (220, 252, 231)
CAJA_PIERDE = (254, 226, 226)
LINEA_ENT = (30, 41, 59)
# EMAs 10/20 (2026-08-19, a pedido del usuario: "un dibujo similar a como
# aparece en TradingView en CIARG_V3"). Ambar y azul — se eligen para no
# confundirse con el verde/rojo de las velas ni con las lineas de entrada y
# salida, que ya usan esos dos colores.
EMA_10 = (255, 152, 0)
EMA_20 = (63, 81, 181)


def calc_ema(valores, periodo):
    """EMA sembrada con la SMA de las primeras `periodo` muestras.

    Devuelve una lista del mismo largo que `valores`, con None en las primeras
    `periodo-1` posiciones: ahi todavia no hay media que mostrar y dibujar algo
    seria inventarlo.

    OJO con el arranque. El grafico del informe es una ventana corta alrededor
    del trade, no la serie completa, asi que no hay historia previa con la que
    arrancar la EMA. Sembrar con la SMA es lo estandar y converge rapido, pero
    los primeros puntos de la linea son aproximados y NO coinciden exactamente
    con los de TradingView, que si tiene todo el historico. Cerca de la entrada
    —que es lo que el informe viene a auditar— ya convergieron.
    """
    if not valores or len(valores) < periodo:
        return [None] * len(valores)
    k = 2.0 / (periodo + 1)
    out = [None] * (periodo - 1)
    prev = sum(valores[:periodo]) / periodo
    out.append(prev)
    for v in valores[periodo:]:
        prev = v * k + prev * (1 - k)
        out.append(prev)
    return out


def draw_chart(pdf, chart):
    """Grafico de velas con el momento de ENTRADA y el de SALIDA.

    Nace de un pedido del usuario (2026-08-10): "necesito validar el momento de
    entrada y el momento de salida... hay algo que no me cuadra". El informe
    contaba el trade en tablas, pero sin poder ver DONDE cayo la entrada y donde
    la salida sobre el precio real no habia forma de auditar el timing — que es
    justo donde aparecieron los problemas (salidas decididas con cotizaciones
    diferidas mientras el indice ya se habia dado vuelta).

    chart = {
      "candles": [{"t": epoch_ms, "o":, "h":, "l":, "c":}, ...],
      "entry":   {"t": epoch_ms, "price": float, "label": "BUY"|"SELL"},
      "exit":    {"t": epoch_ms, "price": float},   # opcional
      "gano":    bool,
      "nota":    "texto al pie"                      # opcional
    }
    """
    velas = chart.get("candles") or []
    if len(velas) < 3:
        draw_text(pdf, "(sin velas suficientes para graficar este trade)")
        return

    x0 = pdf.l_margin
    ancho = pdf.w - pdf.l_margin - pdf.r_margin
    alto = 58.0
    if pdf.get_y() + alto + 14 > pdf.h - pdf.b_margin:
        pdf.add_page()
    y0 = pdf.get_y() + 2

    ent = chart.get("entry") or {}
    sal = chart.get("exit") or {}
    precios = [v["h"] for v in velas] + [v["l"] for v in velas]
    for p_ in (ent.get("price"), sal.get("price")):
        if p_ is not None:
            precios.append(p_)
    lo, hi = min(precios), max(precios)
    margen = (hi - lo) * 0.10 or 1.0
    lo -= margen
    hi += margen

    def px(i):
        return x0 + (i + 0.5) * (ancho / len(velas))

    def py(p_):
        return y0 + (hi - p_) / (hi - lo) * alto

    # indice de la vela que contiene cada instante
    def idx_de(ts):
        if ts is None:
            return None
        mejor = None
        for i, v in enumerate(velas):
            if v["t"] <= ts:
                mejor = i
        return mejor

    iE, iS = idx_de(ent.get("t")), idx_de(sal.get("t"))

    # Fondo
    pdf.set_fill_color(252, 252, 253)
    pdf.rect(x0, y0, ancho, alto, style="F")

    # Caja del recorrido entre entrada y salida
    if iE is not None and iS is not None and iS > iE and ent.get("price") and sal.get("price"):
        pdf.set_fill_color(*(CAJA_GANA if chart.get("gano") else CAJA_PIERDE))
        yA, yB = py(max(ent["price"], sal["price"])), py(min(ent["price"], sal["price"]))
        pdf.rect(px(iE), yA, px(iS) - px(iE), max(0.6, yB - yA), style="F")

    # Velas
    aw = max(0.7, (ancho / len(velas)) * 0.6)
    for i, v in enumerate(velas):
        col = VELA_SUBE if v["c"] >= v["o"] else VELA_BAJA
        pdf.set_draw_color(*col)
        pdf.set_fill_color(*col)
        pdf.set_line_width(0.18)
        pdf.line(px(i), py(v["h"]), px(i), py(v["l"]))
        yo, yc = py(v["o"]), py(v["c"])
        pdf.rect(px(i) - aw / 2, min(yo, yc), aw, max(0.35, abs(yc - yo)), style="F")

    # EMAs 10 y 20, encima de las velas — mismo orden de capas que TradingView.
    # Se calculan de los cierres de estas mismas velas (Sigma, la fuente con la
    # que decide el sistema); no hace falta pedir datos nuevos.
    cierres = [v["c"] for v in velas]
    emas_dibujadas = []
    for periodo, color in ((10, EMA_10), (20, EMA_20)):
        serie = calc_ema(cierres, periodo)
        puntos = [(px(i), py(p_)) for i, p_ in enumerate(serie) if p_ is not None]
        if len(puntos) < 2:
            continue          # ventana mas corta que el periodo: no se dibuja nada
        pdf.set_draw_color(*color)
        pdf.set_line_width(0.35)
        for (xa, ya), (xb, yb) in zip(puntos, puntos[1:]):
            pdf.line(xa, ya, xb, yb)
        emas_dibujadas.append((periodo, color))

    # Leyenda de las EMAs, arriba a la izquierda del panel
    if emas_dibujadas:
        lx, ly = x0 + 2.0, y0 + 3.0
        pdf.set_font("Helvetica", "", 6)
        for periodo, color in emas_dibujadas:
            pdf.set_draw_color(*color)
            pdf.set_line_width(0.35)
            pdf.line(lx, ly, lx + 4.0, ly)
            pdf.set_text_color(*color)
            pdf.set_xy(lx + 4.8, ly - 1.6)
            pdf.cell(12, 3, f"EMA {periodo}", align="L")
            lx += 20.0
        pdf.set_text_color(0, 0, 0)

    # Nivel de entrada y de salida
    pdf.set_line_width(0.3)
    if ent.get("price") is not None:
        pdf.set_draw_color(*LINEA_ENT)
        pdf.line(x0, py(ent["price"]), x0 + ancho, py(ent["price"]))
    if sal.get("price") is not None:
        pdf.set_draw_color(*(GREEN if chart.get("gano") else RED))
        pdf.set_dash_pattern(dash=1.2, gap=1.2)
        pdf.line(x0, py(sal["price"]), x0 + ancho, py(sal["price"]))
        pdf.set_dash_pattern()

    # Marcas
    def marca(i, precio, texto, color, arriba):
        if i is None or precio is None:
            return
        pdf.set_fill_color(*color)
        pdf.ellipse(px(i) - 1.1, py(precio) - 1.1, 2.2, 2.2, style="F")
        w, h = 11.0, 4.4
        yy = py(precio) - h - 1.6 if arriba else py(precio) + 1.6
        yy = min(max(yy, y0), y0 + alto - h)
        pdf.rect(px(i) - w / 2, yy, w, h, style="F")
        pdf.set_xy(px(i) - w / 2, yy)
        pdf.set_font("Helvetica", "B", 6)
        pdf.set_text_color(255, 255, 255)
        pdf.cell(w, h, sanitize(texto), align="C")

    alcista = (ent.get("label") or "BUY").upper() == "BUY"
    marca(iE, ent.get("price"), ent.get("label", "BUY"),
          GREEN if alcista else RED, not alcista)
    marca(iS, sal.get("price"), "EXIT",
          GREEN if chart.get("gano") else RED, alcista)

    # Marco y horas
    pdf.set_draw_color(*BORDER)
    pdf.set_line_width(0.2)
    pdf.rect(x0, y0, ancho, alto)
    pdf.set_font("Helvetica", "", 6)
    pdf.set_text_color(*MUTED)
    paso = max(1, len(velas) // 6)
    for i in range(0, len(velas), paso):
        et = velas[i].get("hora", "")
        if et:
            pdf.set_xy(px(i) - 6, y0 + alto + 0.6)
            pdf.cell(12, 3.4, sanitize(et), align="C")

    pdf.set_y(y0 + alto + 5)
    if chart.get("nota"):
        pdf.set_font("Helvetica", "", 7.5)
        pdf.set_text_color(*MUTED)
        pdf.multi_cell(ancho, 3.8, sanitize(chart["nota"]))
        pdf.ln(1)
    pdf.set_text_color(*TEXT)


def main():
    if len(sys.argv) < 2:
        print("Uso: python render_informe.py <spec.json>")
        sys.exit(1)
    spec_path = sys.argv[1]
    with open(spec_path, "r", encoding="utf-8") as f:
        spec = json.load(f)

    pdf = InformePDF(format="A4")
    pdf.set_auto_page_break(auto=True, margin=14)
    pdf.add_page()

    draw_title(pdf, spec.get("title", "Informe de Trade"), spec.get("subtitle", ""))
    draw_banner(pdf, spec.get("result_banner"))
    draw_meta(pdf, spec.get("meta"))

    for section in spec.get("sections", []):
        if pdf.get_y() > pdf.h - 40:
            pdf.add_page()
        draw_heading(pdf, section.get("heading", ""))
        if section.get("chart"):
            draw_chart(pdf, section["chart"])
        if section.get("checks"):
            draw_checks_table(pdf, section["checks"])
        if section.get("table"):
            draw_table(pdf, section["table"])
        if section.get("text"):
            draw_text(pdf, section["text"])

    output_path = spec["output_path"]
    pdf.output(output_path)
    print(f"OK: {output_path}")


if __name__ == "__main__":
    main()
