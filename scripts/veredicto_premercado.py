# -*- coding: utf-8 -*-
"""
Veredicto del Auditor sobre el PREMERCADO SPX — el segundo dominio del puesto.

Por que existe: hasta hoy el premercado se calificaba a si mismo. El Paso 6.2 del
skill premercado-spx escribe resultado.acierto (si/parcial/no) en el mismo log
que produjo la prediccion, o sea que quien propone es quien se pone la nota. Es
exactamente lo que la regla de riesgo de modelo existe para impedir, y es la
misma razon por la que este puesto existe del lado de la Bitacora Tasty.

Este script NO lee acierto para dictaminar. Recalcula el resultado desde los
hechos crudos —las probabilidades asignadas y el escenario que se valido— y
ademas mide cuanto se aparta la nota propia de los hechos. Esa distancia es el
dato que nadie estaba mirando.

  python scripts/veredicto_premercado.py            # parte completo
  python scripts/veredicto_premercado.py --json     # solo el JSON
  python scripts/veredicto_premercado.py --log RUTA # otro log

Escribe en veredictos/:
  premercado_<fecha>.json        el detalle con los numeros
  parte_premercado_<fecha>.txt   el parte [AUDITOR], listo para el acta

Mismos tres veredictos que el motor de sombra, y por la misma razon:

  MEJORA               con el numero y la muestra
  EMPEORA              con el numero y la muestra
  MUESTRA INSUFICIENTE y aqui se detiene

EL AUDITOR NO PROPONE. Si de estos numeros sale una idea para mejorar el
premercado, va como observacion para el Ingeniero de Datos. Nunca como
recomendacion de este script.
"""
import argparse, json, os, sys
from datetime import datetime, timedelta, timezone
from math import sqrt

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(REPO, "veredictos")

LOG_DEFECTO = os.path.join(
    os.path.expanduser("~"), "Documents", "CARPETA PERSONAL",
    "01. guillermo carvajal", "01_Sigma", "mentoria alejandro",
    "premercados alejandro", "control premercado",
    "premercado_hipotesis_log.json")

# Misma muestra minima que el motor de sombra, y por la misma aritmetica: con
# menos de 30 observaciones la diferencia entre 40% y 60% de acierto no se
# distingue del azar. Aqui una observacion es UN DIA de mercado, asi que 30 son
# unas seis semanas. Bajar el corte porque "el premercado produce poco dato"
# seria fabricar significancia, que es el error que este puesto no puede cometer.
MUESTRA_MINIMA = 30

ESCENARIOS = ("alcista", "neutral", "bajista")
AZAR = 1 / 3             # tres escenarios equiprobables
BRIER_UNIFORME = 2 / 3   # Brier de repartir 33/33/33 todos los dias


def wilson(exitos, n, z=1.96):
    """Intervalo de Wilson al 95%. El mismo que usa veredicto_sombra.py: con n
    chico el normal simple da intervalos que se salen de [0,1] y hacen parecer
    significativo lo que no lo es."""
    if not n:
        return (0.0, 1.0)
    p = exitos / n
    d = 1 + z * z / n
    centro = (p + z * z / (2 * n)) / d
    margen = z * sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, centro - margen), min(1.0, centro + margen))


def contra_referencia(nombre, exitos, n, referencia):
    """Compara una tasa observada contra un valor fijo (el azar, por ejemplo).

    Regla: sin muestra minima NO hay veredicto, por muy tentador que sea el
    numero. Y con muestra, solo concluye si la referencia queda FUERA del
    intervalo de confianza — si cae dentro, lo observado no se distingue de la
    referencia aunque el punto central apunte a algun lado."""
    lo, hi = wilson(exitos, n)
    tasa = exitos / n if n else None
    det = {"medida": nombre, "n": n, "exitos": exitos,
           "tasa": round(tasa * 100, 1) if tasa is not None else None,
           "ic95": [round(lo * 100, 1), round(hi * 100, 1)],
           "referencia": round(referencia * 100, 1)}
    if n < MUESTRA_MINIMA:
        det["motivo"] = (f"n={n}/{MUESTRA_MINIMA} · observado {det['tasa']}% "
                         f"vs referencia {det['referencia']}% — no concluye")
        return "MUESTRA INSUFICIENTE", det
    if lo > referencia:
        det["motivo"] = (f"n={n} · {det['tasa']}% (IC95 {det['ic95'][0]}-{det['ic95'][1]}) "
                         f"por encima de {det['referencia']}%")
        return "MEJORA", det
    if hi < referencia:
        det["motivo"] = (f"n={n} · {det['tasa']}% (IC95 {det['ic95'][0]}-{det['ic95'][1]}) "
                         f"por debajo de {det['referencia']}%")
        return "EMPEORA", det
    det["motivo"] = (f"n={n} · {det['tasa']}% (IC95 {det['ic95'][0]}-{det['ic95'][1]}) "
                     f"contiene a {det['referencia']}% — no se distingue")
    return "MUESTRA INSUFICIENTE", det


def normalizar(bruto):
    """El campo escenario_validado es texto libre, no vocabulario controlado. Hay
    entradas como 'alcista_parcial' o 'neutral (tras recorrido violento en ambas
    direcciones intradia)'. Se normaliza por prefijo y se DECLARA cuantas hicieron
    falta: un instrumento que hay que interpretar para poder leerlo es un
    instrumento en duda, y eso va en el parte."""
    if not bruto:
        return None, False
    t = str(bruto).strip().lower()
    for e in ESCENARIOS:
        if t == e:
            return e, False
        if t.startswith(e):
            return e, True
    return None, True


def cargar(ruta):
    if not os.path.exists(ruta):
        raise SystemExit(f"no existe el log del premercado: {ruta}")
    with open(ruta, encoding="utf-8") as fh:
        crudo = json.load(fh)
    filas = []
    for x in crudo:
        p = x.get("probabilidades") or {}
        r = x.get("resultado") or {}
        val, interpretado = normalizar(r.get("escenario_validado"))
        probs = {e: p.get(e) for e in ESCENARIOS}
        completo = all(isinstance(probs[e], (int, float)) for e in ESCENARIOS)
        fav, empate = None, False
        if completo:
            top = max(probs.values())
            ganadores = [e for e in ESCENARIOS if probs[e] == top]
            fav = ganadores[0] if len(ganadores) == 1 else None
            empate = len(ganadores) > 1
        filas.append({
            "fecha": x.get("fecha"),
            "probabilidades": probs if completo else None,
            "favorito": fav,
            "empate": empate,
            "validadoBruto": r.get("escenario_validado"),
            "validado": val,
            "interpretado": interpretado,
            # Tres estados que NO son lo mismo, y confundirlos esconde el unico
            # fallo que importa aqui:
            #   ok              se pudo leer (con o sin interpretar el prefijo)
            #   pendiente       todavia no se ha escrito el resultado
            #   noInterpretable hay texto pero no arranca por ningun escenario:
            #                   ese dia se cae de la muestra EN SILENCIO
            "estado": ("ok" if val else
                       ("pendiente" if not r.get("escenario_validado")
                        else "noInterpretable")),
            "autoNota": r.get("acierto"),
        })
    return filas


def brier(probs, validado):
    """Brier multiclase de un dia: suma de (probabilidad - resultado)^2 sobre los
    tres escenarios. Mas bajo es mejor. Repartir 33/33/33 todos los dias da 0.667,
    y esa es la vara: un premercado que no baje de ahi no esta aportando nada que
    no aporte tirar una moneda de tres caras."""
    s = 0.0
    for e in ESCENARIOS:
        p = (probs[e] or 0) / 100.0
        o = 1.0 if e == validado else 0.0
        s += (p - o) ** 2
    return s


def nota_por_rango(probs, validado):
    """La misma vara que el Paso 6.2 del skill premercado-spx, aplicada desde
    fuera: si el escenario validado fue el de mayor probabilidad -> "si"; el del
    medio -> "parcial"; el menos probable -> "no". Los empates se resuelven a
    favor del premercado (el rango mas alto de los empatados), para que ninguna
    diferencia que salga sea un artefacto del desempate."""
    p_val = probs[validado] or 0
    mejores = sum(1 for e in ESCENARIOS if (probs[e] or 0) > p_val)
    return ("si", "parcial", "no")[mejores] if mejores < 3 else "no"


def evaluar(filas):
    juzgables = [f for f in filas
                 if f["validado"] and f["probabilidades"] and not f["empate"]]
    canonicas = [f for f in juzgables if not f["interpretado"]]

    # --- PRE-1: el favorito, contra el azar ---
    ok_fav = sum(1 for f in juzgables if f["favorito"] == f["validado"])
    v1, d1 = contra_referencia("acierto del favorito", ok_fav, len(juzgables), AZAR)

    # --- PRE-2: calibracion, via Brier contra el uniforme ---
    briers = [brier(f["probabilidades"], f["validado"]) for f in juzgables]
    b_medio = sum(briers) / len(briers) if briers else None
    mejores = sum(1 for b in briers if b < BRIER_UNIFORME)
    v2, d2 = contra_referencia("dias que le ganan al 33/33/33", mejores, len(briers), 0.5)
    d2["brierMedio"] = round(b_medio, 4) if b_medio is not None else None
    d2["brierUniforme"] = round(BRIER_UNIFORME, 4)

    # --- PRE-3: sesgo direccional, asignado vs validado ---
    asignado = {e: sum(1 for f in juzgables if f["favorito"] == e) for e in ESCENARIOS}
    validado = {e: sum(1 for f in juzgables if f["validado"] == e) for e in ESCENARIOS}
    sesgo = [{"escenario": e, "vecesFavorito": asignado[e], "vecesValidado": validado[e],
              "brecha": asignado[e] - validado[e]} for e in ESCENARIOS]

    # --- PRE-4: la nota propia contra los hechos ---
    # El skill define `acierto` por RANGO, no en binario (Paso 6.2): "si" si se
    # valido el escenario de mayor probabilidad, "parcial" si se valido uno que no
    # era el favorito pero tampoco estaba muy castigado, "no" si se valido el menos
    # probable. Asi que la nota se recalcula con esa misma vara y se compara contra
    # la que el premercado se puso. Tratarlo como binario acusaria de generosidad
    # lo que en realidad es la definicion escrita — un error de este puesto seria
    # peor que el sesgo que busca.
    generosas, severas, concuerdan = [], [], 0
    for f in juzgables:
        if f["autoNota"] is None:
            continue
        f["notaCalculada"] = nota_por_rango(f["probabilidades"], f["validado"])
        orden = {"si": 3, "parcial": 2, "no": 1}
        propia = orden.get(f["autoNota"])
        calc = orden.get(f["notaCalculada"])
        if propia is None or calc is None:
            continue
        if propia == calc:
            concuerdan += 1
        elif propia > calc:
            generosas.append(f"{f['fecha']} ({f['autoNota']} vs {f['notaCalculada']})")
        else:
            severas.append(f"{f['fecha']} ({f['autoNota']} vs {f['notaCalculada']})")
    con_nota = concuerdan + len(generosas) + len(severas)

    return {
        "veredictos": [
            {"id": "PRE-1", "familia": "PREMERCADO", "nivel": "alto",
             "titulo": "El escenario favorito del premercado, contra el azar (33.3%)",
             "veredicto": v1, "detalle": d1},
            {"id": "PRE-2", "familia": "PREMERCADO", "nivel": "alto",
             "titulo": "Calibracion de las probabilidades (Brier vs repartir 33/33/33)",
             "veredicto": v2, "detalle": d2},
        ],
        "sesgo": sesgo,
        "autonota": {"n": con_nota, "concuerdan": concuerdan,
                     "generosas": generosas, "severas": severas},
        "instrumento": {
            "entradas": len(filas),
            "juzgables": len(juzgables),
            "canonicas": len(canonicas),
            "interpretadas": [f["fecha"] for f in juzgables if f["interpretado"]],
            "pendientes": [f["fecha"] for f in filas if f["estado"] == "pendiente"],
            "noInterpretables": [f"{f['fecha']} ({f['validadoBruto']})"
                                 for f in filas if f["estado"] == "noInterpretable"],
            "empates": [f["fecha"] for f in filas if f["empate"]],
            "brutosNoCanonicos": sorted({f["validadoBruto"] for f in juzgables
                                         if f["interpretado"]}),
        },
    }


def parte(fecha, r):
    ins, an = r["instrumento"], r["autonota"]
    # DECISION 2026-08-24 (Guillermo): `escenario_validado` se queda en texto
    # libre y las 3 entradas de julio no se reprocesan.
    #
    # Consecuencia para este puesto: normalizar por prefijo pasa a ser conducta
    # ACEPTADA, no defecto — si siguiera levantando ambar, el dominio quedaria en
    # ambar para siempre y el aviso dejaria de leerse. Es la misma logica del
    # silencio informativo que ya rige los partes.
    #
    # Lo que SI levanta ambar es lo que la decision no cubre y nadie mas mira:
    #   - texto que no arranca por ningun escenario: ese dia se cae de la muestra
    #     sin que nadie se entere. Es el unico fallo silencioso que queda.
    #   - autonota inflada de forma SOSTENIDA (3 o mas dias por encima de los
    #     hechos y superando a las que se puso de menos). Una divergencia suelta
    #     es ruido; un sesgo con direccion es otra cosa.
    sesgo_autonota = len(an["generosas"]) >= 3 and len(an["generosas"]) > len(an["severas"])
    dudoso = bool(ins["noInterpretables"]) or sesgo_autonota
    L = [f"[AUDITOR] {fecha}  ·  dominio PREMERCADO SPX"]
    L.append(f"ESTADO: {'ambar' if dudoso else 'verde'}")
    L.append("VEREDICTOS:")
    for v in r["veredictos"]:
        L.append(f"  - {v['id']} ({v['familia']}, nivel {v['nivel']}) · {v['veredicto']}")
        L.append(f"      {v['titulo']}")
        L.append(f"      {v['detalle']['motivo']}")
    L.append("SENALES EN OBSERVACION (NO son veredicto, no autorizan nada):")
    for s in r["sesgo"]:
        if s["brecha"]:
            signo = "sobre" if s["brecha"] > 0 else "sub"
            L.append(f"  · {s['escenario']}: favorito {s['vecesFavorito']} veces, "
                     f"validado {s['vecesValidado']} — {signo}asignado en {abs(s['brecha'])}")
    b = r["veredictos"][1]["detalle"]
    L.append(f"  · Brier medio {b['brierMedio']} vs {b['brierUniforme']} del uniforme "
             f"(mas bajo es mejor)")
    L.append("INSTRUMENTO:")
    L.append(f"  {ins['juzgables']} dias juzgables de {ins['entradas']} en el log · "
             f"{ins['canonicas']} con escenario canonico")
    if ins["interpretadas"]:
        L.append(f"  escenario_validado en texto libre: {len(ins['interpretadas'])} "
                 f"leidas por prefijo ({', '.join(ins['interpretadas'])}) — "
                 f"aceptado por decision del 2026-08-24, no resta")
    if ins["noInterpretables"]:
        L.append(f"  !! NO INTERPRETABLES — estos dias se caen de la muestra: "
                 f"{', '.join(ins['noInterpretables'])}")
    if ins["pendientes"]:
        L.append(f"  sin resultado escrito todavia: {', '.join(ins['pendientes'])}")
    L.append(f"  autonota (vara del Paso 6.2 aplicada desde fuera): "
             f"{an['concuerdan']}/{an['n']} coinciden")
    if an["generosas"]:
        L.append(f"     mas alta de lo que sostienen los hechos: {', '.join(an['generosas'])}")
    if an["severas"]:
        L.append(f"     mas baja de lo que sostienen los hechos: {', '.join(an['severas'])}")
    L.append("PENDIENTE DE DECISION:")
    accionables = [v for v in r["veredictos"] if v["veredicto"] in ("MEJORA", "EMPEORA")]
    if not accionables:
        L.append(f"  - ninguna: ninguna medida alcanzo las {MUESTRA_MINIMA} observaciones "
                 f"para concluir")
    for v in accionables:
        L.append(f"  - {v['id']}: {v['veredicto']}. Se actua sobre esto? (si/no)")
    if ins["noInterpretables"]:
        L.append("  - Hay dias que se estan cayendo de la muestra por texto ilegible. "
                 "Se corrigen esas entradas? (si/no)")
    L.append("DECIDIDO 2026-08-24: escenario_validado se queda en texto libre y las 3 "
             "entradas de julio no se reprocesan. No se vuelve a preguntar.")
    L.append("EL AUDITOR NO PROPONE: estos numeros juzgan un procedimiento ajeno.")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", default=LOG_DEFECTO, help="ruta del premercado_hipotesis_log.json")
    ap.add_argument("--json", action="store_true", help="solo el JSON")
    a = ap.parse_args()

    filas = cargar(a.log)
    r = evaluar(filas)
    fecha = (datetime.now(timezone.utc) - timedelta(hours=4)).strftime("%Y-%m-%d")
    doc = {"fecha": fecha, "dominio": "PREMERCADO", "muestraMinima": MUESTRA_MINIMA,
           "log": a.log, **r, "generado": datetime.now().isoformat(timespec="seconds")}
    txt = parte(fecha, r)

    # Solo el log de verdad deja veredicto escrito. Correr con --log sobre una
    # copia de prueba NO puede pisar el veredicto oficial del dia: seria fabricar
    # un registro desde datos inventados, en el unico puesto que existe para que
    # eso no pase.
    oficial = os.path.abspath(a.log) == os.path.abspath(LOG_DEFECTO)
    if oficial:
        os.makedirs(SALIDA, exist_ok=True)
        with open(os.path.join(SALIDA, f"premercado_{fecha}.json"), "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=1)
        if not a.json:
            with open(os.path.join(SALIDA, f"parte_premercado_{fecha}.txt"), "w",
                      encoding="utf-8") as fh:
                fh.write(txt + "\n")

    if a.json:
        print(json.dumps(doc, ensure_ascii=False, indent=1))
        return 0
    print(txt)
    if not oficial:
        print(f"\n(prueba sobre {a.log} — NO se escribio nada en veredictos/)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
