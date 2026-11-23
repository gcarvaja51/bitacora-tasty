# -*- coding: utf-8 -*-
"""Rellena en la hoja Hiro (/api/capas) las lecturas de Discord que faltaron el 23-nov-2026 entre 10:00 y 13:20
(sesión del bot caída), con datos RECONSTRUIDOS de las pantallas de la tarde. Pedido de Guillermo (23-nov):
- Gamma Flip GB minuto a minuto: digitalizado de la captura de GexBot Classic de las 15:57 (gexbot_flip_historia.json).
- HIRO de SpotGamma: curva del día de la captura de las 15:55, recortada a la hora de cada lectura (mediana de 7 min).
- Bola 8: las predicciones de texto del historial del canal (bola8/bola8_predicciones.json), en su hora exacta.
El servidor no guarda campos extra, así que la marca "reconstruido" queda en RECONSTRUIDO.md de esta carpeta.
Uso: python rellenar_manana.py [--seco]"""
import json, os, sys
import numpy as np
AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(AQUI, '..', '..', 'gexbot-sombra'))
import confluencia   # enviar_capas (misma clave y destino que el bot)

m = lambda hm: int(hm[:2]) * 60 + int(hm[3:5])
hm_ = lambda t: f'{t // 60:02d}:{t % 60:02d}'
FLIP = json.load(open(os.path.join(AQUI, 'gexbot_flip_historia.json')))
SPX = {f['hora']: f['spx'] for f in json.load(open(os.path.join(AQUI, 'hiro.json'), encoding='utf-8'))['filas']}
regs = json.load(open(os.path.join(AQUI, 'capas.json'), encoding='utf-8'))['registros']
hc = [r for r in regs if (r.get('hiro') or {}).get('curva') and r['at'][11:16] >= '15:50'][-1]['hiro']['curva']
def limpia(col):
    d = {m(x[0]): x[col] for x in hc if x[col] is not None}; out = {}
    for t in sorted(d):
        v = [d[u] for u in range(t - 3, t + 4) if u in d]; out[t] = round(float(np.median(v)), 3)
    return out
C, P = limpia(1), limpia(2)
B8 = json.load(open(os.path.join(AQUI, 'bola8', 'bola8_predicciones.json')))

lecturas = []
for t in range(m('10:00'), m('13:20') + 1, 5):
    hm = hm_(t); d = {'at': f'2026-11-23T{hm}:00-05:00', 'spx': SPX.get(hm)}
    if hm in FLIP and hm >= '10:30': d['gexbot_classic'] = {'gamma_flip_gb': FLIP[hm]}   # antes de 10:30 la línea se confunde con otra amarilla
    curva = [[hm_(u), C[u], P.get(u)] for u in sorted(C) if u <= t]
    if curva: d['hiro'] = {'hiro_bn': curva[-1][1], 'calls_bn': curva[-1][1], 'puts_bn': curva[-1][2], 'curva': curva}
    lecturas.append(d)
for hm, precio, cierre, lo, hi in B8:
    if not ('10:00' <= hm <= '13:20'): continue
    lecturas.append({'at': f'2026-11-23T{hm}:30-05:00', 'spx': SPX.get(hm),
                     'bola8': {'sesgo': 'bullish', 'objetivo1': cierre, 'objetivo2': lo if hi == cierre else hi, 'precio': precio}})
lecturas.sort(key=lambda d: d['at'])
print(len(lecturas), 'lecturas;', sum('bola8' in d for d in lecturas), 'de Bola 8;', sum('gexbot_classic' in d for d in lecturas), 'con flip')
if '--seco' in sys.argv:
    print(json.dumps(lecturas[0])[:300]); print(json.dumps([d for d in lecturas if 'bola8' in d][0])); sys.exit()
ok = sum(1 for d in lecturas if confluencia.enviar_capas(d) == 200)
print('enviadas OK:', ok, 'de', len(lecturas))
