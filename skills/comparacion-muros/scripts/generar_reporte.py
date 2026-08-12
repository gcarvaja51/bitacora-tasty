# -*- coding: utf-8 -*-
"""
Analiza comparacion_muros_log.jsonl (bitacora-tasty) y arma un reporte de
desviacion entre el calculo interno (server.js /api/spx/context) y Sigma
Terminal (/api/spx/sigma-levels), para decidir si dejar de depender de
Sigma Terminal para dibujar los muros en TradingView.

Uso: python generar_reporte.py
Escribe el reporte en texto plano a stdout Y a un .txt junto al log (evita
el crash de consola de Windows con caracteres especiales -- mismo patron
que el resto de scripts de este proyecto).
"""
import json
import statistics
from collections import Counter

LOG_PATH = r"C:\Users\gcarv\bitacora-tasty\comparacion_muros_log.jsonl"
OUT_PATH = r"C:\Users\gcarv\bitacora-tasty\comparacion_muros_reporte.txt"

def main():
    rows = []
    skips = Counter()
    errors = Counter()
    # utf-8-sig: Add-Content de PowerShell escribe un BOM al inicio del
    # archivo (confirmado 2026-07-29) -- utf-8 normal rompe json.loads en la
    # primera linea si no se limpia.
    with open(LOG_PATH, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "error" in obj:
                errors[obj["error"]] += 1
                continue
            if "skip" in obj:
                skips[obj["skip"]] += 1
                continue
            rows.append(obj)

    lines = []
    def p(s=""):
        lines.append(s)

    p("=" * 70)
    p("REPORTE — Comparacion muros: calculo interno vs Sigma Terminal")
    p("=" * 70)
    p(f"Lecturas validas: {len(rows)}")
    p(f"Saltos (dato viejo/faltante): {dict(skips)}")
    p(f"Errores de red: {dict(errors)}")
    if not rows:
        p("\nNo hay lecturas validas todavia -- correr de nuevo mas tarde.")
        _write(lines)
        return

    fechas = sorted(set(r["etTime"][:10] for r in rows))
    p(f"Fechas cubiertas: {fechas}")
    p("")

    def stats_for(field_diff, field_interno, field_sigma, label):
        diffs = [r[field_diff] for r in rows if r.get(field_diff) is not None]
        if not diffs:
            p(f"{label}: sin datos")
            return
        abs_diffs = [abs(d) for d in diffs]
        p(f"{label}:")
        p(f"  n={len(diffs)}  media_abs={statistics.mean(abs_diffs):.1f}pts  "
          f"mediana_abs={statistics.median(abs_diffs):.1f}pts  "
          f"max_abs={max(abs_diffs):.1f}pts  min_abs={min(abs_diffs):.1f}pts")
        exactos = sum(1 for d in diffs if d == 0)
        p(f"  coinciden exacto: {exactos}/{len(diffs)} ({100*exactos/len(diffs):.0f}%)")
        dentro_10 = sum(1 for d in abs_diffs if d <= 10)
        p(f"  dentro de 10pts: {dentro_10}/{len(diffs)} ({100*dentro_10/len(diffs):.0f}%)")
        dentro_25 = sum(1 for d in abs_diffs if d <= 25)
        p(f"  dentro de 25pts: {dentro_25}/{len(diffs)} ({100*dentro_25/len(diffs):.0f}%)")

    stats_for("callWall_diff", "callWall_interno", "callWall_sigma", "CALL WALL (interno - sigma)")
    p("")
    stats_for("putWall_diff", "putWall_interno", "putWall_sigma", "PUT WALL (interno - sigma)")
    p("")
    stats_for("gammaFlip_diff", "gammaFlip_interno", "gammaFlip_sigma", "GAMMA FLIP (interno - sigma)")
    p("")
    stats_for("mvs_diff", "mvs_interno", "mvs_sigma", "MVS (interno_aprox - sigma)")
    p("")

    regimen_coincide = sum(1 for r in rows if r.get("regime_coincide"))
    p(f"REGIMEN (signo de GEX): coincide en {regimen_coincide}/{len(rows)} "
      f"({100*regimen_coincide/len(rows):.0f}%)")
    if regimen_coincide < len(rows):
        discrep = [r for r in rows if not r.get("regime_coincide")]
        p(f"  Momentos con regimen DISTINTO: {len(discrep)}")
        for r in discrep[:10]:
            p(f"    {r['etTime']}: interno={r['regime_interno']} sigma={r['regime_sigma']}"
              f" (netGex interno={r['netGex_interno']:.2e} sigma={r['netGex_sigma']:.2e})")

    p("")
    dex_rows = [r for r in rows if r.get("netDex_interno") is not None and r.get("netDex_sigma") is not None]
    if dex_rows:
        dex_regimen_coincide = sum(1 for r in dex_rows if r.get("dex_regime_coincide"))
        p(f"REGIMEN DEX (signo del Net DEX): coincide en {dex_regimen_coincide}/{len(dex_rows)} "
          f"({100*dex_regimen_coincide/len(dex_rows):.0f}%)")
        if dex_regimen_coincide < len(dex_rows):
            discrep = [r for r in dex_rows if not r.get("dex_regime_coincide")]
            p(f"  Momentos con regimen DEX DISTINTO: {len(discrep)}")
            for r in discrep[:10]:
                p(f"    {r['etTime']}: interno={r['dex_regime_interno']} sigma={r['dex_regime_sigma']}")
        ratios = [abs(r["netDex_interno"]) / abs(r["netDex_sigma"]) for r in dex_rows if r["netDex_sigma"]]
        if ratios:
            p(f"  Magnitud |DEX interno| / |DEX sigma|: media={statistics.mean(ratios):.2f}x  "
              f"mediana={statistics.median(ratios):.2f}x  min={min(ratios):.2f}x  max={max(ratios):.2f}x")
    else:
        p("REGIMEN DEX: sin datos todavia")

    p("")
    p("-" * 70)
    p("NOTA: mvs_interno es una aproximacion (strike de mayor |gex| dentro de")
    p("ctx.gex.levels), no un campo que calcGEX() devuelva nativamente -- ver")
    p("SKILL.md de comparacion-muros para el detalle.")
    p("-" * 70)

    _write(lines)

def _write(lines):
    text = "\n".join(lines)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"Reporte guardado en: {OUT_PATH}")
    print()
    print(text)

if __name__ == "__main__":
    main()
