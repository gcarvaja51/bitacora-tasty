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

# Cierres que no consultan cotizacion NINGUNA: pedirles edad/fuente de la
# cotizacion con que decidieron es un falso positivo. Caso: el 2026-09-03 entro
# a camposFaltantes un CIERRE_1DTE_HORA_TOPE (1/1) cuya propia razon dice
# "cierre por tiempo, sin evaluacion de precio". El usuario decidio exceptuarlo
# el 2026-09-10.
MOTIVOS_SIN_COTIZACION = {"CIERRE_1DTE_HORA_TOPE"}

# Los cierres por nivel de precio de la Reversion deciden con el SPOT, no con la
# cotizacion de las patas, y hasta el 2026-09-10 esa rama no escribia la
# trazabilidad (TIME_STOP 17/17, PRECIO_OBJETIVO 6/6 sin fuente/edad). El
# usuario eligio el 2026-09-10 la opcion 1: que server.js escriba la fuente
# ('spot_sigma'/'spot_yahoo') y la edad del spot. Los cierres anteriores ya no
# se pueden completar: se cuentan aparte como LEGADO, igual que los sin sello de
# antes del corte, para que el hallazgo mida solo los nuevos. El corte es la
# hora y no el dia porque los cierres del propio 10-sep salieron ANTES del
# despliegue (el ultimo, 14:51Z) y siguen sin los campos.
MOTIVOS_SPOT_TPSL      = {"TIME_STOP", "PRECIO_OBJETIVO", "PRECIO_INVALIDACION",
                          "CIERRE_PRE_CLOSE_30MIN"}
CAMPOS_COTIZACION_TPSL = ("edadCotizacionTPSLSeg", "fuenteCotizacionTPSL")
CORTE_SPOT_TPSL        = "2026-09-10T20:00:00Z"

# Etapa del embudo POSTERIOR a SIGNAL_BUILT: server.js escribe una fila extra
# (stage GATE_CREDITO_RIESGO, passed false) cuando el gate de Credito/Riesgo
# omite la orden de una senal ya construida. Caso 2026-08-26: el gate mato 14
# de 16 senales de TENDENCIA y el embudo las mostraba como construidas, o sea
# como si hubieran llegado a orden. Desde el 2026-09-10 se muestra aparte.
ETAPA_POST_SENAL = "GATE_CREDITO_RIESGO"


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
    # El denominador va por (motivo, campo) y no por motivo: desde que hay
    # exenciones y legado, no todos los cierres de un motivo se examinan para
    # todos los campos, y "falta en 2 de 17" contra 17 que no se miraron
    # achicaria el hueco en vez de medirlo.
    faltan = defaultdict(lambda: defaultdict(int))
    examinados = defaultdict(lambda: defaultdict(int))
    legado_spot = Counter()
    for e in cerr:
        cerrado = e.get("closedAt") or ""
        if cerrado[:10] < CORTE_LIBRO:
            continue
        m = e.get("closeReason") or "?"
        campos = ["edadCotizacionTPSLSeg", "fuenteCotizacionTPSL", "paperEntry", "paperExit"]
        # En un cierre manual no hay decision automatica de TP/SL, asi que no hay
        # cotizacion con la que se haya decidido: pedirla es un falso positivo que
        # aparecia todas las semanas. Lo que si importa es la frescura de la
        # cadena con que se valoro la salida, y esa vive en paperExit.
        if e.get("fuenteCotizacionTPSL") == "cierre_manual" or m == "MANUAL_FORZADO":
            campos.remove("edadCotizacionTPSLSeg")
        if m in MOTIVOS_SIN_COTIZACION:
            campos = [c for c in campos if c not in CAMPOS_COTIZACION_TPSL]
        elif m in MOTIVOS_SPOT_TPSL and cerrado < CORTE_SPOT_TPSL:
            if any(e.get(c) in (None, "", {}) for c in CAMPOS_COTIZACION_TPSL):
                legado_spot[m] += 1
            campos = [c for c in campos if c not in CAMPOS_COTIZACION_TPSL]
        for campo in campos:
            examinados[m][campo] += 1
            if e.get(campo) in (None, "", {}):
                faltan[m][campo] += 1
    campos_faltantes = [
        {"motivo": m, "campo": c, "faltan": n, "de": examinados[m][c],
         "todos": n == examinados[m][c]}
        for m, cs in faltan.items() for c, n in cs.items()
    ]
    campos_faltantes.sort(key=lambda x: (-x["faltan"], x["motivo"]))

    # 4. Frescura del precio con el que se DECIDE. Sale del snapshot de cada
    #    evaluacion: es el dato que mas veces ha hecho daño en este proyecto.
    edades, por_fuente = [], defaultdict(list)
    for x in log:
        # La fila de GATE_CREDITO_RIESGO repite el snapshot de su SIGNAL_BUILT:
        # contarla seria medir dos veces la misma decision.
        if dia(x) < desde or x.get("stage") == ETAPA_POST_SENAL:
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
        "legadoCotizacionTPSL": {"corte": CORTE_SPOT_TPSL, "porMotivo": dict(legado_spot),
                                 "n": sum(legado_spot.values())},
        "exentosSinCotizacion": sorted(MOTIVOS_SIN_COTIZACION),
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
    # GATE_CREDITO_RIESGO no es una evaluacion nueva: es la MISMA senal que ya
    # conto como SIGNAL_BUILT, escribiendo una segunda fila al morir despues. Por
    # eso se resta de las construidas para decir cuantas llegaron de verdad a
    # orden, y no se suma a las evaluaciones.
    llegan = {}
    for fam, c in por.items():
        if c.get(ETAPA_POST_SENAL):
            llegan[fam] = {"signalBuilt": c.get("SIGNAL_BUILT", 0),
                           "gateCreditoRiesgo": c[ETAPA_POST_SENAL],
                           "llegaronAOrden": max(0, c.get("SIGNAL_BUILT", 0) - c[ETAPA_POST_SENAL])}
    return {
        "evaluaciones": len(ventana) - sum(c.get(ETAPA_POST_SENAL, 0) for c in por.values()),
        "porFamilia": {f: dict(c.most_common()) for f, c in por.items()},
        "razones": {k: dict(c.most_common(3)) for k, c in razones.items()},
        "senalesQueLleganAOrden": llegan,
    }


def horas_de_sesion(desde_iso, hasta_iso):
    """Horas de SESION (9:30-16:00 ET, lun-vie) entre dos instantes UTC. Las de
    reloj exagerarian el hueco con noches y fines de semana. Aproximado: no
    descuenta feriados y usa ET = UTC-4, como el resto del script."""
    a = datetime.fromisoformat(desde_iso.replace("Z", "+00:00"))
    b = datetime.fromisoformat(hasta_iso.replace("Z", "+00:00"))
    total, d = 0.0, a.date()
    while d <= b.date():
        if d.weekday() < 5:
            ini = datetime(d.year, d.month, d.day, 13, 30, tzinfo=timezone.utc)
            fin = datetime(d.year, d.month, d.day, 20, 0, tzinfo=timezone.utc)
            lo, hi = max(ini, a), min(fin, b)
            if hi > lo:
                total += (hi - lo).total_seconds() / 3600
        d += timedelta(days=1)
    return round(total, 1)


def ventana_recortada(log, desde):
    """El log de produccion tiene tope de 5000 filas y descarta las viejas. Si la
    ventana pedida arranca antes que la fila mas vieja, los conteos de esa
    ventana salen bajos y NADIE lo decia. Caso 2026-08-27: el log estaba en 5000
    justas, el 14-ago conservaba 171 filas desde las 17:22Z y todos los
    "(antes n)" del parte semanal exageraban el aumento sin avisar."""
    ts = sorted(x.get("timestamp") for x in log if x.get("timestamp"))
    if not ts:
        return None
    mas_vieja = ts[0]
    # desde es un dia ET: arranca a las 04:00Z (medianoche ET = UTC-4)
    inicio = f"{desde}T04:00:00Z"
    if mas_vieja <= inicio:
        return None
    return {"desde": desde, "logArranca": mas_vieja, "filasEnLog": len(ts),
            "horasDeSesionFaltantes": horas_de_sesion(inicio, mas_vieja)}


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


def _hora_et(iso):
    t = datetime.fromisoformat(iso.replace("Z", "+00:00")) - timedelta(hours=4)
    return t.strftime("%Y-%m-%d %H:%M ET")


def parte(fecha, cal, emb, emb_prev, torre, semanal, recortes=None):
    L = [f"[DATOS] {fecha}"]

    alertas = []
    # La ventana recortada va PRIMERO: si la comparacion esta truncada, todo lo
    # que viene abajo con "(antes n)" se lee distinto.
    for nombre, r in (recortes or {}).items():
        if not r:
            continue
        cola = ("los (antes n) van subestimados" if nombre == "anterior"
                else "los conteos de la ventana van subestimados")
        alertas.append(f"VENTANA RECORTADA: el log arranca el {_hora_et(r['logArranca'])} "
                       f"({r['filasEnLog']} filas, tope 5000) y la ventana {nombre} pide desde el "
                       f"{r['desde']}: faltan ~{r['horasDeSesionFaltantes']} horas de sesion; {cola}")
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
    leg = cal.get("legadoCotizacionTPSL") or {}
    if leg.get("n"):
        L.append(f"  (legado, no cuenta: {leg['n']} cierres "
                 + "/".join(f"{m} {n}" for m, n in sorted(leg["porMotivo"].items()))
                 + f" anteriores al {leg['corte'][:10]} sin fuente/edad del spot)")

    L.append(f"DONDE MUEREN LAS DECISIONES ({emb['evaluaciones']} evaluaciones):")
    for fam, etapas in sorted(emb["porFamilia"].items(), key=lambda kv: -sum(kv[1].values())):
        prev = (emb_prev or {}).get("porFamilia", {}).get(fam, {})
        antes = lambda k: f" (antes {prev[k]})" if k in prev else ""
        top = [(k, v) for k, v in etapas.items() if k != ETAPA_POST_SENAL][:3]
        partes_ = [f"{k} {v}{antes(k)}" for k, v in top]
        g = etapas.get(ETAPA_POST_SENAL)
        if g:
            # Va pegada a SIGNAL_BUILT: son las mismas senales, no otras.
            nota = f"de ellas {ETAPA_POST_SENAL} {g}{antes(ETAPA_POST_SENAL)} no llegaron a orden"
            if any(k == "SIGNAL_BUILT" for k, _ in top):
                i = [k for k, _ in top].index("SIGNAL_BUILT")
                partes_[i] += f" · {nota}"
            else:
                partes_.append(f"SIGNAL_BUILT {etapas.get('SIGNAL_BUILT', 0)}"
                               f"{antes('SIGNAL_BUILT')} · {nota}")
        L.append(f"  {fam}: " + " · ".join(partes_))

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
    recortes = {"actual": ventana_recortada(log, desde),
                "anterior": ventana_recortada(log, desde_prev) if a.semana else None}

    os.makedirs(SALIDA, exist_ok=True)
    doc = {"fecha": fecha, "ventanaDias": dias, "desde": desde, "semanal": bool(a.semana),
           "calidad": cal, "embudo": emb, "embudoPrevio": emb_prev, "paraLaTorre": torre,
           "ventanaRecortada": recortes,
           "generado": datetime.now().isoformat(timespec="seconds")}
    with open(os.path.join(SALIDA, f"{fecha}.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)

    txt = parte(fecha, cal, emb, emb_prev, torre, a.semana, recortes)
    with open(os.path.join(SALIDA, f"parte_{fecha}.txt"), "w", encoding="utf-8") as fh:
        fh.write(txt + "\n")
    print(txt)
    return 0


if __name__ == "__main__":
    sys.exit(main())
