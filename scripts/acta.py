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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fecha")
    a = ap.parse_args()
    fecha = a.fecha or (datetime.now(timezone.utc) - timedelta(hours=4)).strftime("%Y-%m-%d")

    partes, faltan = {}, []
    for nombre, carpeta, patron, obligatorio in PUESTOS:
        t = leer_torre(fecha) if nombre == "TORRE" else leer_parte(carpeta, patron, fecha)
        partes[nombre] = t
        if t is None and obligatorio:
            faltan.append(nombre)

    estados = {n: estado_de(t) for n, t in partes.items()}
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

    L.append("DECISIONES PENDIENTES  (se contestan si o no)")
    if decisiones:
        for i, d in enumerate(decisiones, 1):
            L.append(f"  {i}. {d}")
    else:
        L.append("  ninguna")
    L.append("")

    L.append("PARTES COMPLETOS")
    L.append("")
    for n, _, _, _ in PUESTOS:
        t = partes[n]
        L.append("-" * 72)
        L.append(t if t else f"[{n}] sin parte para {fecha}")
        L.append("")

    txt = "\n".join(L)
    os.makedirs(SALIDA, exist_ok=True)
    with open(os.path.join(SALIDA, f"acta_{fecha}.txt"), "w", encoding="utf-8") as fh:
        fh.write(txt + "\n")
    with open(os.path.join(SALIDA, f"acta_{fecha}.json"), "w", encoding="utf-8") as fh:
        json.dump({"fecha": fecha, "estado": peor, "estados": estados,
                   "decisiones": decisiones, "sinParte": faltan}, fh,
                  ensure_ascii=False, indent=1)
    print(txt)
    return 0


if __name__ == "__main__":
    sys.exit(main())
