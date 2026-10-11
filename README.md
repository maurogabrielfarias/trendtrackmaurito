# TrendTrack Maurito

Herramienta tipo **TrendTrack** para espiar tiendas Shopify, productos y anuncios. Funciona **100 % online en Cloudflare** y está **vinculada a Claude por MCP**.

- **Servidor MCP**: claude.ai, Claude Desktop, la app móvil de Claude y Claude Code usan TrendTrack directamente (rastrear tiendas, buscar productos y anuncios, ver alertas, guardar en tableros) con tu plan de Claude.
- **Claude dentro de la app** (pestaña *Claude IA*): usa tu API key de Anthropic y sus créditos. Claude busca en internet y usa las mismas herramientas del servidor MCP.

## Publicar en Cloudflare (con Claude Code)

Necesitas una cuenta gratis de Cloudflare, Node.js 22.18 o superior y Claude Code (ver la guía de Cloudflare para agentes: <https://developers.cloudflare.com/agent-setup/claude-code/>).

Abre Claude Code en una carpeta vacía y pega este prompt:

```text
Quiero publicar mi app TrendTrack Maurito en Cloudflare. Soy principiante: explícame cada paso en palabras simples.
1. Clona https://github.com/maurogabrielfarias/trendtrackmaurito (rama claude/eager-hamilton-x1l8sb) y corre npm install.
2. Inicia sesión en Cloudflare con: npx wrangler login (avísame para aprobarlo en el navegador) y confirma con npx wrangler whoami.
3. Crea la base de datos con: npx wrangler d1 create trendtrack, y pon el database_id que te devuelva en wrangler.jsonc.
4. Guarda estos secretos con npx wrangler secret put (yo escribo los valores, tú nunca los veas ni los pongas en el código):
   APP_PASSWORD (contraseña para entrar a la app), MCP_TOKEN (código largo para conectar Claude),
   ANTHROPIC_API_KEY (mi API key de Anthropic) y, si tengo, META_ACCESS_TOKEN.
   Para MCP_TOKEN, genera un valor aleatorio con: node -e "console.log(crypto.randomUUID())" y muéstramelo para que lo guarde.
5. Publica con: npm run deploy, y dame el link .workers.dev.
Pregúntame antes de hacer cualquier cosa que cueste dinero o que borre algo.
```

> El proyecto usa `wrangler.jsonc`, así que se publica con Wrangler (es lo que la guía de Cloudflare indica cuando el proyecto ya tiene archivo de Wrangler).

Al terminar tendrás un link como `https://trendtrack-maurito.<tu-cuenta>.workers.dev`. Entra con cualquier usuario y la contraseña `APP_PASSWORD`.

### Conectar Claude por MCP

En la app, **Ajustes y MCP** muestra tu URL exacta.

- **claude.ai / Claude Desktop / app móvil**: Ajustes → Conectores → Añadir conector personalizado →
  `https://trendtrack-maurito.<tu-cuenta>.workers.dev/mcp?token=TU_MCP_TOKEN`
- **Claude Code**:
  ```bash
  claude mcp add --transport http trendtrack https://trendtrack-maurito.<tu-cuenta>.workers.dev/mcp --header "Authorization: Bearer TU_MCP_TOKEN"
  ```

Prueba: *"Rastrea la tienda gymshark.com y dime sus productos más vendidos"*.

## Funciones

| Función | Qué hace |
|---|---|
| **Rastreo de tiendas** | Descarga el catálogo completo de cualquier tienda Shopify (`/products.json`), con precios, descuentos, fechas de lanzamiento y ranking de más vendidos (si la tienda lo expone). |
| **Tecnología de la tienda** | Detecta el tema de Shopify, unas 50 apps (Klaviyo, Loox, Judge.me, ReCharge, PageFly…), píxeles (Meta, TikTok, Google, Snapchat, Pinterest) y redes sociales. |
| **Explorador de tiendas** | Filtra por nicho, país, tema, app o píxel. Ordena por actividad, lanzamientos, nº de productos, precio medio o anuncios activos. |
| **Explorador de productos** | Busca en todas las tiendas: palabras clave, precio, antigüedad (7/30/90 días), más vendidos, mayor descuento. Incluye historial de precios. |
| **Seguimiento automático** | Un Cron de Cloudflare re-escanea cada tienda una vez al día y detecta productos nuevos, cambios de precio, productos retirados y nuevos anuncios. |
| **Alertas** | Lista de todos esos cambios, filtrable por tipo y por tienda. |
| **Anuncios** | Meta Ad Library API (si guardas `META_ACCESS_TOKEN`): anuncios activos ordenados por días en circulación y conteo de anuncios por tienda. Enlaces directos a Meta, TikTok Creative Center, TikTok Ads Library y Google Ads Transparency. |
| **Tableros** | Guarda productos, tiendas y anuncios en tableros de favoritos. |
| **Exportar CSV** | Tiendas y productos (con los filtros aplicados) para Excel / Google Sheets. |
| **Investigación con Claude** | Productos ganadores, encontrar tiendas, analizar una tienda o producto, anuncios que funcionan. Claude puede agregar tiendas al rastreador por su cuenta. |

## Claude dentro de la app (API key y créditos)

1. Crea una API key en <https://platform.claude.com/settings/keys> y añade créditos en *Billing*.
2. Guárdala como secreto: `npx wrangler secret put ANTHROPIC_API_KEY` (nunca se guarda en la base de datos ni en el código).
3. En **Ajustes** elige modelo (Claude Opus 5.5 por defecto, o Claude Sonnet 5.5, más barato) y profundidad, y pulsa *Probar conexión*.

La app muestra un **coste estimado** según tokens y búsquedas web (10 USD por cada 1000 búsquedas). El importe exacto aparece en la consola de Anthropic.

Detalles técnicos: `src/claude.js` usa el SDK oficial `@anthropic-ai/sdk` con streaming, thinking adaptativo, búsqueda y lectura web del lado del servidor (`web_search_20260209`, `web_fetch_20260209`), caché del prompt y reintento automático con otro modelo si los filtros de seguridad rechazan una petición (`fallbacks: "default"`). Las herramientas de TrendTrack llegan al modelo a través del propio servidor MCP de la app, conectado en memoria.

## Plan gratis de Cloudflare: qué esperar

La app usa Workers, D1 (base de datos), archivos estáticos y Cron, todos con plan gratis. Cuidado con esto:

- **10 ms de CPU por petición** en el plan gratis. Rastrear tiendas pequeñas y medianas funciona; tiendas con miles de productos o investigaciones largas con Claude pueden dar error de límite de CPU. Si pasa, el plan **Workers Paid (5 USD/mes)** lo resuelve. Cloudflare no te cobra de más en el plan gratis: simplemente da error.
- **D1**: 100.000 filas escritas al día. La app solo reescribe los productos que cambian, para gastar poco.
- **Cron**: cada 30 minutos re-escanea 2 tiendas (las que llevan más de 24 h sin escanear). Ajustable con `RESCAN_HOURS` y `RESCAN_BATCH` en `wrangler.jsonc`.

## Limitaciones (sé honesto con los datos)

TrendTrack tiene una base de datos propia con millones de tiendas y estimaciones de tráfico e ingresos. Esta app trabaja **solo con datos públicos**:

- **No hay base de datos global de tiendas**: tú (o Claude) agregáis las tiendas que queréis seguir. Usa la pestaña *Claude IA* o el MCP para descubrir tiendas por nicho.
- **Ventas e ingresos**: no se inventan cifras. La app mide señales reales (lanzamientos, ranking de más vendidos, productos actualizados, anuncios activos) y las resume en una *puntuación de actividad*. Claude puede razonar una estimación si se lo pides, explicando en qué se basa.
- **Anuncios dentro de la app**: la API de Meta solo devuelve anuncios comerciales publicados en la UE o Reino Unido, y requiere `META_ACCESS_TOKEN`. Sin token tienes los enlaces directos a cada biblioteca de anuncios.
- Solo funciona con tiendas **Shopify**; algunas bloquean `/products.json`.

## Desarrollo local

```bash
npm install
cp .dev.vars.example .dev.vars   # pon tus valores
npm run dev                      # http://localhost:8787
npm test                         # pruebas con tienda Shopify y API de Claude simulados
```

## Estructura

```
src/
  worker.js      Worker de Cloudflare: API, contraseña, MCP en /mcp, interfaz y Cron
  mcp.js         Servidor MCP (herramientas y prompts)
  claude.js      Investigación con Claude (API de Anthropic)
  shopify.js     Rastreo de tiendas, productos, alertas y filtros (D1)
  intel.js       Detección de tema, apps, píxeles y redes sociales
  ads.js         Meta Ad Library y enlaces a bibliotecas de anuncios
  boards.js      Tableros de favoritos
  export.js      Exportación CSV
  db.js          Acceso a D1
migrations/      Esquema de la base de datos D1
public/          Interfaz web
test/            Pruebas de punta a punta con wrangler dev
wrangler.jsonc   Configuración de Cloudflare
```
