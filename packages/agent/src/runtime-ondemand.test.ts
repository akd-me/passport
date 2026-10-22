import { MockMailProvider } from "@passport/providers";
import type { Email } from "@passport/types";
import { describe, expect, it, vi } from "vitest";
import { createAgentRuntime } from "./runtime.js";
import { FakeExecutor, FakePolicy, MemoryBus } from "./testing/collaborators.js";
import { FakeLlm } from "./testing/fake-llm.js";
import {
  accountFixture,
  matterFixture,
  newMatterOutput,
  personFixture,
  TEST_NOW,
} from "./testing/fixtures.js";
import { MemoryStore } from "./testing/memory-store.js";

const inbox = "account-1:mailbox:Inbox";

async function setup(script: unknown[], opts: { reader?: boolean } = {}) {
  const mock = new MockMailProvider({ fixtures: false });
  await mock.connect(accountFixture());
  mock.setNow(TEST_NOW);
  const store = new MemoryStore(),
    policy = new FakePolicy(),
    bus = new MemoryBus(),
    llm = new FakeLlm(script);
  await store.accounts.upsert(accountFixture());
  const executor = new FakeExecutor(store, policy);
  const readers = vi.fn(async () => mock.reader());
  const runtime = createAgentRuntime({
    store,
    executor,
    policy,
    bus,
    llm,
    selfAddresses: ["me@example.com"],
    now: () => TEST_NOW,
    ...(opts.reader === false ? {} : { readers }),
  });
  /** A provider message plus its body-less envelope in the store (the v0.3 envelope cache). */
  const arrive = async (input: Partial<Email>): Promise<Email> => {
    const email = mock.injectEmail({
      from: [{ name: "Alice", email: "alice@example.com" }],
      to: [{ email: "me@example.com" }],
      cc: [],
      mailboxIds: [inbox],
      receivedAt: TEST_NOW,
      verification: { dkim: "pass", spf: "pass", dmarc: "pass", passport: "green" },
      ...input,
    });
    const { textBody: _text, htmlBody: _html, ...envelope } = email;
    await store.emails.upsertMany([envelope]);
    return email;
  };
  const query = vi.spyOn(store.emails, "query");
  return { mock, store, executor, bus, llm, runtime, readers, arrive, query };
}

describe("triage on on-demand readers", () => {
  it("triages an envelope-only email, fetching its body through the reader", async () => {
    const env = await setup([newMatterOutput]);
    const email = await env.arrive({
      providerId: "wire",
      subject: "Quick favour",
      textBody: "Please make a wire transfer to the account below today.",
      preview: "Quick favour",
    });
    const run = await env.runtime.run({ kind: "email.received", emailId: email.id });
    // The sensitive screen saw the body, so no fast-model classification was needed.
    expect(env.llm.calls).toHaveLength(1);
    expect(env.llm.calls[0]?.messages[0]?.content).toContain("wire transfer");
    expect(run.summary).toContain("as money");
    expect(env.mock.reader().costLog.map((entry) => entry.method)).toContain("body");
    expect(env.mock.reader().costLog.every((entry) => entry.lane === "arrivals")).toBe(true);
    expect(run.toolBudget.reads).toMatchObject({ failures: 0, skipped: 0 });
    expect(run.toolBudget.reads!.calls).toBeLessThanOrEqual(12);
    expect(env.readers).toHaveBeenCalledTimes(1);
    // Only the bounded page of this thread (R2-12: v0.2 matters list stored ids); no scans.
    expect(env.query.mock.calls.every(([q]) => !!q.threadId && (q.limit ?? 50) <= 30)).toBe(true);
  });

  it("triages an envelope-only email without a reader from its subject and preview", async () => {
    const env = await setup([{ category: "other" }, newMatterOutput], { reader: false });
    const email = await env.arrive({ providerId: "plain", preview: "Lunch on Friday?" });
    const run = await env.runtime.run({ kind: "email.received", emailId: email.id });
    expect(env.llm.calls[0]?.messages[0]?.content).toContain("Lunch on Friday?");
    expect(run.toolBudget.reads).toBeUndefined();
  });

  it("offers matters referencing recent mail with the sender, found by reader search", async () => {
    const env = await setup([
      { category: "replies_stranger" },
      { ...newMatterOutput, matterId: "matter-1" },
    ]);
    const earlier = env.mock.injectEmail({
      providerId: "earlier",
      from: [{ email: "alice@example.com" }],
      mailboxIds: [inbox],
      receivedAt: "2026-10-01T00:00:00.000Z",
    });
    // Older provider mail outside the 90-day window must not be searched for.
    const ancient = env.mock.injectEmail({
      providerId: "ancient",
      from: [{ email: "alice@example.com" }],
      mailboxIds: [inbox],
      receivedAt: "2026-01-01T00:00:00.000Z",
    });
    await env.store.matters.upsert(matterFixture({ title: "Garden", emailIds: [earlier.id] }));
    await env.store.matters.upsert(
      matterFixture({ id: "matter-old", title: "Old", emailIds: [ancient.id] }),
    );
    const email = await env.arrive({ providerId: "new", subject: "Following up" });
    await env.runtime.run({ kind: "email.received", emailId: email.id });
    const prompt = String(env.llm.calls[1]?.messages[0]?.content);
    expect(prompt).toContain('"id":"matter-1"');
    expect(prompt).not.toContain("matter-old");
    expect(env.executor.requests.find((r) => r.type === "matter_attach")).toMatchObject({
      params: { matterId: "matter-1" },
    });
    expect(env.mock.reader().costLog.map((entry) => entry.method)).toContain("search");
    // Only the bounded page of this thread (R2-12: v0.2 matters list stored ids); no scans.
    expect(env.query.mock.calls.every(([q]) => !!q.threadId && (q.limit ?? 50) <= 30)).toBe(true);
  });

  it("offers matters whose title shares a subject word", async () => {
    const env = await setup([{ category: "other" }, newMatterOutput]);
    await env.store.matters.upsert(matterFixture({ title: "Kitchen renovation" }));
    const email = await env.arrive({ providerId: "k", subject: "Renovation quote" });
    await env.runtime.run({ kind: "email.received", emailId: email.id });
    expect(String(env.llm.calls[1]?.messages[0]?.content)).toContain('"id":"matter-1"');
  });

  it("drafts replies from the provider thread", async () => {
    const env = await setup([
      { category: "replies_known" },
      newMatterOutput,
      { textBody: "Happy to help." },
    ]);
    await env.store.people.upsert(personFixture());
    const threadId = "account-1:thread:garden";
    env.mock.injectEmail({
      providerId: "previous",
      threadId,
      from: [{ email: "alice@example.com" }],
      mailboxIds: [inbox],
      textBody: "Only the provider holds this prior thread context.",
      receivedAt: "2026-10-10T00:00:00.000Z",
    });
    const email = await env.arrive({ providerId: "reply-me", threadId });
    await env.runtime.run({ kind: "email.received", emailId: email.id });
    expect(String(env.llm.calls[2]?.messages[0]?.content)).toContain("prior thread context");
    expect(env.mock.reader().costLog.map((entry) => entry.method)).toContain("thread");
    expect(env.executor.requests.find((r) => r.type === "draft_create")).toBeDefined();
  });
});

describe("matter review", () => {
  it("fetches only the newest referenced emails and never scans by matter", async () => {
    const env = await setup([
      { summary: "Quiet for a while", nextStep: "Follow up", status: "waiting" },
    ]);
    const ids = Array.from({ length: 30 }, (_, i) => `old-${i}`);
    await env.store.matters.upsert(matterFixture({ emailIds: ids }));
    const get = vi.spyOn(env.store.emails, "get");
    await env.runtime.run({ kind: "schedule", name: "matter_review" });
    expect(get.mock.calls.map(([id]) => id)).toEqual(ids.slice(-20));
    expect(env.query).not.toHaveBeenCalled();
    expect(await env.store.matters.get("matter-1")).toMatchObject({ status: "waiting" });
  });
});

describe("run queue priority", () => {
  it("starts interactive runs before queued background runs", async () => {
    const env = await setup(["Done.", "Done."]);
    const runs = [
      env.runtime.run({ kind: "schedule", name: "outbox" }),
      env.runtime.run({ kind: "schedule", name: "daily_digest" }),
      env.runtime.run({ kind: "manual", instruction: "Summarize my day" }),
      env.runtime.run({ kind: "schedule", name: "outbox" }, { priority: "interactive" }),
      env.runtime.run({ kind: "manual", instruction: "Routine" }, { priority: "background" }),
    ];
    expect(env.runtime.queued()).toEqual({ interactive: 2, background: 2 });
    await Promise.all(runs);
    const started = env.bus.events.flatMap((event) =>
      event.type === "agent.run.started" ? [event.trigger] : [],
    );
    expect(started).toEqual([
      "schedule:outbox",
      "manual",
      "schedule:outbox",
      "schedule:daily_digest",
      "manual",
    ]);
    expect(env.runtime.queued()).toEqual({ interactive: 0, background: 0 });
  });

  it("keeps running queued work after a failed run", async () => {
    const env = await setup([]);
    const failed = env.runtime.run({ kind: "email.received", emailId: "missing" });
    const next = env.runtime.run({ kind: "schedule", name: "outbox" });
    await expect(failed).rejects.toMatchObject({ code: "EMAIL_NOT_FOUND" });
    await expect(next).resolves.toMatchObject({ summary: expect.stringContaining("Released") });
  });
});
