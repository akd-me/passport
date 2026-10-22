import { createProviderRegistry, MockMailProvider, RateLimitedError } from "@passport/providers";
import { type Email, type MailRow, mailHandle } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addAccount } from "../accounts.js";
import { createApp } from "../auth.test-client.js";
import { createRealBackend, type RealBackend } from "../compose.js";
import { defaultConfig } from "../config.js";
import { createDemoBackend } from "../demo/index.js";
import { runDoctor } from "../doctor.js";

describe("on-demand mail routes", () => {
  const backends: RealBackend[] = [];
  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.close()));
    vi.restoreAllMocks();
  });
  async function fixture() {
    const mail = new MockMailProvider();
    const providers = createProviderRegistry();
    vi.spyOn(providers, "mail").mockReturnValue(mail);
    const backend = await createRealBackend(defaultConfig(), { storePath: ":memory:", providers });
    backends.push(backend);
    const account = await addAccount(backend, {
      kind: "mock",
      emailAddress: "alex@example.com",
      fields: {},
    });
    await backend.syncAccount(account.id);
    return { backend, account, mail, app: createApp(backend) };
  }

  it("requires bearer authentication", async () => {
    const { app } = await fixture();
    expect(
      (await app.request("/api/emails", { headers: { Authorization: "Bearer no" } })).status,
    ).toBe(401);
  });

  it("searches the provider with q, account, limit and pageToken", async () => {
    const { app, account } = await fixture();
    const first = (await (
      await app.request(
        `/api/emails?q=${encodeURIComponent("from:sam@example.com")}&account=${account.id}&limit=2`,
      )
    ).json()) as { items: MailRow[]; nextPageToken?: string; source: string; cost: object };
    expect(first.items).toHaveLength(2);
    expect(first.items.every((row) => row.from.includes("sam@example.com"))).toBe(true);
    expect(first.source).toBe("provider");
    expect(first.cost).toMatchObject({ gmailUnits: expect.any(Number) });
    expect(first.nextPageToken).toBeTruthy();
    const second = (await (
      await app.request(
        `/api/emails?q=${encodeURIComponent("from:sam@example.com")}&account=${account.id}&limit=2&pageToken=${encodeURIComponent(first.nextPageToken!)}`,
      )
    ).json()) as { items: MailRow[] };
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect((await app.request("/api/emails?limit=0")).status).toBe(400);
  });

  it("answers 429 with a retry hint when the provider is rate limited", async () => {
    const { app, mail } = await fixture();
    vi.spyOn(mail.reader(), "search").mockRejectedValue(
      new RateLimitedError(12, "gmail:user-quota"),
    );
    const response = await app.request("/api/emails?q=hello");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("12");
    expect(await response.json()).toMatchObject({
      retryAfterSeconds: 12,
      scope: "gmail:user-quota",
    });
  });

  it("reads uncached messages and threads by handle, and triages a handle", async () => {
    const { app, account, backend } = await fixture();
    const id = mailHandle(account.id, "email", "fixture-19");
    const email = (await (
      await app.request(`/api/emails/${encodeURIComponent(id)}`)
    ).json()) as Email;
    expect(email).toMatchObject({ id, providerId: "fixture-19" });
    expect(email.textBody).toBeTruthy();
    expect(
      (
        await app.request(
          `/api/emails/${encodeURIComponent(mailHandle(account.id, "email", "nope"))}`,
        )
      ).status,
    ).toBe(404);
    const thread = (await (
      await app.request(`/api/threads/${encodeURIComponent(email.threadId)}`)
    ).json()) as { thread: { emailIds: string[] }; emails: { items: Email[] } };
    expect(thread.thread.emailIds).toContain(id);
    expect(thread.emails.items.length).toBeGreaterThan(1);
    const run = vi.spyOn(backend.agent, "run").mockResolvedValue({
      id: "run",
      trigger: { kind: "email.received", emailId: id },
      startedAt: new Date().toISOString(),
      actionIds: [],
      summary: "Triaged",
    });
    expect(
      (await app.request(`/api/agent/triage/${encodeURIComponent(id)}`, { method: "POST" })).status,
    ).toBe(200);
    expect(run).toHaveBeenCalledWith({ kind: "email.received", emailId: id });
    expect(await backend.store.emails.get(id)).not.toBeNull();
  });

  it("falls back to cached mail when no reader exists (demo)", async () => {
    const backend = await createDemoBackend();
    try {
      const page = (await (await createApp(backend).request("/api/emails?limit=5")).json()) as {
        items: Email[];
        source: string;
      };
      expect(page.items).toHaveLength(5);
      expect(page.source).toBe("cache");
    } finally {
      await backend.close();
    }
  });

  it("doctor reports watcher health from the cursor and last tick", async () => {
    const { backend, account } = await fixture();
    const report = await runDoctor(backend, { probe: async () => {} });
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: `${account.emailAddress} watcher`, status: "ok" }),
    );
    const later = await runDoctor(backend, {
      probe: async () => {},
      now: () => Date.now() + 3600_000,
    });
    expect(later.checks).toContainEqual(
      expect.objectContaining({
        name: `${account.emailAddress} watcher`,
        status: "warning",
        detail: expect.stringContaining("No new-mail check"),
      }),
    );
  });
});
