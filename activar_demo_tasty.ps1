# ============================================================
#  Direccional -> demo de TastyTrade (2026-11-10, una sola vez)
#  Pedido de Guillermo el 2026-11-09: "programa tarea".
#
#  -Modo activar  (09:15 ET): pasa trading.ejecutorTendencia a 'tasty_demo'
#                 por POST /api/tendencia/ejecutor y verifica que quedo.
#  -Modo revisar  (12:00 y 16:20 ET): cuenta los trades demo del dia, los
#                 intentos que no abrieron (DEMO_TASTY_NO_ABRIO) y alerta si
#                 aparecio un direccional NUEVO en Tradier despues de activar.
#
#  Todo sale por ntfy. Para volver atras:
#    POST /api/tendencia/ejecutor {"modo":"tradier"}
#  Tareas: Bitacora_DemoTasty_Activar / _Revisar1200 / _Revisar1620
# ============================================================
param([ValidateSet('activar','revisar')][string]$Modo = 'revisar', [switch]$Prueba)

$BASE    = "https://web-production-23473.up.railway.app"
$logPath = "C:\Users\gcarv\bitacora-tasty\activar_demo_tasty_log.txt"
$ACTIVADO_DESDE = "2026-11-10T14:15:00Z"   # 09:15 ET

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$ts  [$Modo] $msg" | Out-File -FilePath $logPath -Append -Encoding utf8
}

function Avisar($titulo, $texto, $prioridad = 3, $tag = 'chart_with_upwards_trend') {
    if ($Prueba) { Log "[PRUEBA, no enviado] $titulo :: $($texto -replace "`n", ' | ')"; return }
    $body = @{ topic = 'bitacora_gcarvaja51'; title = $titulo; message = $texto; priority = $prioridad; tags = @($tag) } | ConvertTo-Json -Depth 4
    try {
        Invoke-RestMethod -Uri "https://ntfy.sh/" -Method Post -ContentType "application/json; charset=utf-8" `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20 | Out-Null
    } catch { Log "ntfy fallo: $($_.Exception.Message)" }
}

function Pedir($ruta, $metodo = 'Get', $cuerpo = $null) {
    for ($i = 1; $i -le 3; $i++) {
        try {
            if ($cuerpo) {
                return Invoke-RestMethod -Uri "$BASE$ruta" -Method $metodo -ContentType "application/json" -Body ($cuerpo | ConvertTo-Json) -TimeoutSec 60
            }
            return Invoke-RestMethod -Uri "$BASE$ruta" -Method $metodo -TimeoutSec 60
        } catch {
            Log "intento $i de $metodo $ruta fallo: $($_.Exception.Message)"
            if ($i -lt 3) { Start-Sleep -Seconds 30 }
        }
    }
    return $null
}

$hoy = Get-Date -Format "yyyy-MM-dd"

if ($Modo -eq 'activar') {
    $estado = Pedir "/api/tendencia/ejecutor"
    if (-not $estado) {
        Log "ERROR: produccion no responde; no se activo"
        Avisar "🚨 Demo TastyTrade: NO se activó" "Producción no respondió a las 9:15. El direccional sigue en Tradier. Hay que activarlo a mano." 5 'rotating_light'
        exit 1
    }
    $sw = Pedir "/api/spx/strategies"
    $dirEncendido = if ($sw) { $sw.estrategias.DIRECCIONAL } else { $null }

    if ($estado.modo -eq 'tasty_demo') {
        Log "ya estaba en tasty_demo"
        Avisar "Demo TastyTrade: ya estaba activa" "El direccional ya ejecutaba en la demo. Saldo demo: $($estado.cuentaDemo.saldo)." 3
        exit 0
    }

    $r = Pedir "/api/tendencia/ejecutor" 'Post' @{ modo = 'tasty_demo' }
    $ver = Pedir "/api/tendencia/ejecutor"
    if ($ver -and $ver.modo -eq 'tasty_demo') {
        Log "ACTIVADO: $($r.antes) -> $($ver.modo); saldo demo $($ver.cuentaDemo.saldo); interruptor DIRECCIONAL=$dirEncendido"
        $nota = if ($dirEncendido -eq $false) { " ⚠️ OJO: el interruptor del Direccional está APAGADO en el Dashboard: no va a abrir nada hasta encenderlo." } else { "" }
        Avisar "✅ Direccional ahora ejecuta en la demo de TastyTrade" ("Interruptor: $($r.antes) → tasty_demo. Cuenta demo: `$$($ver.cuentaDemo.saldo). Revisión a las 12:00 y a las 16:20." + $nota) 4 'white_check_mark'
        exit 0
    }
    Log "ERROR: el POST no dejo el interruptor en tasty_demo (respuesta: $($r | ConvertTo-Json -Compress))"
    Avisar "🚨 Demo TastyTrade: NO se activó" "El interruptor no quedó en tasty_demo. El direccional sigue en Tradier. Revisar a mano." 5 'rotating_light'
    exit 1
}

# ── revisar ────────────────────────────────────────────────
$estado = Pedir "/api/tendencia/ejecutor"
$ex     = Pedir "/api/tradier/executions"
$noAbrio = Pedir "/api/spx/strategy-log?date=$hoy&family=TENDENCIA&stage=DEMO_TASTY_NO_ABRIO"
if (-not $estado -or -not $ex) {
    Log "ERROR: produccion no responde"
    Avisar "⚠️ Demo TastyTrade: no se pudo revisar" "Producción no respondió a la revisión de las $(Get-Date -Format 'HH:mm')." 4 'warning'
    exit 1
}

$demoHoy = @($ex.executions | Where-Object { $_.broker -eq 'tasty_demo' -and $_.timestamp -and $_.timestamp.StartsWith($hoy) })
$abiertos = @($demoHoy | Where-Object { $_.status -eq 'filled' })
$cerrados = @($demoHoy | Where-Object { $_.status -eq 'closed' })
$pnl = 0; foreach ($t in $cerrados) { if ($t.resultadoOficial.pnl -ne $null) { $pnl += [double]$t.resultadoOficial.pnl } }
$tradierNuevos = @($ex.executions | Where-Object {
    $_.strategyFamily -eq 'TENDENCIA' -and $_.broker -ne 'tasty_demo' -and $_.timestamp -and $_.timestamp -gt $ACTIVADO_DESDE })
$nNoAbrio = @($noAbrio).Count
$ultimoMotivo = if ($nNoAbrio -gt 0) { " Último motivo: $(@($noAbrio)[0].reason)" } else { "" }

$lineas = @(
    "Ejecutor: $($estado.modo).",
    "Trades demo hoy: $($demoHoy.Count) ($($cerrados.Count) cerrados, $($abiertos.Count) abiertos). P&L bruto cerrado: `$$([math]::Round($pnl,2)).",
    "Saldo demo: `$$($estado.cuentaDemo.saldo) (disponible `$$($estado.cuentaDemo.disponible)).",
    "Intentos que no abrieron: $nNoAbrio.$ultimoMotivo"
)
$texto = $lineas -join "`n"
Log ($texto -replace "`n", " | ")

if ($estado.modo -ne 'tasty_demo') {
    Avisar "⚠️ Demo TastyTrade: el interruptor NO está en la demo" "$texto" 4 'warning'
} elseif ($tradierNuevos.Count -gt 0) {
    Avisar "🚨 Demo TastyTrade: entró un direccional por Tradier" ("$texto`nTrades TENDENCIA nuevos en Tradier después de activar: $($tradierNuevos.Count). El interruptor no está tomando.") 5 'rotating_light'
} elseif ($nNoAbrio -gt 0 -and $demoHoy.Count -eq 0) {
    Avisar "⚠️ Demo TastyTrade: señales sin abrir" "$texto" 4 'warning'
} else {
    Avisar "Demo TastyTrade · revisión $(Get-Date -Format 'HH:mm')" "$texto" 3 'bar_chart'
}
exit 0
