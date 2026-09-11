# -*- coding: utf-8 -*-
"""
Acta de la reunion diaria — el motor del Secretario.

Junta los partes de los cinco puestos en un solo documento y deja las decisiones
como preguntas de si o no. Guillermo tiene que poder contestar el acta
LEYENDOLA, no estudiandola.

  python scripts/acta.py
  python scripts/acta.py --fecha 2026-08-21

Lee lo que cada motor ya dejo escrito. NO recalcula nada: si el acta y el parte
de un puesto dijeran numeros distintos, el que esta mal es el acta.

  cierres/parte_<fecha>.txt      [CONTADOR]
  datos/parte_<fecha>.txt        [DATOS]
  vigilancia/ultimo.json         [TORRE]
  veredictos/parte_<fecha>.txt   [AUDITOR]   (solo viernes)
  deriva/parte_<fecha>.txt       [SECRETARIO]

Un puesto que no dejo parte NO se omite en silencio: se dice que falto. La
diferencia entre "no pasó nada" y "no corrio" es justo la que hay que ver.

Ademas arrastra las decisiones que siguen abiertas de dias anteriores:

  SUGERENCIAS.md  ## Decisiones pendientes    (los items no tachados)
  deriva/parte_semanal_<ultimo>.txt           PENDIENTE DE DECISION
  datos/parte_semanal_<ultimo>.txt            PENDIENTE DE DECISION
"""
import argparse, json, os, re, sys
from datetime import datetime, timedelta, timezone

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(REPO, "actas")

PUESTOS = [
    ("CONTADOR",   "cierres",    "parte_{f}.txt", True),
    ("DATOS",      "datos",      "parte_{f}.txt", True),
    ("TORRE",      "vigilancia", None,            False),   # deja JSON, no parte
    ("AUDITOR",    "veredictos", "parte_{f}.txt", False),   # solo viernes
    ("SECRETARIO", "deriva",     "parte_{f}.txt", True),
]

ORDEN_ESTADO = {"rojo": 0, "ambar": 1, "verde": 2, "(sin parte)": 3}


def leer_parte(carpeta, patron, fecha):
    if not patron:
        return None
    p = os.path.join(REPO, carpeta, patron.format(f=fecha))
    if not os.path.exists(p):
        return None
    return open(p, encoding="utf-8").read().rstrip()


def leer_torre(fecha):
    p = os.path.join(REPO, "vigilancia", "ultimo.json")
    if not os.path.exists(p):
        return None
    try:
        d = json.load(open(p, encoding="utf-8"))
    except Exception:      # noqa: BLE001
        return None
    if not (d.get("ts") or "").startswith(fecha):
        return None       # el ultimo chequeo no es de hoy: no sirve para esta acta
    L = [f"[TORRE] {d['ts']}", f"ESTADO: {d.get('estado')}"]
    for x in d.get("rojo") or []:
        L.append(f"  ROJO: {x}")
    for x in d.get("ambar") or []:
        L.append(f"  AMBAR: {x}")
    if not (d.get("rojo") or d.get("ambar")):
        L.append("  sin incidentes")
    return "\n".join(L)


def estado_de(texto):
    if not texto:
        return "(sin parte)"
    m = re.search(r"^ESTADO:\s*(\w+)", texto, re.M)
    return (m.group(1).lower() if m else "?")


def decisiones_de(texto):
    """Saca las lineas de PENDIENTE DE DECISION. Solo las preguntas: si el acta
    arrastra la narrativa de cada puesto deja de ser contestable de un vistazo."""
    if not texto:
        return []
    m = re.search(r"^PENDIENTE DE DECISI[OÓ]N:\s*$(.*?)(?=^\S|\Z)", texto, re.M | re.S)
    if not m:
        return []
    out = []
    for l in m.group(1).splitlines():
        l = l.strip(" -·\t")
        if not l or l.lower().startswith("ninguna"):
            continue
        # Una decision es algo que se pueda contestar si o no. Si la linea no
        # pregunta nada, es narrativa del puesto y no entra: el acta se llenaria
        # de marcadores de posicion y dejaria de ser contestable de un vistazo.
        if "?" not in l and "(si/no)" not in l:
            continue
        out.append(l)
    return out


# ── Decisiones abiertas que se arrastran de dias anteriores ─────────────────
#
# Por que existe: el acta solo miraba los partes DEL DIA, y una pregunta que
# ningun puesto repetia ese dia desaparecia del acta aunque nadie la hubiera
# contestado. Caso: las 4 preguntas de deriva del minScore 72 se levantaron el
# 29-ago y el acta de cada dia siguiente decia "DECISIONES PENDIENTES: ninguna"
# mientras llevaban 12 dias sin respuesta (repaso semanal del 05-sep). Un
# "ninguna" que no es cierto es peor que una lista larga: se deja de preguntar.

MESES = {"ene": 1, "feb": 2, "mar": 3, "abr": 4, "may": 5, "jun": 6, "jul": 7,
         "ago": 8, "sep": 9, "oct": 10, "nov": 11, "dic": 12}


def _fecha_de_item(texto, anio):
    """La fecha en que se abrio la pregunta, si el texto la dice. Primero las
    marcas explicitas del backlog ("nuevo, 2026-09-03" / "anotado 2026-08-24"),
    despues "desde el 27-ago" de los partes, y si no, None."""
    m = re.search(r"(?:nuevo|anotado|abierta desde)[,:]?\s*(?:el\s*)?(\d{4}-\d{2}-\d{2})", texto, re.I)
    if m:
        return m.group(1)
    m = re.search(r"desde el (\d{1,2})-(" + "|".join(MESES) + r")", texto, re.I)
    if m:
        return f"{anio}-{MESES[m.group(2).lower()]:02d}-{int(m.group(1)):02d}"
    return None


def _dias(desde, hasta):
    try:
        return (datetime.strptime(hasta, "%Y-%m-%d") - datetime.strptime(desde, "%Y-%m-%d")).days
    except (TypeError, ValueError):
        return None


def abiertas_del_backlog():
    """Items NO tachados de `## Decisiones pendientes` de SUGERENCIAS.md. Uno
    tachado (empieza con ~~) esta cerrado y no se arrastra."""
    p = os.path.join(REPO, "SUGERENCIAS.md")
    try:
        s = open(p, encoding="utf-8").read()
    except OSError:
        return []
    m = re.search(r"^## Decisiones pendientes[^\n]*\n(.*?)(?=^## |\Z)", s, re.M | re.S)
    if not m:
        return []
    items = re.split(r"^- ", m.group(1), flags=re.M)[1:]
    out = []
    for it in items:
        if it.lstrip().startswith("~~"):
            continue
        t = re.search(r"\*\*(.+?)\*\*", it, re.S)
        titulo = re.sub(r"\s+", " ", (t.group(1) if t else it.split("\n")[0])).strip()
        f = _fecha_de_item(it, "2026")
        if not f:
            fs = re.findall(r"\d{4}-\d{2}-\d{2}", it)
            f = fs[0] if fs else None
        out.append({"fuente": "SUGERENCIAS.md", "texto": titulo[:160], "desde": f})
    return out


def _preguntas_de(texto):
    """Items numerados o con guion de un bloque PENDIENTE DE DECISION, juntando
    las lineas de continuacion. Los partes semanales los escribe el agente, a
    veces en varias lineas y con el encabezado adornado."""
    m = re.search(r"^PENDIENTE DE DECISI[OÓ]N[^\n]*\n(.*?)(?=^\S|\Z)", texto, re.M | re.S)
    if not m:
        return []
    items, actual = [], None
    for l in m.group(1).splitlines():
        if re.match(r"^\s*(\d+[.)]|-)\s+", l):
            if actual:
                items.append(actual)
            actual = re.sub(r"^\s*(\d+[.)]|-)\s+", "", l).strip()
        elif l.strip() and actual is not None:
            actual += " " + l.strip()
    if actual:
        items.append(actual)
    return [i for i in items if not i.lower().startswith(("ninguna", "las que abra"))]


def _deriva_ya_resuelta(desde_parte, fecha):
    """Las preguntas del repaso de deriva son todas de la forma "¿manda
    produccion y se corrige el canario/manual?". Si una corrida diaria de deriva
    POSTERIOR al repaso ya da las tres fuentes iguales, las preguntas quedaron
    contestadas por el hecho: arrastrarlas seria pedir que se responda algo que
    ya se aplico. Caso: 2026-09-10, se sincronizaron manual y canario con el 72
    y el repaso del 05-sep seguia preguntandolo."""
    for f in sorted(os.listdir(os.path.join(REPO, "deriva")), reverse=True):
        mm = re.match(r"^(\d{4}-\d{2}-\d{2})\.json$", f)
        if not mm or mm.group(1) > fecha:
            continue
        if mm.group(1) <= desde_parte:
            return None
        try:
            d = json.load(open(os.path.join(REPO, "deriva", f), encoding="utf-8"))
        except Exception:      # noqa: BLE001
            return None
        limpio = not d.get("otras") and not any(
            x.get("deriva") or x.get("manualDifiere") for x in d.get("parametros") or [])
        return mm.group(1) if limpio else None
    return None


def abiertas_de_semanales(fecha):
    out = []
    for carpeta, puesto in (("deriva", "SECRETARIO"), ("datos", "DATOS")):
        d = os.path.join(REPO, carpeta)
        if not os.path.isdir(d):
            continue
        sem = sorted(f for f in os.listdir(d)
                     if re.match(r"^parte_semanal_\d{4}-\d{2}-\d{2}\.txt$", f)
                     and f[14:24] <= fecha)
        if not sem:
            continue
        f_parte = sem[-1][14:24]
        if carpeta == "deriva":
            resuelta = _deriva_ya_resuelta(f_parte, fecha)
            if resuelta:
                out.append({"fuente": f"{carpeta}/{sem[-1]}", "resueltaPor": resuelta})
                continue
        for q in _preguntas_de(open(os.path.join(d, sem[-1]), encoding="utf-8").read()):
            out.append({"fuente": f"{carpeta}/{sem[-1]}", "puesto": puesto,
                        "texto": q[:200], "desde": _fecha_de_item(q, f_parte[:4]) or f_parte})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fecha")
    a = ap.parse_args()
    fecha = a.fecha or (datetime.now(timezone.utc) - timedelta(hours=4)).strftime("%Y-%m-%d")
    # El Auditor corre SOLO los viernes. Los otros dias su "sin parte" no es una
    # anomalia y no se marca con "?": una alarma que suena cuatro dias de cinco
    # por algo esperado entrena a no mirarla.
    es_viernes = datetime.strptime(fecha, "%Y-%m-%d").weekday() == 4

    partes, faltan = {}, []
    for nombre, carpeta, patron, obligatorio in PUESTOS:
        t = leer_torre(fecha) if nombre == "TORRE" else leer_parte(carpeta, patron, fecha)
        partes[nombre] = t
        if nombre == "AUDITOR":
            obligatorio = es_viernes
        if t is None and obligatorio:
            faltan.append(nombre)

    estados = {n: estado_de(t) for n, t in partes.items()}
    if partes.get("AUDITOR") is None and not es_viernes:
        estados["AUDITOR"] = "(corre los viernes)"
    peor = min((e for e in estados.values() if e in ORDEN_ESTADO),
               key=lambda e: ORDEN_ESTADO[e], default="verde")

    decisiones = []
    for n, t in partes.items():
        for d in decisiones_de(t):
            decisiones.append(f"[{n}] {d}")

    L = ["=" * 72,
         f" ACTA DE LA REUNION — {fecha}",
         f" Estado del dia: {peor.upper()}",
         "=" * 72, ""]

    L.append("RESUMEN POR PUESTO")
    for n, _, _, _ in PUESTOS:
        e = estados[n]
        marca = {"rojo": "!!", "ambar": " !", "verde": "  ", "(sin parte)": " ?"}.get(e, "  ")
        L.append(f"  {marca} {n:<11} {e}")
    if faltan:
        L.append("")
        L.append("  OJO: no dejaron parte hoy: " + ", ".join(faltan))
        L.append("  Un puesto sin parte no es un puesto sin novedades: puede ser una corrida que fallo.")
    L.append("")

    arrastradas = abiertas_del_backlog() + abiertas_de_semanales(fecha)
    abiertas = [x for x in arrastradas if not x.get("resueltaPor")]

    L.append("DECISIONES PENDIENTES  (se contestan si o no)")
    if decisiones:
        for i, d in enumerate(decisiones, 1):
            L.append(f"  {i}. {d}")
    elif abiertas:
        L.append(f"  ninguna NUEVA hoy — pero hay {len(abiertas)} abiertas de dias anteriores (abajo)")
    else:
        L.append("  ninguna")
    L.append("")

    L.append("DECISIONES ABIERTAS (arrastradas)")
    if not abiertas:
        L.append("  ninguna")
    for i, x in enumerate(sorted(abiertas, key=lambda x: x.get("desde") or "9999"), 1):
        dd = _dias(x.get("desde"), fecha)
        edad = f"{dd} dias" if dd is not None else "sin fecha"
        L.append(f"  {i}. [{edad}, desde {x.get('desde') or '?'}] {x['texto']}")
        L.append(f"       ({x['fuente']})")
    for x in arrastradas:
        if x.get("resueltaPor"):
            L.append(f"  (las preguntas de {x['fuente']} ya no se arrastran: la deriva del "
                     f"{x['resueltaPor']} da produccion, canario y manual iguales)")
    L.append("")

    L.append("PARTES COMPLETOS")
    L.append("")
    for n, _, _, _ in PUESTOS:
        t = partes[n]
        L.append("-" * 72)
        if not t and n == "AUDITOR" and not es_viernes:
            t = f"[{n}] corre los viernes: hoy no le toca"
        L.append(t if t else f"[{n}] sin parte para {fecha}")
        L.append("")

    txt = "\n".join(L)
    os.makedirs(SALIDA, exist_ok=True)
    with open(os.path.join(SALIDA, f"acta_{fecha}.txt"), "w", encoding="utf-8") as fh:
        fh.write(txt + "\n")
    with open(os.path.join(SALIDA, f"acta_{fecha}.json"), "w", encoding="utf-8") as fh:
        json.dump({"fecha": fecha, "estado": peor, "estados": estados,
                   "decisiones": decisiones, "decisionesArrastradas": arrastradas,
                   "sinParte": faltan}, fh,
                  ensure_ascii=False, indent=1)
    print(txt)
    return 0


if __name__ == "__main__":
    sys.exit(main())
