import { MockMailProvider, mockCapabilities } from "@passport/providers";
import { InMemoryEventBus, openStore } from "@passport/store";
import { type Account, type MailReader, mailHandle, watcherTickKey } from "@passport/types";
import { describe, expect, it, vi } from "vitest";
import { createSyncIdentity } from "../sync/identity.js";
import { MailWatcher } from "./watcher.js";

const start = Date.parse("2026-10-20T12:00:00.000Z");
const account: Account = {
  id: "acct",
  kind: "mock",
  displayName: "Alex",
  emailAddress: "alex@example.com",
  capabilities: { ...mockCapabilities, calendar: false, push: false },
  settings: {},
  createdAt: new Date(start).toISOString(),
  updatedAt: new Date(start).toISOString(),
};
type CostLog = { costLog: Array<{ method: string; lane?: string }> };

/** The watcher with the store's read-through installed, as the composition root wires it. */
async function setup() {
  let clock = start;
  const store = openStore({ path: ":memory:" });
  await store.migrate();
  await store.accounts.upsert(account);
  const mail = new MockMailProvider({ now: () => new Date(clock) });
  await mail.connect(account);
  const reader: MailReader = mail.reader();
  store.setMailReaderResolver!(async () => reader);
  const watcher = new MailWatcher({
    store,
    bus: new InMemoryEventBus(),
    readers: async () => reader,
    normalize: createSyncIdentity(store).email,
    now: () => clock,
  });
  await watcher.tick(account.id);
  const log = () => (reader as unknown as CostLog).costLog;
  return {
    store,
    mail,
    watcher,
    log,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("R2-2 the watcher hot path stays cache-only with read-through installed", () => {
  it("ignores label changes on uncached mail and caches only arrivals, all in the arrivals lane", async () => {
    const env = await setup();
    const before = env.log().length;
    const ids = Array.from({ length: 10 }, (_, i) => `fixture-${String(i + 1).padStart(2, "0")}`);
    await env.mail.applyChanges([{ op: "setKeywords", providerIds: ids, add: ["$seen"] }]);
    for (const n of [1, 2, 3]) {
      env.mail.injectEmail({
        providerId: `new-${n}`,
        from: [{ email: "p@x.test" }],
        mailboxIds: ["acct:mailbox:Inbox"],
      });
    }
    env.advance(60_000);
    await env.watcher.tick(account.id);
    const calls = env.log().slice(before);
    expect(calls.every((call) => call.lane === "arrivals")).toBe(true);
    expect(calls.filter((call) => call.method === "envelopes")).toHaveLength(1);
    const cached = await env.store.emails.query({ accountId: account.id, limit: 100 });
    expect(cached.items.map((item) => item.providerId).sort()).toEqual(["new-1", "new-2", "new-3"]);
  });
});

describe("R2-3 a normal tick leaves cached rows fresh", () => {
  it("does not move the staleness watermark, so cached reads make no provider call", async () => {
    const env = await setup();
    env.mail.injectEmail({
      providerId: "a",
      from: [{ email: "p@x.test" }],
      mailboxIds: ["acct:mailbox:Inbox"],
    });
    env.advance(60_000);
    await env.watcher.tick(account.id);
    env.advance(60_000);
    await env.watcher.tick(account.id);
    expect(await env.store.kv.get(watcherTickKey(account.id))).toBeNull();
    const before = env.log().length;
    for (let i = 0; i < 5; i++) {
      await env.store.emails.get(mailHandle(account.id, "email", "a"), { includeBodies: false });
    }
    expect(env.log().slice(before)).toEqual([]);
  });
});

describe("R2-20 the watcher enforces the cache bounds", () => {
  it("runs body and envelope eviction at most hourly", async () => {
    const env = await setup();
    const bodies = vi.spyOn(env.store.emails, "evictBodies");
    const envelopes = vi.spyOn(env.store.emails, "evictEnvelopes");
    // Labels refresh every 10 minutes; maintenance piggybacks on it.
    for (let i = 0; i < 7; i++) {
      env.advance(11 * 60_000);
      await env.watcher.tick(account.id);
    }
    expect(bodies).toHaveBeenCalledTimes(1);
    expect(envelopes).toHaveBeenCalledTimes(1);
  });
});
