import {
  createProviderRegistry,
  MockCalendarProvider,
  MockMailProvider,
  mockCapabilities,
} from "@passport/providers";
import { InMemoryEventBus, openStore } from "@passport/store";
import {
  type Account,
  type DomainEvent,
  type Email,
  mailHandle,
  type Store,
  type SyncDelta,
} from "@passport/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderConnections } from "./connections.js";
import { SyncService } from "./index.js";
import { legacyPrefix, parseCursors, prefix, readCursors, updateCursors } from "./state.js";

const at = "2026-01-15T09:00:00Z";
export const account: Account = {
  id: "account",
  kind: "mock",
  displayName: "Alex",
  emailAddress: "alex@example.com",
  capabilities: mockCapabilities,
  settings: {},
  createdAt: at,
  updatedAt: at,
};

describe("real provider ingestion", () => {
  let store: Store,
    mail: MockMailProvider,
    calendar: MockCalendarProvider,
    service: SyncService,
    events: DomainEvent[];
  beforeEach(async () => {
    store = openStore({ path: ":memory:" });
    await store.migrate();
    await store.accounts.upsert(account);
    mail = new MockMailProvider();
    calendar = new MockCalendarProvider();
    await mail.connect(account, {});
    await calendar.connect(account, {});
    const bus = new InMemoryEventBus();
    events = [];
    bus.onAny((event) => events.push(event));
    service = new SyncService(store, bus, async () => calendar);
  });
  afterEach(async () => {
    await mail.disconnect();
    await calendar.disconnect();
    await store.close();
    vi.restoreAllMocks();
  });
  async function annotate(...emails: Email[]) {
    await store.matters.upsert({
      id: "matter",
      title: "Keep this history",
      summary: "Agent notes",
      status: "waiting",
      personIds: ["person"],
      emailIds: emails.map((e) => e.id),
      eventIds: [],
      nextStep: "Review",
      createdAt: at,
      updatedAt: at,
    });
    await store.emails.patchMany(
      emails.map((e) => e.id),
      {
        category: "receipts",
        personIds: ["person"],
        matterId: "matter",
      },
    );
  }
  it("syncs only the bounded calendar; mail is never mirrored", async () => {
    await service.syncAccount(account.id);
    expect((await store.emails.query({ accountId: account.id, limit: 100 })).items).toHaveLength(0);
    expect(await store.events.query({ accountId: account.id })).toHaveLength(6);
    expect(events.filter((event) => event.type === "email.received")).toHaveLength(0);
    expect(parseCursors((await store.syncState.get(account.id))?.cursor)).toMatchObject({
      mail: null,
      calendar: expect.any(String),
    });
    const mailOnly = {
      ...account,
      id: "mail-only",
      capabilities: { ...mockCapabilities, calendar: false },
    };
    await store.accounts.upsert(mailOnly);
    await service.syncAccount(mailOnly.id);
    expect(await store.syncState.get(mailOnly.id)).toBeNull();
  });
  it("deletes calendar tombstones and resets an expired calendar cursor", async () => {
    await service.syncAccount(account.id);
    const event = (await store.events.query({ accountId: account.id }))[0]!;
    await calendar.deleteEvent(event.providerId);
    await service.syncAccount(account.id);
    expect(await store.events.get(event.id)).toBeNull();
    vi.spyOn(calendar, "sync").mockImplementationOnce(async function* () {
      throw Object.assign(new Error("expired"), { code: "CURSOR_EXPIRED" });
    });
    await service.syncAccount(account.id);
    expect(await store.events.query({ accountId: account.id })).toHaveLength(5);
  });
  it("requires a final calendar cursor and shares overlapping passes", async () => {
    vi.spyOn(calendar, "sync").mockImplementationOnce(async function* () {});
    const first = service.syncAccount(account.id);
    expect(service.syncAccount(account.id)).toBe(first);
    await expect(first).rejects.toMatchObject({ code: "SYNC_INCOMPLETE" });
    expect(await store.syncState.get(account.id)).toBeNull();
    expect((await store.accounts.get(account.id))!.lastSyncError).toBe("SYNC_INCOMPLETE");
  });
  it("keeps a v0.2 calendar cursor but never reuses the retired mail cursor", async () => {
    await store.syncState.set({
      accountId: account.id,
      cursor: `${legacyPrefix}${JSON.stringify({ mail: "old-mail", calendar: "old-calendar" })}`,
      updatedAt: at,
    });
    expect(await readCursors(store, account.id)).toEqual({ mail: null, calendar: "old-calendar" });
    await updateCursors(store, account.id, { mail: "watch" });
    expect((await store.syncState.get(account.id))!.cursor).toBe(
      `${prefix}${JSON.stringify({ mail: "watch", calendar: "old-calendar" })}`,
    );
  });
  it("gives new mail rows handle ids and keeps v0.2 ULID mappings and annotations", async () => {
    const raw = (await mail.getEmail("fixture-01"))!;
    const fresh = await service.email(account.id, { ...raw, providerId: "brand-new", id: "x" });
    expect(fresh.id).toBe(mailHandle(account.id, "email", "brand-new"));
    expect(fresh.threadId).toBe(raw.threadId);
    expect(fresh.mailboxIds).toEqual(raw.mailboxIds);
    await store.kv.set(`sync-provider:${account.id}:email:fixture-01`, "01LEGACYULID0000000000000");
    const legacy = await service.email(account.id, raw);
    expect(legacy.id).toBe("01LEGACYULID0000000000000");
    await store.emails.upsertMany([{ ...legacy, matterId: null }]);
    await store.emails.patchMany([legacy.id], { category: "receipts" });
    expect((await service.email(account.id, raw)).category).toBe("receipts");
  });
  it("R7: failed calendar cursor recovery preserves unseen events and local links until a complete restart", async () => {
    await service.syncAccount(account.id);
    const before = await store.events.query({ accountId: account.id, limit: 100 });
    const [kept, unseen] = before;
    await annotate();
    await store.events.upsertMany([
      { ...kept!, matterId: "matter", sourceEmailId: "local-invite" },
    ]);
    let raw: typeof kept;
    for await (const delta of calendar.sync(null)) {
      if (
        delta.kind === "event" &&
        delta.op === "upsert" &&
        delta.event.providerId === kept!.providerId
      ) {
        raw = delta.event;
      }
    }
    const pass = vi
      .spyOn(calendar, "sync")
      .mockImplementationOnce(async function* () {
        throw Object.assign(new Error("expired"), { code: "CURSOR_EXPIRED" });
      })
      .mockImplementationOnce(async function* (cursor) {
        expect(cursor).toBeNull();
        yield {
          kind: "event",
          op: "upsert",
          event: { ...raw!, id: "changed-native-id", title: "Refreshed" },
        };
        yield { kind: "event", op: "delete", providerId: unseen!.providerId };
        throw new Error("Replacement failed");
      });
    await expect(service.syncAccount(account.id)).rejects.toThrow("Replacement failed");
    expect(await store.events.get(unseen!.id)).not.toBeNull();
    expect(await store.events.query({ accountId: account.id, limit: 100 })).toHaveLength(
      before.length,
    );
    expect(await store.events.get(kept!.id)).toMatchObject({
      title: "Refreshed",
      matterId: "matter",
      sourceEmailId: "local-invite",
    });
    service = new SyncService(store, new InMemoryEventBus(), async () => calendar);
    pass.mockImplementationOnce(async function* (cursor) {
      expect(cursor).toBeNull();
      yield { kind: "event", op: "upsert", event: { ...raw!, id: "another-native-id" } };
      yield { kind: "cursor", cursor: "full-replacement" };
    });
    await service.syncAccount(account.id);
    expect(await store.events.query({ accountId: account.id, limit: 100 })).toHaveLength(1);
    expect(await store.events.get(kept!.id)).toMatchObject({
      matterId: "matter",
      sourceEmailId: "local-invite",
    });
    expect((await store.matters.get("matter"))!.eventIds).toContain(kept!.id);
  });
  it("uses one lazy connection across push, sync and executor operations; reconnects after failure without replay", async () => {
    const registry = createProviderRegistry();
    vi.spyOn(registry, "mail").mockReturnValue(mail);
    const connect = vi.spyOn(mail, "connect");
    const pool = new ProviderConnections(store, registry, async (_id, _method, value) => value);
    const [one, two] = await Promise.all([pool.mail(account.id), pool.mail(account.id)]);
    expect(one).toBe(two);
    expect(connect).not.toHaveBeenCalled();
    await Promise.all([one.getEmail("fixture-01"), two.getEmail("fixture-02")]);
    expect(registry.mail).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    const send = vi.spyOn(mail, "send").mockRejectedValueOnce(new Error("network"));
    await expect(
      one.send({
        draft: {
          accountId: account.id,
          to: [{ email: "sam@example.com" }],
          subject: "Hello",
          textBody: "Hello",
        },
      }),
    ).rejects.toThrow("network");
    expect(send).toHaveBeenCalledTimes(1);
    await one.getEmail("fixture-01");
    expect(connect).toHaveBeenCalledTimes(2);
    await pool.close();
  });
  it("keeps a sync's connection when a concurrent operation fails, invalidating once idle", async () => {
    const registry = createProviderRegistry();
    vi.spyOn(registry, "mail").mockReturnValue(mail);
    const disconnect = vi.spyOn(mail, "disconnect");
    const pool = new ProviderConnections(store, registry, async (_id, _method, value) => value);
    const provider = await pool.mail(account.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(mail, "sync").mockImplementation(async function* () {
      await gate;
      yield { kind: "cursor", cursor: "done" };
    });
    const sync = (async () => {
      const deltas: SyncDelta[] = [];
      for await (const delta of provider.sync(null)) {
        deltas.push(delta);
      }
      return deltas;
    })();
    await vi.waitFor(() => expect(mail.sync).toHaveBeenCalled());
    vi.spyOn(mail, "getEmail").mockRejectedValueOnce(new Error("throttled"));
    await expect(provider.getEmail("fixture-01")).rejects.toThrow("throttled");
    expect(disconnect).not.toHaveBeenCalled();
    release();
    await expect(sync).resolves.toEqual([{ kind: "cursor", cursor: "done" }]);
    vi.spyOn(mail, "getEmail").mockRejectedValueOnce(new Error("broken"));
    await expect(provider.getEmail("fixture-01")).rejects.toThrow("broken");
    expect(disconnect).toHaveBeenCalledTimes(1);
    await pool.close();
  });
  it("counts reader calls as active operations and never invalidates on a failed read", async () => {
    const registry = createProviderRegistry();
    vi.spyOn(registry, "mail").mockReturnValue(mail);
    const disconnect = vi.spyOn(mail, "disconnect");
    const pool = new ProviderConnections(store, registry, async (_id, _method, value) => value);
    const provider = await pool.mail(account.id);
    const reader = await provider.reader!();
    await expect(reader.body("missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(disconnect).not.toHaveBeenCalled();
    expect((await reader.labels(false)).items.length).toBeGreaterThan(0);
    await pool.close();
  });
});
