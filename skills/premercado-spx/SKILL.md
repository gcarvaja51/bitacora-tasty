---
name: premercado-spx
description: Genera el análisis diario de premercado del SPX siguiendo la metodología de Alejandro (mentor de trading del usuario) - Macro a Micro, cerrando en 3 escenarios (alcista/neutral/bajista). Se activa con /premercado-spx o cuando el usuario pide "el premercado de hoy", "análisis premercado SPX", o similar. También cubre el POSTMERCADO (Paso 8) — se activa con "el postmercado de hoy", "qué hizo el mercado", "revisa si acertamos el premercado", o similar, después del cierre de mercado.
---

# Análisis de Premercado SPX (metodología de Alejandro)

Reproduce, para el día que se solicite (por defecto: hoy), el mismo tipo de análisis
que Alejandro hace cada mañana en sus audios de premercado sobre el S&P 500 (SPX).
El objetivo final SIEMPRE es llegar a **3 escenarios concretos y accionables**
(alcista, neutral, bajista) con niveles de precio, no una predicción única.

Fuente original de la metodología: notebook de NotebookLM **"PREMERCADOS CON
ALEJANDRO"** (id `d2d7c561-0988-419d-bf04-174e1b38cf4e`). Si en algún momento hay
dudas sobre un matiz de la metodología, se puede volver a consultar ese notebook
con `mcp__notebooklm-mcp__notebook_query`.

## Filosofía (no perder de vista)

Proceso **"Macro a Micro"**: se combinan análisis técnico tradicional + posicionamiento
de derivados (Greeks/Gamma). No es predicción, es **"Arquitectura de Decisión
Táctica"**: se plantean 3 hipótesis y se deja que la acción de precio confirme cuál
se activa. El trader NO opera de entrada — observa los primeros 15-30 minutos para
ver cuál escenario valida, y solo entonces ejecuta con niveles y stop ya definidos
de antemano. Si ningún escenario se valida (mercado errático/plano), la decisión
correcta es **quedarse quieto** ("el mejor crédito").

## Disparo automático (fijado 2026-07-29)

A pedido explícito del usuario: el premercado ya no depende solo de que alguien lo
pida a mano. Se dispara **automáticamente 1 hora antes de la apertura de NYSE**
(lunes a viernes, sin feriados NYSE) **y/o cuando el usuario lo solicite** en
cualquier momento (el flujo manual sigue funcionando exactamente igual, sin
cambios). El requisito explícito del usuario para el disparo automático es que
**todo el proceso corra sin ninguna intervención humana** — sin preguntas, sin
esperar aprobaciones, de punta a punta.

### Por qué NO es un agente cloud (`/schedule`, `RemoteTrigger`)

Se evaluó y se descartó: los agentes cloud corren en la infraestructura de
Anthropic, sin acceso a la máquina del usuario. Este skill depende 100% de
recursos **locales**: TradingView Desktop (vía CDP en `localhost`), la sesión de
Chrome ya logueada del usuario (Sigma Terminal), y carpetas locales de
`Documents`. Un agente cloud no puede tocar nada de eso — no es una opción,
punto, no reevaluar esto sin que cambien esas dependencias.

### Mecanismo elegido: Tarea Programada de Windows + gate de horario/feriados

**Por qué no alcanza con `CronCreate`** (el cron nativo de Claude Code): los jobs
de `CronCreate` viven solo en la sesión activa de Claude Code (nada se escribe a
disco), requieren dejar la terminal abierta e inactiva a la hora del disparo, y
se auto-borran a los 7 días. Sirve como *respaldo de validación* (ver más abajo),
no como mecanismo principal — no sobrevive un reinicio de la PC ni de la sesión.

**Mecanismo principal**: una Tarea Programada de **Windows Task Scheduler**
(nombre: `Bitacora_Premercado_SPX_Auto`) que sí sobrevive reinicios y no depende
de tener una sesión de Claude Code abierta. Lanza `claude.cmd` en modo headless
(`-p`) con el skill.

⚠️ **Requisito no negociable de esta Tarea**: como el skill necesita controlar
una app gráfica (TradingView Desktop) y un navegador (Chrome, vía la extensión
`claude-in-chrome`), la Tarea Programada **tiene que correr con la sesión de
Windows del usuario ya iniciada y desbloqueada** (`LogonType: Interactive`) — NO
sirve "ejecutar la tarea esté el usuario conectado o no" (esa modalidad corre en
una sesión sin escritorio interactivo, Session 0, y ni TradingView ni Chrome
serían alcanzables). Si la PC está apagada, en suspensión, o el usuario
deslogueado a esa hora, la Tarea simplemente no dispara nada ese día — es una
limitación real, no un bug, y hay que comunicársela al usuario si pregunta por
qué faltó un día.

**El problema de la hora exacta (DST)**: "1 hora antes de la apertura" son las
8:30am **ET**, pero la máquina corre en hora de Colombia (que no tiene horario de
verano, a diferencia de EE.UU.). La relación Colombia↔ET cambia 2 veces al año:
- **EDT** (horario de verano en EE.UU., aprox. marzo-noviembre): ET = Colombia + 1h
  → 8:30am ET = **7:30am hora Colombia**.
- **EST** (horario estándar, aprox. noviembre-marzo): ET = Colombia + 0h
  → 8:30am ET = **8:30am hora Colombia**.

Solución: la Tarea tiene **2 triggers semanales fijos** (Lun-Vie), uno a las
7:30am y otro a las 8:30am hora Colombia — cubren ambas temporadas sin tener que
editar la Tarea 2 veces al año. El trigger de la temporada "equivocada" también
dispara, pero el script de gate (ver abajo) calcula la hora ET real en vivo
(`[System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId`, que sí resuelve DST
automáticamente) y descarta el disparo si no cae dentro de la ventana real
8:15-8:45am ET — así que de los 2 disparos diarios, exactamente uno hace algo y
el otro se auto-descarta en silencio, sea cual sea la temporada.

**Script de gate**: `scripts/launch_premercado_gate.ps1` (dentro de este skill).
Antes de lanzar nada, valida en este orden:
1. Ventana horaria real en ET (8:15-8:45am) — descarta el trigger de la
   temporada equivocada.
2. Día hábil (defensa en profundidad — la Tarea ya filtra Lun-Vie, pero se
   revalida por si se edita a mano).
3. **Feriados NYSE** — lista fija de fechas 2026 embebida en el script (Año
   Nuevo, MLK, Presidents Day, Good Friday, Memorial Day, Juneteenth,
   Independence Day observado, Labor Day, Thanksgiving, Christmas — confirmado
   cruzando el feriado del 3-jul-2026 contra la fila ya existente en
   `control_premercado.xlsx`, que decía "Festivo" ese día). **Hay que
   actualizar esta lista cada enero para el año siguiente** — no se calcula
   dinámicamente, es una lista fija a mano dentro del `.ps1`.
4. Si todo pasa: lanza `claude.cmd -p "/premercado-spx" --permission-mode
   bypassPermissions --chrome` desde `C:\Users\gcarv\bitacora-tasty`, y deja el
   log en `premercados alejandro\control premercado\
   premercado_auto_launch.log` (una línea por corrida: lanzado o por qué se
   saltó) + la salida completa de `claude` en
   `premercado_auto_launch_ultima_salida.txt` (se sobreescribe cada corrida,
   sirve para depurar el último run sin tener que buscar en logs viejos).

🚨 **Incidente real y arreglo de plumbing (2026-07-30) — la corrida
automática del 30-jul se "lanzó" y "terminó" según el log, pero NO generó
ningún documento, y `premercado_auto_launch_ultima_salida.txt` quedó
vacío.** Diagnóstico reconstruido leyendo el historial de la sesión
headless real (no especulación): el mismo bug de puerto CDP ya documentado
el 2026-07-20 volvió a ocurrir (había procesos `node.exe` viejos del MCP
server de `tradingview-mcp` sin morir de sesiones anteriores, que seguían
sirviendo con el `CDP_PORT` equivocado en memoria), la sesión gastó ~19 min
peleando con eso, y después **se quedó colgada 26 minutos sin actividad**
hasta que `claude.cmd` finalmente murió — sin que el log lo reflejara como
falla (la Tarea de Windows siempre veía "Last Result: 0" porque el
`.vbs` nunca propagaba el código de salida real).

Arreglado en esta fecha, en 4 capas (código real, no solo documentación del
síntoma):
1. **Bug de código en `tradingview-mcp`**: `src/core/tab.js` tenía
   `CDP_PORT` hardcodeado en `9222` mientras `src/connection.js` sí leía
   `process.env.CDP_PORT` — dos módulos del mismo server podían apuntar a
   puertos distintos según qué función se llamara. Ahora `tab.js` importa
   el mismo `CDP_PORT` exportado desde `connection.js`. También
   `core/health.js` (`launch()`) usaba `port || 9222` en vez de respetar el
   env var, y el buscador de rutas en Windows nunca incluía la ruta MSIX/Store
   (por eso `tv_launch` SIEMPRE fallaba en esta máquina con "TradingView not
   found on win32" — confirmado en la sesión real del 30-jul — y había que
   recurrir al workaround manual de `Get-AppxPackage` cada vez); ahora
   `launch()` prueba `Get-AppxPackage -Name "*TradingView*"` como fallback
   antes de rendirse.
2. **`launch_premercado_gate.ps1`** ahora mata cualquier `node.exe` viejo de
   `tradingview-mcp/src/server.js` ANTES de lanzar `claude.cmd`, para
   garantizar un server fresco que sí lea el `CDP_PORT` actual.
3. **Captura de salida rota**: `& claude.cmd ... 2>&1 | Out-File` bajo la
   cadena oculta (Tarea → `wscript` → `powershell -NoProfile`) perdía TODA
   la salida. Reemplazado por `Start-Process` con
   `-RedirectStandardOutput`/`-RedirectStandardError` a archivo directo, que
   no depende de que la tubería de PowerShell tenga una consola detrás.
4. **Sin techo de tiempo ni verificación de resultado**: se agregó un
   timeout duro de 30 min (si `claude.cmd` no termina en ese lapso, se lo
   mata y se loguea FALLO en vez de dejarlo consumir la ventana previa a la
   apertura en silencio) y, al terminar, el script **verifica que el .docx
   del día realmente exista** antes de loguear ÉXITO — ya no basta con que
   el proceso haya retornado.
5. **`launch_premercado_gate.vbs`** ahora propaga el código de salida real
   del `.ps1` vía `WScript.Quit(exitCode)` — antes SIEMPRE devolvía éxito a
   Task Scheduler sin importar qué pasara adentro, así que un fallo como el
   del 30-jul era invisible salvo que alguien abriera la carpeta de
   documentos a mano para notar que faltaba el archivo del día.

No se tocó la metodología del análisis ni el formato del documento — este
incidente y su arreglo son enteramente de la capa de conexión/ejecución.

🚨 **Incidente real (2026-08-03) — el gate llevaba 2 días hábiles muerto en
silencio por un error de SINTAXIS.** Síntoma: no había premercado del lunes
3-ago, la Tarea de Windows figuraba con `LastTaskResult: 1`, y el log
(`premercado_auto_launch.log`) **no tenía ninguna línea nueva desde el 31-jul**
— ni siquiera un `SKIP`. Causa raíz: al agregar el paso del Recolector de datos
el **1-ago**, la línea del `Write-Log` del colector quedó con comillas escapadas
al estilo bash/JSON (`-replace \"`r?`n\", ...`), que en PowerShell es un error
de parseo. PowerShell aborta el archivo entero antes de ejecutar nada, así que
el gate salía con código 1 sin correr una sola instrucción. Como la única
evidencia de una corrida es el log en disco, y la ausencia de líneas se ve igual
que "no disparó", el fallo pasó desapercibido el viernes... y el lunes.

Arreglado en 3 partes:
1. **La sintaxis** — el `-replace` ahora usa comillas normales de PowerShell, y
   el reemplazo se calcula en una variable aparte en vez de dentro de una
   interpolación anidada (que es lo que invitaba al error).
2. **Timeout de 5 min al Recolector** — el gate lo llamaba con `& node
   collect.js` sin ningún techo de tiempo, y el 2-ago se lo vio colgarse
   indefinidamente por el bug de conexión CDP. Un cuelgue ahí se come toda la
   ventana previa a la apertura **antes** de que se llegue siquiera a la línea
   del timeout de 30 min de `claude.cmd`. Ahora corre vía `Start-Process` +
   `WaitForExit(5 min)` y, si se pasa, se lo mata y se sigue con el fallback
   manual del skill (es best-effort, no debe abortar el gate).
3. **Alertas ntfy en 2 capas** — ver la sección "Entrega del documento de
   salida" más arriba. La capa del `.vbs` existe precisamente por este
   incidente: una notificación dentro del `.ps1` no habría servido de nada.

**Lección que aplica a cualquier edición futura de estos scripts**: validar la
sintaxis ANTES de dar por buena una edición del gate, no esperar al próximo
disparo para descubrir que no compila —
```powershell
$e=$null;$t=$null
[System.Management.Automation.Language.Parser]::ParseFile("C:\Users\gcarv\.claude\skills\premercado-spx\scripts\launch_premercado_gate.ps1",[ref]$t,[ref]$e)|Out-Null
if($e.Count){$e|%{"Linea $($_.Extent.StartLineNumber): $($_.Message)"}}else{"Sintaxis OK"}
```
Vale lo mismo para el `.vbs` (probarlo apuntando a un `.ps1` de prueba). Ojo con
el patrón que causó esto: escribir estos scripts desde una herramienta que usa
escapes de bash/JSON hace muy fácil que se cuelen `\"` dentro de código
PowerShell, y el error solo aparece en tiempo de parseo — nunca al escribir.

**Registro de la Tarea** (para recrearla si se borra o se necesita en otra
máquina):
```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\gcarv\.claude\skills\premercado-spx\scripts\launch_premercado_gate.ps1"'
$trigger1 = New-ScheduledTaskTrigger -Weekly -At "07:30" -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday
$trigger2 = New-ScheduledTaskTrigger -Weekly -At "08:30" -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Hours 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "Bitacora_Premercado_SPX_Auto" -Action $action -Trigger @($trigger1,$trigger2) -Principal $principal -Settings $settings -Force
```

### Respaldo temporal de validación (`CronCreate`, vence solo)

Mientras se confirma en vivo que la Tarea de Windows es confiable (los primeros
días), se dejó además un job de `CronCreate` (recurrente, Lun-Vie 7:35am hora
Colombia — 5 min después del trigger de EDT, para no pisarlo) que: revisa si el
`.docx` de hoy ya existe con fecha de hoy (→ la Tarea de Windows funcionó, no
hace nada más) y si NO existe, corre el skill completo él mismo como respaldo y
avisa explícitamente que fue un run de backup (señal de que la Tarea de Windows
falló ese día, para investigar). Este cron **se autoborra solo a los 7 días** —
si sigue funcionando bien para entonces, no hace falta recrearlo; si la Tarea de
Windows demostró ser confiable, el respaldo ya cumplió su función.

### Contrato de "sin intervención humana" — qué hay que validar SIEMPRE

Antes de dar por buena cualquier corrida automática (headless o por `CronCreate`),
confirmar que se cumplen estas 3 condiciones — si alguna falla, la corrida
automática se va a quedar colgada esperando a alguien que no está:
1. **Ningún paso del skill llama `AskUserQuestion`, ni tampoco termina su
   respuesta con una pregunta en texto plano esperando confirmación** — esto
   último es tan fatal como lo primero en una corrida headless (`-p`, un solo
   turno, sin nadie para contestar), y NO basta con revisar que no se invoque
   la tool `AskUserQuestion` para darlo por seguro (bug real encontrado
   2026-08-01: una sesión headless fresca, al notar que ese día era sábado y
   los datos de Gamma eran del cierre del viernes, se detuvo a preguntar en
   texto plano "¿quieres que genere el premercado como preparación para el
   lunes, o hay otro propósito?" en vez de asumir la interpretación obvia y
   seguir — el proceso terminó sin generar ningún documento). **Regla explícita
   de ahora en más: si el día de hoy no es día de mercado (fin de semana o
   feriado NYSE) pero el skill se invoca igual, asumir SIEMPRE que el objetivo
   es preparar el premercado de la próxima sesión de mercado, usando el último
   cierre real disponible como referencia (exactamente el patrón ya usado y
   validado el 2026-08-01) — nunca preguntar por el propósito de la corrida,
   nunca detenerse a pedir confirmación de un supuesto obvio.** En general: ante
   cualquier ambigüedad dentro del flujo automático, tomar la interpretación
   más razonable y seguir — jamás terminar el turno con una pregunta sin
   responder, sea vía tool o en el texto de la respuesta.
2. **El allowlist de permisos cubre todo lo que el flujo necesita** — ver
   sección siguiente. La corrida headless además usa
   `--permission-mode bypassPermissions`, que de por sí ignora cualquier
   prompt de permiso — el allowlist importa sobre todo para las corridas
   interactivas/manuales, donde si el usuario está presente igual conviene no
   interrumpirlo con prompts para operaciones ya conocidas y seguras.
3. **Ninguna acción del flujo es destructiva o irreversible** en el sentido de
   las reglas de seguridad de Claude Code (sin `git push`, sin borrados, sin
   compras, sin credenciales) — confirmado repasando el flujo completo paso a
   paso el 2026-07-29: solo lee datos de mercado, controla TradingView/Chrome
   ya abiertos por el propio flujo, y escribe/actualiza archivos locales del
   propio usuario (docx, xlsx, json de log). Es lo que hace segura la bandera
   `bypassPermissions` en la corrida headless — si el flujo alguna vez agrega
   un paso realmente irreversible (ej. colocar una orden real de trading), HAY
   que revisar esta sección antes de dejarlo correr sin supervisión.

### Allowlist de permisos (`.claude/settings.json` del repo `bitacora-tasty`)

Para que las corridas **interactivas** (el usuario pide "el premercado de hoy" a
mano, con Claude Code abierto) tampoco interrumpan con prompts de aprobación,
`.claude/settings.json` del repo tiene agregado (además del allowlist de
solo-lectura ya documentado desde 2026-07-21):
- Tools de escritura de TradingView usadas por este flujo:
  `chart_set_symbol`, `chart_set_timeframe`, `chart_set_visible_range`,
  `chart_manage_indicator`, `indicator_set_inputs`, `capture_screenshot`,
  `tv_launch`, más las de lectura que faltaban (`data_get_pine_lines`).
- Tools interactivas de `claude-in-chrome` para leer Sigma Terminal:
  `navigate`, `computer`, `tabs_create_mcp`.
- `mcp__notebooklm-mcp__notebook_get`/`source_add` (usadas por otros skills
  relacionados, ej. video-a-texto, que comparten este mismo repo/settings).
- `Bash(python*)` — todo el pipeline de cálculo (MACD/RSI manual, generación del
  `.docx`, actualización del log JSON y del Excel) corre vía scripts de Python
  lanzados con Bash.
- `Bash(curl*)` — fetch directo a Yahoo Finance para OHLC diario/intradía
  (más confiable que pelear con el chart de TradingView para datos puntuales).
- `PowerShell(Get-Process*)`, `PowerShell(Stop-Process*)`,
  `PowerShell(Start-Process*)`, `PowerShell(Get-AppxPackage*)`,
  `PowerShell($pkg*)`, `PowerShell(Invoke-WebRequest*)`, `PowerShell(try*)`,
  `PowerShell(Start-Sleep*)`, `PowerShell(Get-NetTCPConnection*)`,
  `PowerShell(netstat*)`, `PowerShell([System.TimeZoneInfo]*)` — todo el Paso 0
  (matar/relanzar TradingView con el puerto CDP correcto, verificar el puerto,
  chequear hora ET real). Son reglas de prefijo literal sobre el texto del
  comando (no globs de subcomandos como en Bash) — si algún día se reescribe el
  Paso 0 con un cmdlet inicial distinto, hay que agregar ese prefijo nuevo acá
  o va a volver a pedir aprobación.

**No se allowlisteó un `PowerShell(*)` genérico a propósito** — se prefirió
listar los cmdlets realmente usados, aunque sea más frágil ante variaciones
futuras del script, para no abrir la puerta a cualquier comando de PowerShell
sin revisar en este proyecto. Si el Paso 0 cambia de forma y esto empieza a
interrumpir de nuevo, ampliar la lista en vez de saltar a un allow total.

### Entrega del documento de salida

No hay ningún paso de "entrega" activo (no se manda por email/ntfy/chat) — el
documento queda guardado directamente en la carpeta que el usuario ya revisa a
diario:
`premercados alejandro\documentos premercado\<MMDDAAAA>_premercado claude.docx`
(ver la sección "Generar el documento Word" más abajo para el detalle completo
de formato). Para que el usuario sepa que una corrida automática (headless,
sin que él la haya pedido) terminó y qué encontró, sin tener que abrir el log:
- `premercado_auto_launch.log` (una línea por corrida, lanzado/saltado/por qué)
  y `premercado_auto_launch_ultima_salida.txt` (la salida completa de texto de
  `claude -p`, incluido el resumen final que normalmente el usuario vería en
  pantalla) quedan en `control premercado\`, junto al log de hipótesis y el
  Excel de control — mismo lugar, para no dispersar la evidencia de cada día.
- El Excel de control (`control_premercado.xlsx`) se actualiza igual que en una
  corrida manual (Paso final) — es el punto de entrada más rápido para el
  usuario para confirmar "¿corrió hoy?" sin leer el log crudo.
- **Notificación push por ntfy (implementada 2026-08-03, a pedido del usuario)**:
  topic `bitacora_gcarvaja51`, el mismo que ya usan `server.js` y `gamma_daemon`
  del repo `bitacora-tasty` — no se creó un topic nuevo, para que todas las
  alertas del sistema lleguen al mismo lugar. Se manda en 3 casos, en **2 capas
  distintas a propósito**:
  1. **Éxito** (dentro de `launch_premercado_gate.ps1`, prioridad `default`):
     "Premercado SPX listo" + nombre del `.docx` generado.
  2. **Fallo conocido** (dentro del `.ps1`, prioridad `high`): la corrida se
     colgó >30 min, o terminó sin generar el documento. El `.ps1` sale con
     **código 2** en estos casos = "fallé pero YA avisé yo".
  3. **Gate caído** (dentro de `launch_premercado_gate.vbs`, prioridad
     `urgent`): si el `.ps1` sale con cualquier código ≠ 0 y ≠ 2, significa que
     murió sin poder avisar (error de sintaxis, crash temprano) y es el `.vbs`
     el que da la alarma.

  ⚠️ **Por qué la capa 3 vive en el `.vbs` y no en el `.ps1`** (no mover esto
  "para simplificar"): el incidente del 2026-08-03 fue justamente un error de
  **sintaxis** en el `.ps1` — PowerShell no podía ni parsear el archivo, así
  que salía con código 1 **sin ejecutar una sola línea**, ni siquiera el primer
  `Write-Log`. Una notificación dentro del `.ps1` nunca se habría enviado. El
  `.vbs` es un archivo separado que sí sigue corriendo en ese escenario, y por
  eso es el único lugar donde la alerta de "gate caído" tiene sentido.

  Los `SKIP` normales (fuera de ventana horaria, fin de semana, feriado NYSE)
  **no** notifican nada — son 1-2 por día hábil y convertirlos en push volvería
  ruido lo que debe ser señal.

  Verificado en vivo el 2026-08-03: envío real entregado, y la capa 3 probada
  apuntando un `.vbs` de prueba a un `.ps1` roto a propósito con el mismo tipo
  de error de sintaxis del incidente (alerta urgente entregada correctamente).

## Recolector de datos (2026-08-01, nuevo) — correr esto ANTES del Paso 0

A pedido explícito del usuario, tras un día (2026-08-01) peleando en vivo con la conexión
CDP de TradingView Desktop y con la extensión de Chrome mientras se intentaba redactar el
informe al mismo tiempo: **separar la parte mecánica (conectarse, capturar, leer números)
de la parte que necesita criterio (escribir el análisis)**. La redacción del informe NO
debería bloquearse porque el puerto CDP esté desalineado o la extensión de Chrome se cayó
— eso es exactamente lo que pasó ese día.

**Antes de tocar cualquier tool de `mcp__tradingview__*` o `claude-in-chrome` para este
skill, revisar primero si ya existe el bundle de hoy:**
`C:\Users\gcarv\Documents\CARPETA PERSONAL\01. guillermo carvajal\01_Sigma\mentoria
alejandro\premercados alejandro\control premercado\data_collector\<MMDDAAAA>\` — contiene
`chart_30m.png` (captura ya lista para el Paso "Chart 30 minutos") y `bundle.json` (con
`tradingview.studyValues` — POC/EMAs/MACD leídos del chart — y `sigma` — Call Wall/Put
Wall/Gamma Flip/MVS/GEX/DEX/Vanna, con el campo `asOf` indicando de qué momento es el
dato). Si el bundle de hoy existe, **usarlo directamente y saltar el Paso 0 y la lectura
en vivo de Sigma Terminal por completo** — es más confiable que pelear con la conexión en
el momento.

Si el bundle de hoy NO existe (corrida manual/interactiva fuera del horario del disparo
automático, o el colector falló), correrlo a mano antes de intentar cualquier otra cosa:
```
cd "C:\Users\gcarv\bitacora-tasty\premercado_collector" && node collect.js
```
Solo si el colector también falla, recurrir al Paso 0 (conexión en vivo con TradingView
Desktop) y al método de "Modo manual"/Sigma Terminal en vivo documentados más abajo — esos
procedimientos siguen vigentes como respaldo, no se eliminaron.

**Arquitectura** (`C:\Users\gcarv\bitacora-tasty\premercado_collector\collect.js`):
- Reutiliza `gamma_daemon/tv.js` (`connectToSpxWindow`) para la conexión CDP — mismo
  patrón ya probado que prueba cada ventana candidata y verifica el símbolo antes de
  usarla, en vez de tomar ciegamente la primera (que es la causa raíz de la mayoría de los
  incidentes de conexión documentados en este skill).
- Enfoca un pane, guarda su resolución original, cambia a 30min + rango de 3 días, captura
  el PNG (`Page.captureScreenshot` recortado al canvas del chart), lee los valores de todos
  los estudios visibles (`dataSources()` / `dataWindowView()`, el mismo mecanismo que usa
  `data_get_study_values` del MCP), y **restaura la resolución original del pane** antes de
  cerrar la conexión — no debe dejar el chart del usuario en un estado distinto al que
  estaba.
- ⚠️ **Para Sigma Terminal NO lanza su propio Puppeteer.** Se intentó al principio y
  reventó con `Failed to launch the browser process!` — `gamma_daemon/sigma.js` ya
  mantiene abierto un Chrome dedicado con perfil persistente (`sigma_profile/`) de forma
  continua (nunca lo cierra entre ciclos), y una segunda instancia de Puppeteer contra el
  mismo `userDataDir` no puede arrancar mientras la primera esté viva. En vez de competir
  por esa instancia, el colector simplemente **lee `gamma_daemon/status.json`**
  (`lastLevels`/`lastSuccessAt`), que el propio daemon ya persiste en cada ciclo exitoso
  dentro de horario de mercado — es exactamente "el último dato disponible" sin tocar el
  navegador para nada. Si se necesita el dato de Gamma más reciente posible y el gate
  corre menos de ~2 min después de la apertura, este archivo puede estar tan actualizado
  como la lectura en vivo; fuera de horario (fin de semana, antes de que abra el mercado)
  refleja el último cierre exitoso — igual que ya se hacía manualmente ("toma los de
  ayer", instrucción explícita del usuario el 2026-08-01).
- No es una Tarea Programada nueva — se invoca como un paso más dentro de
  `launch_premercado_gate.ps1` (ver "Disparo automático" arriba), justo antes de lanzar
  `claude.cmd`, best-effort (si falla, no aborta el gate, el skill sigue con el fallback
  manual de siempre).

### 🚨 La captura del chart por CDP es IMPOSIBLE con la pestaña del SPX de fondo (2026-08-27)

Cuatro días seguidos de `tradingview: null` en el bundle (24, 25, 26 y 27 de agosto)
tenían una sola causa, y no era lentitud.

**TradingView Desktop no usa pestañas de Chrome.** Cada chart es una ventana top-level
propia que gestiona el shell de la app, y las que no están activas quedan **ocultas** —
`EnumWindows` las devuelve con `IsWindowVisible=false` sin estar minimizadas. Medido en
vivo sobre la ventana real del SPX en ese estado:

| Prueba | Resultado |
|---|---|
| `getBoundingClientRect()` del chart | **0×0** — el layout de una pestaña oculta colapsa |
| `Page.bringToFront()` | Resuelve en **4 ms** y el chart **sigue en 0×0** |
| `captureScreenshot` con `clip` de 0 | `Cannot take screenshot with 0 width` |
| `captureScreenshot` **sin** `clip` | **No vuelve nunca** ← el "timeout de 30s" de los días 24-26 |
| `captureBeyondViewport: true` | No sirve, el clip sigue en 0 |
| `Emulation.setDeviceMetricsOverride` | No sirve, el clip sigue en 0 |

**El arreglo del 21-ago (`bringToFront()` antes de capturar) es un no-op.** Aquella
medición de "0,8s con bringToFront" se hizo cuando la pestaña del SPX era la activa;
dejó de serlo y la línea nunca volvió a servir. CDP activa el *target*, pero no puede
desocultar una ventana que administra el shell de la aplicación.

Y forzarlo **no es opción**: esa ventana es del `gamma_daemon` (ver `CLAUDE.md` de
`bitacora-tasty`). Tampoco tiene sentido pedirle a Guillermo que deje el SPX al frente:
trabaja con el SP500 en pantalla, y esa es su decisión, no un descuido.

**Qué se cambió, entonces:**

1. **Guard rápido en `captureChartPng`.** Si el chart mide 0×0 (o el pane no tiene
   `_mainDiv`), aborta en milisegundos con un mensaje que explica la causa, en vez de
   quemar 30-60 s de la ventana previa a la apertura. Y **nunca** se llama a
   `captureScreenshot` sin `clip`: sin recorte, sobre una ventana que no compone, la
   llamada no vuelve y no hay timeout de CDP que la rescate.
2. **La captura dejó de ser fatal.** Antes un fallo ahí abortaba el bloque entero y se
   perdían también los `studyValues` — por eso el bundle venía con `tradingview: null`
   y el informe se quedaba sin POC, EMAs ni MACD del chart, no solo sin imagen. Son dos
   datos independientes: que no se pueda fotografiar la ventana no impide leerle los
   números. Ahora el bundle trae `chartPng` (bool) y `chartPngError`.
3. **`premercado_collector/chart30m.py`** — el chart de 30 minutos se dibuja con velas
   reales de Yahoo y los muros de Sigma superpuestos, y el colector lo llama solo cuando
   la captura no salió. Esto **ya se venía haciendo a mano cada mañana**: once scripts de
   un solo uso equivalentes (`.scratch_chart30m_0821.py`, `_0825.py`, …) desde el 4 de
   agosto. Ahora sale del bundle siempre y no depende de que alguien lo improvise.
4. **Seis segundos de espera en el gate** tras matar los procesos MCP, antes de arrancar
   el colector. El 27-ago se mataron a las 07:31:22 y el colector conectó a las 07:31:29:
   `connectToSpxWindow()` se colgó hasta su techo de 60 s, cuando en frío la misma llamada
   tarda entre 0,4 y 1,3 s. Matar de golpe procesos con WebSockets CDP abiertos deja a
   TradingView limpiando esas sesiones y la conexión nueva entra en el medio. Solo espera
   si de verdad mató alguno.

**El guard NO desactiva la captura.** Verificado el mismo día: en horario de sesión el
chart del SPX sí estaba compuesto (624×562) y el guard no disparó. Cuando la captura es
posible se hace, y cuando no, se corta en seco y se dibuja. Si algún día la pestaña del
SPX vuelve a ser la activa a las 7:30am, la captura real vuelve sola.

## La base SP500 ↔ SPX — el informe y su pantalla no hablan el mismo idioma (2026-08-31)

Guillermo lo planteó así: *"el precio que muestra el activo SP500 que revisamos no es igual
al precio que muestra el SPX, la diferencia es como de 8 puntos"*. Tiene razón, y el efecto
no es cosmético: **todo este skill está escrito en SPX de contado** — las velas de Yahoo
(`^GSPC`), los estudios que se leen del pane `SPCFD:SPX`, los muros, los disparadores de
15m — mientras él trabaja con **`VANTAGE:SP500`** al frente. Cuando el informe dice "cierre
de 15m bajo 7.671", en su pantalla ese nivel está ~7,5 puntos más arriba. Cada disparador
del día está desplazado, en la misma dirección y sin avisar.

**Se mide, no se asume**: `premercado_collector/base_sp500.js` (repo `bitacora-tasty`), que
el gate corre en el bloque 4.6, después del colector. Lee por CDP las barras de las dos
ventanas, las empareja por timestamp, filtra a horario regular y guarda la serie en
`control premercado\base_sp500_vs_spx.json`.

⚠️ **Es SOLO LECTURA y tiene que seguir siéndolo.** No cambia símbolo, no cambia
resolución, no llama `bringToFront` ni roba foco. Es el mismo patrón que
`connectToSpxWindow()` del daemon ya ejecuta en cada ciclo. Cambiarle el símbolo a la
ventana de `SPCFD:SPX` es lo que dispara el `taskkill` del daemon (ver `CLAUDE.md`).

**El archivo hace MERGE, no overwrite.** El chart solo retiene ~300 barras — con
resolución de 30m son unas 6 sesiones — así que cada corrida ve una ventana que se
desplaza. Si se reescribiera, la serie nunca pasaría de 6 días y el histórico se perdería
en silencio. Un día ya guardado solo se reemplaza si la lectura nueva trae al menos tantas
barras como la vieja.

### Los números al 2026-08-31 (primera medición, 7 sesiones)

| | |
|---|---|
| Base vigente | **+7,45** (mediana de las 5 sesiones completas 25-31 ago) |
| Medianas diarias | 6,31 · 8,06 · 7,20 · 7,47 · 7,55 · 6,04 · 7,45 |
| Banda por barra | 4,15 a 9,32 |
| Deriva | **−0,01 pts por sesión** (o sea: plana) |

`base_vigente` es la mediana de las últimas 5 sesiones COMPLETAS, no la del último día: el
día a día se mueve ±1 punto y quedarse con el último es tomar ruido por señal.

### 🚨 Las dos series tienen que estar en la MISMA resolución

Bug real, encontrado y arreglado el mismo día que se montó esto. La primera versión cogía
la primera serie de cada símbolo **sin mirar la resolución**. Por la mañana las dos
ventanas estaban en 30m y salió bien. Por la tarde Guillermo había pasado la del SPX a 15m
y la del CFD seguía en 30m, y el script emparejó igual — **y emparejó "exacto"**, porque
todo timestamp de 30m existe también en la serie de 15m. Estaba restando el cierre de una
vela de 30 minutos contra el de una de 15 que termina quince minutos antes.

Lo que delató el fallo fue la **banda por barra**, que saltó de 4,15-9,32 a **−11 a +21**:
eso no es la base, es el recorrido del precio en ese cuarto de hora. **La mediana apenas se
movió** (+7,47 → +7,37), y eso es justo lo que hacía peligroso el bug: el número principal
parecía sano mientras el dato estaba roto. Si alguna vez la banda se abre de golpe y la
mediana no, sospechar del emparejado antes que del mercado.

Consecuencias, ya en el código:
- Se eligen las dos series con **resolución común** que más barras de RTH dejen pareadas.
  Si no comparten ninguna, **falla en vez de medir** — un número que parece sano y no lo es
  es peor que no tener número.
- Cada fila del registro guarda su `resolucion`, y el merge **no pisa** una fila medida en
  otra resolución. Sin eso, la corrida rota (mismo `n=13`) machacó seis días de datos
  buenos sin que nada lo notara; hubo que restaurarlos a mano desde la corrida verificada.
- Las medianas son robustas al cambio de resolución (el 31-ago medido en 2m dio +7,45, en
  línea con los días de 30m), pero **la banda por barra no lo es** — a más resolución, más
  ruido. Comparar bandas solo entre filas de la misma resolución.

### 🚨 NO usar la base del futuro para esto

Es el error que casi se comete el mismo día que se montó esto. La base **ES=F ↔ ^GSPC** se
midió aparte sobre un mes (546 barras de 15m) y hace algo completamente distinto:

| | 31-jul | 07-ago | 14-ago | 21-ago | 28-ago |
|---|---|---|---|---|---|
| Base ES vs contado | +28,18 | +23,74 | +20,65 | +16,68 | +11,14 |

Cae **0,77 puntos por sesión hábil**: es la convergencia al vencimiento. Llega a ~0 el
**18-sep** (quad witching) y al día siguiente **salta de vuelta a ~+28** cuando el contrato
rueda a diciembre.

**`VANTAGE:SP500` NO hace eso.** Es un CFD que sigue al contado con un spread de bróker
prácticamente constante: su deriva medida es −0,07, cien veces menor. Confundir las dos
bases metería hoy un error de 5 puntos y, después del roll de septiembre, de 20 — y en la
dirección contraria a la intuición. Son dos números distintos con dos comportamientos
distintos y hay que mantenerlos separados.

La base del ES **sí sigue siendo la correcta** para la apertura implícita (el cálculo desde
`ES=F` que el Paso 4bis ya usa y que el 28-ago acertó la apertura por 0,78 puntos). No
tocar eso: son cálculos distintos sobre instrumentos distintos.

### Qué tiene que hacer el informe con esto

Leer `base_sp500_vs_spx.json` y publicar la conversión, en dos sitios:

1. **En la portada gerencial**, una línea bajo el contexto: *"Los niveles de este informe
   están en SPX de contado. En tu pantalla (VANTAGE:SP500) súmales 7,5: activación bajista
   7.671 → 7.678,5. Base medida el 31-ago sobre 5 sesiones."*
2. **En "Posibles trades"**, el nivel convertido entre paréntesis junto a cada disparador,
   que es donde de verdad se usa.

Y decir siempre **de qué fecha es la base**. Un número sin fecha en este sistema es el
mismo problema que el desfase que vino a resolver.

⚠️ **La conversión es una ayuda de lectura, no un instrumento de precisión.** Dentro de una
misma sesión la base se mueve 2-3 puntos (ver la banda por barra), así que un nivel
convertido es bueno a ±1,5. **Los niveles de registro siguen siendo los de SPX** — el log,
los escenarios que lee la Estrategia Premercado y el postmercado NO se convierten nunca, o
se rompe la comparabilidad de toda la serie histórica. Se convierte para mirar la pantalla,
no para guardar.

## Paso 0 — Conectar con TradingView (datos en vivo)

TradingView Desktop en esta máquina está instalado como app empaquetada (MSIX/Store),
NO en las rutas estándar que busca `tv_launch` automáticamente. Gotchas conocidos:

1. El ejecutable real está en algo como:
   `C:\Program Files\WindowsApps\TradingView.Desktop_<version>_x64__n534cwy3pjxzj\TradingView.exe`
   (la versión puede cambiar; si no lo encuentras, buscar con:
   `Get-ChildItem "C:\Program Files\WindowsApps" -Filter "TradingView*" -ErrorAction SilentlyContinue`)
2. **Resuelto (2026-07-17): puerto separado de tastytrade, ya no hace falta
   cerrarlo.** El health check del MCP (`mcp__tradingview__tv_health_check`) y el
   resto de las tools SÍ respetan un puerto configurable — `src/connection.js` del
   MCP (`C:\Users\gcarv\tradingview-mcp`) lee `process.env.CDP_PORT` (default
   `9222` si no está seteado). El conflicto real era que **tastytrade** (otra app
   del usuario, corre un Chromium embebido de `jxbrowser`) también toma el 9222
   por defecto para su propio uso interno, y competía con TradingView por el mismo
   puerto.

   🚨 **REGRESIÓN — el fix se perdió y estuvo roto del 19 al 24-ago (2026-08-24).**
   Existían **dos** configuraciones del mismo server, y la que mandaba no tenía el
   puerto:

   | Archivo | `CDP_PORT` | ¿Mandaba? |
   |---|---|---|
   | `~\.claude\.mcp.json` | `9223` | no |
   | `~\.claude.json`, scope `user` | `env: {}` | **sí** |

   Sin puerto → default `9222` → el chromium de tastytrade, que expone el puerto
   pero con **cero targets** → `No TradingView chart target found` cuatro sesiones
   seguidas. Reaplicado con el CLI (no editando el JSON a mano, que la app lo está
   usando):
   `claude mcp remove tradingview -s user` y
   `claude mcp add tradingview -s user -e CDP_PORT=9223 -- node C:\Users\gcarv\tradingview-mcp\src\server.js`.

   ✅ **Ya no hay duplicado.** El 2026-08-24 se borró `~\.claude\.mcp.json` (copia
   en `.mcp.json.borrado_20260824.bak`, que **no** se carga) y quedó una sola
   fuente: el scope `user` de `~\.claude.json`. Si el puerto vuelve a fallar, es
   ahí y en ningún otro sitio. Y si alguien vuelve a crear un `.mcp.json`, el
   duplicado ha vuelto — que es como se perdió el fix la primera vez.

   Fix original (2026-07-17), entonces aplicado en `~\.claude\.mcp.json`: el server
   `tradingview` arranca con `"env":{"CDP_PORT":"9223"}`, así que el MCP
   habla con TradingView por el 9223 mientras tastytrade se queda tranquilo en el
   9222 — **corren en paralelo, ya no hace falta cerrar tastytrade nunca más**.

   🚨 **La ventana que elige el MCP (arreglado 2026-08-24).** Con varias ventanas
   de TradingView abiertas, **todas tienen la misma URL y el mismo título**, así
   que por URL no se distinguen. `findChartTarget()` en `src/connection.js` cogía
   `targets.find(...)` — la primera de la lista. Ese día la primera era
   **`VANTAGE:SP500`** (uno de los símbolos que NO valen para el SPX) y
   `SPCFD:SPX` estaba en tercer lugar: el MCP conectaba "bien" y devolvía datos de
   otro instrumento **sin avisar de nada**. Ahora `findChartTarget()` le pregunta
   el símbolo a cada ventana y se queda con la de `TV_SYMBOL` (default
   `SPCFD:SPX`); si no la encuentra, cae a la primera como antes. Una ventana que
   no contesta en 4s se descarta sola. **No hace falta cerrar las otras ventanas**
   — y sobre todo, no hay que cambiarle el símbolo a ninguna para "arreglarlo":
   tocar la de `SPCFD:SPX` es lo que dispara el ciclo de `taskkill` del daemon.
   ⚠️ Este cambio requiere que Claude Code se haya reiniciado/recargado los MCP
   servers al menos una vez después del 2026-07-17 para tomar el nuevo
   `CDP_PORT` (Node lee el env var solo al arrancar el proceso). Si el health
   check sigue fallando apuntando al 9222 tras este fix, sospechar que el
   servidor MCP no se recargó todavía.
   ⚠️ **Confirmado en la práctica (2026-07-20):** el proceso Node del MCP seguía
   vivo desde antes del fix del 17-jul y no había recargado `CDP_PORT` — curl
   directo a `127.0.0.1:9223/json/version` respondía bien (TradingView SÍ estaba
   arriba con el flag correcto), pero `tv_health_check` seguía fallando ("fetch
   failed") porque el server intentaba 9222 por default. Solución pragmática sin
   pedirle al usuario que reinicie Claude Code: cerrar TradingView y relanzarlo
   con `--remote-debugging-port=9222` (el puerto que el proceso MCP viejo sigue
   esperando) en vez de 9223 — funciona igual, solo que sin el aislamiento de
   tastytrade que buscaba el fix. Si esto se repite, confirmar con
   `Get-NetTCPConnection -State Listen | Where LocalPort -in 9222,9223` cuál
   puerto responde antes de asumir cuál usar.
3. Verificar que no quede ninguna instancia vieja de TradingView SIN el flag de
   depuración correcto (si el usuario ya tenía una abierta manualmente, sin
   `--remote-debugging-port`, hay que cerrarla y relanzar):
   ```powershell
   Get-Process -Name "TradingView" -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false
   Start-Sleep -Seconds 2
   $exe = (Get-AppxPackage -Name "*TradingView*").InstallLocation + "\TradingView.exe"
   Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=9223"
   Start-Sleep -Seconds 6
   ```
   (o usar `mcp__tradingview__tv_launch` con `port: 9223` directamente, que hace
   lo mismo — pero ese tool busca el .exe en rutas estándar que no aplican a esta
   instalación MSIX, ver nota de `Get-AppxPackage` arriba en vez de
   `Get-ChildItem "C:\Program Files\WindowsApps"`, que puede devolver vacío por
   permisos aunque el paquete exista.)
4. Verificar con `mcp__tradingview__tv_health_check`. Debe devolver `cdp_connected: true`
   y `chart_symbol` (normalmente `SPCFD:SPX`).

Si el usuario prefiere no tocar procesos del sistema ese día, se puede saltar este
paso y pedirle los niveles manualmente (ver "Modo manual" al final).

⚠️ **Múltiples pestañas de TradingView abiertas — la conexión CDP se puede quedar
pegada a la equivocada (2026-07-21):** si el usuario tiene más de un chart de
TradingView abierto (ej. el de SPX `bbzkaAWN` y otro que esté usando para mirar
otro activo, como NU), la conexión CDP cacheada de la tool puede quedar apuntando
al chart equivocado — `tv_health_check` devuelve `chart_symbol` de OTRO activo.
`mcp__tradingview__tab_switch` NO alcanza para arreglarlo por sí solo (solo trae
la ventana al frente visualmente, no reconecta el WebSocket cacheado) — hay que
usar `tab_list` para encontrar el índice del chart correcto, `tab_switch` a ese
índice, y **verificar de nuevo con `tv_health_check`** antes de asumir que ya
apunta a SPX. Si sigue pegado al chart equivocado tras el switch, no insistir —
avisar brevemente al usuario y, para lo que solo necesite datos de precio/OHLC
(no niveles de Gamma en vivo del chart), preferir traerlos directo de Yahoo
Finance (`https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC`, mismo
método que ya usa el propio servidor de producción) en vez de pelear con la
pestaña — es más simple y confiable para ese caso puntual.

**Permisos ya reducidos (2026-07-21):** `.claude/settings.json` del repo tiene un
allowlist de las tools de solo-lectura más usadas de este flujo (`read_page`,
`pane_list`, `pane_focus`, `tv_health_check`, `chart_get_state`,
`capture_screenshot`, `data_get_*`, `quote_get`, `tab_list`/`tab_switch`, tools de
`claude-in-chrome` de lectura) — esas ya NO deberían pedir confirmación. Las que
SÍ escriben algo (`indicator_set_inputs`, `computer`, `chart_set_symbol`,
`chart_set_timeframe`, `javascript_tool`, `ui_evaluate`, `ui_click`) siguen
pidiendo confirmación a propósito — es el límite de seguridad de Claude Code, no
un pendiente de este skill. No intentar ampliar ese allowlist a tools de
escritura sin que el usuario lo pida explícitamente y entienda el trade-off.

## Paso 1 — Marco Semanal (contexto de fondo)

- Cambiar timeframe a semanal: `mcp__tradingview__chart_set_timeframe timeframe="1W"`.
- Revisar: ¿estructura respeta la EMA10 semanal como soporte de impulsos sanos?
  ¿Hay "colas de piso" (demanda entrando pese al ruido)?
- Ubicar el **techo/piso del canal** semanal de las últimas semanas (usar
  `data_get_ohlcv` con `summary=true` para máximos/mínimos recientes).
- **Fractal semanal**: nivel de referencia donde el precio pivotó antes (varias
  semanas atrás), al cual es "sano" que regrese para tomar fuerza antes de un
  nuevo impulso. Se usa para distinguir un retroceso técnico normal de una
  debilidad estructural mayor. Ejemplo real citado: *"el fractal estaba en los
  7,000... vino a tocar la EMA 10 al tomar la liquidez... milimétrico"*.
- **Cruce EMA50/EMA200 (o 250)** en semanal/diario:
  - Cruce bajista (EMA50 cruza abajo de la 200) = **"Cisne Negro"** → señal de
    debilidad extrema.
  - Cruce alcista (EMA50 cruza arriba de la 200/250) = **"Cisne Blanco" / "Golden
    Cross"** → señal de fortaleza. Revisar si el chart ya tiene EMA200/250; si no,
    agregarla con `chart_manage_indicator`.
- Conclusión: ¿movimiento sano de toma de liquidez, o debilidad estructural?

## Paso 2 — Marco Diario (filtro que define la tesis del día)

- Timeframe diario: `chart_set_timeframe timeframe="1D"`.
- `data_get_study_values` para leer POC diario (D POC), POC de 4 horas (240 POC,
  suele coincidir con el diario formando zona de alta liquidez), MACD (pendiente:
  positiva/negativa/aplanada), y cualquier EMA50 visible.
- RSI: si no hay estudio de RSI en el chart, se puede pedir agregarlo con
  `chart_manage_indicator` (nombre completo: "Relative Strength Index").
- Regla clave: *si el precio respeta el POC diario/EMA50, se conserva estructura
  alcista; si lo rompe, pasa a bajista en la diaria*.
- **Fractal diario**: mismo concepto que el semanal pero en esta temporalidad;
  suele formar una "confluencia de soporte" junto con la línea de tendencia del
  algoritmo y el POC (semanal/diario/30min).
- Identificar clústeres de volumen y zonas de liquidez arriba/abajo.
- Conclusión de esta capa: p.ej. "neutral alcista", "fase 3 (consolidación)", etc.

## Paso 3 — Capa de Derivados (Greeks / Gamma)

⚠️ **SUPERADO (2026-07-30) — el "Ciclo de refresco" descrito más abajo (leer Sigma
Terminal vía `read_page`, `pane_focus`+`indicator_set_inputs`, repetir cada 2 min
con `/loop`) ya NO se ejecuta con un agente de Claude.** Se reemplazó por
`gamma_daemon/` (proceso Node de vida larga, en el repo `bitacora-tasty`, sin LLM
en el loop) — corre solo vía la Tarea Programada de Windows `GammaDaemon`, con su
propio watchdog/reintentos/alerta ntfy. El resto de esta sección (mapeo de
inputs, guards de símbolo/horario, bugs históricos de recompilación) sigue siendo
contexto real y válido — son los mismos hechos sobre CIARG_V1/Sigma Terminal que
el daemon también respeta — pero la **mecánica de ejecución** (agente + tools de
`claude-in-chrome`/`mcp__tradingview__*` corriendo cada 2 min) es historia, no el
procedimiento vigente. Si hace falta tocar el refresco de Gamma en vivo, el punto
de partida es `gamma_daemon/index.js`/`tv.js`/`sigma.js`, no este skill. La única
pieza que SIGUE siendo manual (no automatizada, ver notas ahí) es editar el
código Pine de CIARG_V1 en sí (agregar/cambiar inputs o la tabla) — eso todavía
requiere abrir el editor a mano en TradingView y confirmar "Update on chart".

**Revisar primero el bundle del Recolector de datos** (ver sección al principio del
skill) — `bundle.json` ya trae `sigma` (Call Wall/Put Wall/Gamma Flip/MVS/GEX/DEX/Vanna,
con `asOf`) sin tener que leer Sigma Terminal en vivo. Solo si no existe o está
desactualizado, seguir con la lectura en vivo documentada abajo.

Alejandro usa una herramienta externa ("GreeksInsight" / "Sigma Terminal"). **Antes
de asumir que no hay datos**, revisar si alguno de los estudios ya cargados en el
chart de TradingView del usuario los está ploteando directamente (algunos de sus
indicadores custom — p.ej. "Traders Trend Dashboard", "Reditum Sniper Ultra",
"CIARG_V1" — pueden traer niveles de Gamma/Call Wall/Put Wall como líneas o
etiquetas Pine). Probar `data_get_pine_labels` / `data_get_pine_lines` con
`study_filter` por cada estudio antes de darlos por no disponibles. Si ninguno los
trae, pedir al usuario los valores manualmente.

Elementos a registrar (en vivo si se encuentran, o manuales si no):
- **Gamma Flip**: precio bajo el flip = gamma negativo (movimientos violentos,
  soportes se rompen fácil); sobre el flip = gamma positivo (subida ordenada).
- **Call Wall** (resistencia fuerte / imán) y **Put Wall** (soporte fuerte / imán).
- **Net Gamma Exposure / "contrato(s) más valioso(s)"**: strike(s) donde se
  concentra el gamma (posible "pinning").
- **Comparación día a día (MUY importante, no omitir)**: Alejandro siempre compara
  estos niveles con los del día anterior, no solo su valor absoluto:
  - Si **Call Wall y Put Wall bajan** ambos vs. el día anterior → señal de
    **debilidad** (el "techo" y el "piso" del mercado están descendiendo). Ejemplo
    real: *"el módulo de las Google [Walls] está bajando versus lo que había
    ayer... eso también pueden ser señales"*; *"Put Wall 7,300 ahí está bajando y
    el Call [Wall] es 7,420... que está bajando... estamos abriendo con régimen
    negativo"*.
  - Si **Call Wall sube** vs. el día anterior → se interpreta que se está
    **"abriendo espacio"** para que el precio siga subiendo. Ejemplo real: *"va
    subiendo el Call [Wall]... se le va abriendo más espacio para subir"*.
  - Registrar explícitamente en el documento: Call Wall hoy vs. ayer, Put Wall hoy
    vs. ayer, y la lectura (fortaleza/debilidad) que se deriva de ese movimiento.
- Nota: los primeros ~15 min tras la apertura sirven para que Delta/Gamma "se
  acomoden" y confirmen el régimen real del día (p.ej. "gama negativo, delta
  negativo" vs "gama positivo, delta negativo").

Si el usuario no aporta estos datos ni se encuentran en el chart, indicarlo
claramente en el documento final como "Capa de derivados: sin datos hoy" en vez de
inventar niveles.

### Graficar Call Wall / Put Wall / Gamma Flip / MVS EN VIVO sobre CIARG_V1

El usuario tiene cuenta de TradingView limitada a 4 indicadores por pantalla, así
que en vez de agregar un 5to indicador, estos niveles se inyectaron DIRECTAMENTE
en el script propio del usuario **CIARG_V1** (`USER;da9f994ddf71474ea75238dc0fd719a6`,
entity_id: **confirmar SIEMPRE con `chart_get_state` al empezar la sesión, cambia
cada vez que se remueve/re-agrega el estudio o se recarga la página** — valores
vistos en distintas sesiones: `t6hIQp`, `fToe2v` (pane 0), `22uhrg` (pane 1); no
asumir que sigue siendo el mismo de la sesión anterior). Se agregaron al final
del script 4 inputs nuevos (Call Wall, Put Wall, Gamma Flip, MVS) + líneas y
etiquetas de última barra, ancladas en `bar_index` (justo en el precio actual).

⚠️ **Las líneas NO usan `hline()`, usan `line.new`/`label.new` — a propósito, no
por descuido (2026-07-20, aclarado tras pregunta del usuario sobre por qué no
hay controles de color/grosor en la pestaña "Estilo" del indicador):** `hline()`
exige que su argumento `price` sea input-qualified (const/input), y el guard
"solo dibujar en SPX" (`is_spx_G = str.contains(syminfo.ticker, "SPX")`, evita
que estos niveles distorsionen el chart al abrir otro activo de escala distinta)
depende de `syminfo.ticker`, que Pine solo califica como "simple" — combinarlo
con `hline()` rompe la compilación. `line.new`/`label.new` no tienen esa
restricción, pero como contrapartida **no generan entradas nativas en la pestaña
Estilo** (eso solo lo hacen `hline()`/`plot()`) — el usuario no va a poder
cambiar color/grosor de estas 4 líneas desde la UI del indicador, solo editando
el código Pine directamente (colores fijos, ver más abajo). Explicar esto si el
usuario pregunta de nuevo por qué no aparecen ahí — no es un bug pendiente.

🐛 **Bug real encontrado y resuelto (2026-07-20) — el MVS nunca se graficaba
porque la instancia del chart corría una versión vieja del script:** el código
de `mvs_G`/`in_24` siempre estuvo bien escrito (idéntico patrón a los otros 3
niveles), pero `indicator_set_inputs` nunca confirmaba `in_24` en su respuesta
y `data_get_pine_labels` nunca devolvía el label de MVS. Diagnóstico: leyendo
`study.getInputValues()` en vivo (via `ui_evaluate`, no hay tool dedicado) se
confirmó que la instancia corriendo en el chart estaba en `pineVersion: 14.0`
mientras el script guardado (`pine_list_scripts`) ya iba en la `19.0` — la
instancia nunca se recompiló después de que se agregó el input de MVS, así que
`in_24` literalmente no existía en el estudio vivo (se quedaba en 30 inputs
totales, terminando en `in_23`). **`chart_manage_indicator(action:"add")` por
nombre y `chart.createStudy()` directo por `pineId` (via `ui_evaluate`) NO
sirven para forzar la recompilación** — ambos fallan silenciosamente en agregar
una instancia nueva para este script custom (a diferencia de indicadores
estándar tipo RSI/MACD, que sí funcionan con `chart_manage_indicator`). La
única vía que funcionó: **el usuario quita el indicador a mano desde la UI de
TradingView (clic derecho → Quitar) y lo vuelve a agregar buscándolo por
nombre** — y ni así alcanza, todavía hace falta un **`location.reload()`** (via
`ui_evaluate`, reconectar con `tv_health_check` después — cambia el `target_id`
de CDP) para que TradingView descarte el Pine compilado en caché y recompile
con el código guardado más reciente. Confirmar el fix con
`study.getInputValues()` (`pineVersion` debe ser igual al `version` de
`pine_list_scripts`, y `in_24` debe aparecer) antes de volver a pushear valores.

⚠️ **Probado y revertido (13 jul 2026): NO usar offset en las etiquetas.** Se
intentó mover las etiquetas a `bar_index + N` para que no se superpusieran al
precio en vivo, pero esto causaba que las líneas `hline` quedaran visualmente
desincronizadas de las etiquetas (etiqueta muestra el valor nuevo, línea se
queda en el strike viejo) de forma intermitente e impredecible — no solo tras
recompilar sino en cualquier ciclo normal de refresco de inputs. El toggle de
visibilidad (`indicator_toggle_visibility` off/on) mitigaba el síntoma pero no
lo eliminaba del todo. El usuario decidió que la superposición con el precio es
preferible al desfase, así que las etiquetas volvieron a `bar_index` sin offset
y sin ningún paso de refresco extra en el loop. NO reintroducir el offset a
menos que el usuario lo pida explícitamente sabiendo este riesgo.

**Fuente de los 3 valores**: Sigma Terminal, `https://web.sigma.trade/terminal/?tab=greeks`
(requiere sesión del usuario ya iniciada en Chrome). Esta app es 100% en vivo/streaming
y NUNCA llega a `document_idle`, así que `get_page_text` se cuelga — usar
**`read_page` (árbol de accesibilidad)** en su lugar, que sí funciona. Los campos
relevantes en el árbol son (nombres exactos vistos):
- `generic "Gamma Flip"` seguido de `generic "<numero>"` (ej. "7526")
- `generic "Put Wall"` → `generic "<numero>"` (ej. "7550") + `generic "soporte"`
- `generic "Call Wall"` → `generic "<numero>"` (ej. "7600") + `generic "resistencia"`
- `generic "MVS"` → `generic "<numero>"` (ej. "7495") + `generic "most valuable
  strike"` — se grafica también (agregado 13 jul 2026), color naranja.
- Bonus disponible ahí mismo (no graficado aún): Net GEX, Total Gamma, Net DEX,
  Net Vanna, Max Pain, P/C (OI), IV Promedio ATM.

**Mapeo de inputs en CIARG_V1 (verificado, pero recontar si se vuelve a editar el
script)**: en el orden en que Pine autogenera los IDs según la posición de
declaración del `input.*` en el código — al momento de escribir esto:
- `in_20` = mostrar niveles gamma (bool)
- `in_21` = Call Wall (float)
- `in_22` = Put Wall (float)
- `in_23` = Gamma Flip (float)
- `in_24` = MVS (float)
- `in_25`/`in_26` = GEX actual / GEX hace ~6min (float) — agregado 2026-07-30,
  reemplaza los viejos `in_25`/`in_26` (GEX/DEX positivo, bool) que alimentaban
  la tabla de escenarios (GRIND ALCISTA/etc.); esa tabla se reemplazó por una
  de GEX/DEX/Vanna actual-vs-anterior con color y flecha de tendencia (ver
  `gamma_daemon/new_source.txt` para el código exacto aplicado)
- `in_27`/`in_28` = DEX actual / DEX hace ~6min (float)
- `in_29`/`in_30` = Vanna actual / Vanna hace ~6min (float)

`gamma_daemon/index.js` mantiene el historial corto (`history.json`, posicional —
"hace 3 ciclos", no por timestamp real) para calcular los valores "hace ~6min";
no hace falta ningún cálculo adicional fuera del daemon.

`input.bool`/`input.float` en esta versión de Pine NO aceptan parámetro `id=`
explícito (da error de compilación) — los IDs son posicionales (`in_N`), así que
si se vuelve a abrir `pine_set_source` y se reordenan/agregan inputs ANTES de la
sección de Gamma, hay que volver a verificar el mapeo. Forma de verificar: llamar
`indicator_set_inputs` con los valores nuevos y luego `ui_find_element` con
`query="CIARG_V1"` `strategy="text"` — el texto completo de la fila del legend
lista los valores de todos los inputs en orden; confirmar que los 3 números
esperados aparecen ahí antes de dar por buena la actualización.

**Colores fijos pedidos por el usuario** (no cambiar sin que lo pida): Call Wall =
verde (`color.green`), Put Wall = rojo (`color.red`), Gamma Flip = violeta
(`color.purple`), MVS = naranja (`color.orange`, elegido por el asistente ya que
el usuario no especificó color para este nivel — se puede cambiar si lo pide).

**Alcance: SOLO SPX, no otros activos.** El usuario tiene un plan de TradingView
("Essential") limitado a 2 charts por tab, y los 2 paneles que controlamos están
sincronizados por símbolo entre sí (no hay forma encontrada de desactivar ese
sync). Además, la pestaña/ventana de SPY del usuario vive en un target de CDP
distinto al que este MCP controla — no se ha logrado alcanzarla (se probó
cambio de tab vía la app, clics nativos de Windows, reinicio completo de
TradingView; siempre se termina reconectado al mismo target de SPX). Por lo
tanto:
- El loop de refresco de 2 min **NUNCA debe tocar** paneles/tabs que no sean los
  2 confirmados de SPX (siempre verificar `pane_list` y el símbolo antes de
  `indicator_set_inputs`).
- Cualquier OTRA instancia de CIARG_V1 en otros charts del usuario (ej. su
  pestaña de SPY) queda con los valores de Gamma **congelados en escala SPX**
  (~7500) porque nuestro loop nunca la actualiza — esto distorsiona la imagen
  visualmente en activos de otra escala (SPY ronda ~750, 10x menos). La
  solución NO es tratar de alcanzar esa pestaña — es que el usuario mismo
  desactive el toggle "Mostrar niveles Gamma" (grupo "Bitácora — Niveles Gamma
  (Sigma Terminal)" en la configuración del indicador) en cualquier chart que no
  sea SPX. Si el usuario reporta distorsión en otro activo, esa es la causa y
  esa es la solución — no intentar automatizarlo de nuevo hasta que se resuelva
  la limitación de plan o se encuentre el toggle de sync entre paneles.

**Dos paneles a actualizar, NO uno solo**: el usuario tiene un layout "2
horizontal" con pane 0 = SPX 2 minutos y pane 1 = SPX 15 minutos. CIARG_V1 está
cargado en AMBOS. Los valores de los inputs son **por instancia/pane**, no
compartidos — hay que actualizar los dos. El entity_id que reportan las tools
(`t6hIQp` al momento de escribir esto) es el MISMO string para ambos paneles (es
un id posicional/por-nombre-de-estudio, no por instancia real), así que la forma
de dirigirte a un pane específico es con `pane_focus(index)` ANTES de llamar
`indicator_set_inputs` — no hay otra forma de diferenciarlos. Verificar
`pane_list` al iniciar sesión por si el usuario cambió el layout (más paneles,
otro symbol, etc.) antes de asumir que siguen siendo solo estos 2.

⚠️ Cuidado: en esta misma sesión, al hacer pruebas de `chart_set_timeframe` para
el marco semanal/diario del Paso 1, sin querer se cambió el timeframe del pane
que estaba activo en ese momento (pane 1) de 15m a 1D. Si vas a tocar
`chart_set_timeframe` para revisar semanal/diario, hazlo en un layout/pestaña
aparte si es posible, o como mínimo anota la resolución original de cada pane
ANTES de tocarla (via `pane_list`) y restáurala al terminar.

⚠️ **Guard de horario (regla acordada con el usuario, redocumentada 2026-07-21 —
se había hablado semanas antes pero nunca quedó escrita, y el loop estuvo
corriendo toda una noche sin sentido hasta que el usuario lo señaló):** el dato
de Sigma Terminal solo vale la pena refrescarlo desde **30 minutos antes de la
apertura hasta 5 minutos después del cierre** — ventana **09:00-16:05 ET**,
de lunes a viernes. Fuera de esa ventana (noche, fin de semana, feriado NYSE)
**saltar el ciclo completo de inmediato, sin tocar ni Sigma Terminal ni
TradingView** — no hay dato nuevo que valga la pena traer.

🚨 **NO usar `TZ=America/New_York date` en esta máquina (2026-08-31).** El Git Bash
de aquí no trae base de datos de zonas horarias: **ignora el `TZ` en silencio** y
devuelve UTC, etiquetado además como `GMT`. Comprobado en vivo — con las 13:54 ET
reales, `TZ=America/New_York date` respondió `17:54 GMT`. Un guard de horario
construido sobre eso está **cuatro o cinco horas corrido** (según la temporada) y
daría "fuera de ventana" en plena sesión, o al revés. Es un fallo mudo: no hay
error, solo la hora equivocada. Usar Python, que sí resuelve DST:
```bash
python -c "import datetime,zoneinfo; print(datetime.datetime.now(zoneinfo.ZoneInfo('America/New_York')).strftime('%u %H:%M %Z'))"
```
(en PowerShell, `[System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId`, que es lo
que el gate ya usa correctamente). Día 6/7 o fuera de 09:00-16:05 → salir.

Para los **feriados NYSE** (que caen en día de semana pero sin mercado) ya no hay que
adivinar ni fiarse del indicador de Sigma: desde el 2026-09-06 hay un calendario
compartido, y la respuesta es una sola línea desde cualquiera de los dos lados —

```powershell
. "C:\Users\gcarv\bitacora-tasty\scripts\calendario_nyse.ps1"; Get-MotivoCierreNYSE
```
```bash
node -e "console.log(require('C:/Users/gcarv/bitacora-tasty/src/calendario_nyse').motivoCierre())"
```

Devuelve `null` si hay mercado, o `fin_de_semana` / `feriado`. Ver gotcha 12 de
`bitacora-tasty/CLAUDE.md`. Cuando el guard salta, responder con una línea
breve ("fuera de horario, sin acción"), no repetir la explicación completa
cada vez que corre.

**Ciclo de refresco** (cadencia pedida por el usuario: cada ~2 minutos mientras
esté operando, y SOLO dentro de la ventana de horario de arriba — esto es lo
más importante de configurar, NO dejar a medias):
1. `read_page` sobre la pestaña de Sigma Terminal → extraer Call Wall, Put Wall,
   Gamma Flip, MVS (buscar los `generic` con esos textos exactos en el árbol).
2. ANTES de tocar nada, llamar `pane_list` y anotar la resolución de cada pane
   SPX confirmado (normalmente pane 0 = "2", pane 1 = "15").
3. Para CADA pane: `pane_focus(index)` → `indicator_set_inputs(entity_id="t6hIQp",
   inputs='{"in_20":true,"in_21":<call_wall>,"in_22":<put_wall>,"in_23":<gamma_flip>,"in_24":<mvs>}')`.
   Nada más — no hace falta ningún paso de refresco/toggle adicional (ver nota
   de "Resuelto 13 jul 2026" arriba: se quitó el offset de las etiquetas, que
   era la causa del desfase).
4. ⚠️⚠️ **SUPERADO (2026-07-20) — el loop ahora SÍ toca los 2 paneles, a pedido
   explícito del usuario** ("los dos paneles deben mostrarme siempre lo mismo,
   es lo natural"). La restricción de "solo pane 0" del 13-jul quedó
   documentada abajo como historial, no como regla vigente — release notes:
   - Se probó en vivo `pane_focus(0)` → inputs → `pane_focus(1)` → inputs (sin
     tocar `chart_set_timeframe` en ningún momento) y las resoluciones de
     ambos paneles se mantuvieron intactas (2 y 30 respectivamente) — el
     arrastre de resolución del 13-jul parece haber sido específico a mezclar
     `chart_set_timeframe` con el loop, no a `indicator_set_inputs` por sí
     solo. Igual, **si el usuario reporta que la resolución de un pane le
     cambia sola, avisarle de inmediato y volver al modo solo-pane-0**
     (revertir esta decisión, no asumir que fue casualidad).
   - Historial (13 jul 2026, ya no vigente): se había confirmado que
     actualizar los 2 paneles en el mismo ciclo causaba que la resolución de
     un pane se propagara al otro — el motivo real pudo haber sido que ese
     ciclo SÍ mezclaba pasos de `chart_set_timeframe` (Paso 1 del skill,
     revisión semanal/diario) con el loop corriendo en paralelo, no
     necesariamente el loop en sí.
   - NUNCA llamar `chart_set_timeframe` desde el loop, en ningún pane, bajo
     ninguna circunstancia — ni para "corregir" nada. Esto sigue vigente sin
     cambios.
   - **Timing/race conditions**: en pruebas en vivo, un `pane_focus(0)`
     seguido de `chart_get_state` a veces devolvió el estado del pane
     equivocado (probablemente porque el usuario estaba navegando/clickeando
     al mismo tiempo) — el síntoma es un error "There is no such study" al
     intentar `indicator_set_inputs` con un `entity_id` que en realidad sigue
     existiendo. Mitigación: reintentar `pane_focus` + `chart_get_state` una
     vez antes de asumir que el estudio realmente desapareció.
5. ⚠️ **Guard de símbolo (2026-07-20, agregado tras incidente real; autocorrección
   agregada 2026-07-29)**: la pestaña de Sigma Terminal puede cambiar de
   símbolo (el usuario la usó para mirar SPY en medio de la sesión) — si el
   loop no lo detecta, empuja niveles de SPY (escala ~$744) al indicador de
   SPX (escala ~$7500), rompiendo por completo la visualización. Antes de
   extraer Call Wall/Put Wall/Gamma Flip/MVS, **leer también el botón de
   símbolo junto al precio** (arriba a la izquierda de la tarjeta "Greeks
   Exposure", `generic` con texto tipo "SPX $7,470" o "SPY $744") y confirmar
   que dice "SPX".

   **Ya NO se limita a saltar el ciclo y avisar** — el usuario dejó explícito
   el 2026-07-29 que entra a mirar otros símbolos en Sigma Terminal sin avisar
   con cierta frecuencia, así que exigirle acordarse de volver a SPX no es
   realista. El ciclo ahora se **autocorrige**: clic en el botón de símbolo (el
   correcto, arriba-izquierda de la tarjeta — NO el buscador global de la
   navbar superior, que es un elemento distinto y no sirve para esto) → se abre
   un dropdown con una lista "FAVORITOS" que ya trae "SPX · S&P 500 Index" como
   primera fila → clic ahí → esperar ~2s → releer para confirmar. Solo si esa
   corrección falla (símbolo sigue sin ser SPX tras el intento) se saltea el
   ciclo sin empujar nada. Confirmado funcionando en vivo el 2026-07-29 (ver
   `run_gamma_refresh.ps1`, que es la implementación real de este ciclo en
   producción — este SKILL.md documenta la lógica, el `.ps1` es la fuente de
   verdad operativa).

   **Límite conocido, sin resolver — el mismo problema pero del lado de
   TradingView es MÁS grave y no tiene autocorrección todavía**: si en
   TradingView Desktop se abre una pestaña/ventana nueva con otro símbolo (ej.
   SPY) y se deja abierta, la conexión CDP del MCP se puede quedar pegada a esa
   ventana en vez de la de SPX — a diferencia de Sigma Terminal, esto **no se
   pudo arreglar de forma confiable con la API** (se probaron 3 métodos
   distintos el 2026-07-29: `tab_switch` repetido, relanzar TradingView.exe
   completo, y `tab_close` sobre la pestaña conectada — ninguno destrabó la
   conexión; lo único que funcionó fue que el usuario cerrara la ventana de SPY
   a mano). Mientras no se investigue más a fondo (posible bug del propio MCP
   server de tradingview-mcp cacheando el target CDP), la mitigación es de
   comportamiento, no de código: pedirle al usuario evitar abrir pestañas/
   ventanas NUEVAS en TradingView Desktop con un símbolo distinto de SPX — mirar
   otro símbolo cambiándolo en el mismo panel existente (y volviendo a SPX
   después) no tiene este riesgo, solo abrir una ventana nueva lo tiene. Si el
   loop detecta `chart_symbol` distinto de `SPCFD:SPX` tras un `tab_switch`, que
   termine avisando en vez de seguir insistiendo (ver Paso 0 más arriba, mismo
   criterio ya documentado ahí).
6. Repetir cada ~2 minutos mientras el usuario esté en sesión de trading. Usar el
   skill `/loop` con intervalo de 2 minutos ejecutando este ciclo — se detiene
   cuando el usuario lo pida o cuando termine su sesión de trading, no queda
   corriendo indefinidamente de fondo sin que el usuario lo sepa.

Nota de higiene: Pine Editor puede quedar abierto como panel lateral en la app de
TradingView tras editar — cerrarlo al terminar (`ui_open_panel action=close
panel=pine-editor`) para no dejar la UI del usuario en un estado raro.

✅ **Resuelto (13 jul 2026): se quitó el offset de las etiquetas.** Ver nota en
"Graficar Call Wall / Put Wall / Gamma Flip / MVS EN VIVO" (arriba, Paso 3) —
las etiquetas volvieron a `bar_index` (sin offset), lo que eliminó el desfase
línea/etiqueta de raíz. Ya NO hace falta ningún paso de `indicator_toggle_visibility`
en el loop; el ciclo de 2 min es simple otra vez (leer Sigma Terminal →
`pane_focus(0)` → `indicator_set_inputs`, nada más).

## Paso 3bis — Día de vencimiento mensual (OPEX): imantación al Max Pain (2026-08-21, nuevo)

Pedido explícito del usuario el 2026-08-21 (que era él mismo un 3er viernes): en los días
de vencimiento **el Max Pain deja de ser un dato de adorno y pasa a ser un eje del
análisis**. La teoría que hay que evaluar con fuerza es la de la **imantación**: que al
cierre de los contratos el precio tiende a ser atraído hacia el strike de Max Pain, porque
es el nivel donde vence sin valor la mayor cantidad de primas, y los dealers que están
cortos esas opciones tienen el incentivo (y, vía cobertura de gamma, el mecanismo) para
que el precio termine ahí.

Hasta el 2026-08-21 el Max Pain aparecía UNA sola vez en todo este skill — como un valor
más de la lista de "bonus disponible" del Paso 3. No tenía ningún papel analítico.

### Cómo saber si hoy es día de vencimiento

Regla general (usar esta, no la lista): **el vencimiento mensual de opciones es el 3er
viernes del mes**. Si ese 3er viernes es feriado NYSE, el vencimiento se corre al **jueves
anterior** — no es hipotético: el 3er viernes de junio de 2026 fue el 19, que es Juneteenth
y está en `bitacora-tasty/src/calendario_nyse.json`, el calendario único del sistema (hasta
el 2026-09-06 el gate tenía su propia lista copiada a mano; ver gotcha 12 de `CLAUDE.md`).

Terceros viernes de 2026, calculados y verificados el 2026-08-21:

| Fecha | Tipo |
|---|---|
| 2026-01-16, 02-20, 04-17, 05-15, 07-17 | mensual (ya pasaron) |
| 2026-03-20, 06-19 | trimestral — **06-19 cayó en Juneteenth**, corrió al jueves 18 |
| **2026-08-21** | mensual — el día en que se escribió esta sección |
| **2026-09-18** | **trimestral** (quad witching) |
| **2026-10-16** | mensual |
| **2026-11-20** | mensual |
| **2026-12-18** | **trimestral** (quad witching) |

Los trimestrales (marzo, junio, septiembre, diciembre) vencen índices, futuros y opciones a
la vez — el interés abierto es mucho mayor y, si la imantación existe, ahí debería verse
más fuerte que en un mensual común. Anotar siempre cuál de los dos es.

### Qué hacer en el premercado de un día así

1. **Poner la distancia al Max Pain al frente**, junto al precio de apertura implícita:
   cuántos puntos y qué % separan al precio del Max Pain, y **en qué dirección** habría que
   moverse para llegar. Ese número es el que hay que mirar todo el día.
2. **Comparar Max Pain con Gamma Flip, Call Wall y Put Wall.** El caso interesante es
   cuando el Max Pain cae DENTRO del corredor Put Wall–Call Wall: ahí la imantación y los
   muros empujan para el mismo lado y el escenario Neutral se refuerza. Si el Max Pain
   queda FUERA del corredor, las dos fuerzas se contradicen — decirlo explícitamente en
   vez de promediarlas.
3. **El régimen de gamma manda sobre la teoría.** La imantación necesita dealers en gamma
   POSITIVO (venden fuerza, compran debilidad: eso es lo que fija el precio). Con **gamma
   negativo la teoría se debilita mucho** — los dealers amplifican el movimiento en vez de
   amortiguarlo. Nunca invocar la imantación sin decir en qué régimen estamos.
4. **Escribirlo como escenario, no como profecía**: qué tendría que pasar para que el
   precio termine pegado al Max Pain, y qué lo invalidaría (típicamente: romper y sostener
   un muro, o una noticia macro que domine la sesión).

### Factor 6 del scorecard, SOLO en días de vencimiento

El Paso 6.1 fija 5 factores y exige anotar explícitamente cualquier alta o baja. Esta es
esa anotación: **en días de vencimiento se agrega un 6º factor, "Imantación al Max Pain"**,
y el resto del año el scorecard sigue teniendo 5. Marcar en la entrada del log
`factores: 6` para que las comparaciones históricas no mezclen manzanas con peras.

Cómo puntuarlo (0-10 por escenario):
- **Neutral** se lleva el score alto cuando el Max Pain está cerca del precio (menos de
  ~0,3%), el gamma es positivo y el Max Pain cae dentro del corredor de muros.
- **Alcista / Bajista** se llevan el score alto cuando el Max Pain está claramente por
  encima / por debajo del precio: ahí la imantación, si opera, empuja en esa dirección.
- Con **gamma negativo, ningún escenario pasa de 4 en este factor** — la teoría no tiene el
  mecanismo que la sostiene.

### Y ahora la parte incómoda: medirla, no creerle

La imantación al Max Pain es una teoría muy repetida y con evidencia empírica mixta — hay
estudios en ambos sentidos, y buena parte del efecto que se le atribuye se explica igual de
bien por el gamma positivo, que ocurre a la vez. Así que se incorpora al análisis como pide
el usuario, **y al mismo tiempo se instrumenta para poder desmentirla con sus propios
datos**, que es la única forma de que en diciembre esto valga algo.

En cada día de vencimiento, agregar al objeto de esa fecha en
`premercado_hipotesis_log.json` un bloque `max_pain`:

```json
"max_pain": {
  "es_vencimiento": true,
  "tipo": "mensual",
  "trimestral": false,
  "max_pain": 7675.0,
  "gamma_regime": "MIXTO",
  "gamma_regime_nota": "NEGATIVO en el spot de cierre (7.641), POSITIVO si abre sobre el Flip 7.673",
  "dentro_del_corredor": true,
  "corredor": "7640-7700 (Put Wall - Call Wall)",
  "precio_apertura": 7682.74,
  "precio_apertura_nota": "apertura IMPLICITA desde ES=F al momento del premercado, no la apertura real de la campana; el postmercado la reemplaza por la real al completar los campos de cierre",
  "distancia_apertura_pts": 7.74,
  "distancia_apertura_pct": 0.101,
  "direccion_para_converger": "BAJAR",
  "cierre_real": null,
  "distancia_cierre_pts": null,
  "distancia_cierre_pct": null,
  "convergio": null
}
```

Este es el bloque real de la entrada `2026-08-21`, no un ejemplo inventado — copiar esa
forma. Tres campos merecen atención:

- **`gamma_regime` admite `"MIXTO"`.** El 21-ago el régimen era negativo en el cierre
  previo (7.641) y pasaba a positivo si el precio abría sobre el Flip (7.673), que es
  justo lo que pasó. Forzar un único valor ahí habría falseado la evidencia del día más
  informativo de la serie. Cuando sea MIXTO, el `gamma_regime_nota` explica de qué lado
  cayó.
- **`precio_apertura` es la apertura IMPLÍCITA** que se conocía en el premercado, no la
  real de la campana. El Paso 8 la reemplaza por la real al cerrar los campos — si no, se
  estaría midiendo la convergencia contra un número que nunca existió.
- **`direccion_para_converger`** (`SUBIR` / `BAJAR` / `YA ESTA`) evita tener que
  reinterpretar el signo de la distancia cada vez que se lee el log.

Los cuatro últimos campos los completa el **Paso 8 (postmercado)**. `convergio` es `true`
si la distancia al cierre resultó MENOR que la de la apertura — o sea, si el precio
efectivamente se acercó al Max Pain durante la sesión.

**Al cuarto día de vencimiento registrado (o sea, a partir del 2026-12-18), reportar el
acumulado**: en cuántos de ellos convergió, cuánto se acercó en promedio, y si la
diferencia entre los días de gamma positivo y los de gamma negativo se sostiene. Si el
saldo dice que la teoría no aguanta con los datos del usuario, **decirlo tal cual y bajarle
el peso al factor 6** — no maquillarlo. Es exactamente el mismo criterio que ya rige para
los backtests en este proyecto.

## Paso 4 — Estructura Intradía y Futuros

- Timeframes 30/15/2 minutos: `chart_set_timeframe` a `"30"`, `"15"`, `"2"`.
- **POC de 30 minutos**: elemento propio, DISTINTO del POC diario/semanal. Se lee
  en la transición del análisis diario hacia el intradía. En TradingView, el
  indicador "Reditum Sniper Ultra" ya lo trae listo como campo **"30 POC"** dentro
  de `data_get_study_values` (también trae 60/120/240 POC) — no hay que calcularlo
  a mano. Sirve para:
  - Validar zonas de confluencia intradía junto con la línea de tendencia del
    algoritmo y las EMAs (ejemplo real: *"esas confluencias de soporte... se daban
    uno por el POC de 30 minutos... la línea de tendencia... las EMAs como
    confluencia"*).
  - Detectar cambio de tendencia de corto plazo: *"si rompía este POC podía haber
    un cambio de tendencia en el intradía"* — romper el POC de 30min hacia abajo
    (con gamma negativo) suele confirmar el cambio a bajista intradía.
- **Sin TradingView Desktop (CDP caído), vía TradingView Web + Chrome (2026-07-30, nuevo)**: si el MCP de
  TradingView no conecta pero el usuario tiene el mismo layout abierto en `https://www.tradingview.com/chart/<chart_id>/`
  vía navegador (logueado con su cuenta, los layouts sincronizan Desktop↔Web), se puede leer TODO lo de esta
  sección igual, vía `claude-in-chrome`. La leyenda compacta de un indicador (ej. "Sniper Ultra 4 90 1 4 2 10
  normal...") solo muestra los PARÁMETROS de entrada, no los valores de salida (POC, etc.) — no sirve para esto.
  La vía que sí funciona: abrir el panel **"Object tree and data window"** (ícono en la barra lateral derecha,
  pestaña "Data Window") y ahí sí aparecen los valores reales de cada plot en la barra actual (`find` con query
  tipo "POC value numbers in Data Window panel" encuentra los pares label/valor, ej. "30 POC" → "7,385.43"). Para
  la captura del chart: colapsar de nuevo la leyenda expandida (clic en el chevron `⌄`/`^` junto al contador de
  indicadores) y limpiar el crosshair (tecla `Escape` + clic en una zona vacía del chart) ANTES de la captura,
  o queda un tooltip de precio flotante sobre la imagen.
- **Fractal intradía** (marco de 30 o 15 min): mismo concepto que el semanal/diario
  pero de corto plazo — zona de liquidez donde ya se sabe que el precio puede
  pivotear (ejemplo real: *"zona del fractal 7,450"*, usada como target/zona de
  reacción si el Call Wall se corre hacia arriba).
- **Contexto overnight/domingo — usar `OANDA:SPX500USD`, NO el índice de contado
  (2026-07-20):** `SPCFD:SPX` (y en general cualquier símbolo de índice de
  contado) solo cotiza en horario de mercado (9:30am-4pm ET) — no sirve para ver
  qué hizo el precio durante la noche o el domingo. Alejandro sí mira ese
  contexto, y el activo correcto para reproducirlo es un **CFD de S&P 500**, que
  los brokers ofrecen casi 24/5 igual que el forex. Confirmado con datos reales
  en la cuenta del usuario: `OANDA:SPX500USD` retoma cotización el **domingo a
  las 17:00 hora Bogotá (= 6:00pm ET)**, el horario clásico de apertura de
  CME Globex, y no tiene huecos entre semana (velas continuas incluso a las
  2-3am hora Bogotá) — es el feed más líquido/estándar de los candidatos
  probados (mayor volumen reportado que `VANTAGE:SP500`, que también funciona
  y ya estaba cargado en el chart del usuario antes de este hallazgo, por si
  hace falta una alternativa). Usar `OANDA:SPX500USD` para este paso; los
  futuros `CME_MINI:ES1!`/`CME_MINI:MES1!` quedan como alternativa si alguna
  vez `OANDA:SPX500USD` no está disponible.
- Clasificar la estructura en Fases 1-4 (arranque / impulso / consolidación /
  continuación) y buscar alineación entre 15m y 2m.
- Ver si el precio abre muy alejado de sus medias ("EMAs botadas"/"alejamiento") →
  anticipar toma de liquidez antes de que el movimiento sea sostenible. Regla más
  repetida por Alejandro: con alejamiento fuerte, NO tomar la dirección del
  movimiento de inmediato — esperar el regreso a las medias primero.
- **Regla de los lunes**: Alejandro advierte que el lunes es un día más volátil y
  con más "fintas de mercado" — recomienda esperar más de los 15-30 min estándar
  antes de validar entradas.
- VIX: cambiar símbolo temporalmente a `TVC:VIX`, leer con `quote_get`, y volver a
  `SPCFD:SPX` después (no dejar el chart del usuario en VIX). **Umbrales**: ~15-16
  favorece estabilidad; subiendo hacia 20 es señal de riesgo/nerviosismo creciente.

## Paso 4bis — Radar de apertura anticipada (2026-07-20, nuevo)

A pedido explícito del usuario: no basta con analizar el cierre del viernes, hay
que sumarle **dónde quedó el precio tras el movimiento overnight/dominical** para
anticipar mejor la apertura y afinar las 3 hipótesis con un dato que el propio
Alejandro no tiene (él no mira `OANDA:SPX500USD`, esto es un plus que suma la
bitácora sobre su análisis). Objetivo: sacarle jugo al hecho de que el precio ya
"practicó" los niveles de Sigma Terminal (Put Wall/Gamma Flip/Call Wall) durante
la noche, antes de que abra el mercado de contado.

Procedimiento (usar `OANDA:SPX500USD`, ver Paso 4 arriba — YA debe estar
confirmado como símbolo con datos reales antes de este paso):
1. `data_get_ohlcv` con `count` suficiente para cubrir desde la apertura
   dominical (domingo 6pm ET) hasta el momento actual — en 15m, ~100 velas
   alcanzan de sobra. Filtrar los bars con `time >= timestamp de la apertura
   dominical` (se reconoce por el salto grande en `time` tras el último bar del
   viernes ~3pm hora Bogotá — ver Paso 4 sobre el hueco de fin de semana).
2. Calcular de ese subconjunto: **apertura dominical** (primer bar), **máximo y
   mínimo overnight**, y **precio actual** (`quote_get` o último bar). Comparar
   los tres contra el cierre de contado del viernes (`SPCFD:SPX` o el último
   daily bar) para dimensionar el gap real.
3. Cruzar el rango overnight (máx/mín) contra los niveles de Sigma Terminal ya
   leídos en el Paso 3 (Put Wall/Gamma Flip/Call Wall) — señalar explícitamente
   si el overnight ya tocó/rompió alguno de esos niveles (ej. "el mínimo
   overnight rozó el Put Wall y rebotó", "el máximo overnight perforó el Call
   Wall sin sostenerse"). Esto es la parte de más valor: le dice al trader qué
   niveles YA fueron puestos a prueba antes de que abra el mercado real.
4. Usar esta lectura para **afinar, no reemplazar**, los 3 escenarios del Paso 5
   — el escenario alcista/bajista/neutral debe explicitar en su condición de
   activación qué hizo el precio overnight (ej. "confirma el impulso que ya
   insinuó el spike de la madrugada" en vez de solo "rompe el Call Wall").

Ejemplo real (2026-07-20, ver documento del día): apertura dominical 7,460.80
(+3.11 vs. cierre de contado del viernes, gap casi nulo); mínimo overnight
7,448.60 tocando el Put Wall (7,450) justo al abrir el domingo y rebotando en la
misma vela; máximo overnight 7,511.80 a las 6:30am hora Bogotá perforando
brevemente el Call Wall (7,500) sin sostenerse; precio ~45 min antes de la
apertura de NY: 7,490.60, asentado entre el Gamma Flip (7,484) y el Call Wall
(7,500).

Nota: `SPX500USD`/`SP500` (cualquier variante de broker) es un **CFD**, no el
índice de contado — puede tener pequeñas diferencias de precio absoluto frente a
`SPCFD:SPX` (spread del broker, fees de financiamiento overnight) que no afectan
la lectura de niveles relativos pero sí pueden generar una diferencia de unos
pocos puntos al comparar "gap vs. cierre del viernes". No es un error, es
inherente a usar un CFD como proxy — no tratar de reconciliar el precio exacto
entre ambos símbolos.

## Paso 4ter — Capa de catalizadores: calendario económico (2026-08-21, nuevo)

Pedido del usuario el 2026-08-21: incorporar las noticias que "alborotan" el mercado, para
tener identificados de antemano los momentos en que el precio se mueve por un dato y no por
la estructura técnica. Hasta ese día el premercado no miraba el calendario económico en
absoluto — un dato de alto impacto a media sesión llegaba como sorpresa.

### El filtro: SOLO alto impacto (3 toros) + discursos Fed

⚠️ **Cambiado el 2026-08-25 por decisión explícita de Guillermo** — reemplaza el criterio
más amplio que rigió del 21 al 25 de agosto. Motivo: la tabla se estaba llenando de
eventos que él no usa para decidir nada. El caso que lo detonó fue el informe del
25-ago, con **siete filas** de las cuales solo dos importaban (los dos datos de 3 toros
de las 10:00); las otras cinco eran una subasta de T-Note, dos datos de 2 toros ya
publicados antes de la apertura, y un Richmond de 2 toros. Ruido que compite por
atención con lo que sí mueve el precio.

El criterio vigente es:

1. **Todo evento de 3 toros de EE.UU.**, sin excepción, esté donde esté en el día.
2. **Discursos y comparecencias sin calificación fija** — Presidente, miembros de la Fed,
   Tesoro. Investing no les pone toros porque el impacto depende de lo que digan, y son
   precisamente los que producen los movimientos que no estaban en ningún plan. Esta es
   la única excepción a la regla de los 3 toros, y existe porque estos eventos **no
   tienen toros por definición**, no porque tengan pocos.
3. **Todo lo demás se descarta**: 2 toros (aunque caiga dentro de la ventana operativa),
   1 toro, subastas de deuda, inventarios. No van a la tabla ni al log.

**Si no hay ningún evento que pase el filtro, escribir "Sin catalizadores programados"** —
es información, y es el resultado esperado en muchos días. No rellenar con eventos
menores para que la tabla no quede vacía; una tabla vacía es exactamente la señal de que
hoy manda la estructura técnica y no el calendario.

#### El caso en contra, registrado a propósito

Esta decisión tiene un costo conocido y conviene no olvidarlo. **El 21-ago-2026 no hubo
NINGÚN evento de 3 toros en EE.UU.**, y sin embargo los PMI flash — que Investing
califica con **2 toros** — salían a las 09:45 ET, quince minutos después de la apertura,
justo encima del rango y dentro de un corsé de 26 puntos. Con el filtro vigente ese día
el informe diría "sin catalizadores programados" y el PMI llegaría por sorpresa.

Se le ofreció a Guillermo la variante que cubría ese caso (3 toros siempre, más los de 2
toros solo dentro de 09:30–10:30) y **la descartó a favor del filtro estricto**. Es su
decisión y está tomada con el contraejemplo delante — no reabrirla por iniciativa propia.
Lo que sí corresponde: **si alguna vez un dato de 2 toros descoloca la sesión y el
informe no lo había mencionado, anotarlo en el postmercado de ese día** y acumular esos
casos. Si aparecen varios, ahí sí vale traerle la evidencia para que reconsidere.

### Cómo traerlo

`WebFetch` sobre `https://es.investing.com/economic-calendar/`, pidiendo los eventos de
EE.UU. de la fecha con importancia, pronóstico y previo.

⚠️ **Los HORARIOS no vienen en el HTML estático** (verificado el 21-ago-2026: el fetch
devuelve nombre, toros, pronóstico y previo, pero la columna de hora llega vacía porque se
puebla por JavaScript). Hay que confirmarlos aparte — por horario conocido del dato (flash
PMI 09:45 ET, CPI/PPI/nóminas 08:30 ET, ISM 10:00 ET, minutas de la Fed 14:00 ET) o con una
segunda fuente. **Nunca inventar la hora**: si no se pudo confirmar, escribir "hora sin
confirmar" en el documento, porque el valor entero de este paso está en saber CUÁNDO.

### Clasificar por ventana, que es lo que cambia la lectura

| Ventana | Qué significa |
|---|---|
| **Antes de 09:30 ET** | Ya está en el gap. Afecta la apertura implícita, que el Paso 4bis ya captura |
| **09:30–10:30 ET** | **La más peligrosa.** Choca con el rango de apertura y con la regla del cóndor de las 10:00 |
| **10:30–15:00 ET** | Rompe la sesión en dos: la estructura de la mañana puede no valer para la tarde |
| **Después de 16:00 ET** | No es riesgo del día: es riesgo de gap para la sesión siguiente. Decirlo así |

### Cómo se cruza con el resto del análisis

- **Régimen gamma.** Con gamma POSITIVO los dealers absorben la sorpresa; con gamma
  NEGATIVO la amplifican. El mismo dato produce dos días distintos según de qué lado del
  Gamma Flip esté el precio cuando sale.
- **Días de vencimiento (Paso 3bis).** Un catalizador dentro de la sesión es la principal
  causa de que la imantación al Max Pain NO se cumpla — domina la estructura de opciones.
  En un día de vencimiento con dato de alto impacto en sesión, **el factor 6 no pasa de 5**
  aunque todo lo demás lo favorezca, y hay que decir explícitamente que el dato es el
  riesgo principal de esa tesis.
- **Regla del cóndor.** Si hay una publicación entre 09:30 y 10:00, la prohibición de
  cóndor antes de las 10:00 deja de ser una regla de horario y pasa a ser una regla de
  evento: **no abrir hasta que el dato esté publicado y digerido**, aunque sean las 10:05.

### El punto que no hay que confundir: varianza no es dirección

Un dato **cuyo resultado todavía no se conoce** no vota por una dirección — vota por
**varianza**. No hay forma de saber si el PMI sale mejor o peor, así que sería falsear el
análisis usarlo para subir el Alcista o el Bajista.

Por eso **NO se agrega como factor del scorecard**. Lo que hace es **bajar el escenario
Neutral**: un catalizador de resultado desconocido dentro de la sesión reduce la
probabilidad de un día de rango tranquilo. Se aplica como ajuste explícito sobre el
Neutral, anotado en las notas de la entrada del log, no como un sexto (o séptimo) factor.

La excepción es un dato **ya publicado** antes de escribir el informe: ahí sí se conoce el
resultado y la sorpresa vs. pronóstico es evidencia direccional legítima, que entra por el
factor de momentum intradía.

### En el documento del día

Tabla **"Catalizadores del día"** justo después del Termómetro, con columnas:
`Hora ET | Evento | Importancia | Pronóstico | Previo | Ventana`. Debajo, dos o tres frases
sobre cuál es el que de verdad importa y qué le hace a los 3 escenarios. Si no hay ningún
evento que pase el filtro, escribir **"Sin catalizadores programados"** de forma explícita
— es información, no una sección para omitir.

En `premercado_hipotesis_log.json`, bloque `catalizadores` de esa fecha:

```json
"catalizadores": [
  {"hora_et": "10:00", "evento": "Confianza del Consumidor CB (Ago)",
   "toros": 3, "pronostico": 90.3, "previo": 90.8, "ventana": "09:30-10:30",
   "hora_confirmada": true},
  {"hora_et": "10:00", "evento": "Ventas de viviendas nuevas (Jul)",
   "toros": 3, "pronostico": 620, "previo": 628, "ventana": "09:30-10:30",
   "hora_confirmada": true},
  {"hora_et": "19:00", "evento": "Declaraciones de Trump", "toros": null,
   "pronostico": null, "previo": null, "ventana": "post-cierre",
   "hora_confirmada": false}
],
"ajuste_neutral_por_catalizador": -4
```

Los únicos `toros` que pueden aparecer en este bloque son **`3`** y **`null`** (los
discursos). Un `2` en este campo significa que el filtro se aplicó mal — ver la sección
del filtro más arriba.

El `ajuste_neutral_por_catalizador` es el descuento en puntos porcentuales que se le aplicó
al Neutral por el punto anterior. Guardarlo permite revisar más adelante si el descuento
estuvo bien calibrado, igual que se hace con los pesos del scorecard.

## Paso 5 — Los 3 Escenarios (SIEMPRE el cierre del documento)

Todo gira en torno a: **¿qué hace el gap de apertura?** (¿se sostiene, se cierra, o
rompe hacia abajo?). Estructurar exactamente así, con niveles concretos (no vagos):

1. **Alcista — "Gap and Go"**
   Condición: sostiene el gap alcista y rompe clústeres de resistencia inmediatos.
   Target: Call Wall (si hay dato) o techo del canal semanal.
   Validación: régimen gamma positivo si hay dato.

2. **Bajista — "Ruptura de niveles / cierre de gap"**
   Condición: cierra el gap y rompe POC + EMA50 diarios.
   Target: Put Wall (si hay dato) o mínimos/zonas de liquidez previas.
   Acción de portafolio: si se confirma, considerar neutralizar deltas / coberturas.

3. **Neutral — "Consolidación / Iron Condor"**
   Condición: precio atrapado entre clústeres (techo y piso confirmados), régimen
   gamma positivo (si hay dato).
   Estrategia: Iron Condor solo si el rango está confirmado por rechazo en ambos
   extremos y gamma flip está lejos del precio. **Timing: Alejandro arma el Iron
   Condor a partir de las 10:00 AM**, no antes (deja que pase la apertura/fintas
   iniciales y se confirme el rango).
   Advertencia: nunca armar condor en gamma negativo.

Cada escenario debe llevar: condición de activación (ligada al gap), nivel de
invalidación (stop), y target de precio concreto.

**Principio de confluencia** (el objetivo final de todo el análisis): cuando el
POC, una EMA y un muro de Gamma coinciden en el mismo nivel de precio, esa zona
tiene la mayor probabilidad de reacción — señalar explícitamente en el documento
si se detecta una confluencia así (ej. el 13 de julio: W POC 7,504.58 + D POC
7,509.82 + Daily Fast MA 7,497.62 formaron una zona de soporte apretada
7,497-7,510 — vale la pena nombrar este tipo de agrupación cuando aparezca).

## Paso 5ter — Bloque `escenarios` legible por máquina (2026-08-25, OBLIGATORIO)

A partir del 2026-08-25 el premercado no termina hasta que la entrada del día en
`premercado_hipotesis_log.json` lleva un bloque **`escenarios`** con los tres escenarios
en forma de datos, no solo en la prosa del documento.

**Por qué**: la **Estrategia Premercado** (`src/estrategia_premercado.js` en el repo
`bitacora-tasty`, familia `PREMERCADO` en la bitácora de Tradier) corre entre las 10:00 y
las 11:00 ET, compara el mercado en vivo contra estos tres escenarios y ejecuta el que
valide. Si el bloque no está, el motor devuelve `SIN_PREMERCADO` y ese día no opera. La
prosa del `.docx` no le sirve: necesita niveles.

### Contrato

```json
"escenarios": {
  "alcista": {
    "prob": 36,
    "activa":   {"tipo": "cierre_15m_sobre", "nivel": 7690},
    "invalida": {"tipo": "cierre_15m_bajo",  "nivel": 7675},
    "t1": [7696, 7700],
    "t2": [7708, 7714],
    "nota": "Call Wall 7690 + EMA10 diaria 7687,31."
  },
  "bajista": {
    "prob": 34,
    "activa":   {"tipo": "cierre_15m_bajo",  "nivel": 7662},
    "invalida": {"tipo": "cierre_15m_sobre", "nivel": 7690},
    "t1": [7657, 7662],
    "t2": [7638, 7650]
  },
  "neutral": {
    "prob": 30,
    "activa":   {"tipo": "dentro_corredor",  "min": 7662, "max": 7690},
    "invalida": {"tipo": "cierre_15m_fuera", "min": 7662, "max": 7690},
    "corredor": [7662, 7690]
  }
}
```

Tipos de condición admitidos (son los únicos que el motor entiende):
`cierre_15m_sobre` y `cierre_15m_bajo` llevan `nivel`; `dentro_corredor` y
`cierre_15m_fuera` llevan `min` y `max`.

Reglas:
- Los tres escenarios son obligatorios, con los nombres exactos `alcista`, `bajista`,
  `neutral`. Las `prob` deben sumar 100 y ser las MISMAS que van en la tabla del documento.
- Los direccionales necesitan al menos un objetivo numérico en `t1`/`t2`. El neutral no:
  no compra recorrido.
- Los niveles tienen que ser los mismos que la prosa del documento. Si la tabla dice
  "rompe 7.690" y el JSON dice 7.700, el motor opera algo que el informe no dijo.

### Validar SIEMPRE antes de dar el premercado por terminado

```bash
cd C:/Users/gcarv/bitacora-tasty && node -e "
const fs=require('fs'), {validarEscenarios}=require('./src/estrategia_premercado.js');
const L='<ruta>/premercado_hipotesis_log.json';
const e=JSON.parse(fs.readFileSync(L,'utf8')).find(x=>x.fecha==='<AAAA-MM-DD>');
const v=validarEscenarios(e);
console.log(v.ok?'escenarios OK':'ESCENARIOS INVALIDOS');
v.errores.forEach(x=>console.log(' ERROR:',x)); v.avisos.forEach(x=>console.log(' aviso:',x));
"
```

El validador atrapa lo que de verdad pasa al transcribir a mano: falta un escenario, un
tipo mal escrito, probabilidades que no suman 100, un direccional sin objetivos, y el caso
más traicionero — **un alcista que se activa cayendo** (o el nivel del alcista por debajo
del bajista), que es un error de transcripción invisible a ojo y que el motor ejecutaría
igual.

⚠️ **El colchón lo aplica el motor, no el premercado.** Escribir el nivel limpio (7.662,
no 7.659). El motor exige que el cierre lo supere por `bufferNivelPts` (3 por defecto)
antes de dar la rotura por buena. Esto salió de probar el propio 25-ago: el bajista se
activaba con un cierre de 7.661,93 contra un nivel de 7.662 —siete centésimas— y quince
minutos después el precio ya había vuelto dentro del corredor.

## Paso 5bis — Diagrama visual de los 3 escenarios (2026-07-21, nuevo)

A pedido explícito del usuario: además de la tabla de texto del Paso 5, el
documento lleva un **diagrama vertical de niveles** — un "price ladder" con los
3 escenarios coloreados (verde=alcista, gris=neutral, rojo=bajista) y los
niveles clave (Put Wall, Gamma Flip, Call Wall, MVS, spot de referencia, targets
T1/T2 de cada escenario) dibujados a escala real de precio. Corre DESPUÉS del
Paso 6 (necesita las probabilidades ya calculadas para los rótulos).

**Script**: `scripts/gen_escenarios_chart.py` (dentro de este skill) — Python +
matplotlib (ya confirmado instalado). Uso:
`python gen_escenarios_chart.py <output.png> <spec.json>` — ver el docstring del
script para el contrato completo del JSON (niveles, escenarios con prob/t1/t2,
`y_min`/`y_max` fijados a mano cubriendo todos los niveles con margen).

**Paleta y diseño** (cargar el skill `dataviz` antes de tocar esto si se va a
modificar el script — no reinventar la metodología de color): se usa el par
verde/rojo del categórico validado (no el diverging azul/rojo por defecto del
skill dataviz — acá se prioriza la convención financiera ya establecida en todo
el resto del sistema, Call Wall=verde/Put Wall=rojo, ver CIARG_V1) — este par
da un WARN de separación CVD (ΔE 7.2, banda 6-8), legal solo con **etiquetado
directo** (nunca color solo) — por eso cada zona y cada nivel lleva su propio
texto, no hay leyenda separada. Verificado con
`node scripts/validate_palette.js "#008300,#e34948" --mode light` (dentro del
skill `dataviz`).

⚠️ **Gotcha de superposición de etiquetas**: cuando un target (T1 alcista, o el
T1 bajista si coincide con MVS) cae en el mismo precio que una línea de nivel
nombrada (ej. T1 alcista 7,491-7,510 centrado casi exacto en Call Wall 7,500),
el texto del target queda tachado por la línea — el script ya compensa esto
(desplaza la etiqueta T1 alcista arriba de la banda si su centro cae a <6pts del
Call Wall; omite la etiqueta T1 bajista por completo si coincide con MVS, ya que
la etiqueta "MVS" de la derecha alcanza). Si se agregan más niveles/escenarios,
revisar visualmente el PNG generado antes de insertarlo — no asumir que no hay
overlap sin mirarlo.

**Insertar en el documento**: imagen centrada, ancho ~4.8in, ubicada
inmediatamente después del heading "Los 3 Escenarios" (antes de la tabla de
texto y del párrafo de probabilidades) — mismo patrón
`paragraph.add_run().add_picture(...)` + reubicación con `addnext()` que ya usa
este skill para las 3 capturas de chart.

## Paso 6 — Probabilidades por escenario + aprendizaje diario (2026-07-20, nuevo)

A pedido explícito del usuario: cada premercado asigna un **% de probabilidad**
a cada uno de los 3 escenarios (suman 100%), se guarda en un log persistente, y
**el premercado del día siguiente valida contra lo que pasó de verdad** — un
párrafo corto, en lenguaje simple, de por qué se acertó o no. Es un ciclo de
aprendizaje explícito: el objetivo es afinar el criterio de un día para el otro,
no solo llevar un registro histórico.

**Archivo del log**: `premercados alejandro\control premercado\
premercado_hipotesis_log.json` — array de objetos, uno por fecha. Cargar con
`json.load`/`json.dump` (Python), nunca reescribir el array completo a mano;
agregar/actualizar el objeto de la fecha correspondiente.

Esquema de cada entrada:
```json
{
  "fecha": "2026-07-20",
  "spot_referencia": 7457.69,
  "niveles_clave": {"put_wall": 7450, "call_wall": 7500, "gamma_flip": 7484, "mvs": 7400},
  "probabilidades": {"alcista": 32, "neutral": 24, "bajista": 44},
  "factores": {
    "tendencia_diaria_semanal":        {"alcista": 6, "neutral": 5, "bajista": 6},
    "momentum_intradia_15m_1h":        {"alcista": 2, "neutral": 3, "bajista": 9},
    "radar_overnight":                 {"alcista": 8, "neutral": 2, "bajista": 3},
    "regimen_gamma":                   {"alcista": 4, "neutral": 2, "bajista": 6},
    "confluencia_poc_ema_resistencia": {"alcista": 3, "neutral": 5, "bajista": 7}
  },
  "resultado": null
}
```
`resultado` empieza en `null` y se completa AL DÍA SIGUIENTE (ver más abajo) con:
`{"escenario_validado": "bajista", "cierre_real": 7XXX.XX, "acierto": "si|no|parcial",
"leccion_aprendida": "texto corto en lenguaje simple"}`.

### 6.1 — Metodología del scorecard (asignar probabilidades de HOY)

No es un número "a ojo" — se puntúa 0-10 cada uno de 5 factores, para cada uno de
los 3 escenarios, según qué tanto lo apoya la evidencia del día. Después se suma
por escenario y se normaliza a %. Los 5 factores (fijos, para poder comparar
manzanas con manzanas día a día — si algún día se agrega/quita un factor, dejarlo
anotado explícitamente en esa entrada del log):

1. **Tendencia diaria/semanal** — EMAs diarias y semanales, fase Weinstein en
   esos marcos. Da el contexto de fondo.
2. **Momentum intradía (15m/1h)** — apilamiento de EMAs cortas, GenyTrend,
   Chandelier Exit, fase Weinstein 15m. Es la señal más "fresca" de dirección.
3. **Radar overnight** (Paso 4bis) — qué hizo el precio en `OANDA:SPX500USD`
   desde la apertura dominical: ¿rebotó en el Put Wall?, ¿rechazó el Call Wall?,
   ¿dónde quedó parado justo antes de la apertura?
4. **Régimen Gamma** — no vota por una dirección per se, pero: gamma negativo
   reduce la probabilidad de un día realmente neutral/tranquilo (favorece
   movimientos violentos en la dirección que gane), así que en gamma negativo
   el score de "neutral" debe bajar en este factor casi siempre.
5. **Confluencia POC/EMA como resistencia o soporte** — si hay una zona de
   confluencia (Paso 5, "Principio de confluencia") justo encima o debajo del
   precio actual, eso pesa a favor del escenario que la usa como barrera.

6. **Imantación al Max Pain** — **SOLO en días de vencimiento mensual** (3er viernes;
   ver Paso 3bis, que define cómo puntuarlo y cómo se registra). El resto de los días
   este factor NO existe y el scorecard sigue siendo de 5. Cuando se usa, anotar
   `factores: 6` en la entrada del log de esa fecha.

Normalización: `prob_escenario = sum(score_escenario en los 5 factores, o 6 si es día
de vencimiento) /
sum(todos los scores de los 3 escenarios) × 100`, redondeado a entero. Ejemplo
real (2026-07-20): alcista 23/71→32%, neutral 17/71→24%, bajista 31/71→44%.

Este scorecard es un punto de partida explícito y auditable, NO una fórmula
"correcta" definitiva — la idea es que con el tiempo, al revisar los aciertos y
errores (6.2), se ajusten los PESOS relativos de estos factores (hoy los 5 pesan
igual, 1/5 cada uno) si se nota que alguno predice sistemáticamente mejor o peor
que los demás. Anotar cualquier cambio de peso explícitamente en el skill cuando
se decida, con la fecha y el razonamiento.

### 6.2 — Validación del día anterior (al INICIO de cada premercado nuevo)

⚠️ **Esta nota que te pones a ti mismo ya NO es la última palabra** (desde el
2026-08-24). El Auditor —el agente que del lado de la Bitácora Tasty valida lo que
otros proponen— audita también este log, porque calificarse a uno mismo es
exactamente lo que la independencia existe para impedir. Su motor
(`scripts/veredicto_premercado.py`) **no lee `acierto` para dictaminar**:
recalcula el resultado desde `probabilidades` + `escenario_validado` y después
compara. Dos consecuencias prácticas para este paso:

- **`escenario_validado` sigue siendo texto libre** — decisión de Guillermo del
  2026-08-24, junto con no reprocesar las 3 entradas de julio que ya lo usan
  (`alcista_parcial`, `alcista (intradia, revirtió...)`, `neutral (tras recorrido
  violento...)`). El Auditor las lee por prefijo y no penaliza por eso.
  **Lo único que importa: que el valor EMPIECE por `alcista`, `neutral` o
  `bajista`.** El matiz va detrás, o mejor en `leccion_aprendida`. Un valor que no
  arranque por uno de los tres no se puede leer y **ese día se cae de la muestra
  del Auditor** — que es peor que anotarlo mal, porque desaparece sin ruido.
- **No maquillar la nota.** El Auditor la recalcula igual y reporta la diferencia.
  Al 2026-08-24 coinciden 19 de 23, y las 3 que no, este skill se las puso **más
  duras** de lo que los hechos sostenían — que es el sesgo correcto a tener.

Antes de calcular las probabilidades de hoy, revisar si hay una entrada del día
hábil anterior en el log con `resultado: null`:
1. Traer el rango real de esa sesión (`data_get_ohlcv` diario de `SPCFD:SPX` o
   `OANDA:SPX500USD`, resolución 1D, la barra de esa fecha) — open, high, low,
   close.
2. Determinar cuál de los 3 escenarios se validó, comparando el cierre (y el
   camino que siguió el precio) contra los niveles/targets que se habían escrito
   ese día: ¿rompió y sostuvo el Call Wall/target alcista?, ¿rompió y sostuvo el
   Put Wall/target bajista?, ¿se quedó atrapado entre ambos sin definir?
3. Completar `resultado` en la entrada de esa fecha: `escenario_validado`,
   `cierre_real`, `acierto` (`"si"` si el escenario de MAYOR probabilidad fue el
   que se validó, `"parcial"` si se validó un escenario que no era el favorito
   pero tampoco estaba muy castigado en probabilidad, `"no"` si se validó el
   escenario menos probable de los tres).
4. Escribir un párrafo corto (2-4 frases, lenguaje simple, sin jerga innecesaria)
   explicando POR QUÉ acertamos o no — señalando qué factor(es) del scorecard
   tuvieron más o menos peso del que deberían haber tenido ese día. Este párrafo
   va tanto al campo `leccion_aprendida` del log como a una sección nueva en el
   documento del día: **"Aprendizaje del Premercado Anterior"**, ubicada
   inmediatamente después del título, ANTES de las 3 capturas de chart (es lo
   primero que se lee, a propósito, para que el aprendizaje del día anterior
   quede presente al analizar el día de hoy).
5. Si no hay entrada pendiente (ej. es la primera vez que se corre este paso, o
   el día anterior no fue día de mercado), omitir esta sección sin generar nada
   — no inventar un aprendizaje que no existe.

### 6.3 — En el documento del día

Agregar la columna **"Probabilidad"** a la tabla de "Los 3 Escenarios" (Paso 5)
con el % de cada fila, y un párrafo breve arriba de la tabla explicando en 2-3
frases el balance de factores que llevó a esos números (no hace falta reproducir
el scorecard completo en el documento — el detalle numérico vive en el JSON, el
documento lleva la lectura en lenguaje simple).

## Formato del documento final (esquema fijado 2026-07-21)

⚠️ **El usuario reescribió a mano la estructura completa del documento del
21 de julio y pidió explícitamente mantener ESE esquema para los premercados
siguientes** — no es una sugerencia, es el formato a replicar de ahora en
más. Esta sección documenta ese esquema tal cual quedó, incluyendo cosas que
a primera vista podrían parecer inconsistencias (ej. un heading truncado) —
no "corregirlas", son ediciones deliberadas del usuario.

🚨 **CRÍTICO (2026-07-30) — el documento final NUNCA debe mencionar limitaciones
técnicas, pruebas, ni el proceso de generación en sí:** durante la validación del
arreglo de plumbing de este mismo día se generó un documento con un banner de
"⚠️ DOCUMENTO DE PRUEBA" y frases tipo "no se pudo confirmar en esta prueba (falla
de permisos de la extensión de Chrome)" repartidas en varias secciones — el usuario
lo rechazó de inmediato: *"no sirve de nada poner en el informe que no pudiste ver
tradingview...esa no es respuesta"*. Regla explícita de ahora en más: si un dato
(Call Wall, POC, captura del chart, etc.) no está disponible, **conseguirlo por
otra vía antes de darlo por perdido** (ver más abajo, técnica de TradingView Web +
panel Data Window) — y si de verdad no se consigue, omitirlo en silencio con el
mismo criterio ya usado en el resto del skill ("Capa de derivados: sin datos hoy"),
nunca como una disculpa o una narración de qué falló técnicamente. El contexto de
que una corrida fue una prueba, o qué se rompió y cómo se arregló, va en el Excel
de control (columna Detalle) y/o en este SKILL.md — nunca en el cuerpo del .docx
que el usuario lee a diario. El estándar de calidad a igualar siempre es el de los
documentos anteriores: denso, con tablas de datos reales, capturas reales, sin
meta-comentario sobre el propio proceso de generación.

🚨 **CRÍTICO — bug real encontrado el 2026-07-21 al validar la automatización,
leer esto ANTES de generar/editar cualquier documento**: la primera vez que se
copió este esquema desde el documento editado a mano por el usuario, el
documento de ORIGEN todavía tenía placeholders sin llenar (`xxxxxxx`, la nota
literal "Se debe capturar el chart de 30 minutos, solamente", los 3 párrafos
de ejemplo de "Posibles trades" tal cual los escribió el usuario como
MUESTRA de estilo, y el propio texto "NOTA PARA CLAUDE: en este punto
debemos colocar..."). Una corrida automatizada real encontró el documento de
hoy ya existente, asumió que estaba completo (mismo patrón de "ya existe, no
tocar" documentado en otros lugares de este skill) y **copió esos placeholders
tal cual al documento final** en vez de reemplazarlos con análisis real — el
Postmercado (Paso 8) sí se agregó bien al final, pero todo el cuerpo del
premercado quedó con texto de plantilla, no contenido real. **Regla explícita
de ahora en más**: antes de dar un documento existente por "ya completo",
buscar CUALQUIERA de estos marcadores de plantilla sin llenar — `xxxxxxx`,
"NOTA PARA CLAUDE", o la nota literal del chart de 30 min — si aparece
cualquiera de ellos, el documento está INCOMPLETO sin importar que ya exista
o que el Postmercado ya se le haya agregado, y hay que generar el análisis
real para esas secciones (nunca copiar los ejemplos de este SKILL.md
literalmente, son solo el patrón/tono a seguir, no contenido).

Título: **Premercado SPX — [fecha en español, ej. "martes 21 de julio de 2026"]**

Justo debajo del título, una línea nueva: **"Hora de ejecución informe: [hora
real de cuando se genera el documento]"** — llenar con la hora real (ET), no
dejar el placeholder.

⚠️ Este título ya NO es la primera página del documento: desde el 2026-08-14
delante va la hoja del **Informe Gerencial**, que se agrega al final del proceso
con `scripts/gen_informe_gerencial.py` (ver sección propia más abajo). El orden
de secciones de acá sigue siendo el del cuerpo, que arranca en la hoja 2.

Secciones en este orden exacto:
1. **Feedback Premercado [día de la semana + fecha del día anterior]** (ej.
   "Feedback Premercado Lunes 20 de julio") — antes se llamaba "Aprendizaje del
   Premercado Anterior" (Paso 6.2, mismo contenido/lógica: solo si hay una
   entrada pendiente de validar en el log, si no omitir la sección entera) —
   **solo cambió el nombre del heading**, no la lógica de cuándo incluirla.
2. **Premercado [día de la semana + fecha de hoy]** — heading nuevo, actúa como
   separador visual entre el feedback del día anterior y el análisis de hoy
   (sin contenido propio debajo, solo el título).
3. **Chart 30 minutos** — ver subsección de capturas más abajo (cambió de 3
   capturas a 1 sola).
4. **Marco Semanal** (sin cambios de contenido/lógica, Paso 1).
5. **Marco Diario** (sin cambios de contenido/lógica, Paso 2).
6. **Estructura Intradía 30 Min** — antes "Intradía/Futuros/VIX" (Paso 4),
   mismo contenido (POC 30/60/120/240, momentum 15m, VIX, nota de horario),
   pero termina con una bullet nueva: **"Conclusión intradía: [síntesis de
   2-3 líneas de esta capa específica]"** — llenar con contenido real, no
   dejar el placeholder de "x" repetidas.
7. **Greeks / Gamma) - Sigma Terminal, en vivo [hora]** — antes "Capa de
   Derivados (Greeks / Gamma) - Sigma Terminal". El usuario recortó el
   heading dejando el paréntesis de cierre sin el de apertura — replicar tal
   cual quedó (no "arreglar" el paréntesis), es una edición deliberada.
   **Nota de orden**: esta sección ahora va DESPUÉS de "Estructura Intradía
   30 Min" (antes iba justo después de Marco Diario) — el orden cambió, no
   solo el nombre.
8. **Radar de Apertura Anticipada** (Paso 4bis, sin cambios de contenido).
9. **Conclusiones Los 3 Escenarios** — antes "Los 3 Escenarios" (Paso 5/6),
   mismo contenido (tabla condición/invalidación/target/probabilidad + balance
   de probabilidades + advertencias) — solo cambió el nombre del heading.
10. **Posibles trades** (sección NUEVA, ver subsección dedicada más abajo).
11. **Recordatorio de Gestión** (sin cambios).

### Chart 30 minutos (1 sola captura, ya NO son 3)

**Usar `chart_30m.png` del bundle del Recolector de datos si existe** (ver sección al
principio del skill) — ya viene en 30min con el rango de 3 días correcto, no hace falta
tocar TradingView en vivo para conseguirlo. Solo si el bundle de hoy no existe, seguir con
el procedimiento en vivo de abajo.

⚠️ **Cambio 2026-07-21, revierte la instrucción anterior**: el usuario dejó una
nota explícita en el documento ("Se debe capturar el chart de 30 minutos,
solamente") — de ahora en más es **UNA sola captura**, timeframe **30
minutos**, no las 3 de antes (Semanal/Diario/Intradía). Mostrar las etiquetas
"FRACTAL 30 MIN" y "POC 30 MIN" si están disponibles en el chart. Esa frase
es la INSTRUCCIÓN del usuario sobre cuántas capturas hacer, no texto para el
documento — bajo este heading va la imagen capturada (y opcionalmente una
línea corta de contexto), nunca la frase "se debe capturar..." como párrafo
final (bug real visto el 2026-07-21, ver el aviso 🚨 CRÍTICO más arriba).

⚠️ **Gotcha de zoom** (sigue vigente para este único chart): cambiar
`chart_set_timeframe` dispara el autoescalado por defecto de TradingView si no
se fija `chart_set_visible_range(from, to)` en timestamps unix ANTES de
capturar — usar una ventana corta, ~3 días (`from = ahora - 259200`, `to` ~ahora).
Verificar SIEMPRE con `capture_screenshot` + `Read` de la imagen antes de darla
por buena — confirmar que las velas recientes y las etiquetas de Call
Wall/Put Wall/Gamma Flip/Fractal quedaron legibles y no tapadas por la tabla
de CIARG_V1 (arriba a la derecha).

Guardar con `capture_screenshot(region="full", filename="premercado_spx_30m_<fecha>")`
(en `C:\Users\gcarv\tradingview-mcp\screenshots\`). Al terminar, restaurar el
pane usado a su timeframe original (ver nota de higiene del Paso 3) y volver a
empujar los inputs de Gamma por si el cambio de símbolo/timeframe los reseteó.

### Posibles trades (sección nueva 2026-07-21)

⚠️ **Bug real 2026-07-22, ya corregido una vez a mano**: la corrida automatizada
del 22 de julio generó bien los 3 trades reales y los niveles clave (contenido
correcto), pero dejó el párrafo de la nota de abajo **tal cual, como texto
literal en el documento final**, justo antes de los trades. Esa nota es una
instrucción **para mí** (para saber qué escribir en esta sección) — vive aquí
en el SKILL.md a propósito, para que quede documentada, pero **NUNCA debe
copiarse ni quedar como párrafo en el .docx generado** — una vez aplicada
(es decir, una vez que los 3 trades + niveles clave ya están escritos con
contenido real), ese párrafo se **BORRA** del documento, no se dice nada
parecido a "NOTA PARA CLAUDE" en el resultado final bajo ninguna circunstancia.

Nota literal del usuario (la fuente de esta instrucción, dejada aquí en el
SKILL.md para referencia futura, NO para copiar al documento): *"NOTA PARA
CLAUDE: en este punto debemos colocar los niveles mas relevantes que surjan
del analisis del premercado, los fractales y POC de 30 minutos y todo el
analisis global
que manejemos."*

Formato: 3 párrafos estilo `List Paragraph` (uno por dirección), redactados
en tono de instrucción práctica/accionable — no repetir la tabla de
escenarios, traducirla a una regla de entrada concreta. Ejemplos reales del
usuario (adaptar al análisis del día, no copiar literal):
- **Trade alcista**: *"Como en 15 minutos estamos en F2, si el precio no
  rompe los 7470, esperar en 2 min una fase 2 y entrar en trade alcista ya
  que el precio va a buscar los 7500"* — el patrón es: condición de invalidación
  a vigilar (nivel clave) + qué confirmación esperar (fase Weinstein en 2m
  después de ya tenerla en 15m) + hacia dónde va el target.
- **Trade bajista**: mismo patrón invertido (nivel que si rompe muestra
  debilidad, fase 4 en 15m y luego 2m, target).
- **Trade neutral**: condición de rango (entre qué niveles) + qué tiene que
  pasar con el régimen de gamma (ej. "se pone positivo a las X am") + la
  estrategia condicional (ej. Iron Condor) + una nota de "se requieren
  protecciones" si aplica.
Cerrar la sección incorporando explícitamente los niveles más relevantes del
día (fractales y POC de 30 min ya calculados en el Paso 4/"Estructura
Intradía 30 Min", más cualquier otro nivel del análisis global — Gamma Flip,
Call/Put Wall, POC diario/semanal) en los 3 párrafos, no como una lista aparte.

### Generar el documento Word (.docx)

El usuario guarda cada premercado como un Word en:
`premercados alejandro\documentos premercado\<MMDDAAAA>_premercado claude.docx`
(el nombre de carpeta usa el typo "premercado alejandro" del proyecto — ese SÍ
se mantiene). ⚠️ **Corregido 2026-07-21**: el nombre de archivo usaba antes el
typo "permercado" a pedido explícito del usuario en su momento — el usuario
pidió corregirlo, ahora es "premercado" (bien escrito). Los 4 documentos ya
generados (`0713`, `0716`, `0717`, `0720`) se renombraron a mano ese mismo día
para que todos sigan el patrón nuevo — si aparece algún archivo viejo con
"permercado" (typo) sin renombrar, es un caso perdido, renombrarlo también. Ojo:
la estructura de carpetas del proyecto se
reorganizó en algún momento — ya NO todo está en la raíz de `premercados
alejandro`; ahora hay subcarpetas `audios premercado`, `documentos premercado` y
`control premercado`. Verificar con `ls`/`Glob` antes de asumir rutas viejas.

Usar `python` (no `python3`) con la librería `python-docx` (ya verificado
instalado: `python -c "import docx"`). Estructura: Heading 1 (título) → Heading 2
por sección → párrafos con imagen centrada para cada chart → bullets (`List
Bullet`) para cada capa de análisis → tablas (`Light Grid Accent 1`) para
Derivados/Greeks y para los 3 Escenarios.

### Formato obligatorio del documento (fijado 2026-07-28, confirmado 2026-07-29)

⚠️ **OBLIGATORIO desde la generación inicial** — ya NO es algo que el usuario
aplica a mano después de recibir el documento (ver el punto "MUY IMPORTANTE" más
abajo, que ahora describe ediciones manuales *distintas* de esto, no el
formato base):
- **Fuente**: Tahoma, 11pt, en TODO el documento — cuerpo, bullets, tablas, Y
  los encabezados (`Heading 1`/`Heading 2` también van en Tahoma 11, no en la
  fuente/tamaño por defecto de Word para headings — misma fuente y mismo tamaño
  que el cuerpo, sin jerarquía tipográfica distinta más allá del bold que ya
  trae el estilo Heading).
- **Justificación completa** (`WD_ALIGN_PARAGRAPH.JUSTIFY`) en los párrafos de
  texto corrido y bullets del cuerpo (no en los encabezados — una sola línea de
  título no cambia visualmente con justify, y el patrón del usuario los deja
  alineados a la izquierda).
- **Márgenes de página**: 0.75 pulgadas en los 4 lados (superior, inferior,
  izquierdo, derecho) — el default de python-docx es 1", hay que sobrescribirlo.

Aplicar esto ANTES de escribir contenido, modificando los **estilos base** del
documento (`Normal`, `Heading 1`, `Heading 2`, `List Bullet`, `List Paragraph`)
en vez de tocar cada run a mano — así se hereda automáticamente en cada
`add_heading()`/`add_paragraph()` posterior:

```python
from docx.shared import Inches, Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn

doc = Document()

# Margenes: 0.75" en los 4 lados
for section in doc.sections:
    section.top_margin = Inches(0.75)
    section.bottom_margin = Inches(0.75)
    section.left_margin = Inches(0.75)
    section.right_margin = Inches(0.75)

# Fuente Tahoma 11 (+ justificado en el cuerpo) via estilos base
for style_name in ("Normal", "Heading 1", "Heading 2", "List Bullet", "List Paragraph"):
    style = doc.styles[style_name]
    style.font.name = "Tahoma"
    style.font.size = Pt(11)
    rpr = style.element.get_or_add_rPr()
    rFonts = rpr.find(qn('w:rFonts'))
    if rFonts is None:
        rFonts = rpr.makeelement(qn('w:rFonts'), {})
        rpr.append(rFonts)
    rFonts.set(qn('w:eastAsia'), 'Tahoma')  # cubre tildes/ñ correctamente
    if style_name in ("Normal", "List Bullet", "List Paragraph"):
        style.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
```

Las celdas de tabla (`Light Grid Accent 1`) heredan de `Normal` salvo que Word
las sobrescriba — revisar visualmente que también salgan en Tahoma 11 antes de
dar el documento por bueno; si no heredan, setear `run.font.name`/`size` celda
por celda igual que se hacía antes para todo el documento.

**Caso real, 2026-07-29**: el documento de ese día (`07292026_premercado
claude.docx`) se generó ANTES de que esta regla quedara fijada — salió con
Calibri por defecto, márgenes de 1" y sin justificar. Al aplicar este formato
después de los hechos a un documento ya generado (en vez de en la generación
original), no hace falta preservar ningún ajuste manual del usuario todavía —
alcanza con sobrescribir los estilos base como arriba y guardar de nuevo. Esa
situación es distinta del flujo del punto "MUY IMPORTANTE" de abajo, que aplica
cuando el usuario YA editó un documento a mano con cambios propios (más allá de
este formato base) que hay que respetar.

**MUY IMPORTANTE — si el usuario edita el .docx a mano después de recibirlo**
(más allá del formato base de arriba, que ya sale aplicado desde la
generación): antes de volver a tocar ese archivo:
1. Abrirlo con `python-docx` y **inspeccionar** los runs existentes (nombre de
   fuente, tamaño, bold/italic) con un script de solo-lectura antes de escribir
   nada — NUNCA regenerar el documento desde cero de nuevo una vez que el usuario
   ya lo editó, o se pierden sus cambios de formato.
2. Si hay que agregar contenido nuevo (imágenes, bullets), usar
   `paragraph.insert_paragraph_before(...)` sobre un párrafo ancla localizado por
   texto (no por índice — los índices se corren), y replicar el nombre de fuente
   detectado (Tahoma 11 por defecto desde el punto de arriba, pero confirmar
   contra el run real por si el usuario lo cambió de nuevo — setear también
   `w:rFonts/@w:eastAsia` vía OXML para que cubra tildes/ñ correctamente) en cada
   run nuevo que se cree.
3. Para imágenes: `paragraph.add_run().add_picture(path, width=Inches(6.5))`,
   con el párrafo centrado (`paragraph.alignment =
   WD_ALIGN_PARAGRAPH.CENTER`).
4. Cuidado con la consola de Windows al hacer prints de depuración: usa cp1252 y
   revienta con `→`, tildes, etc. — escribir a un archivo `.txt` con
   `encoding='utf-8'` en vez de `print()` si hay que inspeccionar contenido con
   caracteres especiales.

### Portada — "Informe Gerencial" (obligatoria desde 2026-08-14)

A pedido explícito del usuario: el documento **abre siempre con un resumen
ejecutivo de UNA sola hoja**, y el análisis completo empieza en la hoja 2. La
idea es poder decidir el día leyendo una página; el cuerpo queda como respaldo,
no como lectura obligatoria antes de operar.

**Script**: `scripts/gen_informe_gerencial.py` (dentro de este skill).

```
python gen_informe_gerencial.py <docx> <spec.json> <chart_escenarios.png> [--force]
```

Corre **DESPUÉS** de que el `.docx` ya está escrito y **DESPUÉS** de
`gen_escenarios_chart.py`. Reusa **el mismo PNG** que se incrustó en la sección
"Los 3 Escenarios" — no genera un gráfico nuevo, justamente para que la portada
y el cuerpo no puedan contradecirse. Inserta el bloque antes del `Heading 1`
original y le pone "salto de página antes" a ese título; **no toca ni un párrafo
del cuerpo**.

Si el documento ya tiene portada, aborta con exit 3; con `--force` la borra y la
reescribe (es el camino para corregir un dato después de haber generado).

**Layout de la hoja** (fijado tras medirlo exportando a PDF — ver gotchas):

| Bloque | Contenido |
|---|---|
| Título + línea de contexto | Fecha, hora de ejecución, cierre previo, apertura implícita y gap, pivote del día |
| Columna izquierda | El diagrama de los 3 escenarios a 3,05" de ancho |
| Columna derecha | **Tesis del día** (4-6 líneas), **Termómetro del día** (9 filas), **Lo que cambió vs. ayer** (3 bullets) |
| Ancho completo | Tabla **Los 3 escenarios**: Escenario · Prob. · Se activa si · Se invalida si · Target |
| Dos columnas | **Primera hora — qué mirar** (4 bullets) \| **Riesgo principal** |

**La tesis es una conclusión, no un resumen.** Debe responder qué hace el
mercado hoy y cuál es la pregunta que define la sesión, no repetir en orden lo
que dicen las secciones de abajo. Los números que aparezcan en la portada tienen
que estar tomados del cuerpo ya escrito — nunca recalculados aparte, o se abre la
puerta a que la hoja 1 y la hoja 5 digan cosas distintas.

**El `spec.json`** va como `.scratch_gerencial_<MMDD>.json` en `bitacora-tasty`
(misma convención que los specs del chart). Ver el docstring del script para el
contrato completo de campos.

⚠️ **Gotchas ya pagados (2026-08-14, día en que se creó la portada)**:

1. **Verificar SIEMPRE que quepa en una hoja exportando a PDF**, no a ojo. Con
   Word COM:
   `$d.ExportAsFixedFormat($pdf, 17)` y `$d.ComputeStatistics(2)` para el conteo
   de páginas. La primera versión se pasaba 2 pulgadas a la hoja 2 y no había
   forma de saberlo sin renderizar.
2. **"Primera hora" y "Riesgo" van lado a lado, no apilados.** Apilados a lo
   ancho de la hoja se comían 2,5 pulgadas; en dos columnas ocupan 1,4.
3. **El corte de hoja va como `page_break_before` del `Heading 1` del cuerpo**,
   NO como un párrafo con salto al final de la portada. Ese párrafo extra no
   cabía en la hoja 1 ya llena, se iba solo a la hoja 2 y empujaba el cuerpo a la
   3 — quedaba una **página en blanco** en medio del documento.
4. **Alineación `LEFT` explícita en las celdas de tabla.** El estilo `Normal` del
   documento está en `JUSTIFY`, y en una celda angosta eso abre huecos enormes
   entre palabras cuando la etiqueta se parte en dos líneas.
5. **Tahoma explícito en cada run**, incluso dentro de celdas: el estilo base no
   siempre gana ahí (mismo gotcha que ya estaba documentado para el cuerpo).
6. Si una etiqueta del termómetro se parte fea en dos líneas, **acortar la
   etiqueta y mover el detalle al valor** (`"Pivote del día"` →
   `"7.800 = Call Wall + MVS + POC"`), en vez de pelear con el ancho de columna.

## Paso final — Actualizar Excel de control

Después de generar el análisis del día, actualizar el archivo de control en:
`premercados alejandro\control premercado\control_premercado.xlsx`

- Agregar/actualizar la fila de la fecha analizada en la hoja "Control Premercado"
  con Estado = "Analizado" (o "Grabado" si además hay audio/grabación de ese día) y
  en Detalle anotar brevemente el escenario que se terminó validando si ya se sabe
  al cierre del día (opcional, se puede dejar en blanco si se corre en premercado).
- Actualizar los totales en la hoja "Resumen".
- Usar Python vía Bash con `openpyxl` (NO `python3`, en esta máquina el intérprete
  con `openpyxl` instalado es `python`, verificado con
  `python -c "import openpyxl"`). Cargar el workbook existente con
  `openpyxl.load_workbook(path)` y modificar en vez de recrear desde cero, para no
  perder el formato/colores ya aplicados.

## Paso 8 — Postmercado (2026-07-21, nuevo — corre DESPUÉS del cierre de mercado)

A pedido explícito del usuario: cerrar el círculo del día agregando, al FINAL del
mismo documento de premercado de esa fecha (no un documento nuevo, no hay que
esperar al día siguiente), un análisis de qué hizo el mercado de verdad y si los
3 escenarios planteados esa mañana acertaron. Complementa — no reemplaza — el
Paso 6.2 (que valida el día anterior al EMPEZAR el premercado siguiente,
escribiendo el aprendizaje en el documento del día NUEVO): el Postmercado
documenta el resultado en el propio documento del día que ya pasó, apenas cierra
el mercado; el Paso 6.2 sigue existiendo para la narrativa del día siguiente.

**Cuándo correr esto**: se invoca aparte, después de las 4:00pm ET (no es parte
del mismo comando de la mañana, obviamente — el mercado no ha cerrado todavía
cuando se corre el premercado). Disparadores: "el postmercado de hoy", "qué hizo
el mercado", "revisa si acertamos el premercado", o equivalente.

1. **Traer el rango real del día** — usar Yahoo Finance directo
   (`https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=5d`
   para el diario, `...&interval=15m&range=5d` para el camino intradía), NO pelear
   con la pestaña de TradingView si está en otro chart (ver nota del Paso 0) — es
   más simple y confiable para este dato puntual. Extraer: apertura, máximo,
   mínimo, cierre del día, y el camino de 15m completo (para narrar CUÁNDO pasó
   cada cosa, no solo el resultado final).
2. **Abrir el documento del premercado de esa fecha**
   (`<MMDDAAAA>_premercado claude.docx`) y localizar la sección "Los 3 Escenarios"
   — de ahí se leen las condiciones de activación, invalidación y targets
   exactos que se plantearon esa mañana (no inventar ni re-derivar, usar el texto
   tal cual quedó escrito ese día).
   ⚠️ Desde el 2026-08-14 hay **dos** tablas de escenarios en el documento: la de
   la portada (hoja 1, "LOS 3 ESCENARIOS", texto abreviado para que quepa) y la
   del cuerpo (heading `Conclusiones Los 3 Escenarios`). La que vale para el
   postmercado es **la del cuerpo** — la de la portada es un resumen recortado y
   citarla como si fuera el compromiso original subestima lo que decía el informe.
3. **Comparar el camino real contra los 3 escenarios**, prestando atención
   especial a:
   - **Fakeouts / spikes que no se sostienen**: un movimiento que toca un target
     en los primeros minutos pero se revierte ANTES de que pasen los 15-30 min de
     validación que el propio sistema exige NO cuenta como escenario validado —
     un trader disciplinado no lo habría operado. Señalarlo explícitamente
     (ejemplo real, 2026-07-20: spike alcista tocó el target T1 en el primer
     minuto de sesión y se revirtió en los siguientes 15 minutos).
   - **Validación direccional vs. validación total**: un escenario puede cumplir
     su condición de activación e invalidación (ganó la dirección) sin llegar al
     target de precio completo — hay que distinguir ambas cosas, no marcar
     "no acertamos" solo porque no llegó al extremo del target.
   - **Días de consolidación real seguida de resolución**: si hubo un tramo de
     rango genuino a media mañana que después se resolvió con una tendencia
     clara, el escenario Neutral NO se valida (se resolvió, no se quedó
     atrapado) aunque haya habido una fase de rango real en el medio.
4. **Escribir la sección al final del documento** (después de "Los 3
   Escenarios", que es donde el documento ya termina):
   - Heading 2: "Postmercado — Resultado real (`<fecha en español>`)"
   - Párrafo de rango real + cambio vs. la referencia del premercado y vs. la
     propia apertura del día.
   - Párrafo narrando el camino intradía en orden cronológico (con horas ET),
     no solo el OHLC final — es la parte que explica el "por qué" del resultado.
   - Tabla "Escenario validado" (columnas: Escenario | Probabilidad asignada |
     ¿Se validó? | Nota) con los 3 escenarios y un veredicto para cada uno —
     no dejar ninguno sin comentar, incluso el que "ganó" merece la nota de qué
     tan completo fue.
   - Heading 3 "¿Acertamos?" con un veredicto claro (SÍ/NO/PARCIAL) sobre si el
     escenario de MAYOR PROBABILIDAD asignada esa mañana (Paso 6) fue el que
     terminó imponiéndose — esto es lo que retroalimenta el scorecard de
     probabilidades a través del tiempo, no solo un resumen del día.
   - Usar `doc.add_heading()`/`doc.add_paragraph()`/`doc.add_table()` normales
     (agregan al FINAL del documento por defecto en python-docx) — no hace falta
     la técnica de insertar-antes-de-un-ancla que se usa en otras partes de este
     skill, porque acá el postmercado siempre va último.
4bis. **Si el día fue de vencimiento mensual** (3er viernes — Paso 3bis), el postmercado
   lleva ADEMÁS una sección propia, **"Vencimiento — ¿el precio buscó el Max Pain?"**:
   - Distancia del cierre al Max Pain, en puntos y %, contra la distancia que había en la
     apertura. ¿Se acercó o se alejó?
   - El camino: ¿orbitó el Max Pain durante la sesión, lo cruzó, o nunca se le arrimó? La
     hora en que se pegó (o se despegó) importa más que el cierre solo.
   - Veredicto explícito de si la imantación se observó ese día, **cruzado con el régimen
     de gamma** — un acierto en gamma negativo vale más como evidencia que uno en gamma
     positivo, donde el efecto se explica igual por la cobertura de los dealers.
   - Completar los campos `cierre_real`, `distancia_cierre_pts`, `distancia_cierre_pct` y
     `convergio` del bloque `max_pain` de esa fecha en el log.
   - No forzar la conclusión hacia la teoría. Si el precio se fue al otro lado, se escribe
     que se fue al otro lado.

4ter. **Si hubo catalizadores en sesión** (Paso 4ter), el postmercado dice qué hizo el
   precio en los 15 minutos alrededor de cada publicación: valor real vs. pronóstico, y si
   el movimiento respetó o rompió la estructura que el premercado había marcado. Es lo que
   permite, con el tiempo, saber si el descuento al Neutral
   (`ajuste_neutral_por_catalizador`) está bien calibrado o es puro reflejo.

5. **Actualizar `premercado_hipotesis_log.json`** (Paso 6) con el campo
   `resultado` de la entrada de esa fecha, si todavía está en `null` — mismo
   contrato que documenta el Paso 6.2 (`escenario_validado`, `cierre_real`,
   `acierto`, `leccion_aprendida`). Esto es lo que el Paso 6.2 va a leer al
   empezar el premercado del día siguiente — no duplicar el análisis a mano ahí,
   solo referenciar lo que ya se escribió en el Postmercado.

6. **Emitir la llamada de la sesión siguiente** (2026-09-06, nuevo). El
   postmercado cierra con UNA predicción falsable para la próxima sesión,
   escrita esa misma tarde y guardada en el log.

   **Por qué se agrega.** La auditoría del 2026-09-06 midió los 35 premercados
   contra el precio real: el favorito direccional acertó 14 de 22 (63,6%) —
   exactamente lo mismo que ponerse corto a ciegas esos mismos días, con el
   intervalo de confianza [43%, 80%] cruzando la moneda y p = 0,29. Cuando el
   usuario preguntó lo mismo del postmercado, la respuesta fue que **no se podía
   responder**: el Paso 8 solo evalúa hacia atrás, y una evaluación
   retrospectiva no se puede puntuar. Cero observaciones hacia adelante. Este
   bloque es lo que empieza a generarlas. La primera llamada es para el martes
   2026-09-08 (el lunes 7 es Labor Day).

   Reglas, todas obligatorias:
   - **Se emite el mismo día y NO se edita después.** Si cambia la lectura, va
     una entrada nueva con su hora, nunca una sobrescritura: una llamada
     corregida con información posterior deja de ser una predicción.
   - **Lleva nivel, no prosa.** Mismo contrato que `escenarios` (Paso 6), para
     que la puntúe el mismo código y no una lectura a ojo. Una llamada que dice
     "sesgo bajista con cautela" no se puede puntuar y por tanto no vale.
   - **`para_fecha` se PREGUNTA al calendario**: `cal.siguienteDiaDeMercado()`
     de `src/calendario_nyse`. No se asume "mañana" — gotcha 12 del CLAUDE.md
     del repo: el calendario se pregunta, no se reimplementa.
   - **La puntuación es mecánica y binaria. No existe "parcial".** La misma
     auditoría encontró que de las 17 notas `parcial` del log, **6 tenían la
     dirección objetivamente equivocada** y solo 3 la tenían bien: el "parcial"
     funcionó como colchón y hacía ver la serie mucho mejor de lo que era.
   - **Esto NO autoriza operar.** Muestra cero. Se acumulan al menos 30 sesiones
     antes de que el número signifique nada, y se compara contra el benchmark de
     "siempre corto" en las mismas fechas, nunca contra sí mismo.

   Bloque a escribir en `premercado_hipotesis_log.json`, en la entrada del día
   que se está cerrando:

   ```json
   "llamada_siguiente": {
     "para_fecha": "2026-09-08",
     "emitida_et": "2026-09-04T16:42",
     "spot_cierre": 7718.36,
     "direccion": "BAJISTA",
     "conviccion": 55,
     "activa":   { "tipo": "cierre_15m_bajo",  "nivel": 7700 },
     "invalida": { "tipo": "cierre_15m_sobre", "nivel": 7735 },
     "t1": [7675, 7680],
     "t2": [7650],
     "tesis": "Una sola frase: qué tiene que pasar y por qué.",
     "resultado": null
   }
   ```

   `resultado` lo completa el postmercado del día siguiente, sobre velas de 15m
   y con el mismo colchón de 3 puntos que usa `src/estrategia_premercado.js`:

   ```json
   "resultado": {
     "activo": true,
     "hora_activacion_et": "10:15",
     "alcanzo_t1": false,
     "invalido": true,
     "hora_invalidacion_et": "11:30",
     "pts_desde_activacion_al_cierre": -12.4,
     "veredicto": "FALLO"
   }
   ```

   `veredicto` admite exactamente tres valores: **`ACIERTO`** (activó y alcanzó
   T1 antes de invalidarse), **`FALLO`** (activó y se invalidó antes de T1),
   **`NO_ACTIVO`** (el disparador nunca se cumplió). `NO_ACTIVO` no cuenta a
   favor ni en contra en la tasa de acierto, pero **se registra y se cuenta
   aparte**: una llamada que casi nunca se activa tampoco sirve para operar, y
   sin ese contador eso queda invisible.

**Ejemplo real completo (2026-07-20, ver el documento del día)**: apertura
$7,489.18, máximo $7,513.23 (tocado en el primer minuto, dentro del target
alcista), mínimo $7,440.53, cierre $7,443.28. Camino: spike alcista inicial que
se desvaneció en 15 min, dos horas de rango 7,463-7,495, y desde el mediodía ET
una caída sostenida que rompió el Put Wall y cerró cerca de los mínimos.
Veredicto: el escenario Bajista (44%, el de mayor probabilidad) se validó
direccionalmente (rompió Put Wall, nunca recuperó el Gamma Flip con fuerza)
aunque no llegó al target completo (MVS 7,400) — **acertamos** la dirección de
mayor probabilidad pese al fakeout alcista de apertura.

## Modo manual (sin TradingView conectado)

Si TradingView no está disponible o el usuario prefiere no tocar procesos del
sistema, pedirle explícitamente: precio actual del SPX, POC diario, VIX, y
(si los tiene) Gamma Flip/Call Wall/Put Wall. Con eso igual se puede construir el
documento completo de los 3 escenarios, dejando anotado qué datos fueron
provistos manualmente vs. leídos en vivo.
