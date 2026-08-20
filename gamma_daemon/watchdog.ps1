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
# Aviso por ntfy con HttpClient de .NET, NO con Invoke-RestMethod (2026-08-19).
#
# Invoke-RestMethod en PowerShell 5.1 se apoya en el motor de Internet Explorer y
# en sesion no interactiva -- que es como corre esta tarea -- se atasca. No es
# teorico: el propio log de este vigilante lo registro,
#
#   2026-08-19 15:02:18  ntfy fallo: The operation has timed out
#
# o sea que detecto un problema y NO pudo avisar. Un vigilante mudo es medio
# vigilante: encuentra la falla y se la guarda. HttpClient va directo contra la
# pila de red de .NET y no toca IE.
function Send-Ntfy($titulo,$prioridad,$cuerpo){
  try {
    Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
    $h = New-Object System.Net.Http.HttpClient
    $h.Timeout = [TimeSpan]::FromSeconds(15)
    try {
      [void]$h.DefaultRequestHeaders.TryAddWithoutValidation('Title', $titulo)
      [void]$h.DefaultRequestHeaders.TryAddWithoutValidation('Priority', $prioridad)
      [void]$h.DefaultRequestHeaders.TryAddWithoutValidation('Tags', 'rotating_light')
      $c = New-Object System.Net.Http.StringContent($cuerpo, [System.Text.Encoding]::UTF8, 'text/plain')
      [void]$h.PostAsync($ntfy, $c).GetAwaiter().GetResult()
    } finally { $h.Dispose() }
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

# 2) Sigue ciclando? Y ademas: los ciclos SIRVEN de algo?
$edadMin = $null; $fallos = 0; $modo = ''; $ultError = ''; $edadExitoMin = $null
if (Test-Path $statusF) {
  try {
    $s = Get-Content $statusF -Raw | ConvertFrom-Json
    if ($s.lastCycleAt) {
      $edadMin = ((Get-Date).ToUniversalTime() - ([datetime]::Parse($s.lastCycleAt)).ToUniversalTime()).TotalMinutes
    }
    if ($s.lastSuccessAt) {
      $edadExitoMin = ((Get-Date).ToUniversalTime() - ([datetime]::Parse($s.lastSuccessAt)).ToUniversalTime()).TotalMinutes
    }
    $fallos   = [int]$s.consecutiveFailures
    $modo     = [string]$s.mode
    $ultError = [string]$s.lastError
  } catch { Write-WLog "no se pudo leer status.json: $($_.Exception.Message)" }
}

# ¿Estamos dentro del horario de mercado? (9:30-16:00 ET, lunes a viernes)
# Solo entonces tiene sentido exigir exitos: fuera de horario el daemon CICLA
# pero salta el trabajo a proposito (lastSkipReason=fuera_de_horario), asi que
# lastSuccessAt se queda quieto toda la noche sin que eso sea una averia.
$etNow = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'Eastern Standard Time')
$minEt = $etNow.Hour * 60 + $etNow.Minute
$enMercado = ($etNow.DayOfWeek -ne 'Saturday') -and ($etNow.DayOfWeek -ne 'Sunday') -and ($minEt -ge 570) -and ($minEt -lt 960)

# ── Ciclar no es lo mismo que funcionar (2026-08-19) ──────────────────────────
#
# Hasta hoy este vigilante solo miraba que el proceso existiera y que ciclara.
# El 19-ago cumplio las dos cosas durante OCHO HORAS mientras el daemon no podia
# leer Sigma: el Chrome de sigma_profile habia desaparecido y cada ciclo moria
# con "Sigma Terminal no devolvio el simbolo tras 10s". consecutiveFailures en 4,
# mode en degraded, y el vigilante reportando 0 tan tranquilo.
#
# Es el mismo punto ciego que ya aparecio dos veces esta semana: verde por fuera,
# el dato de fondo muerto. Ciclar es condicion necesaria, no suficiente.
#
# NO se relanza por esto -- el proceso esta vivo y relanzarlo no arregla que
# Sigma no cargue. Solo avisa, que es lo que faltaba.
$maxSinExitoMin = 20

$problema = $null
if (-not $vivo)                    { $problema = 'el proceso node index.js NO existe' }
elseif ($null -eq $edadMin)        { $problema = 'status.json ilegible o sin lastCycleAt' }
elseif ($edadMin -gt $maxEdadMin)  { $problema = ('el proceso existe pero no cicla hace {0:N1} min' -f $edadMin) }
elseif ($fallos -ge 3)             { $problema = ("cicla pero FALLA: {0} ciclos seguidos sin exito (modo {1}). Ultimo error: {2}" -f $fallos, $modo, $ultError) }
elseif ($enMercado -and ($null -ne $edadExitoMin) -and ($edadExitoMin -gt $maxSinExitoMin)) {
  $problema = ('cicla pero lleva {0:N0} min SIN UN CICLO EXITOSO, con el mercado abierto. Ultimo error: {1}' -f $edadExitoMin, $ultError)
}

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
