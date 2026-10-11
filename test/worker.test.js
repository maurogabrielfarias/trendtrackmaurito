// Pruebas de punta a punta: levanta el Worker con "wrangler dev" (D1 local), una tienda Shopify
// simulada y un API de Claude simulado.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeShop } from "./fake-shop.js";
import { startMockAnthropic } from "./mock-anthropic.js";
import { analyzeHtml } from "../src/intel.js";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Basic " + Buffer.from("yo:clave-secreta").toString("base64") };
const persist = fs.mkdtempSync(path.join(os.tmpdir(), "trendtrack-d1-"));
let shop, claude, worker;

const api = async (p, opts = {}) => {
  const res = await fetch(BASE + p, {
    ...opts,
    headers: { "content-type": "application/json", ...AUTH, ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text };
  }
};

const mcp = async (method, params = {}, token = "token-mcp") => {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, data: await res.json() };
};

before(async () => {
  shop = await startFakeShop();
  claude = await startMockAnthropic();
  const bin = path.resolve("node_modules/.bin/wrangler");
  execFileSync(bin, ["d1", "migrations", "apply", "trendtrack", "--local", "--persist-to", persist], { stdio: "ignore" });
  worker = spawn(
    bin,
    [
      "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", persist, "--test-scheduled", "--show-interactive-dev-session=false",
      "--var", "APP_PASSWORD:clave-secreta", "--var", "MCP_TOKEN:token-mcp",
      "--var", "ANTHROPIC_API_KEY:sk-ant-prueba", "--var", `ANTHROPIC_BASE_URL:${claude.url}`, "--var", "RESCAN_HOURS:0.0001",
    ],
    { stdio: "ignore", detached: true },
  );
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(BASE);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("wrangler dev no arrancó");
});

after(() => {
  try {
    process.kill(-worker.pid);
  } catch {}
  shop.server.close();
  claude.server.close();
});

test("detecta tema, apps, píxeles y redes", () => {
  const html = '<html lang="en"><script>Shopify.theme = {"name":"Impulse","theme_store_id":857};</script><script src="https://static.klaviyo.com/a.js"></script><script src="https://analytics.tiktok.com/x.js"></script><a href="https://www.instagram.com/marca">ig</a>';
  const r = analyzeHtml(html);
  assert.equal(r.theme, "Impulse");
  assert.deepEqual(r.apps, ["Klaviyo"]);
  assert.deepEqual(r.pixels, ["TikTok Pixel"]);
  assert.equal(r.socials.instagram, "https://www.instagram.com/marca");
});

test("pide contraseña", async () => {
  assert.equal((await fetch(BASE + "/")).status, 401);
  assert.equal((await fetch(BASE + "/api/stats")).status, 401);
  const page = await fetch(BASE + "/", { headers: AUTH });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /TrendTrack/);
  assert.equal((await fetch(BASE + "/vendor/marked.min.js", { headers: AUTH })).status, 200);
});

let storeId;
test("rastrea la tienda, detecta cambios y genera alertas", async () => {
  const add = await api("/api/stores", { method: "POST", body: { domain: shop.origin } });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  storeId = add.data.store.id;
  assert.equal(add.data.store.name, "Fake Shop");
  assert.equal(add.data.store.productCount, 3);
  assert.equal(add.data.store.tech.theme, "Dawn");
  assert.deepEqual(add.data.store.apps, ["Klaviyo", "Loox"]);

  shop.state.products[0].variants[0].price = "24.99";
  shop.state.products.pop();
  shop.state.products.push(shop.product(4, "Mini proyector", 79, 129, Date.now()));
  const again = await api(`/api/stores/${encodeURIComponent(storeId)}/scan`, { method: "POST" });
  assert.deepEqual(
    [again.data.scan.newProducts, again.data.scan.priceChanges, again.data.scan.removedProducts],
    [1, 1, 1],
  );
  const types = (await api("/api/events")).data.map((e) => e.type);
  for (const t of ["new_product", "price_change", "removed_product", "store_added"]) assert.ok(types.includes(t), t);

  const stats = (await api("/api/stats")).data;
  assert.equal(stats.stores, 1);
  assert.equal(stats.products, 3);
});

test("busca productos y tiendas, exporta CSV", async () => {
  const r = (await api("/api/products?q=proyector")).data;
  assert.equal(r.total, 1);
  assert.equal(r.products[0].discountPct, 39);
  assert.equal((await api("/api/products?maxPrice=25")).data.total, 2);
  assert.equal((await api("/api/products?sort=bestseller")).data.products[0].title, "Mini proyector");
  const p = await api(`/api/products/${encodeURIComponent(r.products[0].key)}`);
  assert.equal(p.data.title, "Mini proyector");
  assert.equal((await api("/api/stores?app=Klaviyo")).data.stores.length, 1);
  assert.equal((await api("/api/stores?theme=Impulse")).data.stores.length, 0);
  assert.match((await api("/api/export/products.csv")).data, /Mini proyector/);
});

test("tableros de favoritos", async () => {
  const board = (await api("/api/boards", { method: "POST", body: { name: "Ganadores" } })).data;
  const key = (await api("/api/products?q=proyector")).data.products[0].key;
  await api(`/api/boards/${board.id}/items`, { method: "POST", body: { type: "product", ref: key } });
  await api(`/api/boards/${board.id}/items`, { method: "POST", body: { type: "product", ref: key } });
  const full = (await api(`/api/boards/${board.id}`)).data;
  assert.equal(full.items.length, 1);
  assert.equal(full.items[0].current.title, "Mini proyector");
  assert.equal((await api("/api/boards")).data[0].itemCount, 1);
});

test("servidor MCP por HTTP", async () => {
  assert.equal((await mcp("tools/list", {}, "malo")).status, 401);
  const list = await mcp("tools/list");
  const names = list.data.result.tools.map((t) => t.name);
  for (const n of ["dashboard", "search_stores", "get_store", "track_store", "search_products", "search_ads", "recent_alerts", "save_to_board"]) {
    assert.ok(names.includes(n), n);
  }
  const call = await mcp("tools/call", { name: "search_products", arguments: { query: "corrector" } });
  assert.equal(JSON.parse(call.data.result.content[0].text).products[0].price, 24.99);
  const store = await mcp("tools/call", { name: "get_store", arguments: { store: shop.origin } });
  assert.equal(JSON.parse(store.data.result.content[0].text).name, "Fake Shop");
  const save = await mcp("tools/call", { name: "save_to_board", arguments: { board: "Desde Claude", type: "store", ref: shop.origin } });
  assert.equal(JSON.parse(save.data.result.content[0].text).itemCount, 1);
});

test("investigación con Claude (API simulado) usando las herramientas MCP", async () => {
  const res = await fetch(`${BASE}/api/research`, {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH },
    body: JSON.stringify({ prompt: "¿Qué tengo?", mode: "products" }),
  });
  const events = (await res.text())
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
  const text = events.filter((e) => e.type === "text").map((e) => e.text).join("");
  assert.equal(text, "Reviso tus datos. Listo: tienes 1 tienda.", JSON.stringify(events));
  assert.ok(events.some((e) => e.type === "tool" && e.name === "dashboard"));
  assert.equal(events.at(-1).type, "done");

  const first = claude.requests.find((r) => r.url.includes("/v1/messages"));
  assert.equal(first.json.model, "claude-opus-5-5");
  assert.equal(first.json.fallbacks, "default");
  assert.match(first.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.ok(first.json.tools.some((t) => t.type === "web_search_20260209"));
  const second = claude.requests.filter((r) => r.url.includes("/v1/messages"))[1];
  assert.match(second.json.messages.at(-1).content[0].content, /"stores": 1/);

  const view = (await api(`/api/conversations/${events.at(-1).id}`)).data;
  assert.equal(view.items[0].text, "¿Qué tengo?");
  assert.equal(view.items[1].text, text);
  const settings = (await api("/api/settings")).data;
  assert.equal(settings.hasApiKey, true);
  assert.ok(settings.usage.costUsd > 0);
});

test("re-escaneo programado (Cron)", async () => {
  shop.state.products.push(shop.product(5, "Lámpara solar", 15, null, Date.now()));
  const res = await fetch(`${BASE}/__scheduled?cron=*/30+*+*+*+*`);
  assert.equal(res.status, 200);
  for (let i = 0; i < 20; i++) {
    const r = (await api("/api/products?q=solar")).data;
    if (r.total === 1) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.fail("el cron no re-escaneó la tienda");
});
