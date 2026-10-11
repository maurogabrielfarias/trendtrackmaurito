// Anuncios: enlaces directos a bibliotecas de anuncios + Meta Ad Library API opcional.
import { ENV, eventStmt } from "./db.js";
import { getStore, saveStore } from "./shopify.js";

export function adLibraryLinks(term, country = "ALL") {
  const q = encodeURIComponent(term);
  return [
    {
      name: "Meta Ad Library (Facebook / Instagram)",
      url: `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${country}&q=${q}&search_type=keyword_unordered&media_type=all`,
    },
    { name: "TikTok Creative Center", url: `https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en?keyword=${q}` },
    { name: "TikTok Ads Library", url: `https://library.tiktok.com/ads?region=all&adv_name=${q}` },
    { name: "Google Ads Transparency", url: `https://adstransparency.google.com/?region=anywhere&domain=${q}` },
  ];
}

// La API de Meta devuelve anuncios comerciales solo para países de la UE/UK.
export async function searchMetaAds({ term, country = "ES", limit = 25 }) {
  const token = ENV.META_ACCESS_TOKEN;
  if (!token) {
    return { configured: false, ads: [] };
  }
  const params = new URLSearchParams({
    search_terms: term,
    ad_reached_countries: JSON.stringify([country]),
    ad_type: "ALL",
    ad_active_status: "ACTIVE",
    limit: String(limit),
    fields: [
      "id",
      "page_name",
      "ad_creation_time",
      "ad_delivery_start_time",
      "ad_creative_bodies",
      "ad_creative_link_titles",
      "ad_creative_link_captions",
      "publisher_platforms",
      "eu_total_reach",
    ].join(","),
    access_token: token,
  });
  const res = await fetch(`https://graph.facebook.com/v21.0/ads_archive?${params}`, {
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Meta API HTTP ${res.status}`);
  const ads = (data.data || []).map((a) => {
    const start = a.ad_delivery_start_time ? Date.parse(a.ad_delivery_start_time) : null;
    return {
      id: a.id,
      page: a.page_name,
      startedAt: a.ad_delivery_start_time || a.ad_creation_time || null,
      daysRunning: start ? Math.max(0, Math.round((Date.now() - start) / 86400000)) : null,
      body: a.ad_creative_bodies?.[0] || "",
      title: a.ad_creative_link_titles?.[0] || "",
      caption: a.ad_creative_link_captions?.[0] || "",
      platforms: a.publisher_platforms || [],
      reach: a.eu_total_reach ?? null,
      // ad_snapshot_url lleva el access token: enlazamos la ficha pública en su lugar
      url: `https://www.facebook.com/ads/library/?id=${a.id}`,
    };
  });
  // Los anuncios que llevan más días activos suelen ser los que funcionan.
  ads.sort((a, b) => (b.daysRunning ?? 0) - (a.daysRunning ?? 0));
  return { configured: true, ads };
}

// Seguimiento de anuncios activos de una tienda rastreada (busca su dominio en la Ad Library).
export async function trackStoreAds(storeId, country = ENV.META_ADS_COUNTRY || "ES") {
  const store = await getStore(storeId);
  if (!store) throw new Error("Tienda no encontrada");
  const { configured, ads } = await searchMetaAds({ term: storeId, country, limit: 100 });
  if (!configured) return null;
  const now = new Date().toISOString();
  const prev = store.ads?.active ?? null;
  store.ads = {
    active: ads.length,
    longestRunningDays: ads[0]?.daysRunning ?? null,
    top: ads.slice(0, 10),
    checkedAt: now,
    country,
    history: [...(store.ads?.history || []), { at: now, active: ads.length }].slice(-90),
  };
  if (prev != null && ads.length > prev) {
    await eventStmt({ type: "new_ads", storeId, title: store.name, from: prev, to: ads.length }).run();
  }
  await saveStore(store);
  return store.ads;
}
