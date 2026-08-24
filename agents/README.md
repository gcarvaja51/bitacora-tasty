# Agentes de la Bitácora Tasty

Definiciones de los cinco agentes que gestionan y miden el proyecto. El diseño completo
—por qué son cinco, qué puesto de la industria ocupa cada uno y la cadena de decisión—
está en `gerencia proyecto robot trading/01_documento_diseno/`.

## Estado

Al 2026-08-24 los cinco están **conectados**: el junction hacia `~/.claude/agents/` existe
(creado el 2026-08-21), las cinco skills están escritas en `skills/`, y los lanzadores
`scripts/ejecutar_*.cmd` los disparan desde el Programador de tareas de Windows.

> El texto anterior de esta sección decía «NADA DE ESTO ESTÁ CONECTADO — no hay junction».
> Quedó desactualizado el mismo 2026-08-21, cuando se creó el junction, y se corrigió el
> 2026-08-24. Se anota en vez de borrarse: es justo el tipo de deriva entre lo documentado
> y lo que corre que el Secretario existe para cazar, y esta vez le tocó sobre su propio
> expediente.

Para que un agente pase a existir hacen falta las tres piezas:

| Pieza | Dónde va | Estado |
|---|---|---|
| Definición (identidad, modelo, herramientas, límites) | `agents/<nombre>.md` | ✅ escrito |
| Skill (el procedimiento paso a paso) | `skills/<nombre>/SKILL.md` | ❌ pendiente |
| Disparador (tarea programada o hook) | Programador de tareas de Windows | ❌ pendiente |

## Cómo se activarían (cuando se decida)

Un solo junction para los cinco, porque son archivos sueltos y no carpetas. **Sin
permisos de administrador**, igual que el de `skills/`:

```cmd
mklink /J "%USERPROFILE%\.claude\agents" "C:\Users\gcarv\bitacora-tasty\agents"
```

La fuente de verdad es esta carpeta, no `~/.claude/agents`. Es la misma razón que llevó
a mover las skills acá el 2026-08-11: `.gitignore` excluye `.claude/`, así que nada de
ahí adentro queda versionado. Un agente sin historial se rompe y no hay forma de volver
atrás.

## Los cinco

| Archivo | Agente | Etiqueta | Modelo | Rol |
|---|---|---|---|---|
| `contador.md` | El Contador | `[CONTADOR]` | opus | Dice **cuánto**. Analista de ejecución (TCA) |
| `ingeniero-datos.md` | El Ingeniero de Datos | `[DATOS]` | opus | Dice **por qué** y **propone**. Calidad del dato + investigación |
| `auditor.md` | El Auditor | `[AUDITOR]` | opus | Dice **si sirve**. Validación de modelo (MRM) |
| `torre-control.md` | La Torre de Control | `[TORRE]` | haiku | **Vigila**. SRE + QA |
| `secretario.md` | El Secretario | `[SECRETARIO]` | sonnet | **Registra**. Control de cambios |

## La cadena

```
CONTADOR         →  INGENIERO DE DATOS  →  AUDITOR      →  GUILLERMO  →  SECRETARIO
¿cuánto?            ¿por qué / y si...?     ¿sirve?          autoriza      anota
```

**Quien propone nunca es quien valida.** Los dos que proponen se separan por dominio: el
Contador es dueño de la **ejecución** (fills, slippage, costo de cruce); el Ingeniero de
Datos es dueño de la **señal** (entradas, filtros, umbrales, ventanas). El Auditor los
valida a los dos por igual y nunca propone.

No hay un sexto agente que haga de CEO: autorizar o frenar un cambio no se delega.

**El Auditor tiene un segundo dominio desde el 2026-08-24: el premercado SPX**, que hasta
entonces se ponía la nota a sí mismo en su propio log. Motor:
`scripts/veredicto_premercado.py`. Los dos dominios **no se mezclan en una misma medición**
— el robot mide trades, el premercado mide días.

## Formato del parte

Los cinco entregan un bloque corto y estructurado, para que la reunión diaria los pueda
consolidar sin interpretarlos:

```
[ETIQUETA] AAAA-MM-DD
ESTADO: verde | ámbar | rojo
HALLAZGOS:
  - una línea por hallazgo, con el número que lo sostiene
PENDIENTE DE DECISIÓN:
  - preguntas de sí o no, nunca narrativa
```

Si no hay nada que reportar, el parte dice `ESTADO: verde` y ninguna línea más. **El
silencio informativo vale**: un agente que rellena cuando no pasó nada entrena a que se
deje de leer.

## Sobre los límites

Las prohibiciones escritas en cada definición son **instrucciones, no candados**. Con la
herramienta `Bash` disponible, un agente puede hacer `curl -X POST` contra el endpoint de
configuración aunque su prompt lo prohíba.

Para convertirlas en candados hacen falta, además:

1. **Reglas de negación** en `.claude/settings.json` (`Bash(curl*POST*/api/spx/config*)`,
   `Bash(git push*)`, `Bash(railway*)`).
2. **No dar `Bash`** a quien no lo necesita.
3. **Que el servidor exija una llave** para escribir configuración, y que ningún agente la
   tenga. Es la única que no depende de la buena conducta del agente.

Ninguna de las tres está implementada todavía.
