// Investigación con Claude: búsqueda web + acceso a las tiendas/productos rastreados.
// Usa tu API key de Anthropic, así que cada búsqueda consume los créditos de tu cuenta.
import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import { db, save } from "./db.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp.js";

export const MODELS = {
  "claude-opus-5-5": { label: "Claude Opus 5.5 (recomendado)", input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5 (más barato)", input: 2, output: 10, cacheRead: 0.2 },
};
export const DEFAULT_MODEL = "claude-opus-5-5";
const WEB_SEARCH_COST = 10 / 1000; // USD por búsqueda
const MAX_TURNS = 15;

export function getSettings() {
  const s = db().settings;
  const apiKey = s.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";
  const model = s.model || process.env.CLAUDE_MODEL || DEFAULT_MODEL;
  return {
    apiKey,
    model: MODELS[model] ? model : DEFAULT_MODEL,
    effort: s.effort || "medium",
  };
}

function client() {
  const { apiKey } = getSettings();
  if (!apiKey) {
    const err = new Error("Falta la API key de Anthropic. Agrégala en Ajustes o en el archivo .env");
    err.status = 400;
    throw err;
  }
  return new Anthropic({ apiKey });
}

export async function testApiKey() {
  const { model } = getSettings();
  const info = await client().models.retrieve(model);
  return { ok: true, model: info.id, name: info.display_name };
}

// System prompt estable (se cachea): nada variable aquí, ni la fecha.
const SYSTEM = `Eres el analista de TrendTrack Maurito, una herramienta para dropshipping y e-commerce.
Ayudas al usuario a encontrar productos ganadores, tiendas Shopify exitosas, tendencias y anuncios que funcionan.

Herramientas:
- web_search / web_fetch: para investigar tendencias, tiendas, anuncios, reseñas y precios en internet.
- Herramientas de TrendTrack (servidor MCP de la app): dashboard, search_stores, get_store, search_products, get_product, recent_alerts, search_ads, list_boards. Son datos reales rastreados desde las tiendas Shopify del usuario; úsalas antes que suposiciones.
- track_store: agrega una tienda Shopify al rastreador (catálogo, tema, apps, píxeles y anuncios). Úsala cuando encuentres una tienda prometedora o el usuario te lo pida.
- save_to_board y set_store_notes: guarda hallazgos en los tableros de favoritos o anota nichos/notas cuando el usuario lo pida.

Cómo responder:
- Responde en el idioma del usuario (por defecto español).
- Sé concreto: nombres de productos, tiendas (con dominio), rangos de precio, ángulos de marketing, proveedores posibles y por qué crees que funciona.
- Distingue lo que viene de datos rastreados, lo que viene de fuentes web (cítalas con enlace) y lo que es tu estimación.
- Nunca inventes cifras de ventas o tráfico; si das una estimación, explica en qué se basa.
- Usa encabezados cortos, listas y tablas en Markdown cuando ayuden.`;

const MODE_HINTS = {
  products: "Objetivo: encontrar productos ganadores (demanda creciente, buen margen, fáciles de anunciar).",
  stores: "Objetivo: encontrar tiendas Shopify exitosas en este nicho y, si son prometedoras, agregarlas al rastreador con track_store.",
  analyze: "Objetivo: analizar a fondo esta tienda o producto (catálogo, precios, anuncios, posicionamiento, debilidades y oportunidades).",
  ads: "Objetivo: encontrar anuncios y creativos que estén funcionando para este producto o nicho, y los ángulos que usan.",
  free: "",
};

// La app se vincula a Claude a través de su propio servidor MCP: las mismas herramientas
// que usa Claude Desktop / claude.ai se conectan aquí en memoria y se ofrecen al modelo.
let bridge = null;
async function mcpBridge() {
  bridge ??= (async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createMcpServer().connect(serverTransport);
    const mcp = new Client({ name: "trendtrack-app", version: "0.1.0" });
    await mcp.connect(clientTransport);
    const { tools } = await mcp.listTools();
    return {
      tools: tools.map((t) => {
        const { $schema, ...schema } = t.inputSchema || { type: "object", properties: {} };
        return { name: t.name, description: t.description, input_schema: schema, eager_input_streaming: true };
      }),
      async call(name, input) {
        // El servidor MCP valida la entrada con zod (necesario con eager_input_streaming).
        const r = await mcp.callTool({ name, arguments: input && typeof input === "object" ? input : {} });
        const text = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
        return { text: text || "(sin resultado)", isError: Boolean(r.isError) };
      },
    };
  })();
  return bridge;
}

const SERVER_TOOLS = [
  { type: "web_search_20260209", name: "web_search", max_uses: 8 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 6 },
];

function addUsage(model, usage) {
  const price = MODELS[model] || MODELS[DEFAULT_MODEL];
  const u = db().usage;
  const input = usage.input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const output = usage.output_tokens || 0;
  const searches = usage.server_tool_use?.web_search_requests || 0;
  const cost =
    (input * price.input + cacheWrite * price.input * 1.25 + cacheRead * price.cacheRead + output * price.output) / 1e6 +
    searches * WEB_SEARCH_COST;
  u.requests++;
  u.inputTokens += input + cacheWrite;
  u.cacheReadTokens += cacheRead;
  u.outputTokens += output;
  u.webSearches += searches;
  u.costUsd += cost;
  save();
  return { input: input + cacheWrite, cacheRead, output, searches, cost };
}

export function listConversations() {
  return Object.values(db().conversations)
    .map(({ id, title, mode, createdAt, updatedAt }) => ({ id, title, mode, createdAt, updatedAt }))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

// Vista simplificada de una conversación para la interfaz.
export function getConversationView(id) {
  const c = db().conversations[id];
  if (!c) return null;
  const items = [];
  for (const m of c.messages) {
    if (m.role === "user") {
      if (typeof m.content === "string") items.push({ role: "user", text: m.content.replace(/^\[[^\]]*\]\n/, "") });
      continue;
    }
    const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const sources = m.content
      .filter((b) => b.type === "web_search_tool_result" && Array.isArray(b.content))
      .flatMap((b) => b.content.map((r) => ({ title: r.title, url: r.url })));
    const last = items[items.length - 1];
    if (last?.role === "assistant") {
      last.text += text;
      last.sources.push(...sources);
    } else {
      items.push({ role: "assistant", text, sources });
    }
  }
  return { id: c.id, title: c.title, mode: c.mode, items };
}

export function deleteConversation(id) {
  delete db().conversations[id];
  save();
}

/**
 * Ejecuta una investigación con Claude y emite eventos para la interfaz:
 * conversation, text, thinking, tool, sources, usage, done, error.
 */
export async function research({ conversationId, prompt, mode = "free" }, emit, signal) {
  const anthropic = client();
  const { model, effort } = getSettings();
  const tools = await mcpBridge();
  const state = db();

  let convo = conversationId && state.conversations[conversationId];
  if (!convo) {
    const now = new Date().toISOString();
    convo = { id: crypto.randomUUID(), title: prompt.slice(0, 80), mode, createdAt: now, updatedAt: now, messages: [] };
    state.conversations[convo.id] = convo;
  }
  emit({ type: "conversation", id: convo.id, title: convo.title });

  // La fecha y el modo van en el mensaje del usuario para no romper la caché del system prompt.
  const hint = MODE_HINTS[mode] || "";
  const header = `[Fecha: ${new Date().toISOString().slice(0, 10)}${hint ? ` | ${hint}` : ""}]\n`;
  convo.messages.push({ role: "user", content: header + prompt });
  convo.updatedAt = new Date().toISOString();
  save();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stream = anthropic.beta.messages.stream(
      {
        model,
        max_tokens: 64000,
        system: SYSTEM,
        cache_control: { type: "ephemeral" },
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort },
        tools: [...SERVER_TOOLS, ...tools.tools],
        messages: convo.messages,
        // Si los filtros de seguridad rechazan la petición, el API la reintenta con otro modelo.
        fallbacks: "default",
        betas: ["server-side-fallback-2026-07-01"],
      },
      { signal },
    );

    stream.on("text", (delta) => emit({ type: "text", text: delta }));
    stream.on("thinking", (delta) => emit({ type: "thinking", text: delta }));
    stream.on("contentBlock", (block) => {
      if (block.type === "server_tool_use" || block.type === "tool_use") {
        emit({ type: "tool", name: block.name, input: block.input });
      } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        emit({ type: "sources", sources: block.content.map((r) => ({ title: r.title, url: r.url })) });
      }
    });

    const message = await stream.finalMessage();
    emit({ type: "usage", usage: addUsage(model, message.usage), total: db().usage });

    // Se guarda el contenido completo (incluidos bloques de thinking) sin modificar.
    convo.messages.push({ role: "assistant", content: message.content });
    convo.updatedAt = new Date().toISOString();
    save();

    if (message.stop_reason === "refusal") {
      emit({ type: "error", message: "Claude no pudo responder a esta petición. Prueba a reformularla." });
      break;
    }
    if (message.stop_reason === "max_tokens") {
      emit({ type: "error", message: "La respuesta llegó al límite de longitud." });
      break;
    }
    if (message.stop_reason === "pause_turn") continue;
    if (message.stop_reason !== "tool_use") break;

    const toolUses = message.content.filter((b) => b.type === "tool_use");
    const results = await Promise.all(
      toolUses.map(async (block) => {
        try {
          const r = await tools.call(block.name, block.input);
          return { type: "tool_result", tool_use_id: block.id, content: r.text, is_error: r.isError };
        } catch (err) {
          return { type: "tool_result", tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true };
        }
      }),
    );
    convo.messages.push({ role: "user", content: results });
    save();
  }

  emit({ type: "done", id: convo.id });
}
