# -*- coding: utf-8 -*-
"""Reconstruye las lecturas de Discord de un día a partir de las capturas guardadas, con el lector ACTUAL, y las
envía a la bitácora (hoja Hiro por capas). Útil cuando se corrige el lector (control de calidad).

Uso: python recargar_capas.py 2026-11-20 [https://web-production-23473.up.railway.app]

Auditoría 20-nov: hora de Nueva York con horario de verano (antes -5 fijo), cada lectura y cada envío en try (un error
ya no deja el día a medio borrar en la bitácora), y también recarga la Bola 8 en texto.
"""
import datetime as dt
import glob
import json
import os
import sys
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

import lector

NY = ZoneInfo("America/New_York")
BASE = Path(__file__).resolve().parent
fecha = sys.argv[1]
dt.date.fromisoformat(fecha)   # fecha mal escrita: se detiene aquí, antes de tocar nada
url = (sys.argv[2] if len(sys.argv) > 2 else "https://web-production-23473.up.railway.app").rstrip("/") + "/api/capas/discord"
carpeta = BASE / "capturas" / fecha
CAB = {"Content-Type": "application/json", "User-Agent": "gexbot-sombra/1.0"}
_clave = os.environ.get("BITACORA_TOKEN") or (lambda f: f.read_text(encoding="utf-8-sig").strip() if f.exists() else "")(BASE / ".bitacora_token")
if _clave:
    CAB["x-bitacora-token"] = _clave


def hora_de(nombre):   # "133802_hiro.png" -> "13:38:02" (las capturas ya se nombran en hora de NY)
    h = os.path.basename(nombre)[:6]
    return f"{h[:2]}:{h[2:4]}:{h[4:6]}"


def hora_bola8(nombre):   # "bola8_202611201546_sonar.png": AAAAMMDDhhmm en UTC -> hh:mm:00 en NY
    marca = os.path.basename(nombre).split("_")[1][:12]
    t = dt.datetime.strptime(marca, "%Y%m%d%H%M").replace(tzinfo=dt.timezone.utc).astimezone(NY)
    return t.strftime("%H:%M:00")


regs = {}
for clave, fn in (("gexbot_classic", lector.gexbot_classic), ("gexbot_state", lector.gexbot_state),
                  ("tradytics", lector.tradytics), ("hiro", lector.hiro), ("option_flow", lector.quantdata)):
    for f in sorted(glob.glob(str(carpeta / f"*_{clave}.png"))):
        try:
            regs.setdefault(hora_de(f), {})[clave] = fn(f)
        except Exception as e:
            print("error", f, e)
for patron, fn in (("bola8_*_sonar.png", lector.bola8_sonar), ("bola8_*_texto.txt", lector.bola8_texto)):
    for f in sorted(glob.glob(str(carpeta / patron))):
        try:
            regs.setdefault(hora_bola8(f), {})["bola8"] = fn(f)
        except Exception as e:
            print("error", f, e)
# el precio del SPX de cada lectura: el del registro de confluencia más cercano
spx = {}
fc = carpeta / "confluencia.jsonl"
if fc.exists():
    for l in fc.read_text(encoding="utf-8").splitlines():
        try:
            d = json.loads(l)
        except Exception:
            continue
        if d.get("spx"):
            spx[d["at"][11:19]] = d["spx"]
claves_spx = sorted(spx)
seg = lambda h: int(h[:2]) * 3600 + int(h[3:5]) * 60
# desfase de NY ese día (con horario de verano), para el sello de cada lectura
off = dt.datetime.strptime(fecha + " 12:00", "%Y-%m-%d %H:%M").replace(tzinfo=NY).strftime("%z")
off = off[:3] + ":" + off[3:]
# 2.ª auditoría: si no hay nada que reenviar (fecha mal escrita, carpeta borrada, Tesseract ausente) NO se vacía el día
if not regs:
    sys.exit(f"sin lecturas para {fecha} en {carpeta}: no se toca la bitácora")
# primero se vacía el día en la bitácora (si no, quedan mezcladas las lecturas del lector viejo)
try:
    urllib.request.urlopen(urllib.request.Request(url.replace("/discord", "/limpiar"), data=json.dumps({"fecha": fecha}).encode("utf-8"),
                                                  headers=CAB, method="POST"), timeout=20)
except Exception as e:
    print("no se pudo vaciar el día (se agregan igual):", e)
n, fallas = 0, 0
for hora in sorted(regs):
    r = regs[hora]
    cerca = min(claves_spx, key=lambda h: abs(seg(h) - seg(hora))) if claves_spx else None
    cuerpo = {"at": f"{fecha}T{hora}{off}", "spx": spx.get(cerca) if cerca else None, **r}
    try:
        urllib.request.urlopen(urllib.request.Request(url, data=json.dumps(cuerpo).encode("utf-8"), headers=CAB, method="POST"), timeout=20)
        n += 1
    except Exception as e:
        fallas += 1
        print("no se pudo enviar", hora, e)
print(f"{n} lecturas enviadas a {url}" + (f" ({fallas} fallaron)" if fallas else ""))
