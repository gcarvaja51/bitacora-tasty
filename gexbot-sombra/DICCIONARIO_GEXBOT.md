# Diccionario GexBot → nuestro análisis

Aprobado por Guillermo el 19-nov-2026. Regla: si es lo mismo que ya usamos, lleva nuestro nombre;
si es el mismo concepto con otro cálculo, lleva "GB"; si no existía, nombre nuevo (con la palabra
"gamma", no el símbolo Γ).

## Nuestros niveles (cálculo propio, regla Sigma, vencimiento del día, contratos abiertos)
- **Call Wall**: strike >= precio con más gamma de calls.
- **Put Wall**: strike <= precio con más gamma de puts.
- **MVS**: strike con más gamma absoluta (calls + puts, sin netear).
- **Gamma Flip**: precio donde la gamma total cambia de signo.

## GexBot Classic
| GexBot | Nombre nuestro | Relación con lo nuestro |
|---|---|---|
| Zero Gamma (volume) | **Gamma Flip GB** | Mismo concepto que Gamma Flip; base = volumen del día |
| Major Positive (volume) | **Imán + GB** | Parecido a Call Wall, no igual: gamma NETA (calls − puts), sin mirar el lado del precio |
| Major Negative (volume) | **Imán − GB** | Parecido a Put Wall; si domina lo negativo suele coincidir con MVS |
| Major Positive / Negative (open interest) | **Imán + GB (OI)** / **Imán − GB (OI)** | Igual que arriba, con contratos abiertos |
| Net GEX (volume / OI) | **Net GEX** | Igual a nuestro Net GEX / régimen |
| Max Change 1/5/10/15/30 min | **Cambio gamma 1m…30m** | Nuevo: strike donde más cambió la gamma en esa ventana |

## GexBot State
| GexBot | Nombre nuestro | Qué significa |
|---|---|---|
| Major Long Gamma | **Freno gamma** | Strike donde los creadores de mercado están más largos en gamma: frenan el precio |
| Major Short Gamma | **Acelerador gamma** | Strike donde están más cortos en gamma: aceleran el precio |
| ±1σ | **Mov. esperado** | Movimiento esperado del día |

## Colores del histograma
- Rojo = gamma negativa (acelera, régimen de tendencia). Verde = gamma positiva (frena, régimen de rango).
- El color NO es alcista/bajista.
- **Barra clara = gamma por VOLUMEN (flujo del día). Barra oscura debajo = gamma por OPEN INTEREST (posicionamiento acumulado)** (comprobado 23-nov con la captura del 20-nov 9:45). Pueden apuntar a lados opuestos: clara verde + oscura roja = el flujo de hoy va contra lo acumulado (el nivel puede ceder); mismo lado = el flujo refuerza.

## Valores de referencia 19-nov-2026 (cierre)
Gamma Flip GB 7395 vs Gamma Flip 7360 · Imán + GB 7400 vs Call Wall 7210 · Imán − GB 7175 = Put Wall 7175 = MVS 7175 ·
Imán + GB (OI) 6935 · Cambio gamma 1m…30m = 7175 · Freno gamma 7170,57 · Acelerador gamma 7179,98 · Mov. esperado 7143,63–7210.
