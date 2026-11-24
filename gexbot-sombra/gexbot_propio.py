# -*- coding: utf-8 -*-
"""
GexBot Classic "propio" (sombra) - 19-nov-2026.

Replica gratis los niveles de GexBot Classic con la cadena 0DTE de SPX de TastyTrade
que ya expone el servidor de la bitacora (/api/option-chain/SPX). No toca produccion:
solo LEE la cadena y escribe en esta carpeta.

Niveles (los mismos dos bloques que muestra GexBot Classic):
  volume:        GEX por strike usando el VOLUMEN del dia  -> zero gamma, major positive, major negative, net gex
  open interest: GEX por strike usando el OI               -> major positive, major negative, net gex
  max change:    strike con mayor cambio de GEX(volumen) contra hace 1/5/10/15/30 min (necesita historial)

GEX de un strike = (gamma_call * N_call - gamma_put * N_put) * 100 * S^2 * 0.01   (convencion clasica:
dealers largos calls / cortos puts). Zero gamma = precio hipotetico donde la GEX total (recalculada con
Black-Scholes a ese precio) cambia de signo.

Uso:
  python gexbot_propio.py            -> una lectura, imprime y agrega a historial_AAAA-MM-DD.jsonl
  python gexbot_propio.py --loop 60  -> lee cada 60 s en horario de mercado
"""
import datetime as dt
import json
import math
import sys
import time
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent
API = "https://web-production-23473.up.railway.app/api/option-chain/SPX"
# 21-nov (2.ª auditoría): hora de NY con horario de verano (antes -5 fijo: de marzo a noviembre todo 1 h corrido)
from zoneinfo import ZoneInfo
NY = ZoneInfo("America/New_York")
CALENDARIO = BASE.parent.parent / "Bitacoras" / "bitacora-tasty" / "src" / "calendario_nyse.json"
VENTANAS = (1, 5, 10, 15, 30)
sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def cadena():
    for intento in range(4):   # Railway da 502 sueltos
        try:
            with urllib.request.urlopen(urllib.request.Request(API, headers={"User-Agent": "Mozilla/5.0"}), timeout=90) as r:
                return json.load(r)
        except Exception:
            if intento == 3:
                raise
            time.sleep(5)


def bs_gamma(S, K, iv, T):
    if iv <= 0 or T <= 0 or S <= 0:
        return 0.0
    v = iv * math.sqrt(T)
    d1 = (math.log(S / K) + 0.5 * iv * iv * T) / v
    return math.exp(-0.5 * d1 * d1) / (math.sqrt(2 * math.pi) * S * v)


def anios_al_cierre(ahora):
    hora = 16
    try:   # medio día NYSE (calendario de la bitácora): la sesión cierra a las 13:00
        if ahora.date().isoformat() in (json.loads(CALENDARIO.read_text(encoding="utf-8")).get("mediosDias") or []):
            hora = 13
    except Exception:
        pass
    cierre = ahora.replace(hour=hora, minute=0, second=0, microsecond=0)
    minutos = max((cierre - ahora).total_seconds() / 60, 30)   # piso de 30 min: tras el cierre la gamma degenera
    return minutos / (365 * 24 * 60)


def gex_por_strike(strikes, S, campo):
    m = {}
    for s in strikes:
        c, p = s.get("call") or {}, s.get("put") or {}
        g = ((c.get("gamma") or 0) * (c.get(campo) or 0) - (p.get("gamma") or 0) * (p.get(campo) or 0)) * 100 * S * S * 0.01
        m[s["strike"]] = g
    return m


def zero_gamma(strikes, S, campo, T):
    """Barre precios +-4% y busca el cruce de signo de la GEX total recalculada (el mas cercano al spot)."""
    def total(x):
        t = 0.0
        for s in strikes:
            c, p = s.get("call") or {}, s.get("put") or {}
            K = s["strike"]
            ivc = (c.get("iv") or 0) / 100
            ivp = (p.get("iv") or 0) / 100
            t += (bs_gamma(x, K, ivc, T) * (c.get(campo) or 0) - bs_gamma(x, K, ivp, T) * (p.get(campo) or 0)) * 100 * x * x * 0.01
        return t
    precios = [S * (0.96 + i * 0.0005) for i in range(161)]
    vals = [total(x) for x in precios]
    cruces = []
    for i in range(1, len(precios)):
        if vals[i - 1] == 0 or (vals[i - 1] < 0) != (vals[i] < 0):
            a, b, va, vb = precios[i - 1], precios[i], vals[i - 1], vals[i]
            cruces.append(a + (b - a) * (abs(va) / (abs(va) + abs(vb))) if va != vb else a)
    return round(min(cruces, key=lambda x: abs(x - S)), 2) if cruces else None


def niveles(m):
    if not m:
        return None, None, 0.0
    pos = max(m.items(), key=lambda kv: kv[1])
    neg = min(m.items(), key=lambda kv: kv[1])
    return pos[0], neg[0], sum(m.values()) / 1e9


def leer():
    d = cadena()
    ahora = dt.datetime.now(NY)
    hoy = ahora.strftime("%Y-%m-%d")
    exps = d.get("expirations") or []
    exp = next((e for e in exps if e["expiry"] == hoy), None) or next((e for e in exps if e["expiry"] >= hoy), exps[0])
    S = float(d.get("underlyingPrice") or 0)
    if S < 1000:   # la cadena a veces viene sin spot: se usa el del calculo de muros propios
        with urllib.request.urlopen(API.replace("option-chain/SPX", "spx/muros-propios"), timeout=90) as r:
            S = float(json.load(r).get("spxPrice") or 0)
    strikes = [s for s in exp["strikes"] if abs(s["strike"] - S) <= S * 0.06]
    T = anios_al_cierre(ahora)
    gv, go = gex_por_strike(strikes, S, "volume"), gex_por_strike(strikes, S, "oi")
    vp, vn, vnet = niveles(gv)
    op, on, onet = niveles(go)
    return {
        "at": ahora.isoformat(timespec="seconds"), "expiry": exp["expiry"], "spot": S,
        "volume": {"zero_gamma": zero_gamma(strikes, S, "volume", T), "major_positive": vp, "major_negative": vn,
                   "net_gex_bn": round(vnet, 3)},
        "open_interest": {"major_positive": op, "major_negative": on, "net_gex_bn": round(onet, 3)},
        "perfil_volume": {str(k): round(v / 1e9, 4) for k, v in sorted(gv.items())},
    }


def max_change(lectura, historial):
    """Strike con mayor |cambio| de GEX(volumen) contra la lectura de hace N minutos."""
    t = dt.datetime.fromisoformat(lectura["at"])
    out = {}
    for n in VENTANAS:
        objetivo = t - dt.timedelta(minutes=n)
        previas = [h for h in historial if dt.datetime.fromisoformat(h["at"]) <= objetivo]
        if not previas:
            continue
        prev = previas[-1]["perfil_volume"]
        cambios = {k: v - prev.get(k, 0.0) for k, v in lectura["perfil_volume"].items()}
        k, v = max(cambios.items(), key=lambda kv: abs(kv[1]))
        out[f"{n}m"] = {"strike": float(k), "cambio_bn": round(v, 4)}
    return out


def una_vez():
    lec = leer()
    f = BASE / f"historial_{lec['at'][:10]}.jsonl"
    hist = []
    for x in (f.read_text(encoding="utf-8").splitlines() if f.exists() else []):
        try:   # una línea cortada no puede hacer fallar todos los ciclos del día
            hist.append(json.loads(x))
        except Exception:
            pass
    lec["max_change"] = max_change(lec, hist)
    with open(f, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(lec, ensure_ascii=False) + "\n")
    v, o = lec["volume"], lec["open_interest"]
    print(f"{lec['at']}  spot {lec['spot']}  venc {lec['expiry']}")
    print(f"  volume: zero gamma {v['zero_gamma']} | major + {v['major_positive']} | major - {v['major_negative']} | net {v['net_gex_bn']} Bn")
    print(f"  OI:     major + {o['major_positive']} | major - {o['major_negative']} | net {o['net_gex_bn']} Bn")
    if lec["max_change"]:
        print("  max change: " + " | ".join(f"{k} {x['strike']} ({x['cambio_bn']:+.3f})" for k, x in lec["max_change"].items()))
    return lec


if __name__ == "__main__":
    if "--loop" in sys.argv:
        seg = int(sys.argv[sys.argv.index("--loop") + 1])
        while True:
            ahora = dt.datetime.now(NY)
            if ahora.weekday() < 5 and dt.time(9, 30) <= ahora.time() <= dt.time(16, 0):
                try:
                    una_vez()
                except Exception as e:
                    print("error:", e)
            time.sleep(seg)
    else:
        una_vez()
