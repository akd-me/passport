import { MockMailProvider } from "@passport/providers";
import { createToolRegistry } from "@passport/tools";
import type { Email, PersonWithStatsCache } from "@passport/types";
import { describe, expect, it, vi } from "vitest";
import { resolvePeople } from "./people.js";
import { createRunReads } from "./reads.js";
import { FakeExecutor, FakePolicy, MemoryBus } from "./testing/collaborators.js";
import { accountFixture, personFixture, TEST_NOW } from "./testing/fixtures.js";
import { MemoryStore } from "./testing/memory-store.js";

const inbox = "account-1:mailbox:Inbox";
const sentBox = "account-1:mailbox:Sent";
const days = (n: number) => new Date(Date.parse(TEST_NOW) + n * 86_400_000).toISOString();

async function setup(failCounts = false) {
  const mock = new MockMailProvider({ fixtures: false });
  await mock.connect(accountFixture());
  mock.setNow(TEST_NOW);
  const store = new MemoryStore(),
    policy = new FakePolicy(),
    bus = new MemoryBus(),
    executor = new FakeExecutor(store, policy);
  await store.accounts.upsert(accountFixture());
  const tools = createToolRegistry({
    store,
    executor,
    policy,
    bus,
    selfAddresses: ["me@example.com"],
    actor: { kind: "agent", id: "run-people" },
  });
  if (failCounts) {
    vi.spyOn(mock.reader(), "search").mockRejectedValue(
      new Error("RATE_LIMITED with untrusted subject text"),
    );
  }
  const query = vi.spyOn(store.emails, "query");
  const actions = vi.spyOn(store.actions, "query");
  const resolve = async (email: Email, opts: { now?: string; refreshStats?: boolean } = {}) => {
    await store.emails.upsertMany([email]);
    const reads = createRunReads({
      readers: async () => mock.reader(),
      lane: "arrivals",
    });
    const result = await resolvePeople({
      email,
      store,
      bus,
      now: opts.now ?? TEST_NOW,
      selfAddresses: new Set(["me@example.com"]),
      reader: await reads.reader(email.accountId),
      ...(opts.refreshStats ? { refreshStats: true } : {}),
      savePerson: async (person, reason) => {
        const result = await tools
          .find((tool) => tool.name === "update_person")!
          .handler(
            {
              accountId: "account-1",
              personId: person.id,
              patch: { displayName: person.displayName },
              reason,
            },
            { personSnapshot: person, projectedPeople: [person], runId: "run-people" },
          );
        if (result.isError) {
          throw new Error(JSON.stringify(result));
        }
      },
    });
    return { result, usage: reads.usage };
  };
  const alice = async () =>
    (await store.people.getByEmail("alice@example.com")) as PersonWithStatsCache | null;
  const counts = () => mock.reader().costLog.filter((entry) => entry.method === "search");
  return { mock, store, executor, query, actions, resolve, alice, counts };
}

/** Injects a provider message from Alice and returns its envelope as the store would hold it. */
function fromAlice(mock: MockMailProvider, providerId: string, receivedAt = TEST_NOW): Email {
  return mock.injectEmail({
    providerId,
    from: [{ name: "Alice", email: "alice@example.com" }],
    to: [{ email: "me@example.com" }],
    cc: [],
    mailboxIds: [inbox],
    receivedAt,
    verification: { dkim: "pass", spf: "pass", dmarc: "pass", passport: "green" },
  });
}

describe("people evidence through the reader", () => {
  it("classifies from capped evidence searches, caches stats, and never scans the store", async () => {
    const env = await setup();
    fromAlice(env.mock, "a-1", "2026-10-01T00:00:00.000Z");
    const first = await env.resolve(fromAlice(env.mock, "a-2"));
    expect(await env.alice()).toMatchObject({
      relationship: "stranger",
      stats: { sent: 0, received: 2 },
      statsRefreshedAt: TEST_NOW,
    });
    expect(first.usage).toMatchObject({ calls: 2, failures: 0 });
    expect(env.counts().every((entry) => entry.lane === "arrivals")).toBe(true);
    await env.resolve(fromAlice(env.mock, "a-3"));
    expect(await env.alice()).toMatchObject({
      relationship: "known",
      stats: { sent: 0, received: 3 },
    });
    expect(env.query).not.toHaveBeenCalled();
    expect(env.actions).not.toHaveBeenCalled();
  });

  it("treats any sent copy addressed to them, including BCC, as known", async () => {
    const env = await setup();
    env.mock.injectEmail({
      providerId: "sent-1",
      from: [{ email: "me@example.com" }],
      to: [],
      bcc: [{ email: "alice@example.com" }],
      mailboxIds: [sentBox],
      receivedAt: "2026-10-01T00:00:00.000Z",
    });
    const { result } = await env.resolve(fromAlice(env.mock, "a-1"));
    expect(await env.alice()).toMatchObject({
      relationship: "known",
      stats: { sent: 1, received: 1 },
    });
    expect(result.people.find((p) => p.primaryEmail === "me@example.com")?.relationship).toBe(
      "self",
    );
    // Self addresses are never counted: one sent and one received query for Alice only.
    expect(env.counts()).toHaveLength(2);
  });

  it("reuses established counts for seven days, then refreshes them", async () => {
    const env = await setup();
    env.mock.injectEmail({
      providerId: "sent-1",
      from: [{ email: "me@example.com" }],
      to: [{ email: "alice@example.com" }],
      mailboxIds: [sentBox],
      receivedAt: "2026-10-01T00:00:00.000Z",
    });
    const email = fromAlice(env.mock, "a-1");
    await env.resolve(email);
    const submitted = env.executor.requests.length;
    await env.resolve(email, { now: days(6) });
    expect(env.counts()).toHaveLength(2);
    // Nothing changed for an unchanged message, so no person_update is resubmitted.
    expect(env.executor.requests.length).toBe(submitted);
    await env.resolve(email, { now: days(8) });
    expect(env.counts()).toHaveLength(4);
    expect((await env.alice())?.statsRefreshedAt).toBe(days(8));
    await env.resolve(email, { now: days(8), refreshStats: true });
    expect(env.counts()).toHaveLength(6);
  });

  it("recounts weak evidence on each arrival so a third message promotes a stranger", async () => {
    const env = await setup();
    await env.resolve(fromAlice(env.mock, "a-1"));
    await env.resolve(fromAlice(env.mock, "a-2"), { now: days(1) });
    expect(env.counts()).toHaveLength(4);
    expect((await env.alice())?.relationship).toBe("stranger");
    await env.resolve(fromAlice(env.mock, "a-3"), { now: days(2) });
    expect((await env.alice())?.relationship).toBe("known");
  });

  it("keeps cached stats and the old stamp when the provider read fails", async () => {
    const env = await setup(true);
    await env.store.people.upsert(
      personFixture({
        relationship: "stranger",
        stats: { sent: 0, received: 1, lastContactAt: null },
      }),
    );
    const { usage } = await env.resolve(fromAlice(env.mock, "a-1"));
    expect(usage).toMatchObject({ calls: 2, failures: 2 });
    expect(await env.alice()).toMatchObject({
      relationship: "stranger",
      stats: { sent: 0, received: 1 },
    });
    expect((await env.alice())?.statsRefreshedAt).toBeUndefined();
  });

  it("keeps a sender's blue verification and downgrade alerts from the current headers", async () => {
    const env = await setup();
    await env.store.people.upsert(
      personFixture({ verification: "blue", lastSeenBlueAt: "2026-10-01T00:00:00.000Z" }),
    );
    const { result } = await env.resolve(fromAlice(env.mock, "a-1"));
    expect(result.downgraded).toEqual(["Alice"]);
    expect(await env.alice()).toMatchObject({
      verification: "green",
      lastSeenBlueAt: "2026-10-01T00:00:00.000Z",
      relationship: "known",
    });
  });
});
