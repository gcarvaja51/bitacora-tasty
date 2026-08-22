# -*- coding: utf-8 -*-
"""
Veredictos del Auditor — el motor determinista de la Fase 2.

Por que existe: hasta hoy la pregunta "¿este cambio mejora o empeora?" se
contestaba con intuicion o con una muestra que nadie contaba. Este script corre
cada propuesta del backlog contra el LIBRO SOMBRA —lo que habria pasado sobre el
historial— y devuelve un veredicto con su n.

  python scripts/veredicto_sombra.py                 # todas las propuestas
  python scripts/veredicto_sombra.py --id REV-3      # una sola
  python scripts/veredicto_sombra.py --json          # solo el JSON, sin parte

Escribe en veredictos/:
  <fecha>.json        el detalle, con los numeros que sostienen cada veredicto
  parte_<fecha>.txt   el parte [AUDITOR], listo para el acta

TRES VEREDICTOS, y el tercero es el mas frecuente al principio:

  MEJORA               con el numero y la muestra
  EMPEORA              con el numero y la muestra
  MUESTRA INSUFICIENTE y aqui se detiene

Y uno que no es veredicto sino un hecho sobre el instrumento:

  SIN INSTRUMENTO      no hay sombra que pueda contestar esta propuesta

Decir "parece que mejora" sobre 6 casos es PEOR que no decir nada, porque
autoriza un cambio con apariencia de evidencia. Por eso el corte no lo decide el
tamaño del efecto sino la muestra, y la aritmetica esta abajo, a la vista.

EL AUDITOR NO PROPONE. Este script juzga lo que otros proponen; las propuestas se
declaran en PROPUESTAS y salen del backlog (SUGERENCIAS.md).
"""
import argparse, json, os, sys
from datetime import datetime, timedelta, timezone
from math import sqrt

PROD = "https://web-production-23473.up.railway.app"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(REPO, "veredictos")

# Muestra minima POR LADO de una comparacion. Con menos, la diferencia entre 60%
# y 80% no se distingue del azar — y ese es exactamente el error que este puesto
# existe para no cometer.
MUESTRA_MINIMA = 30


def _get_json(url, timeout=90, reintentos=3):
    from urllib.request import urlopen
    ultimo = None
    for _ in range(reintentos):
        try:
            with urlopen(url, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:      # noqa: BLE001
            ultimo = e
    raise RuntimeError(f"no se pudo leer {url}: {ultimo}")


def wilson(exitos, n, z=1.96):
    """Intervalo de Wilson al 95%. Se usa este y no el normal simple porque con
    n chico y proporciones cerca de 0 o 1 el normal da intervalos que se salen
    de [0,1] y hacen parecer significativo lo que no lo es."""
    if not n:
        return (0.0, 1.0)
    p = exitos / n
    d = 1 + z * z / n
    centro = (p + z * z / (2 * n)) / d
    margen = z * sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, centro - margen), min(1.0, centro + margen))


def comparar(nom_a, ok_a, n_a, nom_b, ok_b, n_b):
    """Compara dos tasas. Devuelve (veredicto, detalle).

    Regla: si cualquiera de los dos lados no llega a la muestra minima, NO hay
    veredicto — por muy tentador que sea el numero. Y si los intervalos de
    confianza se solapan, la diferencia no se distingue del azar aunque ambos
    lados tengan muestra."""
    wr_a = round(ok_a / n_a * 100, 1) if n_a else None
    wr_b = round(ok_b / n_b * 100, 1) if n_b else None
    ia, ib = wilson(ok_a, n_a), wilson(ok_b, n_b)
    det = {
        nom_a: {"n": n_a, "aciertos": ok_a, "winRate": wr_a,
                "ic95": [round(ia[0] * 100, 1), round(ia[1] * 100, 1)]},
        nom_b: {"n": n_b, "aciertos": ok_b, "winRate": wr_b,
                "ic95": [round(ib[0] * 100, 1), round(ib[1] * 100, 1)]},
    }
    if n_a < MUESTRA_MINIMA or n_b < MUESTRA_MINIMA:
        falta = max(0, MUESTRA_MINIMA - min(n_a, n_b))
        det["motivo"] = (f"el lado mas chico tiene {min(n_a, n_b)} casos; "
                         f"faltan {falta} para los {MUESTRA_MINIMA} minimos")
        return "MUESTRA INSUFICIENTE", det
    solapan = not (ia[1] < ib[0] or ib[1] < ia[0])
    if solapan:
        det["motivo"] = "los intervalos de confianza al 95% se solapan: la diferencia no se distingue del azar"
        return "MUESTRA INSUFICIENTE", det
    det["motivo"] = "intervalos separados al 95%"
    return ("MEJORA" if wr_a > wr_b else "EMPEORA"), det


# ── Las propuestas del backlog (SUGERENCIAS.md) ─────────────────────────────
#
# `nivel` decide cuanto se valida, no cuanto importa:
#   alto  = mueve un umbral de entrada, un veto, un peso, un stop -> sombra completa
#   medio = ventana horaria, limite de orden, comision asumida    -> sombra parcial
#   bajo  = pantallas, textos, refactor sin cambio de conducta    -> no se valida
PROPUESTAS = [
    {
        "id": "REV-3", "familia": "REVERSION", "nivel": "alto",
        "titulo": "La banda de alejamiento deja pasar el setup por centesimas",
        "pregunta": "¿Ampliar la banda hacia abajo mejora el acierto?",
        "instrumento": "reversion-sombra.porBandaAlejamiento",
    },
    {
        "id": "REV-4", "familia": "REVERSION", "nivel": "alto",
        "titulo": "Los dos checks de 5m son un VETO, no un peso",
        "pregunta": "¿Cada check discrimina de verdad, o solo bloquea?",
        "instrumento": "reversion-sombra.porCheck",
    },
    {
        "id": "DIR-1", "familia": "DIRECCIONAL", "nivel": "alto",
        "titulo": "El filtro de direccion de 15m va horas atrasado",
        "pregunta": "¿Que el MACD 15m pueda vetar mejora el resultado?",
        # Instrumento construido el 2026-08-22 (scripts/sombra_direccion.py). No
        # simula: usa trades REALES con su resultado real contra la cadena, y los
        # parte segun el MACD de 15m que habia en el instante de la señal.
        "instrumento": "sombra_direccion",
    },
    {
        "id": "NEU-2", "familia": "NEUTRAL", "nivel": "medio",
        "titulo": "El piso de credito y el limite de precio son la misma perilla",
        "pregunta": "¿Desacoplarlos mejora el credito recibido?",
        "instrumento": None,   # haria falta una sombra de fills del Iron Condor
    },
]


def juzgar_REV_3(datos):
    d = datos["reversion"]
    bandas = d.get("porBandaAlejamiento") or []
    dentro = [b for b in bandas if b.get("dentroDeLaPuertaActual")]
    fuera_abajo = []
    for b in bandas:
        if b.get("dentroDeLaPuertaActual"):
            break
        fuera_abajo.append(b)
    if not dentro:
        return "SIN INSTRUMENTO", {"motivo": "la sombra no marca cual banda es la puerta actual"}
    ok_d = sum(b["objetivo"] for b in dentro);      n_d = sum(b["n"] for b in dentro)
    ok_f = sum(b["objetivo"] for b in fuera_abajo); n_f = sum(b["n"] for b in fuera_abajo)
    v, det = comparar("ampliando hacia abajo", ok_f, n_f, "puerta actual", ok_d, n_d)
    det["bandas"] = [{"banda": b["banda"], "n": b["n"], "winRate": b["winRate"],
                      "puertaActual": bool(b.get("dentroDeLaPuertaActual"))} for b in bandas]
    return v, det


def juzgar_REV_4(datos):
    d = datos["reversion"]
    checks = d.get("porCheck") or {}
    res, veredictos = {}, []
    for nombre, c in checks.items():
        cum, fal = c.get("cumple"), c.get("falla")
        if not cum or not fal:
            res[nombre] = {"veredicto": "SIN INSTRUMENTO",
                           "motivo": "un lado no tiene ni un caso en la sombra"}
            continue
        v, det = comparar("cumple", cum["objetivo"], cum["n"], "falla", fal["objetivo"], fal["n"])
        # Un check que acierta MENOS cuando se cumple no esta siendo estricto:
        # esta apuntando al reves. Es un hallazgo distinto de "no discrimina".
        if (cum["n"] and fal["n"] and cum["objetivo"] / cum["n"] < fal["objetivo"] / fal["n"]):
            det["senal"] = "INVERTIDO: acierta menos cuando el check se cumple"
        res[nombre] = {"veredicto": v, **det}
        veredictos.append(v)
    global_v = "MUESTRA INSUFICIENTE" if all(v == "MUESTRA INSUFICIENTE" for v in veredictos) or not veredictos else "MEJORA"
    return global_v, {"porCheck": res}


def juzgar_DIR_1(datos):
    """El veto del MACD: compara los trades donde el MACD acompañaba contra
    aquellos donde contradecia. Son los que el veto habria evitado."""
    d = datos.get("direccion") or {}
    g = d.get("grupos") or {}
    ac, en = g.get("DE_ACUERDO") or {}, g.get("EN_CONTRA") or {}
    if not ac.get("n") and not en.get("n"):
        return "SIN INSTRUMENTO", {"motivo": "la sombra de direccion no pudo emparejar ni un trade"}
    v, det = comparar("con el veto (MACD de acuerdo)", ac.get("ganadores", 0), ac.get("n", 0),
                      "hoy, sin veto (MACD en contra)", en.get("ganadores", 0), en.get("n", 0))
    det["efectoDelVeto"] = d.get("efectoDelVeto")
    det["emparejados"] = d.get("emparejados")
    det["descartados"] = d.get("descartados")
    # El instrumento es nuevo y su muestra arranca donde arranca el libro propio
    # (17-ago). Decirlo evita que un "insuficiente" se lea como "no hay señal".
    det["notaInstrumento"] = ("instrumento nuevo: solo entran trades con libro propio, "
                              "asi que la muestra arranca el 2026-08-17 y crece desde ahi")
    return v, det


JUECES = {"REV-3": juzgar_REV_3, "REV-4": juzgar_REV_4, "DIR-1": juzgar_DIR_1}


def evaluar(p, datos):
    if not p["instrumento"]:
        return {"veredicto": "SIN INSTRUMENTO",
                "detalle": {"motivo": "no existe una sombra que pueda contestar esta propuesta; "
                                      "construir el instrumento es prerequisito para juzgarla"}}
    j = JUECES.get(p["id"])
    if not j:
        return {"veredicto": "SIN INSTRUMENTO",
                "detalle": {"motivo": f"instrumento {p['instrumento']} declarado pero sin juez escrito"}}
    v, det = j(datos)
    return {"veredicto": v, "detalle": det}


def parte(fecha, filas, datos):
    L = [f"[AUDITOR] {fecha}"]
    rojos = [f for f in filas if f["veredicto"] == "EMPEORA"]
    L.append(f"ESTADO: {'ambar' if rojos else 'verde'}")
    L.append("VEREDICTOS:")
    for f in filas:
        L.append(f"  - {f['id']} ({f['familia']}, nivel {f['nivel']}) · {f['veredicto']}")
        L.append(f"      {f['titulo']}")
        m = (f["detalle"] or {}).get("motivo")
        if m:
            L.append(f"      {m}")
    # Un veredicto de MUESTRA INSUFICIENTE no es lo mismo que "no se ve nada". Los
    # numeros que apuntan a algun lado se muestran aparte, marcados como NO
    # concluyentes — sirven para que el Ingeniero de Datos sepa donde seguir
    # mirando, sin que nadie los confunda con una autorizacion.
    obs = []
    for f in filas:
        if f["veredicto"] != "MUESTRA INSUFICIENTE":
            continue
        d = f["detalle"] or {}
        for b in (d.get("bandas") or []):
            if b["n"] >= 20:
                marca = "  <- puerta actual" if b["puertaActual"] else ""
                obs.append(f"{f['id']}: banda {b['banda']}: n={b['n']} acierto {b['winRate']}%{marca}")
        for nom, c in (d.get("porCheck") or {}).items():
            if c.get("senal"):
                cum, fal = c.get("cumple", {}), c.get("falla", {})
                obs.append(f"{f['id']}: check {nom} {c['senal']} "
                           f"(cumple n={cum.get('n')} {cum.get('winRate')}% vs "
                           f"falla n={fal.get('n')} {fal.get('winRate')}%)")
    if obs:
        L.append("SENALES EN OBSERVACION (NO son veredicto, no autorizan nada):")
        for o in obs:
            L.append(f"  · {o}")

    ins = datos["reversion"]
    L.append(f"INSTRUMENTO: sombra de Reversion con {ins.get('evaluaciones')} evaluaciones "
             f"en {len(ins.get('dias') or [])} dias · libro sombra con "
             f"{datos['libro'].get('cerradas')} cierres en dolares")
    L.append("PENDIENTE DE DECISION:")
    accionables = [f for f in filas if f["veredicto"] in ("MEJORA", "EMPEORA")]
    if not accionables:
        L.append("  - ninguna: ninguna propuesta alcanzo muestra para concluir")
    else:
        for f in accionables:
            L.append(f"  - {f['id']}: la sombra dice {f['veredicto']}. ¿Se aplica esta ventana? (si/no)")
        if len({f["familia"] for f in accionables}) < len(accionables):
            L.append("  - OJO: hay mas de una propuesta ALTO sobre la misma familia. "
                     "Si se aplican juntas no se puede saber cual funciono.")
    L.append("EL AUDITOR NO PROPONE: estos veredictos juzgan propuestas ajenas.")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", help="juzgar solo esta propuesta")
    ap.add_argument("--json", action="store_true", help="solo el JSON")
    a = ap.parse_args()

    datos = {
        "reversion": _get_json(f"{PROD}/api/spx/reversion-sombra"),
        "libro":     _get_json(f"{PROD}/api/spx/sombra-libro"),
        "salidas":   _get_json(f"{PROD}/api/spx/salidas-alternativas"),
        "cadenas":   _get_json(f"{PROD}/api/spx/sombra-cadenas"),
    }
    # La sombra de direccion la calcula un script propio (no hay endpoint): se
    # lee del archivo que deja, y si no esta se dice en vez de fallar callado.
    _sd = os.path.join(SALIDA, "sombra_direccion.json")
    if os.path.exists(_sd):
        with open(_sd, encoding="utf-8") as fh:
            datos["direccion"] = json.load(fh)
    else:
        datos["direccion"] = {}

    props = [p for p in PROPUESTAS if not a.id or p["id"] == a.id]
    filas = [{**p, **evaluar(p, datos)} for p in props]

    fecha = (datetime.now(timezone.utc) - timedelta(hours=4)).strftime("%Y-%m-%d")
    os.makedirs(SALIDA, exist_ok=True)
    doc = {"fecha": fecha, "muestraMinima": MUESTRA_MINIMA, "veredictos": filas,
           "instrumento": {
               "reversionEvaluaciones": datos["reversion"].get("evaluaciones"),
               "reversionDias": len(datos["reversion"].get("dias") or []),
               "libroCerradas": datos["libro"].get("cerradas"),
               "salidasTrades": datos["salidas"].get("trades"),
               "retrasoMedianoPts": (datos["cadenas"].get("resumen") or {}).get("retrasoMedianoPts"),
           },
           "generado": datetime.now().isoformat(timespec="seconds")}
    with open(os.path.join(SALIDA, f"{fecha}.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)

    if a.json:
        print(json.dumps(doc, ensure_ascii=False, indent=1))
        return 0

    txt = parte(fecha, filas, datos)
    with open(os.path.join(SALIDA, f"parte_{fecha}.txt"), "w", encoding="utf-8") as fh:
        fh.write(txt + "\n")
    print(txt)
    return 0


if __name__ == "__main__":
    sys.exit(main())
