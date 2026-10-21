import { MockMailProvider, mockCapabilities } from "@passport/providers";
import { InMemoryEventBus, openStore } from "@passport/store";
import type { Account, DomainEvent, Store, SyncDelta } from "@passport/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSyncService } from "./sync.js";

describe("account sync lifecycle", () => {
  let store: Store,
    mail: MockMailProvider,
    bus: InMemoryEventBus,
    service: AccountSyncService,
    events: DomainEvent[];
  const account: Account = {
    id: "test",
    kind: "mock",
    displayName: "Test",
    emailAddress: "alex@example.com",
    capabilities: { ...mockCapabilities, calendar: false },
    settings: {},
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
    store = openStore({ path: ":memory:" });
    await store.migrate();
    await store.accounts.upsert(account);
    mail = new MockMailProvider();
    await mail.connect(account, {});
    bus = new InMemoryEventBus();
    events = [];
    bus.onAny((e) => events.push(e));
    service = new AccountSyncService(
      store,
      bus,
      async () => mail,
      async () => {
        throw new Error("No calendar");
      },
      {},
      {
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        random: () => 0.5,
      },
    );
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await mail.disconnect();
    await store.close();
  });
  it.each([429, 503])(
    "retries HTTP %s with exponential backoff and stops after five retries",
    async (status) => {
      const sync = vi.spyOn(mail, "sync").mockImplementation(async function* () {
        throw Object.assign(new Error("remote secret"), {
          code: status === 429 ? "RATE_LIMITED" : "HTTP_503",
          status,
        });
      });
      const job = service.syncAccount(account.id),
        failed = expect(job).rejects.toMatchObject({ status });
      await vi.advanceTimersByTimeAsync(0);
      expect(sync).toHaveBeenCalledTimes(1);
      for (const delay of [1000, 2000, 4000, 8000, 16000]) {
        const before = sync.mock.calls.length;
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(sync).toHaveBeenCalledTimes(before);
        await vi.advanceTimersByTimeAsync(1);
        expect(sync).toHaveBeenCalledTimes(before + 1);
      }
      await failed;
      expect(events.filter((e) => e.type === "account.sync.retry")).toHaveLength(5);
      expect(events).toContainEqual({
        type: "account.sync.failed",
        accountId: account.id,
        error: status === 429 ? "RATE_LIMITED" : "HTTP_503",
      });
      expect((await store.accounts.get(account.id))?.lastSyncError).not.toContain("secret");
    },
  );
  it("recovers from a transient failure and commits the successful cursor", async () => {
    let calls = 0;
    vi.spyOn(mail, "sync").mockImplementation(async function* (): AsyncIterable<SyncDelta> {
      if (calls++ === 0) throw Object.assign(new Error(), { status: 503, code: "HTTP_503" });
      yield { kind: "cursor", cursor: "finished" };
    });
    const job = service.syncAccount(account.id);
    expect(service.syncAccount(account.id)).toBe(job);
    await vi.advanceTimersByTimeAsync(1000);
    await job;
    expect((await store.syncState.get(account.id))?.cursor).toContain("finished");
    expect((await store.accounts.get(account.id))?.lastSyncError).toBeNull();
  });
  it("pauses revoked grants without a scheduled crash loop", async () => {
    const sync = vi.spyOn(mail, "sync").mockImplementation(async function* () {
      throw Object.assign(new Error(), { code: "OAUTH_REFRESH_FAILED" });
    });
    await expect(service.syncAccount(account.id)).rejects.toMatchObject({
      code: "OAUTH_REFRESH_FAILED",
    });
    expect(await store.accounts.get(account.id)).toMatchObject({
      settings: { reauthorizationRequired: true },
      lastSyncError: "REAUTHORIZE_REQUIRED",
    });
    await service.syncAccount(account.id);
    expect(sync).toHaveBeenCalledTimes(1);
  });
  it("passes a 30-day initial window, widens backfill, and retains messages across the full pass", async () => {
    const sync = vi.spyOn(mail, "sync").mockImplementation(async function* () {
      yield { kind: "cursor", cursor: "done" };
    });
    await service.syncAccount(account.id);
    expect(sync).toHaveBeenLastCalledWith(null, {
      since: "2026-01-30T12:00:00.000Z",
    });
    await service.backfill(account.id, 90);
    expect(sync).toHaveBeenLastCalledWith(null, {
      since: "2025-12-01T12:00:00.000Z",
    });
    expect((await store.accounts.get(account.id))?.settings.syncDays).toBe(90);
    await service.syncAccount(account.id);
    expect(sync).toHaveBeenLastCalledWith("done", {
      since: "2025-12-01T12:00:00.000Z",
    });
    await expect(service.backfill(account.id, NaN)).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
  });
  it("keeps backfilled annotations and does not tombstone emails outside an expired snapshot window", async () => {
    const oldRaw = mail.injectEmail({
      providerId: "old",
      receivedAt: "2025-12-15T12:00:00.000Z",
    });
    const recentRaw = mail.injectEmail({
      providerId: "recent",
      receivedAt: "2026-02-15T12:00:00.000Z",
    });
    vi.spyOn(mail, "sync").mockImplementationOnce(async function* () {
      yield { kind: "email", op: "upsert", email: recentRaw };
      yield { kind: "cursor", cursor: "initial" };
    });
    await service.syncAccount(account.id);
    const recent = (await store.emails.getByProviderId(account.id, "recent"))!;
    await store.emails.patchMany([recent.id], {
      category: "receipts",
      personIds: ["person"],
    });
    vi.spyOn(mail, "sync").mockImplementationOnce(async function* () {
      yield { kind: "email", op: "upsert", email: oldRaw };
      yield { kind: "cursor", cursor: "backfilled" };
    });
    // A null-cursor backfill is additive even if a previous message is omitted.
    await service.backfill(account.id, 90);
    const old = (await store.emails.getByProviderId(account.id, "old"))!;
    expect((await store.emails.get(recent.id))!.keywords.$deleted).toBeUndefined();
    expect(await store.emails.get(recent.id)).toMatchObject({
      category: "receipts",
      personIds: ["person"],
    });
    vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));
    vi.spyOn(mail, "sync")
      .mockImplementationOnce(async function* () {
        throw Object.assign(new Error("expired"), { code: "CURSOR_EXPIRED" });
      })
      .mockImplementationOnce(async function* (
        cursor: string | null,
        options?: { since?: string },
      ): AsyncIterable<SyncDelta> {
        expect(cursor).toBeNull();
        expect(options?.since).toBe("2026-01-01T12:00:00.000Z");
        yield { kind: "cursor", cursor: "recovered" };
      });
    await service.syncAccount(account.id);
    expect((await store.emails.get(old.id))!.keywords.$deleted).toBeUndefined();
    expect(await store.emails.get(recent.id)).toMatchObject({
      keywords: { $deleted: true },
      category: "receipts",
      personIds: ["person"],
    });
  });
  it("applies jitter within the exponential retry window", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const jittered = new AccountSyncService(
      store,
      bus,
      async () => mail,
      async () => {
        throw new Error();
      },
      {},
      { sleep, random: () => 0.9 },
    );
    vi.spyOn(mail, "sync").mockImplementation(async function* () {
      throw Object.assign(new Error(), { status: 429, code: "RATE_LIMITED" });
    });
    await expect(jittered.syncAccount(account.id)).rejects.toThrow();
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1400, 2800, 5600, 11200, 22400]);
  });
  it("restores the previous incremental cursor when a backfill fails", async () => {
    vi.spyOn(mail, "sync").mockImplementation(async function* () {
      yield { kind: "cursor", cursor: "existing" };
    });
    await service.syncAccount(account.id);
    const before = await store.syncState.get(account.id);
    vi.spyOn(mail, "sync").mockImplementation(async function* () {
      throw Object.assign(new Error(), { code: "NETWORK_ERROR" });
    });
    await expect(service.backfill(account.id, 365)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    expect(await store.syncState.get(account.id)).toEqual(before);
  });
});
