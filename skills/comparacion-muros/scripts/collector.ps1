# ============================================================
#  Comparacion de muros: calculo interno vs Sigma Terminal
#  Corre cada 5 min via Windows Task Scheduler durante 2 dias
#  de mercado. No depende de TradingView ni Chrome -- solo lee
#  2 endpoints HTTP ya existentes en produccion. Sin costo de
#  API de Claude (no invoca claude.cmd).
# ============================================================

$logPath = "C:\Users\gcarv\bitacora-tasty\comparacion_muros_log.jsonl"
$ctxUrl   = "https://web-production-23473.up.railway.app/api/spx/context"
$sigmaUrl = "https://web-production-23473.up.railway.app/api/spx/sigma-levels"

# Guard duro de horario -- mismo patron que run_gamma_refresh.ps1 (hora ET real
# via .NET, no bash/TZ). Ventana: 9:30am-4:00pm ET, lunes-viernes (horario de
# mercado real -- fuera de esta ventana ambas fuentes reflejan el ultimo
# cierre/premarket, comparar ahi no aporta nada a la decision).
$etNow = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, "Eastern Standard Time")
$etMinutes = $etNow.Hour * 60 + $etNow.Minute
$dentroDeVentana = ($etNow.DayOfWeek -ne 'Saturday') -and ($etNow.DayOfWeek -ne 'Sunday') -and ($etMinutes -ge (9*60+30)) -and ($etMinutes -le (16*60))
if (-not $dentroDeVentana) {
    exit 0
}

function Write-Entry($obj) {
    $obj | ConvertTo-Json -Compress -Depth 5 | Add-Content -Path $logPath -Encoding utf8
}

try {
    # /api/spx/context hace varias llamadas externas (Yahoo, cadena de
    # opciones de TastyTrade) -- confirmado en vivo el 2026-07-29 que tarda
    # ~21s normalmente, un timeout de 20s lo cortaba a mitad de camino.
    $ctx = Invoke-RestMethod -Uri $ctxUrl -Method Get -TimeoutSec 45
} catch {
    Write-Entry ([ordered]@{ ts = (Get-Date).ToString("o"); error = "fetch_context_failed"; detail = $_.Exception.Message })
    exit 0
}

try {
    $sigma = Invoke-RestMethod -Uri $sigmaUrl -Method Get -TimeoutSec 20
} catch {
    Write-Entry ([ordered]@{ ts = (Get-Date).ToString("o"); error = "fetch_sigma_failed"; detail = $_.Exception.Message })
    exit 0
}

if (-not $sigma.fresh) {
    # Dato de Sigma Terminal viejo (>5 min, ver getFreshSigmaLevels() en
    # server.js) -- comparar contra un valor stale sesgaria la medicion de
    # desviacion sin que sea culpa de ninguno de los 2 calculos. Se registra
    # el salto para no perder visibilidad de cuantos ciclos se perdieron.
    Write-Entry ([ordered]@{ ts = (Get-Date).ToString("o"); skip = "sigma_stale"; ageMs = $sigma.ageMs })
    exit 0
}

if (-not $ctx.gex) {
    Write-Entry ([ordered]@{ ts = (Get-Date).ToString("o"); skip = "ctx_sin_gex" })
    exit 0
}

# MVS interno: no existe como campo propio en calcGEX (src/spx.js) -- se
# aproxima ACA, sin tocar el codigo de produccion, como el strike de mayor
# |gex| dentro de ctx.gex.levels (mismos "niveles significativos" que ya
# devuelve el endpoint) -- misma definicion que usa Sigma Terminal para su
# "MVS Neto" segun su propio tooltip ("strike con la mayor |Net GEX|").
$mvsInterno = $null
if ($ctx.gex.levels -and $ctx.gex.levels.Count -gt 0) {
    $best = $null
    foreach ($lvl in $ctx.gex.levels) {
        if ($null -eq $best -or [Math]::Abs($lvl.gex) -gt [Math]::Abs($best.gex)) { $best = $lvl }
    }
    if ($best) { $mvsInterno = $best.strike }
}

$entry = [ordered]@{
    ts               = (Get-Date).ToString("o")
    etTime           = $etNow.ToString("yyyy-MM-dd HH:mm:ss")
    spot_interno     = $ctx.spxPrice
    spot_sigma       = $sigma.spxPrice
    regime_interno   = $ctx.gex.regime
    regime_sigma     = $sigma.regime
    regime_coincide  = ($ctx.gex.regime -eq $sigma.regime)
    netGex_interno   = $ctx.gex.netGex
    netGex_sigma     = $sigma.netGex
    netDex_interno   = $ctx.gex.netDex
    netDex_sigma     = $sigma.netDex
    dex_regime_interno = if ($null -ne $ctx.gex.netDex) { if ($ctx.gex.netDex -gt 0) { "POSITIVO" } else { "NEGATIVO" } } else { $null }
    dex_regime_sigma   = if ($null -ne $sigma.netDex) { if ($sigma.netDex -gt 0) { "POSITIVO" } else { "NEGATIVO" } } else { $null }
    dex_regime_coincide = (($ctx.gex.netDex -gt 0) -eq ($sigma.netDex -gt 0))
    callWall_interno = $ctx.gex.callWall
    callWall_sigma   = $sigma.callWall
    callWall_diff    = $ctx.gex.callWall - $sigma.callWall
    putWall_interno  = $ctx.gex.putWall
    putWall_sigma    = $sigma.putWall
    putWall_diff     = $ctx.gex.putWall - $sigma.putWall
    gammaFlip_interno = $ctx.gex.gammaFlip
    gammaFlip_sigma   = $sigma.gammaFlip
    gammaFlip_diff    = $ctx.gex.gammaFlip - $sigma.gammaFlip
    mvs_interno      = $mvsInterno
    mvs_sigma        = $sigma.mvs
    mvs_diff         = if ($null -ne $mvsInterno) { $mvsInterno - $sigma.mvs } else { $null }
    sigma_age_ms     = $sigma.ageMs
}

Write-Entry $entry
