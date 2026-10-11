// TrendTrack Maurito — interfaz web (JavaScript sin frameworks).
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast${isError ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), 4500);
}

function money(n, currency) {
  if (n == null) return "—";
  try {
    return new Intl.NumberFormat("es", { style: "currency", currency: currency || "USD", maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${n} ${currency || ""}`;
  }
}

function ago(iso) {
  if (!iso) return "—";
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (d < 60) return "ahora";
  if (d < 3600) return `hace ${Math.round(d / 60)} min`;
  if (d < 86400) return `hace ${Math.round(d / 3600)} h`;
  if (d < 86400 * 60) return `hace ${Math.round(d / 86400)} d`;
  return new Date(iso).toLocaleDateString("es");
}

const qs = (form) => new URLSearchParams([...new FormData(form)].filter(([, v]) => v !== ""));

function openModal(html) {
  $("#modalContent").innerHTML = html;
  $("#modal").classList.remove("hidden");
}
function closeModal() {
  $("#modal").classList.add("hidden");
}
$("#closeModal").onclick = closeModal;
// Ojo: un handler onclick que devuelve false cancela el clic, por eso va entre llaves.
$("#modal").onclick = (e) => {
  if (e.target.id === "modal") closeModal();
};
document.addEventListener("keydown", (e) => e.key === "Escape" && closeModal());

async function busy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Procesando…";
  try {
    return await fn();
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// ---------- Navegación ----------
const loaders = {};
function show(view) {
  if (!loaders[view]) view = "dashboard";
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  $$("nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
  loaders[view]();
}
window.addEventListener("hashchange", () => show(location.hash.slice(1)));

function goToAi(mode, prompt) {
  closeModal();
  location.hash = "ai";
  newChat();
  $("#chatForm").mode.value = mode;
  $("#chatForm").prompt.value = prompt;
  $("#chatForm").prompt.focus();
}

// ---------- Componentes ----------
function productCard(p) {
  const img = p.image ? `<img loading="lazy" src="${esc(p.image)}&width=400" onerror="this.src='${esc(p.image)}'" alt="">` : `<div class="noimg">Sin imagen</div>`;
  return `<div class="product" data-key="${esc(p.key)}">
    ${img}
    <div class="info">
      <div class="title">${esc(p.title)}</div>
      <div><span class="price">${money(p.price, p.currency)}</span>${p.compareAtPrice > p.price ? `<span class="compare">${money(p.compareAtPrice, p.currency)}</span>` : ""}</div>
      <div class="muted" style="font-size:12px">${esc(p.storeName || p.storeId)} · ${ago(p.createdAt || p.firstSeenAt)}</div>
      <div>${p.bestSellerRank ? `<span class="pill accent">#${p.bestSellerRank} ventas</span>` : ""}${p.discountPct ? `<span class="pill green">-${p.discountPct}%</span>` : ""}</div>
    </div>
  </div>`;
}

function bindProductCards(root) {
  $$(".product", root).forEach((el) => (el.onclick = () => openProduct(el.dataset.key)));
}

const EVENT_TEXT = {
  new_product: (e) => `🆕 <b>${esc(e.storeName)}</b> lanzó <b>${esc(e.title)}</b> ${e.price != null ? `(${e.price})` : ""}`,
  price_change: (e) => `💲 <b>${esc(e.storeName)}</b> cambió el precio de <b>${esc(e.title)}</b>: ${e.from} → ${e.to}`,
  removed_product: (e) => `🗑️ <b>${esc(e.storeName)}</b> retiró <b>${esc(e.title)}</b>`,
  new_ads: (e) => `📣 <b>${esc(e.storeName)}</b> pasó de ${e.from} a ${e.to} anuncios activos`,
  store_added: (e) => `🏬 Tienda agregada: <b>${esc(e.storeName)}</b> (${e.count} productos)`,
};
function eventsHtml(events) {
  if (!events.length) return `<p class="muted">Sin alertas todavía. Rastrea tiendas y vuelve a escanearlas para detectar cambios.</p>`;
  return events
    .map((e) => `<div class="event"><span class="when">${ago(e.at)}</span><span>${(EVENT_TEXT[e.type] || (() => esc(e.type)))(e)}</span></div>`)
    .join("");
}

function bars(values) {
  const max = Math.max(1, ...values);
  return `<div class="bars">${values.map((v) => `<i style="height:${(v / max) * 100}%" title="${v}"></i>`).join("")}</div>`;
}

// ---------- Dashboard ----------
loaders.dashboard = async () => {
  const [s, active, fresh] = await Promise.all([
    api("/api/stats"),
    api("/api/stores?sort=activity"),
    api("/api/products?days=7&sort=newest&limit=12"),
  ]);
  const kpis = [
    ["Tiendas rastreadas", s.stores],
    ["Productos", s.products],
    ["Lanzados esta semana", s.newThisWeek],
    ["Cambios de precio (7d)", s.priceChangesThisWeek],
    ["Anuncios activos", s.activeAds],
    ["Gasto IA estimado", money(s.usage.costUsd, "USD")],
  ];
  $("#kpis").innerHTML = kpis.map(([l, v]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
  $("#topLaunching").innerHTML = active.stores.length
    ? `<table><tr><th>Tienda</th><th>Actividad</th><th>Lanz. 30d</th><th>Productos</th></tr>${active.stores
        .slice(0, 8)
        .map(
          (t) =>
            `<tr class="clickable" data-id="${esc(t.id)}"><td>${esc(t.name)}</td><td><span class="score"><i style="width:${t.activityScore || 0}%"></i></span>${t.activityScore || 0}</td><td>${t.launched30d ?? 0}</td><td>${t.productCount}</td></tr>`,
        )
        .join("")}</table>`
    : `<p class="muted">Aún no rastreas tiendas. Ve a <a href="#stores">Tiendas</a> o pídele a Claude que encuentre algunas.</p>`;
  $$("#topLaunching tr[data-id]").forEach((tr) => (tr.onclick = () => openStore(tr.dataset.id)));
  $("#dashEvents").innerHTML = eventsHtml(s.events.slice(0, 12));
  $("#newProducts").innerHTML = fresh.products.length ? fresh.products.map(productCard).join("") : `<p class="muted">Nada nuevo esta semana.</p>`;
  bindProductCards($("#newProducts"));
};

// ---------- Tiendas ----------
function fillSelect(select, values, placeholder) {
  const current = select.value;
  select.innerHTML = `<option value="">${placeholder}</option>` + values.map((v) => `<option>${esc(v)}</option>`).join("");
  select.value = values.includes(current) ? current : "";
}

loaders.stores = async () => {
  const form = $("#storeFilters");
  const params = qs(form);
  $("#exportStores").href = `/api/export/stores.csv?${params}`;
  const { stores, facets } = await api(`/api/stores?${params}`);
  fillSelect(form.niche, facets.niches, "Nicho");
  fillSelect(form.country, facets.countries, "País");
  fillSelect(form.theme, facets.themes, "Tema");
  fillSelect(form.app, facets.apps, "App");
  fillSelect(form.pixel, facets.pixels, "Píxel");
  $("#storesTable").innerHTML = stores.length
    ? `<div class="table-wrap"><table>
      <tr><th>Tienda</th><th>Nicho</th><th>Productos</th><th>Precio medio</th><th>Lanz. 7d / 30d</th><th>Actividad</th><th>Anuncios</th><th>Tema / Apps</th><th>Último escaneo</th><th></th></tr>
      ${stores
        .map(
          (s) => `<tr class="clickable" data-id="${esc(s.id)}">
        <td><b>${esc(s.name)}</b><br><span class="muted">${esc(s.id)}</span>${s.lastError ? `<br><span class="pill red" title="${esc(s.lastError)}">error</span>` : ""}</td>
        <td>${esc(s.niche) || "<span class=muted>—</span>"}</td>
        <td>${s.productCount}</td>
        <td>${money(s.avgPrice, s.currency)}</td>
        <td>${s.launched7d ?? 0} / ${s.launched30d ?? 0}</td>
        <td><span class="score"><i style="width:${s.activityScore || 0}%"></i></span>${s.activityScore || 0}</td>
        <td>${s.ads ? s.ads.active : '<span class="muted">—</span>'}</td>
        <td>${s.tech?.theme ? `<span class="pill">${esc(s.tech.theme)}</span>` : ""}${(s.tech?.apps || []).slice(0, 3).map((a) => `<span class="pill accent">${esc(a)}</span>`).join("")}${(s.tech?.apps || []).length > 3 ? `<span class="pill">+${s.tech.apps.length - 3}</span>` : ""}</td>
        <td>${ago(s.lastScanAt)}</td>
        <td><button class="ghost icon" data-scan="${esc(s.id)}" title="Re-escanear">↻</button></td>
      </tr>`,
        )
        .join("")}
    </table></div>`
    : `<div class="card empty">Agrega el dominio de una tienda Shopify para empezar a rastrearla.<br>También puedes pedirle a Claude: <i>"encuentra tiendas Shopify de mascotas que estén creciendo"</i>.</div>`;
  $$("#storesTable tr[data-id]").forEach((tr) => (tr.onclick = () => openStore(tr.dataset.id)));
  $$("#storesTable [data-scan]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        busy(b, async () => {
          const r = await api(`/api/stores/${encodeURIComponent(b.dataset.scan)}/scan`, { method: "POST" });
          toast(`${r.store.name}: ${r.scan.newProducts} nuevos, ${r.scan.priceChanges} cambios de precio`);
          loaders.stores();
        });
      }),
  );
};

$("#storeFilters").addEventListener("change", () => loaders.stores());
$("#storeFilters").addEventListener("submit", (e) => {
  e.preventDefault();
  loaders.stores();
});
let storeSearchTimer;
$("#storeFilters").q.addEventListener("input", () => {
  clearTimeout(storeSearchTimer);
  storeSearchTimer = setTimeout(loaders.stores, 300);
});

$("#addStoreForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.target;
  busy($("button.primary", form), async () => {
    const r = await api("/api/stores", { method: "POST", body: { domain: form.domain.value } });
    toast(`✅ ${r.store.name} rastreada: ${r.store.productCount} productos`);
    form.reset();
    loaders.stores();
  });
});

$("#rescanAll").onclick = (e) =>
  busy(e.target, async () => {
    const r = await api("/api/stores-rescan", { method: "POST" });
    toast(`${r.scanned} tiendas re-escaneadas (las 5 más antiguas). El resto se actualiza solo cada día.`);
    loaders.stores();
  });

async function openStore(id) {
  const s = await api(`/api/stores/${encodeURIComponent(id)}`);
  const [newest, best] = await Promise.all([
    api(`/api/products?storeId=${encodeURIComponent(id)}&sort=newest&limit=12`),
    s.hasBestSellerRanking ? api(`/api/products?storeId=${encodeURIComponent(id)}&sort=bestseller&limit=12`) : null,
  ]);
  const tech = s.tech || {};
  const socials = Object.entries(tech.socials || {});
  openModal(`
    <h1>${esc(s.name)} <a href="${esc(s.origin)}" target="_blank" rel="noopener" style="font-size:14px">${esc(s.id)} ↗</a></h1>
    <p class="muted">${esc(s.description || tech.metaDescription || "")}</p>
    <div class="row" style="margin-bottom:14px">
      <button class="primary" id="mScan">↻ Re-escanear</button>
      <button class="ghost" id="mBoard">⭐ Guardar</button>
      <button class="ghost" id="mAnalyze">✨ Analizar con Claude</button>
      <button class="ghost" id="mAds">📣 Ver anuncios</button>
      <a class="button ghost" href="/api/export/products.csv?storeId=${encodeURIComponent(s.id)}">⬇ Productos CSV</a>
      <button class="ghost danger" id="mDelete">Eliminar</button>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="v">${s.productCount}</div><div class="l">Productos</div></div>
      <div class="kpi"><div class="v">${money(s.avgPrice, s.currency)}</div><div class="l">Precio medio</div></div>
      <div class="kpi"><div class="v">${s.launched7d ?? 0} / ${s.launched30d ?? 0}</div><div class="l">Lanzados 7d / 30d</div></div>
      <div class="kpi"><div class="v">${s.activityScore ?? 0}</div><div class="l">Puntuación de actividad</div></div>
      <div class="kpi"><div class="v">${s.ads ? s.ads.active : "—"}</div><div class="l">Anuncios activos (Meta${s.ads ? ", " + esc(s.ads.country) : ""})</div></div>
      <div class="kpi"><div class="v">${s.oldestProductAt ? new Date(s.oldestProductAt).getFullYear() : "—"}</div><div class="l">Primer producto</div></div>
    </div>
    <div class="grid2">
      <div class="card">
        <h3>Tecnología</h3>
        <p><b>Tema:</b> ${esc(tech.theme || "desconocido")} ${tech.themeStoreId ? '<span class="pill">tema oficial</span>' : tech.theme ? '<span class="pill">tema personalizado</span>' : ""}</p>
        <p><b>Apps:</b> ${(tech.apps || []).map((a) => `<span class="pill accent">${esc(a)}</span>`).join("") || '<span class="muted">ninguna detectada</span>'}</p>
        <p><b>Píxeles:</b> ${(tech.pixels || []).map((a) => `<span class="pill green">${esc(a)}</span>`).join("") || '<span class="muted">ninguno detectado</span>'}</p>
        <p><b>Redes:</b> ${socials.map(([k, v]) => `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(k)}</a>`).join(" · ") || '<span class="muted">—</span>'}</p>
        <p class="muted">País: ${esc(s.country || "—")} · Moneda: ${esc(s.currency || "—")} · Idioma: ${esc(tech.language || "—")}</p>
      </div>
      <div class="card">
        <h3>Productos en catálogo por escaneo</h3>
        ${bars((s.scans || []).map((x) => x.productCount))}
        <p class="muted">${(s.scans || []).length} escaneos · agregada ${ago(s.addedAt)}</p>
        <label class="muted">Nicho <input id="mNiche" value="${esc(s.niche)}" style="width:100%"></label>
        <label class="muted">Notas <textarea id="mNotes" rows="2" style="width:100%">${esc(s.notes)}</textarea></label>
        <button class="ghost" id="mSaveNotes" style="margin-top:6px">Guardar notas</button>
      </div>
    </div>
    ${s.ads?.top?.length ? `<h3>Anuncios que más tiempo llevan activos</h3><div class="ads-grid">${s.ads.top.slice(0, 6).map(adCard).join("")}</div><br>` : ""}
    ${best ? `<h3>Más vendidos</h3><div class="product-grid small" id="mBest">${best.products.map(productCard).join("")}</div><br>` : ""}
    <h3>Últimos lanzamientos</h3>
    <div class="product-grid small" id="mNewest">${newest.products.map(productCard).join("")}</div>
    <br><h3>Alertas de esta tienda</h3>
    <div class="event-list">${eventsHtml(s.events)}</div>
  `);
  bindProductCards($("#modalContent"));
  $("#mScan").onclick = (e) =>
    busy(e.target, async () => {
      await api(`/api/stores/${encodeURIComponent(id)}/scan`, { method: "POST" });
      openStore(id);
    });
  $("#mDelete").onclick = async () => {
    if (!confirm(`¿Dejar de rastrear ${s.name}?`)) return;
    await api(`/api/stores/${encodeURIComponent(id)}`, { method: "DELETE" });
    closeModal();
    loaders.stores();
  };
  $("#mSaveNotes").onclick = async () => {
    await api(`/api/stores/${encodeURIComponent(id)}`, { method: "PATCH", body: { niche: $("#mNiche").value, notes: $("#mNotes").value } });
    toast("Notas guardadas");
  };
  $("#mBoard").onclick = () => saveToBoard("store", s.id, s.name);
  $("#mAnalyze").onclick = () => goToAi("analyze", `Analiza la tienda ${s.id}: productos estrella, precios, anuncios, tecnología y oportunidades para competir.`);
  $("#mAds").onclick = () => {
    closeModal();
    location.hash = "ads";
    $("#adsForm").term.value = s.id;
    $("#adsForm").requestSubmit();
  };
}

// ---------- Productos ----------
let productOffset = 0;
async function loadProducts(append = false) {
  const form = $("#productFilters");
  if (!append) productOffset = 0;
  const params = qs(form);
  $("#exportProducts").href = `/api/export/products.csv?${params}`;
  params.set("limit", 60);
  params.set("offset", productOffset);
  const r = await api(`/api/products?${params}`);
  $("#productCount").textContent = `${r.total} productos`;
  const html = r.products.map(productCard).join("");
  if (append) $("#productGrid").insertAdjacentHTML("beforeend", html);
  else $("#productGrid").innerHTML = html || `<div class="card empty">No hay productos. Rastrea tiendas primero.</div>`;
  bindProductCards($("#productGrid"));
  productOffset += r.products.length;
  $("#moreProducts").classList.toggle("hidden", productOffset >= r.total);
}

loaders.products = async () => {
  const stores = (await api("/api/stores")).stores;
  const sel = $("#productFilters").storeId;
  const current = sel.value;
  sel.innerHTML = `<option value="">Todas las tiendas</option>` + stores.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
  sel.value = current;
  loadProducts();
};
$("#productFilters").addEventListener("submit", (e) => {
  e.preventDefault();
  loadProducts();
});
$("#productFilters").addEventListener("change", () => loadProducts());
$("#moreProducts").onclick = () => loadProducts(true);

async function openProduct(key) {
  const p = await api(`/api/products/${encodeURIComponent(key)}`);
  const history = p.priceHistory || [];
  openModal(`
    <div class="grid2">
      <div>${p.image ? `<img src="${esc(p.image)}" style="width:100%;border-radius:12px;background:#fff" alt="">` : ""}</div>
      <div>
        <h1>${esc(p.title)}</h1>
        <p><span class="price" style="font-size:22px">${money(p.price, p.currency)}</span>${p.compareAtPrice > p.price ? `<span class="compare">${money(p.compareAtPrice, p.currency)}</span> <span class="pill green">-${p.discountPct}%</span>` : ""}</p>
        <p><b>Tienda:</b> <a href="#" id="pStore">${esc(p.storeName)}</a> · ${esc(p.vendor)}</p>
        <p><b>Tipo:</b> ${esc(p.productType || "—")} · <b>Variantes:</b> ${p.variantCount}</p>
        <p>${p.bestSellerRank ? `<span class="pill accent">#${p.bestSellerRank} en más vendidos</span>` : ""}${p.available ? '<span class="pill green">En stock</span>' : '<span class="pill red">Agotado</span>'}${p.removed ? '<span class="pill red">Retirado</span>' : ""}</p>
        <p class="muted">Creado ${ago(p.createdAt)} · Detectado ${ago(p.firstSeenAt)}</p>
        <p>${(p.tags || []).slice(0, 12).map((t) => `<span class="pill">${esc(t)}</span>`).join("")}</p>
        <h3>Historial de precio</h3>
        ${history.length > 1 ? bars(history.map((h) => h.price)) + `<p class="muted">${history.map((h) => `${h.price} (${new Date(h.at).toLocaleDateString("es")})`).join(" → ")}</p>` : `<p class="muted">Sin cambios de precio detectados.</p>`}
        <div class="row">
          <a class="button primary" href="${esc(p.url)}" target="_blank" rel="noopener">Ver en tienda ↗</a>
          <button class="ghost" id="pBoard">⭐ Guardar</button>
          <button class="ghost" id="pAds">📣 Buscar anuncios</button>
          <button class="ghost" id="pAi">✨ Analizar con Claude</button>
          <a class="button ghost" target="_blank" rel="noopener" href="https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(p.title)}">AliExpress ↗</a>
          ${p.image ? `<a class="button ghost" target="_blank" rel="noopener" href="https://lens.google.com/uploadbyurl?url=${encodeURIComponent(p.image)}">Buscar imagen ↗</a>` : ""}
        </div>
      </div>
    </div>`);
  $("#pStore").onclick = (e) => {
    e.preventDefault();
    openStore(p.storeId);
  };
  $("#pBoard").onclick = () => saveToBoard("product", key, p.title);
  $("#pAds").onclick = () => {
    closeModal();
    location.hash = "ads";
    $("#adsForm").term.value = p.title;
    $("#adsForm").requestSubmit();
  };
  $("#pAi").onclick = () =>
    goToAi("analyze", `Analiza el producto "${p.title}" de ${p.storeId} (${money(p.price, p.currency)}). ¿Es un producto ganador? Competencia, anuncios, proveedores, margen estimado y ángulos de venta.`);
}

// ---------- Anuncios ----------
function adCard(a) {
  return `<div class="ad">
    <b>${esc(a.page)}</b> ${a.daysRunning != null ? `<span class="pill ${a.daysRunning >= 30 ? "green" : ""}">${a.daysRunning} días activo</span>` : ""}
    <div class="muted" style="font-size:12px">${(a.platforms || []).join(", ")}${a.reach ? ` · alcance UE ${a.reach.toLocaleString("es")}` : ""}</div>
    ${a.title ? `<div><b>${esc(a.title)}</b></div>` : ""}
    <div class="body">${esc(a.body)}</div>
    <div class="row"><a href="${esc(a.url)}" target="_blank" rel="noopener">Ver anuncio ↗</a>
    <a href="#" data-save-ad="${esc(a.id)}" data-title="${esc(a.page + ": " + (a.title || a.body).slice(0, 60))}">⭐ Guardar</a></div>
  </div>`;
}

$("#adsForm").addEventListener("submit", (e) => {
  e.preventDefault();
  busy($("button.primary", e.target), async () => {
    const r = await api(`/api/ads?${qs(e.target)}`);
    const links = `<div class="card"><h3>Abrir en bibliotecas de anuncios</h3><div class="row">${r.links
      .map((l) => `<a class="button ghost" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)} ↗</a>`)
      .join("")}</div></div>`;
    let body;
    if (!r.configured) {
      body = `<p class="muted">Para ver los anuncios aquí mismo (ordenados por días activos), guarda el secreto <code>META_ACCESS_TOKEN</code> en Cloudflare.
        Mientras tanto usa los enlaces de arriba, o pídele a Claude que los investigue.</p>`;
    } else if (r.error) {
      body = `<p class="danger">Meta API: ${esc(r.error)}</p>`;
    } else {
      body = r.ads.length ? `<p class="muted">${r.ads.length} anuncios activos</p><div class="ads-grid">${r.ads.map(adCard).join("")}</div>` : `<p class="muted">Sin anuncios para este término.</p>`;
    }
    $("#adsResult").innerHTML = links + body;
    bindAdSaves($("#adsResult"), r.ads);
  });
});

function bindAdSaves(root, ads = []) {
  $$("[data-save-ad]", root).forEach(
    (a) =>
      (a.onclick = (e) => {
        e.preventDefault();
        const ad = ads.find((x) => x.id === a.dataset.saveAd) || {};
        saveToBoard("ad", a.dataset.saveAd, a.dataset.title, ad);
      }),
  );
}
loaders.ads = () => {};

// ---------- Alertas ----------
loaders.alerts = async () => {
  const events = await api(`/api/events?limit=300&${qs($("#alertFilters"))}`);
  $("#alertsList").innerHTML = eventsHtml(events);
};
$("#alertFilters").addEventListener("change", () => loaders.alerts());

// ---------- Tableros ----------
async function saveToBoard(type, ref, title, data = {}) {
  const boards = await api("/api/boards");
  openModal(`<h1>Guardar en tablero</h1><p>${esc(title)}</p>
    <div class="boards">${boards.map((b) => `<div class="board" data-id="${esc(b.id)}"><b>${esc(b.name)}</b><div class="muted">${b.itemCount} elementos</div></div>`).join("")}</div>
    <form id="quickBoard" class="toolbar"><input name="boardName" placeholder="O crea uno nuevo…" required><button class="primary">Crear y guardar</button></form>`);
  const save = async (boardId) => {
    await api(`/api/boards/${encodeURIComponent(boardId)}/items`, { method: "POST", body: { type, ref, data: { title, ...data } } });
    closeModal();
    toast("⭐ Guardado");
  };
  $$("#modalContent .board").forEach((el) => (el.onclick = () => save(el.dataset.id)));
  $("#quickBoard").onsubmit = async (e) => {
    e.preventDefault();
    const b = await api("/api/boards", { method: "POST", body: { name: e.target.boardName.value } });
    save(b.id);
  };
}

let activeBoard = null;
loaders.boards = async () => {
  const boards = await api("/api/boards");
  $("#boardsList").innerHTML =
    boards.map((b) => `<div class="board ${b.id === activeBoard ? "active" : ""}" data-id="${esc(b.id)}"><b>${esc(b.name)}</b><div class="muted">${b.itemCount} elementos</div></div>`).join("") ||
    `<p class="muted">Crea un tablero para guardar productos, tiendas y anuncios.</p>`;
  $$("#boardsList .board").forEach(
    (el) =>
      (el.onclick = () => {
        activeBoard = el.dataset.id;
        loaders.boards();
      }),
  );
  if (activeBoard && boards.some((b) => b.id === activeBoard)) showBoard(activeBoard);
  else $("#boardDetail").innerHTML = "";
};

async function showBoard(id) {
  const b = await api(`/api/boards/${encodeURIComponent(id)}`);
  const products = b.items.filter((i) => i.type === "product" && i.current);
  const stores = b.items.filter((i) => i.type === "store");
  const ads = b.items.filter((i) => i.type === "ad");
  $("#boardDetail").innerHTML = `<div class="card">
    <div class="row" style="justify-content:space-between"><h3>${esc(b.name)}</h3><button class="ghost danger" id="delBoard">Eliminar tablero</button></div>
    ${products.length ? `<h3>Productos</h3><div class="product-grid small">${products.map((i) => productCard({ ...i.current, key: i.ref })).join("")}</div><br>` : ""}
    ${stores.length ? `<h3>Tiendas</h3>${stores.map((i) => `<div class="event"><a href="#" data-store="${esc(i.ref)}">${esc(i.data?.title || i.ref)}</a> <span class="muted">${esc(i.ref)}</span> <a href="#" class="danger" data-rm="store|${esc(i.ref)}">quitar</a></div>`).join("")}<br>` : ""}
    ${ads.length ? `<h3>Anuncios</h3>${ads.map((i) => `<div class="event"><a href="https://www.facebook.com/ads/library/?id=${esc(i.ref)}" target="_blank" rel="noopener">${esc(i.data?.title || i.ref)} ↗</a> <a href="#" class="danger" data-rm="ad|${esc(i.ref)}">quitar</a></div>`).join("")}` : ""}
    ${b.items.length ? "" : `<p class="muted">Vacío. Usa ⭐ Guardar en productos, tiendas o anuncios.</p>`}
  </div>`;
  bindProductCards($("#boardDetail"));
  $$("#boardDetail [data-store]").forEach((a) => (a.onclick = (e) => (e.preventDefault(), openStore(a.dataset.store))));
  $$("#boardDetail [data-rm]").forEach(
    (a) =>
      (a.onclick = async (e) => {
        e.preventDefault();
        const [type, ref] = a.dataset.rm.split("|");
        await api(`/api/boards/${encodeURIComponent(id)}/items`, { method: "DELETE", body: { type, ref } });
        loaders.boards();
      }),
  );
  $("#delBoard").onclick = async () => {
    if (!confirm("¿Eliminar este tablero?")) return;
    await api(`/api/boards/${encodeURIComponent(id)}`, { method: "DELETE" });
    activeBoard = null;
    loaders.boards();
  };
}

$("#newBoardForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = await api("/api/boards", { method: "POST", body: { name: e.target.boardName.value } });
  e.target.reset();
  activeBoard = b.id;
  loaders.boards();
});

// ---------- Claude IA ----------
let currentChat = null;
let streaming = false;
const PRESETS = [
  ["products", "Productos ganadores de mascotas para vender en España este mes"],
  ["stores", "Encuentra 5 tiendas Shopify de skincare que estén creciendo y rastréalas"],
  ["analyze", "Analiza las tiendas que estoy rastreando y dime cuál copiaría y por qué"],
  ["ads", "¿Qué anuncios de gadgets de cocina llevan más tiempo activos y qué ángulos usan?"],
  ["free", "Revisa mis alertas recientes y resume qué productos nuevos están lanzando mis competidores"],
];

function renderMarkdown(text) {
  const html = window.marked ? marked.parse(text) : esc(text).replace(/\n/g, "<br>");
  return window.DOMPurify ? DOMPurify.sanitize(html, { ADD_ATTR: ["target"] }) : esc(text);
}

function sourcesHtml(sources) {
  const uniq = [...new Map(sources.filter((s) => s.url).map((s) => [s.url, s])).values()].slice(0, 12);
  return uniq.length ? `<div class="sources">🔗 ${uniq.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.title)}">${esc(s.title || s.url)}</a>`).join("")}</div>` : "";
}

function renderChat(items) {
  const log = $("#chatLog");
  if (!items.length) {
    log.innerHTML = `<div class="empty"><h2>✨ Investiga con Claude</h2><p>Claude busca en internet y usa tus datos de TrendTrack (tiendas, productos, anuncios y alertas) a través del servidor MCP de la app.</p></div>`;
    return;
  }
  log.innerHTML = items
    .map((m) =>
      m.role === "user"
        ? `<div class="msg user"><div class="bubble">${esc(m.text)}</div></div>`
        : `<div class="msg"><div class="bubble">${renderMarkdown(m.text)}${sourcesHtml(m.sources || [])}</div></div>`,
    )
    .join("");
  log.scrollTop = log.scrollHeight;
}

async function loadChatList() {
  const list = await api("/api/conversations");
  $("#chatList").innerHTML = list
    .map((c) => `<div class="chat-item ${c.id === currentChat ? "active" : ""}" data-id="${esc(c.id)}"><span title="${esc(c.title)}">${esc(c.title)}</span><a href="#" data-del="${esc(c.id)}" class="muted">✕</a></div>`)
    .join("");
  $$("#chatList .chat-item").forEach((el) => (el.onclick = () => openChat(el.dataset.id)));
  $$("#chatList [data-del]").forEach(
    (a) =>
      (a.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await api(`/api/conversations/${a.dataset.del}`, { method: "DELETE" });
        if (currentChat === a.dataset.del) newChat();
        loadChatList();
      }),
  );
}

async function openChat(id) {
  if (streaming) return;
  currentChat = id;
  const c = await api(`/api/conversations/${id}`);
  renderChat(c.items);
  loadChatList();
}

function newChat() {
  if (streaming) return;
  currentChat = null;
  renderChat([]);
  $$("#chatList .chat-item").forEach((el) => el.classList.remove("active"));
}
$("#newChat").onclick = newChat;

$("#presets").innerHTML = PRESETS.map(([mode, text], i) => `<button class="ghost" data-i="${i}">${esc(text)}</button>`).join("");
$$("#presets button").forEach(
  (b) =>
    (b.onclick = () => {
      const [mode, text] = PRESETS[b.dataset.i];
      $("#chatForm").mode.value = mode;
      $("#chatForm").prompt.value = text;
    }),
);

const TOOL_LABELS = {
  web_search: (i) => `🔎 Buscando en la web: “${i?.query || "…"}”`,
  web_fetch: (i) => `🌐 Leyendo ${i?.url || "una página"}`,
  track_store: (i) => `🏬 Rastreando la tienda ${i?.domain || ""}`,
  search_products: (i) => `🛍️ Buscando en tus productos${i?.query ? `: “${i.query}”` : ""}`,
  search_stores: () => "🏬 Revisando tus tiendas",
  get_store: (i) => `📋 Abriendo ficha de ${i?.store || "la tienda"}`,
  get_product: () => "📦 Revisando un producto",
  search_ads: (i) => `📣 Buscando anuncios de “${i?.term || ""}”`,
  recent_alerts: () => "🔔 Revisando alertas",
  dashboard: () => "📊 Revisando el dashboard",
  save_to_board: (i) => `⭐ Guardando en “${i?.board || "tablero"}”`,
  list_boards: () => "⭐ Revisando tableros",
  set_store_notes: () => "📝 Anotando tienda",
};

$("#chatForm").prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#chatForm").requestSubmit();
  }
});

$("#chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (streaming) return;
  const form = e.target;
  const prompt = form.prompt.value.trim();
  if (!prompt) return;
  streaming = true;
  $("#sendBtn").disabled = true;
  form.prompt.value = "";

  const log = $("#chatLog");
  if ($(".empty", log)) log.innerHTML = "";
  log.insertAdjacentHTML("beforeend", `<div class="msg user"><div class="bubble">${esc(prompt)}</div></div>`);
  log.insertAdjacentHTML("beforeend", `<div class="msg"><div class="bubble"><div class="activity">⏳ Pensando…</div><div class="thinking hidden"></div><div class="answer"></div><div class="src"></div></div></div>`);
  const bubble = log.lastElementChild.querySelector(".bubble");
  const activity = $(".activity", bubble);
  const thinking = $(".thinking", bubble);
  const answer = $(".answer", bubble);
  let text = "";
  const sources = [];

  try {
    const res = await fetch("/api/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, mode: form.mode.value, conversationId: currentChat }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop();
      for (const part of parts) {
        if (!part.startsWith("data: ")) continue;
        const ev = JSON.parse(part.slice(6));
        if (ev.type === "conversation") currentChat = ev.id;
        else if (ev.type === "thinking") {
          thinking.classList.remove("hidden");
          thinking.textContent += ev.text;
          thinking.scrollTop = thinking.scrollHeight;
        } else if (ev.type === "tool") {
          activity.textContent = (TOOL_LABELS[ev.name] || (() => `🔧 ${ev.name}`))(ev.input);
        } else if (ev.type === "sources") {
          sources.push(...ev.sources);
          $(".src", bubble).innerHTML = sourcesHtml(sources);
        } else if (ev.type === "text") {
          text += ev.text;
          activity.textContent = "✍️ Escribiendo…";
          answer.innerHTML = renderMarkdown(text);
        } else if (ev.type === "usage") {
          updateUsage(ev.total);
        } else if (ev.type === "error") {
          answer.insertAdjacentHTML("beforeend", `<p class="danger">⚠️ ${esc(ev.message)}</p>`);
        }
        log.scrollTop = log.scrollHeight;
      }
    }
  } catch (err) {
    answer.insertAdjacentHTML("beforeend", `<p class="danger">⚠️ ${esc(err.message)}</p>`);
  } finally {
    activity.remove();
    thinking.classList.add("hidden");
    streaming = false;
    $("#sendBtn").disabled = false;
    loadChatList();
  }
});

loaders.ai = async () => {
  await loadChatList();
  if (!currentChat && !streaming) renderChat([]);
  const s = await api("/api/settings");
  if (!s.hasApiKey) toast("Falta el secreto ANTHROPIC_API_KEY en Cloudflare para usar Claude dentro de la app (o conéctate por MCP).", true);
};

// ---------- Ajustes ----------
function updateUsage(u) {
  if (!u) return;
  $("#usageMini").innerHTML = `IA: ${money(u.costUsd, "USD")} estimado<br>${u.requests} llamadas · ${u.webSearches} búsquedas`;
}

function codeBlock(text) {
  return `<pre class="code"><button class="ghost copy" type="button">Copiar</button><code>${esc(text)}</code></pre>`;
}

loaders.settings = async () => {
  const s = await api("/api/settings");
  const f = $("#settingsForm");
  f.model.innerHTML = s.models.map((m) => `<option value="${m.id}">${esc(m.label)} — $${m.input}/$${m.output} por millón de tokens</option>`).join("");
  f.model.value = s.model;
  f.effort.value = s.effort;
  $("#keyStatus").innerHTML = s.hasApiKey
    ? "✅ API key configurada como secreto de Cloudflare."
    : "⚠️ Falta la API key. Guárdala como secreto: <code>npx wrangler secret put ANTHROPIC_API_KEY</code>";
  const u = s.usage;
  $("#usageDetail").innerHTML = `<p>${u.requests} llamadas · ${u.inputTokens.toLocaleString("es")} tokens de entrada · ${u.cacheReadTokens.toLocaleString("es")} desde caché · ${u.outputTokens.toLocaleString("es")} de salida · ${u.webSearches} búsquedas web</p>
    <p><b>Coste estimado: ${money(u.costUsd, "USD")}</b> <span class="muted">(el valor exacto lo ves en la consola de Anthropic)</span></p>`;
  $("#metaStatus").innerHTML = s.metaConfigured
    ? "✅ Configurado: los anuncios se muestran dentro de la app y se cuentan los anuncios activos de cada tienda."
    : 'No configurado. Guarda el secreto <code>META_ACCESS_TOKEN</code> en Cloudflare (crea el token en <a href="https://www.facebook.com/ads/library/api" target="_blank" rel="noopener">facebook.com/ads/library/api</a>). Sin él, la app abre la Ad Library en el navegador.';

  const url = s.mcp.url;
  $("#mcpInfo").innerHTML = s.mcp.configured
    ? `
    <p>URL del servidor MCP (reemplaza <code>TU_MCP_TOKEN</code> por el secreto que guardaste):</p>
    ${codeBlock(`${url}?token=TU_MCP_TOKEN`)}
    <h3>claude.ai y Claude Desktop</h3>
    <p class="muted">Ajustes → Conectores → Añadir conector personalizado → pega la URL de arriba. Queda disponible en claude.ai, Claude Desktop y la app móvil de Claude.</p>
    <h3>Claude Code</h3>
    ${codeBlock(`claude mcp add --transport http trendtrack ${url} --header "Authorization: Bearer TU_MCP_TOKEN"`)}
    <p class="muted">Herramientas: dashboard, search_stores, get_store, track_store, set_store_notes, search_products, get_product, search_ads, recent_alerts, list_boards, save_to_board. Prompts: productos_ganadores, analizar_tienda.</p>`
    : `<p>⚠️ El servidor MCP está desactivado. Guarda el secreto: <code>npx wrangler secret put MCP_TOKEN</code></p>`;
  $$("#mcpInfo .copy").forEach(
    (b) =>
      (b.onclick = async () => {
        await navigator.clipboard.writeText(b.nextElementSibling.textContent);
        toast("Copiado");
      }),
  );
  updateUsage(u);
};

$("#settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  await api("/api/settings", { method: "POST", body: { model: f.model.value, effort: f.effort.value } });
  toast("Ajustes guardados");
  loaders.settings();
});
$("#testKey").onclick = (e) =>
  busy(e.target, async () => {
    const r = await api("/api/settings/test", { method: "POST" });
    toast(`✅ Conectado con ${r.name || r.model}`);
  });
$("#resetUsage").onclick = async () => {
  await api("/api/settings/reset-usage", { method: "POST" });
  loaders.settings();
};

// ---------- Inicio ----------
show(location.hash.slice(1) || "dashboard");
api("/api/settings").then((s) => updateUsage(s.usage)).catch(() => {});
