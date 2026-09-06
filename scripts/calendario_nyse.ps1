# ── El calendario de la NYSE para el lado PowerShell — UN SOLO SITIO ─────────
#
# Gemelo de src/calendario_nyse.js. Lee EL MISMO src/calendario_nyse.json, que
# es todo el punto: hasta el 2026-09-06 cada script de PowerShell traia su
# propio "es sabado o domingo?" y solo el gate del premercado tenia su propia
# lista de feriados —copiada a mano, que es como las listas se separan—. El
# lunes 2026-09-07 era Labor Day y el resto iba a correr igual.
#
# NO copiar fechas aca. Si hay que actualizar el calendario, se actualiza el
# JSON y las dos mitades del sistema se enteran a la vez.
#
# Uso, desde cualquier script del repo:
#
#     . "$PSScriptRoot\..\scripts\calendario_nyse.ps1"     # ajustar la subida
#     if (-not (Test-DiaDeMercadoNYSE)) {
#         Add-Content $log "$stamp  SKIP - $(Get-MotivoCierreNYSE)"
#         exit 0
#     }
#
# Todas las funciones aceptan -Fecha 'yyyy-MM-dd' para poder probarlas contra
# una fecha fija en vez de contra el reloj.

$ErrorActionPreference = 'Stop'

$script:CalNyseRutaJson = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\calendario_nyse.json'
$script:CalNyseDatos = $null

function Get-CalendarioNYSE {
    # Se cachea por sesion de script. Si el archivo no esta se deja reventar: un
    # calendario que no carga tiene que parar el script, no degradarse en
    # silencio a "todos los dias son habiles".
    if ($null -eq $script:CalNyseDatos) {
        if (-not (Test-Path $script:CalNyseRutaJson)) {
            throw "No se encuentra el calendario NYSE en $($script:CalNyseRutaJson). Sin el no se puede decidir si hay mercado."
        }
        $script:CalNyseDatos = Get-Content $script:CalNyseRutaJson -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    return $script:CalNyseDatos
}

function Get-AhoraET {
    # 'Eastern Standard Time' es el ID de Windows para la zona completa: incluye
    # el horario de verano. No es un offset fijo.
    return [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'Eastern Standard Time')
}

function Get-FechaET {
    return (Get-AhoraET).ToString('yyyy-MM-dd')
}

function Get-MinutosET {
    $et = Get-AhoraET
    return ($et.Hour * 60 + $et.Minute)
}

function Test-FinDeSemanaNYSE {
    param([string]$Fecha)
    if ([string]::IsNullOrWhiteSpace($Fecha)) { $d = Get-AhoraET } else { $d = [datetime]::ParseExact($Fecha, 'yyyy-MM-dd', $null) }
    return ($d.DayOfWeek -eq [DayOfWeek]::Saturday -or $d.DayOfWeek -eq [DayOfWeek]::Sunday)
}

function Test-FeriadoNYSE {
    param([string]$Fecha)
    if ([string]::IsNullOrWhiteSpace($Fecha)) { $Fecha = Get-FechaET }
    return ((Get-CalendarioNYSE).feriados -contains $Fecha)
}

function Test-MedioDiaNYSE {
    # Cierre a la 1:00pm ET en vez de a las 4:00pm. NO es un dia cerrado.
    param([string]$Fecha)
    if ([string]::IsNullOrWhiteSpace($Fecha)) { $Fecha = Get-FechaET }
    return ((Get-CalendarioNYSE).mediosDias -contains $Fecha)
}

function Get-MotivoCierreNYSE {
    # Devuelve $null si hay mercado. Si no, dice POR QUE, para que el log
    # distinga un domingo de Labor Day en vez de decir "fuera de horario".
    param([string]$Fecha)
    if ([string]::IsNullOrWhiteSpace($Fecha)) { $Fecha = Get-FechaET }
    $cal = Get-CalendarioNYSE
    if ($Fecha -gt $cal.hasta) {
        Write-Warning "[MERCADO] El calendario NYSE llega hasta $($cal.hasta) y hoy es $Fecha : de aqui en adelante NO se detectan feriados. Hay que extender src/calendario_nyse.json."
    }
    if (Test-FinDeSemanaNYSE -Fecha $Fecha) { return "fin de semana ($Fecha)" }
    if (Test-FeriadoNYSE     -Fecha $Fecha) { return "feriado NYSE ($Fecha)" }
    return $null
}

function Test-DiaDeMercadoNYSE {
    # Abre hoy la NYSE? (dia habil y no feriado — no dice nada de la hora)
    param([string]$Fecha)
    return ($null -eq (Get-MotivoCierreNYSE -Fecha $Fecha))
}

function Get-HoraCierreMinNYSE {
    param([string]$Fecha)
    if (Test-MedioDiaNYSE -Fecha $Fecha) { return (13 * 60) }
    return (16 * 60)
}

function Test-HorarioDeMercadoNYSE {
    # La campana: 9:30 ET hasta el cierre (4:00pm, o 1:00pm en medio dia).
    if (-not (Test-DiaDeMercadoNYSE)) { return $false }
    $m = Get-MinutosET
    return (($m -ge (9 * 60 + 30)) -and ($m -lt (Get-HoraCierreMinNYSE)))
}

function Test-VentanaNYSE {
    # Ventana propia en minutos desde la medianoche ET, para los procesos que no
    # van de campana a campana. Exige dia de mercado igual: tener ventana propia
    # no es excusa para correr un feriado.
    param(
        [Parameter(Mandatory=$true)][int]$DesdeMin,
        [Parameter(Mandatory=$true)][int]$HastaMin,
        [switch]$FinExclusivo,
        [switch]$NoRecortarMedioDia
    )
    if (-not (Test-DiaDeMercadoNYSE)) { return $false }
    $fin = $HastaMin
    if ((-not $NoRecortarMedioDia) -and (Test-MedioDiaNYSE)) { $fin = $HastaMin - (3 * 60) }
    $m = Get-MinutosET
    if ($m -lt $DesdeMin) { return $false }
    if ($FinExclusivo) { return ($m -lt $fin) }
    return ($m -le $fin)
}
