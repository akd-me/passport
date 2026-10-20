import { describe, expect, it } from "vitest";
import type { Email } from "@passport/types";
import { resolvePeople } from "./people.js";
import { FakeExecutor, FakePolicy, MemoryBus } from "./testing/collaborators.js";
import { emailFixture, personFixture, TEST_NOW } from "./testing/fixtures.js";
import { MemoryStore } from "./testing/memory-store.js";

async function resolve(email: Email = emailFixture(), history: Email[] = [], person?: ReturnType<typeof personFixture>) {
  const store = new MemoryStore(), policy = new FakePolicy(), bus = new MemoryBus(), executor = new FakeExecutor(store, policy);
  await store.emails.upsertMany([email, ...history]);
  if (person) await store.people.upsert(person);
  const result = await resolvePeople({ email, store, bus, now: TEST_NOW, selfAddresses: new Set(["me@example.com"]), submit: request => executor.submit({ ...request, actor: { kind: "agent", id: "run-people" }, runId: "run-people" }) });
  return { store, bus, executor, result, sender: await store.people.getByEmail(email.from[0]!.email) };
}

describe("people inference", () => {
  it("normalizes email addresses, infers self, and deduplicates from/to/cc", async () => {
    const env = await resolve(emailFixture({ to: [{ email: "ME@EXAMPLE.COM" }], cc: [{ email: "Alice@Example.com" }] }));
    expect(await env.store.people.list()).toHaveLength(2);
    expect(await env.store.people.getByEmail("me@example.com")).toMatchObject({ relationship: "self", primaryEmail: "me@example.com" });
    expect(env.sender).toMatchObject({ primaryEmail: "alice@example.com", relationship: "stranger", stats: { received: 1 } });
  });

  it.each([
    { listId: "news.example" },
    { extra: { precedence: "bulk" } },
    { extra: { precedence: "list" } },
  ])("uses sender headers to infer services: %j", async headers => {
    const env = await resolve(emailFixture({ headers: { messageId: null, inReplyTo: null, references: [], ...headers } }));
    expect(env.sender?.relationship).toBe("service");
    expect((await env.store.people.getByEmail("me@example.com"))?.relationship).toBe("self");
  });

  it("infers no-reply senders as services without marking other recipients service", async () => {
    const env = await resolve(emailFixture({ from: [{ email: "noreply@system.test" }], cc: [{ email: "bob@example.com" }] }));
    expect(env.sender?.relationship).toBe("service");
    expect((await env.store.people.getByEmail("bob@example.com"))?.relationship).toBe("stranger");
  });

  it("infers known after any previously sent message, including BCC", async () => {
    const previous = emailFixture({ id: "sent", from: [{ email: "me@example.com" }], to: [], bcc: [{ email: "alice@example.com" }], receivedAt: "2026-10-01T00:00:00.000Z" });
    const env = await resolve(emailFixture(), [previous]);
    expect(env.sender).toMatchObject({ relationship: "known", stats: { sent: 1, received: 1 } });
  });

  it("requires two prior received messages rather than counting the current message", async () => {
    const previous = emailFixture({ id: "prior-1", receivedAt: "2026-10-01T00:00:00.000Z" });
    const one = await resolve(emailFixture(), [previous]);
    expect(one.sender?.relationship).toBe("stranger");
    const two = await resolve(emailFixture(), [previous, { ...previous, id: "prior-2" }]);
    expect(two.sender).toMatchObject({ relationship: "known", stats: { received: 3 } });
  });

  it("uses prior recorded stats when normalized historical emails are absent", async () => {
    const env = await resolve(emailFixture(), [], personFixture({ relationship: "stranger", stats: { sent: 0, received: 2, lastContactAt: null } }));
    expect(env.sender?.relationship).toBe("known");
  });

  it("ignores future messages and unsent drafts when inferring prior contact", async () => {
    const sent = emailFixture({ id: "future", receivedAt: "2026-10-25T00:00:00.000Z", from: [{ email: "me@example.com" }], to: [{ email: "alice@example.com" }] });
    const draft = { ...sent, id: "draft", receivedAt: "2026-10-01T00:00:00.000Z", keywords: { $draft: true } };
    const env = await resolve(emailFixture(), [sent, draft]);
    expect(env.sender?.relationship).toBe("stranger");
  });

  it("derives verification only for the actual sender and emits blue-to-green downgrade alerts", async () => {
    const env = await resolve(emailFixture(), [], personFixture({ verification: "blue", lastSeenBlueAt: "2026-10-01T00:00:00.000Z" }));
    expect(env.sender).toMatchObject({ verification: "green", lastSeenBlueAt: "2026-10-01T00:00:00.000Z" });
    expect(env.bus.events).toEqual([expect.objectContaining({ type: "person.downgraded", emailId: "email-1", person: expect.objectContaining({ id: "person-alice" }) })]);
    expect(env.executor.requests[0]?.counterparty?.class).toBe("stranger");
  });

  it("never upgrades recipients from a sender's blue verification", async () => {
    const env = await resolve(emailFixture({ verification: { dkim: "pass", spf: "pass", dmarc: "pass", passport: "blue" }, cc: [{ email: "bob@example.com" }] }));
    expect(env.sender).toMatchObject({ verification: "blue", lastSeenBlueAt: TEST_NOW });
    expect((await env.store.people.getByEmail("bob@example.com"))?.verification).toBe("unknown");
  });

  it("refreshes a sender's unknown verification from normalized green headers", async () => {
    const env = await resolve(emailFixture(), [], personFixture({ verification: "unknown" }));
    expect(env.sender?.verification).toBe("green");
    expect(env.bus.events).toEqual([]);
  });

  it("paginates the entire history when counting prior messages", async () => {
    const history = Array.from({ length: 202 }, (_, i) => emailFixture({ id: `old-${i}`, from: [{ email: i >= 200 ? "alice@example.com" : "other@example.com" }], receivedAt: "2026-10-01T00:00:00.000Z" }));
    const env = await resolve(emailFixture(), history);
    expect(env.sender).toMatchObject({ relationship: "known", stats: { received: 3 } });
  });
});
