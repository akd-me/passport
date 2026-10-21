import type { DatabaseSync } from "node:sqlite";
import type { Store } from "@passport/types";

// Server-local adapter until Store exposes a synchronous KV transaction API.
// SQLiteStore uses a TypeScript-private (not #private) db. No await may enter
// this transaction: node:sqlite executes the read/check/write synchronously.
function database(store: Store): DatabaseSync {
  const db = (store as unknown as { db?: DatabaseSync }).db;
  if (!db) {
    throw new Error("Atomic arrival claims require a SQLite store");
  }
  return db;
}
export function mutateKv(
  store: Store,
  key: string,
  update: (current: string | null) => string | null,
): void {
  const db = database(store);
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare("SELECT value FROM kv WHERE key = ?").get(key)?.value as
      | string
      | undefined;
    const next = update(current ?? null);
    if (next === null) {
      db.prepare("DELETE FROM kv WHERE key = ?").run(key);
    } else {
      db.prepare(
        "INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(key, next);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function compareAndSetKv(
  store: Store,
  key: string,
  expected: string | null,
  next: string | null,
): boolean {
  let changed = false;
  mutateKv(store, key, (current) => {
    if (current !== expected) {
      return current;
    }
    changed = true;
    return next;
  });
  return changed;
}
