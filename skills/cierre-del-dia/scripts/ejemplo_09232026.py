# Informe cierre del día 23-sep-2026: se agrega al final del .docx del día + log + Excel.
import json, shutil
from docx import Document
from docx.shared import Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn

BASE = r"C:\Users\gcarv\Documents\CARPETA PERSONAL\01. guillermo carvajal\01_Sigma\mentoria alejandro\premercados alejandro"
DOC = BASE + r"\documentos premercado\09232026_premercado claude.docx"
LOG = BASE + r"\control premercado\premercado_hipotesis_log.json"
XLS = BASE + r"\control premercado\control_premercado.xlsx"

DOC = BASE + r"\documentos premercado9232026_cierre del dia.docx"
from docx.shared import Inches
doc = Document()
for sec in doc.sections:
    sec.top_margin = sec.bottom_margin = sec.left_margin = sec.right_margin = Inches(0.75)
for sn in ("Normal", "Heading 1", "Heading 2", "Heading 3", "List Bullet"):
    st = doc.styles[sn]; st.font.name = "Tahoma"; st.font.size = Pt(11)
    rpr = st.element.get_or_add_rPr(); rf = rpr.find(qn('w:rFonts'))
    if rf is None:
        rf = rpr.makeelement(qn('w:rFonts'), {}); rpr.append(rf)
    rf.set(qn('w:eastAsia'), 'Tahoma')
    if sn in ("Normal", "List Bullet"):
        st.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY

def fuente(run, size=11, bold=None):
    run.font.name = "Tahoma"; run.font.size = Pt(size)
    rpr = run._element.get_or_add_rPr()
    rf = rpr.find(qn('w:rFonts'))
    if rf is None:
        rf = rpr.makeelement(qn('w:rFonts'), {}); rpr.append(rf)
    rf.set(qn('w:eastAsia'), 'Tahoma')
    if bold is not None: run.bold = bold

def H(t, l=2):
    h = doc.add_heading("", level=l); fuente(h.add_run(t))
def P(t):
    p = doc.add_paragraph(); fuente(p.add_run(t)); p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
def B(t):
    p = doc.add_paragraph(style="List Bullet"); fuente(p.add_run(t)); p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
def tabla(cols, filas):
    t = doc.add_table(rows=1, cols=len(cols)); t.style = "Light Grid Accent 1"
    for i, c in enumerate(cols):
        cell = t.rows[0].cells[i]; cell.text = ""
        fuente(cell.paragraphs[0].add_run(c), 9.5, True); cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.LEFT
    for f in filas:
        row = t.add_row()
        for i, v in enumerate(f):
            cell = row.cells[i]; cell.text = ""
            fuente(cell.paragraphs[0].add_run(str(v)), 9.5); cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.LEFT
    doc.add_paragraph()

H("Cierre del día — miércoles 23 de septiembre de 2026", 1)
P("Hora del informe: 18:45 ET. Día sin trade para las estadísticas del premercado (D19: crudo EIA de 3 estrellas a las 10:30).")

H("Qué hizo el mercado", 3)
P("Abrió en 7.762 y cerró en 7.706: −59 puntos (−0,75 %) contra el cierre del martes (7.765). Máximo 7.762 en la "
  "primera vela, mínimo 7.695 a las 13:00. Rango de 67 puntos, el más amplio de la semana. El VIX subió de 14,2 a "
  "15,2 (máximo 15,5): caída ordenada, sin pánico.")
B("09:30 — Abrió sobre el Flip (7.761) y en la primera vela bajó al Put Wall: cierre de 15m en 7.750, sin romperlo.")
B("09:45 — Salieron los PMI flash muy por encima de lo esperado (manufacturero 57,0 contra 53,6; servicios 58,7 "
  "contra 55,8). Economía caliente = tasas altas por más tiempo, y el mercado lo leyó como malo para las acciones. "
  "Esa vela cerró en 7.737: activó el Bajista y cruzó a la baja la EMA10 sobre la EMA20 de 15m.")
B("10:00 — La tercera vela bajó hasta 7.722 y cerró en 7.726: T1 (7.740) y T2 (7.725) cumplidos en media hora.")
B("10:30 — El crudo EIA salió con una subida de inventarios de +2,97M (se esperaba −0,70M). No movió al SPX.")
B("10:45 a 12:15 — Rebote a 7.735 que se frenó debajo de la EMA20 de 15m, y una hora y media de rango 7.713-7.727, "
  "con el Call Wall y el MVS de Sigma juntos en 7.725 como techo.")
B("12:30 a 13:00 — Segunda pierna bajista: perdió la EMA50 de 30m y llegó a 7.695, tocando el Put Wall (7.700).")
B("13:30 a 16:00 — Rebote a 7.720 y deriva lateral-bajista. Última vela: mecha a 7.696 y cierre en 7.706, "
  "defendiendo otra vez el 7.700.")

H("Escenarios del premercado contra lo que pasó", 3)
tabla(["Escenario", "Prob.", "¿Se validó?", "Nota"],
 [["Bajista — pierde el Put Wall", "37 %", "SÍ, completo",
   "Activó al cierre de las 09:45 (7.737, bajo 7.747 con el colchón). T1 7.740 y T2 7.725 en la misma media hora. "
   "La invalidación (7.770) nunca estuvo en juego: después de activar, el máximo fue 7.741."],
  ["Alcista — recupera el Flip", "32 %", "NO",
   "Nunca activó: el máximo del día fue la apertura, 7.762, debajo de 7.770."],
  ["Neutral — el piso aguanta", "31 %", "NO",
   "El corredor 7.750-7.770 se rompió a los quince minutos."]])

H("¿Acertamos?", 3)
P("SÍ, con la versión corregida: el Bajista era el favorito (37 %) y se validó entero. Con la versión de las 08:55, "
  "que daba favorito al Neutral (37 %) porque había descartado los PMI, la respuesta habría sido NO. El dato que "
  "decidió el día fue precisamente el que el informe original había dejado afuera. Como es día D19, no suma a la "
  "asertividad ni a los totales.")

H("Cómo quedó Sigma al cierre", 3)
P("Lectura de las 16:05 ET, cadena del 23-sep (la que venció hoy). El régimen se dio vuelta por completo: el GEX "
  "pasó de +8,7 B a las 08:30 a −49,7 B al cierre, y el DEX a −14,1 B. Los muros se juntaron sobre el precio de "
  "cierre (Call Wall 7.710, Put Wall y MVS 7.705) y el Flip quedó en 7.758, 52 puntos arriba. Esta cadena ya "
  "venció: los muros de mañana se leen en el premercado. Lo que sí sirve es el tono: el día terminó en gamma "
  "negativo, con los dealers acompañando los movimientos en vez de frenarlos.")

H("Qué puede pasar mañana, jueves 24 de septiembre", 3)
P("Estructura al cierre:")
B("Diario: sigue alcista. El cierre (7.706) está 40 puntos sobre la EMA10 diaria (7.666) y la EMA20 (7.661). Hoy fue "
  "el primer retroceso real después del +114 del lunes, y devolvió la mitad.")
B("30 minutos: debajo de la EMA20 (7.724) y encima de la EMA200 (7.675). La EMA10 (7.716) cruzó debajo de la EMA20.")
B("15 minutos: el cruce EMA10/EMA20 sigue bajista desde las 09:45, pero la distancia entre las dos se achicó a la "
  "mitad desde las 13:00 (de −12 a −6). Un cierre de 15m sobre la EMA20 de 15m (7.716) pone el cruce alcista a tiro.")
B("Fuera de hora: el ES de diciembre está en 7.777 a las 18:25 ET. Con la base de hoy (64,7) equivale a 7.712: "
  "apertura implícita ~+6, plana por ahora.")
P("Niveles para mañana (entre paréntesis, en tu pantalla VANTAGE, con +10):")
tabla(["Nivel", "Qué es"],
 [["7.740 (7.750)", "Max Pain de hoy y T1 de hoy: primera resistencia seria"],
  ["7.725 (7.735)", "EMA20 de 30m y techo de la mañana de hoy: el nivel que define si el rebote tiene fuerza"],
  ["7.715 (7.725)", "EMA10 y EMA20 de 15m, y EMA50 de 30m: el pivote de la apertura"],
  ["7.700 / 7.695 (7.710 / 7.705)", "Put Wall de hoy y mínimo del día, defendido dos veces"],
  ["7.675 (7.685)", "EMA200 de 30m"],
  ["7.665 (7.675)", "EMA10 y EMA20 diarias: el soporte de la tendencia de fondo"],
  ["7.645 (7.655)", "Cierre del viernes 18: el gap del lunes completo"]])
P("Catalizadores de 3 estrellas (Investing): subsidio por desempleo a las 08:30 ET (pronóstico 201K, previo 196K) y "
  "ventas de viviendas nuevas a las 10:00 ET (pronóstico 615K, previo 607K). Ninguno a las 10:15 o después, así que "
  "mañana SÍ se opera. El de las 10:00 cae dentro de la tercera vela: la hipótesis activa se califica con el dato "
  "recién publicado, y el cóndor no se arma hasta que se digiera.")
P("Llamada para mañana: BAJISTA, convicción 55 %. Se activa con un cierre de 15m bajo 7.695 (7.705 en pantalla): "
  "pierde el mínimo de hoy y el Put Wall, en gamma negativo. T1 7.675 (EMA200 de 30m), T2 7.665 (EMA diarias). Se "
  "invalida con un cierre de 15m sobre 7.725 (7.735): recupera la EMA20 de 30m, y ahí lo probable es el rebote hacia "
  "7.740. El lado alcista tiene argumentos reales: la tendencia diaria está intacta, el 7.700 aguantó dos veces y "
  "el cruce de 15m se está cerrando. Por eso la convicción es baja. Esta llamada no se edita: mañana se puntúa sola.")
doc.save(DOC)

L = json.load(open(LOG, encoding='utf-8'))
e = [x for x in L if x['fecha'] == '2026-09-23'][0]
e['resultado'] = {
    "escenario_validado": "bajista (activo al cierre 15m de las 09:45 en 7.737,47; T1 7.740 y T2 7.725 en la vela de las 10:00; minimo 7.694,89 a las 13:00)",
    "apertura_real": 7761.94, "maximo": 7761.94, "minimo": 7694.89, "cierre_real": 7706.03,
    "acierto": "si",
    "acierto_nota": "Favorito corregido (09:25) = bajista 37% -> SI. Con la version de las 08:55 (neutral 37% favorito) habria sido NO. Dia D19: fuera de asertividad y totales.",
    "veredicto_mecanico": "Bajista VALIDADO: cierre 15m 09:45 = 7.737,47 < 7.747 (7.750-3); max posterior 7.741 < 7.773 (7.770+3). Alcista NO_ACTIVO (max 7.761,94 < 7.773). Neutral INVALIDADO en la vela de las 09:45.",
    "leccion_aprendida": "El dato que decidio el dia (PMI flash 57,0/58,7 contra 53,6/55,8) fue justo el que el informe de las 08:55 habia descartado por un filtro propio. Con los catalizadores bien leidos el favorito era el correcto. El regimen paso de +8,7B a -49,7B de GEX en la sesion: la lectura de Sigma de las 08:30 no anticipa un dia de catalizador.",
    "catalizadores_resultado": [
        {"evento": "PMI manufacturero (flash)", "actual": 57.0, "pronostico": 53.6, "reaccion": "vela 09:45 -12 pts, activo el bajista"},
        {"evento": "PMI de servicios (flash)", "actual": 58.7, "pronostico": 55.8, "reaccion": "idem"},
        {"evento": "Crudo EIA", "actual": 2.969, "pronostico": -0.7, "reaccion": "sin reaccion en el SPX"},
    ],
    "sigma_cierre": {"capturado": "2026-09-23T20:05:40Z", "call_wall": 7710, "put_wall": 7705, "gamma_flip": 7758, "mvs": 7705, "max_pain": 7740, "net_gex_b": -49.67, "net_dex_b": -14.13, "regimen": "NEGATIVO"},
}
e['llamada_siguiente'] = {
    "para_fecha": "2026-09-24", "emitida_et": "2026-09-23T18:45", "spot_cierre": 7706.03,
    "direccion": "BAJISTA", "conviccion": 55,
    "activa": {"tipo": "cierre_15m_bajo", "nivel": 7695},
    "invalida": {"tipo": "cierre_15m_sobre", "nivel": 7725},
    "t1": 7675, "t2": 7665,
    "tesis": "Gamma negativo profundo al cierre (-49,7B), cruce EMA10/20 bajista en 15m y 30m y PMI caliente (tasas); si pierde el minimo 7.695 va a la EMA200 30m y a las EMA diarias. Conviccion baja: tendencia diaria intacta y 7.700 defendido dos veces.",
    "resultado": None,
}
json.dump(L, open(LOG, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

import openpyxl
wb = openpyxl.load_workbook(XLS); ws = wb['Control Premercado']
assert ws.cell(66, 1).value == '2026-09-23'
ws.cell(66, 4).value = ws.cell(66, 4).value + (' || INFORME CIERRE DEL DIA (18:45 ET): Bajista VALIDADO completo (activo 09:45 en 7.737; T1 y T2 a las 10:00; min 7.695). '
    'Cierre 7.706 (-59, -0,75%). Acierto SI con la version corregida (NO con la de 08:55). Dia D19. Sigma cierre GEX -49,7B. '
    'Llamada 24-sep: BAJISTA 55% bajo 7.695, invalida sobre 7.725, T1 7.675 T2 7.665. Manana 3 estrellas: subsidios 08:30 y viviendas nuevas 10:00 (se opera).')
wb.save(XLS)
print('OK')
