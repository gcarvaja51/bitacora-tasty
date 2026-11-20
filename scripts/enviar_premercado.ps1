# ============================================================
#  Sube el premercado del dia al servidor (2026-11-09)
#  El freno del premercado del direccional v2 decide en Railway, pero el
#  premercado se escribe en la PC (premercado_hipotesis_log.json). Este
#  script toma la entrada de HOY y la manda a POST /api/premercado.
#  Idempotente: se puede correr varias veces, manda la ultima version.
#  Tarea: Bitacora_EnviarPremercado (lun-vie 09:05, 09:35 y 10:30 ET).
#  Si a las 09:35 no hay premercado de hoy, avisa por ntfy: sin el, el
#  freno deja pasar todo ese dia.
# ============================================================
param([switch]$Prueba)

$BASE = "https://web-production-23473.up.railway.app"
$LOG_PREM = Join-Path $env:USERPROFILE "Documents\CARPETA PERSONAL\01. guillermo carvajal\01_Sigma\mentoria alejandro\premercados alejandro\control premercado\premercado_hipotesis_log.json"
$logPath = "C:\Users\gcarv\bitacora-tasty\datos\enviar_premercado_log.txt"
New-Item -ItemType Directory -Force -Path (Split-Path $logPath) | Out-Null
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Out-File -FilePath $logPath -Append -Encoding utf8 }
function Avisar($titulo, $texto) {
    if ($Prueba) { Log "[PRUEBA, no enviado] $titulo :: $texto"; return }
    $body = @{ topic = 'bitacora_gcarvaja51'; title = $titulo; message = $texto; priority = 4; tags = @('warning') } | ConvertTo-Json
    try { Invoke-RestMethod -Uri "https://ntfy.sh/" -Method Post -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20 | Out-Null } catch {}
}

$hoy = Get-Date -Format "yyyy-MM-dd"     # la PC esta en UTC-5: coincide con el dia de mercado de NY
$dia = (Get-Date).DayOfWeek
if ($dia -eq 'Saturday' -or $dia -eq 'Sunday') { Log "fin de semana: nada que enviar"; exit 0 }

try {
    $texto = [System.IO.File]::ReadAllText($LOG_PREM, [System.Text.Encoding]::UTF8)
    $entradas = $texto | ConvertFrom-Json
} catch { Log "ERROR leyendo el log del premercado: $($_.Exception.Message)"; exit 1 }

$e = @($entradas | Where-Object { $_.fecha -eq $hoy }) | Select-Object -Last 1
if (-not $e -or -not $e.probabilidades) {
    Log "todavia no hay premercado de hoy ($hoy) con probabilidades"
    $ahora = (Get-Date).Hour * 60 + (Get-Date).Minute
    if ($ahora -ge (9 * 60 + 30) -and $ahora -lt (10 * 60)) {
        Avisar "⚠️ El premercado de hoy no llegó al robot" "A las $(Get-Date -Format 'HH:mm') no hay premercado del $hoy con probabilidades. Sin él, el freno del premercado del direccional deja pasar todo hoy."
    }
    exit 0
}

$cuerpo = [ordered]@{
    fecha              = $e.fecha
    probabilidades     = $e.probabilidades
    escenarios         = $e.escenarios
    niveles_clave      = $e.niveles_clave
    apertura_implicita = $e.apertura_implicita
    sin_trade_d19      = $e.sin_trade_d19
} | ConvertTo-Json -Depth 12

if ($Prueba) { Log "[PRUEBA] enviaria el premercado del $hoy ($($e.probabilidades | ConvertTo-Json -Compress))"; exit 0 }
try {
    $r = Invoke-RestMethod -Uri "$BASE/api/premercado" -Method Post -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpo)) -TimeoutSec 60
    Log "enviado $hoy -> $($r.probabilidades | ConvertTo-Json -Compress)"
    exit 0
} catch {
    Log "ERROR enviando: $($_.Exception.Message)"
    Avisar "⚠️ No se pudo subir el premercado al robot" "Error al enviar el premercado del $hoy : $($_.Exception.Message)"
    exit 1
}
