// Exportación a CSV (se abre en Excel / Google Sheets).
import { searchProducts, searchStores } from "./shopify.js";

function csv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? "" : Array.isArray(v) ? v.join(" | ") : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [columns.map(([h]) => h).join(","), ...rows.map((r) => columns.map(([, f]) => esc(f(r))).join(","))].join("\n");
}

export async function productsCsv(filters) {
  const { products } = await searchProducts({ ...filters, limit: 1000, offset: 0 });
  return csv(products, [
    ["Producto", (p) => p.title],
    ["Tienda", (p) => p.storeId],
    ["Precio", (p) => p.price],
    ["Precio anterior", (p) => p.compareAtPrice],
    ["Descuento %", (p) => p.discountPct],
    ["Moneda", (p) => p.currency],
    ["Tipo", (p) => p.productType],
    ["Proveedor", (p) => p.vendor],
    ["Ranking más vendidos", (p) => p.bestSellerRank],
    ["Creado", (p) => p.createdAt],
    ["Visto por primera vez", (p) => p.firstSeenAt],
    ["URL", (p) => p.url],
    ["Imagen", (p) => p.image],
  ]);
}

export async function storesCsv(filters) {
  return csv(await searchStores(filters), [
    ["Tienda", (s) => s.name],
    ["Dominio", (s) => s.id],
    ["Nicho", (s) => s.niche],
    ["País", (s) => s.country],
    ["Moneda", (s) => s.currency],
    ["Productos", (s) => s.productCount],
    ["Precio medio", (s) => s.avgPrice],
    ["Lanzados 7d", (s) => s.launched7d],
    ["Lanzados 30d", (s) => s.launched30d],
    ["Actividad", (s) => s.activityScore],
    ["Anuncios activos", (s) => s.ads?.active],
    ["Tema", (s) => s.tech?.theme],
    ["Apps", (s) => s.tech?.apps],
    ["Píxeles", (s) => s.tech?.pixels],
    ["Instagram", (s) => s.tech?.socials?.instagram],
    ["TikTok", (s) => s.tech?.socials?.tiktok],
    ["Agregada", (s) => s.addedAt],
    ["Último escaneo", (s) => s.lastScanAt],
  ]);
}
