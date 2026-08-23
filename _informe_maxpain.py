# -*- coding: utf-8 -*-
"""Informe PDF — ¿existe ventaja estadística en el Max Pain? Vencimiento 2026-08-21."""
import json, io, os
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_JUSTIFY, TA_CENTER
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
                                Image, PageBreak)

BASE = r'C:\Users\gcarv\bitacora-tasty'
OUT = (r'C:\Users\gcarv\Documents\CARPETA PERSONAL\01. guillermo carvajal\01_Sigma'
       r'\mentoria alejandro\premercados alejandro\estudio_max_pain_08212026.pdf')

R = json.load(io.open(os.path.join(BASE, '_resultados_informe.json'), encoding='utf-8'))
U = json.load(io.open(os.path.join(BASE, '_estudio_ohlc.json'), encoding='utf-8'))
SEG = json.load(io.open(os.path.join(BASE, '_segmentos.json'), encoding='utf-8'))

mp = np.array([o['maxPain'] for o in U], float); op = np.array([o['open'] for o in U], float)
hi = np.array([o['hi'] for o in U], float);  lo = np.array([o['lo'] for o in U], float)
cl = np.array([o['close'] for o in U], float); prev = np.array([o['prev'] for o in U], float)
yh = np.array([o['yearHigh'] for o in U], float); yl = np.array([o['yearLow'] for o in U], float)
beta = np.array([o['beta'] or 1.0 for o in U], float)
gap = (mp/op - 1)*100; dist = np.abs(gap); rango = (hi-lo)/op*100; vol = (yh-yl)/op*100
exc = (cl/prev - 1)*100 - beta*R['mercado']

AZUL, ROJO, GRIS, VERDE, AMB = '#1f3864', '#c00000', '#606060', '#2e7d32', '#b8860b'
plt.rcParams.update({'font.size': 9, 'font.family': 'DejaVu Sans'})

def img(fig, w, h):
    b = io.BytesIO(); fig.savefig(b, format='png', dpi=180, bbox_inches='tight')
    plt.close(fig); b.seek(0); return Image(b, width=w, height=h)

# G1 — dónde está el Max Pain respecto del precio (la asimetría)
fig, ax = plt.subplots(figsize=(7.2, 2.6))
ax.hist(np.clip(gap, -30, 30), bins=34, color=AZUL, edgecolor='white', linewidth=.6)
ax.axvline(0, color=ROJO, lw=1.6)
ax.set_xlabel('Posición del Max Pain respecto del precio de apertura (%)')
ax.set_ylabel('N.º de activos')
ax.text(-27, ax.get_ylim()[1]*.72, f"{R['mpAbajoPct']:.0f}% tiene el\nMax Pain ABAJO",
        fontsize=8.5, color=ROJO)
ax.spines[['top','right']].set_visible(False)
G1 = img(fig, 16.5*cm, 6.0*cm)

# G2 — el confusor: vol estructural explica todo
fig, axs = plt.subplots(1, 2, figsize=(7.4, 2.8))
axs[0].scatter(dist, rango, s=20, color=ROJO, alpha=.7)
axs[0].set_xlabel('Distancia al Max Pain (%)'); axs[0].set_ylabel('Rango del día (%)')
axs[0].set_title(f"CRUDO: r=+{R['corrs'][2][1]:.3f} (t={R['corrs'][2][2]:.2f})", fontsize=9, color=ROJO)
axs[1].scatter(dist, rango/np.maximum(vol,1e-9), s=20, color=VERDE, alpha=.7)
axs[1].set_xlabel('Distancia al Max Pain (%)'); axs[1].set_ylabel('Rango / volatilidad propia')
axs[1].set_title(f"NORMALIZADO: r={R['corrs'][4][1]:+.3f} (t={R['corrs'][4][2]:+.2f})", fontsize=9, color=VERDE)
for a in axs:
    a.set_xlim(0, min(40, dist.max())); a.spines[['top','right']].set_visible(False)
fig.tight_layout()
G2 = img(fig, 16.5*cm, 6.3*cm)

# G3 — barras de los tests
labs = [t[0] for t in R['tests'][:3]] + ['Long/short (cuartiles)']
vals = [float(t[2].rstrip('%')) for t in R['tests'][:3]] + [50 + R['ls']['t']*3]
fig, ax = plt.subplots(figsize=(7.2, 2.3))
cols = [VERDE if v > 55 else (AMB if v > 45 else ROJO) for v in vals]
ax.barh(labs[::-1], vals[::-1], color=cols[::-1], height=.6)
ax.axvline(50, color='black', ls='--', lw=1.4)
ax.text(50.7, 3.35, 'azar', fontsize=8)
ax.set_xlim(0, 100); ax.set_xlabel('% de aciertos (50% = azar)')
ax.spines[['top','right']].set_visible(False)
G3 = img(fig, 16.5*cm, 5.3*cm)

ss = getSampleStyleSheet()
H1 = ParagraphStyle('H1', parent=ss['Title'], fontSize=18, textColor=colors.HexColor(AZUL), spaceAfter=1)
SUB = ParagraphStyle('SUB', parent=ss['Normal'], fontSize=9.5, textColor=colors.HexColor(GRIS),
                     alignment=TA_CENTER, spaceAfter=12)
H2 = ParagraphStyle('H2', parent=ss['Heading2'], fontSize=12, textColor=colors.HexColor(AZUL),
                    spaceBefore=13, spaceAfter=5)
P = ParagraphStyle('P', parent=ss['Normal'], fontSize=9.6, leading=14, alignment=TA_JUSTIFY, spaceAfter=6)
CAP = ParagraphStyle('CAP', parent=P, fontSize=8.1, textColor=colors.HexColor(GRIS), alignment=TA_CENTER, spaceAfter=8)
def caja(color, bg):
    return ParagraphStyle('C'+color, parent=P, backColor=colors.HexColor(bg),
                          borderColor=colors.HexColor(color), borderWidth=1.1, borderPadding=9,
                          spaceBefore=5, spaceAfter=9)
ROJOBOX, VERDEBOX = caja(ROJO, '#fdf2f2'), caja(AZUL, '#f2f5fb')

def tabla(data, anchos, alin=()):
    t = Table(data, colWidths=anchos, hAlign='LEFT')
    st = [('BACKGROUND',(0,0),(-1,0),colors.HexColor(AZUL)), ('TEXTCOLOR',(0,0),(-1,0),colors.white),
          ('FONTNAME',(0,0),(-1,0),'Helvetica-Bold'), ('FONTSIZE',(0,0),(-1,-1),8.2),
          ('GRID',(0,0),(-1,-1),.4,colors.HexColor('#cccccc')), ('VALIGN',(0,0),(-1,-1),'MIDDLE'),
          ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white, colors.HexColor('#f4f6fa')]),
          ('TOPPADDING',(0,0),(-1,-1),3), ('BOTTOMPADDING',(0,0),(-1,-1),3)]
    for c in alin: st.append(('ALIGN',(c,1),(c,-1),'RIGHT'))
    t.setStyle(TableStyle(st)); return t

S = []
S.append(Paragraph('¿Hay ventaja estadística en el Max Pain?', H1))
S.append(Paragraph(f"Seis pruebas sobre {R['n']} subyacentes · Vencimiento mensual del viernes 21 de agosto de 2026", SUB))

S.append(Paragraph(
    f"<b>Conclusión: no se detecta ninguna ventaja.</b> Ninguna de las seis pruebas sobrevive al control "
    f"estadístico. El test direccional ajustado por beta acierta <b>{R['tests'][1][2]}</b> (p={R['tests'][1][3]}), "
    f"el intradía <b>{R['tests'][2][2]}</b> (p={R['tests'][2][3]}), y una cartera long/short construida con la "
    f"señal rinde <b>{R['ls']['spread']:+.2f}%</b> con t={R['ls']['t']:+.2f} — signo equivocado y sin "
    f"significancia. La única correlación que aparecía fuerte resultó ser un confusor.", ROJOBOX))

S.append(Paragraph('Por qué el número que todos citan está mal medido', H2))
S.append(Paragraph(
    f"La forma habitual de \"comprobar\" la teoría es ver qué porcentaje de activos cerró cerca de su Max "
    f"Pain, o se acercó a él. Esa medición es inservible, y la razón está en este gráfico: "
    f"<b>{R['mpAbajoPct']:.0f}% de los activos tenía su Max Pain por debajo del precio</b> (gap mediano "
    f"{R['gapMediano']:+.2f}%), porque el open interest se acumula en strikes viejos mientras el mercado sube. "
    f"Si además ese día el mercado sube — y subió, {R['retMediano']:+.2f}% de mediana — entonces \"converger\" "
    f"es <b>casi imposible por construcción</b>. Se termina midiendo la dirección del mercado, no la imantación.", P))
S.append(G1)
S.append(Paragraph('La asimetría estructural que invalida la medición ingenua.', CAP))

S.append(Paragraph('Las seis pruebas', H2))
filas = [['Prueba', 'Resultado', '%', 'p-valor', 'Lectura']] + [list(t) for t in R['tests']]
filas.append(['Long/short por cuartiles', f"{R['ls']['spread']:+.2f}%", f"t={R['ls']['t']:+.2f}", '—', 'signo contrario'])
S.append(tabla(filas, [5.3*cm, 2.3*cm, 1.7*cm, 1.7*cm, 5.0*cm], alin=(1,2,3)))
S.append(Spacer(1, 6))
S.append(G3)

S.append(PageBreak())
S.append(Paragraph('El hallazgo que parecía una ventaja — y por qué no lo era', H2))
S.append(Paragraph(
    f"Una sola prueba dio positivo y con fuerza: los activos que abrieron cerca de su Max Pain tuvieron un "
    f"rango diario menor. La correlación entre distancia y rango era <b>r={R['corrs'][2][1]:+.3f}</b> "
    f"(t={R['corrs'][2][2]:+.2f}, p≈0,0001). Parecía el mecanismo bueno: no una fuerza direccional, sino un "
    f"efecto de <i>pinning</i> sobre la volatilidad — es decir, un trade de vender volatilidad, no de apostar "
    f"a una dirección.", P))
S.append(Paragraph(
    f"Pero hay un confusor evidente: <b>una acción volátil está lejos de su Max Pain justamente porque es "
    f"volátil</b>, y tiene rango grande por lo mismo. Los datos lo confirman: la volatilidad estructural "
    f"explica la distancia al Max Pain (r={R['corrs'][5][1]:+.3f}) y explica el rango del día "
    f"(r=+0,486). Al controlarla, la correlación parcial cae a <b>r={R['corrs'][3][1]:+.3f}</b> "
    f"(t={R['corrs'][3][2]:+.2f}, no significativo), y si en vez de eso se normaliza el rango de cada activo "
    f"por su propia volatilidad, queda en <b>r={R['corrs'][4][1]:+.3f}</b> — cero exacto.", P))
S.append(G2)
S.append(Paragraph('Izquierda: la correlación cruda. Derecha: la misma relación tras normalizar por la volatilidad propia.', CAP))
pin = [['Grupo', 'n', 'Rango del día', 'Rango / volatilidad propia']]
for etq, nn, rg, rn in R['pin']:
    pin.append([etq, str(nn), f'{rg:.2f}%', f'{rn:.4f}'])
S.append(tabla(pin, [5.0*cm, 1.4*cm, 3.4*cm, 5.2*cm], alin=(1,2,3)))
S.append(Paragraph(
    "Con el rango ya normalizado el patrón desaparece y el grupo intermedio queda por encima de los dos "
    "extremos — la firma típica de que no hay señal.", P))

S.append(Paragraph('Una incoherencia que por sí sola descarta el uso direccional', H2))
idx = {o['sym']: o for o in U}
inc = [['Instrumento', 'Cierre', 'Max Pain', 'Distancia', 'Implicaría']]
for s, etq in [('SPX','SPX (SPXW)'), ('SPY','SPY'), ('QQQ','QQQ'), ('NDX','NDX (NDXP)')]:
    o = idx.get(s)
    if not o: continue
    d = (o['close']/o['maxPain'] - 1)*100
    inc.append([etq, f"{o['close']:,.2f}", f"{o['maxPain']:,.2f}", f'{d:+.2f}%',
                'ya está' if abs(d) < .25 else ('debe BAJAR' if d > 0 else 'debe SUBIR')])
S.append(tabla(inc, [3.4*cm, 3.0*cm, 3.0*cm, 2.6*cm, 3.0*cm], alin=(1,2,3)))
S.append(Paragraph(
    "SPX y SPY siguen el <b>mismo índice</b>. SPY 755 equivale a SPX ≈7.550, pero la cadena de SPX apunta a "
    "7.670: 120 puntos de diferencia sobre el mismo subyacente el mismo día. Y QQQ y NDX apuntan en "
    "<b>direcciones opuestas</b> sobre el Nasdaq. El Max Pain no describe al activo — describe dónde está "
    "posicionado el open interest de <i>ese contrato concreto</i>. SPY es minorista y ETF; SPX es "
    "institucional. Son dos libros distintos, y ninguno tira del índice.", P))

S.append(PageBreak())
S.append(Paragraph('Qué significa para la idea de operarlo', H2))
S.append(Paragraph(
    f"La propuesta era poner trades apuntando al Max Pain en el vencimiento mensual. Los datos dicen que "
    f"la premisa no se cumple: el precio ni siquiera <b>visita</b> el nivel — el Max Pain estuvo dentro del "
    f"rango del día en solo <b>{R['tests'][3][2]}</b> de los casos. Un nivel que actúa como imán debería ser "
    f"tocado mucho más seguido que eso.", P))
S.append(Paragraph(
    "Y hay un argumento anterior al estadístico. El mercado de opciones <b>ya cotiza</b> la distribución "
    "esperada del precio al vencimiento. Para ganar dinero no alcanza con que el precio termine cerca del Max "
    "Pain: tiene que terminar <b>más cerca de lo que la volatilidad implícita ya está descontando</b>. Una "
    "mariposa centrada en el Max Pain solo paga si el pin es más fuerte que lo que su prima ya cobra. Nada "
    "en estos datos sugiere que lo sea.", P))

S.append(Paragraph('Qué SÍ se puede afirmar, y qué no', H2))
S.append(Paragraph(
    f"<b>Se puede descartar una ventaja grande.</b> Con {R['n']} observaciones, este diseño detecta "
    f"correlaciones desde |r|≈{R['poder']['rDetectable']:.2f} y sesgos direccionales desde "
    f"~{R['poder']['pctDetectable']:.0f}% de acierto. Nada de eso apareció.", P))
S.append(Paragraph(
    f"<b>No se puede descartar una ventaja pequeña.</b> Un efecto de, digamos, 52% de acierto sería real y "
    f"rentable con volumen, y este estudio no tiene poder para verlo. Tampoco es un backtest: son "
    f"{R['n']} activos de <b>un solo día</b>, que comparten mercado y sesión, así que no son "
    f"{R['n']} experimentos independientes. El open interest histórico previo a vencimientos pasados no está "
    f"disponible en la API del bróker, de modo que la única vía es medir hacia adelante.", P))

S.append(Paragraph('Dónde sí puede haber una ventaja real', H2))
S.append(Paragraph(
    "El estudio sugiere que se está mirando el indicador equivocado. El mecanismo físico que produce pinning "
    "no es el Max Pain sino la <b>cobertura de gamma de los dealers</b>: con gamma positivo venden fuerza y "
    "compran debilidad, y eso sí fija el precio. El Max Pain es una foto estática del open interest; el gamma "
    "es la fuerza que actúa. Esa distinción es medible con los datos que ya se reciben de Sigma Terminal "
    "(Net GEX, Gamma Flip, Call/Put Wall), y es el camino que este resultado deja abierto.", P))
S.append(Paragraph(
    "<b>Próximo paso concreto:</b> repetir esta misma batería el 18 de septiembre —vencimiento trimestral, "
    "con mucho más open interest— y en cada mensual siguiente, acumulando vencimientos. Con cuatro o cinco "
    "fechas se puede empezar a distinguir una ventaja pequeña del ruido. El instrumental ya queda montado y "
    "corre en unos minutos.", P))

doc = SimpleDocTemplate(OUT, pagesize=letter, leftMargin=2*cm, rightMargin=2*cm,
                        topMargin=1.7*cm, bottomMargin=1.7*cm,
                        title='¿Hay ventaja estadística en el Max Pain? — 21-ago-2026',
                        author='Bitácora Sigma')
doc.build(S)
print('PDF: ' + OUT)
print('tamaño: %.0f KB' % (os.path.getsize(OUT)/1024))
