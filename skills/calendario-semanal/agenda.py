"""Calendario semanal de Sigma Club - las dos fases que van SIN Claude.

    python agenda.py esperar [--hasta 20] [--fecha AAAA-MM-DD] [--seco]
    python agenda.py cerrar  [--fecha AAAA-MM-DD] [--seco]
    python agenda.py hecha   [--fecha AAAA-MM-DD]   -> 0 si ya esta el _cargada.json

esperar  Busca en el grupo "Notificaciones 5" (cuenta usa) el mensaje
         "AGENDA SEMANAL" de la semana en curso. Si no esta, vuelve a mirar
         cada hora hasta la hora --hasta. Al encontrarlo deja en disco
         agenda_<lunes>.txt (el texto tal cual) y agenda_<lunes>.json (las
         sesiones ya leidas, con fecha y hora del Este). Esperar cuesta cero:
         Claude no se arranca hasta que la agenda esta.

cerrar   Lee cargada_<lunes>.json, que deja Claude al terminar, y le manda a
         Guillermo por WhatsApp el parte de lo que quedo en el calendario.

Codigos de salida de `esperar`:
    0  agenda en disco, hay que arrancar a Claude
    1  la semana ya estaba cargada: no hay nada que hacer
    2  se acabo la ventana del dia y la agenda no salio
    3  lunes festivo en NY: la agenda sale el martes, hoy no se busca
    4  GOWA no responde
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import time

import requests

sys.path.insert(0, r"C:\yt-dlp\MANANERO")
import enviar_henry as eh   # cabeceras, gowa_vivo, despertar_gowa, avisar (a Guillermo)

AQUI = os.path.dirname(os.path.abspath(__file__))
# Los datos van FUERA de .claude: Claude en modo -p no puede escribir dentro de
# .claude (carpeta protegida) y no podia dejar su _cargada.json (2026-09-28).
DATOS = (r"C:\Users\gcarv\Documents\CARPETA PERSONAL\01. guillermo carvajal"
         r"\01_Sigma\calendario semanal\semanas")
LOG = os.path.join(AQUI, "ejecuciones.log")
GRUPO = "120363403656198230@g.us"   # 📣 Notificaciones 🟤 5 de Opción Sigma, cuenta usa

DIAS = {"lunes": 0, "martes": 1, "miercoles": 2, "miércoles": 2, "jueves": 3,
        "viernes": 4, "sabado": 5, "sábado": 5, "domingo": 6}

SECO = False


def registrar(msg):
    linea = "[%s] %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(linea, flush=True)
    # Desde la Tarea Programada el .cmd ya redirige stdout a este mismo log y
    # lo tiene abierto: abrirlo otra vez aqui da PermissionError en Windows
    # (paso en la primera corrida, 2026-09-28). Solo se escribe a mano.
    if sys.stdout.isatty():
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(linea + "\n")


# ---------------------------------------------------------------- festivos
def _n_lunes(anio, mes, n):
    """n-esimo lunes del mes (n=-1: el ultimo)."""
    if n > 0:
        d = dt.date(anio, mes, 1)
        d += dt.timedelta(days=(0 - d.weekday()) % 7)
        return d + dt.timedelta(weeks=n - 1)
    d = dt.date(anio + (mes == 12), mes % 12 + 1, 1) - dt.timedelta(days=1)
    return d - dt.timedelta(days=d.weekday())


def _observado(d):
    """Festivo de fecha fija que cae en domingo se pasa al lunes."""
    return d + dt.timedelta(days=1) if d.weekday() == 6 else d


def festivo_ny(d):
    """True si ese dia la bolsa de Nueva York esta cerrada por festivo.

    Solo importan los lunes (es lo que mueve la agenda al martes). Se usan los
    festivos de la bolsa y no los federales: Columbus y Veterans Day la bolsa
    abre y Sigma trabaja. Si algun dia se equivoca, no pasa nada grave: la
    tarea del martes carga igual la agenda.
    """
    a = d.year
    fijos = [dt.date(a, 1, 1), dt.date(a, 6, 19), dt.date(a, 7, 4), dt.date(a, 12, 25)]
    moviles = [_n_lunes(a, 1, 3),    # Martin Luther King
               _n_lunes(a, 2, 3),    # Presidents Day
               _n_lunes(a, 5, -1),   # Memorial Day
               _n_lunes(a, 9, 1)]    # Labor Day
    return d in moviles or d in [_observado(f) for f in fijos]


# ---------------------------------------------------------------- lectura
def lunes_de(d):
    return d - dt.timedelta(days=d.weekday())


def buscar_agenda(h, lunes):
    """Devuelve el mensaje de AGENDA SEMANAL de la semana de `lunes`, o None.

    Se traen los 100 mensajes mas recientes (cubren ~10 dias del grupo, ~12 s)
    y se filtra aqui. NO usar `search`: el 2026-09-28 tardo mas de 90 s y dio
    timeout, y `start_time` GOWA lo ignora. La semana se comprueba por el texto
    "Semana del <dia del lunes>" y por la fecha del mensaje.
    """
    r = requests.get(eh.BASE + "/chat/%s/messages" % GRUPO, headers=h, timeout=120,
                     params={"limit": 100})
    r.raise_for_status()
    desde = dt.datetime.combine(lunes - dt.timedelta(days=3), dt.time()).replace(tzinfo=dt.timezone.utc)
    for m in r.json()["results"]["data"]:
        texto = m.get("content") or ""
        if "AGENDA SEMANAL" not in texto.upper():
            continue
        cuando = dt.datetime.fromisoformat(m["timestamp"].replace("Z", "+00:00"))
        if cuando < desde:
            continue
        sem = re.search(r"Semana del\s+(\d{1,2})", texto, re.I)
        if sem and int(sem.group(1)) != lunes.day:
            continue
        return m
    return None


def leer_sesiones(texto, lunes):
    """Pasa el texto de la agenda a una lista de sesiones con fecha y hora ET."""
    sesiones, dia, avisos = [], None, []
    for linea in texto.splitlines():
        limpia = linea.strip()
        m = re.search(r"\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\s+(\d{1,2})\b",
                      limpia, re.I)
        if m and not limpia.startswith("•"):
            dia = lunes + dt.timedelta(days=DIAS[m.group(1).lower()])
            if dia.day != int(m.group(2)):
                avisos.append("el %s dice dia %s pero por calendario es %s"
                              % (m.group(1), m.group(2), dia.isoformat()))
            continue
        e = re.match(r"•\s*(\d{1,2}):(\d{2})\s*([AP])\.?\s*M\.?\s*[–—-]\s*(.+)", limpia, re.I)
        if e and dia:
            hora = int(e.group(1)) % 12 + (12 if e.group(3).upper() == "P" else 0)
            sesiones.append({"fecha": dia.isoformat(),
                             "hora_et": "%02d:%s" % (hora, e.group(2)),
                             "titulo": e.group(4).strip()})
        elif limpia.startswith("•") and dia:
            # sin hora: "Festivo en Estados Unidos – Mercado cerrado" y parecidos
            avisos.append("%s sin hora: %s" % (dia.isoformat(), limpia.lstrip("• ").strip()))
    return sesiones, avisos


# ---------------------------------------------------------------- fases
def rutas(lunes):
    os.makedirs(DATOS, exist_ok=True)
    base = os.path.join(DATOS, lunes.isoformat())
    return base + "_agenda.txt", base + "_agenda.json", base + "_cargada.json"


def esperar(hoy, hasta):
    lunes = lunes_de(hoy)
    txt, js, cargada = rutas(lunes)
    if os.path.exists(cargada):
        registrar("semana del %s ya cargada: nada que hacer" % lunes)
        return 1
    if hoy.weekday() == 0 and festivo_ny(hoy):
        registrar("%s es festivo en NY: la agenda sale el martes, hoy no se busca" % hoy)
        return 3

    h = eh.cabeceras()
    if not eh.gowa_vivo(h) and not eh.despertar_gowa(h):
        registrar("GOWA no responde y no arranca")
        return 4

    while True:
        m, fallos = None, 0
        while True:
            try:
                m = buscar_agenda(h, lunes)
                break
            except (requests.RequestException, ValueError, KeyError) as e:
                fallos += 1
                registrar("no se pudo leer el grupo (intento %d): %s" % (fallos, str(e)[:150]))
                if fallos >= 3:
                    break
                time.sleep(300)   # un fallo de GOWA no debe costar una hora entera
        if m:
            sesiones, avisos = leer_sesiones(m["content"], lunes)
            with open(txt, "w", encoding="utf-8") as f:
                f.write(m["content"])
            with open(js, "w", encoding="utf-8") as f:
                json.dump({"lunes": lunes.isoformat(), "mensaje_id": m["id"],
                           "publicada": m["timestamp"], "sesiones": sesiones,
                           "avisos": avisos}, f, ensure_ascii=False, indent=2)
            registrar("agenda encontrada (publicada %s): %d sesiones%s"
                      % (m["timestamp"], len(sesiones),
                         "; avisos: " + " | ".join(avisos) if avisos else ""))
            return 0
        ahora = dt.datetime.now()
        if ahora.hour >= hasta:
            registrar("a las %s todavia no sale la agenda del %s: se deja para la proxima corrida"
                      % (ahora.strftime("%H:%M"), lunes))
            return 2
        registrar("todavia no esta la agenda; vuelvo a mirar en una hora")
        time.sleep(3600)


def cerrar(hoy):
    lunes = lunes_de(hoy)
    _, _, cargada = rutas(lunes)
    if not os.path.exists(cargada):
        texto = ("⚠️ Calendario semanal Sigma: la agenda del %s se encontro pero NO "
                 "quedo cargada en Google Calendar (Claude no dejo el parte). "
                 "Revisa ejecuciones.log." % lunes.strftime("%d/%m"))
    else:
        with open(cargada, encoding="utf-8") as f:
            r = json.load(f)
        lineas = ["📅 Agenda Sigma Club cargada en tu calendario (semana del %s)"
                  % lunes.strftime("%d/%m"), ""]
        for s in r.get("creadas", []):
            lineas.append("• %s" % s)
        if r.get("ya_estaban"):
            lineas.append("")
            lineas.append("Ya estaban, no se duplicaron: %d" % len(r["ya_estaban"]))
        if r.get("notas"):
            lineas.append("")
            lineas += ["⚠️ %s" % n for n in r["notas"]]
        lineas += ["", "Horas en hora Colombia. El Zoom lo mandan 10 min antes al grupo."]
        texto = "\n".join(lineas)
    if SECO:
        registrar("SECO: avisaria ->\n" + texto)
        return 0
    try:
        h = eh.cabeceras()
        ok = eh.avisar(h, texto)
    except Exception as e:
        registrar("no se pudo avisar: %s" % str(e)[:150])
        ok = False
    registrar("parte a Guillermo: %s" % ("enviado" if ok else "NO salio"))
    return 0 if ok else 5


def main():
    global SECO
    p = argparse.ArgumentParser()
    p.add_argument("fase", choices=["esperar", "cerrar", "hecha"])
    p.add_argument("--hasta", type=int, default=20, help="ultima hora del dia en que se mira")
    p.add_argument("--fecha", help="hacer como si hoy fuera esta fecha (pruebas)")
    p.add_argument("--seco", action="store_true", help="no manda WhatsApp")
    a = p.parse_args()
    SECO = a.seco
    hoy = dt.date.fromisoformat(a.fecha) if a.fecha else dt.date.today()
    if a.fase == "hecha":
        sys.exit(0 if os.path.exists(rutas(lunes_de(hoy))[2]) else 1)
    sys.exit(esperar(hoy, a.hasta) if a.fase == "esperar" else cerrar(hoy))


if __name__ == "__main__":
    main()
