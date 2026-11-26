# Arma datos.json del reel del 25-nov (mismo esquema que el del 24-nov) desde lo que capturó el bot de Discord y las velas de la bitácora.
# OCR: el lector a veces lee el 7 inicial como 4 (4020 en vez de 7020); se corrige sumando 3000 a todo nivel < 5000.
import json, os
S = os.path.dirname(os.path.abspath(__file__))
HIST = r'C:/Users/gcarv/Documents/CARPETA PERSONAL/01. guillermo carvajal/01. Trading/Bitacoras/bitacora-historicos/discord/2026-11-25/confluencia.jsonl'
VELAS = r'C:/Users/gcarv/AppData/Local/Temp/claude/e2c288fa3f57c4db/3724c13a-77e6-4c83-adbe-85a4b0985897/scratchpad/hiro_2026-11-25.json'
fx = lambda v: None if v is None else (v + 3000 if v < 5000 else v)
hm = lambda s: s[11:16]
v = json.load(open(VELAS, encoding='utf-8'))
D = dict(spx={f['hora']: [f['o'], f['h'], f['l'], f['spx']] for f in v['filas']},
         hiro_propio={f['hora']: [round(f['calls'] / 1e9, 3), round(f['puts'] / 1e9, 3), round(f['total'] / 1e9, 3)] for f in v['filas']},
         cierre_previo=v['cierrePrevio'], flip={}, gex=[], state=[], tradytics=[], bola8=[], hiro_curva=[])
vis = set()
for x in map(json.loads, open(HIST, encoding='utf-8')):
    if not ('09:29' <= hm(x['at']) <= '12:30'): continue
    for k in ('gexbot_classic', 'gexbot_state', 'tradytics', 'bola8', 'hiro'):
        c = x.get(k)
        if not c or (k, c.get('archivo') or c.get('capturado_at')) in vis: continue
        vis.add((k, c.get('archivo') or c.get('capturado_at'))); t = hm(c.get('capturado_at') or x['at'])
        if t < '09:30': continue
        if k == 'gexbot_classic' and c.get('gamma_flip_gb'):
            f = fx(c['gamma_flip_gb'])
            if 6900 < f < 7200: D['flip'][t] = round(f, 2); D['gex'].append([t, fx(c.get('iman_neg_gb')), round(f, 2), fx(c.get('iman_pos_gb')), x.get('spx')])
        elif k == 'gexbot_state' and c.get('freno_gamma'):
            D['state'].append([t, round(fx(c['freno_gamma']), 2), round(fx(c['acelerador_gamma']), 2) if c.get('acelerador_gamma') else None])
        elif k == 'tradytics' and c.get('sentimiento'):
            D['tradytics'].append([t, c['sentimiento'], (c.get('exceso_prima') or c.get('exceso'))])
        elif k == 'bola8' and c.get('sesgo'):
            D['bola8'].append([t, c['sesgo'], c.get('fuerza'), c.get('objetivo1'), c.get('objetivo2'), c.get('precio')])
        elif k == 'hiro' and c.get('curva') and t <= '11:45':
            D['hiro_curva'] = c['curva']
D['flip'] = dict(sorted(D['flip'].items()))
json.dump(D, open(os.path.join(S, 'datos.json'), 'w', encoding='utf-8'), ensure_ascii=False)
print({k: len(v) for k, v in D.items() if hasattr(v, '__len__')})
print('flip', list(D['flip'].items())[:4], '...', list(D['flip'].items())[-4:])
print('state', D['state'][:2], D['state'][-2:]); print('bola8', D['bola8']); print('tradytics', D['tradytics'][-2:])
