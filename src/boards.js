// Tableros de favoritos: guarda productos, tiendas y anuncios para revisarlos después.
import { all, first, run, stmt, batch, now, parse } from "./db.js";
import { getProduct, getStore } from "./shopify.js";

export async function listBoards() {
  const rows = await all(
    `SELECT b.id, b.name, b.created_at, COUNT(i.ref) AS items FROM boards b
     LEFT JOIN board_items i ON i.board_id = b.id GROUP BY b.id ORDER BY b.created_at DESC`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, itemCount: r.items }));
}

export async function createBoard(name) {
  const board = { id: crypto.randomUUID(), name: String(name || "Favoritos").slice(0, 80), createdAt: now() };
  await run("INSERT INTO boards (id, name, created_at) VALUES (?, ?, ?)", board.id, board.name, board.createdAt);
  return board;
}

async function findOrCreate(boardIdOrName) {
  const row = await first(
    "SELECT id, name FROM boards WHERE id = ? OR lower(name) = lower(?) LIMIT 1",
    String(boardIdOrName || ""),
    String(boardIdOrName || ""),
  );
  return row || createBoard(boardIdOrName || "Favoritos");
}

// type: "product" | "store" | "ad"; ref: clave del producto, id de tienda o id de anuncio.
export async function addToBoard(boardIdOrName, { type, ref, data = {}, note = "" }) {
  if (!["product", "store", "ad"].includes(type)) throw new Error("type debe ser product, store o ad");
  if (!ref) throw new Error("Falta ref");
  const board = await findOrCreate(boardIdOrName);
  await run(
    "INSERT OR IGNORE INTO board_items (board_id, type, ref, data, note, added_at) VALUES (?, ?, ?, ?, ?, ?)",
    board.id,
    type,
    String(ref),
    JSON.stringify(data || {}),
    String(note).slice(0, 1000),
    now(),
  );
  const { n } = await first("SELECT COUNT(*) AS n FROM board_items WHERE board_id = ?", board.id);
  return { id: board.id, name: board.name, itemCount: n };
}

export async function removeFromBoard(boardId, type, ref) {
  await run("DELETE FROM board_items WHERE board_id = ? AND type = ? AND ref = ?", boardId, type, ref);
}

export async function deleteBoard(boardId) {
  await batch([stmt("DELETE FROM board_items WHERE board_id = ?", boardId), stmt("DELETE FROM boards WHERE id = ?", boardId)]);
}

// Devuelve el tablero con los datos actuales de cada elemento.
export async function getBoard(boardId) {
  const board = await first("SELECT * FROM boards WHERE id = ?", boardId);
  if (!board) return null;
  const items = await all("SELECT * FROM board_items WHERE board_id = ? ORDER BY added_at DESC", boardId);
  return {
    id: board.id,
    name: board.name,
    createdAt: board.created_at,
    items: await Promise.all(
      items.map(async (i) => ({
        type: i.type,
        ref: i.ref,
        note: i.note,
        addedAt: i.added_at,
        data: parse(i.data, {}),
        current: i.type === "product" ? await getProduct(i.ref) : i.type === "store" ? await getStore(i.ref) : null,
      })),
    ),
  };
}
