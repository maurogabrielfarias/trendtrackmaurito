-- Esquema de TrendTrack Maurito en Cloudflare D1.
CREATE TABLE stores (
  id TEXT PRIMARY KEY,             -- dominio sin www, ej: tienda.com
  data TEXT NOT NULL,              -- ficha completa en JSON
  added_at TEXT NOT NULL,
  last_scan_at TEXT
);

CREATE TABLE products (
  key TEXT PRIMARY KEY,            -- "<tienda>:<id de producto>"
  store_id TEXT NOT NULL,
  title TEXT NOT NULL,
  search TEXT NOT NULL,            -- texto en minúsculas para buscar (título, proveedor, tipo, etiquetas)
  vendor TEXT,
  product_type TEXT,
  price REAL,
  compare_at_price REAL,
  discount INTEGER NOT NULL DEFAULT 0,
  best_rank INTEGER,
  created_at TEXT,
  first_seen_at TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0,
  sig TEXT NOT NULL,               -- huella para escribir solo lo que cambia
  data TEXT NOT NULL               -- producto completo en JSON (con historial de precios)
);
CREATE INDEX products_store ON products(store_id, removed);
CREATE INDEX products_created ON products(created_at);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  store_id TEXT,
  data TEXT NOT NULL
);
CREATE INDEX events_at ON events(at);
CREATE INDEX events_store ON events(store_id);

CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE board_items (
  board_id TEXT NOT NULL,
  type TEXT NOT NULL,              -- product | store | ad
  ref TEXT NOT NULL,
  data TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  added_at TEXT NOT NULL,
  PRIMARY KEY (board_id, type, ref)
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mode TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Un mensaje por fila (D1 limita el tamaño de cada fila).
CREATE TABLE messages (
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (conversation_id, seq)
);

CREATE TABLE kv (
  key TEXT PRIMARY KEY,            -- settings, usage
  value TEXT NOT NULL
);
