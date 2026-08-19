# Revision del efecto de los cambios en Reversion a la Media (2026-08-19).
#
# QUE MIDE. El 19-ago se tocaron dos puertas de smaReversion:
#   extBandMinPct         0.13 -> 0.10
#   requiereGammaPositivo true -> false   (el gamma vuelve a pesar 10/100, no veta)
#
# Los cambios se aplicaron DESPUES de las 13:00 ET, o sea despues de que cerrara
# la ventana de la estrategia (9:45am-1pm ET), asi que ese dia no llegaron a
# probarse: las 192 evaluaciones del 19-ago corrieron con la config vieja. Este
# script compara el dia pedido contra esa linea base y dice si sirvieron.
#
# TODO EL ARCHIVO VA EN ASCII, SIN TILDES NI EN LOS TEXTOS. PowerShell 5.1 lee
# los .ps1 como ANSI cuando no hay BOM, y un solo caracter acentuado -- peor aun
# en un nombre de variable -- rompe el parser entero. Evitarlos elimina la
# dependencia de como quedo guardado el archivo.
#
# Uso:
#   .\revision_reversion.ps1                 -> hoy
#   .\revision_reversion.ps1 -Dia 2026-08-20 -> un dia concreto
#   .\revision_reversion.ps1 -SinNtfy        -> no manda notificacion

param(
    [string]$Dia = '',
    [switch]$SinNtfy
)

$BASE = 'https://web-production-23473.up.railway.app'
$NTFY = 'https://ntfy.sh/bitacora_gcarvaja51'
$LOG  = Join-Path $PSScriptRoot 'revision_reversion.log'

# Linea base medida el 19-ago con la config VIEJA (banda 0.13, gamma como puerta)
$BASE_DIA = @{ total = 192; SIN_ALEJAMIENTO = 165; GAMMA_NO_POSITIVO = 14; SCORE_FAIL = 13; SIGNAL_BUILT = 0 }
$HIST_DIAS = 12
$HIST_SENALES = 2


# ?? HTTP con .NET puro, SIN Invoke-RestMethod ????????????????????????????????
#
# Invoke-RestMethod / Invoke-WebRequest en PowerShell 5.1 se apoyan en el motor
# de Internet Explorer. En una sesion no interactiva -- que es como corre el Task
# Scheduler -- esa dependencia se BLOQUEA: la tarea quedaba en Running para
# siempre sin escribir una linea, mientras el mismo script a mano terminaba en
# menos de un segundo.
#
# Se llego aca por descarte, no por corazonada: fallaba igual escrito en Python
# (urllib) y en PowerShell, con wrapper .vbs y sin el, con python.exe y con
# pythonw.exe, con y sin ProxyHandler vacio. El unico factor comun era la llamada
# HTTPS. watchdog.ps1 no lo sufre porque en su camino normal sale antes de hacer
# ninguna peticion -- por eso parecia que el patron .vbs+PowerShell si servia.
#
# HttpClient va directo contra la pila de red de .NET y no toca IE.
function Fetch-Json([string]$url, [int]$timeoutSeg = 60) {
    Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
    $h = New-Object System.Net.Http.HttpClient
    $h.Timeout = [TimeSpan]::FromSeconds($timeoutSeg)
    try {
        return ($h.GetStringAsync($url).GetAwaiter().GetResult() | ConvertFrom-Json)
    } finally { $h.Dispose() }
}

function Post-Ntfy([string]$url, [hashtable]$cab, [string]$cuerpo, [int]$timeoutSeg = 20) {
    Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
    $h = New-Object System.Net.Http.HttpClient
    $h.Timeout = [TimeSpan]::FromSeconds($timeoutSeg)
    try {
        foreach ($k in $cab.Keys) { [void]$h.DefaultRequestHeaders.TryAddWithoutValidation($k, $cab[$k]) }
        $c = New-Object System.Net.Http.StringContent($cuerpo, [System.Text.Encoding]::UTF8, 'text/plain')
        [void]$h.PostAsync($url, $c).GetAwaiter().GetResult()
    } finally { $h.Dispose() }
}


function Emitir([string]$txt) {
    # El informe de verdad va al log y al ntfy. La salida por pantalla solo sirve
    # cuando alguien lo corre a mano, y su ausencia no debe romper la tarea.
    try { Write-Output $txt } catch { }
    try {
        Add-Content -Path $LOG -Value ("`n" + ('=' * 70)) -Encoding utf8
        Add-Content -Path $LOG -Value (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') -Encoding utf8
        Add-Content -Path $LOG -Value $txt -Encoding utf8
    } catch { }
}

function Avisar([string]$titulo, [string]$cuerpo, [string]$prioridad = 'default') {
    try {
        Post-Ntfy $NTFY @{ Title = $titulo; Priority = $prioridad; Tags = 'chart_with_upwards_trend' } $cuerpo
    } catch { Emitir "(ntfy fallo: $($_.Exception.Message))" }
}

function Cnt($obj, $k) {
    if ($obj -and ($obj.PSObject.Properties.Name -contains $k)) { return [int]$obj.$k }
    return 0
}


if (-not $Dia) {
    $et = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'Eastern Standard Time')
    $Dia = $et.ToString('yyyy-MM-dd')
}

try {
    $res = Fetch-Json "$BASE/api/spx/strategy-log?date=$Dia&family=REVERSION&resumen=true" 90
    $cfg = Fetch-Json "$BASE/api/spx/config" 60
} catch {
    Emitir "REVERSION $Dia - NO se pudo consultar el servidor: $($_.Exception.Message)"
    if (-not $SinNtfy) { Avisar 'Reversion: fallo la consulta' "No se pudo leer el log de estrategia: $($_.Exception.Message)" 'high' }
    exit 1
}

if ($cfg.config) { $cfg = $cfg.config }
$rev    = $cfg.trading.smaReversion
$etapas = $res.porEtapa
$total  = [int]$res.total

$L = New-Object System.Collections.ArrayList
[void]$L.Add("REVERSION - revision del $Dia")
[void]$L.Add('')
[void]$L.Add("config vigente: banda $($rev.extBandMinPct)-$($rev.extBandMaxPct)% | gamma como puerta: $($rev.requiereGammaPositivo) | minScore $($rev.minScore)")
[void]$L.Add('')

if ($total -eq 0) {
    [void]$L.Add('SIN EVALUACIONES ese dia. O el mercado estuvo cerrado, o la estrategia no')
    [void]$L.Add('corrio - revisar el daemon y los interruptores antes de sacar conclusiones.')
    $salida = $L -join "`n"
    Emitir $salida
    if (-not $SinNtfy) { Avisar 'Reversion: SIN evaluaciones' $salida 'high' }
    exit 0
}

$senales = Cnt $etapas 'SIGNAL_BUILT'
$sinAlej = Cnt $etapas 'SIN_ALEJAMIENTO'
$pctAlej = 100.0 * $sinAlej / $total

[void]$L.Add("$total evaluaciones (linea base 19-ago: $($BASE_DIA.total))")
[void]$L.Add('')
[void]$L.Add(("{0,-24}{1,7}{2,9}{3,9}" -f 'etapa', 'hoy', '19-ago', 'cambio'))
$claves = @($etapas.PSObject.Properties.Name) + @($BASE_DIA.Keys | Where-Object { $_ -ne 'total' }) | Select-Object -Unique
foreach ($k in ($claves | Sort-Object { -(Cnt $etapas $_) })) {
    $hoy = Cnt $etapas $k
    $ant = 0
    if ($BASE_DIA.ContainsKey($k)) { $ant = $BASE_DIA[$k] }
    [void]$L.Add(("{0,-24}{1,7}{2,9}{3,9}" -f $k, $hoy, $ant, ('{0:+#;-#;0}' -f ($hoy - $ant))))
}

[void]$L.Add('')
[void]$L.Add(("SIN_ALEJAMIENTO: {0:N1}% del total (19-ago: 85.9%)" -f $pctAlej))
[void]$L.Add("SENALES GENERADAS: $senales   (19-ago: 0 | historico: $HIST_SENALES en $HIST_DIAS dias)")
[void]$L.Add('')

# Umbrales medidos: con banda 0.10 sobre la muestra historica pasaban 83 de 1329
# (6,2%), o sea ~7 evaluaciones al dia deberian superar el alejamiento. Si el
# porcentaje no se movio, la banda sigue corta.
if ($senales -gt 0) {
    [void]$L.Add("VEREDICTO: los cambios FUNCIONARON - $senales senal(es) donde antes habia 0.")
    [void]$L.Add('Siguiente pregunta: cuantas se convirtieron en trade y como cerraron.')
    $prio = 'default'
} elseif ($pctAlej -lt 78) {
    [void]$L.Add('VEREDICTO: la banda SI abrio (menos rechazos por alejamiento) pero no hubo')
    [void]$L.Add('senal. El cuello de botella se movio: mirar SCORE_FAIL - minScore 75 con un')
    [void]$L.Add('factor que vale 45 hace casi imposible compensar el alejamiento fallado.')
    $prio = 'default'
} else {
    [void]$L.Add('VEREDICTO: la banda de 0.10% TAMPOCO alcanza - el rechazo por alejamiento no')
    [void]$L.Add('bajo. El arreglo de fondo es expresar la banda en ATR y no en % fijo: con el')
    [void]$L.Add('VIX en 15 el SPX no se despega de su SMA8 lo que la puerta exige.')
    $prio = 'high'
}

$salida = $L -join "`n"
Emitir $salida
if (-not $SinNtfy) { Avisar "Reversion $Dia - $senales senal(es)" $salida $prio }

# Salida explicita (2026-08-19). Sin esto el proceso quedaba vivo despues de
# escribir el informe y el Task Scheduler dejaba la tarea en Running: HttpClient
# mantiene el pool de conexiones abierto y PowerShell espera a que se cierre.
# El trabajo ya esta hecho a esta altura -- el log escrito y el ntfy enviado --
# asi que no hay nada que perder por cortar aqui.
exit 0