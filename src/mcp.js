// Servidor MCP: expone TrendTrack Maurito como herramientas para Claude
// (Claude Desktop, Claude Code o claude.ai como conector personalizado).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, save } from "./db.js";
import {
  scanStore,
  markScanError,
  searchStores,
  storeFacets,
  searchProducts,
  getProduct,
  recentEvents,
  dashboardStats,
  normalizeOrigin,
  storeIdFromOrigin,
} from "./shopify.js";
import { adLibraryLinks, searchMetaAds, trackStoreAds } from "./ads.js";
import { listBoards, addToBoard, getBoard } from "./boards.js";

const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (message) => ({ content: [{ type: "text", text: message }], isError: true });

function compactProduct(p) {
  return {
    key: p.key,
    title: p.title,
    store: p.storeId,
    price: p.price,
    compareAtPrice: p.compareAtPrice,
    discountPct: p.discountPct,
    currency: p.currency,
    type: p.productType,
    vendor: p.vendor,
    createdAt: p.createdAt,
    bestSellerRank: p.bestSellerRank,
    url: p.url,
    image: p.image,
  };
}

function compactStore(s) {
  return {
    id: s.id,
    name: s.name,
    url: s.origin,
    niche: s.niche,
    country: s.country,
    currency: s.currency,
    productCount: s.productCount,
    avgPrice: s.avgPrice,
    launched7d: s.launched7d,
    launched30d: s.launched30d,
    activityScore: s.activityScore,
    activeAds: s.ads?.active ?? null,
    theme: s.tech?.theme ?? null,
    apps: s.tech?.apps ?? [],
    pixels: s.tech?.pixels ?? [],
    lastScanAt: s.lastScanAt,
  };
}

async function trackWithAds(domain) {
  try {
    const { store, scan } = await scanStore(domain);
    const ads = await trackStoreAds(store.id).catch(() => null);
    return { store: { ...compactStore(store), tech: store.tech, ads }, scan };
  } catch (err) {
    markScanError(domain, err);
    throw err;
  }
}

export function createMcpServer() {
  const server = new McpServer({ name: "trendtrack-maurito", version: "0.1.0" });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    "dashboard",
    {
      title: "Resumen del dashboard",
      description: "Resumen general: tiendas rastreadas, productos, lanzamientos de la semana, anuncios activos, tiendas más activas y últimas alertas.",
      annotations: readOnly,
    },
    async () => json(dashboardStats()),
  );

  server.registerTool(
    "search_stores",
    {
      title: "Explorar tiendas",
      description:
        "Busca y filtra las tiendas Shopify rastreadas por texto, nicho, país, moneda, tema, app instalada o píxel. Ordena por actividad, lanzamientos, nº de productos, precio medio o anuncios activos.",
      inputSchema: {
        query: z.string().optional().describe("Texto libre (nombre, dominio, nicho, notas)"),
        niche: z.string().optional(),
        country: z.string().optional().describe("Código de país, ej: US, ES"),
        currency: z.string().optional().describe("Ej: USD, EUR"),
        theme: z.string().optional().describe("Tema de Shopify, ej: Dawn"),
        app: z.string().optional().describe("App instalada, ej: Klaviyo, Loox"),
        pixel: z.string().optional().describe("Ej: Meta Pixel, TikTok Pixel"),
        min_products: z.number().optional(),
        sort: z.enum(["added", "activity", "launched", "products", "price", "ads"]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: readOnly,
    },
    async (a) => {
      const list = searchStores({
        q: a.query,
        niche: a.niche,
        country: a.country,
        currency: a.currency,
        theme: a.theme,
        app: a.app,
        pixel: a.pixel,
        minProducts: a.min_products,
        sort: a.sort,
      });
      return json({ total: list.length, stores: list.slice(0, a.limit || 50).map(compactStore), filters: storeFacets() });
    },
  );

  server.registerTool(
    "get_store",
    {
      title: "Detalle de tienda",
      description:
        "Ficha completa de una tienda rastreada: tecnología (tema, apps, píxeles, redes sociales), historial de escaneos, anuncios activos, productos más nuevos y más vendidos.",
      inputSchema: { store: z.string().describe("Dominio de la tienda, ej: tienda.com") },
      annotations: readOnly,
    },
    async ({ store }) => {
      let id;
      try {
        id = storeIdFromOrigin(normalizeOrigin(store));
      } catch {
        return fail("Dominio inválido");
      }
      const s = db().stores[id];
      if (!s) return fail(`La tienda ${id} no está rastreada. Usa track_store para agregarla.`);
      return json({
        ...compactStore(s),
        description: s.description,
        notes: s.notes,
        tech: s.tech,
        ads: s.ads || null,
        scans: (s.scans || []).slice(-15),
        newestProducts: searchProducts({ storeId: id, sort: "newest", limit: 25 }).products.map(compactProduct),
        bestSellers: s.hasBestSellerRanking
          ? searchProducts({ storeId: id, sort: "bestseller", limit: 25 }).products.map(compactProduct)
          : "La tienda no expone su ranking de más vendidos",
        recentEvents: recentEvents({ storeId: id, limit: 20 }),
      });
    },
  );

  server.registerTool(
    "track_store",
    {
      title: "Rastrear tienda",
      description:
        "Agrega una tienda Shopify al rastreador (o la vuelve a escanear): descarga todo su catálogo, detecta tema/apps/píxeles y, si hay token de Meta, cuenta sus anuncios activos.",
      inputSchema: { domain: z.string().describe("Dominio de la tienda Shopify, ej: tienda.com") },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ domain }) => {
      try {
        return json(await trackWithAds(domain));
      } catch (err) {
        return fail(`No se pudo rastrear ${domain}: ${err.message}`);
      }
    },
  );

  server.registerTool(
    "set_store_notes",
    {
      title: "Anotar tienda",
      description: "Guarda el nicho y/o notas de una tienda rastreada.",
      inputSchema: { store: z.string(), niche: z.string().optional(), notes: z.string().optional() },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ store, niche, notes }) => {
      const s = db().stores[storeIdFromOrigin(normalizeOrigin(store))];
      if (!s) return fail("Tienda no rastreada");
      if (niche !== undefined) s.niche = niche.slice(0, 200);
      if (notes !== undefined) s.notes = notes.slice(0, 2000);
      save();
      return json(compactStore(s));
    },
  );

  server.registerTool(
    "search_products",
    {
      title: "Explorar productos",
      description:
        "Busca productos en todas las tiendas rastreadas. Filtra por palabras clave, tienda, precio, tipo, proveedor y antigüedad; ordena por más nuevos, más vendidos, descuento o precio.",
      inputSchema: {
        query: z.string().optional(),
        store: z.string().optional().describe("Dominio para limitar a una tienda"),
        min_price: z.number().optional(),
        max_price: z.number().optional(),
        product_type: z.string().optional(),
        vendor: z.string().optional(),
        days: z.number().optional().describe("Solo productos creados en los últimos N días"),
        sort: z.enum(["newest", "oldest", "bestseller", "discount", "price_asc", "price_desc"]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: readOnly,
    },
    async (a) => {
      const r = searchProducts({
        q: a.query,
        storeId: a.store ? storeIdFromOrigin(normalizeOrigin(a.store)) : "",
        minPrice: a.min_price,
        maxPrice: a.max_price,
        productType: a.product_type,
        vendor: a.vendor,
        days: a.days,
        sort: a.sort,
        limit: a.limit || 50,
      });
      return json({ total: r.total, products: r.products.map(compactProduct) });
    },
  );

  server.registerTool(
    "get_product",
    {
      title: "Detalle de producto",
      description: "Detalle de un producto rastreado con su historial de precios. Usa la 'key' que devuelve search_products.",
      inputSchema: { key: z.string().describe("Clave tienda:id del producto") },
      annotations: readOnly,
    },
    async ({ key }) => {
      const p = getProduct(key);
      return p ? json(p) : fail("Producto no encontrado");
    },
  );

  server.registerTool(
    "search_ads",
    {
      title: "Buscar anuncios",
      description:
        "Busca anuncios activos en la Meta Ad Library (Facebook/Instagram) por producto, marca o dominio, ordenados por días activos (los que más tiempo llevan suelen ser rentables). Siempre devuelve enlaces a Meta, TikTok y Google Ads Transparency.",
      inputSchema: {
        term: z.string(),
        country: z.string().optional().describe("País UE/UK donde se publicaron, ej: ES, FR, DE (por defecto ES)"),
        min_days_running: z.number().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ term, country, min_days_running }) => {
      const links = adLibraryLinks(term);
      try {
        const r = await searchMetaAds({ term, country: country || "ES", limit: 100 });
        const ads = r.ads.filter((ad) => !min_days_running || (ad.daysRunning ?? 0) >= min_days_running);
        return json({
          links,
          metaApiConfigured: r.configured,
          note: r.configured ? undefined : "Sin META_ACCESS_TOKEN: usa los enlaces o tu búsqueda web para ver los anuncios.",
          total: ads.length,
          ads: ads.slice(0, 40),
        });
      } catch (err) {
        return json({ links, error: err.message });
      }
    },
  );

  server.registerTool(
    "recent_alerts",
    {
      title: "Alertas recientes",
      description: "Últimos cambios detectados en las tiendas rastreadas: productos nuevos, cambios de precio, productos retirados, nuevos anuncios.",
      inputSchema: {
        type: z.enum(["new_product", "price_change", "removed_product", "new_ads", "store_added"]).optional(),
        store: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: readOnly,
    },
    async (a) =>
      json(
        recentEvents({
          type: a.type,
          storeId: a.store ? storeIdFromOrigin(normalizeOrigin(a.store)) : "",
          limit: a.limit || 50,
        }),
      ),
  );

  server.registerTool(
    "list_boards",
    { title: "Tableros", description: "Lista los tableros de favoritos y, si se indica uno, su contenido.", inputSchema: { board_id: z.string().optional() }, annotations: readOnly },
    async ({ board_id }) => (board_id ? json(getBoard(board_id) || "Tablero no encontrado") : json(listBoards().map((b) => ({ id: b.id, name: b.name, items: b.items.length })))),
  );

  server.registerTool(
    "save_to_board",
    {
      title: "Guardar en tablero",
      description: "Guarda un producto (key), tienda (dominio) o anuncio (id) en un tablero de favoritos. Si el tablero no existe se crea.",
      inputSchema: {
        board: z.string().describe("Nombre o id del tablero"),
        type: z.enum(["product", "store", "ad"]),
        ref: z.string().describe("key del producto, dominio de la tienda o id del anuncio"),
        note: z.string().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ board, type, ref, note }) => {
      const data = type === "product" ? getProduct(ref) : type === "store" ? db().stores[ref] : {};
      if (type !== "ad" && !data) return fail(`No se encontró ${type} ${ref}`);
      const b = addToBoard(board, { type, ref, note, data: { title: data?.title || data?.name || ref } });
      return json({ id: b.id, name: b.name, items: b.items.length });
    },
  );

  server.registerPrompt(
    "productos_ganadores",
    {
      title: "Encontrar productos ganadores",
      description: "Investiga productos ganadores para un nicho y mercado",
      argsSchema: { nicho: z.string(), pais: z.string().optional() },
    },
    ({ nicho, pais }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Encuentra productos ganadores del nicho "${nicho}"${pais ? ` para vender en ${pais}` : ""}.
1. Revisa con search_products y recent_alerts qué están lanzando las tiendas que ya rastreo.
2. Busca en la web tiendas Shopify y anuncios de este nicho; rastrea las 3 más prometedoras con track_store.
3. Revisa anuncios con search_ads (los que llevan más días activos).
Entrega una tabla con: producto, tienda, precio, señales de que funciona, ángulo de marketing y riesgo.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "analizar_tienda",
    {
      title: "Analizar tienda",
      description: "Análisis completo de una tienda Shopify",
      argsSchema: { dominio: z.string() },
    },
    ({ dominio }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Analiza a fondo la tienda ${dominio}: usa track_store y get_store, revisa sus anuncios con search_ads y complementa con búsqueda web.
Quiero: posicionamiento, productos estrella, estrategia de precios, tecnología (apps/píxeles), anuncios y ángulos, estimación razonada de tráfico/ventas (explica en qué te basas) y oportunidades para competir.`,
          },
        },
      ],
    }),
  );

  return server;
}

export { trackWithAds };
