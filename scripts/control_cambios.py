# -*- coding: utf-8 -*-
"""
Control de cambios por estrategia, en Excel.

Por que existe: los cambios estaban en git y en CLAUDE.md, pero no habia forma
de ATRIBUIR resultados a versiones. Cuando se pregunta "¿este ajuste mejoro o
empeoro?", sin esto la unica respuesta honesta es "no se puede saber". El
objetivo de llegar a 80% de win rate por familia necesita poder aprender de
cada iteracion, no solo iterar.

Genera un libro por estrategia en su carpeta correspondiente:
  estrategia direccional/  -> control_cambios_direccional.xlsx
  neutral/                 -> control_cambios_neutral.xlsx
  reversion a la media/    -> control_cambios_reversion.xlsx

Cada libro trae 3 hojas: Cambios, Escala de impacto, Seguimiento.

NIVELES DE IMPACTO (la escala no es decorativa: define que hay que revalidar)
  ALTO  - Cambia CUANDO se entra o CUANDO se sale. Gatillos, umbrales de score,
          TP/SL, ventanas horarias, frenos. Puede alterar el resultado de todos
          los trades siguientes. Exige medir win rate antes/despues.
  MEDIO - Cambia CUANTO o CON QUE. Sizing, seleccion de strikes, deltas,
          anchos, filtros secundarios. Afecta la magnitud del resultado, no la
          decision de entrar.
  BAJO  - No cambia ninguna decision de trading. Registro, reportes, P&L
          historico, visualizacion, correccion de datos.

Uso:
  python scripts/control_cambios.py            # regenera desde git
  python scripts/control_cambios.py --dry-run  # muestra sin escribir
"""
import subprocess, sys, os, re
from datetime import datetime

REPO = r"C:\Users\gcarv\bitacora-tasty"
MENTORIA = (r"C:\Users\gcarv\Documents\CARPETA PERSONAL\01. guillermo carvajal"
            r"\01_Sigma\mentoria alejandro")
BASE = os.path.join(MENTORIA, "estrategias automatizadas")

DESTINOS = {
    "DIRECCIONAL": (os.path.join(BASE, "estrategia direccional"), "control_cambios_direccional.xlsx"),
    "NEUTRAL":     (os.path.join(BASE, "neutral"),                "control_cambios_neutral.xlsx"),
    "REVERSION":   (os.path.join(BASE, "reversion a la media"),   "control_cambios_reversion.xlsx"),
    "RUEDA":       (BASE,                                          "control_cambios_rueda.xlsx"),
    # Las dos bitacoras tambien llevan control (pedido del usuario). No son
    # estrategias, pero un error ahi puede hacer que una estrategia PAREZCA
    # buena o mala sin serlo — se vio el 2026-08-03: 39 de 62 trades tenian el
    # P&L mal calculado por la reconciliacion, y eso invalido horas de analisis
    # sobre el gatillo de entrada. Por eso se registran, no se ignoran.
    "BITACORA_TASTY":   (os.path.join(MENTORIA, "manual bitacora tasty"), "control_cambios_bitacora_tasty.xlsx"),
    "BITACORA_TRADIER": (os.path.join(MENTORIA, "analisis tradier"),      "control_cambios_bitacora_tradier.xlsx"),
}

# Las bitacoras se clasifican por ARCHIVOS tocados, no por palabras: el mensaje
# de un commit dice QUE cambio funcionalmente, no en cual de los dos tableros.
# Los archivos si lo dicen sin ambiguedad.
ARCHIVOS_BITACORA = {
    "BITACORA_TASTY":   ["public/index.html", "src/metrics.js", "src/wheel.js",
                         "src/tastytrade.js", "src/bp_adapter"],
    "BITACORA_TRADIER": ["public/tradier.html", "src/metrics_tradier.js",
                         "src/positions_tradier_adapter.js", "src/tradier_closed_pnl_adapter.js",
                         "src/bp_tradier_adapter.js"],
}

# La clasificacion se hace en cascada y EXCLUYENTE, no por coincidencia suelta
# de palabras: un cambio de La Rueda no es un cambio de las estrategias de SPX,
# y un cambio de reportes no es un cambio de estrategia en absoluto. Sin esto
# el registro se llena de ruido y deja de servir para atribuir resultados.

# 1. Cambios que NO son de estrategia: interfaz, reportes, visualizacion.
#    Se excluyen por completo — no alteran ninguna decision de trading.
NO_ESTRATEGIA = ["bitacora", "historial", "reporte", "monitor spx", "grafico", "dashboard",
                 "columna", "etiqueta", "pestaña", "boton", "pwa", "service worker", "informe",
                 "watchlist", "screener de acciones", "notebooklm", "skill", "daemon", "sigma terminal",
                 "tradingview", "premercado", "curva de capital", "calendario"]

# 2. La Rueda es un pipeline aparte (Tradier, acciones/ETF, horizonte de semanas).
RUEDA_KW = ["rueda", "wheel", "csp", "covered call", "cash-secured", "asignacion", "roll"]

# 3. Estrategias de SPX.
CLAVES = {
    "DIRECCIONAL": ["direccional", "camino b", "camino a", "pullback", "tendencia",
                    "playbook", "minscore", "weinstein", "trailing", "stop tecnico", "fractal", "poc",
                    "score", "spx 0dte"],
    "NEUTRAL":     ["iron condor", "condor", "neutral", "gex", "gamma flip", "vanna", "muros", "dex"],
    "REVERSION":   ["reversion", "sma8", "sma 8", "alejamiento", "juez", "bisturi", "vela garcia",
                    "vela tiburon", "vela 9", "compas", "rsi"],
}
# 4. Ejecucion y contabilidad: afecta a las TRES de SPX y a la Rueda por igual.
TRANSVERSAL = ["p&l", "pnl", "reconciliacion", "comision", "fill", "deslizamiento", "worstnetprice",
               "decimal", "orden fantasma", "ejecucion", "slippage", "broker"]

ALTO = ["gatillo", "pullback", "minscore", "umbral", "score", "tp", "sl", "stop", "ventana",
        "entrada", "salida", "veto", "gate", "freno", "peso", "repesaje", "trailing", "norma", "roll",
        # cambios en los insumos de la decision: mover un check de temporalidad,
        # activar/desactivar un indicador o tocar la confluencia cambia que se
        # opera, aunque el mensaje no diga "umbral".
        "check", "confluencia", "fase", "2m a 5m", "15m a 5m", "de 2m", "de 15m",
        "reactivar", "desactivar", "indicador", "señal", "signal", "macd", "ema", "sma"]
MEDIO = ["sizing", "delta", "strike", "ancho", "contrato", "riesgo", "capital", "filtro",
         "comision", "fee", "cordura", "sanidad", "fair value", "margin"]


def clasificar_familias(msg, archivos=''):
    m = msg.lower()
    fams = set()
    for fam, rutas in ARCHIVOS_BITACORA.items():
        if any(r in archivos for r in rutas):
            fams.add(fam)

    if any(k in m for k in NO_ESTRATEGIA):
        return fams   # cuenta para las bitacoras, no para las estrategias
    if any(k in m for k in RUEDA_KW):
        return fams | {"RUEDA"}                       # la Rueda no contamina a SPX
    # Si el commit nombra explicitamente una estrategia, esa manda. Sin esto,
    # "Reversion a la Media: veto GEX..." caia tambien en NEUTRAL por la palabra
    # "gex", y el registro de cada estrategia se llenaba de cambios ajenos.
    EXPLICITO = [("REVERSION", ["reversion a la media", "alejamiento de sma"]),
                 ("DIRECCIONAL", ["spx direccional", "direccional:", "camino b", "camino a"]),
                 ("NEUTRAL", ["iron condor", "long put condor"])]
    for fam, marcas in EXPLICITO:
        if any(k in m for k in marcas):
            return fams | {fam}
    porTema = {f for f, kws in CLAVES.items() if any(k in m for k in kws)}
    if porTema:
        return fams | porTema
    if any(k in m for k in TRANSVERSAL):
        return fams | {"DIRECCIONAL", "NEUTRAL", "REVERSION", "RUEDA"}
    return fams


def clasificar_impacto(msg):
    m = msg.lower()
    # Un fix de datos/reporte no cambia decisiones aunque mencione palabras de alto impacto.
    if any(k in m for k in ["bitacora", "historial", "reporte", "monitor spx", "grafico",
                            "dashboard", "columna", "etiqueta", "pestaña", "boton"]):
        return "BAJO"
    if any(k in m for k in ALTO):
        return "ALTO"
    if any(k in m for k in MEDIO):
        return "MEDIO"
    return "BAJO"


def leer_git():
    out = subprocess.run(
        ["git", "log", "--format=%h|%ad|%an|%s", "--date=format:%Y-%m-%d|%H:%M", "--since=2026-07-01"],
        cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace")
    filas = []
    for linea in out.stdout.strip().split("\n"):
        p = linea.split("|")
        if len(p) < 5:
            continue
        sha, fecha, hora, autor, asunto = p[0], p[1], p[2], p[3], "|".join(p[4:])
        filas.append(dict(sha=sha, fecha=fecha, hora=hora, autor=autor, asunto=asunto))
    return filas


def cuerpo_commit(sha):
    out = subprocess.run(["git", "log", "-1", "--format=%b", sha], cwd=REPO,
                         capture_output=True, text=True, encoding="utf-8", errors="replace")
    txt = " ".join(l.strip() for l in out.stdout.strip().split("\n")
                   if l.strip() and not l.startswith("Co-Authored-By"))
    return txt[:1200]


def archivos_commit(sha):
    out = subprocess.run(["git", "show", "--stat", "--format=", "--name-only", sha], cwd=REPO,
                         capture_output=True, text=True, encoding="utf-8", errors="replace")
    return ", ".join([f for f in out.stdout.strip().split("\n") if f][:6])


def construir():
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter

    commits = leer_git()
    print(f"commits leidos: {len(commits)}")
    dry = "--dry-run" in sys.argv

    COLORES = {"ALTO": "FFC7CE", "MEDIO": "FFEB9C", "BAJO": "C6EFCE"}

    for familia, (carpeta, archivo) in DESTINOS.items():
        filas = []
        for c in commits:
            if familia not in clasificar_familias(c["asunto"], archivos_commit(c["sha"])):
                continue
            filas.append(dict(c, impacto=clasificar_impacto(c["asunto"])))
        filas.sort(key=lambda r: (r["fecha"], r["hora"]), reverse=True)

        print(f"\n{familia}: {len(filas)} cambios  "
              f"(ALTO {sum(1 for f in filas if f['impacto']=='ALTO')}, "
              f"MEDIO {sum(1 for f in filas if f['impacto']=='MEDIO')}, "
              f"BAJO {sum(1 for f in filas if f['impacto']=='BAJO')})")
        if dry:
            for f in filas[:5]:
                print(f"   {f['fecha']} {f['hora']} [{f['impacto']:5}] {f['asunto'][:70]}")
            continue

        wb = Workbook()
        ws = wb.active
        ws.title = "Cambios"
        cols = ["Fecha", "Hora", "Impacto", "Qué cambió", "Por qué / detalle", "Quién lo pidió",
                "Dónde (archivos)", "Commit", "Trades bajo esta versión", "Win rate después", "Validado"]
        ws.append(cols)
        for i, col in enumerate(cols, 1):
            cel = ws.cell(1, i)
            cel.font = Font(bold=True, color="FFFFFF")
            cel.fill = PatternFill("solid", fgColor="1F3864")
            cel.alignment = Alignment(vertical="center", wrap_text=True)
        for f in filas:
            ws.append([f["fecha"], f["hora"], f["impacto"], f["asunto"], cuerpo_commit(f["sha"]),
                       f["autor"], archivos_commit(f["sha"]), f["sha"], "", "", ""])
            ws.cell(ws.max_row, 3).fill = PatternFill("solid", fgColor=COLORES[f["impacto"]])
        for col, ancho in zip("ABCDEFGHIJK", [11, 7, 9, 52, 80, 14, 34, 10, 22, 17, 11]):
            ws.column_dimensions[col].width = ancho
        for r in range(2, ws.max_row + 1):
            ws.cell(r, 4).alignment = Alignment(wrap_text=True, vertical="top")
            ws.cell(r, 5).alignment = Alignment(wrap_text=True, vertical="top")
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = f"A1:K{ws.max_row}"

        ws2 = wb.create_sheet("Escala de impacto")
        for fila in [
            ["Nivel", "Qué significa", "Qué hay que hacer al aplicarlo"],
            ["ALTO", "Cambia CUÁNDO se entra o CUÁNDO se sale: gatillos, umbrales de score, "
                     "TP/SL, ventanas horarias, frenos.",
                     "Medir win rate antes y después. No cambiar dos cosas de impacto alto a la vez — "
                     "si se mueven juntas, no se puede saber cuál funcionó."],
            ["MEDIO", "Cambia CUÁNTO o CON QUÉ: sizing, selección de strikes, deltas, anchos, "
                      "filtros secundarios.",
                      "Revisar el P&L medio por trade. La decisión de entrar no cambia, "
                      "así que el win rate debería moverse poco."],
            ["BAJO", "No cambia ninguna decisión de trading: registro, reportes, P&L histórico, "
                     "visualización, corrección de datos.",
                     "No requiere revalidación de la estrategia. Pero si corrige P&L histórico, "
                     "invalida las comparaciones hechas antes de la corrección."],
        ]:
            ws2.append(fila)
        for i in range(1, 4):
            ws2.cell(1, i).font = Font(bold=True, color="FFFFFF")
            ws2.cell(1, i).fill = PatternFill("solid", fgColor="1F3864")
        for col, ancho in zip("ABC", [10, 62, 72]):
            ws2.column_dimensions[col].width = ancho
        for r in range(2, 5):
            for cc in range(1, 4):
                ws2.cell(r, cc).alignment = Alignment(wrap_text=True, vertical="top")
            ws2.cell(r, 1).fill = PatternFill("solid", fgColor=COLORES[ws2.cell(r, 1).value])

        ws3 = wb.create_sheet("Seguimiento")
        ws3.append(["Objetivo", "Win rate 80%"])
        ws3.append(["Ambito", familia])
        ws3.append([])
        ws3.append(["Cómo se llena", ""])
        ws3.append(["1", "Cada cambio de impacto ALTO abre un período nuevo de medición."])
        ws3.append(["2", "Los trades se atribuyen por huella de versión (campo algoVersion de cada "
                         "ejecución, ver src/algo_version.js) — no por fecha, porque un mismo día "
                         "puede tener dos versiones."])
        ws3.append(["3", "No se compara contra períodos anteriores al 2026-08-03: 39 de los 62 trades "
                         "direccionales previos tienen el P&L mal calculado por el /gainloss viejo, "
                         "y son irrecuperables."])
        ws3.append(["4", "Muestra mínima antes de concluir: 30 trades. Con menos, la diferencia "
                         "entre 60% y 80% no es distinguible del azar."])
        ws3.append([])
        ws3.append(["Período (huella)", "Desde", "Hasta", "Trades", "Ganadores", "Win rate", "P&L", "Notas"])
        for i in range(1, 9):
            ws3.cell(10, i).font = Font(bold=True, color="FFFFFF")
            ws3.cell(10, i).fill = PatternFill("solid", fgColor="1F3864")
        ws3.column_dimensions["A"].width = 20
        ws3.column_dimensions["B"].width = 92
        for col in "CDEFGH":
            ws3.column_dimensions[col].width = 13
        for r in range(4, 9):
            ws3.cell(r, 2).alignment = Alignment(wrap_text=True, vertical="top")

        os.makedirs(carpeta, exist_ok=True)
        destino = os.path.join(carpeta, archivo)
        try:
            wb.save(destino)
            print(f"   -> {destino}")
        except PermissionError:
            alt = destino.replace(".xlsx", "_nuevo.xlsx")
            wb.save(alt)
            print(f"   -> ABIERTO EN EXCEL, guardado como {alt}")


if __name__ == "__main__":
    construir()
