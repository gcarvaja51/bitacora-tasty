# -*- coding: utf-8 -*-
"""Analisis profundo del estudio de Max Pain: controlar la deriva del mercado,
probar poder direccional, y contrastar contra placebos."""
import json, io, math
import numpy as np

U = json.load(io.open(r'C:\Users\gcarv\bitacora-tasty\_universo_dedup.json', encoding='utf-8'))
n = len(U)

mp    = np.array([o['maxPain'] for o in U], float)
prev  = np.array([o['prev'] for o in U], float)
close = np.array([o['cierre'] for o in U], float)
ret   = (close/prev - 1) * 100                      # retorno del dia, %
gap   = (mp/prev - 1) * 100                         # cuanto DEBERIA moverse para llegar al MP

def binom_p(k, N, p=0.5):
    """p-valor a dos colas de k exitos en N con probabilidad p."""
    from math import comb
    pk = sum(comb(N, i) * p**i * (1-p)**(N-i) for i in range(0, N+1)
             if comb(N, i) * p**i * (1-p)**(N-i) <= comb(N, k) * p**k * (1-p)**(N-k) + 1e-15)
    return min(1.0, pk)

print('='*74)
print('1) ASIMETRIA: donde esta el Max Pain respecto del precio')
print('='*74)
abajo = (gap < 0).sum()
print(f'  Max Pain POR DEBAJO del precio de apertura : {abajo}/{n} ({abajo/n*100:.1f}%)')
print(f'  Max Pain POR ENCIMA                        : {n-abajo}/{n} ({(n-abajo)/n*100:.1f}%)')
print(f'  gap mediano (mov. necesario para llegar)   : {np.median(gap):+.2f}%')
print(f'  retorno mediano del dia                    : {np.median(ret):+.2f}%')
print()
print('  >> Si el Max Pain esta casi siempre ABAJO y el mercado sube, "converger"')
print('     es casi imposible por construccion. El % de convergencia crudo mide')
print('     la direccion del mercado, no la imantacion.')

print()
print('='*74)
print('2) TEST DIRECCIONAL: ¿el Max Pain predice hacia donde se mueve el precio?')
print('='*74)
# La afirmacion operable: si el MP esta arriba, el precio deberia subir; si abajo, bajar.
acierto = np.sign(ret) == np.sign(gap)
k = int(acierto.sum())
print(f'  el signo del movimiento coincidio con el lado del Max Pain: {k}/{n} ({k/n*100:.1f}%)')
print(f'  p-valor binomial (H0: 50%)                                : {binom_p(k, n):.4f}')

print()
print('='*74)
print('3) MISMO TEST, PERO NEUTRALIZANDO LA DERIVA DEL MERCADO')
print('='*74)
mercado = np.median(ret)
ret_ex = ret - mercado          # retorno en exceso del mercado
gap_ex = gap - np.median(gap)   # gap centrado
ac2 = np.sign(ret_ex) == np.sign(gap)
k2 = int(ac2.sum())
print(f'  retorno mediano del universo (proxy de mercado): {mercado:+.2f}%')
print(f'  aciertos con retorno EN EXCESO del mercado     : {k2}/{n} ({k2/n*100:.1f}%)')
print(f'  p-valor binomial                               : {binom_p(k2, n):.4f}')
ac3 = np.sign(ret_ex) == np.sign(gap_ex)
k3 = int(ac3.sum())
print(f'  aciertos con AMBOS centrados                   : {k3}/{n} ({k3/n*100:.1f}%)')
print(f'  p-valor binomial                               : {binom_p(k3, n):.4f}')

print()
print('='*74)
print('4) CORRELACION: ¿mueve mas el precio cuando el Max Pain esta mas lejos?')
print('='*74)
for etq, a, b in [('gap vs retorno crudo', gap, ret),
                  ('gap vs retorno en exceso', gap, ret_ex),
                  ('gap centrado vs retorno en exceso', gap_ex, ret_ex)]:
    m = np.isfinite(a) & np.isfinite(b)
    r = np.corrcoef(a[m], b[m])[0,1]
    # t de Student para r
    t = r*math.sqrt((m.sum()-2)/max(1e-12, 1-r*r))
    print(f'  {etq:36s} r = {r:+.3f}   t = {t:+.2f}')
print('  (la teoria predice r POSITIVO y grande: mas lejos el iman, mas fuerte el tiron)')

print()
print('='*74)
print('5) PLACEBO: convergencia hacia el Max Pain vs hacia niveles arbitrarios')
print('='*74)
def conv_hacia(nivel):
    d0 = np.abs(prev - nivel); d1 = np.abs(close - nivel)
    return (d1 < d0).mean()*100
rng = np.random.default_rng(20260821)
print(f'  hacia el MAX PAIN real                    : {conv_hacia(mp):.1f}%')
# Placebo 1: un strike al azar dentro del +-10% del precio
pl1 = prev * (1 + rng.uniform(-0.10, 0.10, n))
print(f'  hacia un nivel AL AZAR (+-10% del precio) : {conv_hacia(pl1):.1f}%')
# Placebo 2: reflejo del max pain al otro lado del precio
pl2 = prev + (prev - mp)
print(f'  hacia el REFLEJO del Max Pain (otro lado) : {conv_hacia(pl2):.1f}%')
# Placebo 3: el propio cierre previo
print(f'  hacia el CIERRE DE AYER (nivel trivial)   : {conv_hacia(prev):.1f}%')

print()
print('='*74)
print('6) ¿Y SI SOLO MIRAMOS LOS QUE TENIAN EL MAX PAIN ARRIBA?')
print('='*74)
for etq, mask in [('Max Pain ARRIBA del precio', gap > 0), ('Max Pain ABAJO del precio', gap < 0)]:
    if mask.sum() < 5: continue
    sub_ret, sub_gap = ret[mask], gap[mask]
    ac = (np.sign(sub_ret) == np.sign(sub_gap)).sum()
    N = int(mask.sum())
    print(f'  {etq:30s} n={N:3d}  acierto direccional {ac/N*100:5.1f}%  '
          f'retorno medio {sub_ret.mean():+.2f}%  (mercado {mercado:+.2f}%)')
print()
print('  >> Este es el corte que importa: si la imantacion existe, el grupo con el')
print('     Max Pain ARRIBA deberia rendir MEJOR que el mercado, y el de abajo PEOR.')
