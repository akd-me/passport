import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@passport/types";
import { describe, expect, it } from "vitest";
import { openStore } from "./store.js";

const now = "2026-10-24T12:00:00.000Z";
const task: Task = {
  id: "task-secret",
  title: "Connect mail",
  kind: "task",
  accountIds: [],
  createdBy: "user",
  permissionMode: "supervised",
  interactionMode: "default",
  status: "inbox",
  pinned: false,
  needsUser: null,
  watches: [],
  createdAt: now,
  lastActivityAt: now,
};

describe("encrypted secrets", () => {
  it("persists encrypted values, binds ciphertext to its key, and consumes references once across restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "passport-secret-"));
    const path = join(dir, "store.db");
    let store = openStore({ path, masterKey: "test-master-key" });
    try {
      await store.migrate();
      await store.tasks!.insert(task);
      const requestInput = {
        taskId: task.id,
        clientRequestId: "persisted-request",
        text: "Signing secret",
        createdAt: now,
        expiresAt: "2026-10-24T12:05:00.000Z",
      };
      const originalRequest = await store.secrets!.requests.create(requestInput);
      const secret = "very private password 🗝";
      const ref = await store.secrets!.put(secret);
      await store.encryptedKv!.set("signer", secret);
      expect(await store.secrets!.take("signer")).toBeNull();
      await store.close();
      expect((await readFile(path)).includes(Buffer.from(secret))).toBe(false);
      store = openStore({ path, masterKey: "test-master-key" });
      await store.migrate();
      const retriedRequest = await store.secrets!.requests.create(requestInput);
      expect(retriedRequest.request.id).toBe(originalRequest.request.id);
      expect(retriedRequest.item).toBeUndefined();
      expect(await store.tasks!.items.list({ taskId: task.id })).toHaveLength(1);
      expect(await store.encryptedKv!.get("signer")).toBe(secret);
      const attempts = await Promise.all([store.secrets!.take(ref), store.secrets!.take(ref)]);
      expect(attempts.filter((value) => value === secret)).toHaveLength(1);
      expect(await store.secrets!.take(ref)).toBeNull();
      await store.encryptedKv!.delete("signer");
      expect(await store.encryptedKv!.get("signer")).toBeNull();
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("deduplicates private cards atomically and never includes values in requests or task items", async () => {
    const store = openStore({ path: ":memory:" });
    try {
      await store.migrate();
      await store.tasks!.insert(task);
      const input = {
        taskId: task.id,
        clientRequestId: "imap-password",
        text: "IMAP app password",
        createdAt: now,
        expiresAt: "2026-10-24T12:05:00.000Z",
      };
      const [first, retry] = await Promise.all([
        store.secrets!.requests.create(input),
        store.secrets!.requests.create(input),
      ]);
      expect(first.request.id).toBe(retry.request.id);
      expect(await store.tasks!.items.list({ taskId: task.id })).toHaveLength(1);
      const saved = await store.secrets!.requests.respond(
        first.request.id,
        task.id,
        { value: "private-value" },
        now,
      );
      expect(saved?.status).toBe("saved");
      expect(JSON.stringify(saved)).not.toContain("private-value");
      expect(await store.secrets!.take(saved!.secretRef!)).toBe("private-value");
      expect(
        await store.secrets!.requests.respond(first.request.id, "other", { value: "bad" }, now),
      ).toBeNull();
      expect(
        await store.secrets!.requests.respond(
          first.request.id,
          task.id,
          { value: "replacement" },
          now,
        ),
      ).toEqual(saved);
      expect(JSON.stringify(await store.tasks!.items.list({ taskId: task.id }))).not.toContain(
        "private-value",
      );
    } finally {
      await store.close();
    }
  });
  it.each(["declined", "cancelled", "timed_out"] as const)(
    "resolves %s without creating a reference",
    async (status) => {
      const store = openStore({ path: ":memory:" });
      try {
        await store.migrate();
        await store.tasks!.insert(task);
        const { request } = await store.secrets!.requests.create({
          taskId: task.id,
          clientRequestId: status,
          text: "Signing secret",
          createdAt: now,
          expiresAt: "2026-10-24T12:05:00.000Z",
        });
        const result =
          status === "timed_out"
            ? await store.secrets!.requests.get(request.id, task.id, "2026-10-24T12:06:00.000Z")
            : await store.secrets!.requests.respond(request.id, task.id, { status }, now);
        expect(result).toMatchObject({ status });
        expect(result).not.toHaveProperty("secretRef");
      } finally {
        await store.close();
      }
    },
  );
});
