# TrendTrack Maurito

Herramienta tipo **TrendTrack** para espiar tiendas Shopify, productos y anuncios, **vinculada a Claude por MCP**.

- **Servidor MCP**: Claude Desktop, Claude Code o claude.ai pueden usar TrendTrack directamente (rastrear tiendas, buscar productos y anuncios, ver alertas, guardar en tableros) con tu plan de Claude.
- **Claude dentro de la app** (pestaña *Claude IA*): usa tu API key de Anthropic y sus créditos. Claude busca en internet y usa las mismas herramientas del servidor MCP.

## Funciones

| Función | Qué hace |
|---|---|
| **Rastreo de tiendas** | Descarga el catálogo completo de cualquier tienda Shopify (`/products.json`), con precios, descuentos, fechas de lanzamiento y ranking de más vendidos (si la tienda lo expone). |
| **Tecnología de la tienda** | Detecta el tema de Shopify, unas 50 apps (Klaviyo, Loox, Judge.me, ReCharge, PageFly…), píxeles (Meta, TikTok, Google, Snapchat, Pinterest) y redes sociales. |
| **Explorador de tiendas** | Filtra por nicho, país, tema, app o píxel. Ordena por actividad, lanzamientos, nº de productos, precio medio o anuncios activos. |
| **Explorador de productos** | Busca en todas las tiendas: palabras clave, precio, antigüedad (7/30/90 días), más vendidos, mayor descuento. Incluye historial de precios. |
| **Seguimiento diario** | Re-escanea las tiendas cada 24 h y detecta productos nuevos, cambios de precio, productos retirados y nuevos anuncios. |
| **Alertas** | Lista de todos esos cambios, filtrable por tipo y por tienda. |
| **Anuncios** | Meta Ad Library API (si configuras el token): anuncios activos ordenados por días en circulación y conteo de anuncios por tienda. Enlaces directos a Meta, TikTok Creative Center, TikTok Ads Library y Google Ads Transparency. |
| **Tableros** | Guarda productos, tiendas y anuncios en tableros de favoritos. |
| **Exportar CSV** | Tiendas y productos (con los filtros aplicados) para Excel / Google Sheets. |
| **Investigación con Claude** | Productos ganadores, encontrar tiendas, analizar una tienda o producto, anuncios que funcionan. Claude puede agregar tiendas al rastreador por su cuenta. |

## Instalación

Necesitas [Node.js](https://nodejs.org) 20 o superior.

```bash
git clone <este repo>
cd trendtrackmaurito
npm install
cp .env.example .env     # opcional: pon aquí tu ANTHROPIC_API_KEY
npm start
```

Abre <http://localhost:3000>.

## Vincular con Claude por MCP

En la app, **Ajustes y MCP** muestra la configuración exacta para tu equipo, con la ruta ya completada.

### Claude Desktop

Ajustes → Desarrollador → Editar configuración (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "trendtrack": {
      "command": "node",
      "args": ["/RUTA/A/trendtrackmaurito/src/mcp-stdio.js"]
    }
  }
}
```

Reinicia Claude Desktop y pídele, por ejemplo: *"Rastrea la tienda gymshark.com y dime sus productos más vendidos"*.

### Claude Code

```bash
claude mcp add trendtrack -- node /RUTA/A/trendtrackmaurito/src/mcp-stdio.js
```

### claude.ai (conector personalizado por HTTP)

Con la app en marcha, el servidor MCP está en `http://localhost:3000/mcp`. claude.ai necesita una URL pública con HTTPS, así que:

1. Define `MCP_TOKEN` (y `APP_PASSWORD`) en `.env`.
2. Publica la app en un servidor, o exponla con un túnel, por ejemplo `cloudflared tunnel --url http://localhost:3000`.
3. En claude.ai: Ajustes → Conectores → Añadir conector personalizado → `https://TU-URL/mcp?token=TU_MCP_TOKEN`.

### Herramientas MCP

| Herramienta | Descripción |
|---|---|
| `dashboard` | Resumen general y últimas alertas |
| `search_stores` | Explorar tiendas con filtros |
| `get_store` | Ficha completa de una tienda |
| `track_store` | Agregar o re-escanear una tienda |
| `set_store_notes` | Guardar nicho y notas |
| `search_products` | Explorar productos |
| `get_product` | Producto con historial de precios |
| `search_ads` | Anuncios de Meta + enlaces a bibliotecas de anuncios |
| `recent_alerts` | Productos nuevos, cambios de precio, etc. |
| `list_boards` / `save_to_board` | Tableros de favoritos |

Prompts incluidos: `productos_ganadores` y `analizar_tienda`.

## Claude dentro de la app (API key y créditos)

1. Crea una API key en <https://platform.claude.com/settings/keys> y añade créditos en *Billing*.
2. Pégala en **Ajustes** (o en `ANTHROPIC_API_KEY` dentro de `.env`) y pulsa *Probar conexión*.
3. Elige modelo (Claude Opus 5.5 por defecto, o Claude Sonnet 5.5, más barato) y profundidad de investigación.

La app muestra un **coste estimado** según tokens y búsquedas web (10 USD por cada 1000 búsquedas). El importe exacto aparece en la consola de Anthropic.

Detalles técnicos: `src/claude.js` usa el SDK oficial `@anthropic-ai/sdk` con streaming, thinking adaptativo, búsqueda y lectura web del lado del servidor (`web_search_20260209`, `web_fetch_20260209`), caché del prompt y reintento automático con otro modelo si los filtros de seguridad rechazan una petición (`fallbacks: "default"`). Las herramientas de TrendTrack llegan al modelo a través del propio servidor MCP de la app, conectado en memoria.

## Limitaciones (sé honesto con los datos)

TrendTrack tiene una base de datos propia con millones de tiendas y estimaciones de tráfico e ingresos. Esta app trabaja **solo con datos públicos**:

- **No hay base de datos global de tiendas**: tú (o Claude) agregáis las tiendas que queréis seguir. Usa la pestaña *Claude IA* o el MCP para descubrir tiendas por nicho.
- **Ventas e ingresos**: no se inventan cifras. La app mide señales reales (lanzamientos, ranking de más vendidos, productos actualizados, anuncios activos) y resume la actividad en una *puntuación*. Claude puede razonar una estimación si se lo pides, explicando en qué se basa.
- **Anuncios dentro de la app**: la API de Meta solo devuelve anuncios comerciales publicados en la UE o Reino Unido, y requiere `META_ACCESS_TOKEN`. Sin token tienes los enlaces directos a cada biblioteca de anuncios.
- Solo funciona con tiendas **Shopify**; algunas bloquean `/products.json`.

## Estructura

```
src/
  server.js      Servidor web (API REST + MCP por HTTP en /mcp)
  mcp.js         Definición del servidor MCP (herramientas y prompts)
  mcp-stdio.js   Servidor MCP por stdio (Claude Desktop / Claude Code)
  claude.js      Investigación con Claude (API de Anthropic)
  shopify.js     Rastreo de tiendas, productos, alertas y filtros
  intel.js       Detección de tema, apps, píxeles y redes sociales
  ads.js         Meta Ad Library y enlaces a bibliotecas de anuncios
  boards.js      Tableros de favoritos
  export.js      Exportación CSV
  db.js          Almacenamiento en data/db.json
public/          Interfaz web
test/            Pruebas (npm test), con una tienda Shopify y un API de Claude simulados
```

Los datos (tiendas, productos, conversaciones y tu API key si la guardas desde la app) se guardan en `data/db.json`, que no se sube a git.
