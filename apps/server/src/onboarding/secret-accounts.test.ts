import { afterEach, describe, expect, it, vi } from "vitest";
import { addAccount } from "../accounts.js";
import { createApp } from "../auth.test-client.js";
import type { RealBackend } from "../compose.js";
import * as diagnostics from "../doctor.js";
import { secretReferences } from "../schedulers/secret-references.js";
import { getSchedulerService } from "../schedulers/service.js";
import { taskBackend } from "../tasks/test-support.js";

const backends: RealBackend[] = [];
afterEach(async () => {
  for (const backend of backends.splice(0)) {
    await getSchedulerService(backend).stop();
    await backend.close();
  }
  vi.restoreAllMocks();
});
const input = (ref: string) => ({
  kind: "imap",
  emailAddress: "private@example.com",
  fields: {
    host: "imap.fixture.invalid",
    smtpHost: "smtp.fixture.invalid",
    password: { secretRef: ref },
  },
});
const json = (value: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});

describe("probe-only private account setup", () => {
  it("peeks on successful and failed probes without consuming the ref or scheduling voice learning", async () => {
    const env = await taskBackend(backends);
    const app = createApp(env.backend);
    const secrets = secretReferences(env.backend.store);
    const ref = await secrets.put("private-password");
    const peek = vi.spyOn(secrets, "peek");
    const consume = vi.spyOn(secrets, "consume");
    const probe = vi.spyOn(diagnostics, "probeAccount").mockResolvedValue();
    probe.mockRejectedValueOnce(new Error("offline fixture failure"));
    const accounts = await env.backend.store.accounts.list();
    const pending = await env.backend.store.kv.get("voice-learning:pending");
    expect((await app.request("/api/accounts/test", json(input(ref)))).status).toBe(400);
    expect((await app.request("/api/accounts/test", json(input(ref)))).status).toBe(200);
    expect(peek).toHaveBeenCalledWith(ref);
    expect(probe).toHaveBeenLastCalledWith(env.backend, expect.objectContaining({ kind: "imap" }), {
      password: "private-password",
    });
    expect(consume).not.toHaveBeenCalled();
    expect(await secrets.peek(ref)).toBe("private-password");
    expect(await env.backend.store.kv.get("voice-learning:pending")).toBe(pending);
    expect(await env.backend.store.accounts.list()).toEqual(accounts);
    const added = await app.request("/api/accounts", json(input(ref)));
    expect(added.status).toBe(201);
    expect(await secrets.peek(ref)).toBeNull();
    expect(consume).toHaveBeenCalledExactlyOnceWith([ref]);
  });
  it.each(["validation", "upsert", "credentials", "account-list", "config"])(
    "keeps refs reusable when %s fails and removes partial accounts",
    async (phase) => {
      const env = await taskBackend(backends);
      const secrets = secretReferences(env.backend.store);
      const ref = await secrets.put("private-password");
      const before = await env.backend.store.accounts.list();
      const beforeConfig = structuredClone(env.backend.config.accounts);
      const consume = vi.spyOn(secrets, "consume");
      const value = input(ref);
      if (phase === "validation") value.emailAddress = "invalid";
      if (phase === "upsert")
        vi.spyOn(env.backend.store.accounts, "upsert").mockRejectedValueOnce(new Error("fixture"));
      if (phase === "credentials")
        vi.spyOn(env.backend.store.accounts, "setCredentials").mockRejectedValueOnce(
          new Error("fixture"),
        );
      if (phase === "account-list")
        vi.spyOn(env.backend.store.accounts, "list").mockRejectedValueOnce(new Error("fixture"));
      if (phase === "config") {
        const update = env.backend.updateConfig.bind(env.backend);
        vi.spyOn(env.backend, "updateConfig").mockImplementationOnce(async (patch) => {
          await update(patch);
          throw new Error("fixture after config update");
        });
      }
      await expect(addAccount(env.backend, value)).rejects.toThrow();
      expect(consume).not.toHaveBeenCalled();
      expect(await secrets.peek(ref)).toBe("private-password");
      expect(await env.backend.store.accounts.list()).toEqual(before);
      expect(env.backend.config.accounts).toEqual(phase === "validation" ? beforeConfig : before);
    },
  );
  it("allows only one concurrent account to install a reference", async () => {
    const env = await taskBackend(backends);
    const secrets = secretReferences(env.backend.store);
    const ref = await secrets.put("private-password");
    const results = await Promise.allSettled([
      addAccount(env.backend, input(ref)),
      addAccount(env.backend, input(ref)),
    ]);
    expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(
      (await env.backend.store.accounts.list()).filter((account) => account.kind === "imap"),
    ).toHaveLength(1);
    expect(await secrets.peek(ref)).toBeNull();
  });
});
