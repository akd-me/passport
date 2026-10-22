import { MockCalendarProvider, MockMailProvider, mockCapabilities } from "@passport/providers";
import { InMemoryEventBus, openStore } from "@passport/store";
import type { Account, CalendarProvider, DomainEvent, Store } from "@passport/types";

type CalendarDelta =
  ReturnType<CalendarProvider["sync"]> extends AsyncIterable<infer T> ? T : never;
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSyncService } from "./sync.js";

describe("account calendar sync lifecycle", () => {
  let store: Store,
    mail: MockMailProvider,
    calendar: MockCalendarProvider,
    bus: InMemoryEventBus,
    service: AccountSyncService,
    events: DomainEvent[];
  const account: Account = {
    id: "test",
    kind: "mock",
    displayName: "Test",
    emailAddress: "alex@example.com",
    capabilities: { ...mockCapabilities, mail: false, push: false },
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
    calendar = new MockCalendarProvider();
    await calendar.connect(account, {});
    bus = new InMemoryEventBus();
    events = [];
    bus.onAny((e) => events.push(e));
    service = new AccountSyncService(
      store,
      bus,
      async () => mail,
      async () => calendar,
      {
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        random: () => 0.5,
      },
    );
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await calendar.disconnect();
    await store.close();
  });
  it.each([429, 503])(
    "retries HTTP %s with exponential backoff and stops after five retries",
    async (status) => {
      const sync = vi.spyOn(calendar, "sync").mockImplementation(async function* () {
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
    vi.spyOn(calendar, "sync").mockImplementation(async function* (): AsyncIterable<CalendarDelta> {
      if (calls++ === 0) {
        throw Object.assign(new Error(), { status: 503, code: "HTTP_503" });
      }
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
    const sync = vi.spyOn(calendar, "sync").mockImplementation(async function* () {
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
  it("skips accounts without a calendar: mail is watched, not synced", async () => {
    const sync = vi.spyOn(calendar, "sync");
    await store.accounts.upsert({ ...account, id: "mail", capabilities: mockCapabilities });
    await store.accounts.upsert({
      ...account,
      id: "mail-only",
      capabilities: { ...mockCapabilities, calendar: false },
    });
    await service.syncAccount("mail-only");
    expect(sync).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === "account.sync.started")).toHaveLength(0);
    expect("backfill" in service).toBe(false);
  });
  it("applies jitter within the exponential retry window", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const jittered = new AccountSyncService(
      store,
      bus,
      async () => mail,
      async () => calendar,
      { sleep, random: () => 0.9 },
    );
    vi.spyOn(calendar, "sync").mockImplementation(async function* () {
      throw Object.assign(new Error(), { status: 429, code: "RATE_LIMITED" });
    });
    await expect(jittered.syncAccount(account.id)).rejects.toThrow();
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1400, 2800, 5600, 11200, 22400]);
  });
});
