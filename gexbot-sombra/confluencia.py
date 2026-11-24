# -*- coding: utf-8 -*-
"""
Motor de confluencia SPX en SOMBRA (19-nov-2026, definido con Guillermo). No opera: registra y dibuja.

Cada ciclo (cada ~3 min, 9:25 al cierre ET; feriados y medios días según calendario_nyse.json):
  1. barrido_discord.mjs --barrido  -> capturas de Bola 8, GexBot Classic/State, Tradytics, HIRO
  2. lector.py                      -> números de cada captura
  3. fases Weinstein 5m (tendencia) y 2m (gatillo) con velas de 1 min de TradingView (TVC:SPX)
  4. votos + lectura A (tendencia) y lectura B (fade estilo Emerson)
  5. registro en capturas/<fecha>/confluencia.jsonl y dibujo en TradingView (tv_dibujar.mjs)
  6. nuestro cálculo estilo GexBot (gexbot_propio.py) para comparar contra GexBot real

Nombres según DICCIONARIO_GEXBOT.md (Gamma Flip GB, Imán + GB, Imán − GB, Cambio gamma, Freno/Acelerador gamma).

Uso:  python confluencia.py            un ciclo
      python confluencia.py --loop 180 ciclos cada 180 s en horario de mercado
"""
import datetime as dt
import json
import subprocess
import sys
import time
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))
sys.path.insert(0, str(BASE.parent / "polymarket-bot" / "pmbot"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import lector  # noqa: E402

NY = ZoneInfo("America/New_York")
NODE = "node"
UMBRAL_FUERZA_BOLA8 = 0.6
TOL_IMAN = 5.0          # puntos: "en el imán"
MIN_VOTOS_A = 2         # lectura A: herramientas a favor (neto) para confirmar


# Calendario NYSE: se lee la ÚNICA fuente (bitacora-tasty/src/calendario_nyse.json), no se copian las listas.
CALENDARIO = BASE.parent.parent / "Bitacoras" / "bitacora-tasty" / "src" / "calendario_nyse.json"


def cierre_del_dia(fecha):
    """Hora de cierre de la sesión de esa fecha (16:00, o 13:00 en medio día); None si no hay mercado."""
    if fecha.weekday() >= 5:
        return None
    try:
        cal = json.loads(CALENDARIO.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[aviso] sin calendario NYSE ({e}): se asume día hábil normal", flush=True)
        return dt.time(16, 0)
    if not isinstance(cal, dict):
        return dt.time(16, 0)
    f = fecha.isoformat()
    if f > str(cal.get("hasta") or ""):
        print("[aviso] calendario NYSE vencido: actualizar bitacora-tasty/src/calendario_nyse.json", flush=True)
    if f in (cal.get("feriados") or []):
        return None
    return dt.time(13, 0) if f in (cal.get("mediosDias") or []) else dt.time(16, 0)


def log(m):
    linea = f"[{dt.datetime.now(NY):%Y-%m-%d %H:%M:%S}] {m}"
    try:   # un log bloqueado o un disco lleno no pueden tumbar el loop
        print(linea, flush=True)
        with open(BASE / "confluencia.log", "a", encoding="utf-8") as f:
            f.write(linea + "\n")
    except Exception:
        pass


# ---------------------------------------------------------------- fases Weinstein (igual que calcWeinstein del servidor)
def _ema(v, n):
    k = 2 / (n + 1)
    e = v[0]
    for x in v[1:]:
        e = x * k + e * (1 - k)
    return e


def fase(c):
    if len(c) < 30:
        return None
    c = c[-200:]
    p, e10, e20, e20p = c[-1], _ema(c, 10), _ema(c, 20), _ema(c[:-1], 20)
    if p > e20 and e10 > e20 and e20 > e20p:
        return 2
    if p < e20 and e10 < e20 and not e20 > e20p:
        return 4
    if e20 * 0.99 <= p <= e20 * 1.01:
        return 1
    return 3


def fases_5m_2m():
    import tv_velas
    v1 = tv_velas.velas("TVC:SPX", "1", 3000)
    ahora = time.time()

    def agrupar(m):
        out = []
        for x in v1:
            b = x["t"] // (m * 60) * (m * 60)
            if out and out[-1][0] == b:
                out[-1][1] = x["c"]
            else:
                out.append([b, x["c"]])
        return [c for b, c in out if b + m * 60 <= ahora + 1]   # solo velas cerradas
    c5, c2 = agrupar(5), agrupar(2)
    return {"fase5m": fase(c5), "fase2m": fase(c2), "fase2m_prev": fase(c2[:-1]) if len(c2) > 31 else None,
            "spx": v1[-1]["c"] if v1 else None}


# ---------------------------------------------------------------- votos
def votar(d, prev):
    v = {}
    b8 = d.get("bola8") or {}
    if b8.get("sesgo") and (b8.get("fuerza") or 0) >= UMBRAL_FUERZA_BOLA8:
        v["bola8"] = 1 if b8["sesgo"] == "bullish" else -1 if b8["sesgo"] == "bearish" else 0
    elif b8:
        v["bola8"] = 0
    tr = (d.get("tradytics") or {}).get("sentimiento")
    if tr:
        v["tradytics"] = 1 if tr == "bullish" else -1 if tr == "bearish" else 0
    try:   # la diferencia solo tiene sentido contra el ciclo anterior (≤ 10 min), no contra uno de hace media hora
        reciente = dt.datetime.fromisoformat(d["at"]) - dt.datetime.fromisoformat(prev["at"]) <= dt.timedelta(minutes=10)
    except Exception:
        reciente = False
    h, hp = (d.get("hiro") or {}).get("hiro_bn"), (prev.get("hiro") or {}).get("hiro_bn") if prev and reciente else None
    if h is not None and hp is not None and abs(h - hp) < 3:   # >3 Bn de salto entre barridos = lectura dudosa
        v["hiro"] = 1 if h - hp > 0.05 else -1 if h - hp < -0.05 else 0
    gb, spx = d.get("gexbot_classic") or {}, d.get("spx")
    barras = gb.get("barras") or []
    if barras and spx:
        k, largo = max(barras, key=lambda x: abs(x[1]))
        d["iman_principal"] = {"strike": k, "largo_px": largo}
        v["gexbot_iman"] = 0 if abs(k - spx) <= TOL_IMAN else (1 if k > spx else -1)
    return v


def lecturas(d, votos):
    f5, f2, f2p, spx = d.get("fase5m"), d.get("fase2m"), d.get("fase2m_prev"), d.get("spx")
    neto = sum(votos.values())
    out = {"neto_herramientas": neto, "n_votos": len(votos)}
    # A. TENDENCIA: 5m marca la tendencia mayor; 2m es el gatillo (está a favor, o acaba de girar a favor)
    a = {"senal": None, "motivo": ""}
    if f5 in (2, 4):
        lado = 1 if f5 == 2 else -1
        gatillo = f2 == f5 or (f2p is not None and f2p != f5 and f2 == f5)
        a["tendencia"] = "alcista" if lado == 1 else "bajista"
        a["gatillo_2m"] = bool(gatillo)
        if gatillo and neto * lado >= MIN_VOTOS_A:
            a["senal"] = "BULL PUT" if lado == 1 else "BEAR CALL"
            a["motivo"] = f"5m fase {f5} + gatillo 2m + herramientas {neto:+d}"
        else:
            a["motivo"] = f"5m fase {f5}; gatillo 2m {'sí' if gatillo else 'no'}; herramientas {neto:+d}"
    else:
        a["motivo"] = f"5m sin tendencia (fase {f5})"
    out["A_tendencia"] = a
    # B. FADE (Emerson): gamma positiva (precio sobre Gamma Flip GB) + precio en un Imán GB + estirado en la 2m
    gb = d.get("gexbot_classic") or {}
    flip, ip, ineg = gb.get("gamma_flip_gb"), gb.get("iman_pos_gb"), gb.get("iman_neg_gb")
    b = {"senal": None, "motivo": ""}
    if spx and flip:
        b["regimen"] = "gamma positiva (frena)" if spx > flip else "gamma negativa (acelera)"
        if spx > flip and ip and spx >= ip - TOL_IMAN and f2 == 2:
            b["senal"], b["motivo"] = "BEAR CALL", f"precio {spx:.0f} en/sobre Imán + GB {ip:.0f}, estirado alcista en 2m, gamma positiva"
        elif spx > flip and ineg and spx <= ineg + TOL_IMAN and f2 == 4:
            b["senal"], b["motivo"] = "BULL PUT", f"precio {spx:.0f} en/bajo Imán − GB {ineg:.0f}, estirado bajista en 2m, gamma positiva"
        else:
            b["motivo"] = f"{b['regimen']}; Imán + GB {ip} / Imán − GB {ineg}; fase 2m {f2}"
    else:
        b["motivo"] = "sin Gamma Flip GB o sin precio"
    out["B_fade"] = b
    return out


# ---------------------------------------------------------------- ciclo
BITACORA = "https://web-production-23473.up.railway.app"


def clave_bitacora():
    """Clave de escritura de la bitácora (la misma BITACORA_TOKEN de Railway): variable de entorno o el archivo local
    gexbot-sombra/.bitacora_token (una línea; lo crea Guillermo, nunca se imprime ni se sube a ningún repo)."""
    import os
    if os.environ.get("BITACORA_TOKEN"):
        return os.environ["BITACORA_TOKEN"].strip()
    try:
        return (BASE / ".bitacora_token").read_text(encoding="utf-8-sig").strip() or None
    except Exception:
        return None


def enviar_capas(d):
    """Empuja la lectura del ciclo a la bitácora (hoja Hiro, capas de Discord). Si falla, el ciclo sigue igual."""
    import os
    import urllib.request
    try:
        cuerpo = json.dumps({k: d.get(k) for k in ("at", "spx", "fase5m", "fase2m", "gexbot_classic", "gexbot_state",
                                                  "bola8", "tradytics", "hiro", "option_flow", "lecturas")}, ensure_ascii=False).encode("utf-8")
        h = {"Content-Type": "application/json", "User-Agent": "gexbot-sombra/1.0"}
        if clave_bitacora():
            h["x-bitacora-token"] = clave_bitacora()
        req = urllib.request.Request(BITACORA + "/api/capas/discord", data=cuerpo, headers=h, method="POST")
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status
    except Exception as e:
        log(f"capas -> bitácora: {e}")
        return None


def matar_navegador_bot():
    """Cierra el Chromium del perfil discord_profile si quedó vivo (si no, el siguiente barrido no puede abrirlo).
    Auditoría 20-nov: SOLO chrome.exe (antes coincidía con cualquier proceso que tuviera la palabra, incluida la propia
    PowerShell) y nunca lanza: se colgaba a los 30 s y tumbaba el ciclo entero (5 veces el 20-nov)."""
    ps = ("Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | "
          "? { $_.CommandLine -like '*discord_profile*' } | "
          "% { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")
    try:
        subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, timeout=60)
    except Exception as e:
        log(f"no se pudo cerrar el navegador del bot: {e}")


def ultimo_registro(carpeta):
    f = carpeta / "confluencia.jsonl"
    if not f.exists():
        return {}
    for linea in reversed(f.read_text(encoding="utf-8").strip().splitlines()):   # una línea cortada no tumba el ciclo
        try:
            return json.loads(linea)
        except Exception:
            continue
    return {}


def ciclo(dibujar=True):
    t0 = time.time()
    try:
        r_b = subprocess.run([NODE, str(BASE / "barrido_discord.mjs"), "--barrido"], cwd=BASE, timeout=420)
        if r_b.returncode != 0:   # node terminó con error: puede quedar Chromium vivo con el perfil bloqueado
            matar_navegador_bot()
    except subprocess.TimeoutExpired:
        log("barrido: superó 7 min; se cierra el navegador del bot y se sigue con lo capturado")
        matar_navegador_bot()
    hoy = dt.datetime.now(NY).strftime("%Y-%m-%d")
    carpeta = BASE / "capturas" / hoy
    carpeta.mkdir(parents=True, exist_ok=True)   # si el barrido no alcanzó a crearla, el ciclo igual sigue
    fb = carpeta / "barridos.jsonl"
    barr = {}
    if fb.exists():   # una última línea cortada no puede tumbar todos los ciclos siguientes
        for linea in reversed(fb.read_text(encoding="utf-8").strip().splitlines()):
            try:
                barr = json.loads(linea); break
            except Exception:
                continue
    # 21-nov (2.ª auditoría): solo vale el barrido de ESTE ciclo (antes "menos de 8 min" alcanzaba al ciclo anterior y
    # una captura vieja se registraba, enviaba y dibujaba como nueva)
    try:
        nuevo = dt.datetime.fromisoformat(barr["at"].replace("Z", "+00:00")).timestamp() >= t0 - 5
    except Exception:
        nuevo = False
    if not nuevo:
        barr = {}
    arch = barr.get("archivos") or {}
    if not arch:   # barrido cortado: usar las capturas sueltas tomadas en ESTE ciclo
        limite = t0 - 5
        for clave in ("gexbot_classic", "gexbot_state", "tradytics", "hiro", "option_flow"):
            fs_ = [f for f in carpeta.glob(f"*_{clave}.png") if f.stat().st_mtime >= limite]
            if fs_:
                arch[clave] = str(max(fs_, key=lambda f: f.stat().st_mtime))
        log(f"barrido incompleto; capturas sueltas usadas: {list(arch)}")
    d = {"at": dt.datetime.now(NY).isoformat(timespec="seconds")}
    lectores = {"gexbot_classic": lector.gexbot_classic, "gexbot_state": lector.gexbot_state,
                "tradytics": lector.tradytics, "hiro": lector.hiro, "option_flow": lector.quantdata}
    for clave, fn in lectores.items():
        if arch.get(clave):
            try:
                d[clave] = fn(arch[clave])
            except Exception as e:
                d[clave] = {"error": str(e)}
    # 24-nov: Option Flow con fecha de otro día (antes de la apertura Quant Data muestra la sesión anterior) no cuenta
    of = d.get("option_flow") or {}
    hoy = dt.datetime.now(NY).date().isoformat()
    if of.get("fecha") and of["fecha"] != hoy:
        log(f"option_flow descartado: la tabla es del {of['fecha']}, no de hoy ({hoy})")
        d.pop("option_flow")
    # la Bola 8 más reciente, sea imagen (Sonar) o texto (desde 20-nov); el nombre lleva la hora del informe
    b8 = sorted(list(carpeta.glob("bola8_*_sonar.png")) + list(carpeta.glob("bola8_*_texto.txt")),
                key=lambda f: f.name.split("_")[1])
    if b8:
        f = b8[-1]
        # solo si es reciente (≤ 20 min; el nombre trae la hora UTC AAAAMMDDhhmm): una Bola 8 de horas atrás no vota
        try:
            marca = dt.datetime.strptime(f.name.split("_")[1][:12], "%Y%m%d%H%M").replace(tzinfo=dt.timezone.utc)
            fresca = dt.datetime.now(dt.timezone.utc) - marca <= dt.timedelta(minutes=20)
        except Exception:
            fresca = False
        if fresca:
            try:
                b8d = lector.bola8_texto(str(f)) if f.suffix == ".txt" else lector.bola8_sonar(str(f))
                if b8d:
                    d["bola8"] = b8d
                    d["bola8"]["archivo"] = f.name
            except Exception as e:
                log(f"bola8 ilegible ({f.name}): {e}")
    try:
        d.update(fases_5m_2m())
    except Exception as e:
        log(f"fases: {e}")
    spx = d.get("spx")
    for clave in ("gexbot_classic", "gexbot_state"):
        lec = d.get(clave) or {}
        br = lec.get("barras") or []
        if spx and br and sorted(abs(k - spx) for k, *_ in br)[len(br) // 2] > 300:
            log(f"{clave}: histograma descartado (strikes {br[0][0]:.0f}-{br[-1][0]:.0f} lejos del SPX {spx:.0f}: eje mal anclado)")
            lec["barras_descartadas"] = len(br)
            for campo in ("barras", "sombras", "puntos", "perfil"):
                lec.pop(campo, None)
    prev = ultimo_registro(carpeta)
    d["votos"] = votar(d, prev)
    d["lecturas"] = lecturas(d, d["votos"])
    with open(carpeta / "confluencia.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(d, ensure_ascii=False) + "\n")
    enviar_capas(d)   # 20-nov: a la hoja Hiro de la bitácora (capas de Discord)
    A, B = d["lecturas"]["A_tendencia"], d["lecturas"]["B_fade"]
    log(f"SPX {d.get('spx')} | 5m {d.get('fase5m')} 2m {d.get('fase2m')} | votos {d['votos']} | "
        f"A: {A['senal'] or '—'} ({A['motivo']}) | B: {B['senal'] or '—'} ({B['motivo']}) | {time.time() - t0:.0f}s")
    if dibujar:
        # ancla del histograma: la vela de 2 min en curso; fuera de horario, la última vela de la sesión (15:58 ET),
        # porque a la derecha de la última vela TradingView colapsa los dibujos.
        ahora = dt.datetime.now(NY)
        cierre = ahora.replace(hour=15, minute=58, second=0, microsecond=0)
        d["ancla_ts"] = int(min(ahora, cierre).timestamp()) // 120 * 120
        (BASE / "ultimo_dibujo.json").write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
        try:   # si TradingView no responde, el ciclo sigue (y corre gexbot_propio igual)
            r = subprocess.run([NODE, str(BASE / "tv_dibujar.mjs"), str(BASE / "ultimo_dibujo.json")], cwd=BASE,
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
            log("TV: " + (r.stdout.strip() or r.stderr.strip()[-200:]))
        except Exception as e:
            log(f"TV: {e}")
    try:
        r = subprocess.run([sys.executable, str(BASE / "gexbot_propio.py")], cwd=BASE, timeout=120, capture_output=True,
                           text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0:
            log(f"gexbot_propio: código {r.returncode} · {(r.stderr or '').strip()[-200:]}")
    except Exception as e:
        log(f"gexbot_propio: {e}")
    return d


def una_sola_instancia():
    """Dos instancias a la vez se pisan el perfil de Discord (y una cerraría el navegador de la otra): la segunda sale."""
    import msvcrt
    global _CANDADO
    _CANDADO = open(BASE / "confluencia.lock", "a+")
    try:
        msvcrt.locking(_CANDADO.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        log("ya hay otra instancia de confluencia corriendo: esta sale sin hacer nada")
        sys.exit(0)


if __name__ == "__main__":
    una_sola_instancia()
    if "--loop" in sys.argv:
        seg = int(sys.argv[sys.argv.index("--loop") + 1])
        log(f"loop cada {seg}s")
        while True:
            ahora = dt.datetime.now(NY)
            cierre = cierre_del_dia(ahora.date())
            if cierre is None:
                log("hoy no hay mercado (fin de semana o feriado NYSE): el loop termina")
                break
            if dt.time(9, 25) <= ahora.time() <= cierre:
                t = time.time()
                try:
                    ciclo()
                except Exception as e:
                    log(f"ciclo error: {e}")
                time.sleep(max(10, seg - (time.time() - t)))
            elif ahora.time() > (dt.datetime.combine(ahora.date(), cierre) + dt.timedelta(minutes=5)).time():
                log("fin de la sesión: el loop termina (la Tarea Programada lo lanza de nuevo mañana)")
                break
            else:
                time.sleep(60)
    else:
        ciclo(dibujar="--sin-tv" not in sys.argv)
