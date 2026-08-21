# Informe de Trade (SPX — Bitácora Tasty)

Genera un PDF de análisis para cada trade SPX que se **cierra** en producción (Iron
Condor/Condor de débito, Direccional, Alejamiento de SMA) — estrategia, fecha de
apertura, condiciones de mercado al abrir, valor ganado/perdido, condiciones de
cierre, y conclusiones. Se activa con `/informe-trade` o intención equivalente
("genera los informes de los trades cerrados", "revisa si hay trades nuevos para
informar", "hazme el análisis de los últimos trades").

Origen: 2026-07-15, a pedido explícito del usuario — quiere entender, para CADA
trade, "por qué se hizo la apertura y cómo se cerró y por qué", en un PDF que pueda
consultar en su propio computador cuando lo necesite.

## Por qué esto corre como skill y no en el servidor

Los trades se abren y cierran solos en el servidor de producción (Railway, 24/7),
pero el PDF se genera con datos que hay que redactar/interpretar (no es un
template de relleno automático, ver paso 5.b) — esta sesión de Claude Code es la
que hace esa redacción, por eso la generación pasa por aquí y no por el propio
servidor.

**Copia subida a Railway (2026-07-28, a pedido explícito del usuario):** el PDF
sigue generándose y guardándose primero en el disco local (ver "Ubicación de
salida" abajo), pero además de eso ahora se sube una copia a producción (paso
5.f) para poder verlo desde el dashboard Bitácora Tradier (`tradier.html`,
columna "Informe" en Demo Tradier) desde cualquier dispositivo, no solo desde
esta compu. Antes de este cambio el diseño era deliberadamente "solo local, nunca
a la nube" — el usuario decidió relajar eso a cambio de poder ver el informe
desde el celular.

**Para que esto se sienta "siempre" (a pedido del usuario)**: correr este skill
dentro de un `/loop` cada 5-10 minutos mientras el usuario esté en su sesión de
trading (`/loop 5m /informe-trade`). El skill es idempotente — cada corrida solo
genera PDFs para trades cerrados que todavía no tienen uno, así que repetirlo no
duplica nada. Invocarlo manualmente también funciona para ponerse al día en
cualquier momento.

## Ubicación de salida

```
C:\Users\gcarv\Documents\CARPETA PERSONAL\01. guillermo carvajal\01_Sigma\mentoria alejandro\analisis tradier\
```

- PDFs: `<MMDDYYYY_fecha_cierre>_<ESTRATEGIA>_<ganador|perdedor><monto_entero>.pdf`
  — a pedido explícito del usuario, para poder ubicar un trade a simple vista sin
  abrir el PDF (ej. `07152026_BULL_PUT_SPREAD_perdedor15.pdf`,
  `07152026_BULL_CALL_SPREAD_perdedor100.pdf`).

  ⚠️ **El nombre sale del MISMO número que el cuerpo del informe** (Fase 0,
  2026-08-21). `monto_entero` = `round(abs(N))` y `ganador` si `N >= 0`, donde
  `N` es `ex.resultadoOficial.pnl` — el de la cadena real cuando hay libro
  propio. Hasta hoy el cuerpo mostraba la cadena real y **el nombre se armaba con
  `ex.pnl` de Tradier**, así que podía salir un `..._perdedor100.pdf` cuyo
  informe mostraba una ganancia. Sobre los trades que tienen las dos mediciones,
  4 de cada 12 cambian de signo: no es un caso teórico.

  Si `resultadoOficial.esCadenaReal` es `false` (registros previos al libro,
  16-ago), agregar el sufijo `_broker` antes de `.pdf` para que se vea de un
  vistazo que ese nombre no está medido con la regla buena.

  Si el nombre resultante ya existe en la carpeta (dos
  trades mismo día/estrategia/monto redondeado — puede pasar en scalping 0DTE),
  agregar un sufijo `_2`, `_3`, etc. antes de `.pdf` hasta encontrar uno libre —
  nunca sobrescribir un PDF existente.
- Manifiesto: `_generados.json` en la misma carpeta — `{"ids": ["tex-...", ...]}`.
  Antes de generar nada, cargar este archivo (si no existe, tratarlo como `{"ids":
  []}` y crearlo al final). Nunca regenerar un PDF para un `id` ya presente ahí.

## Fuentes de datos (producción)

Base URL: `https://web-production-23473.up.railway.app`

- `GET /api/tradier/executions` — el historial completo de ejecuciones (las 3
  familias). Cada registro tiene `id`, `signalId`, `strategy`, `strategyFamily`
  (`NEUTRAL`/`TENDENCIA`/`REVERSION`), `status`, `closeReason`, `pnl`, `pnlSource`,
  `timestamp` (apertura), `closedAt`, y campos propios de cada familia (ver abajo).
- `GET /api/spx/signals` — historial de señales (últimas 50, puede que una
  ejecución vieja ya no tenga su señal ahí — degradar con gracia, ver más abajo).
  Cruzar por `signalId`. Trae `context` (snapshot de mercado al momento de la señal:
  spxPrice, vix, ivRank, gammaRegime, callWall, putWall, gammaFlip, maxPain,
  technicalStop/Source, etTime) y, para Direccional/Reversión, `playbook`
  (`{score, minScore, passed, checks: [{id,label,weight,ok,value,reason}, ...]}`).
- `GET /api/spx/strategy-log?date=YYYY-MM-DD&family=...` — log de CADA evaluación
  (pase o no el gate) de las 3 estrategias, agregado el mismo día que este skill.
  Opcional pero útil como contexto adicional (ej. mostrar si hubo intentos previos
  rechazados justo antes de que este trade sí disparara) — no es indispensable si
  no aporta nada al caso puntual.

## Paso a paso

1. `curl` los 2 endpoints de arriba (o 3 si se quiere el contexto extra) y parsear
   el JSON. Guardar a un archivo temporal en el scratchpad de la sesión — las
   ejecuciones pueden traer arrays grandes (ej. `m2.bars` dentro del contexto de
   señales viejas no, pero sí en otros endpoints — no es el caso aquí, estos 2
   endpoints son livianos).
2. Cargar `_generados.json` de la carpeta de salida (crear si no existe).
3. Filtrar ejecuciones candidatas: `status === 'closed'` **y** `pnl != null` (si
   `pnl` sigue en `null` — típicamente `pnlSource: 'pendiente_verificar'` — todavía
   no hay resultado real que reportar, esperar a la siguiente corrida) **y** `id`
   no está en el manifiesto.
4. Si no hay candidatas nuevas: avisar brevemente al usuario ("sin trades nuevos
   que informar") y terminar sin tocar nada.
5. Para cada candidata, en orden cronológico (más antigua primero):
   a. Buscar la señal (`signals.find(s => s.id === ex.signalId)`). Si no aparece
      (señal fuera del cap de 50, o `signalId` ausente en registros muy viejos),
      seguir igual — la sección de "condiciones de mercado al abrir" queda más
      corta (solo lo que haya en la propia ejecución), nunca inventar datos.
   b. **Yo (el asistente) escribo el contenido del informe** — no es un template
      rígido de relleno automático. Leo los datos reales (score y checks si los
      hay, `closeReason`, niveles técnicos congelados al entrar, duración,
      crédito/débito, R:R si `rrNote` marca algo fuera de rango) y redacto:
      - **Condiciones de mercado al abrir**: spxPrice/VIX/GEX (régimen, call
        wall/put wall/gamma flip) del `context` de la señal; si es Direccional o
        Reversión, la tabla de `checks` completa (label/peso/ok/valor) vía
        `section.checks` (ver `render_informe.py`); si es Iron Condor/Condor de
        débito, el motivo del gate (`signal.notes` o el equivalente en
        `strategy-log` con `stage: 'SIGNAL_BUILT'`).
      - **Estructura del trade**: estrategia, strikes (put/call según la familia
        — Iron Condor tiene 4 patas, direccional/reversión 2), expiry, contratos,
        crédito recibido o débito pagado, TP/SL configurado (`tpPct`/`slMult` o
        `debitTpPct`/`debitSlPct` según `isCredit`).
      - **Resultado**: el número que encabeza el informe es el de la **cadena
        real** — `ex.paperPnl.bruto` cuando `ex.paperPnl.confiable` es true — con
        su banner verde/rojo (`positive: paperPnl.bruto >= 0`). Ver la sección
        "El dinero sale de la cadena real" más abajo. El `ex.pnl` de Tradier va en
        la tabla de comparación, nunca en el banner. Si NO hay `paperPnl`
        confiable (registros anteriores al 2026-08-16, o un cierre que no marcó el
        libro), el banner lleva el número de Tradier **rotulado como tal** y el
        informe dice explícitamente que no hay medición en la cadena real.
      - **Condiciones de cierre**: traducir `closeReason` a una frase (`TP` =
        "cerró por Take Profit", `SL` = "cerró por Stop Loss", `TECHNICAL_STOP` =
        "cerró por invalidación técnica — precio rompió el Fractal 15m
        (`fractalLevel`) o el POC de sesión (`pocLevel`)" si esos campos están
        presentes en la ejecución, `MANUAL` = "se cerró fuera de los monitores
        automáticos (manual o vencimiento), reconciliado después por el sistema").
        Incluir duración (`closedAt - timestamp`, en minutos/segundos según
        corresponda al hold típico de la estrategia).
      - **Conclusiones**: 2-4 oraciones, la parte más importante — no repetir los
        datos de arriba, sintetizar el "por qué". Ejemplos de buen nivel de
        análisis (no copiar literal, adaptar a los datos reales de cada trade):
        "Trade ganador — el score de entrada (90%) reflejaba confluencia fuerte en
        Fase 2 en 2m y 15m, pero el volumen de rompimiento fue el único check que
        falló (0.09x); aun así el TP se alcanzó en X minutos, dentro del
        comportamiento esperado del setup." / "Trade perdedor por invalidación
        técnica — el score (81%) fue apenas superior al mínimo (80%), y el único
        check estructural débil (patrón HL/LH ok pero MACD sin pendiente clara)
        anticipaba que la tendencia podía no sostenerse; el precio rompió el
        Fractal 15m antes de dar tiempo al TP."
   c. Escribir el JSON de especificación (ver contrato de `render_informe.py`,
      dentro de `scripts/`) a un archivo temporal en el scratchpad de la sesión.
   d. Ejecutar: `python "C:\Users\gcarv\.claude\skills\informe-trade\scripts\render_informe.py" <spec.json>`
      con `output_path` ya apuntando directo a la carpeta de salida final (no hace
      falta mover el archivo después).
   e. Agregar el `id` al manifiesto (`ids`) y guardarlo — hacerlo INMEDIATAMENTE
      después de cada PDF generado con éxito (no esperar a procesar todos), para
      que un error a mitad de un lote grande no vuelva a regenerar los que ya
      salieron bien.
   f. Subir la copia a producción (2026-07-28): `POST
      https://web-production-23473.up.railway.app/api/informe-trade/upload` con
      body JSON `{ "executionId": ex.id, "filename": "<nombre_exacto_del_archivo.pdf>",
      "pdfBase64": "<contenido del PDF en base64>" }`. Ejemplo en Bash:
      ```
      curl -s -X POST https://web-production-23473.up.railway.app/api/informe-trade/upload \
        -H "Content-Type: application/json" \
        -d "{\"executionId\":\"$ID\",\"filename\":\"$NOMBRE\",\"pdfBase64\":\"$(base64 -w0 "$RUTA_PDF")\"}"
      ```
      El `filename` debe ser EXACTAMENTE el nombre del archivo tal como quedó
      guardado localmente en el paso `d` (incluyendo el sufijo `_2`/`_3` si
      aplicó) — es lo que usa el dashboard para armar el link. Si esta subida
      falla (sin internet, Railway caído, etc.): no revertir el paso `e` (el
      `id` ya generado localmente no debe regenerarse — el archivo local ya
      existe y es válido), simplemente avisar al usuario al final de la corrida
      qué PDFs no se pudieron subir. No hay reintento automático de solo-la-
      subida — si esto pasa seguido, hay que armar un paso de resincronización
      aparte en vez de asumir que ya quedó resuelto.
6. Al terminar, decirle al usuario cuántos informes nuevos se generaron y sus
   nombres de archivo (lista corta), y si alguno no se pudo subir a producción.
   Si fue invocado dentro de un `/loop` y no hay nada nuevo, no hace falta un
   mensaje largo — una línea basta.

## Diferencias por familia (campos a esperar en la ejecución)

- **NEUTRAL** (`IRON_CONDOR` / `DEBIT_PUT_CONDOR`): sin `playbook`/score — usar el
  `notes`/`creditReason` de la señal o el `reason` del log de estrategia
  (`stage: 'SIGNAL_BUILT'`) como explicación de entrada. Strikes de 4 patas
  (`shortStrike`/`longStrike` del put + `callShortStrike`/`callLongStrike`, o las 4
  del Condor de débito `outerLowStrike`/`innerLowStrike`/`innerHighStrike`/`outerHighStrike`).
  TP/SL: `tpPct`/`slMult` (crédito) o `debitTpPct`/`debitSlPct` (débito, campo
  `isCredit: false`).
- **TENDENCIA** (direccional): tiene `playbook.checks` completo (7 checks, pesos
  del modelo "Peso de la Evidencia"). Puede tener `fractalLevel`/`pocLevel`
  (niveles de invalidación técnica, relevantes si `closeReason === 'TECHNICAL_STOP'`).
- **REVERSION** (Alejamiento de SMA): tiene `playbook.checks` propio (6 checks,
  distintos pesos). Tiene `entryCandleLow`/`entryCandleHigh`/`smaTarget`/`pattern`
  (patrón de confirmación: `VELA_GARCIA`/`VELA_TIBURON`/`VELA_9`) — relevantes para
  explicar el TP (toque de SMA8) o SL (ruptura de la vela de entrada) sin importar
  `closeReason` (esta familia no usa `TECHNICAL_STOP`, cierra por precio del SPX
  directamente, ver `checkAlejamientoSMATPSLImpl` en `server.js`).

## Gráfico de entrada y salida (2026-08-11, a pedido del usuario)

Cada informe lleva un gráfico de velas con el momento exacto de **entrada** y de
**salida** marcados sobre el precio real. Es obligatorio: sin él, el informe
cuenta el trade en tablas pero no permite auditar el *timing*, que es justo donde
aparecieron los problemas.

Origen: *"hay algo en el timing de entrada y salida que no me convence y creo que
con el gráfico podemos mejorar esto"*. Y el primer gráfico ya lo mostró — el
trade `tex-1786372726651` (10-ago, 10:39) recorrió +6 pts a favor, los devolvió
enteros, salió **por debajo** de la entrada y quedó registrado como `TP` con
+$60. La direccional decide su salida con las cotizaciones de opciones que le
pide a Tradier, que en el sandbox llegan diferidas; el SPX del gráfico es en
vivo. Sin el gráfico eso era invisible.

**Cómo armarlo.** Antes de construir el spec, correr:

```
node C:/Users/gcarv/.claude/skills/informe-trade/scripts/velas_trade.mjs <executionId>
```

Devuelve por stdout el bloque `chart` ya listo (JSON). Acepta `--minutos=5` si el
trade duró horas y las velas de 2 min quedan demasiado apretadas; el default es
2 minutos, que es el marco de ejecución.

Ese bloque se mete como PRIMERA sección del informe:

```json
{"heading": "Entrada y salida sobre el precio", "chart": { ...lo que devolvió el script... }}
```

`render_informe.py` la dibuja con `draw_chart()`: velas verdes/rojas, línea
sólida en el precio de entrada, punteada en el de salida, etiqueta **BUY**/
**SELL** y **EXIT** en las velas correspondientes, y el recorrido entre las dos
sombreado en verde si el trade ganó o rojo si perdió. Al pie queda una línea que
dice cuánto se movió el SPX y si fue **a favor** o **en contra** de la posición —
esa frase es la que delata una salida mal cronometrada de un vistazo.

**Las velas salen de Sigma** (`I:SPX` vía su proxy de Polygon), la misma fuente
con la que el sistema decide. Usar Yahoo acá mostraría un gráfico distinto del
que vio el algoritmo, que es exactamente la confusión que esto viene a evitar.

Si el script no devuelve velas (trade de un día que ya no está en la ventana
descargable, o Sigma caído), se omite la sección y se sigue: el informe sin
gráfico es peor, pero no tener informe es peor todavía.

## Valor de cierre: Tradier vs cadena en vivo (2026-08-11)

Todo informe de una **direccional** lleva una sección que compara con cuánto
cerró Tradier contra cuánto habría cerrado con la cadena de opciones en vivo.

Por qué: la direccional decide su salida con las cotizaciones que le pide a
Tradier, y en el sandbox llegan diferidas. El 10-ago eso produjo tres cierres por
"TP" con el SPX ya movido **en contra** — el spread valía lo del TP según el
bróker mientras el índice se había dado vuelta. El usuario necesita cuantificar
eso en dólares para decidir si pasa a cuenta real: *"lo que necesitamos quitarnos
del medio es la duda de cuánto hubiera cerrado si la cadena de opciones estuviera
on line"*.

**El resultado que reporta Tradier se conserva, pero ya no manda.** Desde el
2026-08-20 el resultado de la bitácora es el de la cadena real (ver abajo); el
número de Tradier queda como referencia para cuadrar contra el broker.

Campos que deja el servidor en cada ejecución direccional:

- `cierreVivo` — `{netoTasty, pnlSiFueraEnVivo, at}`: cuánto valía el spread según
  TastyTrade en el instante en que se mandó el cierre, y el P&L que habría dado.
- `trazaCadena` — array `{t, tr, ty, d}` por cada ciclo del monitor (~30 s): el
  neto según Tradier (`tr`), según TastyTrade (`ty`) y la diferencia (`d`).
  Permite ver la curva completa de cómo se separaron las dos fuentes.

Si `cierreVivo` está presente, agregar esta tabla **después de "Condiciones de
cierre"**:

```json
{"heading": "Cierre segun Tradier vs cadena en vivo", "table": [
  ["Cerro Tradier (real)", "$60.00 — es el resultado que ocurrio"],
  ["Valor real en vivo",   "$-45.00 segun TastyTrade en el mismo instante"],
  ["Diferencia",           "$105.00 a favor del sandbox"],
  ["Separacion maxima",    "0.93 pts de spread, a los 12 min"]
]}
```

Los dos últimos salen de `trazaCadena`: la diferencia es
`pnl - cierreVivo.pnlSiFueraEnVivo`, y la separación máxima es el mayor `|d|` de
la traza con el minuto en que ocurrió.

Y una frase en la **Conclusión** diciendo qué implica: si el sandbox cerró mejor
que el mercado real, el resultado del día está inflado por el retraso; si cerró
peor, está castigado. Con varios trades acumulados eso es lo que responde si
conviene pasar a cuenta real.

Si `cierreVivo` no está (trade viejo, mercado cerrado al momento del cierre, o
TastyTrade sin responder), se omite la sección — nunca estimar el valor en vivo
con un modelo. `shadowExits` sí usa Black-Scholes con IV fija y sirve para
comparar reglas de salida entre sí, pero NO para esta comparación: mezclarlos
daría una cifra que parece medida y es teórica.

## Sección "Cadena real" (2026-08-11, a pedido del usuario)

**Esto es permanente y es ADITIVO.** Va en el informe de CADA trade, de ahora en
adelante, sin excepción — no es un apartado de una vez ni un experimento. Y **no
reemplaza ni recorta nada** de lo que el informe ya traía: gráfico de entrada/salida,
condiciones de mercado, tabla de checks, estructura, resultado y conclusión siguen
enteros. Esta sección se SUMA. Si al regenerar un informe falta alguno de los
apartados anteriores, está mal hecho.

Todo informe lleva un apartado **"Cadena real — qué habría pasado con cotizaciones
en vivo"**, entre el resultado y la conclusión. Nace de la pregunta que el usuario
quiere sacarse de encima antes de pasar a cuenta real: *"lo que necesitamos
quitarnos del medio es la duda de cuánto hubiera cerrado si la cadena de opciones
estuviera on line"*.

**El P&L de Tradier se conserva, en la tabla de comparación.** Desde el
2026-08-20 dejó de ser el resultado del informe (ver la sección siguiente).

De dónde sale el dato, en orden de preferencia:

1. **`ex.cierreVivo`** — cuanto valia el spread segun la cadena de TastyTrade en el
   instante en que se mando el cierre. Trae `netoTasty` y `pnlSiFueraEnVivo`.
   ⚠️ **NO es una verificacion independiente del libro propio** (error cometido y
   corregido el 2026-08-20): el servidor calcula `pnlSiFueraEnVivo` con la salida
   AL MEDIO (`mark`, sin cruzar el spread) contra la **entrada de Tradier**, o sea
   que es una cifra mixta. Sirve para mostrar el valor de salida en vivo; el
   resultado del trade es `paperPnl`. Rotularlos distinto — presentar este numero
   como "verificacion" le da un peso que no tiene.
2. **`/api/spx/sombra-cadenas?date=YYYY-MM-DD`** — el muestreo cada 5 min de las dos
   cadenas sobre strikes ATM. Si hay una muestra a pocos minutos del cierre, sirve
   como referencia del *signo y el orden de magnitud* del error, nunca como el valor
   del spread concreto: son strikes distintos y otra moneyness. Decirlo en el texto.
3. **Nada cerca** → decirlo. El resumen del endpoint da el error típico del día
   (`retrasoAbsMedianoPts`) y la antigüedad medida de las cotizaciones de Tradier
   (`edadCotizacionMedianaMin`, unos 15 min). Con eso se puede afirmar si el
   resultado del trade queda por debajo del ruido del broker — que muchas veces es
   la conclusión honesta.

⚠️ **Nunca inventar el número.** Si no hay medición cercana, el informe dice que no
la hay. Un valor "estimado" presentado como real en el apartado que existe justo
para decidir el paso a cuenta real sería el peor lugar posible para adornar.

**Ojo con los informes anteriores al 2026-08-11:** `cierreVivo` está vacío en las
158 ejecuciones previas. No es que no se capturara: `valorSpreadTasty` pegaba a
`/market-data/options` de TastyTrade, que devuelve **404**, y `getGreeks` se tragaba
el error con un `catch` vacío y caía a Black-Scholes. Al no ser dato de mercado, la
función devolvía `null` — correctamente. Corregido ese día para usar
`/api/option-chain/SPX`, la misma cadena que ya alimentaba el muestreo de sombra.

## El dinero sale de la cadena real (2026-08-20) — REGLA QUE MANDA

Regla del usuario, textual: *"la apertura y el cierre de cada trade se hace vs la
cadena de opciones real y no sobre lo que diga Tradier, que ya sabemos que tiene 15
minutos de retraso... lo que vea en la bitácora frente a temas de dinero debe estar
acotado a la cadena de opciones reales, no a Tradier."*

**El resultado de cada informe es `ex.paperPnl.bruto`**, el libro propio medido
contra la cadena de TastyTrade en vivo cruzando el spread (la corta se vendió al
bid, la larga se compró al ask). No `ex.pnl`. Lo mismo vale para el nombre del
archivo (`ganador`/`perdedor` + monto) y para el `gano` del bloque `chart` — si el
gráfico sombrea al revés que el banner, el informe se contradice solo.

Por qué: el sandbox de Tradier no solo cotiza con atraso, **llena** contra ese
libro viejo. Su fill no describe el trade que el algoritmo hizo. Los dos días que
lo destaparon (19 y 20 de agosto, 8 trades) daban esto:

```
              Tradier      cadena real
TP    ->        -$45           +$75
TP    ->        -$90          +$105
SL    ->        +$10          -$260
```

Con Tradier un TP podía terminar en pérdida y un SL en ganancia. Contra la cadena
real cada TP es ganancia y cada SL es pérdida, sin una sola excepción.

**Banner de dos cifras (obligatorio).** El `result_banner` lleva la cifra real a la
izquierda y la de Tradier a la derecha, en gris y mas chica — pedido explicito del
usuario el 2026-08-20: *"quiero que aparezca arriba, como esta, el valor real de
ganancia o perdida y a la derecha el segundo valor que tendria Tradier (el dato
retrasado 15 min)"*. Se pasa asi:

```json
"result_banner": {
  "label": "GANANCIA (cadena real)", "value": "+$105.00", "positive": true,
  "secondary": {"label": "Tradier (dato con 15 min de atraso)", "value": "-$90.00"}
}
```

`draw_banner` agranda el recuadro solo si viene `secondary`. Ver juntas las dos
cifras es el punto: hay trades donde ni el signo coincide.

**Campos:** `paperEntry.neto` (entrada), `paperExit.neto` (salida), `paperPnl`
(`bruto`, `neto` ya con comisión, `comisionAsumida`). Usar `bruto` para el banner y
mostrar el neto en la tabla — así el número es comparable con el de Tradier, que
tampoco lleva comisión descontada.

**Si falta `paperPnl`:** decirlo, no rellenar con Tradier en silencio. Es lo que
pasa con el cierre manual anterior al 2026-08-20 (`cerrarPosicionPorSimbolos` no
marcaba el libro; corregido ese día). Una reconstrucción a partir de otro trade
cercano se puede incluir en la conclusión **rotulada como estimación**, jamás en el
banner ni en el nombre del archivo.

## Formato del PDF (ajustado 2026-07-21, a pedido explícito del usuario)

`render_informe.py` ya aplica esto automáticamente — no hace falta pedir nada
especial al armar el spec JSON, solo pasar los `checks` tal cual vienen de
`playbook.checks` (incluyendo los de peso 0, el script los filtra solo):

- **La tabla de checks oculta los de peso 0** (`volumen_rompimiento`,
  `confirmacion_algoritmica` en el modelo direccional actual — cualquier check
  con `weight: 0` en general) — no aportan nada real a la decisión, solo
  ensuciaban la tabla.
- **Columna nueva "Pts"**: puntos ganados por check (`weight` si `ok`, si no
  `0`) — antes solo se veía el peso posible, no si realmente sumó.
- **Fila "TOTAL"** al final de la tabla de checks: suma de pesos, suma de
  puntos, y `Score: X/Y = Z%` — el score real del trade, visible sin sumar a
  mano.
- **Todo el informe entra en 1 página** (espaciado compactado en `draw_title`/
  `draw_banner`/`draw_meta`/`draw_heading`/`draw_table`/`draw_text`, margen de
  salto de página bajado de 18 a 14) — validado contra el trade real más denso
  del día (`tex-1784649941961`, 5 checks con peso + tabla de mercado + estructura
  + cierre + conclusión de 2 oraciones, cabe justo en una hoja A4).
- **Sección "Conclusión" ya era parte del contrato** (ver paso 5.b más arriba,
  "Conclusiones") — el ajuste de hoy fue asegurar que quepa en la misma página
  que el resto, no agregarla de cero. Ejemplo de buen nivel: "Todas las
  variables de peso real alineadas (100/100)... Confluencia perfecta se
  tradujo en ejecución limpia... Buen resultado de ejecución, coherente con la
  calidad de la entrada."
- Si en el futuro un trade tiene MUCHOS checks fallidos o un texto de
  conclusión muy largo, todavía puede desbordar a una 2da página — el
  `set_auto_page_break` sigue activo como red de seguridad, no se trunca
  contenido para forzar 1 página a cualquier costo.

## Notas

- No hace falta pedir confirmación al usuario antes de generar cada PDF — el
  usuario ya pidió explícitamente que esto sea automático y continuo.
- Si `python` no tiene `fpdf2` instalado en el momento de correr esto, avisar y
  detenerse — no hay fallback (confirmado disponible el 2026-07-15,
  `pip show fpdf2` → 2.8.7).
- El script de render (`scripts/render_informe.py`) ya sanitiza acentos/emoji
  (fuente core Latin-1, sin dependencias de archivos de fuente) — escribir el
  texto normal en español en el JSON, no hace falta evitar tildes ni ñ.
