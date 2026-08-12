# ============================================================
#  Gate de disparo automatico del Premercado SPX
#  Invocado por 2 triggers diarios de Windows Task Scheduler
#  (uno para horario EDT, otro para EST -- ver SKILL.md,
#  seccion "Disparo automatico"). Este script decide si HOY
#  y AHORA es el momento correcto de lanzar el skill, y si no
#  lo es, sale en silencio sin tocar TradingView/Chrome/claude.
# ============================================================

$logDir = "C:\Users\gcarv\Documents\CARPETA PERSONAL\01. guillermo carvajal\01_Sigma\mentoria alejandro\premercados alejandro\control premercado"
$logFile = Join-Path $logDir "premercado_auto_launch.log"

function Write-Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$ts  $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

# Notificacion push via ntfy.sh -- mismo topic que ya usa todo el resto del
# sistema (server.js, gamma_daemon). Agregado 2026-08-03 tras descubrir que el
# gate llevaba 2 dias fallando en silencio (error de sintaxis) sin que nadie se
# enterara, porque la unica evidencia era el log en disco que nadie abre.
# Best-effort: si ntfy no responde, NO debe tumbar la corrida.
$NTFY_TOPIC = "bitacora_gcarvaja51"
function Send-Ntfy($message, $title, $priority) {
    if (-not $priority) { $priority = "default" }
    try {
        Invoke-RestMethod -Uri "https://ntfy.sh/$NTFY_TOPIC" -Method Post `
            -Headers @{ Title = $title; Priority = $priority; Tags = "chart_with_upwards_trend" } `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($message)) `
            -TimeoutSec 15 | Out-Null
    } catch {
        Write-Log "ntfy fallo (no critico): $($_.Exception.Message)"
    }
}

# Hora real en ET (maneja DST solo -- por eso hay 2 triggers de Windows,
# uno cubre EDT y otro EST, y este chequeo descarta el que no corresponde)
$etNow = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, "Eastern Standard Time")

# 1) Ventana horaria: solo entre 8:15am y 8:45am ET (1 hora antes de la
#    apertura de 9:30am, con margen para el jitter de Task Scheduler)
$windowStart = New-Object DateTime($etNow.Year, $etNow.Month, $etNow.Day, 8, 15, 0)
$windowEnd   = New-Object DateTime($etNow.Year, $etNow.Month, $etNow.Day, 8, 45, 0)
if ($etNow -lt $windowStart -or $etNow -gt $windowEnd) {
    Write-Log "SKIP - fuera de ventana horaria (ET actual: $($etNow.ToString('HH:mm')), esperado 08:15-08:45). Este es el trigger de la temporada equivocada (EDT/EST) -- normal, no es un error."
    exit 0
}

# 2) Dia habil (defense in depth -- el trigger de Windows ya filtra
#    Lun-Vie, pero se revalida aca por si alguna vez se edita a mano)
if ($etNow.DayOfWeek -eq [DayOfWeek]::Saturday -or $etNow.DayOfWeek -eq [DayOfWeek]::Sunday) {
    Write-Log "SKIP - fin de semana ($($etNow.DayOfWeek))."
    exit 0
}

# 3) Feriados NYSE -- lista fija, ACTUALIZAR CADA ENERO para el año
#    siguiente (ver SKILL.md, seccion "Disparo automatico" para el
#    criterio de cada feriado). Formato yyyy-MM-dd.
$feriadosNYSE = @(
    # 2026
    "2026-01-01", # New Year's Day
    "2026-01-19", # Martin Luther King Jr. Day
    "2026-02-16", # Washington's Birthday (Presidents Day)
    "2026-04-03", # Good Friday
    "2026-05-25", # Memorial Day
    "2026-06-19", # Juneteenth
    "2026-07-03", # Independence Day (observado, 4-jul cae sabado)
    "2026-09-07", # Labor Day
    "2026-11-26", # Thanksgiving
    "2026-12-25"  # Christmas
)
$hoyStr = $etNow.ToString("yyyy-MM-dd")
if ($feriadosNYSE -contains $hoyStr) {
    Write-Log "SKIP - feriado NYSE ($hoyStr)."
    exit 0
}

# 4) Limpieza de procesos zombie del MCP server de TradingView.
#    Incidente real 2026-07-30: quedan procesos node.exe viejos del server
#    (C:\Users\gcarv\tradingview-mcp\src\server.js) de sesiones anteriores
#    que nunca terminaron limpiamente. Cuando eso pasa, un cambio de
#    CDP_PORT en .mcp.json no se aplica (el proceso viejo sigue vivo con
#    el puerto anterior en memoria) y la corrida entera termina peleando
#    con la conexion CDP en vez de hacer el analisis. Matarlos antes de
#    lanzar claude.cmd garantiza que el server que arranque sea nuevo y
#    lea el env var actual.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*tradingview-mcp*server.js*" } |
    ForEach-Object {
        Write-Log "Matando proceso MCP viejo de tradingview-mcp (PID $($_.ProcessId))"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

# 4.5) Recolector de datos (2026-08-01, nuevo) -- corre ANTES que claude.cmd para
#      dejar ya en disco la captura del chart de 30min + valores de estudios de
#      TradingView, y el ultimo snapshot de Sigma Terminal (via gamma_daemon/status.json,
#      sin lanzar un Chrome nuevo -- ver premercado_collector/collect.js). Best-effort:
#      si falla, NO aborta el gate -- el skill igual puede correr en modo manual/fallback
#      como ya hacia antes de que existiera el colector, solo pierde la ventaja de tener
#      los datos ya listos.
Write-Log "Corriendo recolector de datos (TradingView + Sigma) antes del skill..."
Push-Location "C:\Users\gcarv\bitacora-tasty\premercado_collector"
try {
    # Timeout duro de 5 min: el colector se colgo indefinidamente el 2026-08-02
    # (bug de conexion CDP). Sin techo, ese cuelgue consume la ventana previa a
    # la apertura ANTES de que claude.cmd llegue a correr -- el timeout de 30 min
    # de mas abajo no sirve de nada si nunca se llega a esa linea.
    $collectorOutFile = Join-Path $logDir "premercado_collector_ultima_salida.txt"
    $cproc = Start-Process -FilePath "node" -ArgumentList 'collect.js' `
        -RedirectStandardOutput $collectorOutFile -RedirectStandardError (Join-Path $logDir "premercado_collector_stderr.txt") `
        -NoNewWindow -PassThru
    # Ver nota extensa en el bloque 5): tocar .Handle ANTES de esperar es lo
    # unico que hace que .ExitCode quede poblado con Start-Process -PassThru.
    # Aca el exit code solo va al log, pero sin esto se loguea siempre vacio.
    $null = $cproc.Handle
    if (-not $cproc.WaitForExit(5 * 60 * 1000)) {
        Stop-Process -Id $cproc.Id -Force -ErrorAction SilentlyContinue
        Write-Log "Recolector: TIMEOUT (>5 min), proceso terminado. Se sigue igual con el fallback manual del skill."
    } else {
        $collectorOut = ""
        if (Test-Path $collectorOutFile) { $collectorOut = (Get-Content $collectorOutFile -Raw) }
        $collectorLinea = ($collectorOut.Trim() -replace "`r?`n", ' | ')
        Write-Log "Recolector (exit $($cproc.ExitCode)): $collectorLinea"
    }
} catch {
    Write-Log "Recolector fallo por completo (excepcion): $($_.Exception.Message)"
} finally {
    Pop-Location
}

# 5) Todo OK -- lanzar el skill en modo headless, sin intervencion humana.
#    --permission-mode bypassPermissions: no hay usuario presente para
#    aprobar nada: el allowlist de .claude/settings.json ya cubre las
#    tools de lectura, pero las de escritura (chart_set_symbol,
#    indicator_set_inputs, etc.) tambien quedan sin preguntar bajo este
#    modo -- aceptable porque el skill no hace ninguna accion destructiva
#    (no git push, no borrados, no compras) segun quedo confirmado el
#    2026-07-29 al revisar el flujo completo paso a paso.
#    --chrome: fuerza la integracion de Claude en Chrome (necesaria para
#    leer Sigma Terminal) incluso en modo -p no interactivo.
Write-Log "LANZANDO premercado-spx (ET $($etNow.ToString('HH:mm')), $hoyStr)"

Set-Location "C:\Users\gcarv\bitacora-tasty"

$outFile = Join-Path $logDir "premercado_auto_launch_ultima_salida.txt"
$errFile = Join-Path $logDir "premercado_auto_launch_stderr.txt"
# Incidente real 2026-07-30: "& claude.cmd ... 2>&1 | Out-File" bajo esta
# cadena de ejecucion oculta (Tarea -> wscript -> powershell -NoProfile)
# perdio TODA la salida (el archivo quedo vacio) pese a que la sesion real
# si hizo trabajo real durante 19 minutos. Start-Process con
# -RedirectStandardOutput/-RedirectStandardError escribe directo a archivo
# sin depender de que la tuberia de PowerShell tenga una consola detras,
# que es lo que fallaba antes.
$proc = Start-Process -FilePath "claude.cmd" `
    -ArgumentList '-p', '"/premercado-spx"', '--permission-mode', 'bypassPermissions', '--chrome' `
    -RedirectStandardOutput $outFile -RedirectStandardError $errFile `
    -NoNewWindow -PassThru

# Bug real encontrado el 2026-08-11, activo desde el 2026-07-31: con
# Start-Process -PassThru, PowerShell 5.1 NO retiene el handle del proceso, y
# .ExitCode queda en $null para siempre una vez que el proceso muere. La
# condicion de exito de mas abajo era "(Test-Path $docx) -and $exitCode -eq 0";
# como $null -eq 0 es $false, la rama EXITO era INALCANZABLE: toda corrida
# buena se logueaba como FALLO y disparaba la alerta ntfy de prioridad alta.
# Cuatro dias (5, 6, 7 y 11 de agosto) quedaron marcados como fallo habiendo
# generado el documento, y eso enmascaro el fallo REAL del 10-ago.
# Leer .Handle antes de esperar fuerza a que el handle quede cacheado y
# .ExitCode se pueble correctamente. Verificado empiricamente: sin esta linea
# devuelve vacio, con ella devuelve el codigo real. El .WaitForExit() sin
# argumentos NO sirve como alternativa (tambien devuelve vacio).
$null = $proc.Handle

# Techo duro de 30 min. Incidente real 2026-07-30: el proceso se colgo 26
# min sin ninguna actividad tras el ultimo tool call (probablemente CDP
# atascado) y solo "goteo" hasta morir cerca del limite de 1h de la Tarea
# -- sin este timeout, un cuelgue similar consume toda la ventana previa a
# la apertura sin que quede ninguna senal clara de que algo salio mal.
$timeoutMin = 30
$docxEsperado = Join-Path (Join-Path $logDir "..\documentos premercado") "$($etNow.ToString('MMddyyyy'))_premercado claude.docx"

# Periodo de gracia: el .docx no siempre esta en disco en el instante exacto en
# que claude.cmd devuelve el control (python-docx todavia cerrando el archivo,
# flush del SO, indexador de OneDrive). Incidente real 2026-08-04: el watchdog
# verifico la existencia del .docx ~1 min ANTES de que se escribiera y logueo
# FALLO sobre una corrida que si habia funcionado. Reintentar unos minutos
# cuesta nada y elimina esa clase entera de falso negativo.
function Wait-ForDocx($ruta, $graciaSeg) {
    $limite = (Get-Date).AddSeconds($graciaSeg)
    while ((Get-Date) -lt $limite) {
        if (Test-Path $ruta) {
            # Esperar a que el tamaño se estabilice: existir != estar completo.
            $t1 = (Get-Item $ruta).Length
            Start-Sleep -Seconds 3
            if ((Test-Path $ruta) -and (Get-Item $ruta).Length -eq $t1 -and $t1 -gt 0) { return $true }
        }
        Start-Sleep -Seconds 5
    }
    return (Test-Path $ruta)
}

$colgado = $false
if (-not $proc.WaitForExit($timeoutMin * 60 * 1000)) {
    $colgado = $true
    Write-Log "Timeout - claude.cmd supero $timeoutMin min, forzando cierre. Verificando si alcanzo a dejar el documento..."
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}

$exitCode = $proc.ExitCode
if ($null -eq $exitCode) { $exitCode = "desconocido" }

# El documento es la unica senal que importa: es el entregable. El exit code va
# al log como informacion, pero NO decide exito/fallo -- decidirlo con el exit
# code fue exactamente el bug que rompio la deteccion durante 12 dias.
if (Wait-ForDocx $docxEsperado 180) {
    $nombreDocx = Split-Path $docxEsperado -Leaf
    $nota = if ($colgado) { " (se genero pese a que hubo que matar el proceso por timeout de $timeoutMin min -- revisar $outFile)" } else { "" }
    Write-Log "EXITO - documento generado$nota. Exit code reportado: $exitCode. Ver $outFile para el detalle."
    Send-Ntfy "Documento guardado: $nombreDocx (carpeta 'documentos premercado').$nota" "Premercado SPX listo" "default"
    exit 0
} else {
    $motivo = if ($colgado) { "se colgo mas de $timeoutMin min y se cancelo" } else { "termino (exit $exitCode)" }
    Write-Log "FALLO - la corrida $motivo y NO se encontro el documento esperado tras 3 min de gracia ($docxEsperado). Revisar $outFile y $errFile."
    Send-Ntfy "La corrida $motivo y NO genero el documento. HOY NO HAY PREMERCADO -- hay que correrlo a mano antes de la apertura." "Premercado SPX: FALLO (sin documento)" "high"
    # exit 2 = "fallo, pero YA notifique yo mismo" -- el .vbs no debe duplicar el aviso
    exit 2
}
