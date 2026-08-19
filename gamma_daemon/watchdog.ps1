# Vigilante del gamma_daemon (2026-08-19)
#
# POR QUE EXISTE. El 2026-08-18 el daemon murio a las 13:01 ET y siguio muerto
# 19,6 horas. No quedo ni una linea en daemon_crash_log.txt, porque se fue tambien
# el cmd.exe del start.bat -- que es justamente el bucle encargado de relanzarlo.
# El daemon avisa por ntfy cuando FALLA un ciclo, pero no cuando DEJA DE EXISTIR:
# nadie vigilaba eso. Resultado: 19 horas de muros congelados en el chart y en el
# celular, y las estrategias cayendo al calculo interno del servidor en vez del de
# Sigma sin que nada lo dijera. Lo detecto un humano al dia siguiente.
#
# En PowerShell y NO en Node a proposito: si lo que esta roto es node o el propio
# daemon, un vigilante escrito en node se cae con el.
#
# El daemon ciclea 24/7 -- fuera de horario solo SALTA el trabajo, pero
# lastCycleAt se sigue actualizando -- asi que la frescura se puede exigir a
# cualquier hora, sin ventana horaria que mantener.
#
# SOLO RELANZA SI EL PROCESO NO EXISTE. Si existe pero esta congelado, avisa y no
# toca nada: una segunda instancia escribiendo sobre el mismo status.json y
# empujando a la misma ventana de TradingView seria peor que el atasco.

$dir        = 'C:\Users\gcarv\bitacora-tasty\gamma_daemon'
$statusF    = Join-Path $dir 'status.json'
$stateF     = Join-Path $dir 'watchdog_state.json'
$logF       = Join-Path $dir 'watchdog.log'
$ntfy       = 'https://ntfy.sh/bitacora_gcarvaja51'
$maxEdadMin = 15    # el ciclo normal es de 30s y el degradado de 2 min

function Write-WLog($m){
  "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))  $m" | Out-File -FilePath $logF -Append -Encoding utf8
}
function Send-Ntfy($titulo,$prioridad,$cuerpo){
  try {
    Invoke-RestMethod -Uri $ntfy -Method Post -TimeoutSec 15 `
      -Headers @{ Title=$titulo; Priority=$prioridad; Tags='rotating_light' } -Body $cuerpo | Out-Null
  } catch { Write-WLog "ntfy fallo: $($_.Exception.Message)" }
}

# Estado previo: sin esto la alarma se repetiria cada 10 min hasta que alguien mire.
$yaAlertado = $false
if (Test-Path $stateF) {
  try { $yaAlertado = [bool](Get-Content $stateF -Raw | ConvertFrom-Json).alertado } catch {}
}

# 1) El proceso existe? Se excluye node_modules: los MCP tambien corren un index.js.
$proc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'index\.js' -and $_.CommandLine -notmatch 'node_modules' }
$vivo = [bool]$proc

# 2) Sigue ciclando?
$edadMin = $null
if (Test-Path $statusF) {
  try {
    $s = Get-Content $statusF -Raw | ConvertFrom-Json
    if ($s.lastCycleAt) {
      $edadMin = ((Get-Date).ToUniversalTime() - ([datetime]::Parse($s.lastCycleAt)).ToUniversalTime()).TotalMinutes
    }
  } catch { Write-WLog "no se pudo leer status.json: $($_.Exception.Message)" }
}

$problema = $null
if (-not $vivo)                    { $problema = 'el proceso node index.js NO existe' }
elseif ($null -eq $edadMin)        { $problema = 'status.json ilegible o sin lastCycleAt' }
elseif ($edadMin -gt $maxEdadMin)  { $problema = ('el proceso existe pero no cicla hace {0:N1} min' -f $edadMin) }

if (-not $problema) {
  if ($yaAlertado) {
    Send-Ntfy 'Gamma daemon recuperado' 'default' ('Vuelve a ciclar (ultimo ciclo hace {0:N1} min).' -f $edadMin)
    Write-WLog ('RECUPERADO - ciclo hace {0:N1} min' -f $edadMin)
  }
  '{"alertado":false}' | Out-File -FilePath $stateF -Encoding utf8
  exit 0
}

$relanzado = $false
if (-not $vivo) {
  try { schtasks /Run /TN 'GammaDaemon' | Out-Null; $relanzado = $true; Write-WLog 'GammaDaemon relanzado por el vigilante' }
  catch { Write-WLog "no se pudo relanzar: $($_.Exception.Message)" }
}

Write-WLog "PROBLEMA: $problema (relanzado=$relanzado)"
if (-not $yaAlertado) {
  $detalle = if ($relanzado) {
    'Se relanzo la tarea GammaDaemon automaticamente -- confirmar que vuelva a ciclar.'
  } else {
    'NO se relanzo: el proceso existe pero esta congelado, y una segunda instancia seria peor. Revisar a mano.'
  }
  Send-Ntfy 'Gamma daemon caido' 'urgent' "$problema. $detalle"
}
'{"alertado":true}' | Out-File -FilePath $stateF -Encoding utf8
exit 1
