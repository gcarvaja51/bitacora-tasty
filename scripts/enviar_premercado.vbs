' Lanza enviar_premercado.ps1 sin ventana (Tarea Bitacora_EnviarPremercado, lun-vie 09:05, 09:35 y 10:30 ET).
Set objShell = CreateObject("WScript.Shell")
objShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\gcarv\bitacora-tasty\scripts\enviar_premercado.ps1""", 0, True
