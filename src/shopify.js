// Rastreo de tiendas Shopify usando sus endpoints públicos (/products.json, /meta.json).
import { all, first, run, stmt, batch, now, parse, eventStmt } from "./db.js";
import { fetchStoreIntel } from "./intel.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX_PAGES = 20; // 20 x 250 = hasta 5000 productos por tienda
const DAY = 24 * 60 * 60 * 1000;

// Acepta "tienda.com", "https://www.tienda.com/products/x", etc. y devuelve el origin.
export function normalizeOrigin(input) {
  let s = String(input || "").trim();
  if (!s) throw new Error("Escribe el dominio de la tienda");
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const url = new URL(s);
  return `${url.protocol}//${url.host.toLowerCase()}`;
}

export function storeIdFromOrigin(origin) {
  return new URL(origin).host.replace(/^www\./, "");
}

export function storeIdFrom(input) {
  return storeIdFromOrigin(normalizeOrigin(input));
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  const type = res.headers.get("content-type") || "";
  if (!type.includes("json")) throw new Error(`La respuesta de ${url} no es JSON (¿no es Shopify?)`);
  return res.json();
}

async function fetchShopInfo(origin) {
  try {
    return await fetchJson(`${origin}/meta.json`);
  } catch {
    return {};
  }
}

async function fetchAllProducts(origin) {
  const list = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fetchJson(`${origin}/products.json?limit=250&page=${page}`);
    const items = data.products || [];
    list.push(...items);
    if (items.length < 250) break;
  }
  return list;
}

// Muchas tiendas exponen el orden "más vendidos" de su colección "all".
async function fetchBestSellerRanks(origin) {
  try {
    const data = await fetchJson(`${origin}/collections/all/products.json?sort_by=best-selling&limit=250`);
    const ranks = new Map();
    (data.products || []).forEach((p, i) => ranks.set(String(p.id), i + 1));
    return ranks;
  } catch {
    return new Map();
  }
}

const iso = (s) => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

function summarizeProduct(p) {
  const variants = p.variants || [];
  const prices = variants.map((v) => Number(v.price)).filter((n) => Number.isFinite(n));
  const compare = variants.map((v) => Number(v.compare_at_price)).filter((n) => Number.isFinite(n) && n > 0);
  return {
    id: String(p.id),
    title: p.title || "",
    handle: p.handle,
    vendor: p.vendor || "",
    productType: p.product_type || "",
    tags: Array.isArray(p.tags) ? p.tags : String(p.tags || "").split(",").map((t) => t.trim()).filter(Boolean),
    image: p.images?.[0]?.src || p.image?.src || null,
    price: prices.length ? Math.min(...prices) : null,
    compareAtPrice: compare.length ? Math.max(...compare) : null,
    available: variants.some((v) => v.available !== false),
    variantCount: variants.length,
    createdAt: iso(p.created_at),
    publishedAt: iso(p.published_at),
    updatedAt: iso(p.updated_at),
  };
}

function discount(p) {
  if (!p.compareAtPrice || !p.price || p.compareAtPrice <= p.price) return 0;
  return Math.round((1 - p.price / p.compareAtPrice) * 100);
}

const round = (n) => Math.round(n * 100) / 100;

// Huella de lo que nos importa: si no cambia, no se reescribe la fila (ahorra escrituras en D1).
const signature = (p) =>
  JSON.stringify([p.title, p.price, p.compareAtPrice, p.available, p.image, p.bestSellerRank, p.variantCount, p.tags.length]);

function productStmt(p) {
  return stmt(
    `INSERT INTO products (key, store_id, title, search, vendor, product_type, price, compare_at_price, discount, best_rank, created_at, first_seen_at, removed, sig, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(key) DO UPDATE SET title = excluded.title, search = excluded.search, vendor = excluded.vendor,
       product_type = excluded.product_type, price = excluded.price, compare_at_price = excluded.compare_at_price,
       discount = excluded.discount, best_rank = excluded.best_rank, created_at = excluded.created_at,
       removed = 0, sig = excluded.sig, data = excluded.data`,
    p.key,
    p.storeId,
    p.title,
    `${p.title} ${p.vendor} ${p.productType} ${p.tags.join(" ")}`.toLowerCase(),
    p.vendor,
    p.productType,
    p.price,
    p.compareAtPrice,
    discount(p),
    p.bestSellerRank,
    p.createdAt,
    p.firstSeenAt,
    signature(p),
    JSON.stringify(p),
  );
}

export async function getStore(id) {
  const row = await first("SELECT data FROM stores WHERE id = ?", id);
  return row ? parse(row.data) : null;
}

export function storeStmt(store) {
  return stmt(
    `INSERT INTO stores (id, data, added_at, last_scan_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, last_scan_at = excluded.last_scan_at`,
    store.id,
    JSON.stringify(store),
    store.addedAt,
    store.lastScanAt || null,
  );
}

export async function saveStore(store) {
  await storeStmt(store).run();
}

// Escanea una tienda, guarda los productos y devuelve un resumen de cambios.
export async function scanStore(input) {
  const origin = normalizeOrigin(input);
  const id = storeIdFromOrigin(origin);
  const [info, rawProducts, ranks, intel, prev, existingRows] = await Promise.all([
    fetchShopInfo(origin),
    fetchAllProducts(origin),
    fetchBestSellerRanks(origin),
    fetchStoreIntel(origin, UA),
    getStore(id),
    all("SELECT key, sig, removed, data FROM products WHERE store_id = ?", id),
  ]);

  const at = now();
  const firstScan = !prev;
  const existing = new Map(existingRows.map((r) => [r.key, r]));
  const writes = [];
  const seen = new Set();
  let newProducts = 0;
  let priceChanges = 0;

  for (const raw of rawProducts) {
    const p = summarizeProduct(raw);
    const key = `${id}:${p.id}`;
    seen.add(key);
    const rank = ranks.get(p.id) ?? null;
    const row = existing.get(key);
    if (!row) {
      if (!firstScan) {
        newProducts++;
        writes.push(eventStmt({ type: "new_product", storeId: id, productKey: key, title: p.title, price: p.price }));
      }
      writes.push(
        productStmt({
          ...p,
          key,
          storeId: id,
          url: `${origin}/products/${p.handle}`,
          bestSellerRank: rank,
          firstSeenAt: at,
          priceHistory: p.price != null ? [{ at, price: p.price }] : [],
        }),
      );
      continue;
    }
    const next = { ...p, bestSellerRank: rank };
    if (row.sig === signature(next) && !row.removed) continue;
    const old = parse(row.data, {});
    const history = old.priceHistory || [];
    if (p.price != null && old.price !== p.price) {
      priceChanges++;
      history.push({ at, price: p.price });
      writes.push(eventStmt({ type: "price_change", storeId: id, productKey: key, title: p.title, from: old.price, to: p.price }));
    }
    writes.push(productStmt({ ...old, ...next, key, storeId: id, priceHistory: history.slice(-50) }));
  }

  // Productos que ya no aparecen en la tienda
  let removedProducts = 0;
  for (const row of existingRows) {
    if (!seen.has(row.key) && !row.removed) {
      removedProducts++;
      writes.push(stmt("UPDATE products SET removed = 1 WHERE key = ?", row.key));
      writes.push(eventStmt({ type: "removed_product", storeId: id, productKey: row.key, title: parse(row.data, {}).title }));
    }
  }

  const live = rawProducts.map(summarizeProduct);
  const created = live.map((p) => Date.parse(p.createdAt)).filter(Number.isFinite);
  const prices = live.map((p) => p.price).filter((n) => n != null);
  const launched30d = created.filter((t) => Date.now() - t < 30 * DAY).length;
  const launched7d = created.filter((t) => Date.now() - t < 7 * DAY).length;
  // Productos editados en las últimas 24 h: señal de que la tienda está activa (stock, precios, etc.).
  const updated24h = live.filter((p) => Date.now() - Date.parse(p.updatedAt) < DAY).length;
  if (firstScan) writes.push(eventStmt({ type: "store_added", storeId: id, title: info.name || id, count: live.length }));

  const scan = { at, productCount: live.length, newProducts, priceChanges, removedProducts };
  const store = {
    ...(prev || { addedAt: at, notes: "", niche: "" }),
    id,
    origin,
    name: info.name || prev?.name || id,
    description: info.description || prev?.description || "",
    currency: info.currency || prev?.currency || "",
    country: info.country || prev?.country || "",
    myshopifyDomain: info.myshopify_domain || prev?.myshopifyDomain || "",
    productCount: live.length,
    avgPrice: prices.length ? round(prices.reduce((a, b) => a + b, 0) / prices.length) : null,
    oldestProductAt: created.length ? new Date(Math.min(...created)).toISOString() : null,
    launched30d,
    launched7d,
    updated24h,
    activityScore: Math.min(100, launched7d * 6 + launched30d * 2 + updated24h * 3),
    tech: intel || prev?.tech || null,
    hasBestSellerRanking: ranks.size > 0,
    lastScanAt: at,
    lastError: null,
    scans: [...(prev?.scans || []), scan].slice(-90),
  };
  writes.push(storeStmt(store));
  await batch(writes);
  return { store, scan };
}

export async function markScanError(input, err) {
  try {
    const store = await getStore(storeIdFrom(input));
    if (store) {
      store.lastError = String(err.message || err);
      await saveStore(store);
    }
  } catch {
    // dominio inválido: no hay nada que marcar
  }
}

export async function removeStore(id) {
  await batch([
    stmt("DELETE FROM products WHERE store_id = ?", id),
    stmt("DELETE FROM events WHERE store_id = ?", id),
    stmt("DELETE FROM stores WHERE id = ?", id),
  ]);
}

export async function listStores() {
  return (await all("SELECT data FROM stores")).map((r) => parse(r.data));
}

// Explorador de tiendas con filtros (nicho, país, tema, app, píxel...).
export async function searchStores({ q = "", niche = "", country = "", currency = "", theme = "", app = "", pixel = "", minProducts, sort = "added" } = {}) {
  const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const has = (list, v) => !v || (list || []).some((x) => x.toLowerCase() === String(v).toLowerCase());
  const list = (await listStores()).filter((s) => {
    if (niche && !String(s.niche).toLowerCase().includes(niche.toLowerCase())) return false;
    if (country && s.country !== country) return false;
    if (currency && s.currency !== currency) return false;
    if (theme && String(s.tech?.theme || "").toLowerCase() !== theme.toLowerCase()) return false;
    if (!has(s.tech?.apps, app) || !has(s.tech?.pixels, pixel)) return false;
    if (minProducts && s.productCount < Number(minProducts)) return false;
    if (terms.length) {
      const hay = `${s.id} ${s.name} ${s.description} ${s.niche} ${s.notes}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
  const sorters = {
    added: (a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt),
    activity: (a, b) => (b.activityScore || 0) - (a.activityScore || 0),
    launched: (a, b) => (b.launched30d || 0) - (a.launched30d || 0),
    products: (a, b) => b.productCount - a.productCount,
    price: (a, b) => (b.avgPrice || 0) - (a.avgPrice || 0),
    ads: (a, b) => (b.ads?.active || 0) - (a.ads?.active || 0),
  };
  list.sort(sorters[sort] || sorters.added);
  return list.map(({ scans, ...s }) => ({ ...s, lastScan: scans?.[scans.length - 1] || null }));
}

// Valores disponibles para los filtros del explorador.
export function storeFacets(stores) {
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort();
  return {
    countries: uniq(stores.map((s) => s.country)),
    currencies: uniq(stores.map((s) => s.currency)),
    themes: uniq(stores.map((s) => s.tech?.theme)),
    apps: uniq(stores.flatMap((s) => s.tech?.apps || [])),
    pixels: uniq(stores.flatMap((s) => s.tech?.pixels || [])),
    niches: uniq(stores.map((s) => s.niche)),
  };
}

async function storeNames() {
  const rows = await all("SELECT id, data FROM stores");
  return new Map(rows.map((r) => [r.id, parse(r.data, {})]));
}

function hydrate(row, stores) {
  const p = parse(row.data, {});
  const store = stores.get(row.store_id) || {};
  return {
    ...p,
    key: row.key,
    storeId: row.store_id,
    removed: Boolean(row.removed),
    storeName: store.name || row.store_id,
    currency: store.currency || "",
    discountPct: row.discount,
  };
}

export async function getProduct(key) {
  const row = await first("SELECT * FROM products WHERE key = ?", key);
  return row ? hydrate(row, await storeNames()) : null;
}

// Búsqueda y filtrado de productos de todas las tiendas rastreadas.
export async function searchProducts({ q = "", storeId = "", vendor = "", productType = "", minPrice, maxPrice, sort = "newest", days, limit = 60, offset = 0 } = {}) {
  const where = ["removed = 0"];
  const params = [];
  const add = (sql, ...values) => {
    where.push(sql);
    params.push(...values);
  };
  if (storeId) add("store_id = ?", storeId);
  if (vendor) add("vendor = ?", vendor);
  if (productType) add("product_type = ?", productType);
  if (minPrice != null && minPrice !== "") add("price >= ?", Number(minPrice));
  if (maxPrice != null && maxPrice !== "") add("price <= ?", Number(maxPrice));
  if (days) add("COALESCE(created_at, first_seen_at) >= ?", new Date(Date.now() - Number(days) * DAY).toISOString());
  for (const term of String(q).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) add("search LIKE ?", `%${term}%`);

  const orders = {
    newest: "COALESCE(created_at, first_seen_at) DESC",
    oldest: "COALESCE(created_at, first_seen_at) ASC",
    price_asc: "price ASC",
    price_desc: "price DESC",
    bestseller: "best_rank IS NULL, best_rank ASC",
    discount: "discount DESC",
  };
  const clause = where.join(" AND ");
  const lim = Math.min(Math.max(Number(limit) || 60, 1), 1000);
  const off = Math.max(Number(offset) || 0, 0);
  const [count, rows, stores] = await Promise.all([
    first(`SELECT COUNT(*) AS n FROM products WHERE ${clause}`, ...params),
    all(`SELECT * FROM products WHERE ${clause} ORDER BY ${orders[sort] || orders.newest} LIMIT ? OFFSET ?`, ...params, lim, off),
    storeNames(),
  ]);
  return { total: count.n, products: rows.map((r) => hydrate(r, stores)) };
}

export async function recentEvents({ type = "", storeId = "", limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (type) {
    where.push("type = ?");
    params.push(type);
  }
  if (storeId) {
    where.push("store_id = ?");
    params.push(storeId);
  }
  const rows = await all(
    `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`,
    ...params,
    Math.min(Number(limit) || 100, 500),
  );
  const stores = await storeNames();
  return rows.map((e) => ({
    ...parse(e.data, {}),
    at: e.at,
    type: e.type,
    storeId: e.store_id,
    storeName: stores.get(e.store_id)?.name || e.store_id,
  }));
}

export async function dashboardStats(usage) {
  const weekAgo = new Date(Date.now() - 7 * DAY).toISOString();
  const [stores, products, fresh, priceChanges, events] = await Promise.all([
    listStores(),
    first("SELECT COUNT(*) AS n FROM products WHERE removed = 0"),
    first("SELECT COUNT(*) AS n FROM products WHERE removed = 0 AND COALESCE(created_at, first_seen_at) > ?", weekAgo),
    first("SELECT COUNT(*) AS n FROM events WHERE type = 'price_change' AND at > ?", weekAgo),
    recentEvents({ limit: 30 }),
  ]);
  return {
    stores: stores.length,
    products: products.n,
    newThisWeek: fresh.n,
    priceChangesThisWeek: priceChanges.n,
    topLaunching: [...stores]
      .sort((a, b) => (b.launched30d || 0) - (a.launched30d || 0))
      .slice(0, 5)
      .map((s) => ({ id: s.id, name: s.name, launched30d: s.launched30d, productCount: s.productCount })),
    activeAds: stores.reduce((n, s) => n + (s.ads?.active || 0), 0),
    events,
    usage,
  };
}
