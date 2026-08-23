# -*- coding: utf-8 -*-
"""Segunda tanda de tests sobre el Max Pain, ahora con OHLC intradia y beta.
Busca la ventaja donde todavia podria estar: no en la direccion, sino en el
comportamiento del precio (rango, posicion del cierre, atraccion intradia)."""
import json, io, math
import numpy as np

U = json.load(io.open(r'C:\Users\gcarv\bitacora-tasty\_estudio_ohlc.json', encoding='utf-8'))
n = len(U)
sym  = [o['sym'] for o in U]
mp   = np.array([o['maxPain'] for o in U], float)
op   = np.array([o['open'] for o in U], float)
hi   = np.array([o['hi'] for o in U], float)
lo   = np.array([o['lo'] for o in U], float)
cl   = np.array([o['close'] for o in U], float)
prev = np.array([o['prev'] for o in U], float)
beta = np.array([o['beta'] if o['beta'] else 1.0 for o in U], float)

def binom_p(k, N, p=0.5):
    from math import comb
    tgt = comb(N,k)*p**k*(1-p)**(N-k)
    return min(1.0, sum(comb(N,i)*p**i*(1-p)**(N-i) for i in range(N+1)
                        if comb(N,i)*p**i*(1-p)**(N-i) <= tgt + 1e-15))

def t_de_r(r, N):
    return r*math.sqrt((N-2)/max(1e-12, 1-r*r))

# Mercado: SPY como referencia
i_spy = sym.index('SPY')
mkt_ret = (cl[i_spy]/prev[i_spy] - 1)*100

ret      = (cl/prev - 1)*100
ret_intr = (cl/op   - 1)*100          # intradia puro, sin el gap de apertura
exceso   = ret - beta*mkt_ret          # retorno ajustado por beta
gap_op   = (mp/op - 1)*100             # % que hay que moverse DESDE LA APERTURA al MP
rango    = (hi-lo)/op*100              # rango del dia normalizado

print('='*76)
print(f'BASE: {n} subyacentes | mercado (SPY) {mkt_ret:+.2f}% | rango mediano {np.median(rango):.2f}%')
print('='*76)

print('\nA) DIRECCIONAL AJUSTADO POR BETA  (el test limpio)')
k = int((np.sign(exceso) == np.sign(gap_op)).sum())
print(f'   el retorno EN EXCESO fue hacia el lado del Max Pain: {k}/{n} = {k/n*100:.1f}%  (p={binom_p(k,n):.3f})')
r = np.corrcoef(gap_op, exceso)[0,1]
print(f'   correlacion gap(desde apertura) vs exceso: r={r:+.3f}  t={t_de_r(r,n):+.2f}')

print('\nB) SOLO MOVIMIENTO INTRADIA (apertura -> cierre, sin el gap nocturno)')
k = int((np.sign(ret_intr - np.median(ret_intr)) == np.sign(gap_op)).sum())
print(f'   intradia centrado fue hacia el Max Pain: {k}/{n} = {k/n*100:.1f}%  (p={binom_p(k,n):.3f})')
r = np.corrcoef(gap_op, ret_intr - np.median(ret_intr))[0,1]
print(f'   correlacion: r={r:+.3f}  t={t_de_r(r,n):+.2f}')

print('\nC) EFECTO PIN SOBRE LA VOLATILIDAD  (el mecanismo alternativo)')
print('   La idea: si el precio queda ATRAPADO cerca del Max Pain, su rango deberia')
print('   ser MENOR que el de los que estan lejos. Es un trade de vol, no direccional.')
d_ap = np.abs(gap_op)
cerca = d_ap <= 1.0
lejos = d_ap >= 5.0
medio = (~cerca) & (~lejos)
for etq, m in [('abrio a <=1% del Max Pain', cerca), ('entre 1% y 5%', medio), ('abrio a >=5%', lejos)]:
    if m.sum() >= 3:
        print(f'   {etq:28s} n={int(m.sum()):3d}  rango mediano {np.median(rango[m]):5.2f}%  '
              f'|ret intradia| mediano {np.median(np.abs(ret_intr[m])):5.2f}%')
r = np.corrcoef(d_ap, rango)[0,1]
print(f'   correlacion distancia-al-MP vs rango del dia: r={r:+.3f}  t={t_de_r(r,n):+.2f}')
print('   (la teoria del pin predice r POSITIVO: mas lejos del iman, mas rango)')

print('\nD) POSICION DEL CIERRE DENTRO DEL RANGO DEL DIA')
print('   Si el Max Pain tira, con el MP ARRIBA el cierre deberia caer en la parte')
print('   ALTA del rango, y viceversa. Se mide 0=minimo del dia, 1=maximo.')
pos = np.where(hi > lo, (cl-lo)/np.maximum(hi-lo, 1e-9), 0.5)
arriba, abajo = gap_op > 0, gap_op < 0
print(f'   Max Pain ARRIBA (n={int(arriba.sum())}): posicion mediana del cierre = {np.median(pos[arriba]):.3f}')
print(f'   Max Pain ABAJO  (n={int(abajo.sum())}): posicion mediana del cierre = {np.median(pos[abajo]):.3f}')
print(f'   diferencia = {np.median(pos[arriba]) - np.median(pos[abajo]):+.3f}   (la teoria pide POSITIVA y grande)')
r = np.corrcoef(gap_op, pos)[0,1]
print(f'   correlacion gap vs posicion en el rango: r={r:+.3f}  t={t_de_r(r,n):+.2f}')

print('\nE) ¿EL PRECIO TOCO EL MAX PAIN EN ALGUN MOMENTO DEL DIA?')
toco = (mp >= lo) & (mp <= hi)
print(f'   el Max Pain estuvo DENTRO del rango del dia: {int(toco.sum())}/{n} = {toco.sum()/n*100:.1f}%')
sub = toco & (np.abs(gap_op) > 0.5)
print(f'   ... entre los que abrieron a >0,5% del MP: {int(sub.sum())}/{int((np.abs(gap_op)>0.5).sum())}'
      f' = {sub.sum()/max(1,(np.abs(gap_op)>0.5).sum())*100:.1f}%')
print('   (si hubiera atraccion, el precio deberia VISITAR el nivel mucho mas seguido)')

print('\nF) LO QUE IMPORTA PARA OPERAR: cartera long/short ajustada por beta')
q = np.quantile(gap_op, [0.25, 0.75])
largo  = gap_op >= q[1]     # Max Pain mas arriba -> comprar
corto  = gap_op <= q[0]     # Max Pain mas abajo  -> vender
print(f'   cuartil superior (MP mas arriba, n={int(largo.sum())}): exceso medio {exceso[largo].mean():+.3f}%')
print(f'   cuartil inferior (MP mas abajo,  n={int(corto.sum())}): exceso medio {exceso[corto].mean():+.3f}%')
spread = exceso[largo].mean() - exceso[corto].mean()
sd = math.sqrt(exceso[largo].var(ddof=1)/largo.sum() + exceso[corto].var(ddof=1)/corto.sum())
print(f'   SPREAD long/short = {spread:+.3f}%   error estandar {sd:.3f}%   t = {spread/sd:+.2f}')
print('   (para ser una ventaja necesitaria ser positivo y con |t| > 2)')
