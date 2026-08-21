# -*- coding: utf-8 -*-
"""
Cierre diario del Contador — el motor determinista de la Fase 1.

Por que existe: el modelo NO hace la aritmetica. Si sumara 180 trades en su
cabeza, dos corridas sobre los mismos datos podrian dar dos cifras distintas, y
entonces no se midio nada. Este script baja las ejecuciones de produccion,
calcula, y deja el resultado escrito. El agente lee esa salida y redacta.

Se puede correr a mano para verificar cualquier numero que reporte el agente:

  python scripts/cierre_diario.py                 # el dia de hoy (hora ET)
  python scripts/cierre_diario.py --fecha 2026-08-20
  python scripts/cierre_diario.py --dias 5        # los ultimos 5 dias con trades

Escribe en cierres/:
  <fecha>.json        el detalle completo, para auditar
  parte_<fecha>.txt   el parte en el formato [CONTADOR], listo para el acta
  historico.jsonl     una linea por dia, para ver la serie sin releer todo

REGLA QUE MANDA: el numero oficial sale de la cadena real de TastyTrade. Lo
calcula el servidor en src/pnl_oficial.js y viaja en cada ejecucion como
`resultadoOficial`. Este script NO reimplementa esa regla — la lee. Es lo que
evita que vuelva el problema que la Fase 0 vino a resolver.
"""
import argparse, json, os, sys
from datetime import datetime, timedelta, timezone

PROD = "https://web-production-23473.up.railway.app"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(REPO, "cierres")

# Umbrales del semaforo. Estan aca arriba y con nombre para que se puedan discutir
# sin leer el codigo, y para que cambiarlos quede en el control de cambios.
EDAD_COTIZACION_AMBAR_SEG = 60      # una decision con datos de hace un minuto ya no es la misma
DIFERENCIA_AMBAR_USD      = 150     # brecha por trade contra el broker
DIFERENCIA_DIA_AMBAR_USD  = 200     # brecha acumulada del dia, aunque ningun trade solo la alcance
MUESTRA_MINIMA            = 30


def _get_json(url, timeout=90, reintentos=3):
    """Railway duerme el contenedor: la primera llamada suele dar 502. Reintenta."""
    from urllib.request import urlopen
    ultimo = None
    for i in range(reintentos):
        try:
            with urlopen(url, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:      # noqa: BLE001 — se reintenta a proposito
            ultimo = e
    raise RuntimeError(f"no se pudo leer {url}: {ultimo}")


def hoy_et():
    """La sesion es de Nueva York. En agosto ET = UTC-4."""
    return (datetime.now(timezone.utc) - timedelta(hours=4)).strftime("%Y-%m-%d")


def dia_de(e):
    return (e.get("closedAt") or e.get("filledAt") or e.get("timestamp") or "")[:10]


def hora_de(e):
    t = e.get("closedAt") or e.get("filledAt") or e.get("timestamp") or ""
    return t[11:16] if len(t) > 15 else ""


def _num(v):
    return v if isinstance(v, (int, float)) else None


def fila(e):
    """Una linea por trade, con todo lo que el Contador tiene que mirar."""
    r  = e.get("resultadoOficial") or {}
    pe = e.get("paperEntry") or {}
    px = e.get("paperExit") or {}
    pp = e.get("paperPnl") or {}

    # Deslizamiento contra el medio: lo que costo cruzar el spread de verdad, en
    # vez de soñar con que nos llenaban al mid.
    desliz_ent = None
    if _num(pe.get("neto")) is not None and _num(pe.get("netoAlMedio")) is not None:
        desliz_ent = round(abs(pe["neto"]) - abs(pe["netoAlMedio"]), 4)

    return {
        "id": e.get("id"),
        "hora": hora_de(e),
        "familia": e.get("strategyFamily"),
        "estrategia": e.get("strategy"),
        "motivo": e.get("closeReason"),
        "contratos": e.get("contracts") or 1,
        "oficial": _num(r.get("pnl")),
        "fuente": r.get("fuente"),
        "esCadenaReal": bool(r.get("esCadenaReal")),
        "comparable": bool(r.get("comparable")),
        "broker": _num(r.get("pnlBroker")),
        "diferencia": _num(r.get("diferencia")),
        "costoCruce": _num(pp.get("costoCruceTotal")),
        "deslizEntrada": desliz_ent,
        "comision": _num(e.get("commissionEstimate")),
        "edadCotizacionSeg": _num(e.get("edadCotizacionTPSLSeg")),
        "fuenteCotizacion": e.get("fuenteCotizacionTPSL"),
        "edadEntradaSeg": _num(pe.get("edadSeg")),
        "edadSalidaSeg": _num(px.get("edadSeg")),
        "huella": ((e.get("algoVersion") or {}).get("huella")),
    }


def revisar(filas):
    """El semaforo, y por que. Un ESTADO sin motivo no sirve para nada."""
    rojo, ambar = [], []
    for f in filas:
        if f["oficial"] is None:
            continue
        m = (f["motivo"] or "").upper()
        # Lo que NO deberia pasar nunca: un objetivo que cierra en perdida o un
        # stop que cierra en ganancia. Es la senal de que algo esta mal calculado
        # o mal etiquetado, y va escalado el mismo dia.
        if "TP" in m and f["oficial"] < 0:
            rojo.append(f"{f['id']}: cerro por {f['motivo']} y dio ${f['oficial']}")
        if m.startswith("SL") and f["oficial"] > 0:
            rojo.append(f"{f['id']}: cerro por {f['motivo']} y dio ${f['oficial']}")

        if not f["esCadenaReal"]:
            ambar.append(f"{f['id']}: sin libro propio, medido con {f['fuente']}")
        if (f["edadCotizacionSeg"] or 0) > EDAD_COTIZACION_AMBAR_SEG:
            ambar.append(f"{f['id']}: decidio con cotizacion de {f['edadCotizacionSeg']:.0f}s")
        if f["diferencia"] is not None and abs(f["diferencia"]) >= DIFERENCIA_AMBAR_USD:
            ambar.append(f"{f['id']}: ${abs(f['diferencia']):.0f} de brecha contra el broker")

    # La brecha del DIA, no solo la de cada trade: dos desvios de -100 y -110 no
    # disparan la alerta individual y sin embargo el dia cerro $210 abajo del
    # broker. Paso el 2026-08-21 y el parte salio verde.
    difs = [f["diferencia"] for f in filas if f["diferencia"] is not None]
    if difs and abs(sum(difs)) >= DIFERENCIA_DIA_AMBAR_USD:
        ambar.append(f"brecha del dia contra el broker: ${sum(difs):+.0f} "
                     f"en {len(difs)} trades")

    estado = "rojo" if rojo else ("ambar" if ambar else "verde")
    return estado, rojo, ambar


def resumir(filas):
    comp   = [f for f in filas if f["comparable"] and f["oficial"] is not None]
    legado = [f for f in filas if not f["comparable"] and f["oficial"] is not None]
    gan = [f["oficial"] for f in comp if f["oficial"] > 0]
    per = [f["oficial"] for f in comp if f["oficial"] <= 0]
    cruces = [f["costoCruce"] for f in comp if f["costoCruce"] is not None]
    return {
        "trades": len(comp),
        "ganadores": len(gan),
        "winRate": round(len(gan) / len(comp) * 100, 1) if comp else None,
        "pnl": round(sum(f["oficial"] for f in comp), 2),
        "gananciaMedia": round(sum(gan) / len(gan), 2) if gan else None,
        # La variable a vigilar en estructuras de credito: el win rate engaña,
        # lo que mata es el tamaño de la cola.
        "perdidaMedia": round(sum(per) / len(per), 2) if per else None,
        "costoCruceTotal": round(sum(cruces), 2) if cruces else None,
        "comisionTotal": round(sum(f["comision"] for f in comp if f["comision"]), 2) if comp else None,
        "brokerPnl": round(sum(f["broker"] for f in comp if f["broker"] is not None), 2) if comp else None,
        "legadoTrades": len(legado),
        "legadoPnl": round(sum(f["oficial"] for f in legado), 2) if legado else 0,
    }


def acumulado_version(todas, huella, hasta):
    """Como va la version vigente, para saber cuanto falta para poder concluir.

    Corta en `hasta` a proposito: al rehacer dias viejos con --dias, un acumulado
    "de hoy" pondria en el parte del 17 un numero que ese dia no se sabia. El
    parte tiene que decir lo que se sabia ese dia, o no sirve para auditar."""
    if not huella:
        return None
    f = [fila(e) for e in todas
         if (e.get("algoVersion") or {}).get("huella") == huella
         and e.get("status") == "closed"
         and dia_de(e) <= hasta]
    r = resumir(f)
    r["huella"] = huella
    r["faltan"] = max(0, MUESTRA_MINIMA - r["trades"])
    r["muestraSuficiente"] = r["trades"] >= MUESTRA_MINIMA
    return r


def parte(fecha, res, estado, rojo, ambar, acum, filas):
    """El bloque [CONTADOR] tal como entra al acta. Si no paso nada, una linea."""
    L = [f"[CONTADOR] {fecha}", f"ESTADO: {estado}"]

    if res["trades"] == 0 and res["legadoTrades"] == 0:
        L.append("Sin trades cerrados.")
        return "\n".join(L)

    L.append(f"CIERRE: cadena real ${res['pnl']} · broker ${res['brokerPnl']} "
             f"· diferencia ${round((res['pnl'] or 0) - (res['brokerPnl'] or 0), 2)}")
    L.append(f"  {res['trades']} trades · {res['ganadores']} ganadores"
             + (f" · WR {res['winRate']}%" if res["winRate"] is not None else "")
             + (f" · ganancia media ${res['gananciaMedia']}" if res["gananciaMedia"] is not None else "")
             + (f" · perdida media ${res['perdidaMedia']}" if res["perdidaMedia"] is not None else ""))
    if res["costoCruceTotal"] is not None:
        L.append(f"  costo de cruce ${res['costoCruceTotal']} · comision ${res['comisionTotal']}")
    if res["legadoTrades"]:
        L.append(f"  ({res['legadoTrades']} sin libro propio, no entran al numero de arriba)")

    L.append("HALLAZGOS:")
    if rojo:
        for x in rojo:
            L.append(f"  - IMPOSIBLE: {x}")
    for x in dict.fromkeys(ambar):
        L.append(f"  - {x}")
    if not rojo and not ambar:
        L.append("  - sin novedades")

    if acum:
        v = "suficiente" if acum["muestraSuficiente"] else f"faltan {acum['faltan']} para {MUESTRA_MINIMA}"
        L.append(f"VERSION VIGENTE {acum['huella']}: {acum['trades']} trades"
                 + (f" · WR {acum['winRate']}%" if acum["winRate"] is not None else "")
                 + f" · ${acum['pnl']}"
                 + (f" · perdida media ${acum['perdidaMedia']}" if acum["perdidaMedia"] is not None else "")
                 + f" · muestra {v}")

    L.append("PENDIENTE DE DECISION:")
    if rojo:
        L.append("  - Hay un cierre con resultado imposible. ¿Se escala hoy como correccion? (si/no)")
    elif not ambar:
        L.append("  - ninguna")
    else:
        L.append("  - ninguna (los ambar son para vigilar, no para decidir hoy)")
    return "\n".join(L)


def correr(fecha, todas):
    delDia = [e for e in todas if e.get("status") == "closed" and dia_de(e) == fecha]
    filas  = [fila(e) for e in delDia]
    res    = resumir(filas)
    estado, rojo, ambar = revisar(filas)

    huella = None
    for f in sorted(filas, key=lambda x: x["hora"], reverse=True):
        if f["huella"]:
            huella = f["huella"]; break
    acum = acumulado_version(todas, huella, fecha)

    os.makedirs(SALIDA, exist_ok=True)
    doc = {"fecha": fecha, "estado": estado, "resumen": res, "rojo": rojo,
           "ambar": sorted(set(ambar)), "versionVigente": acum, "trades": filas,
           "generado": datetime.now().isoformat(timespec="seconds"),
           "regla": "cadena real de TastyTrade (src/pnl_oficial.js)"}
    with open(os.path.join(SALIDA, f"{fecha}.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)

    txt = parte(fecha, res, estado, rojo, ambar, acum, filas)
    with open(os.path.join(SALIDA, f"parte_{fecha}.txt"), "w", encoding="utf-8") as fh:
        fh.write(txt + "\n")

    # Una linea por dia: la serie se lee sin abrir 200 archivos.
    linea = {"fecha": fecha, "estado": estado, "trades": res["trades"],
             "pnl": res["pnl"], "broker": res["brokerPnl"],
             "winRate": res["winRate"], "perdidaMedia": res["perdidaMedia"],
             "costoCruce": res["costoCruceTotal"]}
    hist = os.path.join(SALIDA, "historico.jsonl")
    previas = []
    if os.path.exists(hist):
        with open(hist, encoding="utf-8") as fh:
            previas = [json.loads(l) for l in fh if l.strip()]
    previas = [p for p in previas if p.get("fecha") != fecha] + [linea]
    with open(hist, "w", encoding="utf-8") as fh:
        for p in sorted(previas, key=lambda x: x["fecha"]):
            fh.write(json.dumps(p, ensure_ascii=False) + "\n")

    return txt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fecha", help="YYYY-MM-DD (por defecto: hoy en hora ET)")
    ap.add_argument("--dias", type=int, help="rehacer los ultimos N dias CON trades")
    a = ap.parse_args()

    todas = _get_json(f"{PROD}/api/tradier/executions").get("executions", [])
    if not any(isinstance(e.get("resultadoOficial"), dict) for e in todas):
        print("AVISO: produccion no esta mandando `resultadoOficial`. Sin la Fase 0 "
              "desplegada este script no puede aplicar la regla del dinero.", file=sys.stderr)
        return 2

    if a.dias:
        dias = sorted({dia_de(e) for e in todas if e.get("status") == "closed" and dia_de(e)})[-a.dias:]
    else:
        dias = [a.fecha or hoy_et()]

    for d in dias:
        print(correr(d, todas))
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
