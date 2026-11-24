# -*- coding: utf-8 -*-
"""Guarda los históricos para backtesting en la rama 'historicos' del repo bitacora-tasty (21-nov-2026).

La rama vive en su propia carpeta (git worktree): ..\\..\\Bitacoras\\bitacora-historicos. NO toca la rama main, así que
no redespliega Railway ni reinicia el robot.

Qué guarda, por día (AAAA-MM-DD):
  discord/<día>/confluencia.jsonl     lecturas de cada ciclo (GexBot Classic/State, Tradytics, HIRO, Bola 8, option flow),
                                      fases 5m/2m, votos y lecturas A/B — todo lo que vio el motor en sombra
  discord/<día>/barridos.jsonl        qué capturó cada barrido de Discord
  discord/<día>/bola8_*_texto.txt     informes de la Bola 8 en texto
  gexbot_propio/historial_<día>.jsonl nuestro cálculo estilo GexBot desde la cadena de opciones
  produccion/capas/<día>.jsonl        lo que recibió la bitácora (hoja Hiro por capas)
  produccion/hiro/<día>.json          HIRO propio minuto a minuto (calls/puts/total acumulados) + velas de 1 min del SPX
Las capturas PNG (≈30 MB por día) NO van al repo: quedan en gexbot-sombra/capturas.

Uso: python guardar_historicos.py          todos los días que haya
     python guardar_historicos.py --sin-push
Lo lanza confluencia_diaria.cmd al terminar la sesión.
"""
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent
REPO = BASE.parent.parent / "Bitacoras" / "bitacora-historicos"
API = "https://web-production-23473.up.railway.app"
FECHA = re.compile(r"^\d{4}-\d{2}-\d{2}$")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def log(m):
    print(f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}] historicos: {m}", flush=True)


def git(*args, env=None):
    return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace",
                          env=env, timeout=600)


def copiar(origen, destino):
    """Copia solo si cambió (así git no ve diferencias falsas)."""
    if destino.exists() and destino.read_bytes() == origen.read_bytes():
        return False
    destino.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(origen, destino)
    return True


def escribir_si_crece(destino, texto, n_nuevo, n_viejo):
    """Datos de producción: nunca se reemplaza lo guardado por algo vacío o más chico (servidor sin datos o recién limpiado)."""
    if n_nuevo == 0 or n_nuevo < n_viejo:
        return False
    if destino.exists() and destino.read_text(encoding="utf-8") == texto:
        return False
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_text(texto, encoding="utf-8", newline="\n")
    return True


def bajar(ruta):
    req = urllib.request.Request(API + ruta, headers={"User-Agent": "gexbot-sombra/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main():
    if not (REPO / ".git").exists():
        sys.exit(f"no existe la carpeta de la rama historicos: {REPO}")
    if git("branch", "--show-current").stdout.strip() != "historicos":
        sys.exit("la carpeta no está en la rama historicos: no se toca nada")
    dias = sorted({p.name for p in (BASE / "capturas").iterdir() if p.is_dir() and FECHA.match(p.name)}
                  | {p.stem.split("_", 1)[1] for p in BASE.glob("historial_*.jsonl")})
    cambios = 0
    for dia in dias:
        cap = BASE / "capturas" / dia
        for nombre in ("confluencia.jsonl", "barridos.jsonl"):
            if (cap / nombre).exists():
                cambios += copiar(cap / nombre, REPO / "discord" / dia / nombre)
        for f in cap.glob("bola8_*_texto.txt") if cap.exists() else []:
            cambios += copiar(f, REPO / "discord" / dia / f.name)
        h = BASE / f"historial_{dia}.jsonl"
        if h.exists():
            cambios += copiar(h, REPO / "gexbot_propio" / h.name)
        # producción (bitácora): capas recibidas y HIRO propio del día
        try:
            c = bajar(f"/api/capas?fecha={dia}")
            regs = c.get("registros") or []
            dest = REPO / "produccion" / "capas" / f"{dia}.jsonl"
            viejo = len(dest.read_text(encoding="utf-8").splitlines()) if dest.exists() else 0
            cambios += escribir_si_crece(dest, "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in regs), len(regs), viejo)
        except Exception as e:
            log(f"{dia}: capas de producción no disponibles ({e})")
        try:
            r = bajar(f"/api/hiro?fecha={dia}")
            datos = {"fecha": dia, "cierrePrevio": r.get("cierrePrevio"), "filas": r.get("filas") or [], "velas": r.get("velas") or []}
            dest = REPO / "produccion" / "hiro" / f"{dia}.json"
            viejo = 0
            if dest.exists():
                try:
                    v = json.loads(dest.read_text(encoding="utf-8"))
                    viejo = len(v.get("filas") or []) + len(v.get("velas") or [])
                except Exception:
                    pass
            cambios += escribir_si_crece(dest, json.dumps(datos, ensure_ascii=False, indent=0) + "\n",
                                         len(datos["filas"]) + len(datos["velas"]), viejo)
        except Exception as e:
            log(f"{dia}: HIRO de producción no disponible ({e})")
    # índice: qué hay de cada día (para el backtesting)
    indice = {}
    for dia in dias:
        e = {}
        f = REPO / "discord" / dia / "confluencia.jsonl"
        e["ciclos_confluencia"] = len(f.read_text(encoding="utf-8").splitlines()) if f.exists() else 0
        f = REPO / "produccion" / "capas" / f"{dia}.jsonl"
        e["capas"] = len(f.read_text(encoding="utf-8").splitlines()) if f.exists() else 0
        f = REPO / "produccion" / "hiro" / f"{dia}.json"
        try:
            v = json.loads(f.read_text(encoding="utf-8"))
            e["hiro_minutos"], e["velas_spx"] = len(v["filas"]), len(v["velas"])
        except Exception:
            e["hiro_minutos"] = e["velas_spx"] = 0
        f = REPO / "gexbot_propio" / f"historial_{dia}.jsonl"
        e["gexbot_propio"] = len(f.read_text(encoding="utf-8").splitlines()) if f.exists() else 0
        indice[dia] = e
    texto = json.dumps(indice, ensure_ascii=False, indent=1) + "\n"
    fi = REPO / "indice.json"
    if not fi.exists() or fi.read_text(encoding="utf-8") != texto:
        fi.write_text(texto, encoding="utf-8", newline="\n")
        cambios += 1
    if not cambios:
        log("sin cambios")
        return
    git("add", "-A")
    if not git("status", "--porcelain").stdout.strip():
        log("sin cambios")
        return
    env = {**os.environ, "SKIP_CONTROL_CAMBIOS": "1"}   # no es código: el control de cambios de la bitácora no aplica
    r = git("commit", "-q", "-m", f"Históricos al {dt.date.today().isoformat()} ({len(dias)} días)", env=env)
    if r.returncode != 0:
        log("commit falló: " + (r.stderr or r.stdout).strip()[-300:])
        return
    log(f"commit {git('rev-parse', '--short', 'HEAD').stdout.strip()} ({cambios} archivos nuevos o cambiados)")
    if "--sin-push" in sys.argv:
        return
    # Rama de datos, sin código: el pre-push de la bitácora (pruebas del servidor) no aplica y su propio texto indica
    # SKIP_PRUEBAS para "un push que no toca código". La rama main nunca se empuja desde aquí.
    r = git("push", "-u", "origin", "historicos", env={**env, "SKIP_PRUEBAS": "1"})
    log("push ok" if r.returncode == 0 else "push falló: " + (r.stderr or r.stdout).strip()[-300:])


if __name__ == "__main__":
    main()
