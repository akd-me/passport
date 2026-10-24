import { createHash, randomBytes } from "node:crypto";
import type { EncryptedKv, SecretRequest, StoreSecrets, TaskItem } from "@passport/types";
import { decryptCredentials, encryptCredentials } from "./credentials.js";
import { StoreError } from "./errors.js";
import { newId } from "./ids.js";
import type { StoreDatabase } from "./store-database.js";

/** Separate AAD-bound namespace: database copies reveal no plaintext secrets. */
export function createEncryptedKv(db: StoreDatabase): EncryptedKv {
  const keyFor = (key: string) => "encrypted:" + key;
  const read = (key: string): string | null => {
    const row = db.one("SELECT value FROM kv WHERE key = ?", [keyFor(key)]);
    if (!row) {
      return null;
    }
    return decryptCredentials(db.key, keyFor(key), Buffer.from(row.value as string, "base64"))
      .value as string;
  };
  return {
    get: async (key) => read(key),
    set: async (key, value) => {
      const blob = encryptCredentials(db.key, keyFor(key), { value }).toString("base64");
      db.run("INSERT OR REPLACE INTO kv(key, value) VALUES (?, ?)", [keyFor(key), blob]);
    },
    delete: async (key) => db.run("DELETE FROM kv WHERE key = ?", [keyFor(key)]),
    take: async (key) =>
      db.transaction(() => {
        const value = read(key);
        db.run("DELETE FROM kv WHERE key = ?", [keyFor(key)]);
        return value;
      }),
  };
}

export function createSecretsRepository(db: StoreDatabase): StoreSecrets {
  const read = (id: string): SecretRequest | null => {
    const row = db.one("SELECT value FROM kv WHERE key = ?", ["secret-request:" + id]);
    return row ? (JSON.parse(row.value as string) as SecretRequest) : null;
  };
  const write = (request: SecretRequest) => {
    db.run("INSERT OR REPLACE INTO kv(key, value) VALUES (?, ?)", [
      "secret-request:" + request.id,
      JSON.stringify(request),
    ]);
  };
  // Synchronous internal write so saving a value and resolving its request share a transaction.
  const put = (value: string) => {
    const ref = "secret:" + randomBytes(32).toString("hex");
    const key = "encrypted:" + ref;
    const blob = encryptCredentials(db.key, key, { value }).toString("base64");
    db.run("INSERT INTO kv(key, value) VALUES (?, ?)", [key, blob]);
    return ref;
  };
  const encrypted = createEncryptedKv(db);
  return {
    put: async (value) => put(value),
    take: (ref) => encrypted.take(ref),
    requests: {
      create: async (input) =>
        db.transaction(() => {
          const id = createHash("sha256")
            .update(JSON.stringify([input.taskId, input.clientRequestId]))
            .digest("hex");
          const existing = read(id);
          if (existing) {
            return { request: existing };
          }
          if (!db.get("tasks", input.taskId)) {
            throw new StoreError("NOT_FOUND", "Task does not exist");
          }
          const request: SecretRequest = {
            id,
            taskId: input.taskId,
            clientRequestId: input.clientRequestId,
            text: input.text,
            status: "pending",
            createdAt: input.createdAt,
            expiresAt: input.expiresAt,
          };
          write(request);
          const row = db.one(
            "SELECT COALESCE(MAX(seq), 0) AS seq FROM task_items WHERE task_id = ?",
            [input.taskId],
          );
          const item: TaskItem = {
            id: newId(),
            taskId: input.taskId,
            runId: input.runId ?? null,
            seq: Number(row?.seq ?? 0) + 1,
            kind: "secret_request",
            at: input.createdAt,
            payload: { requestId: id, text: input.text, expiresAt: input.expiresAt },
          };
          db.run("INSERT INTO task_items(id, data, task_id, seq, kind) VALUES (?, ?, ?, ?, ?)", [
            item.id,
            JSON.stringify(item),
            item.taskId,
            item.seq,
            item.kind,
          ]);
          return { request, item };
        }),
      get: async (id, taskId, now) =>
        db.transaction(() => {
          const request = read(id);
          if (!request || request.taskId !== taskId) {
            return null;
          }
          if (request.status === "pending" && request.expiresAt <= now) {
            request.status = "timed_out";
            write(request);
          }
          return request;
        }),
      respond: async (id, taskId, response, now) =>
        db.transaction(() => {
          const request = read(id);
          if (!request || request.taskId !== taskId) {
            return null;
          }
          if (request.status !== "pending") {
            return request;
          }
          if (request.expiresAt <= now) {
            request.status = "timed_out";
          } else if ("value" in response) {
            request.secretRef = put(response.value);
            request.status = "saved";
          } else {
            request.status = response.status;
          }
          write(request);
          return request;
        }),
    },
  };
}
