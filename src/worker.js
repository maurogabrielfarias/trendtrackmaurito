// TrendTrack Maurito en Cloudflare Workers: API, interfaz web, servidor MCP y re-escaneo programado.
import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { bindEnv, all, getKv, setKv } from "./db.js";
import { createMcpServer, trackWithAds } from "./mcp.js";
import { listBoards, createBoard, addToBoard, removeFromBoard, deleteBoard, getBoard } from "./boards.js";
import { productsCsv, storesCsv } from "./export.js";
import {
  scanStore,
  markScanError,
  removeStore,
  searchProducts,
  searchStores,
  storeFacets,
  getProduct,
  getStore,
  saveStore,
  recentEvents,
  dashboardStats,
} from "./shopify.js";
import { adLibraryLinks, searchMetaAds, trackStoreAds } from "./ads.js";
import {
  MODELS,
  EMPTY_USAGE,
  getSettings,
  saveSettings,
  testApiKey,
  research,
  listConversations,
  getConversationView,
  deleteConversation,
} from "./claude.js";

const app = new Hono();

// Comparación de secretos en tiempo constante.
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

app.use("*", async (c, next) => {
  bindEnv(c.env);
  await next();
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, err.status || 500);
});

// ---------- MCP (Streamable HTTP) para claude.ai / Claude Desktop / Claude Code ----------
// Protegido con el secreto MCP_TOKEN: cabecera "Authorization: Bearer <token>" o ?token=<token>.
app.all("/mcp", async (c) => {
  const token = c.env.MCP_TOKEN;
  if (!token) return c.json({ error: "Configura el secreto MCP_TOKEN para activar el servidor MCP" }, 503);
  const given = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "") || c.req.query("token") || "";
  if (!safeEqual(given, token)) {
    return c.json({ jsonrpc: "2.0", error: { code: -32001, message: "MCP_TOKEN inválido" }, id: null }, 401);
  }
  if (c.req.method !== "POST") {
    return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Método no permitido" }, id: null }, 405);
  }
  // Modo sin sesión: un servidor y un transporte por petición.
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

// ---------- Contraseña para la interfaz web y la API ----------
app.use("*", async (c, next) => {
  const password = c.env.APP_PASSWORD;
  if (!password) {
    return c.text("Configura el secreto APP_PASSWORD en Cloudflare para abrir TrendTrack Maurito.", 503);
  }
  const [scheme, encoded = ""] = (c.req.header("authorization") || "").split(" ");
  let pass = "";
  try {
    pass = scheme === "Basic" ? atob(encoded).split(":").slice(1).join(":") : "";
  } catch {
    pass = "";
  }
  if (!safeEqual(pass, password)) {
    return c.text("Contraseña requerida", 401, { "WWW-Authenticate": 'Basic realm="TrendTrack", charset="UTF-8"' });
  }
  await next();
});

// ---------- Dashboard y alertas ----------
app.get("/api/stats", async (c) => c.json(await dashboardStats(await getKv("usage", EMPTY_USAGE))));
app.get("/api/events", async (c) => c.json(await recentEvents(c.req.query())));

// ---------- Tiendas ----------
app.get("/api/stores", async (c) => {
  const stores = await searchStores(c.req.query());
  const everything = Object.keys(c.req.query()).length ? await searchStores() : stores;
  return c.json({ stores, facets: storeFacets(everything) });
});

app.get("/api/stores/:id", async (c) => {
  const store = await getStore(c.req.param("id"));
  if (!store) return c.json({ error: "Tienda no encontrada" }, 404);
  return c.json({ ...store, events: await recentEvents({ storeId: store.id, limit: 50 }) });
});

app.post("/api/stores", async (c) => {
  const { domain } = await c.req.json();
  try {
    return c.json(await trackWithAds(domain));
  } catch (err) {
    return c.json({ error: `No se pudo rastrear la tienda: ${err.message}` }, 400);
  }
});

app.post("/api/stores/:id/scan", async (c) => {
  const store = await getStore(c.req.param("id"));
  if (!store) return c.json({ error: "Tienda no encontrada" }, 404);
  try {
    return c.json(await trackWithAds(store.origin));
  } catch (err) {
    return c.json({ error: err.message }, 502);
  }
});

app.patch("/api/stores/:id", async (c) => {
  const store = await getStore(c.req.param("id"));
  if (!store) return c.json({ error: "Tienda no encontrada" }, 404);
  const body = await c.req.json();
  for (const key of ["notes", "niche"]) {
    if (typeof body[key] === "string") store[key] = body[key].slice(0, 2000);
  }
  await saveStore(store);
  return c.json(store);
});

app.delete("/api/stores/:id", async (c) => {
  await removeStore(c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/stores-rescan", async (c) => c.json(await rescanStalest(5, 0)));

// ---------- Productos ----------
app.get("/api/products", async (c) => c.json(await searchProducts(c.req.query())));
app.get("/api/products/:key", async (c) => {
  const p = await getProduct(c.req.param("key"));
  if (!p) return c.json({ error: "Producto no encontrado" }, 404);
  return c.json(p);
});

// ---------- Exportar ----------
const csvResponse = (body, name) =>
  new Response(body, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` },
  });
app.get("/api/export/products.csv", async (c) => csvResponse(await productsCsv(c.req.query()), "productos.csv"));
app.get("/api/export/stores.csv", async (c) => csvResponse(await storesCsv(c.req.query()), "tiendas.csv"));

// ---------- Anuncios ----------
app.get("/api/ads", async (c) => {
  const term = String(c.req.query("term") || "").trim();
  if (!term) return c.json({ error: "Escribe un término de búsqueda" }, 400);
  const links = adLibraryLinks(term);
  try {
    const meta = await searchMetaAds({ term, country: c.req.query("country") || "ES", limit: 100 });
    const minDays = Number(c.req.query("minDays") || 0);
    return c.json({ links, ...meta, ads: meta.ads.filter((a) => (a.daysRunning ?? 0) >= minDays) });
  } catch (err) {
    return c.json({ links, configured: true, ads: [], error: err.message });
  }
});

// ---------- Tableros (favoritos) ----------
app.get("/api/boards", async (c) => c.json(await listBoards()));
app.post("/api/boards", async (c) => c.json(await createBoard((await c.req.json()).name)));
app.get("/api/boards/:id", async (c) => {
  const board = await getBoard(c.req.param("id"));
  if (!board) return c.json({ error: "Tablero no encontrado" }, 404);
  return c.json(board);
});
app.post("/api/boards/:id/items", async (c) => c.json(await addToBoard(c.req.param("id"), await c.req.json())));
app.delete("/api/boards/:id/items", async (c) => {
  const { type, ref } = await c.req.json();
  await removeFromBoard(c.req.param("id"), type, ref);
  return c.json({ ok: true });
});
app.delete("/api/boards/:id", async (c) => {
  await deleteBoard(c.req.param("id"));
  return c.json({ ok: true });
});

// ---------- Ajustes ----------
async function publicSettings(c) {
  const s = await getSettings();
  const origin = new URL(c.req.url).origin;
  return {
    ...s,
    models: Object.entries(MODELS).map(([id, m]) => ({ id, ...m })),
    metaConfigured: Boolean(c.env.META_ACCESS_TOKEN),
    mcp: { url: `${origin}/mcp`, configured: Boolean(c.env.MCP_TOKEN) },
    rescanHours: Number(c.env.RESCAN_HOURS || 24),
    usage: await getKv("usage", EMPTY_USAGE),
  };
}

app.get("/api/settings", async (c) => c.json(await publicSettings(c)));
app.post("/api/settings", async (c) => {
  await saveSettings(await c.req.json());
  return c.json(await publicSettings(c));
});
app.post("/api/settings/test", async (c) => c.json(await testApiKey()));
app.post("/api/settings/reset-usage", async (c) => {
  await setKv("usage", EMPTY_USAGE);
  return c.json(await publicSettings(c));
});

// ---------- Investigación con Claude (API) ----------
app.get("/api/conversations", async (c) => c.json(await listConversations()));
app.get("/api/conversations/:id", async (c) => {
  const view = await getConversationView(c.req.param("id"));
  if (!view) return c.json({ error: "Conversación no encontrada" }, 404);
  return c.json(view);
});
app.delete("/api/conversations/:id", async (c) => {
  await deleteConversation(c.req.param("id"));
  return c.json({ ok: true });
});

// Respuesta en streaming (Server-Sent Events) para ver a Claude escribir en vivo.
app.post("/api/research", async (c) => {
  const body = await c.req.json();
  const prompt = String(body.prompt || "").trim();
  if (!prompt) return c.json({ error: "Escribe qué quieres investigar" }, 400);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const controller = new AbortController();
  let open = true;
  const emit = (event) => {
    if (!open) return;
    writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)).catch(() => {
      // El navegador se desconectó: se cancela la llamada a Claude.
      open = false;
      controller.abort();
    });
  };

  const task = research({ conversationId: body.conversationId, prompt, mode: body.mode }, emit, controller.signal)
    .catch((err) => {
      if (!controller.signal.aborted) {
        emit({ type: "error", message: err.status === 401 ? "API key inválida. Revisa el secreto ANTHROPIC_API_KEY." : err.message });
      }
    })
    .finally(() => {
      open = false;
      writer.close().catch(() => {});
    });
  c.executionCtx.waitUntil(task);

  return new Response(readable, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
  });
});

// ---------- Interfaz web (archivos de /public) ----------
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// ---------- Re-escaneo automático (Cron) ----------
// Cada ejecución escanea pocas tiendas (las más antiguas) para respetar los límites del plan.
async function rescanStalest(limit, minHours) {
  const cutoff = new Date(Date.now() - minHours * 3600 * 1000).toISOString();
  const rows = await all(
    "SELECT id FROM stores WHERE last_scan_at IS NULL OR last_scan_at < ? ORDER BY last_scan_at ASC LIMIT ?",
    cutoff,
    limit,
  );
  const results = [];
  for (const { id } of rows) {
    const store = await getStore(id);
    try {
      const { scan } = await scanStore(store.origin);
      await trackStoreAds(id).catch(() => null);
      results.push({ id, ok: true, scan });
    } catch (err) {
      await markScanError(store.origin, err);
      results.push({ id, ok: false, error: err.message });
    }
  }
  return { scanned: results.length, results };
}

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    bindEnv(env);
    const hours = Number(env.RESCAN_HOURS || 24);
    if (hours <= 0) return;
    ctx.waitUntil(rescanStalest(Number(env.RESCAN_BATCH || 2), hours));
  },
};
