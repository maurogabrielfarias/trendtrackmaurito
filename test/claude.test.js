// Prueba el bucle de investigación contra un API de Anthropic simulado (sin gastar créditos).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "trendtrack-claude-"));
const requests = [];

function sse(res, message, blocks) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    } else {
      send("content_block_start", { index, content_block: { ...b, input: {} } });
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    send("content_block_stop", { index });
  });
  send("message_delta", { delta: { stop_reason: message.stop_reason }, usage: { output_tokens: 50, server_tool_use: { web_search_requests: 1 } } });
  send("message_stop", {});
  res.end();
}

const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = JSON.parse(body);
    requests.push({ json, headers: req.headers });
    const base = { id: `msg_${requests.length}`, type: "message", role: "assistant", model: json.model };
    if (requests.length === 1) {
      sse(res, { ...base, stop_reason: "tool_use" }, [
        { type: "text", text: "Reviso tus datos. " },
        { type: "tool_use", id: "toolu_1", name: "dashboard", input: {} },
      ]);
    } else {
      sse(res, { ...base, stop_reason: "end_turn" }, [{ type: "text", text: "Listo: no rastreas tiendas todavía." }]);
    }
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
process.env.ANTHROPIC_API_KEY = "sk-ant-test";
after(() => fake.close());

const { research, getConversationView } = await import("../src/claude.js");
const { db } = await import("../src/db.js");

test("investigación con herramientas MCP y streaming", async () => {
  const events = [];
  await research({ prompt: "¿Qué tengo?", mode: "products" }, (e) => events.push(e));

  assert.equal(requests.length, 2);
  const first = requests[0];
  assert.equal(first.json.model, "claude-opus-5-5");
  assert.equal(first.json.fallbacks, "default");
  assert.match(first.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.deepEqual(first.json.thinking, { type: "adaptive", display: "summarized" });
  const names = first.json.tools.map((t) => t.name);
  assert.ok(names.includes("web_search") && names.includes("track_store") && names.includes("search_ads"));
  assert.ok(first.json.tools.find((t) => t.name === "search_products").input_schema.properties.query);

  // La segunda petición lleva el resultado de la herramienta MCP
  const toolResult = requests[1].json.messages.at(-1).content[0];
  assert.equal(toolResult.type, "tool_result");
  assert.equal(toolResult.tool_use_id, "toolu_1");
  assert.match(toolResult.content, /"stores": 0/);

  const text = events.filter((e) => e.type === "text").map((e) => e.text).join("");
  assert.equal(text, "Reviso tus datos. Listo: no rastreas tiendas todavía.");
  assert.ok(events.some((e) => e.type === "tool" && e.name === "dashboard"));
  assert.equal(events.at(-1).type, "done");
  assert.equal(db().usage.webSearches, 2);
  assert.ok(db().usage.costUsd > 0);

  const view = getConversationView(events.at(-1).id);
  assert.equal(view.items[0].text, "¿Qué tengo?");
  assert.equal(view.items[1].text, text);
});
