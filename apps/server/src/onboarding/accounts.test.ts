import type { ActionRecord, Matter, Page } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addAccount } from "../accounts.js";
import { createApp } from "../auth.test-client.js";
import type { Backend } from "../backend.js";
import { createRealBackend } from "../compose.js";
import { defaultConfig, validateConfig } from "../config.js";
import { createDemoBackend } from "../demo/index.js";
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
  it("shows inbox counts and watcher state, has no backfill, and removes local data durably", async () => {
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
        accounts: Array<Record<string, unknown>>;
      };
    // The provider's inbox total from label counts, not a local row count.
    expect(data.accounts[0]!.messageCount).toBe(22);
    expect(data.accounts[0]).not.toHaveProperty("syncing");
    expect(data.accounts[0]!.watch).toEqual({
      since: expect.any(String),
      lastTickAt: expect.any(String),
      cursorAgeSeconds: expect.any(Number),
      status: "watching",
    });
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
    expect(await backend.store.kv.get(`watcher-tick:${account.id}`)).toBeNull();
    expect(await backend.store.syncState.get(account.id)).toBeNull();
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
    // Any value is ignored, even one v0.2 rejected.
    expect(() => validateConfig({ ...defaultConfig(), sync: { initialDays: 0 } })).not.toThrow();
    validateConfig({ ...defaultConfig(), sync: { initialDays: 365 } });
    const warnings = warn.mock.calls.filter((call) =>
      String(call.join(" ")).includes("initialDays"),
    );
    expect(warnings).toHaveLength(1);
    expect(() => validateConfig({ ...defaultConfig(), watch: { intervalSeconds: 1 } })).toThrow(
      "watch.intervalSeconds",
    );
  });
});
