# -*- coding: utf-8 -*-
"""
Compara Iron Condor vs Iron Butterfly (SPX 0DTE) en riesgo/beneficio.

Uso:
    # Un dia concreto (estructura de hoy)
    python comparar_neutrales.py dia --spot 7665 --pin 7665 \
        --put-wall 7650 --call-wall 7665 --iv 9.9 --hora-entrada 11.0

    # Backtest sobre el historico real
    python comparar_neutrales.py backtest --datos <dir_con_json>

POR QUE EXISTE (2026-08-25, pedido de Guillermo)
------------------------------------------------
La hipotesis a validar es que en dias de pin fuerte y IV baja el Iron Butterfly
rinde mejor que el Iron Condor, porque toda la prima de un 0DTE esta en el ATM
-- que es justo donde el butterfly vende y el condor no.

La comparacion SOLO es honesta si ambas estructuras arriesgan lo mismo. Por eso
el parametro que se iguala es el ANCHO DE ALA (`wing`): con la misma ala, el
riesgo maximo de ambas es `ancho - credito`, y la unica diferencia real es la
forma del payoff. Comparar un butterfly de alas de 25 contra un condor de alas
de 50 no dice nada.

MODELO
------
- Black-Scholes europeo, que es lo correcto para SPX (liquidacion en efectivo,
  sin ejercicio anticipado). Para un 0DTE solo importa el CIERRE, no si el
  precio toco un strike intradia -- por eso el backtest liquida contra el cierre
  y no penaliza mechas.
- La IV de valoracion se CALIBRA contra el movimiento realizado del periodo, no
  se deriva del VIX (ver el bloque CONVENCION TEMPORAL mas abajo). En el
  backtest, cada dia escala esa IV base por su VIX relativo a la mediana.
- POP se calcula de DOS formas: la teorica (lognormal) y la EMPIRICA, contando
  sobre la distribucion real de movimientos 10:00->cierre. Cuando las dos no
  coinciden, manda la empirica: es lo que de verdad paso.
"""
import argparse
import json
import math
import os
import statistics

# -------------------------------------------------------------------------
# CONVENCION TEMPORAL -- leer antes de tocar nada de esto (2026-08-25)
#
# Un 0DTE NO se puede valorar con tiempo de calendario. Casi toda la varianza
# de una sesion ocurre en las 6,5 horas de mercado, no repartida en 24. Segun
# que convencion se use, la MISMA realidad da numeros distintos:
#
#   sigma realizada 10:00->cierre = 39,1 pts (60 sesiones, jun-ago 2026)
#     - con T de calendario (6/8760 anios)  -> IV efectiva 19,5%  (VIX x 1,24)
#     - con T de mercado    (0,92/252)      -> IV efectiva  8,5%  (VIX x 0,54)
#
# Ninguna es "la correcta": son convenciones. Lo que NO se puede hacer es
# valorar con una y evaluar con otra -- ese fue el error de la primera version
# de este script, que daba EV negativo para todo por pura inconsistencia.
#
# Solucion adoptada: se abandona el VIX como fuente del credito. La IV de
# valoracion se CALIBRA para que la sigma del modelo coincida con la sigma
# realizada del periodo. Asi el precio teorico es "justo" por construccion y la
# comparacion IC vs IB aisla lo unico que se quiere medir: LA FORMA del payoff.
#
# CONSECUENCIA QUE HAY QUE DECIR EN VOZ ALTA: con precios justos el EV de ambas
# estructuras es ~0. Este script NO responde "vender prima gana dinero" -- para
# eso hacen falta precios reales de la cadena, que aqui no hay. Responde "dada
# la misma ala y el mismo modelo, que forma aguanta mejor la distribucion real
# de movimientos". El parametro `--premium` permite simular que el mercado paga
# por encima del valor justo (prima de varianza) y ver como cambia el veredicto.
# -------------------------------------------------------------------------

HORA_CIERRE = 16.0
HORAS_ANIO = 24.0 * 365.0
# Fraccion de la sesion (6,5 h) que queda desde las 10:00 ET.
SESION_H = 6.5


def _phi(x):
    return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)


def _cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def bs(spot, k, iv, T, tipo, r=0.0):
    """Precio Black-Scholes. iv en decimal, T en anios."""
    if T <= 0 or iv <= 0:
        intr = max(spot - k, 0.0) if tipo == "c" else max(k - spot, 0.0)
        return intr
    sq = iv * math.sqrt(T)
    d1 = (math.log(spot / k) + (r + 0.5 * iv * iv) * T) / sq
    d2 = d1 - sq
    disc = math.exp(-r * T)
    if tipo == "c":
        return spot * _cdf(d1) - k * disc * _cdf(d2)
    return k * disc * _cdf(-d2) - spot * _cdf(-d1)


def _metricas(nombre, legs, credito, ancho, k_lo, k_hi):
    """legs: lista de (signo, strike, tipo). k_lo/k_hi: strikes cortos."""
    max_prof = credito
    max_loss = ancho - credito
    be_bajo = k_lo - credito
    be_alto = k_hi + credito
    return {
        "nombre": nombre,
        "legs": legs,
        "credito": credito,
        "max_profit": max_prof,
        "max_loss": max_loss,
        "rr": (max_prof / max_loss) if max_loss > 0 else float("inf"),
        "be_bajo": be_bajo,
        "be_alto": be_alto,
        "zona": be_alto - be_bajo,
        "k_lo": k_lo,
        "k_hi": k_hi,
        "ancho": ancho,
    }


def iron_condor(spot, k_put, k_call, wing, iv, T, r=0.0):
    """Vende put k_put y call k_call; compra alas a `wing` puntos por fuera."""
    legs = [(-1, k_put, "p"), (+1, k_put - wing, "p"),
            (-1, k_call, "c"), (+1, k_call + wing, "c")]
    credito = sum(-s * bs(spot, k, iv, T, t, r) for s, k, t in legs)
    return _metricas("Iron Condor", legs, credito, wing, k_put, k_call)


def iron_butterfly(spot, k_centro, wing, iv, T, r=0.0):
    """Vende straddle en k_centro; compra alas a `wing` puntos."""
    legs = [(-1, k_centro, "p"), (+1, k_centro - wing, "p"),
            (-1, k_centro, "c"), (+1, k_centro + wing, "c")]
    credito = sum(-s * bs(spot, k, iv, T, t, r) for s, k, t in legs)
    return _metricas("Iron Butterfly", legs, credito, wing, k_centro, k_centro)


def liquidar(est, cierre):
    """P&L al vencimiento (SPX es europeo y liquida en efectivo: solo el cierre)."""
    valor = 0.0
    for s, k, t in est["legs"]:
        intr = max(cierre - k, 0.0) if t == "c" else max(k - cierre, 0.0)
        valor += s * intr
    return est["credito"] + valor


def pop_teorico(est, spot, iv, T):
    """Probabilidad de terminar entre breakevens, lognormal."""
    if T <= 0 or iv <= 0:
        return float(est["be_bajo"] <= spot <= est["be_alto"])
    sq = iv * math.sqrt(T)

    def d2(k):
        return (math.log(spot / k) - 0.5 * iv * iv * T) / sq

    return _cdf(d2(est["be_bajo"])) - _cdf(d2(est["be_alto"]))


def pop_empirico(est, cierres):
    """Fraccion de cierres simulados que caen entre breakevens."""
    if not cierres:
        return None
    return sum(1 for c in cierres
               if est["be_bajo"] <= c <= est["be_alto"]) / len(cierres)


def ev_empirico(est, cierres):
    if not cierres:
        return None
    return statistics.mean(liquidar(est, c) for c in cierres)


def T_desde(hora_entrada):
    return max(HORA_CIERRE - hora_entrada, 0.01) / HORAS_ANIO


def _fmt(est, spot, iv, T, cierres):
    pt = pop_teorico(est, spot, iv, T)
    pe = pop_empirico(est, cierres)
    ev = ev_empirico(est, cierres)
    L = []
    L.append(f"  {est['nombre']}")
    L.append(f"    strikes cortos : {est['k_lo']:.0f} / {est['k_hi']:.0f}   alas {est['ancho']:.0f} pts")
    L.append(f"    credito        : {est['credito']:7.2f} pts")
    L.append(f"    max ganancia   : {est['max_profit']:7.2f} pts")
    L.append(f"    max perdida    : {est['max_loss']:7.2f} pts")
    L.append(f"    riesgo/benef.  : 1 : {est['rr']:.2f}")
    L.append(f"    breakevens     : {est['be_bajo']:.2f} - {est['be_alto']:.2f}  (zona {est['zona']:.2f} pts)")
    L.append(f"    POP teorico    : {100*pt:5.1f}%")
    if pe is not None:
        L.append(f"    POP empirico   : {100*pe:5.1f}%   <-- distribucion real, {len(cierres)} sesiones")
        L.append(f"    EV             : {ev:+7.2f} pts por operacion")
    return "\n".join(L)


def cargar_movimientos(datos_dir):
    p = os.path.join(datos_dir, "intraday_1000.json")
    if not os.path.exists(p):
        return [], {}
    d = json.load(open(p, encoding="utf-8"))
    movs = [v["cierre"] - v["p1000"] for v in d.values()]
    return movs, d


def sigma_realizada(movs):
    """Sigma robusta a colas: se estima por la mediana de |mov|, no por la desv."""
    if not movs:
        return None
    return statistics.median([abs(m) for m in movs]) / 0.6745


def z_moves(movs):
    """Movimientos estandarizados: cada uno dividido por la sigma del periodo.
    Permite reescalar la distribucion REAL (con sus colas) a la sigma de hoy."""
    s = sigma_realizada(movs)
    return [m / s for m in movs] if s else []


def iv_calibrada(movs, spot, T):
    """IV que hace que la sigma del modelo iguale la sigma realizada."""
    s = sigma_realizada(movs)
    if not s or T <= 0:
        return None
    return (s / spot) / math.sqrt(T)


def escenarios(spot, zs, sigma_hoy):
    """Cierres simulados: la forma real de la distribucion, escalada a hoy."""
    return [spot + z * sigma_hoy for z in zs]


def cmd_dia(a):
    movs, _ = cargar_movimientos(a.datos) if a.datos else ([], {})
    T = T_desde(a.hora_entrada)
    wing = a.wing

    ivc = iv_calibrada(movs, a.spot, T) if movs else None
    iv = (a.iv / 100.0) if a.iv else ivc
    if iv is None:
        raise SystemExit("Hace falta --iv o un --datos con historico para calibrar.")

    sigma_hoy = a.spot * iv * math.sqrt(T)
    zs = z_moves(movs)
    cierres = escenarios(a.spot, zs, sigma_hoy) if zs else []

    ic = iron_condor(a.spot, a.put_wall, a.call_wall, wing, iv, T)
    ib = iron_butterfly(a.spot, a.pin, wing, iv, T)
    if a.premium:
        f = 1.0 + a.premium / 100.0
        for e in (ic, ib):
            e["credito"] *= f
            e["max_profit"] = e["credito"]
            e["max_loss"] = e["ancho"] - e["credito"]
            e["rr"] = e["max_profit"] / e["max_loss"] if e["max_loss"] > 0 else float("inf")
            e["be_bajo"] = e["k_lo"] - e["credito"]
            e["be_alto"] = e["k_hi"] + e["credito"]
            e["zona"] = e["be_alto"] - e["be_bajo"]

    print(f"SPX {a.spot:.2f}   pin {a.pin:.0f}   muros {a.put_wall:.0f}/{a.call_wall:.0f}")
    print(f"entrada {a.hora_entrada:.2f} ET   T = {T*HORAS_ANIO:.2f} h de calendario   "
          f"sigma modelo = {sigma_hoy:.1f} pts")
    if ivc:
        print(f"IV usada {100*iv:.1f}%   (calibrada a sigma realizada = {100*ivc:.1f}%)")
    if a.premium:
        print(f"Prima de varianza simulada: +{a.premium:.0f}% sobre el valor justo")
    print(f"Alas igualadas en {wing:.0f} pts (misma exposicion maxima)\n")
    print(_fmt(ic, a.spot, iv, T, cierres))
    print()
    print(_fmt(ib, a.spot, iv, T, cierres))
    print()
    if cierres:
        evi, evb = ev_empirico(ic, cierres), ev_empirico(ib, cierres)
        gana = "IRON BUTTERFLY" if evb > evi else "IRON CONDOR"
        print(f"  VEREDICTO (EV sobre distribucion real): {gana}   "
              f"IC {evi:+.2f} vs IB {evb:+.2f}  ->  diferencia {abs(evb-evi):.2f} pts")


def cmd_backtest(a):
    movs, sesiones = cargar_movimientos(a.datos)
    vixp = os.path.join(a.datos, "vix_daily.json")
    vix = json.load(open(vixp, encoding="utf-8")) if os.path.exists(vixp) else {}
    T = T_desde(a.hora_entrada)
    wing = a.wing

    # IV base calibrada al periodo; cada dia se escala por su VIX relativo, de
    # modo que un dia mas volatil pague mas prima -- sin reintroducir la
    # inconsistencia de convencion (ver cabecera).
    spot_med = statistics.median([s["p1000"] for s in sesiones.values()])
    iv_base = iv_calibrada(movs, spot_med, T)
    vix_med = statistics.median(list(vix.values())) if vix else None
    prem = 1.0 + a.premium / 100.0

    filas = []
    for fecha in sorted(sesiones):
        s = sesiones[fecha]
        spot, cierre = s["p1000"], s["cierre"]
        v = vix.get(fecha)
        iv = iv_base * ((v / vix_med) if (v and vix_med) else 1.0)
        # Condor centrado en el spot con los cortos a `off` puntos.
        ic = iron_condor(spot, spot - a.off, spot + a.off, wing, iv, T)
        # Butterfly centrado en el spot (sin dato de pin historico fiable).
        ib = iron_butterfly(spot, spot, wing, iv, T)
        for e in (ic, ib):
            e["credito"] *= prem
        filas.append((fecha, spot, cierre, cierre - spot,
                      liquidar(ic, cierre), liquidar(ib, cierre),
                      ic["credito"], ib["credito"]))

    if not filas:
        print("Sin datos suficientes para el backtest.")
        return

    pic = [f[4] for f in filas]
    pib = [f[5] for f in filas]
    print(f"BACKTEST  {len(filas)} sesiones   entrada {a.hora_entrada:.2f} ET, "
          f"liquidacion al cierre")
    print(f"Condor: cortos a +-{a.off} pts del spot. Butterfly: straddle ATM. "
          f"Alas {wing} pts en ambos.")
    print(f"IV base calibrada {100*iv_base:.1f}%, escalada por el VIX de cada dia"
          + (f"   |   prima simulada +{a.premium:.0f}%" if a.premium else "") + "\n")
    print("fecha        spot    cierre    mov      P&L IC    P&L IB   mejor")
    for f in filas:
        mejor = "IB" if f[5] > f[4] else ("IC" if f[4] > f[5] else "=")
        print(f"{f[0]}  {f[1]:7.1f} {f[2]:8.1f} {f[3]:+7.1f}   "
              f"{f[4]:+8.2f}  {f[5]:+8.2f}    {mejor}")

    def resumen(nombre, p, cred):
        g = sum(1 for x in p if x > 0)
        print(f"\n  {nombre}")
        print(f"    credito medio   : {statistics.mean(cred):7.2f} pts")
        print(f"    P&L total       : {sum(p):+8.2f} pts")
        print(f"    P&L medio       : {statistics.mean(p):+8.2f} pts / operacion")
        print(f"    mediana         : {statistics.median(p):+8.2f} pts")
        print(f"    aciertos        : {g}/{len(p)}  ({100*g/len(p):.1f}%)")
        print(f"    peor dia        : {min(p):+8.2f} pts")
        print(f"    desv. tipica    : {statistics.pstdev(p):8.2f} pts")

    resumen("IRON CONDOR", pic, [f[6] for f in filas])
    resumen("IRON BUTTERFLY", pib, [f[7] for f in filas])

    tic, tib = sum(pic), sum(pib)
    gana = "IRON BUTTERFLY" if tib > tic else "IRON CONDOR"
    print(f"\n  VEREDICTO: {gana} por {abs(tib-tic):.2f} pts acumulados "
          f"({len(filas)} sesiones)")
    nb = sum(1 for f in filas if f[5] > f[4])
    print(f"  El butterfly gano en {nb}/{len(filas)} sesiones "
          f"({100*nb/len(filas):.1f}%)")


def main():
    ap = argparse.ArgumentParser(description="Iron Condor vs Iron Butterfly (SPX 0DTE)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("dia")
    d.add_argument("--spot", type=float, required=True)
    d.add_argument("--pin", type=float, required=True)
    d.add_argument("--put-wall", type=float, required=True)
    d.add_argument("--call-wall", type=float, required=True)
    d.add_argument("--iv", type=float, default=None,
                   help="IV ATM en %%. Si se omite, se calibra del historico.")
    d.add_argument("--wing", type=float, default=25.0)
    d.add_argument("--hora-entrada", type=float, default=10.0)
    d.add_argument("--premium", type=float, default=0.0,
                   help="%% que el mercado paga por encima del valor justo")
    d.add_argument("--datos", default=None)
    d.set_defaults(func=cmd_dia)

    b = sub.add_parser("backtest")
    b.add_argument("--datos", required=True)
    b.add_argument("--wing", type=float, default=25.0)
    b.add_argument("--off", type=float, default=25.0,
                   help="distancia de los cortos del condor al spot")
    b.add_argument("--hora-entrada", type=float, default=10.0)
    b.add_argument("--premium", type=float, default=0.0,
                   help="%% que el mercado paga por encima del valor justo")
    b.set_defaults(func=cmd_backtest)

    a = ap.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
