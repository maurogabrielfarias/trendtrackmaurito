// Acceso a Cloudflare D1. El Worker llama a bindEnv(env) al recibir cada petición.
export let ENV = {};
export function bindEnv(env) {
  ENV = env;
}

const d1 = () => {
  if (!ENV.DB) throw new Error("Falta la base de datos D1 (binding DB) en wrangler.jsonc");
  return ENV.DB;
};

export async function all(sql, ...params) {
  const { results } = await d1().prepare(sql).bind(...params).all();
  return results;
}

export async function first(sql, ...params) {
  return d1().prepare(sql).bind(...params).first();
}

export async function run(sql, ...params) {
  return d1().prepare(sql).bind(...params).run();
}

export const stmt = (sql, ...params) => d1().prepare(sql).bind(...params);

// Ejecuta muchas sentencias en lotes (más rápido y atómico por lote).
export async function batch(statements, size = 80) {
  for (let i = 0; i < statements.length; i += size) {
    await d1().batch(statements.slice(i, i + size));
  }
}

export const now = () => new Date().toISOString();
export const parse = (s, fallback = null) => {
  try {
    return s == null ? fallback : JSON.parse(s);
  } catch {
    return fallback;
  }
};

// Pequeño almacén clave-valor (ajustes, consumo de la API).
export async function getKv(key, fallback) {
  const row = await first("SELECT value FROM kv WHERE key = ?", key);
  return row ? { ...fallback, ...parse(row.value, {}) } : fallback;
}

export async function setKv(key, value) {
  await run(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    JSON.stringify(value),
  );
}

export function eventStmt(event) {
  const { type, storeId = null, ...data } = event;
  return stmt("INSERT INTO events (at, type, store_id, data) VALUES (?, ?, ?, ?)", now(), type, storeId, JSON.stringify(data));
}
