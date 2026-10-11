#!/usr/bin/env node
// Servidor MCP por stdio: para Claude Desktop y Claude Code.
// No escribir nada en stdout aquí: ese canal es del protocolo MCP.
import "./env.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp.js";
import { flushPending } from "./db.js";

const server = createMcpServer();
await server.connect(new StdioServerTransport());
console.error("TrendTrack Maurito MCP listo (stdio)");

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    flushPending();
    process.exit(0);
  });
}
