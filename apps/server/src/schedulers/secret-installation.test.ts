import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../auth.test-client.js";
import type { RealBackend } from "../compose.js";
import { taskBackend } from "../tasks/test-support.js";
import { secretReferences } from "./secret-references.js";
import { getSchedulerService } from "./service.js";

const backends: RealBackend[] = [];
afterEach(async () => {
  for (const backend of backends.splice(0)) {
    await getSchedulerService(backend).stop();
    await backend.close();
  }
  vi.restoreAllMocks();
});

describe("late routine secret installation", () => {
  it.each(["signer", "definitions", "register", "webhook-record"])(
    "preserves refs and cleans partial state if %s persistence fails",
    async (phase) => {
      const env = await taskBackend(backends);
      const service = getSchedulerService(env.backend);
      await service.ready;
      const secrets = secretReferences(env.backend.store);
      const ref = await secrets.put("private-signing-key");
      const consume = vi.spyOn(secrets, "consume");
      const set = env.backend.store.kv.set.bind(env.backend.store.kv);
      let failed = false;
      let routineId = "";
      const originalEncryptedSet = env.backend.store.encryptedKv!.set.bind(
        env.backend.store.encryptedKv,
      );
      vi.spyOn(env.backend.store.encryptedKv!, "set").mockImplementation(async (key, value) => {
        routineId = key.slice("webhook-signature:".length);
        if (phase === "signer") throw new Error("fixture");
        await originalEncryptedSet(key, value);
      });
      vi.spyOn(env.backend.store.kv, "set").mockImplementation(async (key, value) => {
        const matches =
          phase === "definitions"
            ? key === "scheduler:routines"
            : phase === "register"
              ? key.startsWith("job:routine:")
              : phase === "webhook-record" && key.startsWith("scheduler:webhooks:routine:");
        if (!failed && matches) {
          failed = true;
          throw new Error("fixture");
        }
        await set(key, value);
      });
      const input = {
        name: "Signed hook",
        schedule: {
          type: "webhook",
          signature: { header: "x-sig", encoding: "hex", secretRef: ref },
        },
        routine: { instruction: "Read {{body}}" },
      };
      await expect(service.addRoutine(input)).rejects.toThrow("fixture");
      expect(consume).not.toHaveBeenCalled();
      expect(await secrets.peek(ref)).toBe("private-signing-key");
      expect(await env.backend.store.encryptedKv!.get("webhook-signature:" + routineId)).toBeNull();
      expect(service.scheduler.get(routineId)).toBeUndefined();
      expect(service.webhooks.path(routineId)).toBeUndefined();
      expect(JSON.parse((await env.backend.store.kv.get("scheduler:routines")) ?? "[]")).toEqual(
        [],
      );
      if (phase === "signer") vi.mocked(env.backend.store.encryptedKv!.set).mockRestore();
      const app = createApp(env.backend);
      const response = await app.request("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(201);
      expect(await secrets.peek(ref)).toBeNull();
    },
  );
});
