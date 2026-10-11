import "./env.js";
import express from "express";
import path from "node:path";
import { db, save, flushPending, ROOT } from "./db.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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
  recentEvents,
  dashboardStats,
} from "./shopify.js";
import { adLibraryLinks, searchMetaAds, trackStoreAds } from "./ads.js";
import {
  MODELS,
  getSettings,
  testApiKey,
  research,
  listConversations,
  getConversationView,
  deleteConversation,
} from "./claude.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------- MCP (Streamable HTTP) para claude.ai / Claude Desktop / Claude Code ----------
// Protegido con MCP_TOKEN: cabecera "Authorization: Bearer <token>" o ?token=<token> en la URL.
function mcpAuth(req, res, next) {
  const token = process.env.MCP_TOKEN;
  if (!token) return next();
  const given = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || req.query.token;
  if (given === token) return next();
  res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "MCP_TOKEN inválido" }, id: null });
}

app.post("/mcp", mcpAuth, async (req, res) => {
  // Modo sin sesión: un servidor y un transporte por petición.
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error MCP:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Error interno" }, id: null });
    }
  }
});
app.all("/mcp", (req, res) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Método no permitido" }, id: null }),
);

// Protección opcional con contraseña para la interfaz web.
if (process.env.APP_PASSWORD) {
  app.use((req, res, next) => {
    const [, encoded = ""] = (req.headers.authorization || "").split(" ");
    const pass = Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":");
    if (pass === process.env.APP_PASSWORD) return next();
    res.set("WWW-Authenticate", 'Basic realm="TrendTrack"').status(401).send("Contraseña requerida");
  });
}

app.use(express.static(path.join(ROOT, "public")));
// Librerías del navegador servidas desde node_modules (sin depender de un CDN).
app.get("/vendor/marked.min.js", (req, res) => res.sendFile(path.join(ROOT, "node_modules/marked/marked.min.js")));
app.get("/vendor/purify.min.js", (req, res) => res.sendFile(path.join(ROOT, "node_modules/dompurify/dist/purify.min.js")));

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
};

// ---------- Dashboard y alertas ----------
app.get("/api/stats", (req, res) => res.json(dashboardStats()));
app.get("/api/events", (req, res) => res.json(recentEvents(req.query)));

// ---------- Tiendas ----------
app.get("/api/stores", (req, res) => res.json({ stores: searchStores(req.query), facets: storeFacets() }));

app.get("/api/stores/:id", (req, res) => {
  const store = db().stores[req.params.id];
  if (!store) return res.status(404).json({ error: "Tienda no encontrada" });
  res.json({ ...store, events: recentEvents({ storeId: store.id, limit: 50 }) });
});

app.post("/api/stores", async (req, res) => {
  try {
    res.json(await trackWithAds(req.body.domain));
  } catch (err) {
    res.status(400).json({ error: `No se pudo rastrear la tienda: ${err.message}` });
  }
});

app.post("/api/stores/:id/scan", async (req, res) => {
  const store = db().stores[req.params.id];
  if (!store) return res.status(404).json({ error: "Tienda no encontrada" });
  try {
    res.json(await trackWithAds(store.origin));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.patch("/api/stores/:id", (req, res) => {
  const store = db().stores[req.params.id];
  if (!store) return res.status(404).json({ error: "Tienda no encontrada" });
  for (const key of ["notes", "niche"]) {
    if (typeof req.body[key] === "string") store[key] = req.body[key].slice(0, 2000);
  }
  save();
  res.json(store);
});

app.delete("/api/stores/:id", (req, res) => {
  removeStore(req.params.id);
  res.json({ ok: true });
});

// ---------- Productos ----------
app.get("/api/products", (req, res) => res.json(searchProducts(req.query)));
app.get("/api/products/:key", (req, res) => {
  const p = getProduct(req.params.key);
  if (!p) return res.status(404).json({ error: "Producto no encontrado" });
  res.json(p);
});

// ---------- Exportar ----------
app.get("/api/export/products.csv", (req, res) => {
  res.attachment("productos.csv").type("text/csv").send(productsCsv(req.query));
});
app.get("/api/export/stores.csv", (req, res) => {
  res.attachment("tiendas.csv").type("text/csv").send(storesCsv(req.query));
});

// ---------- Anuncios ----------
app.get("/api/ads", async (req, res) => {
  const term = String(req.query.term || "").trim();
  if (!term) return res.status(400).json({ error: "Escribe un término de búsqueda" });
  const links = adLibraryLinks(term);
  try {
    const meta = await searchMetaAds({ term, country: req.query.country || "ES", limit: 100 });
    const minDays = Number(req.query.minDays || 0);
    res.json({ links, ...meta, ads: meta.ads.filter((a) => (a.daysRunning ?? 0) >= minDays) });
  } catch (err) {
    res.json({ links, configured: true, ads: [], error: err.message });
  }
});

// ---------- Tableros (favoritos) ----------
app.get("/api/boards", (req, res) => res.json(listBoards()));
app.post("/api/boards", (req, res) => res.json(createBoard(req.body.name)));
app.get("/api/boards/:id", (req, res) => {
  const board = getBoard(req.params.id);
  if (!board) return res.status(404).json({ error: "Tablero no encontrado" });
  res.json(board);
});
app.post("/api/boards/:id/items", wrap((req, res) => res.json(addToBoard(req.params.id, req.body))));
app.delete("/api/boards/:id/items", wrap((req, res) => res.json(removeFromBoard(req.params.id, req.body.type, req.body.ref))));
app.delete("/api/boards/:id", (req, res) => {
  deleteBoard(req.params.id);
  res.json({ ok: true });
});

// ---------- Ajustes ----------
function publicSettings(req) {
  const { apiKey, model, effort } = getSettings();
  const base = `${req.protocol}://${req.get("host")}`;
  return {
    hasApiKey: Boolean(apiKey),
    apiKeyPreview: apiKey ? `${apiKey.slice(0, 10)}…${apiKey.slice(-4)}` : "",
    model,
    effort,
    models: Object.entries(MODELS).map(([id, m]) => ({ id, ...m })),
    metaConfigured: Boolean(process.env.META_ACCESS_TOKEN),
    mcp: {
      httpUrl: `${base}/mcp`,
      tokenRequired: Boolean(process.env.MCP_TOKEN),
      stdioCommand: "node",
      stdioArgs: [path.join(ROOT, "src", "mcp-stdio.js")],
    },
    usage: db().usage,
  };
}

app.get("/api/settings", (req, res) => res.json(publicSettings(req)));

app.post("/api/settings", (req, res) => {
  const s = db().settings;
  const { apiKey, model, effort } = req.body;
  if (typeof apiKey === "string" && apiKey.trim()) s.anthropicApiKey = apiKey.trim();
  if (apiKey === null) delete s.anthropicApiKey;
  if (MODELS[model]) s.model = model;
  if (["low", "medium", "high", "xhigh", "max"].includes(effort)) s.effort = effort;
  save();
  res.json(publicSettings(req));
});

app.post("/api/settings/test", wrap(async (req, res) => res.json(await testApiKey())));

app.post("/api/settings/reset-usage", (req, res) => {
  Object.assign(db().usage, { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, webSearches: 0, costUsd: 0 });
  save();
  res.json(publicSettings(req));
});

// ---------- Investigación con Claude (API) ----------
app.get("/api/conversations", (req, res) => res.json(listConversations()));

app.get("/api/conversations/:id", (req, res) => {
  const view = getConversationView(req.params.id);
  if (!view) return res.status(404).json({ error: "Conversación no encontrada" });
  res.json(view);
});

app.delete("/api/conversations/:id", (req, res) => {
  deleteConversation(req.params.id);
  res.json({ ok: true });
});

// Respuesta en streaming (Server-Sent Events) para ver a Claude escribir en vivo.
app.post("/api/research", async (req, res) => {
  const prompt = String(req.body.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "Escribe qué quieres investigar" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const emit = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    await research({ conversationId: req.body.conversationId, prompt, mode: req.body.mode }, emit, controller.signal);
  } catch (err) {
    if (!controller.signal.aborted) {
      const message = err.status === 401 ? "API key inválida. Revísala en Ajustes." : err.message;
      emit({ type: "error", message });
    }
  }
  res.end();
});

// ---------- Re-escaneo automático ----------
const RESCAN_HOURS = Number(process.env.RESCAN_HOURS || 24);
let rescanning = null;
function rescanAll() {
  rescanning ??= (async () => {
    for (const store of Object.values(db().stores)) {
      try {
        await scanStore(store.origin);
        await trackStoreAds(store.id).catch(() => null);
      } catch (err) {
        markScanError(store.origin, err);
      }
    }
  })().finally(() => (rescanning = null));
  return rescanning;
}
if (RESCAN_HOURS > 0) setInterval(rescanAll, RESCAN_HOURS * 3600 * 1000).unref();

app.post("/api/stores-rescan", async (req, res) => {
  await rescanAll();
  res.json({ ok: true });
});

process.on("SIGINT", () => {
  flushPending();
  process.exit(0);
});

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`TrendTrack Maurito listo en http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`Servidor MCP (HTTP) en http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/mcp`);
});
