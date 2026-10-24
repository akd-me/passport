import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@passport/store";
import type { Store } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealBackend } from "../compose.js";
import { taskBackend } from "../tasks/test-support.js";
import { secretReferences } from "./secret-references.js";
import { getSchedulerService } from "./service.js";

const backends: RealBackend[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const backend of backends.splice(0)) {
    await getSchedulerService(backend).stop();
    await backend.close();
  }
  for (const store of stores.splice(0)) await store.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function fixture() {
  const store = openStore({ path: ":memory:" });
  stores.push(store);
  await store.migrate();
  return { store, secrets: secretReferences(store) };
}

describe("saved secret reference expiry", () => {
  it("expires peeks and takes exactly one hour after saving without extending on peek", async () => {
    vi.useFakeTimers();
    const { secrets } = await fixture();
    const forPeek = await secrets.put("private-peek");
    const forTake = await secrets.put("private-take");
    vi.setSystemTime(Date.now() + 3600000 - 1);
    expect(await secrets.peek(forPeek)).toBe("private-peek");
    vi.setSystemTime(Date.now() + 1);
    expect(await secrets.peek(forPeek)).toBeNull();
    expect(await secrets.take(forTake)).toBeNull();
    expect(await secrets.consume([forPeek])).toBe(false);
  });
  it("keeps batch consumption atomic when one reference expires or is missing", async () => {
    vi.useFakeTimers();
    const { secrets } = await fixture();
    const valid = await secrets.put("valid");
    const expired = await secrets.put("expired", { ttlMs: 1 });
    vi.setSystemTime(Date.now() + 1);
    expect(await secrets.consume([valid, expired])).toBe(false);
    expect(await secrets.peek(valid)).toBe("valid");
    expect(await secrets.consume([valid, "secret:" + "0".repeat(64)])).toBe(false);
    expect(await secrets.take(valid)).toBe("valid");
    expect(await secrets.take(valid)).toBeNull();
  });
  it("preserves the original expiry across a file-backed restart", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "passport-secret-ttl-"));
    const path = join(dir, "store.db");
    let store = openStore({ path, masterKey: "offline-master-key" });
    try {
      await store.migrate();
      const ref = await secretReferences(store).put("private-persisted");
      await store.close();
      vi.setSystemTime(Date.now() + 3599999);
      store = openStore({ path, masterKey: "offline-master-key" });
      await store.migrate();
      expect(await secretReferences(store).peek(ref)).toBe("private-persisted");
      vi.setSystemTime(Date.now() + 1);
      expect(await secretReferences(store).take(ref)).toBeNull();
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("sweeps expired and legacy references through the existing maintenance job", async () => {
    const env = await taskBackend(backends);
    const service = getSchedulerService(env.backend);
    await service.ready;
    const secrets = secretReferences(env.backend.store);
    vi.useFakeTimers();
    const expired = await secrets.put("expired", { ttlMs: 1 });
    const legacy = "secret:" + "f".repeat(64);
    await env.backend.store.encryptedKv!.set(legacy, "legacy-no-expiry");
    const valid = await secrets.put("valid");
    await env.backend.store.encryptedKv!.set("webhook-signature:installed", "installed-key");
    vi.setSystemTime(Date.now() + 1);
    const result = await service.scheduler.runNow("store.maintenance");
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("expired 2 secret references");
    expect(await env.backend.store.encryptedKv!.get(expired)).toBeNull();
    expect(await env.backend.store.encryptedKv!.get(legacy)).toBeNull();
    expect(await secrets.peek(valid)).toBe("valid");
    expect(await env.backend.store.encryptedKv!.get("webhook-signature:installed")).toBe(
      "installed-key",
    );
  });
  it("starts a saved request's reference TTL when the value is saved", async () => {
    const env = await taskBackend(backends);
    const { task, done } = await env.backend.tasks!.service.create({
      title: "Private setup",
      message: "Set up private input",
    });
    await done;
    vi.useFakeTimers();
    const now = new Date().toISOString();
    const { request } = await env.backend.store.secrets!.requests.create({
      taskId: task.id,
      clientRequestId: "ttl",
      text: "Signing key",
      createdAt: now,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    });
    const saved = await env.backend.store.secrets!.requests.respond(
      request.id,
      task.id,
      { value: "private-saved" },
      now,
    );
    expect(saved?.status).toBe("saved");
    const secrets = secretReferences(env.backend.store);
    vi.setSystemTime(Date.now() + 3600000);
    expect(await secrets.peek(saved!.secretRef!)).toBeNull();
  });
});
