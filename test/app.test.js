import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeShop } from "./fake-shop.js";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "trendtrack-test-"));
delete process.env.META_ACCESS_TOKEN;

const shopify = await import("../src/shopify.js");
const { analyzeHtml } = await import("../src/intel.js");
const boards = await import("../src/boards.js");
const { productsCsv } = await import("../src/export.js");
const { createMcpServer } = await import("../src/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

let shop;
before(async () => (shop = await startFakeShop()));
after(() => shop.server.close());

test("normaliza dominios", () => {
  assert.equal(shopify.normalizeOrigin("Tienda.com/products/x"), "https://tienda.com");
  assert.equal(shopify.storeIdFromOrigin("https://www.tienda.com"), "tienda.com");
});

test("detecta tema, apps, píxeles y redes", () => {
  const html = '<html lang="en"><script>Shopify.theme = {"name":"Impulse","theme_store_id":857};</script><script src="https://static.klaviyo.com/a.js"></script><script src="https://analytics.tiktok.com/x.js"></script><a href="https://www.instagram.com/marca">ig</a>';
  const r = analyzeHtml(html);
  assert.equal(r.theme, "Impulse");
  assert.deepEqual(r.apps, ["Klaviyo"]);
  assert.deepEqual(r.pixels, ["TikTok Pixel"]);
  assert.equal(r.socials.instagram, "https://www.instagram.com/marca");
  assert.equal(r.language, "en");
});

test("rastrea la tienda, detecta cambios y genera alertas", async () => {
  const { store, scan } = await shopify.scanStore(shop.origin);
  assert.equal(store.name, "Fake Shop");
  assert.equal(store.productCount, 3);
  assert.equal(store.launched30d, 1);
  assert.equal(store.tech.theme, "Dawn");
  assert.deepEqual(store.tech.apps, ["Klaviyo", "Loox"]);
  assert.ok(store.tech.pixels.includes("Meta Pixel"));
  assert.equal(scan.newProducts, 0);

  // Segundo escaneo: producto nuevo, cambio de precio y producto retirado.
  shop.state.products[0].variants[0].price = "24.99";
  shop.state.products.pop();
  shop.state.products.push(shop.product(4, "Mini proyector", 79, 129, Date.now()));
  const second = await shopify.scanStore(shop.origin);
  assert.equal(second.scan.newProducts, 1);
  assert.equal(second.scan.priceChanges, 1);
  assert.equal(second.scan.removedProducts, 1);
  const types = shopify.recentEvents().map((e) => e.type);
  for (const t of ["new_product", "price_change", "removed_product", "store_added"]) assert.ok(types.includes(t), t);
});

test("busca y filtra productos y tiendas", () => {
  const r = shopify.searchProducts({ q: "proyector" });
  assert.equal(r.total, 1);
  assert.equal(r.products[0].discountPct, 39);
  assert.equal(shopify.searchProducts({ maxPrice: 25 }).total, 2);
  assert.equal(shopify.searchProducts({ sort: "bestseller" }).products[0].title, "Mini proyector");
  assert.equal(shopify.searchStores({ app: "klaviyo" }).length, 1);
  assert.equal(shopify.searchStores({ theme: "Impulse" }).length, 0);
  assert.ok(productsCsv({}).includes("Mini proyector"));
});

test("tableros de favoritos", () => {
  const key = shopify.searchProducts({ q: "proyector" }).products[0].key;
  const b = boards.addToBoard("Ganadores", { type: "product", ref: key });
  boards.addToBoard("Ganadores", { type: "product", ref: key });
  assert.equal(boards.getBoard(b.id).items.length, 1);
  assert.equal(boards.getBoard(b.id).items[0].current.title, "Mini proyector");
});

test("servidor MCP expone las herramientas", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(b);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(a);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["dashboard", "search_stores", "get_store", "track_store", "search_products", "search_ads", "recent_alerts", "save_to_board"]) {
    assert.ok(names.includes(n), n);
  }
  const res = await client.callTool({ name: "search_products", arguments: { query: "corrector" } });
  assert.equal(JSON.parse(res.content[0].text).products[0].price, 24.99);
  const store = await client.callTool({ name: "get_store", arguments: { store: "127.0.0.1" } });
  assert.ok(store.isError); // el id incluye el puerto
  const bad = await client.callTool({ name: "search_products", arguments: { limit: "mucho" } });
  assert.ok(bad.isError);
  const ads = await client.callTool({ name: "search_ads", arguments: { term: "proyector" } });
  assert.equal(JSON.parse(ads.content[0].text).metaApiConfigured, false);
  const { prompts } = await client.listPrompts();
  assert.equal(prompts.length, 2);
});
