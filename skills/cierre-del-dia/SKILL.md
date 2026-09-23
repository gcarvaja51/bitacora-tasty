---
name: cierre-del-dia
description: Informe "Cierre del día" del SPX, después de las 16:00 ET. Cuenta qué hizo el mercado, cómo le fue a los 3 escenarios del premercado y, sobre todo, qué puede pasar mañana, con niveles, catalizadores de 3 estrellas y una llamada falsable. Es un informe APARTE del premercado y no lo modifica. Se activa con "/cierre-del-dia", "el cierre del día", "informe cierre del día", "qué puede pasar mañana" (después del cierre), o similar.
---

# Cierre del día (SPX)

Pedido de Guillermo el 2026-09-23: "hagamos el análisis del cierre del mercado, tratemos de
avanzar en lo que pueda pasar mañana... vamos a crear un informe que se llame cierre del día".

🚫 **No toca el informe de premercado ni su skill** ("no vamos a cambiar el informe de
premercado"). Lee el premercado del día (el `.docx` y la entrada del log) para comparar,
pero no los edita. Es un documento propio.

## Salida

`premercados alejandro\documentos premercado\<MMDDAAAA>_cierre del dia.docx`, **solo Word,
nunca PDF**. Formato igual al del premercado: Tahoma 11 en todo (tablas en 9,5), márgenes de
0,75", cuerpo justificado, tablas `Light Grid Accent 1` con celdas alineadas a la izquierda.
Niveles redondos (múltiplos de 5) y precios sin decimales, igual que en el premercado.

Título (Heading 1): **"Cierre del día — <día de la semana, fecha en español>"**, y debajo la
hora del informe (ET).

## Secciones, en este orden

1. **Qué hizo el mercado**: apertura, máximo, mínimo, cierre, variación en puntos y %, rango
   y VIX (apertura → cierre, y el máximo). Después el camino en bullets por hora ET, diciendo
   qué hizo el precio en cada catalizador de 3 estrellas del día (valor real contra
   pronóstico).
2. **Escenarios del premercado contra lo que pasó**: tabla Escenario · Prob. · ¿Se validó? ·
   Nota. Los niveles salen del bloque `escenarios` de la entrada del día en
   `premercado_hipotesis_log.json`. La puntuación es mecánica sobre cierres de 15m, con el
   colchón de 3 puntos del motor.
3. **¿Acertamos?**: SÍ o NO sobre el favorito del premercado. Si el día es D19, se dice que
   no suma a la asertividad.
4. **Cómo quedó Sigma al cierre**: `gamma_daemon/status.json` → `lastLevels` de las ~16:05
   ET. Aclarar que esa cadena ya venció: sirve el tono (régimen, GEX, DEX), no los muros
   para mañana.
5. **Qué puede pasar mañana**, la parte principal:
   - Estructura al cierre por temporalidad: diario (EMA10/20/50), 30m (EMA10/20/50/200) y
     **el cruce EMA10/EMA20 de 15m, su indicador principal**: de qué lado está, desde qué
     vela y si se está cerrando.
   - ES fuera de hora convertido a contado con la base ES-SPX del día (mediana de las velas
     de 15m pareadas de la sesión): apertura implícita provisoria.
   - Tabla de niveles de mañana con el equivalente en VANTAGE:SP500 entre paréntesis (base
     de `control premercado\base_sp500_vs_spx.json`, redondeada).
   - Catalizadores de mañana: **solo los que Investing marca con 3 estrellas**, leídos del
     calendario en el Chrome de Guillermo (pestaña "Mañana"; ver abajo). Decir si alguno
     activa la regla D19 (3 estrellas a las 10:15 ET o después → día sin trade).
   - **Llamada para mañana**: dirección, convicción, se activa con, se invalida con, T1 y
     T2, más los argumentos del lado contrario. Se escribe una vez y **no se edita**.

## Registro

- `premercado_hipotesis_log.json`, entrada del día (con backup antes): `resultado` (mismo
  contrato del Paso 6.2 del premercado, que de todas formas lo llenaría a la mañana
  siguiente) y `llamada_siguiente` (contrato del Paso 8.6 del premercado; `para_fecha` sale
  de `src/calendario_nyse.siguienteDiaDeMercado()`). Son campos que el premercado ya lee;
  no se agrega nada que lo cambie.
- `control_premercado.xlsx`, fila del día: se añade al Detalle un "CIERRE DEL DÍA: …" corto.

## Fuentes de datos

- Velas: Yahoo `^GSPC` 15m/30m/1d, `^VIX` 15m, `ES=F` 15m (ver memoria de velas del SPX).
  La vela diaria de Yahoo puede venir vacía: reconstruirla con las de 15m. El cierre oficial
  es `meta.regularMarketPrice` del chart diario.
- Sigma: `C:\Users\gcarv\bitacora-tasty\gamma_daemon\status.json`.
- Calendario: Investing en Chrome (`claude-in-chrome`). La tabla se arma por JavaScript:
  clic en "Mañana" y leer las filas `table tr` con `javascript_tool`; 3 `svg` en la celda de
  importancia = 3 estrellas. Las horas salen en hora Colombia (ET = Colombia + 1 en horario
  de verano de EE.UU.). WebFetch no sirve para las estrellas.
- Hora ET: con Python `zoneinfo` (en Git Bash, `TZ=` devuelve UTC en silencio).

## Gotchas del primer informe (2026-09-23)

- Si el `.docx` del premercado está abierto en Word, `save` falla con PermissionError. Este
  informe no lo toca, así que no importa, pero no intentar agregarle nada.
- Al armar rutas de Windows en Python con strings raw, cuidar que `\0` de "\09232026" no se
  cuele como byte nulo: el primer intento guardó el archivo fuera de su carpeta.
- `scripts/ejemplo_09232026.py` es el script con el que se generó el primero: sirve de molde
  para las funciones de formato, no para copiar el texto.
