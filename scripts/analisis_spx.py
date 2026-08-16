"""
Análisis exploratorio del log de estrategia SPX (spx_strategy_log.json).

SOLO LECTURA. No toca el servidor, no escribe ningún archivo que el sistema
consuma en vivo. Genera un informe en scripts/informe_analisis_spx.md.

Responde tres preguntas que hoy no se responden:
  1. ¿Dónde mueren las evaluaciones? (embudo por familia de estrategia)
  2. ¿El score predice de verdad la dirección del SPX, o solo filtra por filtrar?
  3. ¿Qué checks del playbook son los que realmente bloquean, y cuánto pesan?

MÉTODO — límite importante:
  Solo hay 5 ejecuciones reales con P&L en tradier_executions.json: muy pocas
  para estadística. Así que el "resultado" de cada evaluación se aproxima con
  el RETORNO ADELANTADO del SPX: dónde estaba el precio 15/30/60 minutos
  después, tomado del propio log (que guarda spxPrice cada ~29 segundos).
  Es un proxy de si la LECTURA DIRECCIONAL fue correcta. NO es el P&L de la
  estrategia: no incluye theta, spread, comisiones ni la gestión de la
  posición. Sirve para calibrar el score, no para estimar ganancias.

Uso:  python scripts/analisis_spx.py
"""

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# La consola de Windows usa cp1252 y revienta con los acentos y las flechas.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

RAIZ = Path(__file__).resolve().parent.parent
LOG = RAIZ / "spx_strategy_log.json"
SALIDA = Path(__file__).resolve().parent / "informe_analisis_spx.md"

# Horizontes (minutos) para medir el retorno adelantado del SPX
HORIZONTES = [15, 30, 60]
# Tolerancia al buscar el precio futuro: si el log tiene un hueco mayor, se
# descarta la fila en vez de comparar contra un precio de hace mucho rato.
TOLERANCIA = pd.Timedelta(minutes=5)

_bloques: list[str] = []


def emitir(texto: str = "") -> None:
    """Escribe en consola y acumula para el informe en markdown."""
    print(texto)
    _bloques.append(texto)


def titulo(texto: str) -> None:
    emitir()
    emitir(f"## {texto}")
    emitir()


def tabla(df: pd.DataFrame) -> None:
    """Markdown a mano — evita depender de `tabulate`, que no está instalado."""
    d = df.reset_index()
    cols = [str(c) for c in d.columns]
    filas = [[("" if pd.isna(v) else str(v)) for v in fila] for fila in d.values]
    ancho = [
        max(len(cols[i]), *(len(f[i]) for f in filas)) if filas else len(cols[i])
        for i in range(len(cols))
    ]
    emitir("| " + " | ".join(c.ljust(ancho[i]) for i, c in enumerate(cols)) + " |")
    emitir("|" + "|".join("-" * (a + 2) for a in ancho) + "|")
    for f in filas:
        emitir("| " + " | ".join(v.ljust(ancho[i]) for i, v in enumerate(f)) + " |")
    emitir()


# ─────────────────────────────────────────────────────────────────────
# 1. Carga y normalización
# ─────────────────────────────────────────────────────────────────────
def cargar() -> pd.DataFrame:
    registros = json.loads(LOG.read_text(encoding="utf-8"))
    filas = []
    for r in registros:
        s = r.get("snapshot") or {}
        gex = s.get("gex") or {}
        filas.append(
            {
                "ts": r.get("timestamp"),
                "stage": r.get("stage"),
                "familia": r.get("strategyFamily"),
                "dte": r.get("dte"),
                "passed": bool(r.get("passed")),
                "reason": r.get("reason"),
                "spx": s.get("spxPrice"),
                "vix": s.get("vix"),
                "ivRank": s.get("ivRank"),
                "direction": s.get("direction"),
                "score": s.get("score"),
                "minScore": s.get("minScore"),
                "estrategia": s.get("strategy"),
                "regimenGex": gex.get("regime"),
                "gammaFlip": gex.get("gammaFlip"),
                "callWall": gex.get("callWall"),
                "putWall": gex.get("putWall"),
                "faseW15": (s.get("weinstein15m") or {}).get("fase"),
                "faseW2": (s.get("weinstein2m") or {}).get("fase"),
                "macdHist": (s.get("macd15m") or {}).get("hist"),
                "checks": s.get("checks"),
            }
        )

    df = pd.DataFrame(filas)
    # El log NO viene ordenado cronológicamente (el primer registro del archivo
    # es del 4-ago y el último del 17-jul) — hay que ordenarlo antes de nada.
    df["ts"] = pd.to_datetime(df["ts"], utc=True, format="ISO8601")
    df["ts_et"] = df["ts"].dt.tz_convert("America/New_York")
    df = df.sort_values("ts_et").reset_index(drop=True)
    df["sesion"] = df["ts_et"].dt.date  # día de mercado en hora del Este
    df["hora_et"] = df["ts_et"].dt.hour
    df["dia_semana"] = df["ts_et"].dt.day_name()
    return df


# ─────────────────────────────────────────────────────────────────────
# 1b. Limpieza — el log crudo tiene basura que envenena los promedios
# ─────────────────────────────────────────────────────────────────────
def limpiar(df: pd.DataFrame) -> pd.DataFrame:
    """Marca como inválido el precio que no se puede creer.

    Dos problemas reales encontrados en el log de producción:

    a) Precio centinela 5530.00 — residuo anterior al arreglo de
       `server.js:5135` (ahí se cambió el fallback 5530 por 0). Se cuela
       como si fuera un nivel del índice y produce saltos del -26%.

    b) Sesiones de fin de semana con el precio CONGELADO (mismo valor
       durante todo el día). El motor sigue evaluando sábado y domingo con
       la última cotización del viernes; los retornos salen exactamente 0 y
       arrastran hacia abajo cualquier tasa de acierto.

    No se borran filas: se anula el precio (`spx`), de modo que el embudo y
    el análisis de checks siguen usando el 100% de las evaluaciones y solo
    el análisis de retornos pierde lo que no es fiable.
    """
    antes = df["spx"].notna().sum()
    motivos = {}

    malo = pd.Series(False, index=df.index)

    # (a) centinela
    centinela = df["spx"].eq(5530.0)
    motivos["precio centinela 5530.00 (bug ya corregido en server.js:5135)"] = int(
        centinela.sum()
    )
    malo |= centinela

    # (b) fin de semana
    finde = df["dia_semana"].isin(["Saturday", "Sunday"]) & df["spx"].notna()
    motivos["sesión de fin de semana (precio congelado del viernes)"] = int(finde.sum())
    malo |= finde

    # (c) cualquier precio que se aparte >10% de la mediana de su sesión:
    #     red de seguridad genérica por si aparece otro centinela distinto.
    mediana = df.groupby("sesion")["spx"].transform("median")
    fuera = df["spx"].notna() & ((df["spx"] / mediana - 1).abs() > 0.10)
    fuera &= ~malo
    motivos["precio fuera de ±10% de la mediana de la sesión"] = int(fuera.sum())
    malo |= fuera

    df.loc[malo, "spx"] = np.nan

    global _limpieza
    _limpieza = {
        "antes": int(antes),
        "descartados": int(malo.sum()),
        "quedan": int(df["spx"].notna().sum()),
        "motivos": {k: v for k, v in motivos.items() if v},
    }
    return df


_limpieza: dict = {}


# ─────────────────────────────────────────────────────────────────────
# 2. Retorno adelantado del SPX (proxy del resultado)
# ─────────────────────────────────────────────────────────────────────
def agregar_retornos(df: pd.DataFrame) -> pd.DataFrame:
    """Para cada fila con precio, busca el precio N minutos después dentro de
    la MISMA sesión y calcula el retorno. Usa merge_asof por sesión para no
    cruzar de un día al siguiente (el salto nocturno arruinaría la medición)."""
    serie = (
        df.loc[df["spx"].notna(), ["ts_et", "sesion", "spx"]]
        .rename(columns={"spx": "spx_fut", "ts_et": "ts_fut"})
        .sort_values("ts_fut")
        .reset_index(drop=True)
    )

    signo = df["direction"].map({"BULLISH": 1.0, "BEARISH": -1.0})

    for mins in HORIZONTES:
        # merge_asof devuelve un índice nuevo, así que se lleva el índice
        # original como columna explícita en vez de confiar en el orden.
        izq = df[["ts_et", "sesion"]].copy()
        izq["idx_orig"] = df.index
        izq["objetivo"] = izq["ts_et"] + pd.Timedelta(minutes=mins)
        izq = izq.sort_values("objetivo")

        emparejado = pd.merge_asof(
            izq,
            serie,
            left_on="objetivo",
            right_on="ts_fut",
            by="sesion",
            direction="nearest",
            tolerance=TOLERANCIA,
        ).set_index("idx_orig")

        df[f"spx_{mins}m"] = emparejado["spx_fut"].reindex(df.index)
        df[f"ret_{mins}m"] = (df[f"spx_{mins}m"] / df["spx"] - 1) * 100

        # Retorno "a favor de la tesis": positivo = la dirección acertó.
        # El retorno exactamente 0 no informa nada (precio sin actualizar o
        # mercado quieto) y se descarta en vez de contarlo como fallo.
        ret_dir = df[f"ret_{mins}m"] * signo
        df[f"ret_dir_{mins}m"] = ret_dir.where(ret_dir != 0)
        df[f"acierto_{mins}m"] = np.where(
            df[f"ret_dir_{mins}m"].notna(), df[f"ret_dir_{mins}m"] > 0, np.nan
        )
    return df


# ─────────────────────────────────────────────────────────────────────
# 2b. Episodios — el motor evalúa cada ~29 segundos, así que 30 filas
#     seguidas describen EL MISMO momento de mercado. Contarlas como 30
#     observaciones independientes infla artificialmente cualquier
#     porcentaje. Se agrupan las filas contiguas (misma sesión, familia y
#     dirección, separadas por menos de HUECO_EPISODIO) en un episodio, y
#     los porcentajes de verdad se calculan sobre episodios.
# ─────────────────────────────────────────────────────────────────────
HUECO_EPISODIO = pd.Timedelta(minutes=10)


def agregar_episodios(df: pd.DataFrame) -> pd.DataFrame:
    clave = df["sesion"].astype(str) + "|" + df["familia"].astype(str) + "|" + df[
        "direction"
    ].astype(str)
    nuevo_grupo = clave.ne(clave.shift())
    salto = df["ts_et"].diff().gt(HUECO_EPISODIO).fillna(True)
    df["episodio"] = (nuevo_grupo | salto).cumsum()
    return df


def resumen_por_episodio(d: pd.DataFrame, mins: int) -> pd.DataFrame:
    """Un voto por episodio: se promedia dentro del episodio y luego entre
    episodios, para que un momento largo no pese más que uno corto."""
    d = d.dropna(subset=[f"acierto_{mins}m"])
    if d.empty:
        return pd.DataFrame()
    por_ep = d.groupby(["grupo", "episodio"]).agg(
        acierto=(f"acierto_{mins}m", "mean"),
        ret=(f"ret_dir_{mins}m", "mean"),
    )
    return por_ep.groupby("grupo").agg(
        episodios=("acierto", "size"),
        pct_acierto=("acierto", lambda s: round(s.mean() * 100, 1)),
        ret_medio=("ret", lambda s: round(s.mean(), 4)),
    )


# ─────────────────────────────────────────────────────────────────────
# 3. Informes
# ─────────────────────────────────────────────────────────────────────
def informe_cobertura(df: pd.DataFrame) -> None:
    titulo("Cobertura de los datos")
    sesiones = sorted(df["sesion"].unique())
    emitir(f"- **Evaluaciones registradas:** {len(df):,}")
    emitir(f"- **Sesiones de mercado (hora ET):** {len(sesiones)}")
    emitir(f"- **Rango:** {sesiones[0]} → {sesiones[-1]}")
    emitir(f"- **Con precio del SPX:** {df['spx'].notna().sum():,}")
    emitir(f"- **Con dirección y score:** {df['score'].notna().sum():,}")
    emitir()
    por_sesion = (
        df.groupby("sesion")
        .agg(
            dia=("dia_semana", "first"),
            evaluaciones=("stage", "size"),
            precio_usable=("spx", "count"),
            señales=("stage", lambda s: (s == "SIGNAL_BUILT").sum()),
        )
        .rename_axis("sesión")
    )
    tabla(por_sesion)


def informe_limpieza() -> None:
    titulo("Calidad de los datos: qué se descartó y por qué")
    L = _limpieza
    emitir(
        f"De **{L['antes']:,}** evaluaciones que traían precio del SPX, se anularon "
        f"**{L['descartados']:,}** por no ser fiables. Quedan **{L['quedan']:,}** "
        f"usables para medir retornos."
    )
    emitir()
    mot = pd.DataFrame(
        {"registros": list(L["motivos"].values())}, index=list(L["motivos"].keys())
    ).rename_axis("motivo del descarte")
    tabla(mot)
    emitir(
        "> El embudo y el análisis de checks **sí** usan las 3.927 evaluaciones "
        "completas — la limpieza solo afecta a los cálculos de retorno."
    )
    emitir()


def informe_embudo(df: pd.DataFrame) -> None:
    titulo("1. El embudo: dónde mueren las evaluaciones")
    emitir(
        "Cada fila es un motivo de corte. `SIGNAL_BUILT` es el único desenlace "
        "que produce una señal operable."
    )
    emitir()
    emb = (
        pd.crosstab(df["stage"], df["familia"], margins=True, margins_name="TOTAL")
        .sort_values("TOTAL", ascending=False)
        .rename_axis("etapa")
    )
    emb["% del total"] = (emb["TOTAL"] / len(df) * 100).round(1)
    tabla(emb)

    tasa = (
        df.assign(señal=df["stage"].eq("SIGNAL_BUILT"))
        .groupby("familia")
        .agg(evaluaciones=("señal", "size"), señales=("señal", "sum"))
    )
    tasa["% conversión"] = (tasa["señales"] / tasa["evaluaciones"] * 100).round(1)
    emitir("**Conversión por familia de estrategia:**")
    emitir()
    tabla(tasa.sort_values("% conversión", ascending=False).rename_axis("familia"))


def informe_score(df: pd.DataFrame) -> None:
    titulo("2. ¿El score predice la dirección del SPX?")
    emitir(
        "Comparación entre las evaluaciones que **pasaron** el umbral de score "
        "(`SIGNAL_BUILT`) y las que fueron **rechazadas** por score "
        "(`SCORE_FAIL`). Si el score sirve, las que pasan deben acertar más."
    )
    emitir()

    sub = df[df["stage"].isin(["SIGNAL_BUILT", "SCORE_FAIL"])].copy()
    sub["grupo"] = np.where(
        sub["stage"].eq("SIGNAL_BUILT"), "PASÓ (señal)", "RECHAZADA (score bajo)"
    )

    filas = []
    for mins in HORIZONTES:
        g = sub.dropna(subset=[f"acierto_{mins}m"]).groupby("grupo")
        for grupo, datos in g:
            filas.append(
                {
                    "horizonte": f"+{mins} min",
                    "grupo": grupo,
                    "n": len(datos),
                    "% acierto direccional": round(
                        datos[f"acierto_{mins}m"].mean() * 100, 1
                    ),
                    "retorno medio a favor (%)": round(
                        datos[f"ret_dir_{mins}m"].mean(), 4
                    ),
                    "retorno mediano (%)": round(
                        datos[f"ret_dir_{mins}m"].median(), 4
                    ),
                }
            )
    tabla(pd.DataFrame(filas).set_index(["horizonte", "grupo"]))

    emitir(
        "⚠️ **Lo mismo contado por episodios.** El motor evalúa cada ~29 s: "
        "treinta filas seguidas son el MISMO momento de mercado. Esta tabla "
        "da un voto por episodio (huecos de más de 10 min separan episodios) "
        "y es la que hay que mirar — la de arriba exagera la muestra."
    )
    emitir()
    for mins in HORIZONTES:
        res = resumen_por_episodio(sub, mins)
        if res.empty:
            continue
        emitir(f"**Horizonte +{mins} min**")
        emitir()
        tabla(res.rename_axis("grupo"))

    emitir("**Acierto por tramo de score** (¿es monótono? debería serlo):")
    emitir()
    con_score = sub.dropna(subset=["score", "acierto_30m"]).copy()
    con_score["tramo"] = pd.cut(
        con_score["score"],
        bins=[-0.01, 25, 50, 60, 70, 75, 85, 100],
        labels=["0-25", "25-50", "50-60", "60-70", "70-75", "75-85", "85-100"],
    )
    por_tramo = con_score.groupby("tramo", observed=True).agg(
        filas=("score", "size"),
        episodios=("episodio", "nunique"),
        sesiones=("sesion", "nunique"),
        acierto_30m=("acierto_30m", lambda s: round(s.mean() * 100, 1)),
        ret_medio_30m=("ret_dir_30m", lambda s: round(s.mean(), 4)),
    )
    tabla(por_tramo.rename_axis("tramo de score"))
    emitir(
        "> Mirar la columna `episodios`, no `filas`. Un tramo con muchas filas "
        "pero 2 o 3 episodios describe un par de ratos concretos, no una "
        "regularidad — su porcentaje no significa nada todavía."
    )
    emitir()

    # ¿Cuántos rechazos se quedaron a un pelo del umbral?
    fallos = df[df["stage"].eq("SCORE_FAIL")].dropna(subset=["score", "minScore"])
    if not fallos.empty:
        brecha = fallos["minScore"] - fallos["score"]
        cerca = fallos[brecha <= 10]
        emitir(
            f"**Rechazos al filo del umbral:** {len(cerca):,} de {len(fallos):,} "
            f"({len(cerca) / len(fallos) * 100:.1f}%) quedaron a 10 puntos o menos "
            f"del mínimo exigido."
        )
        if not cerca.dropna(subset=["acierto_30m"]).empty:
            ac = cerca["acierto_30m"].mean() * 100
            emitir(
                f"De esos, el **{ac:.1f}%** acertó la dirección a +30 min "
                f"(n={cerca['acierto_30m'].notna().sum()})."
            )
        emitir()


def informe_checks(df: pd.DataFrame) -> None:
    titulo("3. Qué checks del playbook bloquean de verdad")
    filas = []
    for _, fila in df[df["checks"].notna()].iterrows():
        for c in fila["checks"]:
            filas.append(
                {
                    "familia": fila["familia"],
                    "id": c.get("id"),
                    "label": c.get("label") or c.get("id"),
                    "peso": c.get("weight"),
                    "ok": bool(c.get("ok")),
                    "paso_score": fila["stage"] == "SIGNAL_BUILT",
                }
            )
    if not filas:
        emitir("_Sin checks en el log._")
        return

    ch = pd.DataFrame(filas)
    resumen = ch.groupby(["familia", "label"]).agg(
        veces=("ok", "size"),
        peso=("peso", "max"),
        pct_ok=("ok", lambda s: round(s.mean() * 100, 1)),
    )
    resumen["puntos perdidos"] = (
        resumen["peso"] * (100 - resumen["pct_ok"]) / 100
    ).round(1)
    resumen = resumen.sort_values(["familia", "puntos perdidos"], ascending=[True, False])
    emitir(
        "`puntos perdidos` = peso del check × su tasa de fallo. Es el check que "
        "más puntaje te está costando en promedio."
    )
    emitir()
    tabla(resumen.rename_axis(["familia", "check"]))


def informe_contexto(df: pd.DataFrame) -> None:
    titulo("4. Acierto direccional según el contexto de mercado")
    emitir(
        "Sobre todas las evaluaciones con dirección (pasaran o no). Busca "
        "regímenes donde la lectura funciona mejor o peor."
    )
    emitir()
    ini = df.dropna(subset=["spx"]).iloc[0]
    fin = df.dropna(subset=["spx"]).iloc[-1]
    var = (fin["spx"] / ini["spx"] - 1) * 100
    emitir(
        f"⚠️ **Sesgo de régimen.** En la ventana analizada el SPX pasó de "
        f"{ini['spx']:,.0f} a {fin['spx']:,.0f} (**{var:+.1f}%**) en solo "
        f"{df['sesion'].nunique()} sesiones. En un tramo alcista, cualquier "
        f"tesis BULLISH acierta más que una BEARISH por el simple arrastre "
        f"del mercado. La tabla de dirección de abajo mide eso tanto como "
        f"mide la calidad del sistema — no se puede separar con 10 días."
    )
    emitir()
    base = df.dropna(subset=["acierto_30m"]).copy()

    def desglose(col, etiqueta, bins=None, labels=None):
        d = base.dropna(subset=[col]).copy()
        if d.empty:
            return
        clave = d[col] if bins is None else pd.cut(d[col], bins=bins, labels=labels)
        res = d.groupby(clave, observed=True).agg(
            filas=("acierto_30m", "size"),
            episodios=("episodio", "nunique"),
            sesiones=("sesion", "nunique"),
            acierto_30m=("acierto_30m", lambda s: round(s.mean() * 100, 1)),
            ret_medio=("ret_dir_30m", lambda s: round(s.mean(), 4)),
        )
        res = res[res["filas"] >= 20]
        if res.empty:
            return
        emitir(f"**{etiqueta}**")
        emitir()
        tabla(res.rename_axis(etiqueta))

    desglose("familia", "Familia de estrategia")
    desglose("regimenGex", "Régimen GEX")
    desglose("direction", "Dirección de la tesis")
    desglose("faseW15", "Fase Weinstein 15m")
    desglose("hora_et", "Hora del día (ET)")
    desglose("vix", "VIX", bins=[0, 15, 17, 19, 100],
             labels=["<15", "15-17", "17-19", ">19"])


def informe_gates(df: pd.DataFrame) -> None:
    titulo("5. Los gates duros")
    emitir(
        "Cortes que ocurren ANTES de calcular el score. No guardan dirección, "
        "así que no se puede medir su acierto — pero sí cuánto filtran."
    )
    emitir()
    gates = df[
        df["stage"].isin(
            ["GEX_NOT_POSITIVE", "NO_CAMINO_B", "POSITION_CHECK_MISMATCH", "GATE_FAIL"]
        )
    ]
    res = gates.groupby(["stage", "familia"]).size().unstack(fill_value=0)
    res["TOTAL"] = res.sum(axis=1)
    tabla(res.sort_values("TOTAL", ascending=False).rename_axis("gate"))

    emitir("**Motivos textuales más frecuentes:**")
    emitir()
    motivos = (
        gates["reason"].str.slice(0, 95).value_counts().head(12).rename("veces")
    )
    tabla(motivos.to_frame().rename_axis("motivo"))


def main() -> None:
    df = agregar_episodios(agregar_retornos(limpiar(cargar())))

    emitir("# Análisis del log de estrategia SPX")
    emitir()
    emitir(
        "> Generado por `scripts/analisis_spx.py` (solo lectura). El resultado "
        "de cada evaluación se aproxima con el retorno adelantado del SPX, no "
        "con P&L real — ver la nota de método en la cabecera del script."
    )

    informe_cobertura(df)
    informe_limpieza()
    informe_embudo(df)
    informe_score(df)
    informe_checks(df)
    informe_contexto(df)
    informe_gates(df)

    SALIDA.write_text("\n".join(_bloques) + "\n", encoding="utf-8")
    print(f"\n[ok] Informe escrito en {SALIDA}")


if __name__ == "__main__":
    main()
