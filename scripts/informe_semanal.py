# -*- coding: utf-8 -*-
"""
Informe semanal de ejecucion — TastyTrade (cuenta REAL) y Tradier (sandbox/DEMO).

Dos fases, mismo patron que el Contador y el Auditor: la aritmetica la hace este
script (determinista, se puede re-correr y da la misma cifra); la lectura —veredicto,
lo bueno/malo/feo y el plan— la escribe Claude en un JSON aparte, y este mismo
script la ensambla en HTML + PDF.

    python scripts/informe_semanal.py datos   [--semana 2026-09-21]
    python scripts/informe_semanal.py render  [--semana 2026-09-21]

--semana es el LUNES de la semana (hora ET). Sin el flag: de lunes a viernes toma
la semana en curso; sabado y domingo, la que acaba de terminar.

Salida de trabajo (datos + graficos + narrativa):
    informes_semanales/<AAAA-Www>/tasty.json, tradier.json, graficos/*.png,
                                   narrativa_tasty.json, narrativa_tradier.json
Salida final (lo que lee Guillermo):
    ...\\01_Sigma\\mentoria alejandro\\informes bitacora\\
        tastytrades\\<AAAA-Www>_informe-semanal_TASTYTRADE_cuenta-real.{html,pdf}
        tradier\\<AAAA-Www>_informe-semanal_TRADIER_cuenta-demo.{html,pdf}

Reglas que no se discuten (ver CLAUDE.md del repo y la memoria del proyecto):
  * Tasty: los importes salen del net-value de TastyTrade (netos de comisiones).
    Las operaciones cerradas son las de metrics.strategies del servidor — el mismo
    clasificador que ve la bitacora. No se reimplementa.
  * Tradier: el unico P&L oficial es resultadoOficial.pnl (cadena real de Tasty).
    El del broker va al lado, solo para auditar la brecha. Nunca se suman.
  * Un roll no es una operacion cerrada: es flujo de caja de una campana viva.
    Se reporta aparte y NO entra en win rate ni en el P&L realizado.
"""
import argparse
import base64
import html
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = "https://web-production-23473.up.railway.app"
ET = ZoneInfo("America/New_York")
REPO = Path(__file__).resolve().parent.parent
TRABAJO = REPO / "informes_semanales"
SALIDA = Path(r"C:\Users\gcarv\Documents\CARPETA PERSONAL\01. guillermo carvajal\01_Sigma\mentoria alejandro\informes bitacora")
CHROME = [r"C:\Program Files\Google\Chrome\Application\chrome.exe",
          r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"]
DIAS_ES = ["Lun", "Mar", "Mie", "Jue", "Vie", "Sab", "Dom"]
DIAS_LARGO = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"]
MESES = ["", "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
         "septiembre", "octubre", "noviembre", "diciembre"]


# ─────────────────────────── utilidades ───────────────────────────

def get(path, intentos=4, timeout=120):
    """GET a produccion. La primera llamada suele dar 502 (cold start de Railway)."""
    ultimo = None
    for i in range(intentos):
        try:
            with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            ultimo = e
            time.sleep(4 * (i + 1))
    raise RuntimeError(f"{path}: {ultimo}")


def f(x, d=0.0):
    try:
        return float(x)
    except (TypeError, ValueError):
        return d


def et_de(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ET)


def lunes_por_defecto():
    hoy = datetime.now(ET).date()
    if hoy.weekday() >= 5:
        return hoy - timedelta(days=hoy.weekday())
    return hoy - timedelta(days=hoy.weekday())


def etiqueta_semana(lunes):
    y, w, _ = lunes.isocalendar()
    return f"{y}-W{w:02d}"


def rango_texto(lunes):
    vie = lunes + timedelta(days=4)
    if lunes.month == vie.month:
        return f"lunes {lunes.day} a viernes {vie.day} de {MESES[vie.month]} de {vie.year}"
    return f"lunes {lunes.day} de {MESES[lunes.month]} a viernes {vie.day} de {MESES[vie.month]} de {vie.year}"


def resumen_grupo(ops, clave_pnl="pnl"):
    n = len(ops)
    gan = [o[clave_pnl] for o in ops if o[clave_pnl] > 0]
    per = [o[clave_pnl] for o in ops if o[clave_pnl] < 0]
    tot = sum(o[clave_pnl] for o in ops)
    return {
        "operaciones": n,
        "ganadas": len(gan),
        "perdidas": len(per),
        "winRate": round(100 * len(gan) / n, 1) if n else None,
        "resultado": round(tot, 2),
        "gananciaMedia": round(sum(gan) / len(gan), 2) if gan else None,
        "perdidaMedia": round(sum(per) / len(per), 2) if per else None,
        "profitFactor": round(sum(gan) / -sum(per), 2) if per and sum(per) else None,
        "porOperacion": round(tot / n, 2) if n else None,
    }


def agrupar(ops, clave, clave_pnl="pnl"):
    g = defaultdict(list)
    for o in ops:
        g[o[clave]].append(o)
    filas = [{"grupo": k, **resumen_grupo(v, clave_pnl)} for k, v in g.items()]
    return sorted(filas, key=lambda r: -r["resultado"])


def vencimiento_de(simbolo):
    m = re.search(r"(\d{6})[CP]\d{8}", (simbolo or "").replace(" ", ""))
    if not m:
        return None
    s = m.group(1)
    return date(2000 + int(s[:2]), int(s[2:4]), int(s[4:6]))


# ─────────────────────────── TASTYTRADE ───────────────────────────

def datos_tasty(lunes):
    viernes = lunes + timedelta(days=4)
    dias = [lunes + timedelta(days=i) for i in range(5)]
    dset = {d.isoformat() for d in dias}
    # Rango ancho: las operaciones que cierran esta semana pueden haber abierto
    # semanas atras, y el clasificador del servidor necesita ver la apertura.
    desde = (lunes - timedelta(days=200)).isoformat()
    hasta = (viernes + timedelta(days=1)).isoformat()
    tx = get(f"/api/transactions?startDate={desde}&endDate={hasta}")
    ov = get("/api/overview")
    wheel = get("/api/wheel")
    nlvh = get("/api/nlv-history").get("history", {})
    m = tx["metrics"]
    rueda_subs = set(wheel.get("underlyings") or [w["underlying"] for w in wheel.get("wheels", [])])

    # ── operaciones cerradas (round-trips del servidor) ──
    ops = []
    for s in m["strategies"]:
        if s.get("closeDate") not in dset or s.get("positionOpen"):
            continue
        venc = vencimiento_de(s.get("symbol"))
        abre = date.fromisoformat(s["openDate"]) if s.get("openDate") else None
        dte = (venc - abre).days if (venc and abre) else None
        sub = s.get("underlying")
        if sub in ("SPX", "SPXW", "XSP"):
            libro = "SPX corto plazo (0-2 DTE)" if (dte is not None and dte <= 2) else \
                f"Campana SPX {venc.strftime('%d/%m') if venc else ''}".strip()
        elif sub in rueda_subs:
            libro = "La Rueda"
        else:
            libro = "Swing / otros"
        cierre_et = et_de(s["closeExecAt"]) if s.get("closeExecAt") else None
        ops.append({
            "cierre": s["closeDate"],
            "hora": cierre_et.strftime("%H:%M") if cierre_et else "",
            "apertura": s.get("openDate"),
            "subyacente": sub,
            "estructura": s.get("stratType") or "?",
            "libro": libro,
            "patas": s.get("_legs"),
            "valorApertura": round(f(s.get("openValue")), 2),
            "valorCierre": round(f(s.get("closeValue")), 2),
            "pnl": round(f(s.get("pnl")), 2),
            "franja": s.get("amPm"),
            "duracion": s.get("durationCat"),
            "vence": venc.isoformat() if venc else None,
            "dteApertura": dte,
            "cierrePorVencimiento": str(s.get("closeOrderId", "")).startswith("RD_"),
            "orden": s.get("closeOrderId"),
        })
    ops.sort(key=lambda o: (o["cierre"], o["hora"]))

    movs = [x for x in m.get("movimientos", []) if x.get("date") in dset]
    rolls = [{"fecha": x["date"], "subyacente": x["underlying"], "estructura": x.get("stratType"),
              "resumen": x.get("resumen"), "neto": round(f(x.get("net")), 2)} for x in movs if x.get("tipo") == "Roll"]
    aperturas = [{"fecha": x["date"], "subyacente": x["underlying"], "estructura": x.get("stratType"),
                  "resumen": x.get("resumen"), "neto": round(f(x.get("net")), 2),
                  "sigueViva": abs(f(x.get("vivo"))) > 0.001} for x in movs if x.get("tipo") == "Apertura"]

    # ── comisiones y fees (todas las filas de la semana) ──
    campos_fee = ["commission", "clearing-fees", "regulatory-fees", "proprietary-index-option-fees"]
    fee_dia = defaultdict(float)
    for t in tx["items"]:
        fd = t.get("transaction-date")
        if fd not in dset:
            continue
        for c in campos_fee:
            v = f(t.get(c))
            if v:
                fee_dia[fd] += -v if t.get(c + "-effect") == "Debit" else v

    # ── NLV ──
    previos = sorted(k for k in nlvh if k < lunes.isoformat())
    nlv_ini = nlvh[previos[-1]] if previos else None
    nlv_ini_fecha = previos[-1] if previos else None
    diario = []
    ant = nlv_ini
    for d in dias:
        k = d.isoformat()
        ops_d = [o for o in ops if o["cierre"] == k]
        nlv = nlvh.get(k)
        diario.append({
            "fecha": k, "etiqueta": f"{DIAS_ES[d.weekday()]} {d.day}",
            "operaciones": len(ops_d),
            "pnl": round(sum(o["pnl"] for o in ops_d), 2),
            "comisiones": round(fee_dia.get(k, 0.0), 2),
            "primaAperturas": round(sum(a["neto"] for a in aperturas if a["fecha"] == k), 2),
            "rolls": round(sum(r["neto"] for r in rolls if r["fecha"] == k), 2),
            "nlv": nlv,
            "cambioNlv": round(nlv - ant, 2) if (nlv is not None and ant is not None) else None,
            "hubo_mercado": nlv is not None or bool(ops_d),
        })
        if nlv is not None:
            ant = nlv
    nlv_fin = next((d["nlv"] for d in reversed(diario) if d["nlv"] is not None), None)

    # ── posiciones abiertas ──
    bal = ov.get("balances", {})
    abiertas, acciones = [], []
    for p in ov.get("positions", []):
        q = f(p.get("quantity"))
        sgn = -1 if p.get("quantity-direction") == "Short" else 1
        mark = f(p.get("mark-price") or (p.get("greeks") or {}).get("mark") or p.get("close-price"))
        abre = f(p.get("average-open-price"))
        mult = f(p.get("multiplier"), 100.0 if p.get("instrument-type") == "Equity Option" else 1.0)
        g = p.get("greeks") or {}
        fila = {
            "subyacente": p.get("underlying-symbol"),
            "simbolo": p.get("symbol", "").strip(),
            "lado": "Corta" if sgn < 0 else "Larga",
            "cantidad": q,
            "precioApertura": abre,
            "precioHoy": mark,
            "noRealizado": round((mark - abre) * q * mult * sgn, 2),
        }
        if p.get("instrument-type") == "Equity Option":
            venc = vencimiento_de(p.get("symbol"))
            mm = re.search(r"\d{6}([CP])(\d{8})", p.get("symbol", "").replace(" ", ""))
            fila.update({
                "tipo": "Call" if mm and mm.group(1) == "C" else "Put",
                "strike": int(mm.group(2)) / 1000 if mm else None,
                "vence": venc.isoformat() if venc else None,
                "creado": (p.get("created-at") or "")[:10],
                "delta": round(f(g.get("delta")) * q * mult * sgn, 2),
                "theta": round(f(g.get("theta")) * q * mult * sgn, 2),
                "vega": round(f(g.get("vega")) * q * mult * sgn, 2),
            })
            abiertas.append(fila)
        else:
            acciones.append(fila)
    abiertas.sort(key=lambda r: (r["subyacente"], r.get("vence") or "", r.get("strike") or 0))
    # 'vivo' de movimientos es una foto del momento; lo que manda es si hoy
    # quedan patas de ese subyacente con ese vencimiento en la cuenta.
    vivos_hoy = {(a["subyacente"], a["vence"][5:7] + "/" + a["vence"][8:10]) for a in abiertas if a.get("vence")}
    for ap_ in aperturas:
        mm = re.search(r"(\d{2}/\d{2})\s*$", ap_["resumen"] or "")
        ap_["sigueViva"] = bool(mm) and (ap_["subyacente"], mm.group(1)) in vivos_hoy

    # campanas vivas: patas abiertas agrupadas por subyacente+vencimiento
    camp = defaultdict(list)
    for a in abiertas:
        camp[(a["subyacente"], a["vence"])].append(a)
    campanas = []
    for (sub, venc), patas in sorted(camp.items()):
        campanas.append({
            "subyacente": sub, "vence": venc, "patas": len(patas),
            "strikes": "/".join(f"{p['strike']:g}{p['tipo'][0]}" for p in sorted(patas, key=lambda p: p["strike"])),
            "noRealizado": round(sum(p["noRealizado"] for p in patas), 2),
            "diasAlVencimiento": (date.fromisoformat(venc) - viernes).days if venc else None,
        })

    # ── la rueda ──
    precio_accion = {a["subyacente"]: a["precioHoy"] for a in acciones}
    rueda = []
    for w in wheel.get("wheels", []):
        ev_sem = [e for e in w.get("events", []) if e.get("date") in dset]
        sh = f(w.get("shares"))
        cb = w.get("costBasis")
        px = precio_accion.get(w["underlying"])
        rueda.append({
            "activo": w["underlying"], "fase": w.get("phase"), "acciones": sh,
            "costoMedio": f(w.get("avgCost")) or None, "costoBaseAjustado": cb,
            "primaAcumulada": round(f(w.get("totalPremium")), 2),
            "eventosSemana": len(ev_sem),
            "eventos": [{"fecha": e.get("date"), "tipo": e.get("type"), "monto": round(f(e.get("amount")), 2)} for e in ev_sem],
            "precioHoy": px,
            "contraLaCompra": round((px - f(w.get("avgCost"))) * sh, 2) if (px and sh) else None,
            "contraLaBase": round((px - f(cb)) * sh, 2) if (px and sh and cb) else None,
        })

    ganancias = [o["pnl"] for o in ops if o["pnl"] > 0]
    perdidas = [o["pnl"] for o in ops if o["pnl"] < 0]
    comis = round(sum(fee_dia.values()), 2)
    pnl = round(sum(o["pnl"] for o in ops), 2)
    nlv_ov = f(bal.get("net-liquidating-value"))
    mant = f(bal.get("maintenance-requirement"))
    dias_mercado = [d for d in diario if d["hubo_mercado"]]
    semanas_srv = m.get("strategyByWeek", {})
    ult8 = sorted(semanas_srv.items())[-8:]

    return {
        "cuenta": "TastyTrade", "numeroCuenta": bal.get("account-number"),
        "semana": etiqueta_semana(lunes), "lunes": lunes.isoformat(), "viernes": viernes.isoformat(),
        "rango": rango_texto(lunes), "generado": datetime.now(ET).isoformat(timespec="minutes"),
        "resumen": {
            "pnlRealizado": pnl,
            "operacionesCerradas": len(ops),
            "ganadas": len(ganancias), "perdidas": len(perdidas),
            "winRate": round(100 * len(ganancias) / len(ops), 1) if ops else None,
            "profitFactor": round(sum(ganancias) / -sum(perdidas), 2) if perdidas else None,
            "gananciaMedia": round(sum(ganancias) / len(ganancias), 2) if ganancias else None,
            "perdidaMedia": round(sum(perdidas) / len(perdidas), 2) if perdidas else None,
            "gananciaBruta": round(sum(ganancias), 2),
            "perdidaBruta": round(sum(perdidas), 2),
            "comisiones": comis,
            "comisionesSobreGananciaBruta": round(100 * -comis / sum(ganancias), 1) if ganancias else None,
            "flujoRolls": round(sum(r["neto"] for r in rolls), 2),
            "rolls": len(rolls),
            "primaNetaAperturas": round(sum(a["neto"] for a in aperturas), 2),
            "aperturas": len(aperturas),
            "nlvInicio": nlv_ini, "nlvInicioFecha": nlv_ini_fecha, "nlvCierre": nlv_fin,
            "cambioNlv": round(nlv_fin - nlv_ini, 2) if (nlv_fin is not None and nlv_ini) else None,
            "cambioNlvPct": round(100 * (nlv_fin - nlv_ini) / nlv_ini, 2) if (nlv_fin is not None and nlv_ini) else None,
            "nlvAhora": nlv_ov,
            "mejorDia": max(dias_mercado, key=lambda d: d["pnl"]) if dias_mercado else None,
            "peorDia": min(dias_mercado, key=lambda d: d["pnl"]) if dias_mercado else None,
            "diasVerde": sum(1 for d in dias_mercado if d["pnl"] > 0), "diasMercado": len(dias_mercado),
            "mayorGanancia": max(ops, key=lambda o: o["pnl"]) if ops else None,
            "mayorPerdida": min(ops, key=lambda o: o["pnl"]) if ops else None,
            "margenMantenimiento": mant,
            "margenPct": round(100 * mant / nlv_ov, 1) if nlv_ov else None,
            "poderCompraDerivados": f(bal.get("derivative-buying-power")),
            "patasAbiertas": len(abiertas),
            "subyacentesAbiertos": len({a["subyacente"] for a in abiertas}),
            "noRealizadoOpciones": round(sum(a["noRealizado"] for a in abiertas), 2),
            "deltaOpciones": round(sum(a["delta"] for a in abiertas), 1),
            "thetaDia": round(sum(a["theta"] for a in abiertas), 2),
            "vega": round(sum(a["vega"] for a in abiertas), 2),
        },
        "diario": diario,
        "operaciones": ops,
        "porLibro": agrupar(ops, "libro"),
        "porEstructura": agrupar(ops, "estructura"),
        "porSubyacente": agrupar(ops, "subyacente"),
        "porFranja": agrupar(ops, "franja"),
        "porDuracion": agrupar(ops, "duracion"),
        "rolls": rolls, "aperturas": aperturas,
        "abiertas": abiertas, "acciones": acciones, "campanas": campanas, "rueda": rueda,
        "ultimasSemanas": [{"semana": k, "pnl": round(v, 2)} for k, v in ult8],
        "balances": {k: bal.get(k) for k in ["net-liquidating-value", "maintenance-requirement", "margin-equity",
                                              "derivative-buying-power", "equity-buying-power", "cash-balance",
                                              "maintenance-excess", "maintenance-call-value"]},
    }


# ─────────────────────────── TRADIER ───────────────────────────

def datos_tradier(lunes):
    viernes = lunes + timedelta(days=4)
    dias = [lunes + timedelta(days=i) for i in range(5)]
    dset = {d.isoformat() for d in dias}
    ex = get("/api/tradier/executions")
    stats = get("/api/spx/version-stats")
    nlvh = get("/api/nlv-history-tradier").get("history", {})
    try:
        pos = get("/api/positions-tradier")
    except Exception:  # noqa: BLE001
        pos = {}
    todas = ex.get("executions", [])
    cuenta = ex.get("account", {})
    ahora = datetime.now(timezone.utc)

    def fecha_et(e):
        return et_de(e["timestamp"]).date().isoformat()

    def cierre_et(e):
        return et_de(e["closedAt"]).date().isoformat() if e.get("closedAt") else None

    # Mismo corte que el Contador: un trade cerrado pertenece al dia en que CERRO.
    # Canceladas y vivas, por el dia de la senal.
    sem = [e for e in todas if (e.get("status") == "closed" and cierre_et(e) in dset) or
           (e.get("status") != "closed" and fecha_et(e) in dset)]
    trades, canceladas, vivas = [], [], []
    for e in sem:
        r = e.get("resultadoOficial") or {}
        fam = e.get("strategyFamily") or (e.get("algoVersion") or {}).get("familia") or "?"
        t_in = et_de(e["timestamp"])
        base = {
            "id": e.get("id"), "fecha": cierre_et(e) or fecha_et(e), "entrada": fecha_et(e), "hora": t_in.strftime("%H:%M"),
            "horaBloque": f"{t_in.hour:02d}:00", "estrategia": e.get("strategy"), "familia": fam,
            "huella": (e.get("algoVersion") or {}).get("huella"), "estado": e.get("status"),
            "motivo": e.get("closeReason"),
        }
        if e.get("status") == "canceled":
            canceladas.append(base)
            continue
        if e.get("status") != "closed":
            edad_h = (ahora - datetime.fromisoformat(e["timestamp"].replace("Z", "+00:00"))).total_seconds() / 3600
            vivas.append({**base, "edadHoras": round(edad_h, 1), "vence": e.get("expiry"),
                          "posibleZombi": e.get("status") == "submitted" and edad_h > 24})
            continue
        pe = e.get("paperEntry") or {}
        dur = None
        if e.get("closedAt") and (e.get("filledAt") or e.get("timestamp")):
            dur = (datetime.fromisoformat(e["closedAt"].replace("Z", "+00:00")) -
                   datetime.fromisoformat((e.get("filledAt") or e["timestamp"]).replace("Z", "+00:00"))).total_seconds() / 60
        trades.append({
            **base,
            "pnl": f(r.get("pnl")), "pnlBroker": f(r.get("pnlBroker")),
            "neto": f(r.get("neto"), f(r.get("pnl"))), "comision": f(e.get("commissionEstimate")),
            "ts": e["timestamp"],
            "diferencia": round(f(r.get("pnl")) - f(r.get("pnlBroker")), 2),
            "fuente": r.get("fuente"), "comparable": bool(r.get("comparable")),
            "costoCruce": round(f(pe.get("costoCruce")) * 100 * f(e.get("contracts"), 1), 2) if pe else None,
            "duracionMin": round(dur, 1) if dur is not None else None,
            "gammaPositivo": (e.get("condiciones") or {}).get("gammaPositivo"),
            "vix": (e.get("condiciones") or {}).get("vix"),
        })
    trades.sort(key=lambda t: (t["fecha"], t["hora"]))
    oficiales = [t for t in trades if t["comparable"]]
    legado = [t for t in trades if not t["comparable"]]

    previos = sorted(k for k in nlvh if k < lunes.isoformat())
    nlv_ini = nlvh[previos[-1]] if previos else None
    diario, ant = [], nlv_ini
    for d in dias:
        k = d.isoformat()
        td = [t for t in oficiales if t["fecha"] == k]
        nlv = nlvh.get(k)
        diario.append({
            "fecha": k, "etiqueta": f"{DIAS_ES[d.weekday()]} {d.day}",
            "trades": len(td), "pnl": round(sum(t["pnl"] for t in td), 2),
            "pnlBroker": round(sum(t["pnlBroker"] for t in td), 2),
            "canceladas": sum(1 for c in canceladas if c["fecha"] == k),
            "nlv": nlv, "cambioNlv": round(nlv - ant, 2) if (nlv is not None and ant is not None) else None,
            "hubo_mercado": nlv is not None or bool(td),
        })
        if nlv is not None:
            ant = nlv
    nlv_fin = next((d["nlv"] for d in reversed(diario) if d["nlv"] is not None), None)

    # semanas anteriores (oficial, comparable) para la tendencia
    por_sem = defaultdict(list)
    for e in todas:
        r = e.get("resultadoOficial") or {}
        if e.get("status") != "closed" or not r.get("comparable"):
            continue
        d = et_de(e.get("closedAt") or e["timestamp"]).date()
        if d > viernes:
            continue
        por_sem[etiqueta_semana(d - timedelta(days=d.weekday()))].append(f(r.get("pnl")))
    ult8 = [{"semana": k, "pnl": round(sum(v), 2), "trades": len(v),
             "winRate": round(100 * sum(1 for x in v if x > 0) / len(v), 1)} for k, v in sorted(por_sem.items())[-8:]]

    gan = [t["pnl"] for t in oficiales if t["pnl"] > 0]
    per = [t["pnl"] for t in oficiales if t["pnl"] < 0]
    pnl = round(sum(t["pnl"] for t in oficiales), 2)
    # Senales repetidas: misma estrategia, entrada a menos de 3 minutos de otra
    # que tambien se lleno. Duplican el riesgo del mismo setup.
    duplicadas = []
    orden = sorted(trades, key=lambda t: t["ts"])
    for a_, b_ in zip(orden, orden[1:]):
        dt = (datetime.fromisoformat(b_["ts"].replace("Z", "+00:00")) -
              datetime.fromisoformat(a_["ts"].replace("Z", "+00:00"))).total_seconds() / 60
        if a_["estrategia"] == b_["estrategia"] and dt <= 3:
            duplicadas.append({"fecha": a_["entrada"], "horas": f'{a_["hora"]} y {b_["hora"]}', "estrategia": a_["estrategia"],
                               "familia": a_["familia"], "pnlJuntas": round(a_["pnl"] + b_["pnl"], 2)})
    dias_m = [d for d in diario if d["hubo_mercado"]]
    vigentes = {}
    for v in stats.get("versiones", []):
        fam = v.get("familia")
        if fam not in vigentes or (v.get("hasta") or "") > (vigentes[fam].get("hasta") or ""):
            vigentes[fam] = v

    return {
        "cuenta": "Tradier", "semana": etiqueta_semana(lunes), "lunes": lunes.isoformat(),
        "viernes": viernes.isoformat(), "rango": rango_texto(lunes),
        "generado": datetime.now(ET).isoformat(timespec="minutes"),
        "reglaDelDinero": stats.get("reglaDelDinero"), "objetivo": stats.get("objetivo"),
        "resumen": {
            "pnlOficial": pnl,
            "pnlBroker": round(sum(t["pnlBroker"] for t in oficiales), 2),
            "brecha": round(pnl - sum(t["pnlBroker"] for t in oficiales), 2),
            "trades": len(oficiales), "tradesLegado": len(legado),
            "ganadas": len(gan), "perdidas": len(per),
            "empates": sum(1 for t in oficiales if t["pnl"] == 0),
            "winRate": round(100 * len(gan) / len(oficiales), 1) if oficiales else None,
            "profitFactor": round(sum(gan) / -sum(per), 2) if per else None,
            "gananciaMedia": round(sum(gan) / len(gan), 2) if gan else None,
            "perdidaMedia": round(sum(per) / len(per), 2) if per else None,
            "esperanzaPorTrade": round(pnl / len(oficiales), 2) if oficiales else None,
            "winRateNecesario": round(100 * -(sum(per) / len(per)) / ((sum(gan) / len(gan)) - (sum(per) / len(per))), 1) if (gan and per) else None,
            "costoCruceTotal": round(sum(t["costoCruce"] or 0 for t in oficiales), 2),
            "comisiones": round(sum(t["comision"] for t in oficiales), 2),
            "pnlNeto": round(sum(t["neto"] for t in oficiales), 2),
            "duplicadas": len(duplicadas),
            "senales": len(sem), "canceladas": len(canceladas),
            "tasaCancelacion": round(100 * len(canceladas) / len(sem), 1) if sem else None,
            "vivas": len(vivas), "posiblesZombis": sum(1 for v in vivas if v["posibleZombi"]),
            "duracionMediaMin": round(sum(t["duracionMin"] for t in oficiales if t["duracionMin"] is not None) /
                                      max(1, sum(1 for t in oficiales if t["duracionMin"] is not None)), 1),
            "nlvInicio": nlv_ini, "nlvCierre": nlv_fin,
            "cambioNlv": round(nlv_fin - nlv_ini, 2) if (nlv_fin is not None and nlv_ini) else None,
            "cuenta": cuenta,
            "mejorDia": max(dias_m, key=lambda d: d["pnl"]) if dias_m else None,
            "peorDia": min(dias_m, key=lambda d: d["pnl"]) if dias_m else None,
            "diasVerde": sum(1 for d in dias_m if d["pnl"] > 0), "diasMercado": len(dias_m),
        },
        "diario": diario,
        "trades": trades, "canceladas": canceladas, "vivas": vivas, "duplicadas": duplicadas,
        "porFamilia": agrupar(oficiales, "familia"),
        "porEstrategia": agrupar(oficiales, "estrategia"),
        "porMotivo": agrupar(oficiales, "motivo"),
        "porHora": sorted(agrupar(oficiales, "horaBloque"), key=lambda r: r["grupo"]),
        "porDia": agrupar(oficiales, "fecha"),
        "canceladasPorFamilia": {k: sum(1 for c in canceladas if c["familia"] == k) for k in {c["familia"] for c in canceladas}},
        "versionesVigentes": [{"familia": k, "huella": v.get("huella"), "desde": v.get("desde"),
                               "parametros": v.get("parametros"), "comparable": v.get("comparable")}
                              for k, v in sorted(vigentes.items())],
        "ultimasSemanas": ult8,
        "posicionesAbiertas": pos.get("groups", []),
    }


# ─────────────────────────── graficos ───────────────────────────

AZUL, VERDE, ROJO, OCRE, GRIS = "#1d3a5c", "#127f5c", "#c0262f", "#c9821f", "#8a94a3"


def _plt():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11, "axes.spines.top": False,
                         "axes.spines.right": False, "axes.edgecolor": "#b8c0cc", "axes.grid": True,
                         "grid.color": "#e3e7ee", "axes.axisbelow": True})
    return plt


def barras(ruta, etiquetas, valores, titulo, fmt="${:,.0f}", ancho=10, alto=4.2):
    plt = _plt()
    fig, ax = plt.subplots(figsize=(ancho, alto), dpi=110)
    cols = [VERDE if v >= 0 else ROJO for v in valores]
    b = ax.bar(etiquetas, valores, color=cols, width=0.55)
    ax.axhline(0, color="#5b6573", lw=1)
    for r, v in zip(b, valores):
        ax.annotate(fmt.format(v).replace("$-", "-$"), (r.get_x() + r.get_width() / 2, v),
                    xytext=(0, 6 if v >= 0 else -16), textcoords="offset points", ha="center",
                    fontweight="bold", color=VERDE if v >= 0 else ROJO, fontsize=10)
    ax.set_title(titulo, fontweight="bold", loc="left")
    if sum(len(e) for e in etiquetas) > 70:  # motivos de cierre largos: sin rotar se pisan en el eje
        ax.set_xticks(range(len(etiquetas)), etiquetas, rotation=25, ha="right", fontsize=9)
    ax.yaxis.set_major_formatter(lambda x, _: f"${x:,.0f}".replace("$-", "-$"))
    lo, hi = min(valores + [0]), max(valores + [0])
    margen = max(hi - lo, 1) * 0.15
    ax.set_ylim(lo - margen if lo < 0 else 0, hi + margen if hi > 0 else margen)
    fig.tight_layout()
    fig.savefig(ruta)
    plt.close(fig)


def lineas(ruta, etiquetas, series, titulo):
    plt = _plt()
    fig, ax = plt.subplots(figsize=(10, 4.2), dpi=110)
    for nombre, vals, color, estilo in series:
        xs = [i for i, v in enumerate(vals) if v is not None]
        ax.plot(xs, [vals[i] for i in xs], marker="o", color=color, lw=2.4, ls=estilo, label=nombre)
    ax.set_xticks(range(len(etiquetas)), etiquetas)
    ax.axhline(0, color="#5b6573", lw=1)
    ax.yaxis.set_major_formatter(lambda x, _: f"${x:,.0f}".replace("$-", "-$"))
    ax.set_title(titulo, fontweight="bold", loc="left")
    ax.legend(frameon=True, framealpha=0.9, edgecolor="none", loc="best")
    fig.tight_layout()
    fig.savefig(ruta)
    plt.close(fig)


def cascada(ruta, etiquetas, valores, titulo):
    plt = _plt()
    fig, ax = plt.subplots(figsize=(10, 4.4), dpi=110)
    acum, niveles = 0, [0]
    for i, v in enumerate(valores):
        ax.bar(i, v, bottom=acum, color=VERDE if v >= 0 else ROJO, width=0.6)
        acum += v
        niveles.append(acum)
    rango = max(niveles) - min(niveles) or 1
    ax.set_ylim(min(niveles) - rango * 0.08, max(niveles) + rango * 0.08)
    ax.axhline(0, color="#5b6573", lw=1)
    ax.set_xticks(range(len(etiquetas)), etiquetas, rotation=40, ha="right", fontsize=9)
    ax.yaxis.set_major_formatter(lambda x, _: f"${x:,.0f}".replace("$-", "-$"))
    ax.set_title(titulo, fontweight="bold", loc="left")
    fig.tight_layout()
    fig.savefig(ruta)
    plt.close(fig)


ABREV = {"Bear Call Spread": "BCS", "Bull Put Spread": "BPS", "Bull Call Spread": "BuCS", "Bear Put Spread": "BePS",
         "Iron Condor": "IC", "Iron Butterfly": "IB", "Put Butterfly": "Mariposa P", "Call Butterfly": "Mariposa C",
         "Short Put": "Put corta", "Short Call": "Call corta"}


def graficos_tasty(d, carpeta):
    carpeta.mkdir(parents=True, exist_ok=True)
    dm = d["diario"]
    et = [x["etiqueta"] for x in dm]
    barras(carpeta / "t_pnl_dia.png", et, [x["pnl"] for x in dm], "P&L realizado por dia (operaciones cerradas, neto de comisiones)")
    acum, a = [], 0
    for x in dm:
        a += x["pnl"]
        acum.append(round(a, 2))
    nlv0 = d["resumen"]["nlvInicio"]
    cam = [round(x["nlv"] - nlv0, 2) if (x["nlv"] is not None and nlv0) else None for x in dm]
    lineas(carpeta / "t_acumulado.png", et, [("P&L realizado acumulado", acum, AZUL, "-"),
                                             ("Cambio del NLV (incluye lo abierto)", cam, OCRE, "--")],
           "P&L realizado acumulado vs cambio del valor de la cuenta")
    (carpeta / "t_libros.png").unlink(missing_ok=True)
    if len(d["porLibro"]) > 1:
        barras(carpeta / "t_libros.png", [r["grupo"] for r in d["porLibro"]], [r["resultado"] for r in d["porLibro"]],
               "Resultado por libro")
    if d["porEstructura"]:
        barras(carpeta / "t_estructuras.png", [r["grupo"] for r in d["porEstructura"]],
               [r["resultado"] for r in d["porEstructura"]], "Resultado por estructura")
    if d["operaciones"]:
        cascada(carpeta / "t_cascada.png",
                [f"{o['cierre'][8:]} {o['subyacente']} {ABREV.get(o['estructura'], o['estructura'][:12])}" for o in d["operaciones"]],
                [o["pnl"] for o in d["operaciones"]], "Operacion por operacion — asi se construyo el resultado")
    if d["ultimasSemanas"]:
        barras(carpeta / "t_semanas.png", [s["semana"][5:] for s in d["ultimasSemanas"]],
               [s["pnl"] for s in d["ultimasSemanas"]], "P&L realizado de las ultimas semanas (clasificador del servidor)")


def graficos_tradier(d, carpeta):
    carpeta.mkdir(parents=True, exist_ok=True)
    dm = d["diario"]
    et = [x["etiqueta"] for x in dm]
    barras(carpeta / "r_pnl_dia.png", et, [x["pnl"] for x in dm], "P&L oficial por dia (cadena real de TastyTrade)")
    a1, a2, s1, s2 = [], [], 0, 0
    for x in dm:
        s1 += x["pnl"]
        s2 += x["pnlBroker"]
        a1.append(round(s1, 2))
        a2.append(round(s2, 2))
    lineas(carpeta / "r_oficial_vs_broker.png", et, [("Oficial (cadena real)", a1, AZUL, "-"),
                                                     ("Broker (fills Tradier, solo auditoria)", a2, GRIS, "--")],
           "Acumulado de la semana: oficial vs broker")
    for clave, archivo, titulo in [("porFamilia", "r_familias.png", "Resultado oficial por familia"),
                                   ("porMotivo", "r_motivos.png", "Resultado oficial por motivo de cierre"),
                                   ("porHora", "r_horas.png", "Resultado oficial por hora de entrada (ET)")]:
        if d[clave]:
            barras(carpeta / archivo, [str(r["grupo"]) for r in d[clave]], [r["resultado"] for r in d[clave]], titulo)
    if d["ultimasSemanas"]:
        barras(carpeta / "r_semanas.png", [s["semana"][5:] for s in d["ultimasSemanas"]],
               [s["pnl"] for s in d["ultimasSemanas"]], "P&L oficial de las ultimas semanas")


# ─────────────────────────── render HTML / PDF ───────────────────────────

CSS = """
:root{--az:#1d3a5c;--az2:#23507a;--vd:#127f5c;--rj:#c0262f;--oc:#b0701a;--tx:#1f2733;--mu:#6b7684;--bd:#dfe4eb;--bg:#f3f6f9}
*{box-sizing:border-box}body{font-family:"Segoe UI",system-ui,sans-serif;color:var(--tx);margin:0;background:#fff;font-size:13px;line-height:1.5}
.pag{max-width:1000px;margin:0 auto;padding:28px 36px}
.cab{background:linear-gradient(135deg,#12283f,#1d3a5c 55%,#23516f);color:#fff;border-radius:12px;padding:28px 32px}
.cab .k{letter-spacing:.25em;font-size:10.5px;font-weight:700;color:#9fb8d3}.cab h1{margin:10px 0 4px;font-size:30px}
.cab .s{color:#d6e2ef;font-size:14px}.cab .fu{margin-top:14px;padding-top:10px;border-top:1px solid #ffffff33;font-size:10.5px;color:#b9cadb}
.ver{background:var(--bg);border-left:5px solid var(--az);border-radius:8px;padding:16px 22px;margin:18px 0}
.ver .k{letter-spacing:.2em;font-size:10px;font-weight:700;color:var(--mu)}.ver p{margin:6px 0 0;font-size:14px}
h2{font-size:17px;border-bottom:3px solid var(--az);padding-bottom:6px;margin:30px 0 12px;page-break-after:avoid}
h2 .n{display:inline-block;background:var(--az);color:#fff;border-radius:5px;padding:0 7px;margin-right:8px;font-size:13px}
h3{font-size:12px;letter-spacing:.12em;color:var(--az);margin:18px 0 8px;text-transform:uppercase}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
.kpi{border:1px solid var(--bd);border-radius:8px;padding:10px 12px;page-break-inside:avoid}.kpi.dest{background:var(--bg)}
.kpi .l{font-size:9.5px;letter-spacing:.12em;font-weight:700;color:var(--mu);text-transform:uppercase}
.kpi .v{font-size:21px;font-weight:700;margin:4px 0 2px;color:var(--az)}.kpi .d{font-size:10.5px;color:var(--mu)}
.pos{color:var(--vd)!important}.neg{color:var(--rj)!important}
.nota{background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:12px 16px;margin:12px 0;font-size:12px}
table{width:100%;border-collapse:collapse;margin:8px 0 14px;font-size:11.5px;page-break-inside:auto}
th{background:var(--az);color:#fff;text-align:left;padding:7px 8px;font-size:10px;letter-spacing:.05em;text-transform:uppercase}
td{padding:6px 8px;border-bottom:1px solid #eef1f5}tr:nth-child(even) td{background:#fafbfc}
td.r,th.r{text-align:right}tr.tot td{font-weight:700;background:#eef2f7;border-top:2px solid var(--az)}
tr{page-break-inside:avoid}img{max-width:100%;display:block;margin:10px auto}
.caja{border-radius:8px;padding:14px 20px;margin:12px 0;border-left:5px solid}.caja h4{margin:0 0 6px;font-size:14px}
.caja ol{margin:0;padding-left:20px}.caja li{margin:6px 0}
.bueno{background:#eef7f2;border-color:var(--vd)}.bueno h4{color:var(--vd)}
.malo{background:#fdf6ec;border-color:var(--oc)}.malo h4{color:var(--oc)}
.feo{background:#fbf0f1;border-color:var(--rj)}.feo h4{color:var(--rj)}
.chip{display:inline-block;border-radius:10px;padding:1px 9px;font-size:9.5px;font-weight:700;letter-spacing:.06em}
.ALTA,.NO{background:#fbe3e5;color:var(--rj)}.MEDIA,.PARCIAL{background:#fbefdc;color:var(--oc)}
.BAJA,.SIN{background:#eef1f5;color:var(--mu)}.MANTENER,.CUMPLIDO{background:#dff2e9;color:var(--vd)}
.pie{border-top:1px solid var(--bd);margin-top:28px;padding-top:10px;font-size:10px;color:var(--mu)}
.dos{display:grid;grid-template-columns:1fr 1fr;gap:14px}
table.apretada{font-size:10.5px}table.apretada td{white-space:nowrap;padding:5px 6px}
@page{size:A4;margin:11mm 10mm}
@media print{body{zoom:.8}.pag{padding:0 4px;max-width:none}h2{page-break-after:avoid}.caja li,img{page-break-inside:avoid}}
"""


def m_(v, dec=2, signo=True):
    if v is None:
        return "—"
    s = f"{abs(v):,.{dec}f}".replace(",", "X").replace(".", ",").replace("X", ".")
    if not signo:
        return ("-" if v < 0 else "") + s
    return ("+$" if v > 0 else "-$" if v < 0 else "$") + s


def num(v, dec=2):
    if v is None:
        return "—"
    return m_(v, dec, signo=False)


def cls(v):
    return "pos" if (v or 0) > 0 else "neg" if (v or 0) < 0 else ""


def pct(v):
    return "—" if v is None else f"{v:.1f}%".replace(".", ",")


def kpi(l, v, d="", c="", dest=False):
    return f'<div class="kpi{" dest" if dest else ""}"><div class="l">{l}</div><div class="v {c}">{v}</div><div class="d">{d}</div></div>'


def img(carpeta, nombre):
    p = carpeta / nombre
    if not p.exists():
        return ""
    return f'<img src="data:image/png;base64,{base64.b64encode(p.read_bytes()).decode()}">'


def tabla(cols, filas, tot=None, clase=""):
    h = f'<table class="{clase}"><tr>' + "".join(f'<th class="{c[1]}">{c[0]}</th>' for c in cols) + "</tr>"
    for fl in filas:
        h += "<tr>" + "".join(f'<td class="{c[1]}">{x}</td>' for c, x in zip(cols, fl)) + "</tr>"
    if tot:
        h += '<tr class="tot">' + "".join(f'<td class="{c[1]}">{x}</td>' for c, x in zip(cols, tot)) + "</tr>"
    return h + "</table>"


def tabla_grupos(filas, nombre):
    cols = [(nombre, ""), ("Operaciones", "r"), ("Ganadas", "r"), ("Win rate", "r"), ("Resultado", "r"),
            ("Ganancia media", "r"), ("Perdida media", "r"), ("Por operacion", "r")]
    return tabla(cols, [[f"<b>{html.escape(str(r['grupo']))}</b>", r["operaciones"], r["ganadas"], pct(r["winRate"]),
                         f'<b class="{cls(r["resultado"])}">{m_(r["resultado"])}</b>', m_(r["gananciaMedia"]),
                         m_(r["perdidaMedia"]), m_(r["porOperacion"])] for r in filas])


def tabla_compacta(filas, nombre):
    cols = [(nombre, ""), ("Oper.", "r"), ("Ganadas", "r"), ("Win rate", "r"), ("Resultado", "r")]
    return tabla(cols, [[f"<b>{html.escape(str(r['grupo']))}</b>", r["operaciones"], r["ganadas"], pct(r["winRate"]),
                         f'<b class="{cls(r["resultado"])}">{m_(r["resultado"])}</b>'] for r in filas])


def bloques_narrativa(n, sec):
    return "".join(f'<div class="nota">{t}</div>' for t in (n.get("notas", {}).get(sec) or []) if t) \
        if isinstance(n.get("notas", {}).get(sec), list) else \
        (f'<div class="nota">{n["notas"][sec]}</div>' if n.get("notas", {}).get(sec) else "")


def cajas_bmf(n):
    h = ""
    for clave, titulo in [("bueno", "LO BUENO"), ("malo", "LO MALO"), ("feo", "LO FEO")]:
        items = n.get(clave) or []
        if items:
            h += f'<div class="caja {clave}"><h4>{titulo}</h4><ol>' + "".join(f"<li>{i}</li>" for i in items) + "</ol></div>"
    return h


def plan_html(n):
    h = ""
    seg = n.get("seguimiento_plan_anterior") or []
    if seg:
        h += "<h3>Seguimiento del plan de la semana pasada</h3>" + tabla(
            [("Lo que se dijo", ""), ("Estado", ""), ("Que paso", "")],
            [[s.get("accion", ""), f'<span class="chip {(s.get("estado") or "SIN").split()[0]}">{s.get("estado", "SIN DATO")}</span>',
              s.get("comentario", "")] for s in seg])
    plan = n.get("plan") or []
    if plan:
        h += "<h3>Plan de mejora para la proxima semana</h3>" + tabla(
            [("#", ""), ("Accion", ""), ("Por que", ""), ("Como se mide el viernes", ""), ("Prioridad", "")],
            [[i + 1, p.get("accion", ""), p.get("porque", ""), p.get("medida", ""),
              f'<span class="chip {p.get("prioridad", "MEDIA")}">{p.get("prioridad", "MEDIA")}</span>'] for i, p in enumerate(plan)])
    return h


def extras(n, donde):
    return "".join(f'<h2><span class="n">+</span>{x["titulo"]}</h2>{x["html"]}'
                   for x in n.get("secciones_extra", []) if x.get("despues_de", "rueda") == donde)


def html_tasty(d, n, carpeta):
    r = d["resumen"]
    md, pd = r["mejorDia"] or {}, r["peorDia"] or {}
    k = [
        kpi("P&L realizado", m_(r["pnlRealizado"]), f'{r["operacionesCerradas"]} operaciones cerradas', cls(r["pnlRealizado"]), True),
        kpi("Valor de la cuenta", num(r["nlvCierre"]), f'desde {num(r["nlvInicio"])} el {(r["nlvInicioFecha"] or "")[5:]}'),
        kpi("Cambio del NLV", m_(r["cambioNlv"]), f'{pct(r["cambioNlvPct"])} en la semana', cls(r["cambioNlv"])),
        kpi("Win rate", pct(r["winRate"]), f'{r["ganadas"]} ganadas / {r["perdidas"]} perdidas'),
        kpi("Profit factor", num(r["profitFactor"]), "ganancias sobre perdidas"),
        kpi("Ganancia media", m_(r["gananciaMedia"]), f'{r["ganadas"]} ganadoras', "pos"),
        kpi("Perdida media", m_(r["perdidaMedia"]), f'{r["perdidas"]} perdedoras', "neg"),
        kpi("Mejor dia", m_(md.get("pnl")), md.get("etiqueta", ""), cls(md.get("pnl"))),
        kpi("Peor dia", m_(pd.get("pnl")), pd.get("etiqueta", ""), cls(pd.get("pnl"))),
        kpi("Dias en verde", f'{r["diasVerde"]} de {r["diasMercado"]}', "por P&L realizado"),
        kpi("Comisiones y fees", m_(r["comisiones"]), f'{pct(r["comisionesSobreGananciaBruta"])} de la ganancia bruta', "neg"),
        kpi("Rolls (flujo)", m_(r["flujoRolls"]), f'{r["rolls"]} rolls — no es P&L cerrado', cls(r["flujoRolls"])),
        kpi("Posiciones abiertas", f'{r["patasAbiertas"]} patas', f'en {r["subyacentesAbiertos"]} subyacentes'),
        kpi("Margen comprometido", pct(r["margenPct"]), f'{num(r["margenMantenimiento"])} de mantenimiento',
            "neg" if (r["margenPct"] or 0) > 60 else ""),
        kpi("Poder de compra libre", num(r["poderCompraDerivados"]), "en derivados"),
    ]
    dm = d["diario"]
    t_dia = tabla([("Dia", ""), ("Cerradas", "r"), ("P&L realizado", "r"), ("Comisiones", "r"), ("Prima neta aperturas", "r"),
                   ("Rolls", "r"), ("NLV cierre", "r"), ("Cambio NLV", "r")],
                  [[f"<b>{x['etiqueta']}</b>", x["operaciones"], f'<b class="{cls(x["pnl"])}">{m_(x["pnl"])}</b>',
                    f'<span class="neg">{m_(x["comisiones"])}</span>', num(x["primaAperturas"]), m_(x["rolls"]) if x["rolls"] else "—",
                    num(x["nlv"]), f'<span class="{cls(x["cambioNlv"])}">{m_(x["cambioNlv"])}</span>'] for x in dm],
                  ["SEMANA", r["operacionesCerradas"], f'<span class="{cls(r["pnlRealizado"])}">{m_(r["pnlRealizado"])}</span>',
                   m_(r["comisiones"]), num(r["primaNetaAperturas"]), m_(r["flujoRolls"]), num(r["nlvCierre"]),
                   f'<span class="{cls(r["cambioNlv"])}">{m_(r["cambioNlv"])}</span>'])
    t_ops = tabla([("Cierre", ""), ("Hora ET", ""), ("Subyacente", ""), ("Estructura", ""), ("Libro", ""), ("Patas", "r"),
                   ("Abrio", ""), ("Valor apertura", "r"), ("Valor cierre", "r"), ("Resultado", "r")],
                  [[o["cierre"][8:] + "/" + o["cierre"][5:7], o["hora"] + (" (venc.)" if o["cierrePorVencimiento"] else ""),
                    f"<b>{o['subyacente']}</b>", o["estructura"], o["libro"], o["patas"],
                    (o["apertura"] or "")[5:], num(o["valorApertura"]), num(o["valorCierre"]),
                    f'<b class="{cls(o["pnl"])}">{m_(o["pnl"])}</b>'] for o in d["operaciones"]],
                  [f'TOTAL — {r["operacionesCerradas"]} operaciones', "", "", "", "", "", "", "", "",
                   f'<span class="{cls(r["pnlRealizado"])}">{m_(r["pnlRealizado"])}</span>'], "apretada")
    t_rolls = tabla([("Fecha", ""), ("Subyacente", ""), ("Estructura", ""), ("Movimiento", ""), ("Neto", "r")],
                    [[x["fecha"][5:], f"<b>{x['subyacente']}</b>", x["estructura"] or "", x["resumen"] or "",
                      f'<span class="{cls(x["neto"])}">{m_(x["neto"])}</span>'] for x in d["rolls"]]) if d["rolls"] else \
        '<p class="d">No hubo rolls esta semana.</p>'
    t_ap = tabla([("Fecha", ""), ("Subyacente", ""), ("Estructura", ""), ("Strikes / venc.", ""), ("Neto al abrir", "r"), ("Sigue viva", "")],
                 [[x["fecha"][5:], f"<b>{x['subyacente']}</b>", x["estructura"] or "", x["resumen"] or "",
                   f'<span class="{cls(x["neto"])}">{m_(x["neto"])}</span>', "Si" if x["sigueViva"] else "No"] for x in d["aperturas"]])
    t_camp = tabla([("Subyacente", ""), ("Vence", ""), ("Dias", "r"), ("Patas", "r"), ("Strikes", ""), ("No realizado", "r")],
                   [[f"<b>{c['subyacente']}</b>", c["vence"], c["diasAlVencimiento"], c["patas"], c["strikes"],
                     f'<b class="{cls(c["noRealizado"])}">{m_(c["noRealizado"])}</b>'] for c in d["campanas"]],
                   ["TOTAL", "", "", r["patasAbiertas"], "", f'<span class="{cls(r["noRealizadoOpciones"])}">{m_(r["noRealizadoOpciones"])}</span>'])
    t_ab = tabla([("Subyacente", ""), ("Contrato", ""), ("Lado", ""), ("Cant.", "r"), ("Precio apertura", "r"),
                  ("Precio hoy", "r"), ("Vence", ""), ("Abierta", ""), ("No realizado", "r")],
                 [[f"<b>{a['subyacente']}</b>", f"{a['tipo']} {a['strike']:g}", a["lado"], f"{a['cantidad']:g}",
                   num(a["precioApertura"]), num(a["precioHoy"]), a["vence"], a["creado"][5:],
                   f'<span class="{cls(a["noRealizado"])}">{m_(a["noRealizado"])}</span>'] for a in d["abiertas"]], clase="apretada")
    t_rueda = tabla([("Activo", ""), ("Fase", ""), ("Acciones", "r"), ("Costo medio", "r"), ("Costo base ajustado", "r"),
                     ("Precio hoy", "r"), ("Prima acumulada", "r"), ("Eventos semana", "r"), ("Contra la base", "r")],
                    [[f"<b>{w['activo']}</b>", (w["fase"] or "").replace("_", " ").title(), f"{w['acciones']:g}" if w["acciones"] else "—",
                      num(w["costoMedio"], 4) if w["costoMedio"] else "—", num(w["costoBaseAjustado"], 4) if w["costoBaseAjustado"] else "—",
                      num(w["precioHoy"]) if w["precioHoy"] else "—", f'<span class="pos">{m_(w["primaAcumulada"])}</span>',
                      w["eventosSemana"], f'<b class="{cls(w["contraLaBase"])}">{m_(w["contraLaBase"])}</b>' if w["contraLaBase"] is not None else "—"]
                     for w in sorted(d["rueda"], key=lambda w: -w["primaAcumulada"])])
    ks = r
    riesgo = "".join([
        kpi("No realizado en opciones", m_(ks["noRealizadoOpciones"]), f'{ks["patasAbiertas"]} patas', cls(ks["noRealizadoOpciones"]), True),
        kpi("Delta de opciones", num(ks["deltaOpciones"], 1), "en acciones equivalentes"),
        kpi("Theta", m_(ks["thetaDia"]), "por dia", cls(ks["thetaDia"])),
        kpi("Vega", m_(ks["vega"]), "por punto de volatilidad", cls(ks["vega"])),
        kpi("Margen", pct(ks["margenPct"]), f'{num(ks["margenMantenimiento"])} sobre NLV {num(ks["nlvAhora"])}'),
    ])
    sec = 0

    def h2(t):
        nonlocal sec
        sec += 1
        return f'<h2><span class="n">{sec}</span>{t}</h2>'

    cuerpo = f"""
<div class="cab"><div class="k">BITACORA TASTY · INFORME SEMANAL</div><h1>TastyTrade — cuenta real</h1>
<div class="s">Cuenta {d.get('numeroCuenta') or ''} · Semana {d['semana'][-2:]} · {d['rango']}</div>
<div class="fu">Fuentes: <b>/api/transactions</b> (clasificador <i>metrics.strategies</i> del servidor), <b>/api/overview</b>, <b>/api/wheel</b>, <b>/api/nlv-history</b> — produccion en Railway · Importes del <b>net-value</b> de TastyTrade, netos de comisiones y fees · Los rolls se reportan aparte: son flujo de caja de una campana viva, no operaciones cerradas · Generado el {d['generado'][:16].replace('T', ' ')} ET</div></div>
<div class="ver"><div class="k">VEREDICTO EN UNA LINEA</div><p>{n.get('veredicto', '<i>(pendiente: falta narrativa_tasty.json)</i>')}</p></div>
{h2('Los numeros de la semana')}<div class="kpis">{''.join(k)}</div>
{bloques_narrativa(n, 'numeros')}
{img(carpeta, 't_pnl_dia.png')}{img(carpeta, 't_acumulado.png')}
<h3>Dia a dia</h3>{t_dia}
{h2('De donde salio el dinero: los libros')}
{img(carpeta, 't_libros.png')}{tabla_grupos(d['porLibro'], 'Libro')}{bloques_narrativa(n, 'libros')}
<h3>Por tipo de estructura</h3>{tabla_grupos(d['porEstructura'], 'Estructura')}{img(carpeta, 't_estructuras.png')}
<h3>Por subyacente</h3>{tabla_grupos(d['porSubyacente'], 'Subyacente')}
<div class="dos"><div><h3>Por franja horaria</h3>{tabla_compacta(d['porFranja'], 'Franja')}</div>
<div><h3>Por duracion</h3>{tabla_compacta(d['porDuracion'], 'Duracion')}</div></div>
{h2('Operacion por operacion')}{t_ops}{img(carpeta, 't_cascada.png')}{bloques_narrativa(n, 'operaciones')}
<h3>Aperturas de la semana</h3>{t_ap}
<h3>Rolls de la semana (flujo de caja, fuera del P&L realizado)</h3>{t_rolls}
{extras(n, 'operaciones')}
{h2('Lo que costo operar')}{bloques_narrativa(n, 'costos')}
{h2('Lo que quedo abierto y cuanto riesgo tiene')}<div class="kpis">{riesgo}</div>
<h3>Campanas vivas (patas agrupadas por subyacente y vencimiento)</h3>{t_camp}{bloques_narrativa(n, 'abiertas')}
<h3>Detalle de patas</h3>{t_ab}
{extras(n, 'abiertas')}
{h2('La Rueda, activo por activo')}{t_rueda}{bloques_narrativa(n, 'rueda')}
{extras(n, 'rueda')}
{h2('La tendencia: ultimas semanas')}{img(carpeta, 't_semanas.png')}{bloques_narrativa(n, 'tendencia')}
{h2('Lo bueno, lo malo y lo feo')}{cajas_bmf(n)}
{h2('Plan de mejora y sugerencias')}{plan_html(n)}{bloques_narrativa(n, 'sugerencias')}
<div class="pie">Bitacora Tasty · Informe semanal TastyTrade (cuenta real) · Semana {d['semana']} ({d['rango']}) · Datos en informes_semanales/{d['semana']}/tasty.json · Generado por scripts/informe_semanal.py</div>
"""
    return pagina(f"Informe semanal TastyTrade - {d['semana']}", cuerpo)


def html_tradier(d, n, carpeta):
    r = d["resumen"]
    md, pd = r["mejorDia"] or {}, r["peorDia"] or {}
    k = [
        kpi("P&L oficial", m_(r["pnlOficial"]), f'{r["trades"]} trades contra la cadena real', cls(r["pnlOficial"]), True),
        kpi("P&L del broker", m_(r["pnlBroker"]), "fills de Tradier — solo auditoria", cls(r["pnlBroker"])),
        kpi("Brecha oficial − broker", m_(r["brecha"]), "lo que el sandbox distorsiona", cls(r["brecha"])),
        kpi("Win rate", pct(r["winRate"]), f'{r["ganadas"]} G / {r["perdidas"]} P / {r["empates"]} en cero'),
        kpi("Win rate necesario", pct(r["winRateNecesario"]), "para no perder con estas medias"),
        kpi("Ganancia media", m_(r["gananciaMedia"]), "", "pos"),
        kpi("Perdida media", m_(r["perdidaMedia"]), "", "neg"),
        kpi("Profit factor", num(r["profitFactor"]), ""),
        kpi("Esperanza por trade", m_(r["esperanzaPorTrade"]), "", cls(r["esperanzaPorTrade"])),
        kpi("P&L neto", m_(r["pnlNeto"]), f'tras {m_(-r["comisiones"])} de comisiones', cls(r["pnlNeto"])),
        kpi("Costo de cruzar el spread", m_(-r["costoCruceTotal"]), "al entrar; ya incluido en el oficial", "neg"),
        kpi("Senales", r["senales"], f'{r["canceladas"]} canceladas ({pct(r["tasaCancelacion"])})'),
        kpi("Mejor dia", m_(md.get("pnl")), md.get("etiqueta", ""), cls(md.get("pnl"))),
        kpi("Peor dia", m_(pd.get("pnl")), pd.get("etiqueta", ""), cls(pd.get("pnl"))),
        kpi("Senales repetidas", r["duplicadas"], "misma estrategia a menos de 3 min", "neg" if r["duplicadas"] else ""),
        kpi("Duracion media", f'{r["duracionMediaMin"]:g} min', "de la entrada al cierre"),
        kpi("NLV sandbox (no oficial)", num(r["nlvCierre"]), f'cambio {m_(r["cambioNlv"])} — fills de Tradier', cls(r["cambioNlv"])),
    ]
    dm = d["diario"]
    t_dia = tabla([("Dia", ""), ("Trades", "r"), ("Oficial", "r"), ("Broker", "r"), ("Canceladas", "r"), ("NLV sandbox", "r"), ("Cambio NLV", "r")],
                  [[f"<b>{x['etiqueta']}</b>", x["trades"], f'<b class="{cls(x["pnl"])}">{m_(x["pnl"])}</b>',
                    f'<span class="{cls(x["pnlBroker"])}">{m_(x["pnlBroker"])}</span>', x["canceladas"], num(x["nlv"]),
                    f'<span class="{cls(x["cambioNlv"])}">{m_(x["cambioNlv"])}</span>'] for x in dm],
                  ["SEMANA", r["trades"], m_(r["pnlOficial"]), m_(r["pnlBroker"]), r["canceladas"], num(r["nlvCierre"]), m_(r["cambioNlv"])])
    t_tr = tabla([("Cierre", ""), ("Entrada ET", ""), ("Estrategia", ""), ("Familia", ""), ("Motivo cierre", ""), ("Min", "r"),
                  ("Oficial", "r"), ("Broker", "r"), ("Cruce", "r")],
                 [[t["fecha"][5:] + ("" if t["entrada"] == t["fecha"] else f' (abrio {t["entrada"][5:]})'), t["hora"], t["estrategia"], t["familia"], t["motivo"] or "", f'{t["duracionMin"]:g}' if t["duracionMin"] is not None else "—",
                   f'<b class="{cls(t["pnl"])}">{m_(t["pnl"])}</b>', f'<span class="{cls(t["pnlBroker"])}">{m_(t["pnlBroker"])}</span>',
                   m_(-(t["costoCruce"] or 0))] for t in d["trades"]],
                 ["TOTAL", "", "", "", "", "", m_(r["pnlOficial"]), m_(r["pnlBroker"]), m_(-r["costoCruceTotal"])], "apretada")
    t_ver = tabla([("Familia", ""), ("Huella vigente", ""), ("Desde", ""), ("Trades medidos", "r"), ("Win rate", "r"),
                   ("P&L acumulado", "r"), ("Por trade", "r"), ("Muestra", "")],
                  [[f"<b>{v['familia']}</b>", v["huella"], v["desde"], (v["comparable"] or {}).get("trades"),
                    pct((v["comparable"] or {}).get("winRate")), m_((v["comparable"] or {}).get("pnl")),
                    m_((v["comparable"] or {}).get("pnlPorTrade")),
                    "suficiente" if (v["comparable"] or {}).get("muestraSuficiente") else f'faltan {(v["comparable"] or {}).get("faltan")}']
                   for v in d["versionesVigentes"]])
    t_viv = tabla([("Fecha", ""), ("Hora", ""), ("Estrategia", ""), ("Estado", ""), ("Edad (h)", "r"), ("Vence", ""), ("Alerta", "")],
                  [[v["fecha"][5:], v["hora"], v["estrategia"], v["estado"], v["edadHoras"], v["vence"] or "",
                    '<b class="neg">posible zombi</b>' if v["posibleZombi"] else ""] for v in d["vivas"]]) if d["vivas"] else "<p>Nada abierto.</p>"
    sec = 0

    def h2(t):
        nonlocal sec
        sec += 1
        return f'<h2><span class="n">{sec}</span>{t}</h2>'

    cuerpo = f"""
<div class="cab"><div class="k">BITACORA TASTY · INFORME SEMANAL · ROBOT SPX</div><h1>Tradier — cuenta demo (sandbox)</h1>
<div class="s">Semana {d['semana'][-2:]} · {d['rango']}</div>
<div class="fu">Fuentes: <b>/api/tradier/executions</b>, <b>/api/spx/version-stats</b>, <b>/api/nlv-history-tradier</b> · <b>Regla del dinero:</b> el P&L oficial es el de la cadena real de TastyTrade (resultadoOficial). El numero del broker (fills del sandbox, ~15 min de atraso) va al lado solo para medir la brecha y nunca se suma · Generado el {d['generado'][:16].replace('T', ' ')} ET</div></div>
<div class="ver"><div class="k">VEREDICTO EN UNA LINEA</div><p>{n.get('veredicto', '<i>(pendiente: falta narrativa_tradier.json)</i>')}</p></div>
{h2('Los numeros de la semana')}<div class="kpis">{''.join(k)}</div>{bloques_narrativa(n, 'numeros')}
{img(carpeta, 'r_pnl_dia.png')}{img(carpeta, 'r_oficial_vs_broker.png')}
<h3>Dia a dia</h3>{t_dia}
{h2('Por familia y estrategia')}{img(carpeta, 'r_familias.png')}{tabla_grupos(d['porFamilia'], 'Familia')}
{tabla_grupos(d['porEstrategia'], 'Estrategia')}{bloques_narrativa(n, 'familias')}
{h2('Como salieron los trades')}{img(carpeta, 'r_motivos.png')}{tabla_grupos(d['porMotivo'], 'Motivo de cierre')}{bloques_narrativa(n, 'motivos')}
{h2('A que hora gana y a que hora pierde')}{img(carpeta, 'r_horas.png')}{tabla_grupos(d['porHora'], 'Hora de entrada ET')}{bloques_narrativa(n, 'horas')}
{h2('Trade por trade')}{t_tr}
{h2('Ejecucion: ordenes atascadas y lo que sigue abierto')}
<p><b>{r['canceladas']}</b> de {r['senales']} senales terminaron canceladas por ORDEN_ATASCADA ({pct(r['tasaCancelacion'])}). Por familia: {', '.join(f'{k} {v}' for k, v in d['canceladasPorFamilia'].items()) or '—'}.</p>
{t_viv}
<h3>Senales repetidas (misma estrategia, a menos de 3 minutos, las dos llenadas)</h3>
{tabla([('Fecha', ''), ('Entradas ET', ''), ('Estrategia', ''), ('Familia', ''), ('Resultado de las dos', 'r')], [[x['fecha'][5:], x['horas'], x['estrategia'], x['familia'], f'<b class="{cls(x["pnlJuntas"])}">{m_(x["pnlJuntas"])}</b>'] for x in d['duplicadas']]) if d['duplicadas'] else '<p>Ninguna.</p>'}
{bloques_narrativa(n, 'ejecucion')}
{h2('La muestra de cada version vigente')}{t_ver}{bloques_narrativa(n, 'versiones')}
{extras(n, 'rueda')}
{h2('La tendencia: ultimas semanas')}{img(carpeta, 'r_semanas.png')}
{tabla([('Semana', ''), ('Trades', 'r'), ('Win rate', 'r'), ('P&L oficial', 'r')], [[s['semana'], s['trades'], pct(s['winRate']), f'<b class="{cls(s["pnl"])}">{m_(s["pnl"])}</b>'] for s in d['ultimasSemanas']])}
{bloques_narrativa(n, 'tendencia')}
{h2('Lo bueno, lo malo y lo feo')}{cajas_bmf(n)}
{h2('Plan de mejora y sugerencias')}{plan_html(n)}{bloques_narrativa(n, 'sugerencias')}
<div class="pie">Bitacora Tasty · Informe semanal Tradier (sandbox) · Semana {d['semana']} ({d['rango']}) · Datos en informes_semanales/{d['semana']}/tradier.json · Generado por scripts/informe_semanal.py</div>
"""
    return pagina(f"Informe semanal Tradier - {d['semana']}", cuerpo)


def pagina(titulo, cuerpo):
    return f'<!doctype html><html lang="es"><head><meta charset="utf-8"><title>{titulo}</title><style>{CSS}</style></head><body><div class="pag">{cuerpo}</div></body></html>'


def a_pdf(html_path, pdf_path):
    exe = next((c for c in CHROME if Path(c).exists()), None)
    if not exe:
        print("  ! no encontre Chrome/Edge: queda solo el HTML")
        return False
    tmp = Path(os.environ.get("TEMP", ".")) / f"chrome_pdf_{os.getpid()}"
    try:
        Path(pdf_path).unlink(missing_ok=True)
    except PermissionError:
        print(f"  ! {Path(pdf_path).name} esta abierto en otro programa: cierralo y vuelve a correr render")
        return False
    subprocess.run([exe, "--headless=new", "--disable-gpu", "--no-pdf-header-footer", f"--user-data-dir={tmp}",
                    f"--print-to-pdf={pdf_path}", html_path.as_uri()], check=False, timeout=180,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return Path(pdf_path).exists()


# ─────────────────────────── main ───────────────────────────

def plan_anterior(lunes, cuenta):
    """La narrativa de la semana previa, para que el informe nuevo califique su plan."""
    for atras in range(1, 6):
        p = TRABAJO / etiqueta_semana(lunes - timedelta(weeks=atras)) / f"narrativa_{cuenta}.json"
        if p.exists():
            try:
                return {"semana": p.parent.name, "plan": json.loads(p.read_text(encoding="utf-8")).get("plan", [])}
            except Exception:  # noqa: BLE001
                return None
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fase", choices=["datos", "render", "todo"])
    ap.add_argument("--semana", help="lunes de la semana, AAAA-MM-DD (hora ET)")
    a = ap.parse_args()
    lunes = date.fromisoformat(a.semana) if a.semana else lunes_por_defecto()
    lunes -= timedelta(days=lunes.weekday())
    et = etiqueta_semana(lunes)
    carpeta = TRABAJO / et
    graf = carpeta / "graficos"
    carpeta.mkdir(parents=True, exist_ok=True)

    if a.fase in ("datos", "todo"):
        print(f"[informe-semanal] {et} ({rango_texto(lunes)})")
        for nombre, fn, fg in [("tasty", datos_tasty, graficos_tasty), ("tradier", datos_tradier, graficos_tradier)]:
            try:
                d = fn(lunes)
                d["planAnterior"] = plan_anterior(lunes, nombre)
                (carpeta / f"{nombre}.json").write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
                fg(d, graf)
                print(f"  ok {nombre}.json")
            except Exception as e:  # noqa: BLE001
                print(f"  ERROR {nombre}: {e}")
                import traceback
                traceback.print_exc()
                if a.fase == "datos":
                    sys.exit(2)

    if a.fase in ("render", "todo"):
        SALIDA.mkdir(parents=True, exist_ok=True)
        for nombre, fn, sufijo, sub in [("tasty", html_tasty, "TASTYTRADE_cuenta-real", "tastytrades"),
                                        ("tradier", html_tradier, "TRADIER_cuenta-demo", "tradier")]:
            p = carpeta / f"{nombre}.json"
            if not p.exists():
                print(f"  falta {p} — corre primero la fase datos")
                continue
            d = json.loads(p.read_text(encoding="utf-8"))
            pn = carpeta / f"narrativa_{nombre}.json"
            n = json.loads(pn.read_text(encoding="utf-8")) if pn.exists() else {}
            if not n:
                print(f"  aviso: sin narrativa_{nombre}.json — el informe sale solo con numeros")
            destino = SALIDA / sub
            destino.mkdir(parents=True, exist_ok=True)
            h = destino / f"{et}_informe-semanal_{sufijo}.html"
            h.write_text(fn(d, n, graf), encoding="utf-8")
            ok = a_pdf(h, destino / f"{et}_informe-semanal_{sufijo}.pdf")
            print(f"  {'ok' if ok else 'SIN PDF'} {h.with_suffix('.pdf').name}")


if __name__ == "__main__":
    main()
