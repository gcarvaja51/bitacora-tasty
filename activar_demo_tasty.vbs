' Lanza activar_demo_tasty.ps1 sin ventana. Argumento: activar | revisar
Dim modo
modo = "revisar"
If WScript.Arguments.Count > 0 Then modo = WScript.Arguments(0)
Set objShell = CreateObject("WScript.Shell")
objShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\gcarv\bitacora-tasty\activar_demo_tasty.ps1"" -Modo " & modo, 0, True
