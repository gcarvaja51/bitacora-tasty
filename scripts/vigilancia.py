# -*- coding: utf-8 -*-
"""
Vigilancia intradia — el motor de la Torre de Control.

Corre cada 30 minutos en horario de mercado. Esta pensado para CALLARSE: si todo
esta bien sale con codigo 0 y el lanzador NI SIQUIERA ARRANCA a Claude. Un
vigilante que escribe cuando no pasa nada entrena a que se dejen de leer sus
avisos, y el dia que hay un incendio nadie lo mira.

  python scripts/vigilancia.py           # el chequeo intradia
  python scripts/vigilancia.py --frenos  # ademas, el estado de los limites de riesgo

Codigos de salida — los usa ejecutar_torre.cmd para decidir si vale la pena
gastar una sesion de Claude:

  0  verde   todo bien. No se escala.
  1  ambar   algo degradado pero se puede operar. Se escala para causa raiz.
  2  rojo    no se puede operar, o se esta operando con datos malos. Se escala.

NO DUPLICA el chequeo de las 07:00 (`chequeo_salud_estrategias.py`), que cubre
kill-switches, canario de configuracion y modo del daemon antes de la apertura.
Este mira lo que se rompe DURANTE la sesion.

LA FRONTERA: la Torre vigila que el SISTEMA este sano —procesos, ordenes,
errores—. Que el DATO este sano —frescura, sellos, completitud— es del Ingeniero
de Datos. Lo que aparece aca y es del dato se marca y se le pasa.
"""
import argparse, json, os, sys
from collections import Counter
from datetime import datetime, timedelta, timezone

PROD = "https://web-production-23473.up.railway.app"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(REPO, "vigilancia")
DAEMON_STATUS = os.path.join(REPO, "gamma_daemon", "status.json")

# Umbrales, con nombre para poder discutirlos sin leer el codigo.
CICLO_DAEMON_MAX_MIN   = 10    # el daemon cicla cada 2 min; 10 sin ciclar es que murio
EXITO_DAEMON_MAX_MIN   = 20    # ciclar sin exito es peor que no ciclar: parece vivo
APERTURA_ATASCADA_MIN  = 25    # una apertura que no resuelve bloquea entradas en silencio
MISMATCH_HORA_AMBAR    = 40    # bloqueos por desacuerdo de posicion en la ultima hora
RECHAZOS_HORA_AMBAR    = 3     # ordenes que el broker rechazo en la ultima hora


def _get_json(url, timeout=45, reintentos=2):
    from urllib.request import urlopen
    ultimo = None
    for _ in range(reintentos):
        try:
            with urlopen(url, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:      # noqa: BLE001
            ultimo = e
    raise RuntimeError(str(ultimo))


def ahora_et():
    return datetime.now(timezone.utc) - timedelta(hours=4)


def mercado_abierto(t=None):
    t = t or ahora_et()
    if t.weekday() >= 5:
        return False
    hm = t.hour * 60 + t.minute
    return 9 * 60 + 30 <= hm <= 16 * 60


def edad_min(iso):
    if not iso:
        return None
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return round((datetime.now(timezone.utc) - d).total_seconds() / 60, 1)
    except Exception:      # noqa: BLE001
        return None


def chequear(frenos=False):
    """Devuelve (estado, incidentes, detalle). Cada incidente lleva su causa
    aparente: avisar sin decir por que obliga a diagnosticar desde cero."""
    inc_rojo, inc_ambar, det = [], [], {}
    abierto = mercado_abierto()
    det["mercadoAbierto"] = abierto

    # 1. El servidor. Si esto falla, lo demas no se puede ni preguntar.
    try:
        h = _get_json(f"{PROD}/api/health")
        det["servidor"] = {"ok": True, "commit": h.get("commit"),
                           "uptimeHoras": round((h.get("uptimeSeg") or 0) / 3600, 1),
                           "auth": h.get("auth")}
        if h.get("auth") is False:
            inc_rojo.append("el servidor esta arriba pero SIN sesion en TastyTrade: "
                            "no puede cotizar la cadena real, o sea que no puede medir ni cerrar bien")
    except Exception as e:      # noqa: BLE001
        det["servidor"] = {"ok": False, "error": str(e)[:160]}
        inc_rojo.append(f"produccion no responde ({str(e)[:80]}) — el robot esta ciego")
        return "rojo", inc_rojo, inc_ambar, det

    # 2. El daemon de gamma. Ojo con la trampa: que CICLE no quiere decir que
    #    FUNCIONE. Un daemon que cicla sin exito parece vivo en cualquier
    #    chequeo ingenuo y lleva horas sin empujar un nivel.
    try:
        with open(DAEMON_STATUS, encoding="utf-8") as fh:
            st = json.load(fh)
        e_ciclo = edad_min(st.get("lastCycleAt"))
        e_exito = edad_min(st.get("lastSuccessAt"))
        det["daemon"] = {"mode": st.get("mode"), "fallosSeguidos": st.get("consecutiveFailures"),
                         "ultimoCicloMin": e_ciclo, "ultimoExitoMin": e_exito}
        if e_ciclo is not None and e_ciclo > CICLO_DAEMON_MAX_MIN:
            inc_rojo.append(f"el daemon no cicla hace {e_ciclo} min (max {CICLO_DAEMON_MAX_MIN}): "
                            "el proceso probablemente murio y los muros estan congelados")
        elif abierto and e_exito is not None and e_exito > EXITO_DAEMON_MAX_MIN:
            inc_rojo.append(f"el daemon CICLA pero no tiene exito hace {e_exito} min: "
                            "parece vivo y no esta empujando niveles")
        if (st.get("consecutiveFailures") or 0) >= 3:
            inc_ambar.append(f"{st['consecutiveFailures']} fallos seguidos del daemon")
        if st.get("mode") and st.get("mode") != "normal":
            inc_ambar.append(f"daemon en modo '{st['mode']}', no 'normal'")
    except FileNotFoundError:
        det["daemon"] = {"error": "sin status.json"}
        inc_ambar.append("no hay status.json del daemon: no se puede saber si esta vivo")
    except Exception as e:      # noqa: BLE001
        det["daemon"] = {"error": str(e)[:160]}
        inc_ambar.append(f"no se pudo leer el estado del daemon: {str(e)[:80]}")

    # 3. Aperturas atascadas. La peor clase de falla: no hay error, el robot
    #    simplemente deja de entrar y nadie se entera.
    try:
        ex = _get_json(f"{PROD}/api/tradier/executions").get("executions", [])
        colgadas = []
        for e in ex:
            if e.get("status") in ("closed", "canceled"):
                continue
            edad = edad_min(e.get("timestamp") or e.get("filledAt"))
            if edad is not None and edad > APERTURA_ATASCADA_MIN:
                colgadas.append({"id": e.get("id"), "status": e.get("status"),
                                 "familia": e.get("strategyFamily"), "edadMin": edad})
        det["aperturasAtascadas"] = colgadas
        for c in colgadas:
            inc_ambar.append(f"{c['id']} ({c['familia']}) lleva {c['edadMin']} min en '{c['status']}': "
                             "mientras no resuelva, bloquea entradas nuevas sin avisar")
    except Exception as e:      # noqa: BLE001
        inc_ambar.append(f"no se pudieron leer las ejecuciones: {str(e)[:80]}")

    # 4. La ultima hora del log: rechazos del broker y desacuerdos de posicion.
    try:
        log = _get_json(f"{PROD}/api/spx/strategy-log?limit=1200")
        if isinstance(log, dict):
            log = log.get("entradas") or []
        corte = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        ult = [x for x in log if (x.get("timestamp") or "") >= corte]
        rech = [x for x in ult if x.get("stage") == "ORDEN_RECHAZADA"]
        mism = [x for x in ult if x.get("stage") == "POSITION_CHECK_MISMATCH"]
        det["ultimaHora"] = {"evaluaciones": len(ult), "rechazos": len(rech),
                             "desacuerdoPosicion": len(mism)}
        if len(rech) >= RECHAZOS_HORA_AMBAR:
            r = Counter((x.get("reason") or "")[:90] for x in rech).most_common(1)
            inc_ambar.append(f"{len(rech)} ordenes rechazadas por el broker en la ultima hora"
                             + (f" — {r[0][0]}" if r else ""))
        if len(mism) >= MISMATCH_HORA_AMBAR:
            inc_ambar.append(f"{len(mism)} bloqueos por desacuerdo entre Tradier y el registro local "
                             "en la ultima hora: el robot esta discutiendo consigo mismo si tiene posicion")
    except Exception as e:      # noqa: BLE001
        inc_ambar.append(f"no se pudo leer el log de estrategia: {str(e)[:80]}")

    # 4-bis. ¿Estamos DENTRO de un apagon del broker ahora mismo? (2026-09-03)
    #
    # Distinto del conteo de rechazos de arriba, que mira una hora hacia atras y
    # no distingue veinte rechazos de un mismo bloque de veinte problemas. Esto
    # dice si el sandbox esta caido EN ESTE MOMENTO, que es lo que decide si
    # tiene sentido esperar una entrada hoy. Medido el 3-sep: bloques de 10 a 40
    # min, ~59% del horario de mercado. Ver src/apagon_broker.js.
    try:
        ap = _get_json(f"{PROD}/api/spx/apagon-broker")
        det["apagonBroker"] = ap
        if ap.get("enApagon"):
            inc_ambar.append(
                f"el broker lleva {ap.get('duracionMin')} min sin aceptar ordenes "
                f"({ap.get('setupsPerdidos')} setups perdidos, {', '.join(ap.get('familias') or [])}): "
                "las señales se generan y no se ejecutan")
    except Exception as e:      # noqa: BLE001
        inc_ambar.append(f"no se pudo leer el estado del broker: {str(e)[:80]}")

    # 5. Los frenos. IMPORTANTE: esto verifica que esten CONFIGURADOS y cuanto
    #    margen queda, NO que disparen. Probar que un freno frena exige un
    #    simulacro deliberado, y decir que esta verificado sin haberlo hecho es
    #    peor que no verificarlo.
    if frenos:
        try:
            cfg = _get_json(f"{PROD}/api/spx/config")
            t = (cfg.get("config") or cfg).get("trading") or {}
            rev = t.get("smaReversion") or {}
            # Solo UNO de los tres frena de verdad. Los otros dos estan
            # guardados con valores que parecen protecciones y no lo son:
            # riskPctPerTrade no sizea nada (la reversion usa contracts=1 fijo
            # desde el 2026-07-27) y maxStopsPerDay no lo lee ninguna linea desde
            # esa misma fecha. Reportarlos juntos —como se hizo el 2026-08-21—
            # es exactamente el error contra el que el propio codigo advierte:
            # se toman decisiones creyendo que hay protecciones puestas.
            det["frenos"] = {
                "activos": {"maxDailyDrawdownPct": rev.get("maxDailyDrawdownPct")},
                "decorativos": {"riskPctPerTrade": rev.get("riskPctPerTrade"),
                                "maxStopsPerDay": rev.get("maxStopsPerDay")},
                "verificadoConSimulacro": True,
                "simulacro": "node scripts/simulacro_frenos.js — 16 casos, 2026-08-22",
                "nota": "SOLO maxDailyDrawdownPct frena. Los decorativos estan en la config pero "
                        "ninguna linea de codigo los lee: no reportarlos como proteccion.",
            }
            if rev.get("maxDailyDrawdownPct") in (None, 0):
                inc_rojo.append("maxDailyDrawdownPct esta en "
                                f"{rev.get('maxDailyDrawdownPct')!r}: el UNICO freno real "
                                "no esta limitando nada")
        except Exception as e:      # noqa: BLE001
            inc_ambar.append(f"no se pudo leer la configuracion de frenos: {str(e)[:80]}")

    estado = "rojo" if inc_rojo else ("ambar" if inc_ambar else "verde")
    return estado, inc_rojo, inc_ambar, det


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frenos", action="store_true", help="ademas, el estado de los limites de riesgo")
    a = ap.parse_args()

    estado, rojo, ambar, det = chequear(frenos=a.frenos)
    t = ahora_et()

    os.makedirs(SALIDA, exist_ok=True)
    doc = {"ts": t.strftime("%Y-%m-%d %H:%M") + " ET", "estado": estado,
           "rojo": rojo, "ambar": ambar, "detalle": det}
    with open(os.path.join(SALIDA, "ultimo.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
    with open(os.path.join(SALIDA, "historico.jsonl"), "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"ts": doc["ts"], "estado": estado,
                             "incidentes": len(rojo) + len(ambar)}, ensure_ascii=False) + "\n")

    # El parte de un vigilante sano es una linea. Nada mas.
    print(f"[TORRE] {doc['ts']}")
    print(f"ESTADO: {estado}")
    for x in rojo:
        print(f"  ROJO: {x}")
    for x in ambar:
        print(f"  AMBAR: {x}")

    return 2 if estado == "rojo" else (1 if estado == "ambar" else 0)


if __name__ == "__main__":
    sys.exit(main())
