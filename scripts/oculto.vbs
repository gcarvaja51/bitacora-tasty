' Lanza cualquier comando SIN ventana visible (2026-08-24).
'
' Por que existe: varias Tareas Programadas ejecutaban su .cmd directamente, y
' el Programador de Windows le da consola propia a cada uno. Con la Torre de
' Control corriendo cada 30 minutos en horario de mercado, eso es una ventana
' que roba el foco ~13 veces al dia, justo mientras se opera.
'
' Es el mismo truco que el repo ya usa en run_informe_trade.vbs, watchdog.vbs y
' reactivar_auto_execute.vbs — el 0 del segundo parametro es "ventana oculta" y
' el True es "esperar a que termine", asi el Programador ve el codigo de salida
' real y no un 0 prematuro. Esto solo lo generaliza para no escribir un .vbs por
' tarea.
'
' Uso desde el Programador de tareas:
'   Programa:   wscript.exe
'   Argumentos: "C:\Users\gcarv\bitacora-tasty\scripts\oculto.vbs" "C:\ruta\script.cmd" [arg1] [arg2]
'
' OJO: sigue necesitando sesion de usuario activa. No convierte la tarea en
' "ejecutar aunque el usuario no inicie sesion" — varias de estas necesitan el
' escritorio interactivo (el navegador de la captura, la ventana de TradingView).
' Solo esconde la consola.

Set sh = CreateObject("WScript.Shell")

If WScript.Arguments.Count = 0 Then
  WScript.Quit 1
End If

linea = ""
For i = 0 To WScript.Arguments.Count - 1
  linea = linea & """" & WScript.Arguments(i) & """"
  If i < WScript.Arguments.Count - 1 Then linea = linea & " "
Next

' 0 = ventana oculta, True = esperar y devolver el codigo de salida
WScript.Quit sh.Run(linea, 0, True)
