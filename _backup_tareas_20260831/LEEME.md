# Foto de las Tareas Programadas — 2026-08-31

Sucede a `_backup_tareas_20260827/`. Se toma porque ese mismo día se cambiaron
definiciones de tareas, y **el cambio no vive en ningún fichero del repo: vive en el
Programador de Windows**. Sin esta foto, un commit no lo preserva.

## Qué se cambió y por qué

Guillermo reportó que se le abre una consola de `cmd` o `powershell` cada pocos
minutos, robando el foco mientras opera.

El repo **ya tenía la solución escrita**: `scripts/oculto.vbs`, del 2026-08-24, creado
por este mismo motivo — *"el Programador de Windows le da consola propia a cada uno...
una ventana que roba el foco ~13 veces al día, justo mientras se opera"*. Pero el
arreglo quedó a medias: de las 28 tareas, 18 seguían la convención y 10 no.

Tres se corrigieron y quedaron verificadas:

| Tarea | Antes | Ahora |
|---|---|---|
| `Bitacora_Estrategia_Premercado` | `powershell.exe` directo — consola visible, 09:30 y 10:30 | `wscript` + `run_estrategia_premercado.vbs` |
| `Bitacora_GEX_Perfil` | `powershell.exe` directo — consola visible, 08:00 y 09:00 | `wscript` + `run_gex_perfil.vbs` |
| `SigmaMaxPainVerifica` | `powershell.exe` directo — consola visible, 12:30 | `wscript` + `verificar_captura.vbs` |

Y se añadió `Bitacora_LogVentanas` (07:15, L-V, 5 h): registra qué proceso con consola
nace y quién lo lanza, en `scripts/ventanas_espias.log`, con un resumen final ordenado
por frecuencia. Existe porque **la causa de la cadencia de 2-3 minutos NO está probada**:
dos vigilancias manuales dieron resultados contradictorios, y adivinar ya falló una vez
esa noche (se acusó al host nativo de Adobe Acrobat y no se sostuvo).

## Lo que quedó pendiente

**`GammaDaemon` sigue sin arreglar.** Es la peor de todas: no parpadea, deja una consola
**permanente** abierta, y si se cierra sin querer, el daemon muere. `Set-ScheduledTask`
devolvió `Access is denied` — esa tarea exige elevación. Desde un PowerShell **como
administrador**, con el mercado cerrado:

```powershell
$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"C:\Users\gcarv\bitacora-tasty\scripts\oculto.vbs" "C:\Users\gcarv\bitacora-tasty\gamma_daemon\start.bat"'
Set-ScheduledTask -TaskName 'GammaDaemon' -Action $a
```

El watchdog lo relanza solo si lo ve muerto, así que no hace falta arrancarlo a mano.

## Dos cosas que conviene no olvidar

**`-WindowStyle Hidden` NO basta.** PowerShell crea la consola y *luego* la esconde: el
parpadeo ocurre igual. Cuatro tareas lo usan y siguen parpadeando
(`Bitacora_RutinaInicio`, `SigmaMaxPainMediodia`, `SigmaMaxPainSnapshot`,
`Vigilancia radicado Liteyca`). El wrapper `.vbs` con `Run(..., 0, True)` es el único
que la evita del todo. No se tocaron porque son poco frecuentes, pero si molestan, el
arreglo es el mismo.

**`pythonw.exe` sí está bien** (`Mananero_*`): es el intérprete sin consola. No tocar.

## Restaurar una tarea desde su XML

```powershell
schtasks /Create /TN "NombreTarea" /XML "C:\Users\gcarv\bitacora-tasty\_backup_tareas_20260831\NombreTarea.xml" /F
```

Ojo: casi todas necesitan `LogonType: Interactive` — sesión de Windows iniciada y
desbloqueada. Varias controlan TradingView o un navegador y no funcionan en Session 0.
