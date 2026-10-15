---
name: calendario-semanal
description: Rutina semanal que trae la "AGENDA SEMANAL – SIGMA CLUB" del grupo de WhatsApp "Notificaciones 5 de Opción Sigma" (cuenta usa) y carga las sesiones en el Google Calendar de Guillermo, en hora del Este. Se activa con "/calendario-semanal", "calendario semanal", "carga la agenda de Sigma", "pasa las sesiones de la semana al calendario", o los lunes a las 11:00am vía la Tarea Programada de Windows (martes si el lunes es festivo en NY).
---

# Calendario semanal de Sigma Club

Pasa la agenda semanal que publica Sigma Club por WhatsApp al Google Calendar
de Guillermo (`guillermo.alu@gmail.com`). Creada el 2026-09-28.

## La regla, tal como la pidió Guillermo

- **Todos los lunes a las 11:00am** (hora Colombia) se busca la agenda y se carga.
- **Si a esa hora no está, se sigue mirando cada hora** hasta que la publiquen.
- **Si el lunes es festivo en NY, la agenda la publican el martes**: ese lunes no
  se busca y se hace el martes. (Comprobado: la semana del 7-sep-2026, Labor Day,
  salió el martes 8 con el lunes marcado "Festivo en Estados Unidos – Mercado cerrado".)

## De dónde sale

Grupo `📣 Notificaciones 🟤 5 de Opción Sigma` — `120363403656198230@g.us`,
cuenta **`usa`**. Lo publica "Tarri Sigma Club" con una imagen y este texto:

```
📅 AGENDA SEMANAL – SIGMA CLUB
Semana del 28 de septiembre al 4 de octubre

🔵 Lunes 28
• 9:15 AM – Sesión en Vivo con Cristian
• 12:30 PM – Sesión en Vivo con Pipe
...
📘 Domingo 4
• 6:30 PM – Planeación semanal
```

Suele salir el lunes entre las 8:40 y las 9:15am hora Colombia. Por eso las 11:00.

## Automático: tres fases

Tarea Programada **`Sigma_Calendario_Semanal`** → `ejecutar-semanal.cmd`,
**lunes, martes y miércoles a las 11:00**. El martes y el miércoles son red de
seguridad: si la semana ya está cargada, la fase 1 sale al instante y no cuesta nada.

| Fase | Quién | Qué hace |
|---|---|---|
| 1 | `agenda.py esperar` (Python, Claude apagado) | Si la semana ya está cargada → sale (código 1). Si es lunes festivo NY → sale (3). Si no, busca el mensaje; si no está, **mira cada hora hasta las 20:00** (2 si no salió). Al encontrarlo deja `semanas/<lunes>_agenda.txt` y `_agenda.json` (código 0). |
| 2 | `claude -p "/calendario-semanal ..."` | Solo si la fase 1 dio 0. Hace el **paso 3** de abajo. **Hasta 3 intentos**, 2 min entre uno y otro, mientras no aparezca el `_cargada.json`. |
| 3 | `agenda.py cerrar` (Python) | Manda a Guillermo por WhatsApp (línea usa → su número colombiano) el parte de lo cargado, o el aviso de que falló. |

Si el lunes no la publican antes de las 20:00, la tarea del martes a las 11:00
vuelve a empezar la vigilancia horaria; y el miércoles igual.

**Por qué los 3 intentos:** el conector de Google Calendar de claude.ai **no siempre carga** en una
sesión `claude -p`. El 2026-09-28 cargó en la primera prueba y no en la segunda, con el mismo
comando; a `informe-offside` e `interesados-apartamentos` les pasa igual con Gmail. Si falla los
3, el parte avisa y el martes 11:00 se reintenta.

**La cura de verdad** son tres variables que pone el `.cmd` antes de `claude -p`:
`MCP_CONNECTION_NONBLOCKING=0`, `MCP_CONNECT_TIMEOUT_MS=60000` y `MCP_TIMEOUT=60000`.
Por defecto `-p` conecta los conectores en segundo plano y arranca sin esperarlos; con
esto espera. Probado el 2026-09-28: sin ellas, 0 de 4 intentos vieron Calendar; con ellas,
al primero. Los 3 intentos se quedan como red de seguridad.

**Los datos van fuera de `.claude`**, en
`Documents\CARPETA PERSONAL\01. guillermo carvajal\01_Sigma\calendario semanal\semanas\`.
Dentro de `.claude` Claude en `-p` no puede escribir (carpeta protegida): la primera prueba
cargó bien el calendario pero no pudo dejar su `_cargada.json`. Claude arranca en esa carpeta.

La espera va fuera de Claude a propósito: es la lección del mañanero
(`mananero-henry`), donde esperar dentro de una sesión de Claude era caro y frágil.

## Los pasos

### 1. Encontrar el mensaje de esta semana

`agenda.py` lo hace por la API REST de GOWA (reusa las cabeceras de
`C:\yt-dlp\MANANERO\enviar_henry.py`). A mano: `whatsapp_mensajes` con
`cuenta: usa`, `chat_jid` de arriba, `buscar: "AGENDA SEMANAL"`.

**Trampa:** GOWA **ignora `start_time`** en esa búsqueda y devuelve también las
agendas de semanas pasadas. Hay que quedarse con la que dice
`Semana del <día del lunes de esta semana>` y se publicó esta semana.

### 2. Leer las sesiones

Cada línea `• H:MM AM/PM – Título` bajo un encabezado `Lunes 28`, `Martes 29`...
es una sesión. Las líneas con viñeta **sin hora** (p. ej. "Festivo en Estados
Unidos – Mercado cerrado") **no son eventos**: van a `avisos` y se mencionan en el parte.
`agenda.py` comprueba que el número de cada día cuadre con el calendario.

### 3. Cargar en Google Calendar (lo único que hace Claude)

1. Lee `semanas/<lunes>_agenda.json` (en la carpeta de datos) y el `.txt`. Si el JSON no cuadra con el texto
   (falta una sesión, hora distinta), **manda el texto**: corrige a partir de él.
2. Busca duplicados: `list_events` con `fullText: "Sigma Club"` del lunes 00:00 al
   domingo 23:59. Una sesión ya existe si coincide título y hora de inicio.
3. Por cada sesión nueva, `create_event`:
   - `summary`: `Sigma Club – <título>` (ej. `Sigma Club – Sesión en Vivo con Pipe`)
   - `startTime` / `endTime`: fecha + `hora_et`, **1 hora** de duración, sin offset
   - **`timeZone: "America/New_York"`** — obligatorio. Las horas de la agenda son del
     Este y el calendario está en America/Bogota; sin esto todo queda una hora corrido.
   - `description`: `Agenda semanal Sigma Club (grupo Notificaciones 5). Duración estimada 1 h. El link de Zoom llega 10 min antes por el canal de notificaciones.`
   - `notificationLevel: "NONE"`, sin invitados.
   - Para "La Enfermería", añadir a la descripción que las posiciones a revisar se
     mandan antes a tarri@opcionsigma.com (estrategia, strikes, vencimiento, prima, estado).
4. Escribe `semanas/<lunes>_cargada.json`:

```json
{
  "lunes": "2026-09-28",
  "creadas": ["Lun 28 8:15am – Sesión en Vivo con Cristian", "..."],
  "ya_estaban": ["..."],
  "notas": ["Lunes festivo: mercado cerrado", "..."]
}
```

   En `creadas` la hora va **en hora Colombia** (es lo que lee Guillermo en el parte).
   Ese archivo es la marca de "semana hecha": sin él, el martes se vuelve a intentar
   y la fase 3 avisa de fallo. Escríbelo aunque todo estuviera ya (con `creadas` vacía).

## Cuando lo pide a mano

Con "calendario semanal" o `/calendario-semanal` en una sesión normal: hacer los
pasos 1–3 directamente con las herramientas de WhatsApp y Calendar, escribir
igual `semanas/<lunes>_cargada.json` (para que la tarea no repita) y darle la
tabla con las horas en hora Colombia.

Mirar además los mensajes del grupo posteriores a la agenda: a veces llega un
`⚠️ CAMBIO EN LA AGENDA DE HOY` o un seminario anunciado sin hora. La rutina
automática no los procesa; a mano sí se mencionan.

## Lo que la agenda no dice

- **Duración**: se asume 1 h.
- **Link de Zoom**: no existe todavía; lo mandan 10 min antes por el grupo.

## Archivos

```
calendario-semanal/
|-- SKILL.md
|-- agenda.py              # fases 1 y 3 (esperar / cerrar); --fecha y --seco para probar
|-- ejecutar-semanal.cmd   # lo que lanza la Tarea Programada
|-- ejecuciones.log

01_Sigma\calendario semanal\semanas\<lunes>_agenda.txt | _agenda.json | _cargada.json
```

Probar sin esperar ni mandar nada:
`python agenda.py esperar --fecha 2026-09-08 --hasta 0` y `python agenda.py cerrar --seco`.
`python agenda.py hecha` devuelve 0 si la semana ya está marcada.

**GOWA:** se leen los 100 mensajes más recientes sin `search` (~12 s). Con `search` tardó
más de 90 s y dio timeout. Si la lectura falla, se reintenta a los 5 min (3 veces) antes
de esperar la hora.

## Historial

- 2026-09-28 — creada. La semana del 28-sep ya se había cargado a mano esa mañana
  (11 sesiones); se dejó su `_cargada.json` para que la tarea no la duplique.
  Tres arreglos en las pruebas del mismo día: log compartido .cmd/Python (PermissionError),
  `search` de GOWA demasiado lento, y `_cargada.json` imposible de escribir dentro de `.claude`.

## Aviso en el PC antes de cada sesión (2026-10-15)

Pedido de Guillermo: una notificación en el PC para no perderse las reuniones, con el link
para entrar, **5 min antes, al inicio y 5 min después**.

`aviso_sesiones.ps1` lee los `semanas/*_agenda.json` de las dos últimas semanas. En cada
etapa (−5, 0, +5) muestra una notificación de Windows tipo recordatorio, que se queda hasta
cerrarla. Hacer clic en ella, o en **Entrar**, abre el link. Convierte hora ET → hora local
con `TimeZoneInfo`, que resuelve el horario de verano.

**El link** no viene en la agenda. Sigma lo manda ~10 min antes al grupo "Notificaciones 5"
(cuenta usa): *"Sigma Club te invita a una reunión en Zoom… ¡Empezamos en 10 minutos!"*,
con el link de Zoom y el código de acceso. El script lee los últimos 30 mensajes del grupo
por la API local de WhatsApp (GOWA, `127.0.0.1:3001`, las mismas credenciales que usa el
gate del premercado). Toma el mensaje con link de Zoom o de YouTube en vivo publicado entre
30 min antes y 10 min después del inicio, y prefiere el que nombra la hora de la sesión.
Las grabaciones ("Ya disponible") no cuentan.

- **Sigma Live de YouTube (Luis): el grupo NO manda link** (visto el 13 y el 15-oct). Se usa
  `https://www.youtube.com/@OPCIONSIGMA/live`, que lleva al directo en curso o al próximo.
- Si el link de Zoom todavía no llegó, la notificación sale igual y lo dice.
- Tarea **`Sigma_Aviso_Sesiones`**: cada 5 min (las sesiones caen en múltiplos de 5, así que
  coincide con las etapas), oculta vía `bitacora-tasty\scripts\oculto.vbs`, con sesión iniciada.
  Si el PC estaba suspendido, solo dispara la última etapa que toca, no las tres de golpe.
- Estado: `avisos_enviados.json` (clave `fecha hora título|m5/m0/p5`, guarda 14 días). Log:
  `aviso_sesiones.log`, los dos en la carpeta de datos `calendario semanal\`.
- Pruebas: `aviso_sesiones.ps1 -Prueba` (notificación con botón) y
  `aviso_sesiones.ps1 -ProbarLink "2026-10-15 09:15"` (qué link encontraría, hora ET).
- Una sesión que se agregue a mano en Google Calendar NO avisa: solo avisan las del JSON.

**Celular (mismo día):** cada aviso sale también por ntfy, topic `bitacora_gcarvaja51`, el mismo del gate del premercado, así que la app ya está suscrita. Va con prioridad alta y el link como `Click` y como botón "Entrar". Depende de que el PC esté encendido, porque lo dispara la misma tarea. Si ntfy falla queda la línea `ntfy fallo:` en el log.
