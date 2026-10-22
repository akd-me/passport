import { type ActionRecord, type Matter, type Page, watcherTickKey } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addAccount } from "../accounts.js";
import { createApp } from "../auth.test-client.js";
import type { Backend } from "../backend.js";
import { createRealBackend } from "../compose.js";
import { defaultConfig, validateConfig } from "../config.js";
import { createDemoBackend } from "../demo/index.js";
import type { WatchStatus } from "../watch/status.js";
import { resetDeprecationWarnings } from "./config.js";

describe("account onboarding API", () => {
  let backend: Backend | undefined;
  afterEach(async () => {
    await backend?.close();
    vi.restoreAllMocks();
  });
  it("tests a mock connection without persisting the account or credentials", async () => {
    backend = await createRealBackend(defaultConfig(), {
      storePath: ":memory:",
    });
    const app = createApp(backend),
      before = await backend.store.accounts.list();
    const response = await app.request("/api/accounts/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "mock",
        emailAddress: "new@example.com",
        fields: {},
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await backend.store.accounts.list()).toEqual(before);
  });
  it("validates fields and returns a safe connection failure", async () => {
    backend = await createRealBackend(defaultConfig(), {
      storePath: ":memory:",
    });
    const app = createApp(backend);
    vi.spyOn(backend.providers, "mail").mockImplementation(() => {
      throw new Error("password=private");
    });
    const response = await app.request("/api/accounts/test", {
      method: "POST",
      body: JSON.stringify({
        kind: "imap",
        emailAddress: "a@example.com",
        fields: {
          host: "mail.example",
          smtpHost: "smtp.example",
          password: "private",
          port: "not-a-port",
        },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private");
    expect(await backend.store.accounts.list()).toHaveLength(0);
  });
  it("shows inbox counts and watcher health, and removes local mail and credentials durably", async () => {
    backend = await createRealBackend(defaultConfig(), {
      storePath: ":memory:",
    });
    const account = await addAccount(backend, {
      kind: "mock",
      emailAddress: "alex@example.com",
      fields: {},
    });
    await backend.syncAccount(account.id);
    const app = createApp(backend),
      data = (await (await app.request("/api/accounts")).json()) as {
        accounts: Array<{ messageCount: number | null; watch: WatchStatus | null }>;
      };
    // Inbox total from the provider's label counts (22 of the 40 fixtures are in the Inbox).
    expect(data.accounts[0]!.messageCount).toBe(22);
    expect(data.accounts[0]).not.toHaveProperty("syncing");
    expect(data.accounts[0]!.watch).toMatchObject({
      status: "watching",
      since: expect.any(String),
      lastTickAt: expect.any(String),
      cursorAgeSeconds: expect.any(Number),
    });
    // Backfill is gone: there is no local mirror to extend.
    expect(
      (await app.request(`/api/accounts/${account.id}/backfill?days=90`, { method: "POST" }))
        .status,
    ).toBe(404);
    expect((await app.request(`/api/accounts/${account.id}`, { method: "DELETE" })).status).toBe(
      200,
    );
    expect(await backend.store.accounts.list()).toHaveLength(0);
    expect(await backend.store.accounts.getCredentials(account.id)).toBeNull();
    expect((await backend.store.emails.query({ accountId: account.id })).items).toHaveLength(0);
    expect(backend.config.accounts).toHaveLength(0);
    expect(await backend.store.kv.get(watcherTickKey(account.id))).toBeNull();
  });
  it("filters actions before pagination and adds account IDs to matters", async () => {
    backend = await createDemoBackend();
    const app = createApp(backend),
      all = await backend.store.actions.query({ limit: 500 });
    const id = all.items[0]!.request.accountId;
    const filtered = (await (
      await app.request(`/api/actions?accountId=${encodeURIComponent(id)}&limit=1`)
    ).json()) as Page<ActionRecord>;
    expect(filtered.items).toHaveLength(1);
    expect(
      filtered.items.every((a: { request: { accountId: string } }) => a.request.accountId === id),
    ).toBe(true);
    expect(filtered.total).toBe(all.items.filter((a) => a.request.accountId === id).length);
    expect(
      ((await (await app.request("/api/decisions?accountId=missing")).json()) as Page<ActionRecord>)
        .items,
    ).toHaveLength(0);
    const matters = (await (
      await app.request(`/api/matters?accountId=${encodeURIComponent(id)}`)
    ).json()) as Array<Matter & { accountIds: string[] }>;
    expect(matters.every((m: { accountIds: string[] }) => m.accountIds.includes(id))).toBe(true);
  });
  it("accepts the deprecated sync.initialDays once with a warning and validates the watch interval", () => {
    resetDeprecationWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(defaultConfig().sync).toBeUndefined();
    expect(defaultConfig().watch?.intervalSeconds).toBe(30);
    validateConfig({ ...defaultConfig(), sync: { initialDays: 0 } });
    validateConfig({ ...defaultConfig(), sync: { initialDays: 90 } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("sync.initialDays is deprecated");
    expect(() => validateConfig({ ...defaultConfig(), watch: { intervalSeconds: 1 } })).toThrow(
      "watch.intervalSeconds",
    );
  });
});
