# Históricos para backtesting

Rama **`historicos`** del repo bitacora-tasty. Solo datos, sin código. La rama `main` (la que despliega Railway) no se toca desde aquí.

La actualiza sola `gexbot-sombra/guardar_historicos.py`. La lanza `confluencia_diaria.cmd` al terminar cada sesión de mercado.

## Estructura (por día AAAA-MM-DD)

| Ruta | Qué es | Fuente |
|---|---|---|
| `discord/<día>/confluencia.jsonl` | Un registro por ciclo (~3 min): lecturas de GexBot Classic (Gamma Flip GB, imanes, histograma, cambio gamma) y State, Tradytics, HIRO real (curva), Bola 8, option flow; SPX; fases Weinstein 5m/2m; votos; lecturas A (tendencia) y B (fade) | Motor en sombra del PC (`confluencia.py`) |
| `discord/<día>/barridos.jsonl` | Qué capturó cada barrido de Discord y a qué hora | `barrido_discord.mjs` |
| `discord/<día>/bola8_*_texto.txt` | Informes de la Bola 8 publicados en texto (hora UTC en el nombre) | Discord |
| `gexbot_propio/historial_<día>.jsonl` | Nuestro cálculo estilo GexBot (zero gamma, imanes, net GEX, max change) desde la cadena de opciones | `gexbot_propio.py` |
| `produccion/capas/<día>.jsonl` | Lo que recibió la bitácora para la hoja Hiro por capas (versión saneada de las lecturas) | `/api/capas` |
| `produccion/hiro/<día>.json` | HIRO propio minuto a minuto (`filas`: calls, puts y total acumulados en USD de cobertura) y velas de 1 min del SPX (`velas`) | `/api/hiro` (dxLink de TastyTrade) |
| `indice.json` | Cuántos registros hay de cada cosa por día | generado |

## Notas

- **Horas:** todas en Nueva York, salvo los sellos `at` de `barridos.jsonl` (UTC, con Z) y los nombres de la Bola 8 (UTC).
- **Capturas PNG:** no se guardan aquí (≈30 MB por día). Quedan en `gexbot-sombra/capturas/<día>/`. Con ellas, `recargar_capas.py` vuelve a leer un día con el lector corregido.
- **Lecturas antiguas:** las lecturas del 19 y 20-nov-2026 se hicieron con versiones anteriores del lector. Los arreglos de OCR están descritos en los commits de bitacora-tasty del 20 y 21-nov.
- **Uso:** solo datos informativos. Ninguna estrategia opera con ellos todavía.
