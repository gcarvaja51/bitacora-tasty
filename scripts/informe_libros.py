# -*- coding: utf-8 -*-
"""Informe diario de los cuatro libros del Demo Tasty (fase 2 paso 3, 2026-11-16).

Guillermo: "hagamos un informe automatico diario con las ejecuciones de cada uno de los 4 grupos para saber
que trades se hicieron y el resultado del dia".

Python puro, SIN Claude: baja /api/libros/diario (solo lectura), arma el PDF y lo manda por WhatsApp
(linea Colombia, chat propio de Guillermo). El mismo dia da siempre el mismo numero.

  python scripts/informe_libros.py                    hoy (dia de Nueva York), genera y envia
  python scripts/informe_libros.py --fecha 2026-11-13 otro dia
  python scripts/informe_libros.py --no-enviar        solo genera el PDF
  python scripts/informe_libros.py --forzar           aunque no sea dia de mercado

Salidas en informes_libros/: Libros_AAAA-MM-DD.pdf, .json (lo que respondio el servidor) y .txt (resumen
para el correo). Codigos: 0 generado (y enviado si aplica) · 3 no es dia de mercado · 1 fallo.

SOLO se envia a Guillermo. Los saldos de los libros nunca se suman.
"""
import argparse
import base64
import json
import os
import sys
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

from reportlab.lib import colors
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

BASE = os.environ.get('BITACORA_URL', 'https://web-production-23473.up.railway.app')
RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(RAIZ, 'informes_libros')
WA_DIR = r'C:\Users\gcarv\Documents\CARPETA PERSONAL\whatsapp'
DESTINO = '573186252537@s.whatsapp.net'        # chat propio de Guillermo, linea Colombia. No cambiar.
NY = ZoneInfo('America/New_York')
MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo']

VERDE, ROJO, GRIS, AZUL = colors.HexColor('#1a7f37'), colors.HexColor('#c62828'), colors.HexColor('#666666'), colors.HexColor('#12355b')
_ss = getSampleStyleSheet()
N = ParagraphStyle('n', parent=_ss['Normal'], fontName='Helvetica', fontSize=8, leading=10)
NB = ParagraphStyle('nb', parent=N, fontName='Helvetica-Bold')
CH = ParagraphStyle('ch', parent=N, fontSize=7, leading=8.5, textColor=GRIS)
H1 = ParagraphStyle('h1', parent=N, fontName='Helvetica-Bold', fontSize=15, leading=18, textColor=AZUL)
H2 = ParagraphStyle('h2', parent=N, fontName='Helvetica-Bold', fontSize=11, leading=14, textColor=AZUL, spaceBefore=8, spaceAfter=3)
H3 = ParagraphStyle('h3', parent=N, fontName='Helvetica-Bold', fontSize=8.5, leading=11, spaceBefore=5, spaceAfter=2)
AV = ParagraphStyle('av', parent=N, textColor=colors.HexColor('#8a5a00'))


def esc(s):
    return str(s if s is not None else '').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('\u2212', '-').replace('\u2192', 'a')


def usd(x, signo=True):
    if x is None:
        return '—'
    s = f'{abs(x):,.2f}'.replace(',', 'X').replace('.', ',').replace('X', '.')
    return ('-' if x < 0 else ('+' if signo and x > 0 else '')) + '$' + s


def usd_color(x):
    if x is None:
        return Paragraph('—', N)
    c = '#1a7f37' if x > 0 else ('#c62828' if x < 0 else '#333333')
    return Paragraph(f'<font color="{c}"><b>{usd(x)}</b></font>', N)


def hora(iso, fecha):
    """Hora de Nueva York; si es de otro dia, antepone la fecha."""
    if not iso:
        return '—'
    try:
        d = datetime.fromisoformat(str(iso).replace('Z', '+00:00')).astimezone(NY)
    except ValueError:
        return '—'
    h = d.strftime('%H:%M')
    return h if d.strftime('%Y-%m-%d') == fecha else f'{d.day}-{MESES[d.month - 1]} {h}'


def precio(x):
    return '—' if x is None else f'{x:.2f}'


def fecha_larga(f):
    d = datetime.strptime(f, '%Y-%m-%d')
    return f'{DIAS[d.weekday()]} {d.day}-{MESES[d.month - 1]}-{d.year}'


def tabla(filas, anchos, cabecera=True, extra=None):
    t = Table(filas, colWidths=anchos, repeatRows=1 if cabecera else 0, hAlign='LEFT')
    est = [('FONTSIZE', (0, 0), (-1, -1), 8), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
           ('GRID', (0, 0), (-1, -1), 0.25, colors.HexColor('#cccccc')),
           ('TOPPADDING', (0, 0), (-1, -1), 2), ('BOTTOMPADDING', (0, 0), (-1, -1), 2)]
    if cabecera:
        est += [('BACKGROUND', (0, 0), (-1, 0), AZUL), ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold')]
    t.setStyle(TableStyle(est + (extra or [])))
    return t


def filas_trades(lista, fecha):
    out = [['Abrió', 'Cerró', 'Grupo', 'Trade', 'Entrada', 'Salida', 'Comis.', 'Neto', 'Estado']]
    for f in lista:
        desc = esc(f['descripcion'])
        if isinstance(f.get('extra'), str) and f['extra']:
            desc += f'<br/><font size="6.5" color="#666666">{esc(f["extra"])}</font>'
        if f.get('nota'):
            desc += f'<br/><font size="6.5" color="#666666">{esc(f["nota"])}</font>'
        if f['estado'] == 'cerrado':
            estado = esc(f.get('motivo') or 'cerrado')
            neto = usd_color(f['neto']) if f['neto'] is not None else Paragraph('<font color="#8a5a00">pendiente de asentar</font>', N)
        else:
            estado = 'ABIERTO'
            neto = Paragraph(f'<font color="#666666">latente {usd(f["latente"])}</font>', N) if f.get('latente') is not None else Paragraph('—', N)
        out.append([hora(f['abiertaAt'], fecha), hora(f['cerradaAt'], fecha), Paragraph(esc(f['grupo']), N), Paragraph(desc, N),
                    precio(f['entrada']), precio(f['salida']), usd(f['comisiones'], False) if f['comisiones'] is not None else '—', neto,
                    Paragraph(estado, N)])
    return out


ANCHOS_T = [22 * mm, 22 * mm, 32 * mm, 66 * mm, 16 * mm, 16 * mm, 17 * mm, 30 * mm, 38 * mm]


def construir_pdf(dia, ruta):
    fecha = dia['fecha']
    doc = SimpleDocTemplate(ruta, pagesize=landscape(letter), leftMargin=10 * mm, rightMargin=10 * mm, topMargin=9 * mm, bottomMargin=9 * mm,
                            title=f'Demo Tasty - informe diario {fecha}', author='Bitácora Tasty')
    h = [Paragraph(f'Demo Tasty · informe diario · {esc(fecha_larga(fecha))}', H1),
         Paragraph('Cuatro libros independientes de $10.000. Los saldos no se suman. Todo es demo: dry-run en TastyTrade, sin órdenes reales. '
                   'Horas de Nueva York. El resultado del día es lo CERRADO hoy, neto de comisiones.', CH), Spacer(1, 4)]
    if not dia.get('diaDeMercado', True):
        h.append(Paragraph('Hoy no fue día de mercado en Nueva York.', AV))

    # ── resumen ──
    res = [['Libro', 'Resultado del día', 'Abrió hoy', 'Cerró hoy', 'Ganados', 'Abiertos ahora', 'Latente', 'Saldo']]
    for L in dia['libros']:
        if L.get('error'):
            res.append([Paragraph(f'<b>{esc(L["libro"])}</b>', N), Paragraph(f'<font color="#c62828">sin datos: {esc(L["error"])}</font>', N), '', '', '', '', '', ''])
            continue
        res.append([Paragraph(f'<b>{esc(L["libro"])}</b>', N), usd_color(L['resultadoHoy']) if L['cerradosHoy'] else Paragraph('sin cierres', N),
                    L['abiertosHoy'], L['cerradosHoy'], L['ganadosHoy'] if L['cerradosHoy'] else '—', L['abiertasAhora'],
                    usd(L['latente']) if L.get('latente') is not None else '—', usd(L['saldo'], False)])
    h.append(tabla(res, [45 * mm, 45 * mm, 24 * mm, 24 * mm, 22 * mm, 30 * mm, 30 * mm, 32 * mm]))

    # ── detalle por libro ──
    for L in dia['libros']:
        h.append(Paragraph(esc(L['libro']), H2))
        if L.get('error'):
            h.append(Paragraph(f'<font color="#c62828">No se pudo leer este libro: {esc(L["error"])}</font>', N))
            continue
        for a in L.get('avisos', []):
            h.append(Paragraph('Aviso: ' + esc(a), AV))
        if L['movimientos']:
            h.append(Paragraph('Trades de hoy', H3))
            h.append(tabla(filas_trades(L['movimientos'], fecha), ANCHOS_T))
        else:
            h.append(Paragraph('Sin trades hoy.', N))

        if L['libro'] == 'Robot SPX':
            pe = L.get('porEstrategiaHoy') or []
            if pe:
                h.append(Paragraph('Por estrategia (hoy)', H3))
                h.append(tabla([['Estrategia', 'Abrió', 'Cerró', 'Ganados', 'Neto del día']] +
                               [[x['estrategia'], x['abiertos'], x['cerrados'], x['ganados'], usd_color(x['neto']) if x['cerrados'] else '—'] for x in pe],
                               [45 * mm, 22 * mm, 22 * mm, 22 * mm, 35 * mm]))
            e = L.get('espejo') or {}
            h.append(Paragraph('Espejo de Tradier (Mediodía, Iron Condor, Reversión)', H3))
            if not e.get('encendido', True):
                h.append(Paragraph('<font color="#c62828">APAGADO.</font>', N))
            elif not e.get('desde'):
                h.append(Paragraph('Encendido, todavía sin su primera revisión con mercado abierto.', N))
            elif not e.get('copiadosHoy') and not e.get('noCopiadosHoy') and not e.get('cerradosHoy'):
                h.append(Paragraph('Encendido. Tradier no llenó hoy ningún trade de estas estrategias.', N))
            else:
                h.append(tabla([['Copiados hoy', 'Cerrados hoy', 'No copiados', 'Retraso prom.', 'Comparables', 'Demo Tasty (neto)', 'Tradier (bruto)'],
                                [e.get('copiadosHoy', 0), e.get('cerradosHoy', 0), e.get('noCopiadosHoy', 0),
                                 f"{e['retrasoProm']} s" if e.get('retrasoProm') is not None else '—', e.get('comparables', 0),
                                 usd_color(e.get('demoNeto')) if e.get('comparables') else '—', usd_color(e.get('tradierBruto')) if e.get('comparables') else '—']],
                               [28 * mm, 28 * mm, 26 * mm, 28 * mm, 26 * mm, 36 * mm, 36 * mm]))
                h.append(Paragraph('Comparables: trades cerrados hoy en los dos lados con precio propio del demo. El demo va neto de comisiones; Tradier va bruto.', CH))

        viejas = [f for f in L['abiertas'] if f not in L['movimientos']]
        if viejas:
            h.append(Paragraph('Siguen abiertas de días anteriores', H3))
            h.append(tabla(filas_trades(viejas, fecha), ANCHOS_T))
        if L['noEntraron']:
            h.append(Paragraph('No entraron hoy', H3))
            h.append(tabla([['Hora', 'Grupo', 'Trade', 'Motivo']] +
                           [[hora(f['abiertaAt'] or f['cerradaAt'], fecha), Paragraph(esc(f['grupo']), N), Paragraph(esc(f['descripcion']), N), Paragraph(esc(f.get('motivo') or ''), N)]
                            for f in L['noEntraron']], [22 * mm, 36 * mm, 70 * mm, 131 * mm]))
    gen = datetime.fromisoformat(dia['generado'].replace('Z', '+00:00')).astimezone(NY)
    h += [Spacer(1, 6), Paragraph(f'Generado {gen.strftime("%Y-%m-%d %H:%M")} ET desde {esc(BASE)}/api/libros/diario', CH)]
    doc.build(h)


def resumen_texto(dia):
    f = dia['fecha']
    d = datetime.strptime(f, '%Y-%m-%d')
    lin = [f'Demo Tasty · informe diario · {DIAS[d.weekday()]} {d.day}-{MESES[d.month - 1]}']
    for L in dia['libros']:
        if L.get('error'):
            lin.append(f'• {L["libro"]}: SIN DATOS ({L["error"]})')
            continue
        if L['cerradosHoy']:
            t = f'{usd(L["resultadoHoy"])} ({L["cerradosHoy"]} cerrado{"s" if L["cerradosHoy"] != 1 else ""}, {L["ganadosHoy"]} ganado{"s" if L["ganadosHoy"] != 1 else ""})'
        elif L['abiertosHoy']:
            t = f'abrió {L["abiertosHoy"]}, sin cierres'
        else:
            t = 'sin trades'
        if L['abiertasAhora']:
            t += f' · {L["abiertasAhora"]} abierto{"s" if L["abiertasAhora"] != 1 else ""}'
        lin.append(f'• {L["libro"]}: {t} · saldo {usd(L["saldo"], False)}')
        for a in L.get('avisos', []):
            lin.append(f'   ⚠ {a}')
    lin.append('Los saldos no se suman. Detalle en el PDF.')
    return '\n'.join(lin)


def enviar_whatsapp(ruta, pie):
    import requests  # solo aqui: generar el PDF no depende de requests
    cred = {}
    for linea in open(os.path.join(WA_DIR, 'credenciales.txt'), encoding='utf-8'):
        if ':' in linea:
            k, v = linea.split(':', 1)
            cred[k.strip()] = v.strip()
    cuentas = json.load(open(os.path.join(WA_DIR, 'cuentas.json'), encoding='utf-8'))
    auth = base64.b64encode(f"{cred['usuario']}:{cred['password']}".encode()).decode()
    cab = {'X-Device-Id': cuentas['colombia']['device_id'], 'Authorization': 'Basic ' + auth}
    with open(ruta, 'rb') as fh:
        r = requests.post(os.environ.get('GOWA_URL', 'http://127.0.0.1:3001') + '/send/file', headers=cab, timeout=120,
                          data={'phone': DESTINO, 'caption': pie}, files={'file': (os.path.basename(ruta), fh, 'application/pdf')})
    if r.status_code >= 300:
        raise RuntimeError(f'GOWA {r.status_code}: {r.text[:300]}')
    return r.text[:200]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fecha')
    ap.add_argument('--no-enviar', action='store_true')
    ap.add_argument('--forzar', action='store_true')
    ap.add_argument('--json', help='usar este JSON en vez de bajar del servidor (pruebas)')
    a = ap.parse_args()
    try:
        if a.json:
            dia = json.load(open(a.json, encoding='utf-8'))
        else:
            url = BASE + '/api/libros/diario' + (f'?fecha={a.fecha}' if a.fecha else '')
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'informe-libros'}), timeout=90) as r:
                dia = json.loads(r.read().decode('utf-8'))
        if not dia.get('ok'):
            raise RuntimeError('el servidor respondió sin ok: ' + str(dia)[:200])
        if not dia.get('diaDeMercado', True) and not a.forzar:
            print(f"{dia['fecha']}: no es día de mercado, no se genera informe")
            return 3
        os.makedirs(SALIDA, exist_ok=True)
        base = os.path.join(SALIDA, f"Libros_{dia['fecha']}")
        json.dump(dia, open(base + '.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        texto = resumen_texto(dia)
        open(base + '.txt', 'w', encoding='utf-8').write(texto)
        construir_pdf(dia, base + '.pdf')
        open(os.path.join(SALIDA, 'ultimo.txt'), 'w', encoding='utf-8').write(base)   # lo lee la fase del correo
        print('PDF:', base + '.pdf')
        print(texto)
        if not a.no_enviar:
            print('WhatsApp:', enviar_whatsapp(base + '.pdf', texto))
        return 0
    except Exception as e:  # noqa: BLE001 - la tarea programada necesita el motivo en el log
        print('FALLO:', repr(e))
        return 1


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
