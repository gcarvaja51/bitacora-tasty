# -*- coding: utf-8 -*-
"""¿Hay pinning hacia el Max Pain en la ULTIMA SEMANA antes del vencimiento?

Diseno: se usa como blanco el Max Pain FINAL (el del dia del vencimiento). Eso le da
a la teoria la maxima ventaja posible -- en la vida real ese nivel no se conocia el
lunes -- asi que si aun asi no aparece efecto, no lo hay.

Placebo: se mide exactamente lo mismo en las 3 semanas anteriores, contra el MISMO
blanco. Cualquier tendencia a acercarse que aparezca tambien ahi es linea de base,
no pinning. Lo que importa es el EXCESO de la semana de vencimiento.
"""
import json, io, math
import numpy as np

H = json.load(io.open(r'C:\Users\gcarv\bitacora-tasty\_historico.json', encoding='utf-8'))

# Calendario comun (dias de mercado) tomado de SPX
spx = next(h for h in H if h['sym'] == 'SPX')
fechas = [b['fecha'] for b in spx['barras']]
i_venc = fechas.index('2026-08-21')

# Semanas de 5 ruedas: la del vencimiento y las 3 anteriores
BLOQUES = [('Vencimiento (17-21 ago)', i_venc-4, i_venc),
           ('Previa  (10-14 ago)',     i_venc-9, i_venc-5),
           ('2 antes (3-7 ago)',       i_venc-14, i_venc-10),
           ('3 antes (28-31 jul)',     i_venc-19, i_venc-15)]

def serie(h):
    m = {b['fecha']: b for b in h['barras']}
    return [m.get(f) for f in fechas]

def t_de_r(r, N):
    return r*math.sqrt((N-2)/max(1e-12, 1-r*r))

def t_pareado(d):
    d = np.asarray(d, float); d = d[np.isfinite(d)]
    if len(d) < 3: return float('nan'), float('nan'), 0
    return d.mean(), d.mean()/(d.std(ddof=1)/math.sqrt(len(d))), len(d)

print('='*78)
print('PINNING EN LA SEMANA DE VENCIMIENTO — 113 subyacentes, blanco = Max Pain final')
print('='*78)

# Retorno del mercado por bloque (SPX), para contexto
spx_s = serie(spx)
print('\nContexto de cada bloque (movimiento del SPX):')
for etq, a, b in BLOQUES:
    if spx_s[a] and spx_s[b]:
        print(f'   {etq:26s} SPX {(spx_s[b]["c"]/spx_s[a]["o"]-1)*100:+6.2f}%')

print('\n' + '-'*78)
print('A) ¿SE ACERCA EL PRECIO AL MAX PAIN DURANTE LA SEMANA?')
print('-'*78)
print(f'   {"Bloque":26s} {"n":>4} {"d.inicio":>9} {"d.final":>9} {"cambio":>9} {"t pareado":>10} {"conv%":>7}')
resumen = {}
for etq, a, b in BLOQUES:
    difs, d0s, d1s, conv = [], [], [], []
    for h in H:
        s = serie(h); mp = h['maxPain']
        if not s[a] or not s[b] or not mp: continue
        d0 = abs(s[a]['o'] - mp)/mp*100      # distancia al ABRIR el bloque
        d1 = abs(s[b]['c'] - mp)/mp*100      # distancia al CERRAR el bloque
        difs.append(d1 - d0); d0s.append(d0); d1s.append(d1); conv.append(d1 < d0)
    m, t, n = t_pareado(difs)
    resumen[etq] = dict(n=n, d0=float(np.median(d0s)), d1=float(np.median(d1s)),
                        cambio=m, t=t, conv=float(np.mean(conv)*100))
    print(f'   {etq:26s} {n:4d} {np.median(d0s):8.2f}% {np.median(d1s):8.2f}% '
          f'{m:+8.2f}pp {t:+10.2f} {np.mean(conv)*100:6.1f}%')
print('\n   cambio NEGATIVO = se acerco al Max Pain. La teoria exige que la primera')
print('   fila sea claramente mas negativa que las otras tres.')

print('\n' + '-'*78)
print('B) EXCESO DE LA SEMANA DE VENCIMIENTO vs LAS PREVIAS')
print('-'*78)
venc = resumen[BLOQUES[0][0]]
base = np.mean([resumen[e[0]]['cambio'] for e in BLOQUES[1:]])
baseconv = np.mean([resumen[e[0]]['conv'] for e in BLOQUES[1:]])
print(f'   acercamiento en semana de vencimiento : {venc["cambio"]:+.3f} pp   (conv {venc["conv"]:.1f}%)')
print(f'   promedio de las 3 semanas previas     : {base:+.3f} pp   (conv {baseconv:.1f}%)')
print(f'   >> EXCESO ATRIBUIBLE AL VENCIMIENTO   : {venc["cambio"]-base:+.3f} pp   '
      f'({venc["conv"]-baseconv:+.1f} pp de convergencia)')

print('\n' + '-'*78)
print('C) ¿SE COMPRIME LA VOLATILIDAD HACIA EL VENCIMIENTO?  (el otro mecanismo)')
print('-'*78)
print(f'   {"Bloque":26s} {"rango medio diario":>20}')
rangos = {}
for etq, a, b in BLOQUES:
    rr = []
    for h in H:
        s = serie(h)
        v = [(x['h']-x['l'])/x['c']*100 for x in s[a:b+1] if x and x['c']]
        if v: rr.append(np.mean(v))
    rangos[etq] = float(np.median(rr))
    print(f'   {etq:26s} {np.median(rr):19.2f}%')
print(f'\n   vencimiento vs promedio previas: '
      f'{rangos[BLOQUES[0][0]] - np.mean([rangos[e[0]] for e in BLOQUES[1:]]):+.3f} pp')
print('   (el pinning predice compresion: la semana de vencimiento deberia tener MENOS rango)')

print('\n' + '-'*78)
print('D) SOLO LOS QUE EMPEZARON LA SEMANA CERCA DEL MAX PAIN (<=2%)')
print('-'*78)
print('   Es donde el pin deberia agarrar: si ya estas cerca, el iman te retiene.')
a, b = BLOQUES[0][1], BLOQUES[0][2]
cerca_d, lejos_d = [], []
for h in H:
    s = serie(h); mp = h['maxPain']
    if not s[a] or not s[b] or not mp: continue
    d0 = abs(s[a]['o'] - mp)/mp*100; d1 = abs(s[b]['c'] - mp)/mp*100
    (cerca_d if d0 <= 2 else lejos_d).append(d1 - d0)
for etq, arr in [('empezo a <=2% del MP', cerca_d), ('empezo a >2%', lejos_d)]:
    m, t, n = t_pareado(arr)
    conv = np.mean(np.array(arr) < 0)*100 if arr else float('nan')
    print(f'   {etq:24s} n={n:3d}  cambio {m:+.3f} pp  t={t:+.2f}  convergio {conv:.1f}%')

print('\n' + '-'*78)
print('E) DIA A DIA DE LA SEMANA DE VENCIMIENTO')
print('-'*78)
print('   Si el pin existe, la distancia mediana deberia bajar rueda a rueda.')
for k in range(5):
    i = i_venc-4+k
    ds = []
    for h in H:
        s = serie(h); mp = h['maxPain']
        if s[i] and mp: ds.append(abs(s[i]['c']-mp)/mp*100)
    print(f'   {fechas[i]}  (T-{4-k})  distancia mediana al Max Pain: {np.median(ds):5.2f}%   n={len(ds)}')
