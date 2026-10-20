import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MockMailProvider,
  MockCalendarProvider,
  createProviderRegistry,
  mockCapabilities,
} from "@passport/providers";
import { openStore, InMemoryEventBus } from "@passport/store";
import type { Account, DomainEvent, Store, SyncDelta } from "@passport/types";
import { SyncService } from "./index.js";
import { ProviderConnections } from "./connections.js";

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
  it("maps all references, keeps verification, and replays idempotently without retriggering arrivals", async () => {
    await service.syncAccount(account.id);
    const first = await store.emails.query({
      accountId: account.id,
      limit: 100,
    });
    expect(first.items).toHaveLength(40);
    expect(
      events.filter((event) => event.type === "email.received"),
    ).toHaveLength(40);
    expect(await store.mailboxes.list(account.id)).toHaveLength(8);
    const calendars = await store.calendars.list(account.id);
    const calendarEvents = await store.events.query({ accountId: account.id });
    expect(calendarEvents).toHaveLength(6);
    expect(
      calendarEvents.every((event) => event.calendarId === calendars[0]!.id),
    ).toBe(true);
    for (const email of first.items) {
      expect(email.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(email.personIds).toEqual([]);
      expect((await store.threads.get(email.threadId))!.emailIds).toContain(
        email.id,
      );
      for (const id of email.mailboxIds)
        expect(await store.mailboxes.get(id)).not.toBeNull();
    }
    const raw = await mail.getEmail("fixture-40");
    expect(
      (await store.emails.getByProviderId(account.id, "fixture-40"))!
        .verification,
    ).toEqual(raw!.verification);
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
    expect(
      events.filter((event) => event.type === "email.received"),
    ).toHaveLength(40);
    expect(
      events.some(
        (event) =>
          event.type === "email.updated" && event.emailId === existing.id,
      ),
    ).toBe(true);
    expect(await store.emails.get(existing.id)).toMatchObject({
      subject: "Updated subject",
      category: "triage",
      personIds: ["person"],
    });
    expect(
      (await store.emails.query({ limit: 100 })).items
        .map((item) => item.id)
        .sort(),
    ).toEqual(first.items.map((item) => item.id).sort());
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
        if (delta.kind === "cursor")
          throw Object.assign(new Error("secret-token"), {
            code: "NETWORK_ERROR",
          });
        yield delta;
      }
    });
    await expect(service.syncAccount(account.id)).rejects.toThrow(
      "secret-token",
    );
    expect(await store.syncState.get(account.id)).toEqual(previous);
    expect((await store.accounts.get(account.id))!.lastSyncError).toBe(
      "NETWORK_ERROR",
    );
    await service.syncAccount(account.id);
    expect(
      events.filter((event) => event.type === "email.received"),
    ).toHaveLength(41);
    expect((await store.syncState.get(account.id))!.cursor).not.toBe(
      previous!.cursor,
    );
  });
  it("clears expired mail snapshots, removes stale mail, preserves IDs and suppresses repeated arrivals", async () => {
    await service.syncAccount(account.id);
    const originalEmail = await store.emails.getByProviderId(
      account.id,
      "fixture-01",
    );
    const staleRaw = mail.injectEmail({ providerId: "stale" });
    await service.syncAccount(account.id);
    const original = mail.sync.bind(mail);
    vi.spyOn(mail, "sync")
      .mockImplementationOnce(async function* () {
        throw Object.assign(new Error("expired"), { code: "CURSOR_EXPIRED" });
      })
      .mockImplementationOnce(async function* (cursor) {
        expect(cursor).toBeNull();
        for await (const delta of original(cursor))
          if (
            !(
              delta.kind === "email" &&
              delta.op === "upsert" &&
              delta.email.providerId === staleRaw.providerId
            )
          )
            yield delta;
      });
    await service.syncAccount(account.id);
    expect(await store.emails.getByProviderId(account.id, "stale")).toBeNull();
    expect(
      (await store.emails.getByProviderId(account.id, "fixture-01"))!.id,
    ).toBe(originalEmail!.id);
    expect(
      events.filter((event) => event.type === "email.received"),
    ).toHaveLength(41);
  });
  it("ingests mail/calendar tombstones and resets an expired calendar cursor", async () => {
    await service.syncAccount(account.id);
    const email = (await store.emails.getByProviderId(
      account.id,
      "fixture-01",
    ))!;
    const event = (await store.events.query({ accountId: account.id }))[0]!;
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
    expect(await store.emails.get(email.id)).toBeNull();
    expect((await store.threads.get(email.threadId))!.emailIds).not.toContain(
      email.id,
    );
    expect(await store.events.get(event.id)).toBeNull();
    vi.spyOn(calendar, "sync").mockImplementationOnce(async function* () {
      throw Object.assign(new Error("expired"), { code: "CURSOR_EXPIRED" });
    });
    await service.syncAccount(account.id);
    expect(await store.events.query({ accountId: account.id })).toHaveLength(5);
  });
  it("requires a final cursor and shares overlapping passes", async () => {
    vi.spyOn(mail, "sync").mockImplementationOnce(async function* () {});
    const first = service.syncAccount(account.id);
    expect(service.syncAccount(account.id)).toBe(first);
    await expect(first).rejects.toMatchObject({ code: "SYNC_INCOMPLETE" });
    expect(await store.syncState.get(account.id)).toBeNull();
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
      const first = (await store.emails.getByProviderId(
        account.id,
        "fixture-01",
      ))!;
      const next = (await store.emails.getByProviderId(
        second.id,
        "fixture-01",
      ))!;
      expect(first.id).not.toBe(next.id);
      expect(first.threadId).not.toBe(next.threadId);
      expect(
        (await store.emails.query({ accountId: second.id, limit: 100 })).items,
      ).toHaveLength(40);
      expect((await store.mailboxes.get(next.mailboxIds[0]!))!.accountId).toBe(
        second.id,
      );
    } finally {
      await otherMail.disconnect();
      await otherCalendar.disconnect();
    }
  });
  it("uses one lazy connection across push, sync and executor operations; reconnects after failure without replay", async () => {
    const registry = createProviderRegistry();
    vi.spyOn(registry, "mail").mockReturnValue(mail);
    const connect = vi.spyOn(mail, "connect");
    const pool = new ProviderConnections(
      store,
      registry,
      async (_id, _method, value) => value,
    );
    const [one, two] = await Promise.all([
      pool.mail(account.id),
      pool.mail(account.id),
    ]);
    expect(one).toBe(two);
    expect(connect).not.toHaveBeenCalled();
    await Promise.all([one.getEmail("fixture-01"), two.getEmail("fixture-02")]);
    expect(registry.mail).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    const send = vi
      .spyOn(mail, "send")
      .mockRejectedValueOnce(new Error("network"));
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
});
