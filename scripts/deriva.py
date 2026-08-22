# -*- coding: utf-8 -*-
"""
Deriva — el motor del Secretario para la parte que mas duele.

Compara TRES fuentes que deberian decir lo mismo y casi nunca lo dicen:

  1. PRODUCCION   lo que el robot esta corriendo de verdad (/api/spx/config)
  2. EL CANARIO   lo que el chequeo de las 07:00 espera encontrar
  3. EL MANUAL    lo que CLAUDE.md dice que hay

Por que existe: el 2026-08-21 las tres discrepaban sobre la banda de alejamiento
de Reversion —manual 0.10-0.35, canario 0.13-0.30, produccion 0.10-0.30— y
ademas el endpoint de la sombra tenia 0.13 HARDCODEADO. O sea que el instrumento
con el que el Auditor decidia si mover esa banda estaba midiendo contra una
puerta que hacia rato no era la vigente.

Una perilla que se mueve sin quedar anotada no es un descuido administrativo:
hace que todo lo que se midio despues sea sobre otra cosa.

  python scripts/deriva.py
  python scripts/deriva.py --json

Escribe en deriva/<fecha>.json y deriva/parte_<fecha>.txt.

QUE NO HACE: no corrige nada. El Secretario registra y levanta la mano; decidir
cual de las tres fuentes tiene razon es de quien autoriza.
"""
import argparse, json, os, re, sys
from datetime import datetime, timedelta, timezone

PROD = "https://web-production-23473.up.railway.app"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(REPO, "deriva")
MENTORIA = (r"C:\Users\gcarv\Documents\CARPETA PERSONAL\01. guillermo carvajal"
            r"\01_Sigma\mentoria alejandro")
CANARIO = os.path.join(MENTORIA, "estrategias automatizadas", "chequeo_salud_estrategias.py")
MANUAL = os.path.join(REPO, "CLAUDE.md")


def _get_json(url, timeout=60, reintentos=3):
    from urllib.request import urlopen
    ultimo = None
    for _ in range(reintentos):
        try:
            with urlopen(url, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:      # noqa: BLE001
            ultimo = e
    raise RuntimeError(str(ultimo))


def leer_canario():
    """Saca ESPERADO_REVERSION del script del chequeo sin importarlo: importarlo
    ejecutaria sus llamadas a produccion."""
    try:
        s = open(CANARIO, encoding="utf-8").read()
    except OSError:
        return {}, "no se pudo leer el canario"
    m = re.search(r"ESPERADO_REVERSION\s*=\s*\{(.*?)\n\}", s, re.S)
    if not m:
        return {}, "no se encontro ESPERADO_REVERSION"
    out = {}
    for k, v in re.findall(r'"([A-Za-z_]+)"\s*:\s*([^,\n#]+)', m.group(1)):
        v = v.strip()
        if v in ("True", "False"):
            out[k] = (v == "True")
        else:
            try:
                out[k] = float(v) if "." in v else int(v)
            except ValueError:
                out[k] = v.strip('"\'')
    return out, None


def leer_manual():
    """Busca en CLAUDE.md los valores que el manual afirma. Es una lectura por
    patron, no un parser: si no encuentra algo lo dice, no lo inventa."""
    try:
        s = open(MANUAL, encoding="utf-8").read()
    except OSError:
        return {}, "no se pudo leer el manual"
    out = {}
    # Banda de alejamiento: "0.10%-0.35%", "0.13% a 0.3%", "0.13–0.30"
    for m in re.finditer(r"(\d\.\d{1,2})\s*%?\s*[-–—aA]\s*(\d\.\d{1,2})\s*%", s):
        lo, hi = float(m.group(1)), float(m.group(2))
        if 0.0 < lo < 1.0 and lo < hi < 1.0:
            out.setdefault("extBandMinPct", lo)
            out.setdefault("extBandMaxPct", hi)
            break
    return out, None


# Parametros que de verdad cambian decisiones. Solo estos se vigilan: llenar el
# parte con diferencias que no mueven un trade es la forma mas rapida de que se
# deje de leer.
VIGILADOS = ["extBandMinPct", "extBandMaxPct", "minScore", "earlyExitPct",
             "requiereGammaPositivo", "maxStopsPerDay", "maxDailyDrawdownPct",
             "riskPctPerTrade", "stopMinPts", "alejamientoEsPuerta", "puertasBinarias"]


def comparar(prod, canario, manual):
    filas = []
    for k in VIGILADOS:
        p, c, m = prod.get(k, "—"), canario.get(k, "—"), manual.get(k, "—")
        # La DERIVA la decide produccion contra el canario: las dos son fuentes
        # legibles por maquina y sin ambiguedad. El manual se lee con un regex
        # sobre prosa —no es un parser— y se muestra solo como referencia: si
        # dejara que una lectura aproximada disparara una alerta, el parte se
        # llenaria de falsos positivos y se dejaria de leer. Ya paso en la
        # primera corrida: el regex pesco "0.1-0.2" de una frase sobre la meseta
        # optima y lo reporto como si el manual dijera que la banda maxima es
        # 0.2.
        distintos = (c != "—") and (repr(p) != repr(c))
        manual_difiere = (m != "—") and (repr(m) != repr(p))
        filas.append({"parametro": k, "produccion": p, "canario": c,
                      "manualAprox": m, "deriva": distintos,
                      "manualDifiere": manual_difiere})
    return filas


def parte(fecha, filas, extra):
    derivados = [f for f in filas if f["deriva"]]
    L = [f"[SECRETARIO] {fecha}",
         f"ESTADO: {'ambar' if derivados or extra else 'verde'}"]
    L.append("DERIVA DETECTADA:")
    if not derivados:
        L.append("  - ninguna: produccion, canario y manual coinciden en los "
                 f"{len(filas)} parametros que cambian decisiones")
    for f in derivados:
        L.append(f"  - {f['parametro']}: produccion {f['produccion']!r} · "
                 f"canario {f['canario']!r}")
    revisar_manual = [f for f in filas if f.get("manualDifiere") and not f["deriva"]]
    if revisar_manual:
        L.append("REVISAR EN EL MANUAL (lectura aproximada, puede ser falso positivo):")
        for f in revisar_manual:
            L.append(f"  - {f['parametro']}: produccion {f['produccion']!r}, "
                     f"el manual parece decir {f['manualAprox']!r}")
    if extra:
        L.append("OTRAS INCONSISTENCIAS:")
        for e in extra:
            L.append(f"  - {e}")
    L.append("PENDIENTE DE DECISION:")
    if derivados:
        for f in derivados:
            L.append(f"  - {f['parametro']}: ¿manda produccion y se actualizan "
                     "canario y manual? (si/no)")
    else:
        L.append("  - ninguna")
    L.append("EL SECRETARIO NO CORRIGE: registra y levanta la mano.")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    cfg = _get_json(f"{PROD}/api/spx/config")
    c = cfg.get("config") or cfg
    prod = (c.get("trading") or {}).get("smaReversion") or {}
    canario, err_c = leer_canario()
    manual, err_m = leer_manual()

    filas = comparar(prod, canario, manual)
    extra = [e for e in (err_c, err_m) if e]

    # Un caso que ya mordio: un valor de puerta escrito a mano en el codigo, que
    # no se entera cuando alguien mueve la configuracion.
    try:
        srv = open(os.path.join(REPO, "server.js"), encoding="utf-8").read()
        if re.search(r"dentroDeLaPuertaActual:\s*lo\s*>=\s*0\.\d", srv):
            extra.append("server.js tiene la puerta de alejamiento HARDCODEADA en la sombra: "
                         "el instrumento del Auditor no se entera si se mueve la configuracion")
    except OSError:
        pass

    fecha = (datetime.now(timezone.utc) - timedelta(hours=4)).strftime("%Y-%m-%d")
    os.makedirs(SALIDA, exist_ok=True)
    doc = {"fecha": fecha, "parametros": filas, "otras": extra,
           "generado": datetime.now().isoformat(timespec="seconds")}
    with open(os.path.join(SALIDA, f"{fecha}.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)

    if a.json:
        print(json.dumps(doc, ensure_ascii=False, indent=1))
        return 0
    txt = parte(fecha, filas, extra)
    with open(os.path.join(SALIDA, f"parte_{fecha}.txt"), "w", encoding="utf-8") as fh:
        fh.write(txt + "\n")
    print(txt)
    return 0


if __name__ == "__main__":
    sys.exit(main())
