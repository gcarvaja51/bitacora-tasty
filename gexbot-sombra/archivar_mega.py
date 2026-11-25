# -*- coding: utf-8 -*-
"""Archiva en MEGA las capturas de Discord viejas y libera el disco del PC (Guillermo, 24-nov-2026: "sobre el tema del
disco, podemos cargar informacion en mega... en mega tengo muchos gigas libres").

Con la captura continua (desde el 25-nov) se guardan ~1 GB de PNG por día en capturas/AAAA-MM-DD/. Cada noche, al
terminar la sesión (lo llama confluencia_diaria.cmd), las carpetas con más de DIAS_LOCAL días se suben a
MEGA:/Bitacora/gexbot-capturas/AAAA-MM-DD, se VERIFICA que llegaron todos los archivos con el mismo tamaño total, y
recién entonces se borran del PC. Si algo no cuadra, la carpeta local se queda y se avisa en el log.
Los datos leídos (confluencia.jsonl, barridos, capas) ya van a la rama "historicos" del repo: aquí solo pesan los PNG.

  python archivar_mega.py              # archiva lo que corresponda
  python archivar_mega.py --simular    # solo dice qué haría
"""
import datetime as dt
import re
import shutil
import subprocess
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
CAPTURAS = BASE / "capturas"
MEGA = Path(r"C:\Users\gcarv\AppData\Local\MEGAcmd")
DESTINO = "/Bitacora/gexbot-capturas"
DIAS_LOCAL = 5          # se quedan en el PC los últimos 5 días (para recargar_capas / rellenar huecos)
SIMULAR = "--simular" in sys.argv


def log(m):
    linea = f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}] archivar_mega: {m}"
    print(linea, flush=True)
    with open(BASE / "archivar_mega.log", "a", encoding="utf-8") as f:
        f.write(linea + "\n")


def mega(cmd, *args, timeout=3600):
    r = subprocess.run([str(MEGA / f"mega-{cmd}.bat"), *args], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def tamano_remoto(ruta):
    """(archivos, bytes) de una carpeta en MEGA, o None si no existe."""
    code, out = mega("ls", "-lR", ruta, timeout=600)   # (MEGAcmd devuelve código 255 aunque liste bien: no se usa)
    if "Couldn't find" in out or "FLAGS" not in out:
        return None
    n = b = 0
    for linea in out.splitlines():
        # "----    1          180 09Nov2026 19:07:27 nombre" (archivo, tamaño exacto en bytes); carpetas: "d---  -  -"
        m = re.match(r"^([-a-z]{4})\s+\S+\s+(\d+)\s+\d{2}\w{3}\d{4}\s", linea)
        if m and m.group(1)[0] != "d":
            n += 1
            b += int(m.group(2))
    return n, b


def main():
    if not (MEGA / "mega-put.bat").exists():
        log("no encuentro MEGAcmd; no se archiva nada")
        return 1
    code, out = mega("whoami", timeout=120)
    if code != 0 or "@" not in out:
        log(f"MEGA sin sesión ({out.strip()[:120]}); no se archiva nada")
        return 1
    limite = dt.date.today() - dt.timedelta(days=DIAS_LOCAL)
    carpetas = sorted(p for p in CAPTURAS.iterdir() if p.is_dir() and re.fullmatch(r"\d{4}-\d{2}-\d{2}", p.name)
                      and dt.date.fromisoformat(p.name) < limite)
    if not carpetas:
        log(f"nada que archivar (se guardan en el PC los días desde {limite})")
        return 0
    mega("mkdir", "-p", DESTINO, timeout=120)
    for c in carpetas:
        archivos = [f for f in c.rglob("*") if f.is_file()]
        n_loc, b_loc = len(archivos), sum(f.stat().st_size for f in archivos)
        remoto = f"{DESTINO}/{c.name}"
        if SIMULAR:
            log(f"subiría {c.name}: {n_loc} archivos, {b_loc / 1e6:.1f} MB -> {remoto} y luego la borraría del PC")
            continue
        ya = tamano_remoto(remoto)
        if ya != (n_loc, b_loc):
            code, out = mega("put", "-c", str(c), DESTINO + "/")      # sube la carpeta completa (crea /DESTINO/AAAA-MM-DD)
            if code != 0:
                log(f"{c.name}: falló la subida ({out.strip()[-200:]}); la carpeta se queda en el PC")
                continue
            ya = tamano_remoto(remoto)
        if ya != (n_loc, b_loc):
            log(f"{c.name}: no cuadra (PC {n_loc} archivos / {b_loc} B, MEGA {ya}); NO se borra")
            continue
        shutil.rmtree(c)
        log(f"{c.name}: {n_loc} archivos, {b_loc / 1e6:.1f} MB en MEGA {remoto}; borrada del PC")
    code, out = mega("df", "-h", timeout=120)
    usado = re.search(r"USED STORAGE:\s+([\d.]+ \w+)\s+([\d.]+)% of ([\d.]+ \w+)", out)
    if usado:
        log(f"MEGA: {usado.group(1)} usados de {usado.group(3)} ({usado.group(2)} %)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
