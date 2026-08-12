# Skills de Claude Code, versionados

Los skills viven en `~/.claude/skills/`, que **no es este repo** — y `.gitignore`
excluye `.claude/`, así que ponerlos ahí dentro tampoco los versionaría. Resultado:
durante meses el skill del informe de trade estuvo fuera de todo control de cambios.
Se editaba, se rompía, y no había historial ni forma de volver atrás.

Desde el 2026-08-11 la fuente de verdad de esos skills es **esta carpeta**, y
`~/.claude/skills/<nombre>` es un **junction de Windows** que apunta acá. Una sola
copia: lo que se edita en cualquiera de las dos rutas es el mismo archivo, así que no
pueden desincronizarse.

## Cómo se reproduce en otra máquina

Con el repo ya clonado, y **sin permisos de administrador** (un junction de directorio
no los pide, a diferencia de un symlink):

```cmd
mklink /J "%USERPROFILE%\.claude\skills\informe-trade" "C:\ruta\al\repo\skills\informe-trade"
```

Si en `~/.claude/skills/` ya existe una carpeta real con ese nombre, hay que sacarla
antes (`mklink` no pisa un directorio existente). Conviene moverla, no borrarla, hasta
comprobar que el skill sigue funcionando.

## Verificar que quedó bien

El junction es transparente para cualquier programa, así que basta con correr los
scripts por la ruta del skill, que es la que documenta `SKILL.md`:

```bash
node   "%USERPROFILE%/.claude/skills/informe-trade/scripts/velas_trade.mjs" <executionId>
python "%USERPROFILE%/.claude/skills/informe-trade/scripts/render_informe.py" <spec.json>
```

Y comprobar que Claude Code lo sigue listando como skill disponible (`informe-trade`,
sin sufijos).

⚠️ **No dejar copias de respaldo dentro de `~/.claude/skills/`.** Cualquier carpeta con
un `SKILL.md` adentro se descubre como un skill más: un `informe-trade.bak` aparece en
la lista como si fuera otro skill distinto, con la misma descripción, y se puede invocar
por error. Los respaldos van fuera de esa carpeta.

## ⚠️ Este repo es PÚBLICO — no todo skill puede venir acá

`gcarvaja51/bitacora-tasty` es público: cualquiera lo lee. Antes de mover un skill hay
que abrirlo y mirar qué contiene, no asumir que "es solo un script".

Tres skills se quedaron **a propósito** en `~/.claude/skills/`, sin versionar:

| Skill | Por qué no puede publicarse |
|---|---|
| `american-school-way` | Registro académico de una persona real: su nivel, fechas de clases y evaluaciones, más el método de acceso a la plataforma del colegio. Datos de un tercero que no consintió nada. |
| `video-a-texto` | Describe cómo extraer el contenido de cursos pagos (Opción Sigma / Kajabi+Wistia). Publicarlo puede traer un problema con el proveedor. |
| `actualizacion-videos` | Pipeline sobre el material de los mentores de Sigma. |

El costo es real —esos tres siguen sin historial ni diff— y se aceptó a conciencia. Si
alguna vez hace falta versionarlos, va en un repo **privado** aparte, con el mismo
esquema de junctions.

## Qué hay acá

| Skill | Qué hace |
|---|---|
| `informe-trade/` | Genera el PDF de análisis de cada trade SPX cerrado: gráfico de entrada/salida sobre velas de Sigma, condiciones de mercado, tabla de checks, estructura, resultado de Tradier, **cadena real** (cuánto habría cerrado con cotizaciones en vivo) y conclusión. |
| `premercado-spx/` | Análisis diario de premercado del SPX con la metodología de Alejandro (Macro a Micro, tres escenarios), y el postmercado que contrasta lo previsto contra lo que hizo el mercado. |
| `comparacion-muros/` | Recolecta cada 5 min los muros de Gamma y los regímenes GEX/DEX que calcula el servidor contra los que muestra Sigma Terminal, para decidir si se puede dejar de depender de Sigma. |
| `notebooklm/` | API completa de NotebookLM. Documentación de herramienta, sin datos propios. |

## Cuidado al montar los junctions

Crearlos **uno a uno con rutas literales**. Armarlos dentro de un bucle con variables
interpoladas salió mal el 2026-08-11: la variable con el nombre del skill no se expandió,
y en vez de enlazar `~/.claude/skills/<nombre>` se movió y enlazó **la carpeta
`~/.claude/skills` entera** al repo. Durante unos minutos los siete skills apuntaban al
contenido del repo y los tres que no debían publicarse no aparecían por ningún lado.

Se recuperó completo (nada se borró, todo estaba movido), pero la lección queda: al
quitar un junction usar `cmd /c rmdir`, **nunca** `Remove-Item -Recurse` — sobre un
reparse point puede llevarse el contenido del destino, que acá es el repo.
