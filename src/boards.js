// Tableros de favoritos: guarda productos, tiendas y anuncios para revisarlos después.
import crypto from "node:crypto";
import { db, save } from "./db.js";

export function listBoards() {
  return Object.values(db().boards).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function createBoard(name) {
  const board = { id: crypto.randomUUID(), name: String(name || "Favoritos").slice(0, 80), createdAt: new Date().toISOString(), items: [] };
  db().boards[board.id] = board;
  save();
  return board;
}

function findOrCreate(boardIdOrName) {
  const boards = db().boards;
  if (boards[boardIdOrName]) return boards[boardIdOrName];
  const byName = Object.values(boards).find((b) => b.name.toLowerCase() === String(boardIdOrName || "").toLowerCase());
  return byName || createBoard(boardIdOrName || "Favoritos");
}

// type: "product" | "store" | "ad"; ref: clave del producto, id de tienda o id de anuncio.
export function addToBoard(boardIdOrName, { type, ref, data = {}, note = "" }) {
  if (!["product", "store", "ad"].includes(type)) throw new Error("type debe ser product, store o ad");
  const board = findOrCreate(boardIdOrName);
  if (!board.items.some((i) => i.type === type && i.ref === ref)) {
    board.items.unshift({ type, ref: String(ref), data, note: String(note).slice(0, 1000), addedAt: new Date().toISOString() });
    save();
  }
  return board;
}

export function removeFromBoard(boardId, type, ref) {
  const board = db().boards[boardId];
  if (!board) throw new Error("Tablero no encontrado");
  board.items = board.items.filter((i) => !(i.type === type && i.ref === ref));
  save();
  return board;
}

export function deleteBoard(boardId) {
  delete db().boards[boardId];
  save();
}

// Devuelve el tablero con los datos actuales de cada elemento.
export function getBoard(boardId) {
  const board = db().boards[boardId];
  if (!board) return null;
  const { products, stores } = db();
  return {
    ...board,
    items: board.items.map((i) => ({
      ...i,
      current: i.type === "product" ? products[i.ref] || null : i.type === "store" ? stores[i.ref] || null : null,
    })),
  };
}
