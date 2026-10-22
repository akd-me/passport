import {
  createProviderRegistry,
  MockCalendarProvider,
  MockMailProvider,
  mockCapabilities,
} from "@passport/providers";
import { InMemoryEventBus, openStore } from "@passport/store";
import type { Account, DomainEvent, Email, Store, SyncDelta } from "@passport/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderConnections } from "./connections.js";
import { SyncService } from "./index.js";

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
    service = new SyncService(
      store,
      bus,
      async () => mail,
      async () => calendar,
    );
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
  it("maps all references, keeps verification, and replays idempotently without retriggering arrivals", async () => {
    await service.syncAccount(account.id);
    const first = await store.emails.query({
      accountId: account.id,
      limit: 100,
    });
    expect(first.items).toHaveLength(40);
    expect(events.filter((event) => event.type === "email.received")).toHaveLength(40);
    expect(await store.mailboxes.list(account.id)).toHaveLength(8);
    const calendars = await store.calendars.list(account.id);
    const calendarEvents = await store.events.query({ accountId: account.id });
    expect(calendarEvents).toHaveLength(6);
    expect(calendarEvents.every((event) => event.calendarId === calendars[0]!.id)).toBe(true);
    for (const email of first.items) {
      expect(email.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(email.personIds).toEqual([]);
      expect((await store.threads.get(email.threadId))!.emailIds).toContain(email.id);
      for (const id of email.mailboxIds) {
        expect(await store.mailboxes.get(id)).not.toBeNull();
      }
    }
    const raw = await mail.getEmail("fixture-40");
    expect((await store.emails.getByProviderId(account.id, "fixture-40"))!.verification).toEqual(
      raw!.verification,
    );
    const existing = first.items[0]!;
    await store.emails.patchMany([existing.id], {
      category: "triage",
      personIds: ["person"],
    });
    mail.injectEmail({
      ...(await mail.getEmail(existing.providerId))!,
      subject: "Updated subject",
    });
    await service.syncAccount(account.id);
    expect(events.filter((event) => event.type === "email.received")).toHaveLength(40);
    expect(
      events.some((event) => event.type === "email.updated" && event.emailId === existing.id),
    ).toBe(true);
    expect(await store.emails.get(existing.id)).toMatchObject({
      subject: "Updated subject",
      category: "triage",
      personIds: ["person"],
    });
    expect((await store.emails.query({ limit: 100 })).items.map((item) => item.id).sort()).toEqual(
      first.items.map((item) => item.id).sort(),
    );
    expect(await store.accounts.get(account.id)).toMatchObject({
      lastSyncError: null,
      lastSyncAt: expect.any(String),
    });
  });
  it("does not advance cursors on interruption, retries without duplicate arrivals, and redacts errors", async () => {
    await service.syncAccount(account.id);
    const previous = await store.syncState.get(account.id);
    mail.injectEmail({ providerId: "new-one" });
    const original = mail.sync.bind(mail);
    vi.spyOn(mail, "sync").mockImplementationOnce(async function* (cursor) {
      for await (const delta of original(cursor)) {
        if (delta.kind === "cursor") {
          throw Object.assign(new Error("secret-token"), {
            code: "NETWORK_ERROR",
          });
        }
        yield delta;
      }
    });
    await expect(service.syncAccount(account.id)).rejects.toThrow("secret-token");
    expect(await store.syncState.get(account.id)).toEqual(previous);
    expect((await store.accounts.get(account.id))!.lastSyncError).toBe("NETWORK_ERROR");
    await service.syncAccount(account.id);
    expect(events.filter((event) => event.type === "email.received")).toHaveLength(41);
    expect((await store.syncState.get(account.id))!.cursor).not.toBe(previous!.cursor);
  });
  it("reconciles expired mail snapshots without losing annotations or matter history or retriggering arrivals", async () => {
    await service.syncAccount(account.id);
    const originalEmail = await store.emails.getByProviderId(account.id, "fixture-01");
    const staleRaw = mail.injectEmail({ providerId: "stale" });
    await service.syncAccount(account.id);
    const stale = (await store.emails.getByProviderId(account.id, "stale"))!;
    await annotate(originalEmail!, stale);
    mail.injectEmail({
      ...(await mail.getEmail("fixture-01"))!,
      subject: "Provider updated this",
      keywords: { $seen: true },
      category: null,
      personIds: [],
      matterId: null,
    });
    const original = mail.sync.bind(mail);
    vi.spyOn(mail, "sync")
      .mockImplementationOnce(async function* () {
        throw Object.assign(new Error("expired"), { code: "CURSOR_EXPIRED" });
      })
      .mockImplementationOnce(async function* (cursor) {
        expect(cursor).toBeNull();
        for await (const delta of original(cursor)) {
          if (
            !(
              delta.kind === "email" &&
              delta.op === "upsert" &&
              delta.email.providerId === staleRaw.providerId
            )
          ) {
            yield delta;
          }
        }
      });
    await service.syncAccount(account.id);
    expect(await store.emails.getByProviderId(account.id, "stale")).toMatchObject({
      id: stale.id,
      keywords: { $deleted: true },
      matterId: "matter",
      category: "receipts",
      personIds: ["person"],
    });
    expect(await store.emails.getByProviderId(account.id, "fixture-01")).toMatchObject({
      id: originalEmail!.id,
      subject: "Provider updated this",
      keywords: { $seen: true },
      category: "receipts",
      personIds: ["person"],
      matterId: "matter",
    });
    expect((await store.matters.get("matter"))!.emailIds).toEqual([originalEmail!.id, stale.id]);
    expect((await store.threads.get(stale.threadId))!.emailIds).toContain(stale.id);
    expect(events.filter((event) => event.type === "email.received")).toHaveLength(41);
  });
  it("keeps unseen emails after an interrupted reconciliation and restarts recovery from null", async () => {
    await service.syncAccount(account.id);
    const email = (await store.emails.getByProviderId(account.id, "fixture-01"))!;
    const unseen = (await store.emails.getByProviderId(account.id, "fixture-02"))!;
    await annotate(email, unseen);
    const raw = (await mail.getEmail(email.providerId))!;
    const sync = vi
      .spyOn(mail, "sync")
      .mockImplementationOnce(async function* () {
        throw Object.assign(new Error("expired"), { code: "CURSOR_EXPIRED" });
      })
      .mockImplementationOnce(async function* (cursor) {
        expect(cursor).toBeNull();
        yield {
          kind: "email",
          op: "upsert",
          email: { ...raw, subject: "Refreshed" },
        };
        yield { kind: "email", op: "delete", providerId: unseen.providerId };
        throw new Error("Interrupted snapshot");
      });
    await expect(service.syncAccount(account.id)).rejects.toThrow("Interrupted snapshot");
    expect((await store.emails.query({ accountId: account.id, limit: 100 })).items).toHaveLength(
      40,
    );
    expect((await store.emails.get(unseen.id))!.keywords.$deleted).toBeUndefined();
    expect(await store.emails.get(email.id)).toMatchObject({
      category: "receipts",
      personIds: ["person"],
      matterId: "matter",
    });
    expect(
      JSON.parse((await store.syncState.get(account.id))!.cursor!.slice("passport-sync-v1:".length))
        .mail,
    ).toBeNull();
    const bus = new InMemoryEventBus();
    bus.onAny((event) => events.push(event));
    service = new SyncService(
      store,
      bus,
      async () => mail,
      async () => calendar,
    );
    sync.mockImplementationOnce(async function* (cursor) {
      expect(cursor).toBeNull();
      yield { kind: "email", op: "upsert", email: raw };
      yield { kind: "cursor", cursor: "recovered" };
    });
    await service.syncAccount(account.id);
    expect(await store.emails.get(unseen.id)).toMatchObject({
      keywords: { $deleted: true },
      matterId: "matter",
    });
    expect((await store.matters.get("matter"))!.emailIds).toEqual([email.id, unseen.id]);
    expect(events.filter((event) => event.type === "email.received")).toHaveLength(40);
  });
  it("emits one arrival for duplicate provider identities within a pass and across replayed passes", async () => {
    const raw = (await mail.getEmail("fixture-01"))!;
    vi.spyOn(mail, "sync").mockImplementation(async function* () {
      yield { kind: "email", op: "upsert", email: raw };
      yield {
        kind: "email",
        op: "upsert",
        email: { ...raw, id: "different-native-id", subject: "Latest" },
      };
      yield { kind: "cursor", cursor: "duplicated" };
    });
    await service.syncAccount(account.id);
    await service.syncAccount(account.id);
    const page = await store.emails.query({ accountId: account.id });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.subject).toBe("Latest");
    expect(events.filter((event) => event.type === "email.received")).toHaveLength(1);
    expect(JSON.parse((await store.kv.get(`arrival:${page.items[0]!.id}`))!)).toMatchObject({
      attempts: 0,
    });
    expect((await store.threads.get(page.items[0]!.threadId))!.emailIds).toEqual([
      page.items[0]!.id,
    ]);
  });
  it("ingests mail/calendar tombstones and resets an expired calendar cursor", async () => {
    await service.syncAccount(account.id);
    const email = (await store.emails.getByProviderId(account.id, "fixture-01"))!;
    const event = (await store.events.query({ accountId: account.id }))[0]!;
    await annotate(email);
    await calendar.deleteEvent(event.providerId);
    const original = mail.sync.bind(mail);
    vi.spyOn(mail, "sync").mockImplementationOnce(async function* (cursor) {
      yield {
        kind: "email",
        op: "delete",
        providerId: email.providerId,
      } satisfies SyncDelta;
      yield* original(cursor);
    });
    await service.syncAccount(account.id);
    expect(await store.emails.get(email.id)).toMatchObject({
      keywords: { $deleted: true },
      matterId: "matter",
      category: "receipts",
      personIds: ["person"],
    });
    expect((await store.matters.get("matter"))!.emailIds).toContain(email.id);
    expect((await store.threads.get(email.threadId))!.emailIds).toContain(email.id);
    expect(await store.events.get(event.id)).toBeNull();
    vi.spyOn(calendar, "sync").mockImplementationOnce(async function* () {
      throw Object.assign(new Error("expired"), { code: "CURSOR_EXPIRED" });
    });
    await service.syncAccount(account.id);
    expect(await store.events.query({ accountId: account.id })).toHaveLength(5);
    mail.injectEmail((await mail.getEmail(email.providerId))!);
    await service.syncAccount(account.id);
    expect((await store.emails.get(email.id))!.keywords.$deleted).toBeUndefined();
    expect(events.filter((event) => event.type === "email.received")).toHaveLength(40);
  });
  it("requires a final cursor and shares overlapping passes", async () => {
    vi.spyOn(mail, "sync").mockImplementationOnce(async function* () {});
    const first = service.syncAccount(account.id);
    expect(service.syncAccount(account.id)).toBe(first);
    await expect(first).rejects.toMatchObject({ code: "SYNC_INCOMPLETE" });
    expect(await store.syncState.get(account.id)).toBeNull();
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
    service = new SyncService(
      store,
      new InMemoryEventBus(),
      async () => mail,
      async () => calendar,
    );
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
  it("R16: ingests sent/draft/self mail but only queues genuine arrivals, including self inbox mail", async () => {
    const raw = (await mail.getEmail("fixture-01"))!;
    vi.spyOn(mail, "sync").mockImplementation(async function* () {
      for (const [id, role] of [
        ["in", "inbox"],
        ["sent", "sent"],
        ["drafts", "drafts"],
        ["archive", "archive"],
      ] as const) {
        yield {
          kind: "mailbox",
          op: "upsert",
          mailbox: {
            id,
            accountId: account.id,
            providerId: id,
            role,
            name: role,
            totalEmails: 0,
            unreadEmails: 0,
          },
        };
      }
      for (const [id, box, draft, self] of [
        ["incoming", "in", false, false],
        ["outgoing", "sent", false, false],
        ["draft-role", "drafts", false, false],
        ["draft-keyword", "in", true, false],
        ["self-archive", "archive", false, true],
        ["self-inbox", "in", false, true],
      ] as const) {
        yield {
          kind: "email",
          op: "upsert",
          email: {
            ...raw,
            id,
            providerId: id,
            mailboxIds: [box],
            keywords: { $draft: draft },
            from: [{ email: self ? account.emailAddress : "sender@example.com" }],
            ...(id === "outgoing" ? { provenance: "sent" as const } : {}),
          },
        };
      }
      yield { kind: "cursor", cursor: "complete" };
    });
    await service.syncAccount(account.id);
    expect((await store.emails.query({ accountId: account.id })).items).toHaveLength(6);
    expect((await store.emails.getByProviderId(account.id, "outgoing"))!.provenance).toBe("sent");
    expect(
      events
        .filter((event) => event.type === "email.received")
        .map((event) => event.type === "email.received" && event.email.providerId)
        .sort(),
    ).toEqual(["incoming", "self-inbox"]);
    expect(Object.keys(JSON.parse((await store.kv.get("arrival:pending"))!))).toHaveLength(2);
    await service.syncAccount(account.id);
    expect(events.filter((event) => event.type === "email.received")).toHaveLength(2);
  });
  it("keeps identical provider IDs isolated between accounts", async () => {
    await service.syncAccount(account.id);
    const second = { ...account, id: "another-account" };
    await store.accounts.upsert(second);
    const otherMail = new MockMailProvider(),
      otherCalendar = new MockCalendarProvider();
    await otherMail.connect(second, {});
    await otherCalendar.connect(second, {});
    try {
      const other = new SyncService(
        store,
        new InMemoryEventBus(),
        async () => otherMail,
        async () => otherCalendar,
      );
      await other.syncAccount(second.id);
      const first = (await store.emails.getByProviderId(account.id, "fixture-01"))!;
      const next = (await store.emails.getByProviderId(second.id, "fixture-01"))!;
      expect(first.id).not.toBe(next.id);
      expect(first.threadId).not.toBe(next.threadId);
      expect((await store.emails.query({ accountId: second.id, limit: 100 })).items).toHaveLength(
        40,
      );
      expect((await store.mailboxes.get(next.mailboxIds[0]!))!.accountId).toBe(second.id);
    } finally {
      await otherMail.disconnect();
      await otherCalendar.disconnect();
    }
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
});
