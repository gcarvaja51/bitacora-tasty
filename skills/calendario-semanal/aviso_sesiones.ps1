# ============================================================
#  Aviso en el PC de las sesiones de Sigma Club (2026-10-15)
#  Pedido de Guillermo: "me gustaria que me apareciera aqui en el pc una
#  notificacion de las reuniones para no perdermelas". Mismo dia, segunda
#  vuelta: avisar 5 min antes, al inicio y 5 min despues, y meter en la
#  notificacion el link para entrar.
#
#  Las sesiones salen de los _agenda.json que deja agenda.py cada lunes (la
#  misma fuente con la que se carga Google Calendar). El link NO viene en la
#  agenda: Sigma lo manda ~10 min antes al grupo "Notificaciones 5" (cuenta
#  usa) -- "Sigma Club te invita a una reunion en Zoom... Empezamos en 10
#  minutos" con el link de Zoom y el codigo de acceso; el Sigma Live de Luis
#  va por YouTube. Se lee ese grupo por la API local de WhatsApp (GOWA, la
#  misma que usa el gate del premercado para mandar alertas).
#
#  La notificacion es tipo recordatorio (se queda hasta cerrarla) y trae el
#  boton "Entrar" que abre el link. Si el link todavia no llego, avisa igual
#  y dice que el link va al grupo de WhatsApp.
#
#  Lo corre la Tarea "Sigma_Aviso_Sesiones" cada 5 min. Las sesiones caen en
#  multiplos de 5 min, asi que los disparos coinciden con -5, 0 y +5.
#  Estado en avisos_enviados.json y log en aviso_sesiones.log (carpeta de datos).
#  Prueba: powershell -File aviso_sesiones.ps1 -Prueba
# ============================================================
param([switch]$Prueba, [string]$ProbarLink)

$ETAPAS = @(
    @{ id = 'm5'; min = 5;  titulo = { param($t) "Sigma Club en 5 min" } },
    @{ id = 'm0'; min = 0;  titulo = { param($t) "Sigma Club EMPIEZA AHORA" } },
    @{ id = 'p5'; min = -5; titulo = { param($t) "Sigma Club empezo hace 5 min" } }
)
$GRUPO = "120363403656198230@g.us"   # Notificaciones 5 de Opcion Sigma, cuenta usa
$datos = "C:\Users\gcarv\Documents\CARPETA PERSONAL\01. guillermo carvajal\01_Sigma\calendario semanal"
$semanas = Join-Path $datos "semanas"
$estadoF = Join-Path $datos "avisos_enviados.json"
$logF = Join-Path $datos "aviso_sesiones.log"

function Log($m) { Add-Content -Encoding utf8 $logF "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" }

function Show-Toast($titulo, $texto, $url) {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $esc = { param($s) [Security.SecurityElement]::Escape($s) }
    # scenario="reminder": no se va sola a los 5 s, se queda hasta que se cierra.
    # Con link: clic en la notificacion o en "Entrar" abre el Zoom/YouTube.
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
    # AppId de PowerShell: ya esta registrado en Windows, asi que el toast se muestra sin instalar nada.
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show(
        [Windows.UI.Notifications.ToastNotification]::new($doc))
}

# El mismo aviso al celular por ntfy (2026-10-15, "puedes enviarme algo similar a
# mi celular tambien?"). Mismo topic que ya usan el gate del premercado, server.js
# y el gamma_daemon, asi que la app del celular ya esta suscrita. Con link: tocar
# la notificacion o el boton "Entrar" abre el Zoom/YouTube. Best-effort.
$NTFY_TOPIC = "bitacora_gcarvaja51"
function Send-Ntfy($titulo, $texto, $url) {
    $h = @{ Title = $titulo; Priority = 'high'; Tags = 'calendar' }
    if ($url) { $h.Click = $url; $h.Actions = "view, Entrar, $url" }
    try {
        Invoke-RestMethod -Uri "https://ntfy.sh/$NTFY_TOPIC" -Method Post -Headers $h `
            -Body ([Text.Encoding]::UTF8.GetBytes($texto)) -TimeoutSec 15 | Out-Null
    } catch { Log "ntfy fallo: $($_.Exception.Message)" }
}

# Mensajes recientes del grupo de Sigma por la API local de WhatsApp.
function Get-MensajesGrupo {
    $waDir = "C:\Users\gcarv\Documents\CARPETA PERSONAL\whatsapp"
    $cred = Get-Content (Join-Path $waDir "credenciales.txt")
    $usuario  = ($cred | Select-String '^usuario:').ToString().Split(':')[1].Trim()
    $password = ($cred | Select-String '^password:').ToString().Split(':')[1].Trim()
    $cuentas = Get-Content (Join-Path $waDir "cuentas.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $h = @{
        Authorization = "Basic " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${usuario}:${password}"))
        'X-Device-Id' = $cuentas.usa.device_id
    }
    (Invoke-RestMethod "http://127.0.0.1:3001/chat/$GRUPO/messages?limit=30" -Headers $h -TimeoutSec 45).results.data
}

# Busca el link de la sesion que empieza en $inicioUtc: el mensaje con link de
# Zoom o de YouTube en vivo publicado entre 30 min antes y 10 min despues del
# inicio. Si hay varios, gana el que menciona la hora de la sesion (ej. "09:15"
# o "9:15"); si no, el mas reciente. Las grabaciones ("Ya disponible") no cuentan.
function Find-Link($mensajes, $inicioUtc, $horaEt) {
    $h = [datetime]::ParseExact($horaEt, 'HH:mm', $null)
    $horas = @($h.ToString('HH:mm'), $h.ToString('H:mm'), $h.ToString('hh:mm'))
    $cands = @()
    foreach ($m in $mensajes) {
        $t = [string]$m.content
        if (-not $t -or $t -match 'Ya disponible|Grabaci') { continue }
        $url = [regex]::Match($t, 'https?://[^\s]*(zoom\.us/j/|youtube\.com/live/|youtu\.be/)[^\s]*').Value
        if (-not $url) { continue }
        $cuando = ([datetimeoffset]::Parse($m.timestamp)).UtcDateTime
        if ($cuando -lt $inicioUtc.AddMinutes(-30) -or $cuando -gt $inicioUtc.AddMinutes(10)) { continue }
        $codigo = [regex]::Match($t, 'digo de acceso:\s*(\S+)').Groups[1].Value
        $nombra = [bool]($horas | Where-Object { $t.Contains($_) })
        $cands += [pscustomobject]@{ url = $url; codigo = $codigo; nombra = $nombra; cuando = $cuando }
    }
    $cands | Sort-Object @{ e = 'nombra'; Descending = $true }, @{ e = 'cuando'; Descending = $true } | Select-Object -First 1
}

if ($ProbarLink) {
    # -ProbarLink "2026-10-15 09:15": que link encontraria para esa sesion (hora ET).
    $et = [TimeZoneInfo]::FindSystemTimeZoneById('Eastern Standard Time')
    $iniEt = [datetime]::ParseExact($ProbarLink, 'yyyy-MM-dd HH:mm', $null)
    $ini = [TimeZoneInfo]::ConvertTime($iniEt, $et, [TimeZoneInfo]::Utc)
    Find-Link @(Get-MensajesGrupo) $ini $iniEt.ToString('HH:mm') | Format-List
    return
}

if ($Prueba) {
    Show-Toast "Sigma Club en 5 min (prueba)" "9:15 ET (8:15 hora local) - Sesion en Vivo con Facu`nCodigo: 7sha16" "https://zoom.us/test"
    Send-Ntfy "Sigma Club en 5 min (prueba)" "9:15 ET (8:15 hora local) - Sesion en Vivo con Facu`nCodigo: 7sha16" "https://www.youtube.com/@OPCIONSIGMA/live"
    Log "PRUEBA: notificacion enviada"
    return
}

try {
    $et = [TimeZoneInfo]::FindSystemTimeZoneById('Eastern Standard Time')
    $ahora = Get-Date
    $enviados = @{}
    if (Test-Path $estadoF) {
        (Get-Content $estadoF -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $enviados[$_.Name] = $_.Value }
    }

    # Las dos ultimas semanas alcanzan: la del domingo 18:30 (Planeacion semanal)
    # vive en el JSON de la semana que termina.
    $sesiones = foreach ($f in (Get-ChildItem $semanas -Filter '*_agenda.json' | Sort-Object Name -Descending | Select-Object -First 2)) {
        (Get-Content $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json).sesiones
    }

    $mensajes = $null
    foreach ($s in $sesiones) {
        $clave = "$($s.fecha) $($s.hora_et) $($s.titulo)"
        # hora del Este -> hora local de este PC (resuelve el horario de verano de EE.UU.)
        $inicioEt = [datetime]::ParseExact("$($s.fecha) $($s.hora_et)", 'yyyy-MM-dd HH:mm', $null)
        $inicioLocal = [TimeZoneInfo]::ConvertTime($inicioEt, $et, [TimeZoneInfo]::Local)
        $faltan = ($inicioLocal - $ahora).TotalMinutes
        # Etapa que toca: la ultima cuyo momento ya llego, dentro de una ventana de
        # 5 min (asi un PC que despierta tarde no dispara las tres de golpe).
        $etapa = $ETAPAS | Where-Object { $faltan -le $_.min -and $faltan -gt ($_.min - 5) } | Select-Object -Last 1
        if (-not $etapa) { continue }
        $claveEtapa = "$clave|$($etapa.id)"
        if ($enviados.ContainsKey($claveEtapa)) { continue }

        $link = $null
        try {
            if ($null -eq $mensajes) { $mensajes = @(Get-MensajesGrupo) }
            $link = Find-Link $mensajes $inicioLocal.ToUniversalTime() $s.hora_et
        } catch { Log "WhatsApp no respondio: $($_.Exception.Message)" }
        # El Sigma Live de YouTube NO trae link en el grupo (visto el 13 y el 15-oct).
        # /live del canal publico lleva siempre al directo en curso o al proximo.
        if (-not $link -and $s.titulo -match 'YouTube') {
            $link = [pscustomobject]@{ url = 'https://www.youtube.com/@OPCIONSIGMA/live'; codigo = '' }
        }

        $texto = "{0} ET ({1} hora local) - {2}" -f $inicioEt.ToString('H:mm'), $inicioLocal.ToString('H:mm'), $s.titulo
        if ($link) {
            if ($link.codigo) { $texto += "`nCodigo de acceso: $($link.codigo)" }
        } else {
            $texto += "`nEl link todavia no llego: lo mandan al grupo de WhatsApp de Sigma."
        }
        Show-Toast (& $etapa.titulo $s.titulo) $texto $(if ($link) { $link.url } else { $null })
        Send-Ntfy (& $etapa.titulo $s.titulo) $texto $(if ($link) { $link.url } else { $null })
        # Las etapas anteriores que no salieron (PC suspendido) se dan por pasadas.
        foreach ($e in $ETAPAS) { if ($e.min -ge $etapa.min) { $enviados["$clave|$($e.id)"] = $ahora.ToString('s') } }
        Log "AVISO $($etapa.id): $clave (faltaban $([math]::Round($faltan,1)) min) link=$(if ($link) { $link.url } else { 'NO' })"
    }

    # Se guardan solo los avisos de los ultimos 14 dias, para que el archivo no crezca.
    $corte = $ahora.AddDays(-14).ToString('yyyy-MM-dd')
    $limpio = [ordered]@{}
    foreach ($k in ($enviados.Keys | Sort-Object)) { if ($k.Substring(0, 10) -ge $corte) { $limpio[$k] = $enviados[$k] } }
    $limpio | ConvertTo-Json | Set-Content -Encoding UTF8 $estadoF
} catch {
    Log "ERROR: $($_.Exception.Message)"
}
