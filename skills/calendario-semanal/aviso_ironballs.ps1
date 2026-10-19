# ============================================================
#  Aviso en el PC y en el celular de las sesiones de Iron Balls (2026-10-15)
#  Pedido de Guillermo: lo mismo que Sigma (aviso 5 min antes, al inicio y
#  5 min despues, con el link para entrar) para el canal de WhatsApp
#  "Canal Oficial - Iron Balls" (cuenta usa), y al calendario en AZUL.
#
#  Iron Balls NO publica agenda semanal como Sigma. Anuncia suelto, por ej.:
#    - imagen con texto "HOY 12:30 NEW YORK"
#    - "Nos vemos para operar en vivo el Jueves via Zoom y YouTube. 12:30 New York."
#    - Emerson: "hoy compartiremos la sesion ... link en aproximadamente 10 minutos"
#  y pega el link de Zoom 4-20 min antes. Por eso este script, cada 2 min:
#    1. Lee los ultimos mensajes del canal (API local de WhatsApp, GOWA).
#    2. Saca las sesiones anunciadas con hora ("12:30 New York" + hoy/manana/dia
#       de la semana) y las guarda en ironballs\sesiones.json.
#    3. Avisa -5 / 0 / +5 de cada sesion, con el link si ya llego.
#    4. Si aparece un link de Zoom NUEVO (aunque no hubiera anuncio con hora,
#       caso Emerson), avisa en el acto: "link publicado, entra".
#    5. Si hay sesiones nuevas sin pasar a Google Calendar, lanza
#       ironballs_calendario.cmd (claude -p) que las crea en azul.
#
#  Tarea "IronBalls_Aviso_Sesiones" cada 2 min, oculta (oculto.vbs).
#  Datos: 01_Sigma\calendario semanal\ironballs\ (sesiones.json, avisos.json,
#  en_calendario.json, aviso.log).
#  Pruebas: -Prueba (notificacion de muestra)  |  -Seco (lee y muestra lo que
#  detecta, sin avisar ni guardar)
# ============================================================
param([switch]$Prueba, [switch]$Seco)

$GRUPO = "120363233546136336@g.us"   # Canal Oficial - Iron Balls, cuenta usa
$datos = "C:\Users\gcarv\Documents\CARPETA PERSONAL\01. guillermo carvajal\01_Sigma\calendario semanal\ironballs"
if (-not (Test-Path $datos)) { New-Item -ItemType Directory -Force $datos | Out-Null }
$sesionesF = Join-Path $datos "sesiones.json"
$avisosF = Join-Path $datos "avisos.json"
$calF = Join-Path $datos "en_calendario.json"
$calIntentoF = Join-Path $datos "calendario_intento.txt"
$logF = Join-Path $datos "aviso.log"
$CAL_CMD = Join-Path $PSScriptRoot "ironballs_calendario.cmd"

$ETAPAS = @(
    @{ id = 'm5'; min = 5;  titulo = "Iron Balls en 5 min" },
    @{ id = 'm0'; min = 0;  titulo = "Iron Balls EMPIEZA AHORA" },
    @{ id = 'p5'; min = -5; titulo = "Iron Balls empezo hace 5 min" }
)

function Log($m) { Add-Content -Encoding utf8 $logF "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" }

function Show-Toast($titulo, $texto, $url) {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $esc = { param($s) [Security.SecurityElement]::Escape($s) }
    $launch = ''; $boton = ''
    if ($url) {
        $u = & $esc $url
        $launch = " launch=`"$u`" activationType=`"protocol`""
        $boton = "<action content=`"Entrar`" arguments=`"$u`" activationType=`"protocol`"/>"
    }
    $xml = @"
<toast scenario="reminder"$launch>
  <visual><binding template="ToastGeneric">
    <text>$(& $esc $titulo)</text>
    <text>$(& $esc $texto)</text>
  </binding></visual>
  <actions>$boton<action content="Cerrar" arguments="dismiss" activationType="system"/></actions>
  <audio src="ms-winsoundevent:Notification.Reminder"/>
</toast>
"@
    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($xml)
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show(
        [Windows.UI.Notifications.ToastNotification]::new($doc))
}

# Mismo topic de ntfy que Sigma y el gate del premercado: la app del celular ya esta suscrita.
$NTFY_TOPIC = "bitacora_gcarvaja51"
function Send-Ntfy($titulo, $texto, $url) {
    $h = @{ Title = $titulo; Priority = 'high'; Tags = 'large_blue_circle' }
    if ($url) { $h.Click = $url; $h.Actions = "view, Entrar, $url" }
    try {
        Invoke-RestMethod -Uri "https://ntfy.sh/$NTFY_TOPIC" -Method Post -Headers $h `
            -Body ([Text.Encoding]::UTF8.GetBytes($texto)) -TimeoutSec 15 | Out-Null
    } catch { Log "ntfy fallo: $($_.Exception.Message)" }
}

# $link = objeto de Get-Url (o $null). En el PC se abre con zoommtg:// (directo a la app de
# Zoom, sin pasar por el navegador ni pedir clave); en el celular con el https completo, que
# trae la clave en ?pwd= y el iPhone abre en la app de Zoom.
function Avisar($titulo, $texto, $link) {
    $pc = $(if ($link) { $link.pc } else { $null }); $cel = $(if ($link) { $link.url } else { $null })
    if ($Seco) { Write-Output "AVISARIA: $titulo | $texto | PC=$pc | CEL=$cel"; return }
    Show-Toast $titulo $texto $pc
    Send-Ntfy $titulo $texto $cel
}

# Link de Zoom para la app de escritorio: zoommtg://zoom.us/join?action=join&confno=<id>&pwd=<clave>.
# La clave sale del ?pwd= del link (cifrada, la que trae el link de Pipe/Emerson); si el link no
# la trae, se usa el codigo de acceso del mensaje.
function Get-ZoomPc($url, $codigo) {
    $id = [regex]::Match($url, 'zoom\.us/j/(\d+)').Groups[1].Value
    if (-not $id) { return $url }
    $pwd = [regex]::Match($url, '[?&]pwd=([^&\s]+)').Groups[1].Value
    if (-not $pwd) { $pwd = $codigo }
    "zoommtg://zoom.us/join?action=join&confno=$id" + $(if ($pwd) { "&pwd=$pwd" } else { "" })
}

function Get-Mensajes {
    $waDir = "C:\Users\gcarv\Documents\CARPETA PERSONAL\whatsapp"
    $cred = Get-Content (Join-Path $waDir "credenciales.txt")
    $usuario  = ($cred | Select-String '^usuario:').ToString().Split(':')[1].Trim()
    $password = ($cred | Select-String '^password:').ToString().Split(':')[1].Trim()
    $cuentas = Get-Content (Join-Path $waDir "cuentas.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $h = @{
        Authorization = "Basic " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${usuario}:${password}"))
        'X-Device-Id' = $cuentas.usa.device_id
    }
    $n = $(if ($Seco) { 100 } else { 30 })
    # Normalmente responde en 0.2 s; el 15-oct hubo dos baches de >60 s. Dos intentos de 25 s.
    try { (Invoke-RestMethod "http://127.0.0.1:3001/chat/$GRUPO/messages?limit=$n" -Headers $h -TimeoutSec 25).results.data }
    catch {
        Log "WhatsApp lento ($($_.Exception.Message)); reintento"
        (Invoke-RestMethod "http://127.0.0.1:3001/chat/$GRUPO/messages?limit=$n" -Headers $h -TimeoutSec 25).results.data
    }
}

function Leer-Json($f) {
    $d = @{}
    if (Test-Path $f) {
        $o = Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($o) { $o.PSObject.Properties | ForEach-Object { $d[$_.Name] = $_.Value } }
    }
    $d
}

$et = [TimeZoneInfo]::FindSystemTimeZoneById('Eastern Standard Time')
$DIAS = @{ 'lunes' = 1; 'martes' = 2; 'miercoles' = 3; 'jueves' = 4; 'viernes' = 5; 'sabado' = 6; 'domingo' = 0 }

function Sin-Tildes($s) {
    $n = $s.Normalize([Text.NormalizationForm]::FormD)
    -join ($n.ToCharArray() | Where-Object { [Globalization.CharUnicodeInfo]::GetUnicodeCategory($_) -ne 'NonSpacingMark' })
}

# Una sesion anunciada: hora + "New York/NY" en el texto, y el dia por "hoy", "manana"
# o el nombre del dia (el proximo a partir de la fecha del mensaje, hora NY).
function Get-Anuncio($m) {
    $t = Sin-Tildes ([string]$m.content).ToLower()
    $rx = [regex]::Match($t, '(\d{1,2}):(\d{2})\s*(a\.?\s?m\.?|p\.?\s?m\.?)?\s*[^\w]{0,4}\s*(hora\s+(de\s+)?)?(new york|nueva york|ny\b|n\.y\.|et\b)')
    if (-not $rx.Success) { return $null }
    $hh = [int]$rx.Groups[1].Value; $mm = [int]$rx.Groups[2].Value
    $ampm = $rx.Groups[3].Value
    if ($ampm -match '^p' -and $hh -lt 12) { $hh += 12 }
    elseif (-not $ampm -and $hh -ge 1 -and $hh -le 6) { $hh += 12 }   # "1:30" sin am/pm en mercado = tarde
    if ($hh -gt 23 -or $mm -gt 59) { return $null }
    $msgEt = [TimeZoneInfo]::ConvertTime(([datetimeoffset]::Parse($m.timestamp)).UtcDateTime, [TimeZoneInfo]::Utc, $et)
    # El nombre del dia manda sobre "manana": "Manana no estare... nos vemos el Jueves 12:30 New York" (12-oct).
    $fecha = $null; $porDia = $false
    foreach ($d in $DIAS.Keys) {
        if ($t -match "\b$d\b") {
            $delta = ($DIAS[$d] - [int]$msgEt.DayOfWeek + 7) % 7
            $fecha = $msgEt.Date.AddDays($delta); $porDia = $true
            break
        }
    }
    if (-not $fecha) {
        if ($t -match '\bmanana\b' -and $t -notmatch 'de la manana') { $fecha = $msgEt.Date.AddDays(1) }
        elseif ($t -match '\bhoy\b') { $fecha = $msgEt.Date }
    }
    if (-not $fecha) { $fecha = $msgEt.Date }      # sin dia: se asume el mismo dia del mensaje
    $inicioEt = $fecha.AddHours($hh).AddMinutes($mm)
    if ($inicioEt -lt $msgEt.AddMinutes(-5)) {
        if (-not $porDia) { return $null }
        $inicioEt = $inicioEt.AddDays(7)            # "el jueves" dicho un jueves despues de la hora
        if ($inicioEt -gt $msgEt.AddDays(8)) { return $null }
    }
    $plat = @(); if ($t -match 'zoom') { $plat += 'Zoom' }; if ($t -match 'youtube') { $plat += 'YouTube' }
    $titulo = "Iron Balls – Sesión en vivo" + $(if ($plat) { " (" + ($plat -join ' y ') + ")" } else { "" })
    [pscustomobject]@{
        clave = $inicioEt.ToString('yyyy-MM-dd HH:mm'); fecha = $inicioEt.ToString('yyyy-MM-dd')
        hora_et = $inicioEt.ToString('HH:mm'); titulo = $titulo; quien = [string]$m.sender_display_name
        texto = ([string]$m.content).Substring(0, [math]::Min(200, ([string]$m.content).Length)); msg_id = $m.id
    }
}

function Get-Url($m) {
    $t = [string]$m.content
    if ($t -match 'Ya disponible|Grabaci') { return $null }
    $url = [regex]::Match($t, 'https?://[^\s]*(zoom\.us/j/|youtube\.com/live/)[^\s]*').Value
    if (-not $url) { return $null }
    $codigo = [regex]::Match($t, '(digo de acceso|Passcode):\s*(\S+)').Groups[2].Value
    $zoom = $url -match 'zoom\.us'
    [pscustomobject]@{
        url = $url; zoom = $zoom; codigo = $codigo
        pc = $(if ($zoom) { Get-ZoomPc $url $codigo } else { $url })
        cuando = ([datetimeoffset]::Parse($m.timestamp)).UtcDateTime; id = $m.id
    }
}

if ($Prueba) {
    # Prueba con un link real ya vencido: debe abrir la app de Zoom sin pedir clave (dira que la reunion termino).
    $u = "https://us06web.zoom.us/j/86136507629?pwd=1siPScQkOc7rHnXbuzHwS2aqh87wDW.1"
    Avisar "Iron Balls en 5 min (prueba)" "12:30 ET (11:30 hora local) - Sesion en vivo con Pipe`nToca Entrar: abre Zoom directo, sin clave." ([pscustomobject]@{ url = $u; pc = (Get-ZoomPc $u "389787") })
    Log "PRUEBA: notificacion enviada"
    return
}

try {
    $ahora = Get-Date
    $ahoraUtc = $ahora.ToUniversalTime()
    $mensajes = @(Get-Mensajes)
    $sesiones = Leer-Json $sesionesF
    $avisos = Leer-Json $avisosF
    $nuevas = 0

    # 1) sesiones anunciadas (solo las que aun no pasaron)
    foreach ($m in $mensajes) {
        $a = Get-Anuncio $m
        if (-not $a) { continue }
        $iniUtc = [TimeZoneInfo]::ConvertTime([datetime]::ParseExact($a.clave, 'yyyy-MM-dd HH:mm', $null), $et, [TimeZoneInfo]::Utc)
        if ($Seco) { Write-Output "ANUNCIO: $($a.clave) ET  $($a.titulo)  <- $($a.texto -replace '\s+', ' ')" }
        if ($iniUtc -lt $ahoraUtc.AddHours(-2)) { continue }
        if (-not $sesiones.ContainsKey($a.clave)) {
            $sesiones[$a.clave] = $a; $nuevas++
            Log "SESION NUEVA: $($a.clave) ET $($a.titulo) (de: $($a.texto -replace '\s+', ' '))"
        }
    }

    # links del canal: Zoom o YouTube en vivo
    $links = @($mensajes | ForEach-Object { Get-Url $_ } | Where-Object { $_ })

    # 2) avisos -5 / 0 / +5 de cada sesion
    $linksAvisados = @{}
    foreach ($k in @($sesiones.Keys)) {
        $s = $sesiones[$k]
        $inicioEt = [datetime]::ParseExact($s.clave, 'yyyy-MM-dd HH:mm', $null)
        $inicioLocal = [TimeZoneInfo]::ConvertTime($inicioEt, $et, [TimeZoneInfo]::Local)
        $iniUtc = $inicioLocal.ToUniversalTime()
        $faltan = ($inicioLocal - $ahora).TotalMinutes
        $etapa = $ETAPAS | Where-Object { $faltan -le $_.min -and $faltan -gt ($_.min - 5) } | Select-Object -Last 1
        if (-not $etapa) { continue }
        $ce = "$k|$($etapa.id)"
        if ($avisos.ContainsKey($ce)) { continue }
        $link = $links | Where-Object { $_.cuando -ge $iniUtc.AddMinutes(-40) -and $_.cuando -le $iniUtc.AddMinutes(15) } |
            Sort-Object @{ e = 'zoom'; Descending = $true }, @{ e = 'cuando'; Descending = $true } | Select-Object -First 1
        $texto = "{0} ET ({1} hora local) - {2}" -f $inicioEt.ToString('H:mm'), $inicioLocal.ToString('H:mm'), ($s.titulo -replace '^Iron Balls – ', '')
        if ($link) { if ($link.codigo) { $texto += "`nCodigo de acceso: $($link.codigo)" }; $linksAvisados[$link.id] = 1 }
        else { $texto += "`nEl link todavia no llego: lo pegan en el canal de WhatsApp de Iron Balls." }
        Avisar $etapa.titulo $texto $link
        foreach ($e in $ETAPAS) { if ($e.min -ge $etapa.min) { $avisos["$k|$($e.id)"] = $ahora.ToString('s') } }
        Log "AVISO $($etapa.id): $k ET (faltaban $([math]::Round($faltan,1)) min) link=$(if ($link) { $link.url } else { 'NO' })"
    }

    # 3) link de Zoom nuevo, publicado hace <= 15 min: aviso inmediato aunque no hubiera
    #    anuncio con hora (Emerson, 12-oct: "link en 10 minutos" y luego solo el Zoom).
    foreach ($l in ($links | Where-Object { $_.zoom -and $_.cuando -ge $ahoraUtc.AddMinutes(-15) })) {
        $cl = "link|$($l.id)"
        if ($avisos.ContainsKey($cl)) { continue }
        $avisos[$cl] = $ahora.ToString('s')
        if ($linksAvisados.ContainsKey($l.id)) { continue }      # ya salio con el aviso de la sesion
        $hl = [TimeZoneInfo]::ConvertTime($l.cuando, [TimeZoneInfo]::Utc, [TimeZoneInfo]::Local)
        $texto = "Pegaron el link de Zoom en el canal ($($hl.ToString('H:mm')) hora local). Entra ya."
        if ($l.codigo) { $texto += "`nCodigo de acceso: $($l.codigo)" }
        Avisar "Iron Balls: link de Zoom publicado" $texto $l
        Log "AVISO link: $($l.url)"
    }

    if ($Seco) { Write-Output "Sesiones vigentes: $(@($sesiones.Keys) -join ', ')"; return }

    # limpieza: sesiones y avisos de los ultimos 14 dias
    $corte = $ahora.AddDays(-14).ToString('yyyy-MM-dd')
    $s2 = [ordered]@{}; foreach ($k in ($sesiones.Keys | Sort-Object)) { if ($k -ge $corte) { $s2[$k] = $sesiones[$k] } }
    $s2 | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $sesionesF
    $a2 = [ordered]@{}; foreach ($k in ($avisos.Keys | Sort-Object)) { if ($avisos[$k].Substring(0, 10) -ge $corte) { $a2[$k] = $avisos[$k] } }
    $a2 | ConvertTo-Json | Set-Content -Encoding UTF8 $avisosF

    # 4) Google Calendar (azul): lo hace claude -p. Solo si hay sesiones futuras que no
    #    estan en en_calendario.json, y como mucho un intento cada 30 min.
    $hechas = @(); if (Test-Path $calF) { $hechas = @(Get-Content $calF -Raw -Encoding UTF8 | ConvertFrom-Json) }
    $pend = @($s2.Keys | Where-Object {
        $_ -notin $hechas -and [TimeZoneInfo]::ConvertTime([datetime]::ParseExact($_, 'yyyy-MM-dd HH:mm', $null), $et, [TimeZoneInfo]::Local) -gt $ahora })
    if ($pend) {
        $ult = $(if (Test-Path $calIntentoF) { [datetime](Get-Content $calIntentoF) } else { [datetime]::MinValue })
        if (($ahora - $ult).TotalMinutes -ge 30) {
            $ahora.ToString('s') | Set-Content $calIntentoF
            Start-Process -WindowStyle Hidden -FilePath $env:ComSpec -ArgumentList "/c `"$CAL_CMD`""
            Log "CALENDARIO: lanzado claude -p para $($pend -join ', ')"
        }
    }
} catch {
    Log "ERROR: $($_.Exception.Message)"
    if ($Seco) { throw }
}
