# -*- coding: utf-8 -*-
"""
Sombra del credito de apertura — el instrumento de NEU-2.

NEU-2 PEDIA DESACOPLAR el piso de credito (`minCreditoAnchoPct`, un gate de
ENTRADA) del limite de precio de la orden. Con el gate en 0, el limite caia a
$0.01: un limit que acepta cualquier cosa, o sea un market disfrazado.

ESO YA SE HIZO el 2026-08-13, el mismo dia que se anoto la propuesta.
`limiteDeAperturaVertical()` calcula el limite desde la PRIMA ESTIMADA
(prem * (1 - tolerancia/100) en credito) y `minCreditoAnchoPct` quedo como lo
que es: el gate de entrada. La propuesta llevaba nueve dias en el backlog
pidiendo algo hecho, y el Auditor devolviendo SIN INSTRUMENTO por ella.

Asi que este script NO juzga si conviene desacoplar. Hace la pregunta que sigue,
que es el paso 4 del Auditor: ¿el arreglo aplicado esta CUMPLIENDO?

  python scripts/sombra_credito.py
  python scripts/sombra_credito.py --json

QUE MIDE, por apertura con sombra:

  mid Tasty      lo que valia el spread en la cadena real
  mid Tradier    lo mismo segun el sandbox
  CRUZANDO       lo que da tomar el mercado (vender al bid, comprar al ask)
  limite         el que la formula habria puesto
  fill real      lo que se cobro de verdad

Un fill POR DEBAJO del limite calculado no deberia poder ocurrir: significa que
el limite no se esta aplicando. Un fill cerca de CRUZANDO es lo esperable y
sano; uno muy por debajo es el problema que NEU-2 describia.
"""
import argparse, json, os, sys
from datetime import datetime
from statistics import median

PROD = "https://web-production-23473.up.railway.app"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(REPO, "veredictos")

TOL_DEFAULT = 25.0     # el mismo default que usa limiteDeAperturaVertical


def _get_json(url, timeout=120, reintentos=3):
    from urllib.request import urlopen
    ultimo = None
    for _ in range(reintentos):
        try:
            with urlopen(url, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:      # noqa: BLE001
            ultimo = e
    raise RuntimeError(str(ultimo))


def limite_credito(prima, tol):
    """Replica de limiteDeAperturaVertical() para el lado credito.

    Incluye la caida al default cuando la tolerancia llega a 100: desde el
    2026-08-20 un valor fuera de rango vuelve al 25 documentado en vez de
    desactivar la proteccion (antes mandaba la orden A MERCADO sin decirlo)."""
    if not prima or prima <= 0:
        return None
    t = TOL_DEFAULT if (tol is None or tol >= 100) else float(tol)
    return round(prima * (1 - t / 100), 2)


def desarmar(sa):
    """sombraApertura tiene DOS formas segun la estrategia: el Iron Condor la
    guarda por pata (put/call) y la Reversion plana. Devuelve (mid, cruzando)
    en unidades de prima, o (None, None) si no se reconoce."""
    if not isinstance(sa, dict):
        return None, None
    if sa.get("put") or sa.get("call"):
        mid = cruz = 0.0
        for lado in ("put", "call"):
            p = sa.get(lado) or {}
            mid += (p.get("tasty") or {}).get("net") or 0
            cruz += (p.get("tradier") or {}).get("netCruzando") or 0
        return (mid or None), (cruz or None)
    t = sa.get("tasty") or {}
    if t.get("net") is not None:
        return t.get("net"), (t.get("netCruzando") or (sa.get("tradier") or {}).get("netCruzando"))
    return None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    ex = _get_json(f"{PROD}/api/tradier/executions").get("executions", [])
    cfg = _get_json(f"{PROD}/api/spx/config")
    tcfg = ((cfg.get("config") or cfg).get("trading") or {})
    tol_cruda = tcfg.get("toleranciaDeslizamientoPct")

    filas = []
    for e in ex:
        sa = e.get("sombraApertura")
        if not sa:
            continue
        mid, cruz = desarmar(sa)
        real = e.get("creditReceived")
        if mid is None or not real:
            continue
        lim = limite_credito(mid, tol_cruda)
        c = e.get("contracts") or 1
        filas.append({
            "id": e.get("id"), "dia": (e.get("timestamp") or "")[:10],
            "familia": e.get("strategyFamily"), "expType": e.get("expType"),
            "contratos": c,
            "midUsd": round(mid * 100 * c, 2),
            "cruzandoUsd": round(cruz * 100 * c, 2) if cruz else None,
            "limiteUsd": round(lim * 100 * c, 2) if lim else None,
            "fillUsd": round(real * 100 * c, 2),
            "vsLimite": round((real - lim) * 100 * c, 2) if lim else None,
            "vsCruzando": round((real - cruz) * 100 * c, 2) if cruz else None,
            "vsMid": round((real - mid) * 100 * c, 2),
        })

    filas.sort(key=lambda f: f["dia"], reverse=True)
    bajo_limite = [f for f in filas if f["vsLimite"] is not None and f["vsLimite"] < -0.5]

    doc = {
        "propuesta": "NEU-2 — desacoplar el piso de credito del limite de precio",
        "estado": "YA RESUELTA el 2026-08-13 (limiteDeAperturaVertical). Este instrumento "
                  "verifica que el arreglo cumpla, que es el paso 4 del Auditor.",
        "toleranciaConfigurada": tol_cruda,
        "toleranciaAplicada": TOL_DEFAULT if (tol_cruda is None or tol_cruda >= 100) else tol_cruda,
        "notaTolerancia": ("la config esta en 100; desde el 2026-08-20 eso YA NO manda la orden "
                           "a mercado — cae al 25 por defecto") if (tol_cruda or 0) >= 100 else None,
        "aperturas": len(filas),
        "fillsPorDebajoDelLimite": len(bajo_limite),
        "medianas": {
            "vsMid": round(median([f["vsMid"] for f in filas]), 2) if filas else None,
            "vsCruzando": round(median([f["vsCruzando"] for f in filas if f["vsCruzando"] is not None]), 2)
                          if any(f["vsCruzando"] is not None for f in filas) else None,
        },
        "trades": filas,
        "generado": datetime.now().isoformat(timespec="seconds"),
    }

    os.makedirs(SALIDA, exist_ok=True)
    with open(os.path.join(SALIDA, "sombra_credito.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)

    if a.json:
        print(json.dumps(doc, ensure_ascii=False, indent=1)); return 0

    print("=" * 78)
    print(" SOMBRA DEL CREDITO DE APERTURA (NEU-2)")
    print(" NEU-2 ya se resolvio el 2026-08-13. Esto verifica que el arreglo cumpla.")
    print("=" * 78)
    print(f"tolerancia configurada: {tol_cruda}  ->  aplicada: {doc['toleranciaAplicada']}")
    if doc["notaTolerancia"]:
        print(f"  OJO: {doc['notaTolerancia']}")
    print()
    if not filas:
        print("  sin aperturas con sombra todavia")
        return 0
    print(f"{'dia':11}{'familia':11}{'mid':>8}{'cruzando':>10}{'limite':>9}{'fill':>8}{'vs lim':>9}{'vs cruz':>9}")
    for f in filas:
        print(f"{f['dia']:11}{str(f['familia'])[:10]:11}{f['midUsd']:>8.0f}"
              f"{(f['cruzandoUsd'] if f['cruzandoUsd'] is not None else 0):>10.0f}"
              f"{(f['limiteUsd'] if f['limiteUsd'] is not None else 0):>9.0f}"
              f"{f['fillUsd']:>8.0f}"
              f"{(f['vsLimite'] if f['vsLimite'] is not None else 0):>+9.0f}"
              f"{(f['vsCruzando'] if f['vsCruzando'] is not None else 0):>+9.0f}")
    print()
    print(f"  aperturas con sombra: {len(filas)}")
    print(f"  fills POR DEBAJO del limite: {len(bajo_limite)}"
          + ("  <- no deberia poder pasar: el limite no se estaria aplicando" if bajo_limite else "  (ninguno)"))
    print(f"  mediana vs mid: ${doc['medianas']['vsMid']}   vs cruzando: ${doc['medianas']['vsCruzando']}")
    print()
    print("  EL VEREDICTO NO ES DE ESTE SCRIPT: lo da el Auditor con su regla de muestra.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
