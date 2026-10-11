// Almacenamiento simple en un archivo JSON (sin base de datos externa).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Ruta absoluta: el servidor MCP puede arrancar desde cualquier carpeta.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

const EMPTY = () => ({
  stores: {},
  products: {},
  conversations: {},
  events: [],
  boards: {},
  settings: {},
  usage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, webSearches: 0, costUsd: 0 },
});

let state = load();
let saveTimer = null;
let loadedMtime = mtime();

function mtime() {
  try {
    return fs.statSync(DB_FILE).mtimeMs;
  } catch {
    return 0;
  }
}

function load() {
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    return { ...EMPTY(), ...JSON.parse(raw) };
  } catch {
    return EMPTY();
  }
}

// Si otro proceso (p. ej. el servidor MCP por stdio) escribió el archivo, se recarga.
export function db() {
  if (!saveTimer) {
    const m = mtime();
    if (m !== loadedMtime) {
      state = load();
      loadedMtime = m;
    }
  }
  return state;
}

// Escritura atómica, agrupando cambios cercanos en el tiempo.
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 100);
}

// Guarda solo si hay cambios pendientes (evita pisar lo que escribió otro proceso).
export function flushPending() {
  if (saveTimer) flush();
}

export function flush() {
  clearTimeout(saveTimer);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, DB_FILE);
  saveTimer = null;
  loadedMtime = mtime();
}

// Registro de eventos para las alertas (nuevos productos, cambios de precio, etc.).
export function addEvent(event) {
  state.events.unshift({ at: new Date().toISOString(), ...event });
  if (state.events.length > 2000) state.events.length = 2000;
}

export function reset() {
  state = EMPTY();
  flush();
}
