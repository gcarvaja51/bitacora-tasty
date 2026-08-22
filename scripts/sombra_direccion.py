# -*- coding: utf-8 -*-
"""
Sombra del filtro de direccion — el instrumento que le faltaba a DIR-1.

La propuesta mas vieja del backlog dice que el filtro de direccion de 15m va
horas atrasado, y propone que el MACD de 15m pueda VETAR cuando contradice a la
fase. Hasta hoy el Auditor devolvia SIN INSTRUMENTO: no habia sombra que pudiera
contestarla, asi que llevaba semanas esperando una muestra que nadie juntaba.

  python scripts/sombra_direccion.py
  python scripts/sombra_direccion.py --json

QUE MIDE, y por que es mejor que una simulacion:

No reconstruye lo que habria pasado. Usa trades REALES con su resultado REAL
contra la cadena de TastyTrade, y los parte en dos segun el MACD de 15m que
habia EN EL MOMENTO de construir la señal:

  DE ACUERDO   el MACD apuntaba al mismo lado que la señal
  EN CONTRA    el MACD apuntaba al lado opuesto  <- estos son los que se vetarian

Si el grupo EN CONTRA rinde peor, el veto tiene sentido. Si rinde igual o mejor,
la propuesta esta equivocada y hay que decirlo.

COMO SE UNEN LOS DATOS: el MACD del instante de la señal solo queda en el
snapshot de `SIGNAL_BUILT` del log de estrategia; las ejecuciones no lo guardan.
Se emparejan por el epoch que el propio signalId lleva dentro (spx-<ms>), con
tolerancia de 5 segundos.

⚠️ LIMITE CONOCIDO: el log guarda las ultimas 5000 entradas, o sea unos 10 dias.
Los trades mas viejos que eso NO se pueden emparejar y la muestra no crece hacia
atras — solo hacia adelante, y con techo. Por eso server.js pasa a estampar el
macd15m en la propia ejecucion (como el sello de algoVersion): a partir de ahi la
muestra se acumula sin depender de la retencion del log.
"""
import argparse, json, os, re, sys
from datetime import datetime, timedelta, timezone

PROD = "https://web-production-23473.up.railway.app"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(REPO, "veredictos")
TOLERANCIA_SEG = 5


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


def _ts(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def macd_de(e, señales_log):
    """El MACD de 15m del instante de la señal.

    Primero el sello propio de la ejecucion —si existe, es exacto y no depende de
    ninguna retencion—; si no, se busca en el log por cercania temporal."""
    sello = e.get("macd15mEntrada")
    if isinstance(sello, dict):
        return sello, "sello"
    m = re.match(r"spx-(\d{13})", e.get("signalId") or "")
    if not m or not señales_log:
        return None, None
    objetivo = int(m.group(1)) / 1000
    best = min(señales_log, key=lambda x: abs(x["_t"] - objetivo))
    if abs(best["_t"] - objetivo) > TOLERANCIA_SEG:
        return None, None
    return (best.get("snapshot") or {}).get("macd15m"), "log"


def clasificar(direccion, macd):
    """DE_ACUERDO / EN_CONTRA / NEUTRO. Neutro no es lo mismo que de acuerdo:
    un MACD sin sesgo no confirma nada, y meterlo en el grupo bueno inflaria
    artificialmente al que se quiere defender."""
    if not isinstance(macd, dict) or not direccion:
        return None
    bull, bear = bool(macd.get("bullish")), bool(macd.get("bearish"))
    if not bull and not bear:
        return "NEUTRO"
    if direccion == "BULLISH":
        return "DE_ACUERDO" if bull else "EN_CONTRA"
    if direccion == "BEARISH":
        return "DE_ACUERDO" if bear else "EN_CONTRA"
    return None


def resumir(filas):
    if not filas:
        return {"n": 0, "ganadores": 0, "winRate": None, "pnl": 0,
                "pnlPorTrade": None, "perdidaMedia": None}
    gan = [f for f in filas if f["pnl"] > 0]
    per = [f for f in filas if f["pnl"] <= 0]
    suma = sum(f["pnl"] for f in filas)
    return {
        "n": len(filas), "ganadores": len(gan),
        "winRate": round(len(gan) / len(filas) * 100, 1),
        "pnl": round(suma, 2), "pnlPorTrade": round(suma / len(filas), 2),
        "perdidaMedia": round(sum(f["pnl"] for f in per) / len(per), 2) if per else None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    ex = _get_json(f"{PROD}/api/tradier/executions").get("executions", [])
    log = _get_json(f"{PROD}/api/spx/strategy-log")
    if isinstance(log, dict):
        log = log.get("entradas") or []
    sb = [x for x in log if x.get("stage") == "SIGNAL_BUILT" and x.get("snapshot")]
    for x in sb:
        x["_t"] = _ts(x["timestamp"])

    filas, sin_macd, sin_libro = [], 0, 0
    for e in ex:
        if e.get("strategyFamily") != "TENDENCIA" or e.get("status") != "closed":
            continue
        r = e.get("resultadoOficial") or {}
        if r.get("fuente") == "no_operacion":
            continue
        # SOLO cadena real. Mezclar aca lo medido con el broker seria repetir el
        # error que la Fase 0 vino a resolver, y encima sobre la propuesta de
        # mayor impacto del backlog.
        if not r.get("comparable") or r.get("pnl") is None:
            sin_libro += 1
            continue
        macd, fuente = macd_de(e, sb)
        cls = clasificar(e.get("direction"), macd)
        if not cls:
            sin_macd += 1
            continue
        filas.append({"id": e.get("id"), "dia": (e.get("closedAt") or "")[:10],
                      "direccion": e.get("direction"), "clase": cls,
                      "hist": (macd or {}).get("hist"),
                      "pnl": r["pnl"], "motivo": e.get("closeReason"),
                      "fuenteMacd": fuente})

    acuerdo = [f for f in filas if f["clase"] == "DE_ACUERDO"]
    contra  = [f for f in filas if f["clase"] == "EN_CONTRA"]
    neutro  = [f for f in filas if f["clase"] == "NEUTRO"]
    total   = resumir(filas)
    con_veto = resumir([f for f in filas if f["clase"] != "EN_CONTRA"])

    doc = {
        "propuesta": "DIR-1 — que el MACD de 15m pueda vetar cuando contradice a la señal",
        "regla": "cadena real de TastyTrade",
        "emparejados": len(filas),
        "descartados": {"sinLibroPropio": sin_libro, "sinMacdEnElLog": sin_macd},
        "grupos": {"DE_ACUERDO": resumir(acuerdo), "EN_CONTRA": resumir(contra),
                   "NEUTRO": resumir(neutro)},
        "hoy": total,
        "conElVeto": con_veto,
        "efectoDelVeto": {
            "tradesQueSeEvitarian": len(contra),
            "pnlQueSeEvitaria": round(sum(f["pnl"] for f in contra), 2),
            "diferenciaPnl": round(con_veto["pnl"] - total["pnl"], 2),
        },
        "limite": ("el log guarda 5000 entradas (~10 dias): los trades mas viejos no se "
                   "pueden emparejar. Desde el sello macd15mEntrada la muestra ya no depende de eso."),
        "trades": filas,
        "generado": datetime.now().isoformat(timespec="seconds"),
    }

    os.makedirs(SALIDA, exist_ok=True)
    with open(os.path.join(SALIDA, "sombra_direccion.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)

    if a.json:
        print(json.dumps(doc, ensure_ascii=False, indent=1)); return 0

    print("=" * 72)
    print(" SOMBRA DEL FILTRO DE DIRECCION (DIR-1)")
    print(" Trades reales, resultado real contra la cadena de TastyTrade")
    print("=" * 72)
    print(f"emparejados: {len(filas)}   "
          f"(descartados: {sin_libro} sin libro propio, {sin_macd} sin MACD en el log)")
    print()
    for nom, g in doc["grupos"].items():
        if not g["n"]:
            print(f"  {nom:<12} sin casos"); continue
        print(f"  {nom:<12} n={g['n']:<3} WR={g['winRate']}%  ${g['pnl']}  "
              f"por trade ${g['pnlPorTrade']}  perdida media ${g['perdidaMedia']}")
    print()
    print(f"  hoy (sin veto):  n={total['n']}  WR={total['winRate']}%  ${total['pnl']}")
    print(f"  con el veto:     n={con_veto['n']}  WR={con_veto['winRate']}%  ${con_veto['pnl']}")
    ev = doc["efectoDelVeto"]
    print(f"  efecto: evitaria {ev['tradesQueSeEvitarian']} trades que sumaron "
          f"${ev['pnlQueSeEvitaria']} -> el total cambia ${ev['diferenciaPnl']:+}")
    print()
    print("  EL VEREDICTO NO ES DE ESTE SCRIPT: lo da el Auditor con su regla de muestra.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
