import type { SQLInputValue } from "node:sqlite";
import type { ActionRecord, Store } from "@passport/types";
import { StoreError } from "./errors.js";
import type { StoreDatabase } from "./store-database.js";
import { decodeCursor, definedPatch, limitOf, nextCursor } from "./store-query.js";

export function createActionsRepositories(db: StoreDatabase) {
  function actionScalars(record: ActionRecord): Record<string, SQLInputValue> {
    return {
      status: record.status,
      category: record.request.category,
      actor_kind: record.request.actor.kind,
      run_id: record.request.runId ?? null,
      matter_id: record.request.matterId ?? null,
      created_at: record.createdAt,
      hold_until: record.holdUntil ?? null,
    };
  }
  const actions: Store["actions"] = {
    get: async (id) => db.get("actions", id),
    query: async (q) => {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (q.status !== undefined) {
        where.push(`status IN (${q.status.map(() => "?").join(",")})`);
        params.push(...q.status);
      }
      for (const [column, value] of [
        ["category", q.category],
        ["actor_kind", q.actorKind],
        ["run_id", q.runId],
        ["matter_id", q.matterId],
      ] as const) {
        if (value !== undefined) {
          where.push(`${column} = ?`);
          params.push(value);
        }
      }
      if (q.after !== undefined) {
        where.push("created_at > ?");
        params.push(q.after);
      }
      if (q.before !== undefined) {
        where.push("created_at < ?");
        params.push(q.before);
      }
      const clause = () => (where.length ? `WHERE ${where.join(" AND ")}` : "");
      const total = Number(
        db.one(`SELECT COUNT(*) AS count FROM actions ${clause()}`, params)!.count,
      );
      if (q.cursor) {
        const cursor = decodeCursor(q.cursor, "createdAt_desc");
        where.push("(created_at, id) < (?, ?)");
        params.push(cursor.at, cursor.id);
      }
      const limit = limitOf(q.limit);
      const rows = db.rows<ActionRecord>(
        `SELECT data FROM actions ${clause()} ORDER BY created_at DESC, id DESC LIMIT ?`,
        [...params, limit + 1],
      );
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        total,
        nextCursor:
          rows.length > limit && last
            ? nextCursor("createdAt_desc", last.createdAt, last.id)
            : null,
      };
    },
    insert: async (record) => {
      const scalars = actionScalars(record);
      const columns = ["id", "data", ...Object.keys(scalars)];
      db.run(
        `INSERT INTO actions(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        [record.id, JSON.stringify(record), ...Object.values(scalars)],
      );
      return db.get<ActionRecord>("actions", record.id)!;
    },
    update: async (id, patch) =>
      db.transaction(() => {
        const record = db.get<ActionRecord>("actions", id);
        if (!record) {
          throw new StoreError("NOT_FOUND", "Action does not exist");
        }
        if (patch.id !== undefined && patch.id !== id) {
          throw new StoreError("INVALID_PATCH", "An action's id cannot change");
        }
        const updated = { ...record, ...definedPatch(patch), id };
        db.put("actions", id, updated, actionScalars(updated));
        return db.get<ActionRecord>("actions", id)!;
      }),
    dueHeld: async (now) =>
      db.rows(
        "SELECT data FROM actions WHERE status = 'held' AND hold_until <= ? ORDER BY hold_until, id",
        [now],
      ),
    claim: async (id, from, to, now) => {
      const row = db.one(
        `UPDATE actions SET status = ?, data = json_set(data, '$.status', ?, '$.decidedAt', ?)
        WHERE id = ? AND status = ? RETURNING data`,
        [to, to, now, id, from],
      );
      return row ? db.parse<ActionRecord>(row) : null;
    },
  };
  const trust: Store["trust"] = {
    list: async () => db.rows("SELECT data FROM trust ORDER BY id"),
    get: async (category) => db.get("trust", category),
    upsert: async (state) => {
      db.put("trust", state.category, state);
      return db.get("trust", state.category)!;
    },
    getConfig: async () => db.get("policy_config", "global"),
    setConfig: async (config) => db.put("policy_config", "global", config),
  };
  const kv: Store["kv"] = {
    get: async (key) =>
      (db.one("SELECT value FROM kv WHERE key = ?", [key])?.value as string | undefined) ?? null,
    set: async (key, value) =>
      db.run(
        "INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [key, value],
      ),
    delete: async (key) => db.run("DELETE FROM kv WHERE key = ?", [key]),
  };
  return { actions, trust, kv };
}
