// API de Anthropic simulado (respuestas en streaming) para probar sin gastar créditos.
import http from "node:http";

export function startMockAnthropic() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = JSON.parse(body || "{}");
      requests.push({ url: req.url, json, headers: req.headers });
      if (req.url.startsWith("/v1/models/")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ id: json.model || "claude-opus-5-5", display_name: "Claude Opus 5.5", type: "model" }));
      }
      const base = { id: `msg_${requests.length}`, type: "message", role: "assistant", model: json.model };
      const isFirst = !json.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
      if (isFirst) {
        sse(res, { ...base, stop_reason: "tool_use" }, [
          { type: "text", text: "Reviso tus datos. " },
          { type: "tool_use", id: "toolu_1", name: "dashboard", input: {} },
        ]);
      } else {
        sse(res, { ...base, stop_reason: "end_turn" }, [{ type: "text", text: "Listo: tienes 1 tienda." }]);
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })),
  );
}

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
