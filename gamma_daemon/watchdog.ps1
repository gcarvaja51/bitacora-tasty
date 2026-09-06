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
# COMO RELANZA, segun el caso:
#
#   - El proceso NO existe -> `schtasks /Run`. La tarea termino, asi que arrancarla
#     devuelve exactamente una instancia.
#   - El proceso existe pero esta DEGRADADO -> se mata SOLO su node y el bucle de
#     start.bat lo relanza en ~16s. Nunca `schtasks /Run` aca: la tarea sigue en
#     Running y con MultipleInstances=IgnoreNew la llamada se ignora sin hacer nada.
#
# Hasta el 2026-09-02 el segundo caso no se tocaba, por miedo a una segunda
# instancia escribiendo sobre el mismo status.json. El miedo era correcto y la
# solucion tambien: matando primero, muere uno y vuelve uno — nunca hay dos.
#
# Lo que costo no arreglarlo: el 2026-09-02 el daemon estuvo 18 HORAS en degraded
# con el proceso vivo. Este vigilante lo detecto a las 09:06 ("cicla pero lleva
# 1.081 min SIN UN CICLO EXITOSO, con el mercado abierto") y anoto relanzado=False.
# Detecto y se quedo mirando. El ntfy tambien fallo, asi que nadie se entero: los
# muros del chart y del celular pasaron la primera hora de sesion 18 horas viejos,
# con el regimen de GEX invertido (decia NEGATIVO cuando era POSITIVO, que es lo
# que habilita al Iron Condor). Un reinicio a mano lo arreglo en 40 segundos.
#
# GUARDA ANTI-BUCLE: como maximo un reinicio forzado cada $minEntreReiniciosMin.
# Si tras reiniciar vuelve a degradarse, es que el reinicio no era el remedio —
# entonces escala el aviso en vez de reiniciar en bucle cada 10 minutos.

$dir        = 'C:\Users\gcarv\bitacora-tasty\gamma_daemon'
# El calendario de la NYSE, el mismo archivo que lee el servidor y el daemon.
# Ver scripts/calendario_nyse.ps1 y src/calendario_nyse.json.
. (Join-Path (Split-Path -Parent $dir) 'scripts\calendario_nyse.ps1')
$statusF    = Join-Path $dir 'status.json'
$stateF     = Join-Path $dir 'watchdog_state.json'
$logF       = Join-Path $dir 'watchdog.log'
$ntfy       = 'https://ntfy.sh/bitacora_gcarvaja51'
$maxEdadMin = 15    # el ciclo normal es de 30s y el degradado de 2 min
$minEntreReiniciosMin = 30   # guarda anti-bucle del reinicio por degradado

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
$ultimoReinicio = $null
if (Test-Path $stateF) {
  try {
    $st = Get-Content $stateF -Raw | ConvertFrom-Json
    $yaAlertado = [bool]$st.alertado
    if ($st.ultimoReinicio) { $ultimoReinicio = [datetime]::Parse($st.ultimoReinicio) }
  } catch {}
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

# ¿Estamos dentro del horario de mercado? Solo entonces tiene sentido exigir
# exitos: fuera de horario el daemon CICLA pero salta el trabajo a proposito
# (lastSkipReason), asi que lastSuccessAt se queda quieto toda la noche sin que
# eso sea una averia.
#
# (2026-09-06) Esta linea calculaba el dia ella misma y solo descartaba sabado y
# domingo. El lunes 2026-09-07 --Labor Day-- iba a dar $true: el vigilante habria
# exigido un ciclo exitoso cada 20 minutos contra un mercado cerrado, marcado el
# daemon como degradado y MATADO el proceso, con su guarda anti-bucle
# permitiendo un reinicio cada 30 min durante toda la jornada. Ahora el dia lo
# decide el calendario compartido (fin de semana Y feriados) y la hora sale de
# la misma fuente, incluidos los medios dias, donde la campana suena a la 1pm.
$enMercado = Test-HorarioDeMercadoNYSE

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

# `$degradado` = el proceso esta VIVO pero sus ciclos no sirven. Es el unico caso
# que se cura matando el node: el atasco vive dentro del proceso (tipicamente un
# Chrome headless colgado que ya no devuelve el simbolo de Sigma), y al arrancar
# de cero el daemon corre limpiarChromiumHuerfano() y levanta un Chrome nuevo.
$problema = $null
$degradado = $false
if (-not $vivo)                    { $problema = 'el proceso node index.js NO existe' }
elseif ($null -eq $edadMin)        { $problema = 'status.json ilegible o sin lastCycleAt' }
elseif ($edadMin -gt $maxEdadMin)  { $problema = ('el proceso existe pero no cicla hace {0:N1} min' -f $edadMin) }
elseif ($fallos -ge 3)             { $problema = ("cicla pero FALLA: {0} ciclos seguidos sin exito (modo {1}). Ultimo error: {2}" -f $fallos, $modo, $ultError); $degradado = $true }
elseif ($enMercado -and ($null -ne $edadExitoMin) -and ($edadExitoMin -gt $maxSinExitoMin)) {
  $problema = ('cicla pero lleva {0:N0} min SIN UN CICLO EXITOSO, con el mercado abierto. Ultimo error: {1}' -f $edadExitoMin, $ultError)
  $degradado = $true
}

if (-not $problema) {
  if ($yaAlertado) {
    Send-Ntfy 'Gamma daemon recuperado' 'default' ('Vuelve a ciclar (ultimo ciclo hace {0:N1} min).' -f $edadMin)
    Write-WLog ('RECUPERADO - ciclo hace {0:N1} min' -f $edadMin)
  }
  $ur = ''
  if ($ultimoReinicio) { $ur = $ultimoReinicio.ToString('o') }
  (@{ alertado = $false; ultimoReinicio = $ur } | ConvertTo-Json -Compress) | Out-File -FilePath $stateF -Encoding utf8
  exit 0
}

$relanzado = $false
if (-not $vivo) {
  # La tarea termino: /Run devuelve exactamente una instancia.
  try { schtasks /Run /TN 'GammaDaemon' | Out-Null; $relanzado = $true; Write-WLog 'GammaDaemon relanzado por el vigilante' }
  catch { Write-WLog "no se pudo relanzar: $($_.Exception.Message)" }
}
elseif ($degradado) {
  # Vivo pero inutil. Se mata SOLO el node del daemon y start.bat lo relanza.
  $minsDesde = $null
  if ($ultimoReinicio) { $minsDesde = ((Get-Date).ToUniversalTime() - $ultimoReinicio.ToUniversalTime()).TotalMinutes }

  if (($null -ne $minsDesde) -and ($minsDesde -lt $minEntreReiniciosMin)) {
    Write-WLog ('degradado, pero ya se reinicio hace {0:N0} min - no se insiste (guarda de {1} min). El reinicio no es el remedio: revisar a mano.' -f $minsDesde, $minEntreReiniciosMin)
  } else {
    # Identificacion ESTRICTA antes de matar: no basta con que la linea de comando
    # diga index.js. Se exige que el PADRE sea el start.bat del gamma_daemon.
    # El 2026-09-01 un filtro ancho ('*server.js*') se llevo por delante el MCP de
    # TradingView; aqui se paga el doble de rigor y no se mata nada dudoso.
    $objetivo = @($proc | Where-Object {
      $padre = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)" -ErrorAction SilentlyContinue
      $padre -and ($padre.CommandLine -like '*gamma_daemon*start.bat*')
    })
    if ($objetivo.Count -eq 0) {
      Write-WLog 'degradado, pero ningun node index.js tiene por padre el start.bat del gamma_daemon - NO se mata nada. Revisar a mano.'
    } else {
      foreach ($o in $objetivo) {
        try { Stop-Process -Id $o.ProcessId -Force -ErrorAction Stop; Write-WLog ('degradado: matado node PID {0}; start.bat lo relanza en ~16s' -f $o.ProcessId); $relanzado = $true }
        catch { Write-WLog ('no se pudo matar el PID {0}: {1}' -f $o.ProcessId, $_.Exception.Message) }
      }
      if ($relanzado) { $ultimoReinicio = (Get-Date).ToUniversalTime() }
    }
  }
}

Write-WLog "PROBLEMA: $problema (relanzado=$relanzado)"
if (-not $yaAlertado) {
  $detalle = if ($relanzado -and $degradado) {
    'Estaba vivo pero degradado: se mato su node y start.bat lo relanza -- confirmar que vuelva a tener ciclos EXITOSOS, no solo que cicle.'
  } elseif ($relanzado) {
    'Se relanzo la tarea GammaDaemon automaticamente -- confirmar que vuelva a ciclar.'
  } else {
    'NO se relanzo (guarda anti-bucle o no se pudo identificar el proceso con certeza). Revisar a mano.'
  }
  Send-Ntfy 'Gamma daemon caido' 'urgent' "$problema. $detalle"
}
$ur2 = ''
if ($ultimoReinicio) { $ur2 = $ultimoReinicio.ToString('o') }
(@{ alertado = $true; ultimoReinicio = $ur2 } | ConvertTo-Json -Compress) | Out-File -FilePath $stateF -Encoding utf8
exit 1
