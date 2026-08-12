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

## Qué hay acá

| Skill | Qué hace |
|---|---|
| `informe-trade/` | Genera el PDF de análisis de cada trade SPX cerrado: gráfico de entrada/salida sobre velas de Sigma, condiciones de mercado, tabla de checks, estructura, resultado de Tradier, **cadena real** (cuánto habría cerrado con cotizaciones en vivo) y conclusión. |
