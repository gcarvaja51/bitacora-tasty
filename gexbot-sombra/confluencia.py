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
      python confluencia.py --continuo (24-nov) NO lanza el barrido: lee cada 10 s las capturas nuevas que deja
                                       barrido_discord.mjs --continuo y envía cada lectura con su hora de captura.
                                       Opciones: --carpeta <dir> (otra carpeta de capturas), --sin-envio (no toca la
                                       bitácora), --sin-tv (no dibuja), --prueba (sin horario ni vigilante; sale tras 30 s
                                       sin capturas nuevas)
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
try:   # en los procesos lectores del modo continuo stdout puede no existir
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
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


# ================================================================ MODO CONTINUO (24-nov-2026)
# "Estamos en 0 DTE y en scalping, cada minuto cuenta" (Guillermo). El capturador (barrido_discord.mjs --continuo) deja
# el navegador abierto todo el día y escribe capturas sueltas; aquí NO se lanza ningún barrido: cada 10 s se buscan
# capturas NUEVAS en capturas/<hoy>/ y se leen SOLO esas (en procesos aparte: el OCR de option flow tarda ~40 s y no
# puede frenar a las demás). Estado en memoria con la última lectura de cada fuente y su HORA DE CAPTURA.
#
# Envío a la bitácora: cada registro lleva "at" = hora de captura y SOLO las fuentes nuevas (la hoja calcula la antigüedad
# de cada fuente con el "at" del registro donde aparece; reenviar una lectura vieja con hora nueva la haría parecer
# fresca). La bitácora acepta como mucho 800 registros por día (server.js, /api/capas/discord): con una captura por
# escenario por minuto serían ~2.000, así que las lecturas nuevas que llegan juntas (una vuelta del capturador, ~35 s)
# van en UN registro con "at" = la captura MÁS VIEJA del grupo (nunca parece más fresca de lo que es), y hay además un
# presupuesto diario repartido en la sesión (TOPE_CAPAS_DIA).
CLAVES_ESC = ("gexbot_classic", "gexbot_state", "tradytics", "hiro", "option_flow")
FUENTES = CLAVES_ESC + ("bola8",)
MAX_EDAD_VOTO = {"hiro": 10, "bola8": 20, "tradytics": 15, "gexbot_classic": 15}   # minutos (desde la captura)
MAX_EDAD_VIGILANTE = {"bola8": 20}   # la Bola 8 publica cada 15 min; el resto de fuentes: 10 min
AGRUPAR_SEG = 40          # una lectura nueva espera hasta 40 s a que lleguen las demás de la misma vuelta
TOPE_CAPAS_DIA = 780      # la bitácora corta en 800 (subirlo aquí si se sube allá)
WA_DIR = Path("C:/Users/gcarv/Documents/CARPETA PERSONAL/whatsapp")


def _leer_captura(clave, ruta):
    """Corre en un proceso aparte (ProcessPoolExecutor): el lector de cada fuente."""
    if clave == "bola8":
        return lector.bola8_texto(ruta) if ruta.endswith(".txt") else lector.bola8_sonar(ruta)
    return {"gexbot_classic": lector.gexbot_classic, "gexbot_state": lector.gexbot_state, "tradytics": lector.tradytics,
            "hiro": lector.hiro, "option_flow": lector.quantdata}[clave](ruta)


def hora_captura(f, fecha):
    """Hora de captura (NY, aware). Escenarios: HHMMSS del nombre (ya en NY). Bola 8: marca AAAAMMDDhhmm UTC del informe."""
    n = f.name
    if n.startswith("bola8_"):
        return dt.datetime.strptime(n.split("_")[1][:12], "%Y%m%d%H%M").replace(tzinfo=dt.timezone.utc).astimezone(NY)
    h = n[:6]
    return dt.datetime.combine(dt.date.fromisoformat(fecha), dt.time(int(h[:2]), int(h[2:4]), int(h[4:6])), tzinfo=NY)


def avisar_whatsapp(texto):
    """Aviso a Guillermo (línea Colombia, chat propio) por GOWA local, como avisarSesion de barrido_discord.mjs."""
    import base64
    import re
    import urllib.request
    try:
        cfg = json.loads((WA_DIR / "cuentas.json").read_text(encoding="utf-8"))["colombia"]
        cred = (WA_DIR / "credenciales.txt").read_text(encoding="utf-8")
        u = re.search(r"usuario:\s*(\S+)", cred).group(1)
        pw = re.search(r"password:\s*(\S+)", cred).group(1)
        req = urllib.request.Request("http://127.0.0.1:3001/send/message", method="POST",
                                     data=json.dumps({"phone": "573186252537@s.whatsapp.net", "message": texto}).encode("utf-8"),
                                     headers={"Content-Type": "application/json", "X-Device-Id": cfg["device_id"],
                                              "Authorization": "Basic " + base64.b64encode(f"{u}:{pw}".encode()).decode()})
        with urllib.request.urlopen(req, timeout=15) as r:
            log(f"vigilante: aviso por WhatsApp ({r.status})")
            return True
    except Exception as e:
        log(f"vigilante: no se pudo avisar por WhatsApp ({e})")
        return False


class Continuo:
    def __init__(self, carpeta=None, sin_envio=False, sin_tv=False, prueba=False):
        from concurrent.futures import ProcessPoolExecutor
        self.carpeta_fija = Path(carpeta).resolve() if carpeta else None
        self.sin_envio, self.sin_tv, self.prueba = sin_envio, sin_tv or prueba, prueba
        self.pool = ProcessPoolExecutor(max_workers=3)
        self.estado = {}          # clave -> lectura (con "capturado_at" y "archivo")
        self.capt = {}            # clave -> datetime de captura
        self.hiro_prev = None     # (datetime, lectura) de la lectura de HIRO anterior
        self.visto = {}           # clave -> mtime del último archivo tomado (bola8: marca)
        self.en_curso = {}        # clave -> (future, ruta, datetime)
        self.pend = {}            # clave -> (datetime, lectura) leídas y aún no enviadas
        self.fases = {}
        self.t_fases = 0
        self.tv = None
        self.tv_t = 0
        self.tv_pendiente = False
        self.gp = None
        self.gp_t = 0
        self.avisos = {}          # motivo -> epoch del último aviso
        self.enviados = None      # registros enviados hoy (se lee/guarda en capas_enviadas.json)
        self.ultima_novedad = time.time()

    # ---------------------------------------------------------------- carpeta / fecha
    def fecha(self):
        return self.carpeta_fija.name if self.carpeta_fija else dt.datetime.now(NY).strftime("%Y-%m-%d")

    def carpeta(self):
        c = self.carpeta_fija or (BASE / "capturas" / self.fecha())
        c.mkdir(parents=True, exist_ok=True)
        return c

    # ---------------------------------------------------------------- 1. buscar capturas nuevas
    def buscar(self):
        c, fecha = self.carpeta(), self.fecha()
        for clave in CLAVES_ESC:
            if clave in self.en_curso:
                continue   # se termina la que se está leyendo; la próxima búsqueda toma la más nueva
            fs_ = [f for f in c.glob(f"*_{clave}.png") if f.name[:6].isdigit()]
            if not fs_:
                continue
            f = max(fs_, key=lambda x: x.stat().st_mtime)
            m = f.stat().st_mtime
            if m > self.visto.get(clave, 0):
                self.visto[clave] = m
                self.lanzar(clave, f, hora_captura(f, fecha))
        if "bola8" not in self.en_curso:
            marcas = {}
            for f in list(c.glob("bola8_*_sonar.png")) + list(c.glob("bola8_*_texto.txt")):
                marca = f.name.split("_")[1][:12]
                if f.suffix == ".png" or marca not in marcas:   # si hay Sonar e informe en texto de la misma hora, Sonar
                    marcas[marca] = f
            if marcas:
                marca = max(marcas)
                if marca > str(self.visto.get("bola8", "")):
                    self.visto["bola8"] = marca
                    f = marcas[marca]
                    h = hora_captura(f, fecha)
                    if h.date().isoformat() != fecha:   # la 1.ª pasada del día trae el último informe de ayer
                        log(f"bola8 de otro día, se omite: {f.name}")
                    else:
                        self.lanzar("bola8", f, h)

    def lanzar(self, clave, f, h):
        from concurrent.futures.process import BrokenProcessPool
        try:
            self.en_curso[clave] = (self.pool.submit(_leer_captura, clave, str(f)), f, h, time.time())
        except (BrokenProcessPool, RuntimeError):
            from concurrent.futures import ProcessPoolExecutor
            log("lector: el grupo de procesos se cayó; se vuelve a crear")
            self.pool = ProcessPoolExecutor(max_workers=3)
            self.en_curso[clave] = (self.pool.submit(_leer_captura, clave, str(f)), f, h, time.time())

    # ---------------------------------------------------------------- 2. recoger lecturas terminadas
    def recoger(self):
        nuevas = []
        for clave, (fut, f, h, t0) in list(self.en_curso.items()):
            if not fut.done():
                if time.time() - t0 > 180:
                    log(f"{clave}: el lector pasó de 3 min con {f.name}; se abandona")
                    self.en_curso.pop(clave)
                continue
            self.en_curso.pop(clave)
            try:
                lec = fut.result()
            except Exception as e:
                lec = {"error": str(e)}
            if clave == "bola8" and not lec:
                log(f"bola8 ilegible ({f.name})")
                continue
            lec = dict(lec or {})
            if clave == "option_flow" and lec.get("fecha") and lec["fecha"] != self.fecha():
                log(f"option_flow descartado: la tabla es del {lec['fecha']}, no de hoy ({self.fecha()})")
                continue
            if clave in ("gexbot_classic", "gexbot_state"):
                self.descartar_lejos(clave, lec)
            lec["capturado_at"] = h.isoformat(timespec="seconds")
            lec["archivo"] = f.name
            if clave == "hiro" and self.estado.get("hiro") and not self.estado["hiro"].get("error"):
                self.hiro_prev = (self.capt["hiro"], self.estado["hiro"])
            self.estado[clave], self.capt[clave] = lec, h
            if not lec.get("error"):
                self.pend[clave] = (h, lec)
            nuevas.append(clave)
            log(f"{clave}: leída {f.name} (captura {h:%H:%M:%S}, lectura {time.time() - t0:.0f}s)"
                + (f" · error: {lec['error']}" if lec.get("error") else ""))
        return nuevas

    def descartar_lejos(self, clave, lec):
        spx = self.precio().get("spx")
        br = lec.get("barras") or []
        if spx and br and sorted(abs(k - spx) for k, *_ in br)[len(br) // 2] > 300:
            log(f"{clave}: histograma descartado (strikes {br[0][0]:.0f}-{br[-1][0]:.0f} lejos del SPX {spx:.0f}: eje mal anclado)")
            lec["barras_descartadas"] = len(br)
            for campo in ("barras", "sombras", "puntos", "perfil"):
                lec.pop(campo, None)

    def precio(self):
        """Fases 5m/2m y SPX, con caché de 30 s (son velas de 1 min)."""
        if time.time() - self.t_fases > 30:
            self.t_fases = time.time()
            try:
                self.fases = fases_5m_2m()
            except Exception as e:
                log(f"fases: {e}")
        return self.fases

    # ---------------------------------------------------------------- 3. votos y lecturas con el estado completo
    def evaluar(self, nuevas):
        ahora = dt.datetime.now(NY)
        d = {"at": ahora.isoformat(timespec="seconds"), "modo": "continuo", "nuevas": nuevas}
        d.update(self.precio())
        for k in FUENTES:
            if k in self.estado:
                d[k] = self.estado[k]
        # para votar solo cuentan las fuentes recientes (por su hora de CAPTURA, no la del registro)
        dv = {k: v for k, v in d.items() if k not in FUENTES}
        for k in FUENTES:
            lim = MAX_EDAD_VOTO.get(k)
            if k in self.estado and not self.estado[k].get("error") and (lim is None or ahora - self.capt[k] <= dt.timedelta(minutes=lim)):
                dv[k] = self.estado[k]
        prev = {}
        if "hiro" in dv:   # HIRO vota por la diferencia contra la lectura anterior, si hay ≤ 10 min entre las dos capturas
            dv["at"] = self.capt["hiro"].isoformat()
            if self.hiro_prev:
                prev = {"at": self.hiro_prev[0].isoformat(), "hiro": self.hiro_prev[1]}
        d["votos"] = votar(dv, prev)
        if "iman_principal" in dv:
            d["iman_principal"] = dv["iman_principal"]
        d["lecturas"] = lecturas(dv, d["votos"])   # B (fade) usa el GexBot Classic solo si está fresco
        with open(self.carpeta() / "confluencia.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")
        A, B = d["lecturas"]["A_tendencia"], d["lecturas"]["B_fade"]
        log(f"[{','.join(nuevas)}] SPX {d.get('spx')} | 5m {d.get('fase5m')} 2m {d.get('fase2m')} | votos {d['votos']} | "
            f"A: {A['senal'] or '—'} ({A['motivo']}) | B: {B['senal'] or '—'} ({B['motivo']})")
        return d

    # ---------------------------------------------------------------- 4. envío a la bitácora (agrupado y con presupuesto)
    def _contador(self, sumar=0):
        f = BASE / "capas_enviadas.json"
        if self.enviados is None:
            try:
                j = json.loads(f.read_text(encoding="utf-8"))
                self.enviados = j["n"] if j.get("fecha") == self.fecha() else 0
            except Exception:
                self.enviados = 0
        if sumar:
            self.enviados += sumar
            try:
                f.write_text(json.dumps({"fecha": self.fecha(), "n": self.enviados}), encoding="utf-8")
            except Exception:
                pass
        return self.enviados

    def permitido(self):
        if self.prueba:
            return True
        n = self._contador()
        if n >= TOPE_CAPAS_DIA:
            return False
        ahora = dt.datetime.now(NY)
        cierre = cierre_del_dia(ahora.date()) or dt.time(16, 0)
        ini = dt.datetime.combine(ahora.date(), dt.time(9, 25), tzinfo=NY)
        fin = dt.datetime.combine(ahora.date(), cierre, tzinfo=NY)
        frac = min(1.0, max(0.0, (ahora - ini) / (fin - ini)))
        return n < TOPE_CAPAS_DIA * frac + 40   # repartido en la sesión, con 40 de holgura para ráfagas

    def enviar(self, d, forzar=False):
        if not self.pend:
            return
        mas_vieja = min(h for h, _ in self.pend.values())
        if not forzar and (dt.datetime.now(NY) - mas_vieja).total_seconds() < AGRUPAR_SEG:
            return
        if not self.permitido():
            if not self.avisos.get("presupuesto"):
                log(f"capas -> bitácora: presupuesto del día en uso ({self._contador()} registros); se espera")
                self.avisos["presupuesto"] = time.time()
            return
        self.avisos.pop("presupuesto", None)
        reg = {"at": mas_vieja.isoformat(timespec="seconds"), "spx": d.get("spx"), "fase5m": d.get("fase5m"),
               "fase2m": d.get("fase2m"), "lecturas": d.get("lecturas")}
        for k, (_, lec) in self.pend.items():
            reg[k] = lec
        claves = sorted(self.pend)
        self.pend = {}
        if self.sin_envio:
            log(f"[sin envío] enviaría at={reg['at']} con {claves} + spx {reg['spx']} fase5m {reg['fase5m']} fase2m {reg['fase2m']}")
            with open(self.carpeta() / "capas_simuladas.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps({"at": reg["at"], "fuentes": claves, "capturado_at": {k: reg[k].get("capturado_at") for k in claves},
                                    "spx": reg["spx"]}, ensure_ascii=False) + "\n")
            return
        st = enviar_capas(reg)
        self._contador(1)
        log(f"capas -> bitácora: at={reg['at']} {claves} ({st})")

    # ---------------------------------------------------------------- 5. TradingView y gexbot_propio en segundo plano
    def dibujar(self, d):
        if self.sin_tv:
            return
        ahora = dt.datetime.now(NY)
        cierre = ahora.replace(hour=15, minute=58, second=0, microsecond=0)
        d = dict(d, ancla_ts=int(min(ahora, cierre).timestamp()) // 120 * 120)
        (BASE / "ultimo_dibujo.json").write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
        self.tv_pendiente = True
        self.segundo_plano()

    def segundo_plano(self):
        if self.sin_tv:
            return
        if self.tv is not None and self.tv.poll() is not None:
            try:
                out = (self.tv.stdout.read() or "").strip()
            except Exception:
                out = ""
            log(f"TV ({time.time() - self.tv_t:.0f}s): {out[-200:] or 'código ' + str(self.tv.returncode)}")
            self.tv = None
        if self.tv is not None and time.time() - self.tv_t > 90:
            log("TV: tv_dibujar pasó de 90 s; se corta")
            self.tv.kill()
            self.tv = None
        if self.tv is None and self.tv_pendiente:
            self.tv_pendiente = False
            self.tv_t = time.time()
            try:
                self.tv = subprocess.Popen([NODE, str(BASE / "tv_dibujar.mjs"), str(BASE / "ultimo_dibujo.json")], cwd=BASE,
                                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                                           errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            except Exception as e:
                log(f"TV: {e}")
        # gexbot_propio cada 3 min
        if self.gp is not None and self.gp.poll() is not None:
            if self.gp.returncode != 0:
                log(f"gexbot_propio: código {self.gp.returncode}")
            self.gp = None
        if self.gp is not None and time.time() - self.gp_t > 150:
            log("gexbot_propio: pasó de 150 s; se corta")
            self.gp.kill()
            self.gp = None
        if self.gp is None and time.time() - self.gp_t >= 180:
            self.gp_t = time.time()
            try:
                self.gp = subprocess.Popen([sys.executable, str(BASE / "gexbot_propio.py")], cwd=BASE, stdout=subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            except Exception as e:
                log(f"gexbot_propio: {e}")

    # ---------------------------------------------------------------- 6. vigilante
    def vigilar(self, cierre):
        if self.prueba:
            return
        ahora = dt.datetime.now(NY)
        if not (dt.time(9, 28) <= ahora.time() <= cierre):
            return
        motivos = []
        try:
            lat = float((BASE / "latido_captura.txt").read_text(encoding="utf-8").strip()) / 1000
            if time.time() - lat > 180:
                motivos.append(("latido", f"el capturador de Discord no da señales hace {(time.time() - lat) / 60:.0f} min"))
        except Exception:
            motivos.append(("latido", "no hay latido del capturador de Discord (latido_captura.txt)"))
        if ahora.time() >= dt.time(9, 40):
            for k in FUENTES:
                lim = MAX_EDAD_VIGILANTE.get(k, 10)
                ref = self.capt.get(k) or dt.datetime.combine(ahora.date(), dt.time(9, 30), tzinfo=NY)
                edad = (ahora - ref).total_seconds() / 60
                if edad > lim:
                    motivos.append((k, f"{k}: {edad:.0f} min sin captura nueva"))
        nuevos = [(m, t) for m, t in motivos if time.time() - self.avisos.get(m, 0) >= 3600]
        for m, t in motivos:
            if m in dict(nuevos):
                log(f"vigilante: {t}")
        if nuevos:
            for m, _ in nuevos:
                self.avisos[m] = time.time()
            avisar_whatsapp(f"⚠️ GexBot sombra ({ahora:%H:%M} ET): " + "; ".join(t for _, t in nuevos)
                            + ". Revisar barrido_continuo.log / confluencia.log en el PC.")

    # ---------------------------------------------------------------- bucle
    def paso(self, buscar=True):
        if buscar:
            self.buscar()
        nuevas = self.recoger()
        if nuevas:
            self.ultima_novedad = time.time()
            d = self.evaluar(nuevas)
            if "gexbot_classic" in nuevas and (self.estado["gexbot_classic"].get("barras") or self.estado["gexbot_classic"].get("gamma_flip_gb")):
                self.dibujar(d)
            self.d = d
        if getattr(self, "d", None):
            self.enviar(self.d)
        self.segundo_plano()

    def cerrar(self):
        t = time.time()
        while self.en_curso and time.time() - t < 120:   # que terminen las lecturas en curso
            self.paso(buscar=False)
            time.sleep(1)
        if getattr(self, "d", None):
            self.enviar(self.d, forzar=True)
        self.pool.shutdown(wait=False, cancel_futures=True)
        for p in (self.tv, self.gp):
            if p is not None and p.poll() is None:
                try:
                    p.wait(timeout=60)
                except Exception:
                    p.kill()


def modo_continuo(argv):
    carpeta = argv[argv.index("--carpeta") + 1] if "--carpeta" in argv else None
    c = Continuo(carpeta=carpeta, sin_envio="--sin-envio" in argv, sin_tv="--sin-tv" in argv, prueba="--prueba" in argv)
    log(f"continuo: arranca (lee capturas nuevas cada 10 s{'; PRUEBA' if c.prueba else ''}{'; sin envío' if c.sin_envio else ''}"
        f"{' · carpeta ' + str(c.carpeta_fija) if c.carpeta_fija else ''})")
    t_buscar = 0
    try:
        while True:
            ahora = dt.datetime.now(NY)
            if c.prueba:
                cierre = dt.time(23, 59)
                if time.time() - c.ultima_novedad > 30 and not c.en_curso and not c.pend:
                    log("continuo (prueba): sin capturas nuevas en 30 s: termina")
                    break
            else:
                cierre = cierre_del_dia(ahora.date())
                if cierre is None:
                    log("hoy no hay mercado (fin de semana o feriado NYSE): el modo continuo termina")
                    break
                if ahora.time() > (dt.datetime.combine(ahora.date(), cierre) + dt.timedelta(minutes=5)).time():
                    log("fin de la sesión: el modo continuo termina (la Tarea Programada lo lanza de nuevo mañana)")
                    break
                if ahora.time() < dt.time(9, 25):
                    time.sleep(20)
                    continue
            try:
                buscar = time.time() - t_buscar >= 10
                if buscar:
                    t_buscar = time.time()
                c.paso(buscar=buscar)
                c.vigilar(cierre)
            except Exception as e:
                log(f"continuo: error en el paso: {e}")
            time.sleep(2)
    finally:
        c.cerrar()
        log("continuo: cerrado")


def limpiar_capturador():
    """Lo llama confluencia_diaria.cmd al final: el capturador continuo debería haber salido solo (cierre + 2 min); si
    sigue vivo, se cierra SOLO ese node (por su línea de comando) y el Chromium de discord_profile. Con la sesión en
    curso NO se toca nada (p. ej. una segunda corrida de la tarea que salió por el candado no puede tumbar la buena)."""
    ahora = dt.datetime.now(NY)
    cierre = cierre_del_dia(ahora.date())
    if cierre and ahora < dt.datetime.combine(ahora.date(), cierre, tzinfo=NY) + dt.timedelta(minutes=2):
        log("limpieza: la sesión sigue en curso; no se toca el capturador")
        return
    ps_vivo = ("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | "
               "? { $_.CommandLine -like '*barrido_discord.mjs*--continuo*' } | % { $_.ProcessId }")
    for i in range(7):
        try:
            r = subprocess.run(["powershell", "-NoProfile", "-Command", ps_vivo], capture_output=True, text=True, timeout=60)
            pids = r.stdout.split()
        except Exception as e:
            log(f"limpieza: no se pudo revisar ({e})")
            pids = []
        if not pids:
            break
        if i == 6:
            log(f"limpieza: el capturador sigue vivo ({pids}); se cierra")
            subprocess.run(["powershell", "-NoProfile", "-Command", ps_vivo.replace("% { $_.ProcessId }",
                            "% { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")], capture_output=True, timeout=60)
            break
        time.sleep(10)
    matar_navegador_bot()
    log("limpieza: capturador y navegador del bot cerrados")


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
    if "--limpiar-capturador" in sys.argv:
        limpiar_capturador()
        sys.exit(0)
    una_sola_instancia()
    if "--continuo" in sys.argv:
        modo_continuo(sys.argv)
    elif "--loop" in sys.argv:
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
