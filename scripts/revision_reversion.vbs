' Wrapper silencioso. El 0 del segundo argumento de Run() evita el parpadeo de
' consola; True espera y WScript.Quit propaga el codigo real.
'
' Se llama a python DIRECTO, sin cmd /c ni redirecciones: la primera version
' usaba `cmd /c chcp 65001 && python ... >> log 2>&1` y se colgaba sin escribir
' una sola linea, por las comillas anidadas. Ahora el propio script escribe su
' log (ver emitir()) y la codificacion va por PYTHONIOENCODING.
Set sh = CreateObject("WScript.Shell")
sh.Environment("PROCESS")("PYTHONIOENCODING") = "utf-8"
sh.CurrentDirectory = "C:\Users\gcarv\bitacora-tasty"
WScript.Quit(sh.Run("python scripts\revision_reversion.py", 0, True))
