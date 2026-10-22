import { MockMailProvider } from "@passport/providers";
import type { Email, Person } from "@passport/types";
import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "./context.js";
import { matterCandidates, readThread } from "./matters.js";
import { PEOPLE_PER_ARRIVAL, resolvePeople } from "./people.js";
import { createRunReads, PEOPLE_READ_BUDGET } from "./reads.js";
import { MATTER_REVIEWS_PER_RUN, reviewMatters } from "./schedules.js";
import { MemoryBus } from "./testing/collaborators.js";
import {
  accountFixture,
  emailFixture,
  matterFixture,
  personFixture,
  TEST_NOW,
} from "./testing/fixtures.js";
import { MemoryStore } from "./testing/memory-store.js";

const inbox = "account-1:mailbox:Inbox";
const sentBox = "account-1:mailbox:Sent";
const fail = { dkim: "fail", spf: "fail", dmarc: "fail", passport: "green" } as const;

async function setup() {
  const mock = new MockMailProvider({ fixtures: false });
  await mock.connect(accountFixture());
  mock.setNow(TEST_NOW);
  const store = new MemoryStore();
  await store.accounts.upsert(accountFixture());
  const reads = createRunReads({ readers: async () => mock.reader(), lane: "arrivals" });
  const resolve = async (email: Email, reader: "people" | null = "people") => {
    await store.emails.upsertMany([email]);
    return resolvePeople({
      email,
      store,
      bus: new MemoryBus(),
      now: TEST_NOW,
      selfAddresses: new Set(["me@example.com"]),
      reader: reader ? await reads.reader(email.accountId, reader) : null,
      savePerson: async (person: Person) => {
        await store.people.upsert(person);
      },
    });
  };
  const relationship = async (address: string) =>
    (await store.people.getByEmail(address))?.relationship;
  return { mock, store, reads, resolve, relationship };
}

describe("R2-1 relationship evidence matches addresses exactly", () => {
  it("a lookalike containing a real correspondent's address stays a stranger", async () => {
    const env = await setup();
    env.mock.injectEmail({
      providerId: "sent-1",
      from: [{ email: "me@example.com" }],
      to: [{ name: "Alice", email: "alice@bigbank.com" }],
      mailboxIds: [sentBox],
      receivedAt: "2026-09-01T00:00:00.000Z",
    });
    const attack = env.mock.injectEmail({
      providerId: "evil-1",
      from: [{ name: "Alice", email: "alice@bigbank.co" }],
      to: [{ email: "me@example.com" }],
      cc: [],
      mailboxIds: [inbox],
      receivedAt: TEST_NOW,
      verification: fail,
    });
    await env.resolve(attack);
    expect(await env.store.people.getByEmail("alice@bigbank.co")).toMatchObject({
      relationship: "stranger",
      stats: { sent: 0, received: 0 },
    });
  });

  it("a display name containing an address is not mail from that address", async () => {
    const env = await setup();
    for (const [i, from] of ["x1@throwaway.test", "x2@throwaway.test"].entries()) {
      env.mock.injectEmail({
        providerId: `spoof-${i}`,
        from: [{ name: "boss@corp.test", email: from }],
        to: [{ email: "me@example.com" }],
        mailboxIds: [inbox],
        receivedAt: "2026-10-01T00:00:00.000Z",
      });
    }
    const first = env.mock.injectEmail({
      providerId: "real-1",
      from: [{ name: "Boss", email: "boss@corp.test" }],
      to: [{ email: "me@example.com" }],
      cc: [],
      mailboxIds: [inbox],
      receivedAt: TEST_NOW,
    });
    await env.resolve(first);
    expect(await env.store.people.getByEmail("boss@corp.test")).toMatchObject({
      relationship: "stranger",
      stats: { received: 1 },
    });
  });

  it("DMARC-failing mail never counts towards known, with or without a reader", async () => {
    for (const reader of ["people", null] as const) {
      const env = await setup();
      let last: Email | undefined;
      for (const n of [1, 2, 3]) {
        last = env.mock.injectEmail({
          providerId: `forged-${n}`,
          from: [{ email: "ceo@example.org" }],
          to: [{ email: "me@example.com" }],
          cc: [],
          mailboxIds: [inbox],
          receivedAt: `2026-10-0${n}T00:00:00.000Z`,
          verification: fail,
        });
        await env.store.emails.upsertMany([last]);
      }
      await env.resolve(last!, reader);
      expect(await env.relationship("ceo@example.org")).toBe("stranger");
    }
  });
});

describe("R2-13 recipient evidence is bounded and has its own budget", () => {
  it("resolves at most eight non-owner addresses, From and To first", async () => {
    const env = await setup();
    const many = Array.from({ length: 20 }, (_, i) => ({ email: `cc${i}@example.net` }));
    const email = env.mock.injectEmail({
      providerId: "wide",
      from: [{ email: "alice@example.com" }],
      to: [{ email: "me@example.com" }, { email: "bob@example.com" }],
      cc: many,
      mailboxIds: [inbox],
      receivedAt: TEST_NOW,
    });
    const result = await env.resolve(email);
    const addresses = result.people.map((person) => person.primaryEmail);
    expect(addresses.filter((address) => address !== "me@example.com")).toHaveLength(
      PEOPLE_PER_ARRIVAL,
    );
    expect(addresses.slice(0, 3)).toEqual([
      "alice@example.com",
      "me@example.com",
      "bob@example.com",
    ]);
    expect(env.reads.usage.calls).toBeLessThanOrEqual(PEOPLE_READ_BUDGET);
    // The run budget (body, thread, matter search) is untouched by people evidence.
    const run = await env.reads.reader("account-1");
    expect(await run?.call((r, opts) => r.countIds("from:x@example.com", 1, opts))).not.toBeNull();
  });
});

describe("R2-6 store reads carry the run's lane and budget", () => {
  it("storeRead charges the run budget and turns cache-only once it is spent", () => {
    const reads = createRunReads({ readers: async () => null, lane: "arrivals", budget: 1 });
    expect(reads.storeRead({ includeBodies: true })).toEqual({
      includeBodies: true,
      lane: "arrivals",
    });
    expect(reads.storeRead({ includeBodies: true })).toEqual({
      includeBodies: true,
      cacheOnly: true,
    });
    expect(createRunReads({ lane: "background" }).storeRead()).toEqual({ lane: "background" });
  });

  it("the stored-thread fallback reads only the newest ten members through storeRead", async () => {
    const store = new MemoryStore();
    const ids = Array.from({ length: 15 }, (_, i) => `e${i}`);
    await store.emails.upsertMany(ids.map((id) => emailFixture({ id, providerId: id })));
    await store.threads.upsertMany([{ id: "thread-1", accountId: "account-1", emailIds: ids }]);
    const get = vi.spyOn(store.emails, "get");
    const reads = createRunReads({ readers: async () => null, lane: "arrivals", budget: 4 });
    const thread = await readThread(store, emailFixture(), null, reads.storeRead);
    expect(thread).toHaveLength(10);
    expect(get.mock.calls.map(([id]) => id)).toEqual(ids.slice(-10));
    expect(get.mock.calls.filter(([, opts]) => opts?.lane === "arrivals")).toHaveLength(4);
    expect(get.mock.calls.filter(([, opts]) => opts?.cacheOnly)).toHaveLength(6);
  });
});

describe("R2-11 reviewMatters sees every active matter", () => {
  it("reviews the stale matters behind a page of recently updated ones, capped per run", async () => {
    const store = new MemoryStore();
    await store.accounts.upsert(accountFixture());
    const now = Date.parse(TEST_NOW);
    for (let i = 0; i < 60; i++) {
      const at = new Date(now - (i < 15 ? 30 * 86_400_000 : i * 60_000)).toISOString();
      await store.matters.upsert(
        matterFixture({ id: `m${String(i).padStart(2, "0")}`, createdAt: at, updatedAt: at }),
      );
    }
    const updated: string[] = [];
    const ctx = {
      store,
      now: () => TEST_NOW,
      notes: [] as string[],
      structured: async () => ({ summary: "s", nextStep: "n", status: "waiting" }),
      callTool: async (_name: string, input: { matterId: string }) => {
        updated.push(input.matterId);
        return {};
      },
    } as unknown as RunContext;
    await reviewMatters(ctx, 7);
    expect(updated).toHaveLength(MATTER_REVIEWS_PER_RUN);
    expect(updated.every((id) => Number(id.slice(1)) < 15)).toBe(true);
  });
});

describe("R2-12 v0.2 matters match new mail in reader mode", () => {
  it("finds the matter through the stored thread and through ULID rows behind search handles", async () => {
    const env = await setup();
    // A v0.2 row in this thread, linked to its matter, and another (other thread) only listed
    // by ULID in a second matter's emailIds.
    await env.store.emails.upsertMany([
      emailFixture({ id: "01JTHREADROW", providerId: "old-thread", matterId: "matter-thread" }),
      emailFixture({ id: "01JSEARCHROW", providerId: "old-search", threadId: "thread-other" }),
    ]);
    await env.store.matters.upsert(matterFixture({ id: "matter-thread" }));
    await env.store.matters.upsert(
      matterFixture({ id: "matter-search", title: "Zzz", summary: "", emailIds: ["01JSEARCHROW"] }),
    );
    env.mock.injectEmail({
      providerId: "old-search",
      from: [{ email: "alice@example.com" }],
      mailboxIds: [inbox],
      receivedAt: "2026-10-10T00:00:00.000Z",
    });
    const arrival = emailFixture({ id: "account-1:email:new", providerId: "new", subject: "Hi" });
    const reader = await env.reads.reader("account-1");
    const found = await matterCandidates(
      { store: env.store, selfAddresses: new Set(["me@example.com"]) },
      arrival,
      [],
      reader,
    );
    expect(found.map((matter) => matter.id).sort()).toEqual(["matter-search", "matter-thread"]);
  });
});

describe("R2-23 verification follows message order", () => {
  it("an older green message replayed after newer blue mail neither downgrades nor rewinds", async () => {
    const env = await setup();
    await env.store.people.upsert(
      personFixture({
        verification: "blue",
        lastSeenBlueAt: "2026-10-15T00:00:00.000Z",
        stats: { sent: 1, received: 1, lastContactAt: "2026-10-15T00:00:00.000Z" },
      }),
    );
    const older = emailFixture({ receivedAt: "2026-10-01T00:00:00.000Z" });
    const result = await env.resolve(older, null);
    expect(result.downgraded).toEqual([]);
    expect(await env.store.people.getByEmail("alice@example.com")).toMatchObject({
      verification: "blue",
      lastSeenBlueAt: "2026-10-15T00:00:00.000Z",
    });
  });
});
