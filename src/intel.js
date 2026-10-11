// Inteligencia de la tienda a partir de su HTML público: tema, apps, píxeles y redes sociales.

const APPS = [
  ["Klaviyo", /klaviyo\.com/i],
  ["Omnisend", /omnisend(cdn)?\.com|omnisrc\.com/i],
  ["Privy", /privy\.com/i],
  ["Judge.me", /judge\.me|judgeme/i],
  ["Loox", /loox\.io/i],
  ["Yotpo", /yotpo\.com/i],
  ["Okendo", /okendo\.io/i],
  ["Stamped", /stamped\.io/i],
  ["Reviews.io", /reviews\.io|reviews\.co\.uk/i],
  ["Ali Reviews", /alireviews/i],
  ["Rivyo", /rivyo/i],
  ["ReCharge", /rechargecdn|rechargepayments|rc_container/i],
  ["Skio", /skio\.com/i],
  ["Gorgias", /gorgias\.(chat|io)/i],
  ["Tidio", /tidio\.co|tidiochat/i],
  ["Zendesk", /zdassets\.com|zendesk/i],
  ["Intercom", /intercom(cdn)?\.(io|com)/i],
  ["AfterShip", /aftership\.com/i],
  ["Route", /route\.com|routeapp/i],
  ["Klarna", /klarna/i],
  ["Afterpay", /afterpay/i],
  ["Sezzle", /sezzle/i],
  ["PageFly", /pagefly/i],
  ["GemPages", /gempages/i],
  ["Shogun", /getshogun|shogun/i],
  ["Zipify Pages", /zipify/i],
  ["Replo", /replo/i],
  ["Vitals", /vitals\.(co|app)|appsolve/i],
  ["Bold", /boldapps|boldcommerce/i],
  ["ReConvert", /reconvert/i],
  ["Frequently Bought Together", /frequently-bought|codeblackbelt/i],
  ["Rebuy", /rebuyengine/i],
  ["UpCart", /upcart/i],
  ["Kaching Bundles", /kaching/i],
  ["Smile.io", /smile\.io|smile-io/i],
  ["LoyaltyLion", /loyaltylion/i],
  ["Weglot", /weglot/i],
  ["Langify", /langify/i],
  ["Hotjar", /hotjar/i],
  ["Microsoft Clarity", /clarity\.ms/i],
  ["Triple Whale", /triplewhale|triplepixel/i],
  ["Elevar", /elevar/i],
  ["Attentive", /attentivemobile|attn\.tv/i],
  ["Postscript", /postscript\.io/i],
  ["Justuno", /justuno/i],
  ["Growave", /growave/i],
  ["DSers", /dsers/i],
  ["Zendrop", /zendrop/i],
  ["CJ Dropshipping", /cjdropshipping/i],
  ["AutoDS", /autods/i],
];

const PIXELS = [
  ["Meta Pixel", /connect\.facebook\.net|fbq\(/i],
  ["TikTok Pixel", /analytics\.tiktok\.com|ttq\.load/i],
  ["Google Analytics", /google-analytics\.com|gtag\(|G-[A-Z0-9]{6,}/],
  ["Google Tag Manager", /googletagmanager\.com\/gtm/i],
  ["Google Ads", /AW-\d{6,}/],
  ["Snapchat Pixel", /sc-static\.net|snaptr\(/i],
  ["Pinterest Tag", /pintrk\(|s\.pinimg\.com\/ct/i],
  ["X / Twitter Pixel", /static\.ads-twitter\.com|twq\(/i],
];

const SOCIAL = {
  instagram: /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]+)/i,
  tiktok: /https?:\/\/(?:www\.)?tiktok\.com\/@([A-Za-z0-9_.]+)/i,
  facebook: /https?:\/\/(?:www\.|m\.)?facebook\.com\/([A-Za-z0-9_.-]+)/i,
  youtube: /https?:\/\/(?:www\.)?youtube\.com\/(@?[A-Za-z0-9_/-]+)/i,
  pinterest: /https?:\/\/(?:[a-z]+\.)?pinterest\.[a-z.]+\/([A-Za-z0-9_]+)/i,
  twitter: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]+)/i,
};

export function analyzeHtml(html) {
  const theme = html.match(/Shopify\.theme\s*=\s*(\{[^;]*?\})\s*;/);
  let themeName = null;
  let themeStoreId = null;
  if (theme) {
    try {
      const t = JSON.parse(theme[1]);
      themeName = t.schema_name || t.name || null;
      themeStoreId = t.theme_store_id ?? null;
    } catch {
      themeName = theme[1].match(/"name"\s*:\s*"([^"]+)"/)?.[1] || null;
    }
  }
  const socials = {};
  for (const [name, re] of Object.entries(SOCIAL)) {
    const m = html.match(re);
    if (m && !/sharer|share\.php|intent|plugins|tr\?/.test(m[0])) socials[name] = m[0];
  }
  return {
    isShopify: /cdn\.shopify\.com|Shopify\.theme|myshopify\.com/i.test(html),
    theme: themeName,
    themeStoreId,
    apps: APPS.filter(([, re]) => re.test(html)).map(([name]) => name),
    pixels: PIXELS.filter(([, re]) => re.test(html)).map(([name]) => name),
    socials,
    language: html.match(/<html[^>]*\blang=["']?([a-zA-Z-]+)/i)?.[1] || null,
    title: decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || ""),
    metaDescription: decode(html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] || ""),
  };
}

function decode(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export async function fetchStoreIntel(origin, userAgent) {
  try {
    const res = await fetch(origin, {
      headers: { "User-Agent": userAgent, Accept: "text/html" },
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    return { ...analyzeHtml(await res.text()), checkedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}
