// Tienda Shopify simulada para las pruebas.
import http from "node:http";

export function startFakeShop() {
  const day = 86400000;
  const state = {
    products: [
      product(1, "Corrector de postura", 29.99, 49.99, Date.now() - 2 * day),
      product(2, "Cepillo para mascotas", 19.5, null, Date.now() - 40 * day),
      product(3, "Lámpara de luna 3D", 34, 59, Date.now() - 200 * day),
    ],
  };
  const html = `<!doctype html><html lang="es"><head><title>Fake &amp; Shop</title>
    <meta name="description" content="La mejor tienda"><script>Shopify.theme = {"name":"Dawn","id":1,"schema_name":"Dawn","theme_store_id":887};</script>
    <script src="https://cdn.shopify.com/x.js"></script><script src="https://static.klaviyo.com/onsite.js"></script>
    <script src="https://loox.io/widget.js"></script><script>!function(){fbq('init','1')}()</script>
    <script src="https://connect.facebook.net/en_US/fbevents.js"></script></head>
    <body><a href="https://www.instagram.com/fakeshop">IG</a><a href="https://www.tiktok.com/@fakeshop">TT</a></body></html>`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (obj) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === "/products.json") return send({ products: url.searchParams.get("page") === "1" ? state.products : [] });
    if (url.pathname === "/collections/all/products.json") return send({ products: [...state.products].reverse() });
    if (url.pathname === "/meta.json") return send({ name: "Fake Shop", currency: "EUR", country: "ES", description: "Tienda falsa" });
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(html);
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, state, origin: `http://127.0.0.1:${server.address().port}`, product })),
  );
}

function product(id, title, price, compare, created) {
  return {
    id,
    title,
    handle: title.toLowerCase().replace(/\s+/g, "-"),
    vendor: "Fake",
    product_type: "Hogar",
    tags: ["tendencia"],
    images: [{ src: `https://cdn.example.com/${id}.jpg` }],
    created_at: new Date(created).toISOString(),
    published_at: new Date(created).toISOString(),
    updated_at: new Date().toISOString(),
    variants: [{ price: String(price), compare_at_price: compare ? String(compare) : null, available: true }],
  };
}
