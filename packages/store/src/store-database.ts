import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { nowIso } from "@passport/types";
import { StoreError } from "./errors.js";
import { migrations } from "./migrations.js";
import { type Row, unique } from "./store-query.js";

export class StoreDatabase {
  readonly statements = new Map<string, StatementSync>();
  closed = false;
  constructor(
    readonly db: DatabaseSync,
    readonly key: Buffer,
  ) {}
  statement(sql: string): StatementSync {
    if (this.closed) {
      throw new StoreError("STORE_CLOSED", "The store is closed");
    }
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  all(sql: string, params: SQLInputValue[] = []): Row[] {
    return this.statement(sql).all(...params);
  }
  one(sql: string, params: SQLInputValue[] = []): Row | undefined {
    return this.statement(sql).get(...params);
  }
  run(sql: string, params: SQLInputValue[] = []): void {
    this.statement(sql).run(...params);
  }
  transaction<T>(write: () => T): T {
    this.run("BEGIN IMMEDIATE");
    try {
      const result = write();
      this.run("COMMIT");
      return result;
    } catch (error) {
      // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

      this.run("ROLLBACK");
      throw error;
    }
  }
  parse<T>(row: Row): T {
    return JSON.parse(row.data as string) as T;
  }
  get<T>(table: string, id: string): T | null {
    const row = this.one(`SELECT data FROM ${table} WHERE id = ?`, [id]);
    return row ? this.parse<T>(row) : null;
  }
  rows<T>(sql: string, params: SQLInputValue[] = []): T[] {
    return this.all(sql, params).map((row) => this.parse<T>(row));
  }
  put(table: string, id: string, data: unknown, scalars: Record<string, SQLInputValue> = {}): void {
    const columns = ["id", "data", ...Object.keys(scalars)];
    this.run(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})
      ON CONFLICT(id) DO UPDATE SET ${columns
        .slice(1)
        .map((c) => `${c}=excluded.${c}`)
        .join(",")}`,
      [id, JSON.stringify(data), ...Object.values(scalars)],
    );
  }
  async migrate(): Promise<void> {
    this.transaction(() => {
      this.run(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      const rows = this.all("SELECT version FROM schema_version ORDER BY version");
      if (rows.some((row, i) => Number(row.version) !== i + 1) || rows.length > migrations.length) {
        throw new StoreError(
          "SCHEMA_VERSION",
          "Database migrations do not match this version of @passport/store",
        );
      }
      for (let i = rows.length; i < migrations.length; i += 1) {
        this.db.exec(migrations[i]!);
        this.run("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)", [
          i + 1,
          nowIso(),
        ]);
      }
    });
  }
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.db.close();
    this.closed = true;
    this.statements.clear();
    this.key.fill(0);
  }
  ids(table: string, ownerColumn: string, owner: string, targetColumn: string): string[] {
    return this.all(
      `SELECT ${targetColumn} AS id FROM ${table} WHERE ${ownerColumn} = ? ORDER BY position, ${targetColumn}`,
      [owner],
    ).map((row) => row.id as string);
  }
  replaceIds(
    table: string,
    ownerColumn: string,
    owner: string,
    targetColumn: string,
    ids: string[],
  ): void {
    this.run(`DELETE FROM ${table} WHERE ${ownerColumn} = ?`, [owner]);
    unique(ids).forEach((id, position) =>
      this.run(`INSERT INTO ${table}(${ownerColumn}, ${targetColumn}, position) VALUES (?, ?, ?)`, [
        owner,
        id,
        position,
      ]),
    );
  }
  setMatterLink(kind: "emails" | "events", id: string, matterId: string | null): void {
    const column = kind === "emails" ? "email_id" : "event_id";
    const current = this.one(`SELECT matter_id FROM matter_${kind} WHERE ${column} = ?`, [id]);
    if ((current?.matter_id ?? null) !== matterId) {
      this.run(`DELETE FROM matter_${kind} WHERE ${column} = ?`, [id]);
      if (matterId !== null) {
        this.run(
          `INSERT INTO matter_${kind}(matter_id, ${column}, position)
          SELECT ?, ?, COALESCE(MAX(position), -1) + 1 FROM matter_${kind} WHERE matter_id = ?`,
          [matterId, id, matterId],
        );
      }
    }
    this.run(`UPDATE ${kind} SET matter_id = ? WHERE id = ? AND matter_id IS NOT ?`, [
      matterId,
      id,
      matterId,
    ]);
  }
  deleteEvent(id: string): void {
    this.run("DELETE FROM matter_events WHERE event_id = ?", [id]);
    this.run("DELETE FROM events WHERE id = ?", [id]);
  }
}
