import {
  MockMailProvider,
  mockCapabilities,
  ProviderError,
  RateLimitedError,
} from "@passport/providers";
import { InMemoryEventBus, openStore } from "@passport/store";
import {
  type Account,
  type DomainEvent,
  type MailReader,
  mailHandle,
  type Store,
} from "@passport/types";
import { afterEach, describe, expect, it } from "vitest";
import { createSyncIdentity } from "../sync/identity.js";
import { readCursors } from "../sync/state.js";
import { inboxCount, readWatchStatus, stateKey, watcherTickKey } from "./status.js";
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
const inbox = `${account.id}:mailbox:Inbox`;
const handle = (providerId: string) => mailHandle(account.id, "email", providerId);
/** The mock reader with some methods replaced (class methods do not survive a spread). */
function override(reader: MailReader, methods: Partial<MailReader>): MailReader {
  return new Proxy(reader, {
    get: (target, property) => {
      const value = methods[property as keyof MailReader] ?? Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("MailWatcher", () => {
  const stores: Store[] = [];
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  async function fixture(
    options: { reader?: (reader: MailReader) => MailReader | null; pageSize?: number } = {},
  ) {
    let clock = start;
    const store = openStore({ path: ":memory:" });
    stores.push(store);
    await store.migrate();
    await store.accounts.upsert(account);
    const mail = new MockMailProvider({ now: () => new Date(clock) });
    await mail.connect(account);
    const bus = new InMemoryEventBus();
    const events: DomainEvent[] = [];
    bus.onAny((event) => events.push(event));
    const identity = createSyncIdentity(store);
    const reader = options.reader ? options.reader(mail.reader()) : mail.reader();
    const watcher = new MailWatcher({
      store,
      bus,
      readers: async () => reader,
      normalize: identity.email,
      now: () => clock,
      ...(options.pageSize ? { pageSize: options.pageSize } : {}),
    });
    const inject = (providerId: string, input: Parameters<typeof mail.injectEmail>[0] = {}) =>
      mail.injectEmail({
        providerId,
        from: [{ email: "pat@unknown.example", name: "Pat" }],
        mailboxIds: [inbox],
        ...input,
      });
    return {
      store,
      mail,
      watcher,
      events,
      inject,
      advance: (ms: number) => {
        clock += ms;
      },
      arrivals: () => events.filter((e) => e.type === "email.received"),
    };
  }

  it("takes a cursor at now on the first tick: no backfill, no arrivals", async () => {
    const { store, watcher, events, arrivals } = await fixture();
    const result = await watcher.tick(account.id);
    expect(result).toMatchObject({ status: "started", arrivals: 0 });
    expect(arrivals()).toHaveLength(0);
    // 40 fixtures exist at the provider; none are cached or queued.
    expect((await store.emails.query({ accountId: account.id, limit: 100 })).items).toHaveLength(0);
    expect(await store.kv.get("arrival:pending")).toBeNull();
    const stored = (await store.syncState.get(account.id))?.cursor;
    expect(stored?.startsWith("passport-watch-v1:")).toBe(true);
    expect((await readCursors(store, account.id)).since).toBe(new Date(start).toISOString());
    expect(await store.kv.get(watcherTickKey(account.id))).toBe(new Date(start).toISOString());
    expect(await inboxCount(store, account.id)).toBe(22);
    expect(events.map((e) => e.type)).toContain("account.watch.started");
  });

  it("queues new inbox mail as an arrival with a handle id", async () => {
    const { store, watcher, inject, arrivals, advance } = await fixture();
    await watcher.tick(account.id);
    advance(30_000);
    inject("new-1");
    const result = await watcher.tick(account.id);
    expect(result).toMatchObject({ status: "ok", added: 1, arrivals: 1 });
    expect(arrivals()).toHaveLength(1);
    const email = await store.emails.get(handle("new-1"));
    expect(email?.providerId).toBe("new-1");
    expect(await store.kv.get(`arrival:${handle("new-1")}`)).not.toBeNull();
    expect(JSON.parse((await store.kv.get("arrival:pending"))!)).toEqual({
      [handle("new-1")]: account.id,
    });
    expect(await store.kv.get(watcherTickKey(account.id))).toBe(
      new Date(start + 30_000).toISOString(),
    );
    // Replaying the same changes never triages twice.
    await watcher.tick(account.id);
    expect(arrivals()).toHaveLength(1);
  });

  it("caches but never triages self mail, Sent, Drafts or non-inbox mail", async () => {
    const { store, watcher, inject, arrivals } = await fixture();
    await watcher.tick(account.id);
    inject("self", { from: [{ email: "Alex@Example.com" }] });
    inject("sent", { mailboxIds: [`${account.id}:mailbox:Sent`] });
    inject("draft", { keywords: { $draft: true }, mailboxIds: [`${account.id}:mailbox:Drafts`] });
    inject("archived", { mailboxIds: [`${account.id}:mailbox:Archive`] });
    const result = await watcher.tick(account.id);
    expect(result).toMatchObject({ added: 4, arrivals: 0 });
    expect(arrivals()).toHaveLength(0);
    expect(await store.emails.get(handle("sent"))).not.toBeNull();
  });

  it("patches cached rows on label changes and ignores uncached ids", async () => {
    const { store, mail, watcher, inject } = await fixture();
    await watcher.tick(account.id);
    inject("new-1");
    await watcher.tick(account.id);
    await mail.applyChanges([
      { op: "setKeywords", providerIds: ["new-1", "fixture-20"], add: ["$seen"] },
    ]);
    await watcher.tick(account.id);
    expect((await store.emails.get(handle("new-1")))?.keywords.$seen).toBe(true);
    expect(await store.emails.getByProviderId(account.id, "fixture-20")).toBeNull();
  });

  it("removes cached rows for deleted messages without tombstones", async () => {
    const { store, mail, watcher, inject } = await fixture();
    await watcher.tick(account.id);
    inject("draft-1", { keywords: { $draft: true }, mailboxIds: [`${account.id}:mailbox:Drafts`] });
    await watcher.tick(account.id);
    expect(await store.emails.get(handle("draft-1"))).not.toBeNull();
    await mail.deleteDraft("draft-1");
    await watcher.tick(account.id);
    expect(await store.emails.get(handle("draft-1"))).toBeNull();
  });

  it("follows hasMore pages within one tick", async () => {
    const { watcher, inject } = await fixture({ pageSize: 1 });
    await watcher.tick(account.id);
    inject("a");
    inject("b");
    inject("c");
    expect(await watcher.tick(account.id)).toMatchObject({ added: 3, arrivals: 3 });
  });

  it("on cursor expiry marks labels stale and sweeps recent inbox mail once, deduped", async () => {
    const { store, watcher, inject, events, advance, arrivals } = await fixture();
    await watcher.tick(account.id);
    const before = (await readCursors(store, account.id)).mail;
    advance(8 * 86400_000);
    inject("handled");
    inject("missed");
    // "handled" was already triaged by its arrival run.
    await store.kv.set(`run:arrival:${handle("handled")}`, "{}");
    const result = await watcher.tick(account.id);
    expect(result).toMatchObject({ status: "expired", arrivals: 1 });
    expect(arrivals().map((e) => e.type === "email.received" && e.email.providerId)).toEqual([
      "missed",
    ]);
    expect(events.find((e) => e.type === "account.watch.expired")).toMatchObject({
      swept: 2,
      arrivals: 1,
    });
    expect(await store.kv.get(watcherTickKey(account.id))).toBe(
      new Date(start + 8 * 86400_000).toISOString(),
    );
    const after = (await readCursors(store, account.id)).mail;
    expect(after).not.toBe(before);
    // Continues from the fresh cursor.
    expect(await watcher.tick(account.id)).toMatchObject({ status: "ok", arrivals: 0 });
  });

  it("backs off on rate limits without failing the account", async () => {
    let limited = true;
    let calls = 0;
    const { store, watcher, events, advance } = await fixture({
      reader: (reader) =>
        override(reader, {
          changes: async (...args: Parameters<MailReader["changes"]>) => {
            calls++;
            if (limited && args[0] !== null) {
              throw new RateLimitedError(40, "gmail:user-quota", 429);
            }
            return reader.changes(...args);
          },
        }),
    });
    await watcher.tick(account.id);
    advance(30_000);
    expect(await watcher.tick(account.id)).toMatchObject({ status: "backoff" });
    expect(events.find((e) => e.type === "account.watch.backoff")).toMatchObject({
      retryAfterSeconds: 40,
    });
    expect(JSON.parse((await store.kv.get(stateKey(account.id)))!)).toMatchObject({
      status: "backoff",
    });
    expect(
      (await readWatchStatus(store, (await store.accounts.get(account.id))!, 30, start + 31_000))
        ?.status,
    ).toBe("backoff");
    const fresh = await store.accounts.get(account.id);
    expect(fresh?.lastSyncError ?? null).toBeNull();
    expect(fresh?.settings.reauthorizationRequired).toBeUndefined();
    const before = calls;
    advance(10_000);
    expect(await watcher.tick(account.id)).toMatchObject({ status: "backoff" });
    expect(calls).toBe(before);
    limited = false;
    advance(40_000);
    expect(await watcher.tick(account.id)).toMatchObject({ status: "ok" });
    expect(await store.kv.get(stateKey(account.id))).toBeNull();
  });

  it("pauses an account whose grant was revoked", async () => {
    const { store, watcher } = await fixture({
      reader: (reader) =>
        override(reader, {
          changes: async (cursor, ...rest) => {
            if (cursor !== null) {
              throw new ProviderError("AUTH_FAILED", "token=secret");
            }
            return reader.changes(cursor, ...rest);
          },
        }),
    });
    await watcher.tick(account.id);
    await expect(watcher.tick(account.id)).rejects.toMatchObject({ code: "AUTH_FAILED" });
    const paused = (await store.accounts.get(account.id))!;
    expect(paused).toMatchObject({
      lastSyncError: "REAUTHORIZE_REQUIRED",
      settings: { reauthorizationRequired: true },
    });
    expect(await watcher.tick(account.id)).toMatchObject({ status: "paused" });
    expect((await readWatchStatus(store, paused, 30))?.status).toBe("needs-sign-in");
  });

  it("reports providers without a reader as unsupported", async () => {
    const { store, watcher } = await fixture({ reader: () => null });
    expect(await watcher.tick(account.id)).toMatchObject({ status: "unsupported" });
    expect((await readWatchStatus(store, account, 30))?.status).toBe("unsupported");
  });

  it("derives watch status from durable state", async () => {
    const { store, watcher, advance } = await fixture();
    expect((await readWatchStatus(store, account, 30, start))?.status).toBe("starting");
    await watcher.tick(account.id);
    advance(30_000);
    await watcher.tick(account.id);
    expect(await readWatchStatus(store, account, 30, start + 45_000)).toEqual({
      since: new Date(start).toISOString(),
      lastTickAt: new Date(start + 30_000).toISOString(),
      cursorAgeSeconds: 15,
      status: "watching",
    });
    expect((await readWatchStatus(store, account, 30, start + 3600_000))?.status).toBe("stale");
  });
});
