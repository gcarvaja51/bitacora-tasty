# -*- coding: utf-8 -*-
"""
Mide la PRIMA DE VARIANZA efectiva de la cadena 0DTE real y resuelve, con
precios de mercado, la pregunta Iron Condor vs Iron Butterfly.

Uso:
    python medir_prima.py <snapshot.json> [--sigma-real 39.1] [--wing 25]
                          [--pin 7665] [--off 25] [--lado mid|bid]

QUE MIDE
--------
`comparar_neutrales.py` deja la pregunta a medias: identifica que el veredicto
depende de la prima de varianza y localiza el punto de quiebre (~5%), pero
valora con Black-Scholes y por tanto no puede decir de que lado esta el mercado.
Este script cierra eso: toma los bid/ask REALES capturados por
`capturar_cadena_0dte.cjs`, y para cada opcion compara

    prima_mercado / prima_teorica

donde la teorica sale de Black-Scholes con la sigma REALIZADA del periodo (la
misma calibracion de `comparar_neutrales.py`, 39,1 pts). El exceso medio de esa
razon, ponderado por relevancia, es la prima de varianza efectiva.

DOS DETALLES QUE CAMBIAN EL RESULTADO
-------------------------------------
1. `--lado`: `mid` usa el punto medio bid/ask; `bid` usa lo que REALMENTE se
   cobra al vender (el bid). Un 0DTE de SPX tiene spreads anchos, asi que la
   diferencia entre ambos NO es cosmetica -- es el coste de cruzar, y se lo
   come el vendedor. El veredicto honesto es el de `bid`.
2. Solo se miden strikes con bid > 0. Los que cotizan 0 bid no aportan prima y
   meterlos hunde la media hacia cero por un artefacto de liquidez.
"""
import argparse
import json
import math
import statistics

HORAS_ANIO = 24.0 * 365.0
HORA_CIERRE = 16.0


def _cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def bs(spot, k, iv, T, tipo):
    if T <= 0 or iv <= 0:
        return max(spot - k, 0.0) if tipo == "c" else max(k - spot, 0.0)
    sq = iv * math.sqrt(T)
    d1 = (math.log(spot / k) + 0.5 * iv * iv * T) / sq
    d2 = d1 - sq
    if tipo == "c":
        return spot * _cdf(d1) - k * _cdf(d2)
    return k * _cdf(-d2) - spot * _cdf(-d1)


def precio(leg, lado):
    if not leg:
        return None
    if lado == "bid":
        return leg["bid"] if leg["bid"] > 0 else None
    m = (leg["bid"] + leg["ask"]) / 2.0
    return m if m > 0 else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("snapshot")
    ap.add_argument("--sigma-real", type=float, default=39.1,
                    help="sigma realizada del periodo, en puntos")
    ap.add_argument("--wing", type=float, default=25.0)
    ap.add_argument("--pin", type=float, default=None)
    ap.add_argument("--off", type=float, default=25.0)
    ap.add_argument("--lado", choices=["mid", "bid"], default="mid")
    a = ap.parse_args()

    d = json.load(open(a.snapshot, encoding="utf-8"))
    spot = d["spot"]
    hora = float(d["horaET"].split(":")[0]) + float(d["horaET"].split(":")[1]) / 60.0
    T = max(HORA_CIERRE - hora, 0.01) / HORAS_ANIO
    # IV que reproduce la sigma realizada, escalada al tiempo que queda.
    frac = max(HORA_CIERRE - hora, 0.01) / 6.0
    sigma_hoy = a.sigma_real * math.sqrt(frac)
    iv_justa = (sigma_hoy / spot) / math.sqrt(T)

    print(f"Snapshot {d['fechaET']} {d['horaET']} ET   SPX {spot:.2f}   exp {d['expiry']}")
    print(f"Quedan {HORA_CIERRE-hora:.2f} h  ->  sigma justa {sigma_hoy:.1f} pts "
          f"(IV equivalente {100*iv_justa:.1f}%)")
    print(f"Lado usado: {a.lado.upper()}"
          + ("  (lo que de verdad se cobra al vender)" if a.lado == "bid" else "  (punto medio)"))
    print()

    filas = {f["strike"]: f for f in d["filas"]}
    ratios = []
    print(f"{'strike':>8} {'tipo':>5} {'mercado':>9} {'teorico':>9} {'ratio':>7} {'IVmkt':>7}")
    for k in sorted(filas):
        f = filas[k]
        for tipo, leg in (("c", f["call"]), ("p", f["put"])):
            p = precio(leg, a.lado)
            if p is None:
                continue
            t = bs(spot, k, iv_justa, T, tipo)
            if t < 0.05:      # teorico ~0: el ratio explota y no informa
                continue
            r = p / t
            ratios.append((abs(k - spot), r))
            if abs(k - spot) <= 30:
                print(f"{k:8.0f} {tipo:>5} {p:9.2f} {t:9.2f} {r:7.2f} "
                      f"{100*leg['iv']:6.1f}%")

    if not ratios:
        print("Sin datos suficientes.")
        return
    cerca = [r for dist, r in ratios if dist <= 25]
    todos = [r for _, r in ratios]
    print()
    print(f"  PRIMA EFECTIVA (ratio mercado/teorico)")
    print(f"    strikes a <=25 pts del spot : mediana {statistics.median(cerca):.3f}   "
          f"-> prima {100*(statistics.median(cerca)-1):+.1f}%   n={len(cerca)}")
    print(f"    todos los strikes           : mediana {statistics.median(todos):.3f}   "
          f"-> prima {100*(statistics.median(todos)-1):+.1f}%   n={len(todos)}")

    # ---- Estructuras con precios REALES ----
    pin = a.pin if a.pin else round(spot / 5) * 5

    def leg_px(k, tipo, vender):
        f = filas.get(k)
        if not f:
            return None
        o = f["call"] if tipo == "c" else f["put"]
        if not o:
            return None
        if a.lado == "bid":
            # vender -> se cobra el bid; comprar -> se paga el ask
            v = o["bid"] if vender else o["ask"]
        else:
            v = (o["bid"] + o["ask"]) / 2.0
        return v if v > 0 else None

    def credito(legs):
        tot = 0.0
        for signo, k, tipo in legs:
            p = leg_px(k, tipo, vender=(signo < 0))
            if p is None:
                return None
            tot += (-signo) * p
        return tot

    ic_legs = [(-1, pin - a.off, "p"), (+1, pin - a.off - a.wing, "p"),
               (-1, pin + a.off, "c"), (+1, pin + a.off + a.wing, "c")]
    ib_legs = [(-1, pin, "p"), (+1, pin - a.wing, "p"),
               (-1, pin, "c"), (+1, pin + a.wing, "c")]

    print()
    print(f"  ESTRUCTURAS CON PRECIOS REALES  (centro {pin:.0f}, alas {a.wing:.0f})")
    for nombre, legs, klo, khi in (("Iron Condor", ic_legs, pin - a.off, pin + a.off),
                                   ("Iron Butterfly", ib_legs, pin, pin)):
        c = credito(legs)
        if c is None:
            print(f"    {nombre}: faltan strikes en el snapshot")
            continue
        ml = a.wing - c
        rr = c / ml if ml > 0 else float("inf")
        print(f"    {nombre:16s} credito {c:6.2f}   max perdida {ml:6.2f}   "
              f"R:R 1:{rr:.2f}   BE {klo-c:.1f} - {khi+c:.1f}")


if __name__ == "__main__":
    main()
