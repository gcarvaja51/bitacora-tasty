' Incidente real 2026-07-30: antes este wrapper no capturaba el codigo de
' salida del .ps1, asi que Windows Task Scheduler siempre veia "Last
' Result: 0" (exito) sin importar si la corrida realmente genero el
' documento o se colgo. WScript.Quit(exitCode) propaga el resultado real.
'
' Incidente real 2026-08-03: el .ps1 tenia un error de SINTAXIS (comillas
' escapadas al estilo bash en un -replace, introducido el 1-ago junto con el
' paso del recolector). PowerShell no podia ni parsear el archivo, asi que
' salia con codigo 1 sin ejecutar una sola linea -- ni siquiera la primera
' llamada a Write-Log. Resultado: el disparo automatico llevaba 2 dias
' muerto y la unica senal era la AUSENCIA de entradas en un log que nadie
' abre. Por eso la notificacion de fallo vive ACA y no solo dentro del .ps1:
' este archivo es el unico que sigue corriendo cuando el .ps1 no compila.
'
' Convencion de codigos de salida del .ps1:
'   0 = todo bien (o SKIP normal por horario/feriado -- sin notificacion)
'   2 = fallo, pero el .ps1 YA mando su propio ntfy con el detalle
'   otro = el .ps1 murio sin poder avisar (parse error, crash temprano)
'          -> es este wrapper el que tiene que dar la alarma

Const NTFY_URL = "https://ntfy.sh/bitacora_gcarvaja51"

Set objShell = CreateObject("WScript.Shell")
exitCode = objShell.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\gcarv\.claude\skills\premercado-spx\scripts\launch_premercado_gate.ps1""", 0, True)

If exitCode <> 0 And exitCode <> 2 Then
    SendNtfy "El gate murio con codigo " & exitCode & " sin llegar a ejecutarse (posible error de sintaxis o crash temprano del .ps1). NO se genero el premercado de hoy y el log puede estar vacio.", "Premercado SPX: GATE CAIDO", "urgent"
End If

WScript.Quit(exitCode)

Sub SendNtfy(mensaje, titulo, prioridad)
    On Error Resume Next
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    http.SetTimeouts 5000, 5000, 10000, 15000
    http.Open "POST", NTFY_URL, False
    http.SetRequestHeader "Title", titulo
    http.SetRequestHeader "Priority", prioridad
    http.SetRequestHeader "Tags", "rotating_light"
    http.Send mensaje
    On Error Goto 0
End Sub
