# ============================================================
#  Reactiva tradierAutoExecute en las 3 estrategias SPX
#  (Direccional, Iron Condor, Alejamiento de SMA) -- pausadas
#  a mano el 2026-07-29 por volatilidad (discurso de la Fed).
#  Corre UNA sola vez, 30 min antes de la apertura del dia
#  siguiente (Task Scheduler: "Bitacora_ReactivarAutoExecute",
#  trigger de una sola vez).
# ============================================================

$cfgUrl = "https://web-production-23473.up.railway.app/api/spx/config"
$logPath = "C:\Users\gcarv\bitacora-tasty\reactivar_auto_execute_log.txt"

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$ts  $msg" | Out-File -FilePath $logPath -Append -Encoding utf8
}

try {
    # Trae la config VIVA en el momento de la reactivacion (no una copia
    # guardada de ayer) -- si algo mas cambio la config entre el pausado y
    # ahora, no se pisa, solo se prenden los 3 switches sobre lo que sea que
    # este vigente en ese momento.
    $cfg = Invoke-RestMethod -Uri $cfgUrl -Method Get -TimeoutSec 20
} catch {
    Log "ERROR obteniendo config: $($_.Exception.Message)"
    exit 1
}

$trading = $cfg.trading
$trading.tradierAutoExecute = $true
$trading.ironCondor.tradierAutoExecute = $true
$trading.smaReversion.tradierAutoExecute = $true

$body = @{ trading = $trading } | ConvertTo-Json -Depth 10

try {
    $resp = Invoke-RestMethod -Uri $cfgUrl -Method Post -ContentType "application/json" -Body $body -TimeoutSec 20
    $ok = ($resp.trading.tradierAutoExecute -eq $true) -and
          ($resp.trading.ironCondor.tradierAutoExecute -eq $true) -and
          ($resp.trading.smaReversion.tradierAutoExecute -eq $true)
    if ($ok) {
        Log "OK -- las 3 estrategias reactivadas (Direccional/IronCondor/SmaReversion tradierAutoExecute=true)."
    } else {
        Log "ADVERTENCIA -- el POST respondio pero algun flag no quedo en true. Revisar a mano: $($resp | ConvertTo-Json -Depth 10 -Compress)"
    }
} catch {
    Log "ERROR posteando config: $($_.Exception.Message)"
    exit 1
}
