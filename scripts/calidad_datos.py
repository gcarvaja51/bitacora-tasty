# -*- coding: utf-8 -*-
"""
Calidad del dato y anatomia de la semana — el motor del Ingeniero de Datos.

Dos oficios, la misma materia prima: quien vigila que el dato este bien es quien
mejor puede leer que dice el dato.

  python scripts/calidad_datos.py                # el dia de hoy
  python scripts/calidad_datos.py --semana       # revision semanal (jueves)
  python scripts/calidad_datos.py --dias 10      # ventana explicita

Escribe en datos/:
  <fecha>.json        el detalle completo
  parte_<fecha>.txt   el parte [DATOS]

QUE CALCULA, y que NO:

  Calcula hechos verificables: cuantas evaluaciones murieron en cada puerta, con
  que frescura de precio se decidio, que campos faltan, como se compara con la
  semana anterior.

  NO formula la hipotesis ni la propuesta. Eso es criterio y lo pone el agente
  leyendo esta salida. Un script no sabe POR QUE el mercado giro; sabe cuantas
  veces la puerta dijo que no.

LA FRONTERA: este puesto es dueño de que el DATO este sano (frescura, sellos,
completitud) y de la SEÑAL (entradas, filtros, umbrales). Que el SISTEMA este
sano —procesos, ordenes, errores del broker— es de la Torre de Control. Lo que
aparece aca y es de la Torre se marca aparte y se le pasa; no se dictamina.
"""
import argparse, json, os, sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from statistics import median

PROD = "https://web-production-23473.up.railway.app"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(REPO, "datos")

SPOT_VIEJO_SEG = 120      # un precio con mas de 2 min no describe el mercado en que se decide
CORTE_LIBRO    = "2026-08-16"


def _get_json(url, timeout=120, reintentos=3):
    from urllib.request import urlopen
    ultimo = None
    for _ in range(reintentos):
        try:
            with urlopen(url, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:      # noqa: BLE001
            ultimo = e
    raise RuntimeError(f"no se pudo leer {url}: {ultimo}")


def hoy_et():
    return (datetime.now(timezone.utc) - timedelta(hours=4)).strftime("%Y-%m-%d")


def dia(x, campo="timestamp"):
    return (x.get(campo) or "")[:10]


# ── Bloque A: la calidad del dato ───────────────────────────────────────────

def calidad(ejec, log, desde):
    cerr = [e for e in ejec if e.get("status") == "closed"]

    # 1. Sellos. Sin algoVersion un trade no se puede atribuir a ninguna version:
    #    no es que valga menos, es que no entra a ninguna comparacion.
    sin_sello = [e for e in cerr if not (e.get("algoVersion") or {}).get("huella")]
    por_fam_sello = Counter(e.get("strategyFamily") for e in sin_sello)

    # 2. Libro propio. Despues del corte, un cierre sin libro es un defecto, no
    #    una limitacion historica.
    sin_libro_nuevo = [e for e in cerr
                       if (e.get("closedAt") or "")[:10] >= CORTE_LIBRO
                       and not ((e.get("paperPnl") or {}).get("confiable"))]

    # 3. Campos que faltan segun el motivo de cierre. Un campo que no se escribe
    #    solo para cierto tipo de cierre es un bug, no una casualidad.
    faltan = defaultdict(lambda: defaultdict(int))
    totales_motivo = Counter()
    for e in cerr:
        if (e.get("closedAt") or "")[:10] < CORTE_LIBRO:
            continue
        m = e.get("closeReason") or "?"
        totales_motivo[m] += 1
        campos = ["edadCotizacionTPSLSeg", "fuenteCotizacionTPSL", "paperEntry", "paperExit"]
        # En un cierre manual no hay decision automatica de TP/SL, asi que no hay
        # cotizacion con la que se haya decidido: pedirla es un falso positivo que
        # aparecia todas las semanas. Lo que si importa es la frescura de la
        # cadena con que se valoro la salida, y esa vive en paperExit.
        if e.get("fuenteCotizacionTPSL") == "cierre_manual" or m == "MANUAL_FORZADO":
            campos.remove("edadCotizacionTPSLSeg")
        for campo in campos:
            if e.get(campo) in (None, "", {}):
                faltan[m][campo] += 1
    campos_faltantes = [
        {"motivo": m, "campo": c, "faltan": n, "de": totales_motivo[m],
         "todos": n == totales_motivo[m]}
        for m, cs in faltan.items() for c, n in cs.items()
    ]
    campos_faltantes.sort(key=lambda x: (-x["faltan"], x["motivo"]))

    # 4. Frescura del precio con el que se DECIDE. Sale del snapshot de cada
    #    evaluacion: es el dato que mas veces ha hecho daño en este proyecto.
    edades, por_fuente = [], defaultdict(list)
    for x in log:
        if dia(x) < desde:
            continue
        s = x.get("snapshot") or {}
        ed, fu = s.get("spotEdadSeg"), s.get("spotFuente")
        if isinstance(ed, (int, float)):
            edades.append(ed)
            if fu:
                por_fuente[fu].append(ed)
    frescura = {
        "n": len(edades),
        "medianaSeg": round(median(edades), 1) if edades else None,
        "p90Seg": round(sorted(edades)[int(len(edades) * 0.9)], 1) if edades else None,
        "maxSeg": round(max(edades), 1) if edades else None,
        "sobreUmbral": sum(1 for e in edades if e > SPOT_VIEJO_SEG),
        "umbralSeg": SPOT_VIEJO_SEG,
        "porFuente": {k: {"n": len(v), "medianaSeg": round(median(v), 1)}
                      for k, v in sorted(por_fuente.items(), key=lambda kv: -len(kv[1]))},
    }

    return {
        "sinSello": {"n": len(sin_sello), "porFamilia": dict(por_fam_sello),
                     "de": len(cerr)},
        "sinLibroDespuesDelCorte": {"n": len(sin_libro_nuevo), "corte": CORTE_LIBRO,
                                    "ids": [e.get("id") for e in sin_libro_nuevo][:10]},
        "camposFaltantes": campos_faltantes[:12],
        "frescuraDelSpot": frescura,
    }


# ── Bloque B: donde mueren las decisiones ───────────────────────────────────

def embudo(log, desde, hasta=None):
    ventana = [x for x in log if dia(x) >= desde and (hasta is None or dia(x) <= hasta)]
    por = defaultdict(Counter)
    razones = defaultdict(Counter)
    for x in ventana:
        fam = x.get("strategyFamily") or "?"
        st = x.get("stage") or "?"
        por[fam][st] += 1
        if not x.get("passed"):
            razones[f"{fam}|{st}"][(x.get("reason") or "")[:110]] += 1
    return {
        "evaluaciones": len(ventana),
        "porFamilia": {f: dict(c.most_common()) for f, c in por.items()},
        "razones": {k: dict(c.most_common(3)) for k, c in razones.items()},
    }


# ── Bloque C: lo que aparece aca pero es de otro ────────────────────────────

def para_la_torre(log, desde):
    """La Torre vigila el sistema; este puesto vigila el dato. Pero el log los
    mezcla, asi que lo que es suyo se separa y se le pasa — no se dictamina."""
    v = [x for x in log if dia(x) >= desde]
    rech = [x for x in v if x.get("stage") == "ORDEN_RECHAZADA"]
    mism = [x for x in v if x.get("stage") == "POSITION_CHECK_MISMATCH"]
    return {
        "ordenesRechazadas": {"n": len(rech),
                              "razones": dict(Counter((x.get("reason") or "")[:110] for x in rech).most_common(3))},
        "desacuerdoDePosicion": {"n": len(mism),
                                 "razones": dict(Counter((x.get("reason") or "")[:110] for x in mism).most_common(2))},
    }


def parte(fecha, cal, emb, emb_prev, torre, semanal):
    L = [f"[DATOS] {fecha}"]

    alertas = []
    f = cal["frescuraDelSpot"]
    if f["n"] and f["sobreUmbral"]:
        pct = round(f["sobreUmbral"] / f["n"] * 100, 1)
        alertas.append(f"{f['sobreUmbral']} de {f['n']} decisiones ({pct}%) con precio de mas de {f['umbralSeg']}s")
    if cal["sinLibroDespuesDelCorte"]["n"]:
        alertas.append(f"{cal['sinLibroDespuesDelCorte']['n']} cierres despues del {CORTE_LIBRO} sin libro propio")
    # Un campo que falta en la MAYORIA de un tipo de cierre es un patron, no una
    # casualidad. Exigir que falte en TODOS era demasiado estricto: los
    # MANUAL_FORZADO llegan sin edadCotizacionTPSLSeg 3 de cada 4 veces y la
    # alerta no disparaba.
    patron = [c for c in cal["camposFaltantes"]
              if c["de"] >= 3 and c["faltan"] / c["de"] >= 0.75]
    for c in patron:
        alertas.append(f"`{c['campo']}` falta en {c['faltan']} de {c['de']} cierres {c['motivo']}"
                       + (" (en todos)" if c["todos"] else ""))

    L.append(f"ESTADO: {'ambar' if alertas else 'verde'}")
    L.append(f"CALIDAD DEL DATO: frescura mediana {f['medianaSeg']}s (p90 {f['p90Seg']}s) "
             f"· {cal['sinSello']['n']} de {cal['sinSello']['de']} cierres sin sello")
    fu = f.get("porFuente") or {}
    if len(fu) > 1:
        L.append("  fuentes del precio: " + " · ".join(
            f"{k} n={v['n']} mediana {v['medianaSeg']}s" for k, v in fu.items()))

    L.append("HALLAZGOS:")
    if alertas:
        for a in alertas:
            L.append(f"  - {a}")
    else:
        L.append("  - sin novedades")

    L.append(f"DONDE MUEREN LAS DECISIONES ({emb['evaluaciones']} evaluaciones):")
    for fam, etapas in sorted(emb["porFamilia"].items(), key=lambda kv: -sum(kv[1].values())):
        top = list(etapas.items())[:3]
        prev = (emb_prev or {}).get("porFamilia", {}).get(fam, {})
        det = " · ".join(f"{k} {v}" + (f" (antes {prev[k]})" if k in prev else "") for k, v in top)
        L.append(f"  {fam}: {det}")

    t = torre["ordenesRechazadas"]["n"]; m = torre["desacuerdoDePosicion"]["n"]
    if t or m:
        L.append("PARA LA TORRE DE CONTROL (no es mio, se lo paso):")
        if t:
            L.append(f"  - {t} ordenes rechazadas por el broker")
        if m:
            L.append(f"  - {m} bloqueos por desacuerdo entre Tradier y el registro local")

    L.append("PROPUESTA:")
    if semanal:
        L.append("  - (la formula el agente leyendo esta salida: UNA por familia, maximo,")
        L.append("     con el numero que la motiva y que espera que cambie)")
    else:
        L.append("  - ninguna: de lunes a jueves se anota, no se propone")

    L.append("PENDIENTE DE DECISION:")
    L.append("  - " + ("las que abra la propuesta" if semanal else "ninguna"))
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--semana", action="store_true", help="revision semanal (jueves)")
    ap.add_argument("--dias", type=int, default=None)
    a = ap.parse_args()

    dias = a.dias or (7 if a.semana else 1)
    fecha = hoy_et()
    desde = (datetime.strptime(fecha, "%Y-%m-%d") - timedelta(days=dias - 1)).strftime("%Y-%m-%d")
    desde_prev = (datetime.strptime(desde, "%Y-%m-%d") - timedelta(days=dias)).strftime("%Y-%m-%d")
    hasta_prev = (datetime.strptime(desde, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")

    ejec = _get_json(f"{PROD}/api/tradier/executions").get("executions", [])
    log  = _get_json(f"{PROD}/api/spx/strategy-log")
    if isinstance(log, dict):
        log = log.get("entradas") or []

    cal = calidad(ejec, log, desde)
    emb = embudo(log, desde)
    emb_prev = embudo(log, desde_prev, hasta_prev) if a.semana else None
    torre = para_la_torre(log, desde)

    os.makedirs(SALIDA, exist_ok=True)
    doc = {"fecha": fecha, "ventanaDias": dias, "desde": desde, "semanal": bool(a.semana),
           "calidad": cal, "embudo": emb, "embudoPrevio": emb_prev, "paraLaTorre": torre,
           "generado": datetime.now().isoformat(timespec="seconds")}
    with open(os.path.join(SALIDA, f"{fecha}.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)

    txt = parte(fecha, cal, emb, emb_prev, torre, a.semana)
    with open(os.path.join(SALIDA, f"parte_{fecha}.txt"), "w", encoding="utf-8") as fh:
        fh.write(txt + "\n")
    print(txt)
    return 0


if __name__ == "__main__":
    sys.exit(main())
