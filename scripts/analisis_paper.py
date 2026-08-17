"""Revision del LIBRO PAPER — el P&L real contra el que reporta Tradier.

Por que existe: el sandbox de Tradier llena las ordenes contra un libro de hace
~15 minutos, asi que su `pnl` es ficcion. Desde el 2026-08-16 cada ejecucion
lleva ademas `paperEntry`/`paperExit`/`paperPnl`: la marca CRUZANDO el spread
(compra al ask, venta al bid) contra la cadena en vivo de TastyTrade, tomada en
el instante del envio de cada orden. Ese es el numero con el que se decide si el
algoritmo funciona.

Uso:
    python scripts/analisis_paper.py            # todo el historial disponible
    python scripts/analisis_paper.py 2026-08-18 # solo esa fecha

Responde cuatro cosas:
  1. Cobertura — cuantos trades quedaron con marca confiable y cuantos no (y por
     que). Sin esto el resto no se puede leer: un P&L calculado sobre 3 de 10
     trades no es el P&L del dia.
  2. Paper contra Tradier — cuanto mentia el atraso, trade por trade.
  3. Costo de cruzar — la mediana de `costoCruce`. Es el insumo para recalibrar
     toleranciaDeslizamientoPct, ahora con el cruce AISLADO del atraso (antes los
     dos venian mezclados en la misma medicion del 34%).
  4. Veto de muro en sombra — si los trades que habria vetado salieron peores.
"""
import json
import sys
import urllib.request
from collections import defaultdict
from statistics import median

BASE = "https://web-production-23473.up.railway.app"


def traer(ruta):
    with urllib.request.urlopen(f"{BASE}{ruta}", timeout=90) as r:
        return json.loads(r.read())


def med(xs):
    xs = [x for x in xs if x is not None]
    return round(median(xs), 2) if xs else None


def fmt(v, sufijo="", ancho=8):
    return f"{v:>{ancho}}{sufijo}" if v is not None else f"{'—':>{ancho}}{sufijo}"


def main():
    fecha = sys.argv[1] if len(sys.argv) > 1 else None

    ex = traer("/api/tradier/executions")
    ex = ex if isinstance(ex, list) else ex.get("executions", [])
    if fecha:
        ex = [e for e in ex if (e.get("filledAt") or e.get("timestamp") or "").startswith(fecha)]
    # Solo lo que tiene libro: los trades previos al 2026-08-16 no lo llevan.
    conLibro = [e for e in ex if e.get("paperEntry") is not None]

    print(f"ejecuciones traidas: {len(ex)}" + (f"  (filtradas por {fecha})" if fecha else ""))
    print(f"con libro paper:     {len(conLibro)}")
    if not conLibro:
        print("\nTodavia no hay ningun trade con libro paper. Nada que analizar.")
        return

    # ── 1. COBERTURA ───────────────────────────────────────────────────────
    print("\n=== 1. COBERTURA DE LA MARCA ===")
    print("Sin marca confiable el trade NO entra al analisis — un precio viejo")
    print("anotado como bueno contamina justo la conclusion que buscamos.\n")
    porFam = defaultdict(lambda: {"total": 0, "ok": 0, "motivos": defaultdict(int)})
    for e in conLibro:
        f = e.get("strategyFamily") or "?"
        d = porFam[f]
        d["total"] += 1
        pe, px = e.get("paperEntry") or {}, e.get("paperExit") or {}
        if (e.get("paperPnl") or {}).get("confiable"):
            d["ok"] += 1
        else:
            motivo = (e.get("paperPnl") or {}).get("motivo") or pe.get("motivo") or "cerrado sin marcar aun"
            d["motivos"][motivo[:70]] += 1
    for f, d in sorted(porFam.items()):
        pct = 100 * d["ok"] / d["total"] if d["total"] else 0
        print(f"  {f:<12} {d['ok']}/{d['total']} con P&L propio ({pct:.0f}%)")
        for m, n in sorted(d["motivos"].items(), key=lambda kv: -kv[1]):
            print(f"       {n}x  {m}")

    # ── 1b. DISTRIBUCION DE EDADES: con que umbral se habria salvado cada marca ──
    # El umbral es 15s y se eligio por razonamiento, no medido. Esto lo pone a
    # prueba: si el grueso de las marcas cae en 20-40s, el umbral es muy duro y
    # esta tirando datos buenos; si cae en cientos de segundos, el problema no es
    # el umbral sino que ese strike no tiene actividad.
    edades = []
    for e in conLibro:
        for lado in ("paperEntry", "paperExit"):
            m = e.get(lado) or {}
            pv = m.get("pataMasVieja") or {}
            if pv.get("edadSeg") is not None:
                edades.append((pv["edadSeg"], e.get("strategyFamily"), lado, pv.get("sym")))
    if edades:
        print("\n  Edad de la pata mas vieja, por marca:")
        for fam in sorted({x[1] for x in edades}):
            xs = sorted(x[0] for x in edades if x[1] == fam)
            dentro = sum(1 for v in xs if v <= 15)
            print(f"    {fam:<12} n={len(xs):>3}  mediana {med(xs):>6}s  p90 {xs[int(.9*len(xs))-1] if xs else '—':>6}s"
                  f"  max {max(xs):>6}s   |  <=15s: {dentro}/{len(xs)}")
        for umbral in (15, 30, 60, 120):
            ok = sum(1 for v, *_ in edades if v <= umbral)
            print(f"    con umbral {umbral:>3}s se salvarian {ok}/{len(edades)} marcas ({100*ok/len(edades):.0f}%)")
        viejas = sorted(edades, reverse=True)[:5]
        if viejas and viejas[0][0] > 15:
            print("\n  Las 5 patas mas dormidas (para ver si es un strike puntual o un patron):")
            for v, fam, lado, sym in viejas:
                print(f"    {v:>6}s  {fam:<11} {lado:<11} {sym}")

    utiles = [e for e in conLibro if (e.get("paperPnl") or {}).get("confiable")]
    if not utiles:
        print("\nNingun trade con P&L propio todavia — el resto del analisis necesita eso.")
        print("Si arriba se ve que casi todo cae por frescura, el umbral de 15s es el sospechoso,")
        print("no el algoritmo. Mirar la tabla de umbrales antes de tocar nada mas.")
        return

    # ── 2. PAPER CONTRA TRADIER ────────────────────────────────────────────
    print("\n=== 2. EL LIBRO PROPIO CONTRA LO QUE REPORTA TRADIER ===")
    print(f"  {'fecha/hora':<17} {'familia':<11} {'paper':>9} {'tradier':>9} {'dif':>9}  cierre")
    print("  " + "-" * 74)
    difs, pPaper, pTradier = [], 0.0, 0.0
    for e in sorted(utiles, key=lambda x: x.get("filledAt") or ""):
        p = e["paperPnl"]["neto"]
        t = e.get("pnl")
        pPaper += p
        if isinstance(t, (int, float)):
            pTradier += t
            dif = round(p - t, 2)
            difs.append(dif)
        else:
            dif = None
        print(f"  {(e.get('filledAt') or '')[:16]:<17} {(e.get('strategyFamily') or '?'):<11} "
              f"{p:>9.0f} {fmt(t, ancho=9)} {fmt(dif, ancho=9)}  {e.get('closeReason') or ''}")
    print("  " + "-" * 74)
    print(f"  {'TOTAL':<29} {pPaper:>9.0f} {pTradier:>9.0f} {pPaper - pTradier:>9.0f}")
    if difs:
        print(f"\n  Diferencia mediana por trade: ${med(difs)}  |  peor caso: ${max(difs, key=abs)}")
        print("  Esa diferencia ES lo que el atraso de 15 min estaba distorsionando.")

    gan = [e for e in utiles if e["paperPnl"]["neto"] > 0]
    print(f"\n  Winrate REAL (libro propio): {100*len(gan)/len(utiles):.1f}% sobre {len(utiles)} trades")
    tCon = [e for e in utiles if isinstance(e.get("pnl"), (int, float))]
    if tCon:
        ganT = [e for e in tCon if e["pnl"] > 0]
        print(f"  Winrate segun Tradier:       {100*len(ganT)/len(tCon):.1f}% sobre {len(tCon)} trades")

    # ── 3. COSTO DE CRUZAR ─────────────────────────────────────────────────
    print("\n=== 3. COSTO DE CRUZAR EL SPREAD (para recalibrar la tolerancia) ===")
    cruces = [e["paperPnl"].get("costoCruceTotal") for e in utiles]
    entradas = [(e.get("paperEntry") or {}).get("costoCruce") for e in utiles]
    salidas = [(e.get("paperExit") or {}).get("costoCruce") for e in utiles]
    print(f"  ida y vuelta: mediana {fmt(med(cruces), ' pts', 6)}"
          f"   (= ${(med(cruces) or 0)*100:.0f} por contrato)")
    print(f"  solo apertura: mediana {fmt(med(entradas), ' pts', 5)}")
    print(f"  solo cierre:   mediana {fmt(med(salidas), ' pts', 5)}")
    print("\n  Esto es el cruce AISLADO del atraso. El 25% que se habia calibrado")
    print("  salia de un 34% que mezclaba las dos cosas; con estos numeros se puede")
    print("  fijar toleranciaDeslizamientoPct sobre el efecto real.")

    # ── 4. VETO DE MURO EN SOMBRA ──────────────────────────────────────────
    print("\n=== 4. VETO DE MURO EN SOMBRA ===")
    conVeto = [e for e in utiles if isinstance(e.get("vetoMuroSombra"), dict)
               and e["vetoMuroSombra"].get("aplica")]
    if not conVeto:
        print("  Sin trades con veto evaluado todavia.")
    else:
        vet = [e for e in conVeto if e["vetoMuroSombra"].get("vetaria")]
        pas = [e for e in conVeto if not e["vetoMuroSombra"].get("vetaria")]
        for nom, grupo in (("HABRIA VETADO", vet), ("dejo pasar", pas)):
            if grupo:
                g = [e for e in grupo if e["paperPnl"]["neto"] > 0]
                tot = sum(e["paperPnl"]["neto"] for e in grupo)
                print(f"  {nom:<15} n={len(grupo):>3}  winrate {100*len(g)/len(grupo):>5.1f}%  P&L ${tot:>8.0f}")
            else:
                print(f"  {nom:<15} n=  0")
        print(f"\n  Recordatorio: hacen falta ~25-30 vetos para darle poder de bloqueo.")
        print(f"  Van {len(vet)}.")


if __name__ == "__main__":
    main()
