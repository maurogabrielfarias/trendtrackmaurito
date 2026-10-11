// Rastreo de tiendas Shopify usando sus endpoints públicos (/products.json, /meta.json).
import { db, save, addEvent } from "./db.js";
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
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fetchJson(`${origin}/products.json?limit=250&page=${page}`);
    const batch = data.products || [];
    all.push(...batch);
    if (batch.length < 250) break;
  }
  return all;
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

function summarizeProduct(p) {
  const variants = p.variants || [];
  const prices = variants.map((v) => Number(v.price)).filter((n) => Number.isFinite(n));
  const compare = variants.map((v) => Number(v.compare_at_price)).filter((n) => Number.isFinite(n) && n > 0);
  return {
    id: String(p.id),
    title: p.title,
    handle: p.handle,
    vendor: p.vendor || "",
    productType: p.product_type || "",
    tags: Array.isArray(p.tags) ? p.tags : String(p.tags || "").split(",").map((t) => t.trim()).filter(Boolean),
    image: p.images?.[0]?.src || p.image?.src || null,
    price: prices.length ? Math.min(...prices) : null,
    compareAtPrice: compare.length ? Math.max(...compare) : null,
    available: variants.some((v) => v.available !== false),
    variantCount: variants.length,
    createdAt: p.created_at || null,
    publishedAt: p.published_at || null,
    updatedAt: p.updated_at || null,
  };
}

// Escanea una tienda, guarda los productos y devuelve un resumen de cambios.
export async function scanStore(input) {
  const origin = normalizeOrigin(input);
  const id = storeIdFromOrigin(origin);
  const [info, rawProducts, ranks, intel] = await Promise.all([
    fetchShopInfo(origin),
    fetchAllProducts(origin),
    fetchBestSellerRanks(origin),
    fetchStoreIntel(origin, UA),
  ]);

  const state = db();
  const now = new Date().toISOString();
  const prev = state.stores[id];
  const firstScan = !prev;
  const seen = new Set();
  let newProducts = 0;
  let priceChanges = 0;

  for (const raw of rawProducts) {
    const p = summarizeProduct(raw);
    const key = `${id}:${p.id}`;
    seen.add(key);
    const old = state.products[key];
    const rank = ranks.get(p.id) ?? null;
    if (!old) {
      if (!firstScan) {
        newProducts++;
        addEvent({ type: "new_product", storeId: id, productKey: key, title: p.title, price: p.price });
      }
      state.products[key] = {
        ...p,
        storeId: id,
        url: `${origin}/products/${p.handle}`,
        bestSellerRank: rank,
        firstSeenAt: now,
        lastSeenAt: now,
        removed: false,
        priceHistory: p.price != null ? [{ at: now, price: p.price }] : [],
      };
    } else {
      const history = old.priceHistory || [];
      if (p.price != null && old.price !== p.price) {
        priceChanges++;
        addEvent({ type: "price_change", storeId: id, productKey: key, title: p.title, from: old.price, to: p.price });
        history.push({ at: now, price: p.price });
      }
      state.products[key] = {
        ...old,
        ...p,
        bestSellerRank: rank,
        lastSeenAt: now,
        removed: false,
        priceHistory: history.slice(-50),
      };
    }
  }

  // Productos que ya no aparecen en la tienda
  let removedProducts = 0;
  for (const [key, p] of Object.entries(state.products)) {
    if (p.storeId === id && !seen.has(key) && !p.removed) {
      p.removed = true;
      removedProducts++;
      addEvent({ type: "removed_product", storeId: id, productKey: key, title: p.title });
    }
  }

  const live = rawProducts.map(summarizeProduct);
  const created = live.map((p) => Date.parse(p.createdAt)).filter(Number.isFinite);
  const prices = live.map((p) => p.price).filter((n) => n != null);
  const launched30d = created.filter((t) => Date.now() - t < 30 * DAY).length;
  const launched7d = created.filter((t) => Date.now() - t < 7 * DAY).length;
  // Productos editados en las últimas 24 h: señal de que la tienda está activa (stock, precios, etc.).
  const updated24h = live.filter((p) => Date.now() - Date.parse(p.updatedAt) < DAY).length;
  if (firstScan) addEvent({ type: "store_added", storeId: id, title: info.name || id, count: live.length });

  const scan = { at: now, productCount: live.length, newProducts, priceChanges, removedProducts };
  state.stores[id] = {
    ...(prev || { addedAt: now, notes: "", niche: "" }),
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
    lastScanAt: now,
    lastError: null,
    scans: [...(prev?.scans || []), scan].slice(-90),
  };
  save();
  return { store: state.stores[id], scan };
}

export function markScanError(input, err) {
  try {
    const id = storeIdFromOrigin(normalizeOrigin(input));
    const store = db().stores[id];
    if (store) {
      store.lastError = String(err.message || err);
      save();
    }
  } catch {
    // dominio inválido: no hay nada que marcar
  }
}

export function removeStore(id) {
  const state = db();
  delete state.stores[id];
  state.events = state.events.filter((e) => e.storeId !== id);
  for (const key of Object.keys(state.products)) {
    if (state.products[key].storeId === id) delete state.products[key];
  }
  save();
}

// Explorador de tiendas con filtros (nicho, país, tema, app, píxel...).
export function searchStores({ q = "", niche = "", country = "", currency = "", theme = "", app = "", pixel = "", minProducts, sort = "added" } = {}) {
  const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const has = (list, v) => !v || (list || []).some((x) => x.toLowerCase() === String(v).toLowerCase());
  let list = Object.values(db().stores).filter((s) => {
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
export function storeFacets() {
  const stores = Object.values(db().stores);
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

export function getProduct(key) {
  const p = db().products[key];
  if (!p) return null;
  const store = db().stores[p.storeId];
  return { ...p, key, storeName: store?.name || p.storeId, currency: store?.currency || "", discountPct: discount(p) };
}

export function recentEvents({ type = "", storeId = "", limit = 100 } = {}) {
  const stores = db().stores;
  return db()
    .events.filter((e) => (!type || e.type === type) && (!storeId || e.storeId === storeId))
    .slice(0, Number(limit))
    .map((e) => ({ ...e, storeName: stores[e.storeId]?.name || e.storeId }));
}

// Búsqueda y filtrado de productos de todas las tiendas rastreadas.
export function searchProducts({ q = "", storeId = "", vendor = "", productType = "", minPrice, maxPrice, sort = "newest", days, limit = 60, offset = 0 } = {}) {
  const state = db();
  const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const since = days ? Date.now() - Number(days) * DAY : null;
  let list = Object.values(state.products).filter((p) => {
    if (p.removed) return false;
    if (storeId && p.storeId !== storeId) return false;
    if (minPrice != null && minPrice !== "" && (p.price ?? 0) < Number(minPrice)) return false;
    if (maxPrice != null && maxPrice !== "" && (p.price ?? Infinity) > Number(maxPrice)) return false;
    if (vendor && p.vendor !== vendor) return false;
    if (productType && p.productType !== productType) return false;
    if (since && Date.parse(p.createdAt || p.firstSeenAt) < since) return false;
    if (terms.length) {
      const hay = `${p.title} ${p.vendor} ${p.productType} ${p.tags.join(" ")}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });

  const ts = (p) => Date.parse(p.createdAt || p.firstSeenAt) || 0;
  const sorters = {
    newest: (a, b) => ts(b) - ts(a),
    oldest: (a, b) => ts(a) - ts(b),
    price_asc: (a, b) => (a.price ?? 0) - (b.price ?? 0),
    price_desc: (a, b) => (b.price ?? 0) - (a.price ?? 0),
    bestseller: (a, b) => (a.bestSellerRank ?? 1e9) - (b.bestSellerRank ?? 1e9),
    discount: (a, b) => discount(b) - discount(a),
  };
  list.sort(sorters[sort] || sorters.newest);
  const total = list.length;
  list = list.slice(Number(offset), Number(offset) + Number(limit)).map((p) => ({
    ...p,
    key: `${p.storeId}:${p.id}`,
    storeName: state.stores[p.storeId]?.name || p.storeId,
    currency: state.stores[p.storeId]?.currency || "",
    discountPct: discount(p),
  }));
  return { total, products: list };
}

function discount(p) {
  if (!p.compareAtPrice || !p.price || p.compareAtPrice <= p.price) return 0;
  return Math.round((1 - p.price / p.compareAtPrice) * 100);
}

function round(n) {
  return Math.round(n * 100) / 100;
}

export function dashboardStats() {
  const state = db();
  const products = Object.values(state.products).filter((p) => !p.removed);
  const weekAgo = Date.now() - 7 * DAY;
  const stores = Object.values(state.stores);
  return {
    stores: stores.length,
    products: products.length,
    newThisWeek: products.filter((p) => Date.parse(p.createdAt || p.firstSeenAt) > weekAgo).length,
    priceChangesThisWeek: stores.reduce(
      (n, s) => n + (s.scans || []).filter((x) => Date.parse(x.at) > weekAgo).reduce((m, x) => m + x.priceChanges, 0),
      0,
    ),
    topLaunching: [...stores]
      .sort((a, b) => (b.launched30d || 0) - (a.launched30d || 0))
      .slice(0, 5)
      .map((s) => ({ id: s.id, name: s.name, launched30d: s.launched30d, productCount: s.productCount })),
    activeAds: stores.reduce((n, s) => n + (s.ads?.active || 0), 0),
    events: recentEvents({ limit: 30 }),
    usage: state.usage,
  };
}
