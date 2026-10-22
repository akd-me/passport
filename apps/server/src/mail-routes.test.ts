import {
  createProviderRegistry,
  MockCalendarProvider,
  MockMailProvider,
  RateLimitedError,
} from "@passport/providers";
import { type AgentRun, type Email, type MailRow, mailHandle } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addAccount } from "./accounts.js";
import { createApp } from "./auth.test-client.js";
import { createRealBackend, type RealBackend } from "./compose.js";
import { defaultConfig } from "./config.js";

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
    vi.spyOn(providers, "calendar").mockReturnValue(new MockCalendarProvider());
    const backend = await createRealBackend(defaultConfig(), { storePath: ":memory:", providers });
    backends.push(backend);
    const account = await addAccount(backend, {
      kind: "mock",
      emailAddress: "alex@example.com",
      fields: {},
    });
    return { backend, account, mail, app: createApp(backend) };
  }

  it("GET /api/emails searches the provider with q, account, limit and pageToken", async () => {
    const { backend, account, app } = await fixture();
    const first = await app.request(
      `/api/emails?q=${encodeURIComponent("Garden")}&account=${account.id}&limit=2`,
    );
    expect(first.status).toBe(200);
    const page = (await first.json()) as { items: MailRow[]; nextPageToken?: string };
    expect(page.items).toHaveLength(2);
    expect(page.items.every((row) => row.subject.includes("Garden"))).toBe(true);
    expect(page.items[0]!.id).toMatch(new RegExp(`^${account.id}:email:`));
    expect(page.nextPageToken).toBeTruthy();
    const next = (await (
      await app.request(
        `/api/emails?q=Garden&account=${account.id}&limit=2&pageToken=${encodeURIComponent(page.nextPageToken!)}`,
      )
    ).json()) as { items: MailRow[] };
    expect(next.items.map((row) => row.id)).not.toContain(page.items[0]!.id);
    // Search reads the provider; nothing is mirrored locally.
    expect((await backend.store.emails.query({ accountId: account.id })).items).toHaveLength(0);
    expect((await app.request("/api/emails?limit=0")).status).toBe(400);
  });

  it("GET /api/emails answers 429 with Retry-After when the provider is rate limited", async () => {
    const { mail, app } = await fixture();
    vi.spyOn(mail.reader(), "search").mockRejectedValue(
      new RateLimitedError(12, "gmail:user-quota", 429),
    );
    const response = await app.request("/api/emails?q=Garden");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("12");
    expect(await response.json()).toMatchObject({
      error: { code: "RATE_LIMITED" },
      retryAfterSeconds: 12,
    });
  });

  it("GET /api/emails/:id reads a handle through the cache, then serves it locally", async () => {
    const { backend, account, mail, app } = await fixture();
    const id = mailHandle(account.id, "email", "fixture-19");
    const response = await app.request(`/api/emails/${encodeURIComponent(id)}`);
    expect(response.status).toBe(200);
    const email = (await response.json()) as Email;
    expect(email).toMatchObject({ id, providerId: "fixture-19" });
    expect(email.textBody).toBeTruthy();
    const cached = await backend.store.emails.get(id, { cacheOnly: true });
    expect(cached?.id).toBe(id);
    const missing = mailHandle(account.id, "email", "nope");
    expect((await app.request(`/api/emails/${encodeURIComponent(missing)}`)).status).toBe(404);
    expect(mail.reader().costLog.length).toBeGreaterThan(0);
  });

  it("GET /api/threads/:id reads a thread handle from the provider", async () => {
    const { account, app } = await fixture();
    const email = (await (
      await app.request(
        `/api/emails/${encodeURIComponent(mailHandle(account.id, "email", "fixture-19"))}`,
      )
    ).json()) as Email;
    const response = await app.request(`/api/threads/${encodeURIComponent(email.threadId)}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      thread: { id: string; emailIds: string[] };
      emails: { items: Email[] };
    };
    expect(body.thread.id).toBe(email.threadId);
    expect(body.emails.items.map((item) => item.providerId)).toContain("fixture-19");
  });

  it("POST /api/agent/triage/:id accepts a handle and runs as an interactive run", async () => {
    const { backend, account, app } = await fixture();
    const run = vi.spyOn(backend.agent, "run").mockResolvedValue({
      id: "run",
      trigger: { kind: "manual", instruction: "fixture" },
      startedAt: new Date().toISOString(),
      actionIds: [],
      summary: "Triaged",
    } satisfies AgentRun);
    const id = mailHandle(account.id, "email", "fixture-20");
    const response = await app.request(`/api/agent/triage/${encodeURIComponent(id)}`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledExactlyOnceWith(
      { kind: "email.received", emailId: id },
      { priority: "interactive" },
    );
    expect(await backend.store.emails.get(id, { cacheOnly: true })).not.toBeNull();
  });
});
