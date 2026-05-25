# Bitácora Tasty 📊

Dashboard de trading profesional en tiempo real para TastyTrade.
Inspirado en TraderSync Pro — conectado directo a tu cuenta.

## Stack
- **Backend**: Node.js + Express
- **Frontend**: HTML/CSS/JS puro + Chart.js
- **Datos**: TastyTrade REST API (real-time)
- **Deploy**: Railway

## Features
- ✅ Dashboard con KPIs en tiempo real
- ✅ Curva de capital (NLV history)
- ✅ Calendario P&L por día (estilo TraderSync)
- ✅ Monitor de posiciones abiertas con DTE y % capturado
- ✅ Historial completo con filtros por fecha
- ✅ Reportes: Win Rate, Profit Factor, by underlying, by semana
- ✅ Análisis de estrategias cerradas (round-trips)
- ✅ Sección "Hoy" con operaciones del día
- ✅ Auto-refresh cada 90 segundos

## Setup Local

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables
cp .env.example .env
# editar .env con tus credenciales

# 3. Correr
npm start        # producción
npm run dev      # desarrollo con hot-reload
```

## Deploy en Railway

1. Sube el código a GitHub: `gcarvaja51/bitacora_tastyrade`
2. En Railway → New Project → Deploy from GitHub
3. Agrega las variables de entorno:
   - `TT_USERNAME`
   - `TT_REMEMBER_TOKEN`
   - `TT_ACCOUNT_NUMBER`
4. Railway detecta el `Procfile` y levanta el servidor

## Obtener el Remember Token

```bash
curl -X POST https://api.tastytrade.com/sessions \
  -H "Content-Type: application/json" \
  -d '{"login":"tu_email","password":"tu_pass","remember-me":true}'
```
Copia el campo `remember-token` de la respuesta.
El token dura ~30 días. Cuando expire, repite el proceso.

## API Endpoints

| Ruta | Descripción | Cache |
|------|-------------|-------|
| `GET /api/overview` | Balance + posiciones | 60s |
| `GET /api/curve` | NLV history + calendario | 5min |
| `GET /api/transactions` | Historial + métricas | 2min |
| `GET /api/today` | Operaciones de hoy | 30s |
| `POST /api/refresh` | Limpia el caché | — |
| `GET /api/health` | Status de conexión | — |

---
Cuenta: Individual 5WZ83584 · Bitácora generada automáticamente desde TastyTrade
