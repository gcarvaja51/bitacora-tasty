# -*- coding: utf-8 -*-
"""Memoria del precio por nivel: "mirar a la izquierda" para elegir T1 y T2 (2026-09-24).

Pedido de Guillermo: "analicemos con más cuidado los T1, T2 de alcista y bajista... miremos a
la izquierda y lo valoramos". Origen: el 24-sep señaló que 7.665 tenía mucho interés en el
pasado, y al medirlo resultó que la zona 7.665-7.675 era la más negociada de todo el tramo
7.640-7.710 desde julio.

Qué mide, sobre las velas de 15m del SPX en horario regular (Yahoo ^GSPC, 60 días):
  - pasadas: velas cuyo rango pasa a ±2 pts del nivel
  - cierres: velas que cierran a ±2,5 pts del nivel
  - giros:   mínimos o máximos locales (4 velas a cada lado) a ±3 pts del nivel, con fecha
Y con eso una "memoria" = cierres + 4 × giros, comparada con la mediana del tramo.

Uso:
  python memoria_niveles.py --alcista 7700 --bajista 7665 [--hasta 2026-09-23] [--rango 90]
    --alcista / --bajista: niveles de ACTIVACIÓN del día. Los objetivos se buscan por encima
    de la activación alcista y por debajo de la bajista.
    --hasta: último día que cuenta (por defecto, ayer). Nunca incluye el día que se analiza.

Salida: por cada dirección, los niveles candidatos (múltiplos de 5) ordenados por distancia,
marcando los que tienen memoria FUERTE (≥ 1,5 × la mediana) o MEDIA (≥ la mediana), con sus
giros más recientes, y un SUGERIDO por dirección:
  T1 = el más fuerte de los dos primeros niveles con memoria (MEDIA o FUERTE) que estén a
       --min-dist (10) o más de la activación (más cerca queda dentro del colchón de 3 pts).
  T2 = el primer nivel FUERTE a 10 pts o más del T1; si no hay, el más fuerte de los dos
       siguientes con memoria.
Es una lectura de estructura, no una probabilidad: cuánto "se discutió" un precio antes.
"""
import argparse, json, ssl, urllib.request
from datetime import date, timedelta
from zoneinfo import ZoneInfo
import pandas as pd

ET = ZoneInfo('America/New_York')


def velas15(hasta):
    ctx = ssl._create_unverified_context()
    url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=15m&range=60d'
    r = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}), context=ctx, timeout=60))
    q = r['chart']['result'][0]; c = q['indicators']['quote'][0]
    m = pd.DataFrame({'h': c['high'], 'l': c['low'], 'c': c['close']},
                     index=pd.to_datetime(q['timestamp'], unit='s', utc=True).tz_convert(ET)).dropna()
    m = m[(m.index.time >= pd.Timestamp('09:30').time()) & (m.index.time < pd.Timestamp('16:00').time())]
    return m[m.index.date <= hasta]


def medir(m, niveles, w=4):
    piv_l = m[m.l == m.l.rolling(2 * w + 1, center=True).min()]
    piv_h = m[m.h == m.h.rolling(2 * w + 1, center=True).max()]
    out = {}
    for k in niveles:
        pasadas = int(((m.l <= k + 2) & (m.h >= k - 2)).sum())
        cierres = int(((m.c - k).abs() <= 2.5).sum())
        gl = [i for i, v in piv_l.l.items() if abs(v - k) <= 3]
        gh = [i for i, v in piv_h.h.items() if abs(v - k) <= 3]
        giros = sorted(gl + gh)
        out[k] = dict(pasadas=pasadas, cierres=cierres, giros=len(giros),
                      ultimos=[g.strftime('%d-%b').lower() for g in giros[-3:]],
                      memoria=cierres + 4 * len(giros))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--alcista', type=float, required=True)
    ap.add_argument('--bajista', type=float, required=True)
    ap.add_argument('--hasta', default=None)
    ap.add_argument('--rango', type=int, default=90)
    ap.add_argument('--min-dist', type=int, default=10)
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()
    hasta = date.fromisoformat(a.hasta) if a.hasta else date.today() - timedelta(days=1)
    m = velas15(hasta)
    lo = int((a.bajista - a.rango) // 5 * 5); hi = int((a.alcista + a.rango) // 5 * 5 + 5)
    niveles = list(range(lo, hi + 1, 5))
    med = medir(m, niveles)
    mediana = pd.Series([v['memoria'] for v in med.values()]).median()
    for k, v in med.items():
        v['fuerza'] = 'FUERTE' if v['memoria'] >= 1.5 * mediana else ('MEDIA' if v['memoria'] >= mediana else 'debil')
    def sugerir(cands, act, signo):
        # T1: el más fuerte de los dos primeros niveles con memoria (MEDIA o FUERTE) a >= min-dist
        # de la activación. T2: el primer FUERTE a >= 10 pts más allá del T1; si no hay, el más
        # fuerte de los dos siguientes con memoria. Un nivel dentro del colchón no sirve de objetivo.
        util = [c for c in cands if c['fuerza'] != 'debil' and abs(c['nivel'] - act) >= a.min_dist]
        if not util:
            return None, None
        t1 = max(util[:2], key=lambda c: c['memoria'])
        resto = [c for c in util if signo * (c['nivel'] - t1['nivel']) >= 10]
        fuertes = [c for c in resto if c['fuerza'] == 'FUERTE']
        t2 = fuertes[0] if fuertes else (max(resto[:2], key=lambda c: c['memoria']) if resto else None)
        return t1, t2
    res = {'desde': str(m.index[0].date()), 'hasta': str(m.index[-1].date()), 'mediana_memoria': float(mediana),
           'alcista': [dict(nivel=k, **med[k]) for k in niveles if k > a.alcista],
           'bajista': [dict(nivel=k, **med[k]) for k in reversed(niveles) if k < a.bajista]}
    for lado, act, signo in (('alcista', a.alcista, 1), ('bajista', a.bajista, -1)):
        t1, t2 = sugerir(res[lado], act, signo)
        res['sugerido_' + lado] = {'t1': t1['nivel'] if t1 else None, 't2': t2['nivel'] if t2 else None}
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=1)); return
    print(f"Velas 15m {res['desde']} -> {res['hasta']}; mediana de memoria del tramo {mediana:.0f}")
    for lado in ('alcista', 'bajista'):
        print(f"\n{lado.upper()} (desde la activación hacia afuera):")
        for x in res[lado]:
            if x['fuerza'] == 'debil':
                continue
            cerca = '  (dentro de la distancia minima)' if abs(x['nivel'] - (a.alcista if lado == 'alcista' else a.bajista)) < a.min_dist else ''
            print(f"  {x['nivel']}  {x['fuerza']:6}  memoria {x['memoria']:3}  (pasadas {x['pasadas']}, cierres {x['cierres']}, giros {x['giros']}: {', '.join(x['ultimos'])}){cerca}")
        sg = res['sugerido_' + lado]
        print(f"  -> SUGERIDO: T1 {sg['t1']}  T2 {sg['t2']}")


if __name__ == '__main__':
    main()
