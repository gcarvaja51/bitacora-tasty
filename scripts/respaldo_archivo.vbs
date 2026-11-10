' Lanza respaldo_archivo.ps1 sin ventana (Tarea Bitacora_RespaldoArchivo, lun-vie 17:30).
Set objShell = CreateObject("WScript.Shell")
objShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\gcarv\bitacora-tasty\scripts\respaldo_archivo.ps1""", 0, True
