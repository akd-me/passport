import { describe, expect, it, vi } from "vitest";
import { availability, expandRecurringEvents } from "./availability.js";
import { createToolRegistry } from "./index.js";
import { MemoryBus, MemoryExecutor, MemoryPolicy, MemoryStore } from "./testing/fakes.js";
import { account, event } from "./testing/fixtures.js";

const range = { start: "2026-10-19T09:00:00.000Z", end: "2026-10-23T11:00:00.000Z" };
const weekly = event({
  id: "series",
  providerId: "provider-series",
  start: "2026-09-28T09:00:00.000Z",
  end: "2026-09-28T10:00:00.000Z",
  recurrenceRule: "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261021T090000Z",
});

describe("availability review regressions", () => {
  it("T8 reads the complete requested range beyond 50 old events and prefers live connected accounts", async () => {
    const store = new MemoryStore();
    await store.accounts.upsert(
      account({ capabilities: { ...account().capabilities, calendar: true } }),
    );
    await store.events.upsertMany([
      ...Array.from({ length: 60 }, (_, i) =>
        event({ id: `old-${i}`, start: "2025-01-01T09:00:00Z", end: "2025-01-01T10:00:00Z" }),
      ),
      event({ id: "recent", start: range.start, end: "2026-10-19T10:00:00.000Z" }),
    ]);
    const query = vi.spyOn(store.events, "query");
    expect((await availability(store, range)).busy).toHaveLength(1);
    expect(query).toHaveBeenCalledWith({
      range,
      accountId: undefined,
      includeRecurring: true,
      limit: 2_147_483_647,
    });
    const providerBusy = [{ start: "2026-10-20T09:00:00.000Z", end: "2026-10-20T10:00:00.000Z" }];
    const freeBusy = vi.fn(async () => providerBusy);
    expect(await availability(store, range, { freeBusy })).toEqual({
      busy: providerBusy,
      source: "provider",
    });
    expect(freeBusy).toHaveBeenCalledWith("account-1", range);
    expect((await availability(store, range, { freeBusy: async () => null })).source).toBe(
      "local_store",
    );
  });

  it("T9 expands weekly BYDAY/UNTIL masters before the window and find_free_slots excludes occurrences", async () => {
    const store = new MemoryStore(),
      policy = new MemoryPolicy(),
      bus = new MemoryBus();
    await store.events.upsertMany([weekly]);
    expect(expandRecurringEvents([weekly], range).map((item) => item.start)).toEqual([
      "2026-10-19T09:00:00.000Z",
      "2026-10-21T09:00:00.000Z",
    ]);
    const tools = createToolRegistry({
      store,
      executor: new MemoryExecutor(store, policy),
      policy,
      bus,
      selfAddresses: [],
      actor: { kind: "agent", id: "test" },
    });
    const result = await tools
      .find((tool) => tool.name === "find_free_slots")!
      .handler({
        durationMinutes: 60,
        window: range,
        workingHours: { start: "09:00", end: "10:00", days: [1, 3, 5] },
      });
    expect(result.slots).toEqual([
      { start: "2026-10-23T09:00:00.000Z", end: "2026-10-23T10:00:00.000Z" },
    ]);
  });

  it("T9 handles daily INTERVAL/COUNT and monthly BYDAY and skips invalid month dates", () => {
    const daily = event({
      start: "2026-10-01T09:00:00.000Z",
      end: "2026-10-01T10:00:00.000Z",
      recurrenceRule: "FREQ=DAILY;INTERVAL=2;COUNT=3",
    });
    const window = { start: "2026-10-03T00:00:00.000Z", end: "2026-10-10T00:00:00.000Z" };
    expect(expandRecurringEvents([daily], window).map((item) => item.start)).toEqual([
      "2026-10-03T09:00:00.000Z",
      "2026-10-05T09:00:00.000Z",
    ]);
    const monthly = {
      ...daily,
      start: "2026-01-31T09:00:00.000Z",
      end: "2026-01-31T10:00:00.000Z",
      recurrenceRule: "FREQ=MONTHLY;COUNT=3",
    };
    const months = { start: "2026-01-01T00:00:00.000Z", end: "2026-06-01T00:00:00.000Z" };
    expect(expandRecurringEvents([monthly], months).map((item) => item.start)).toEqual([
      "2026-01-31T09:00:00.000Z",
      "2026-03-31T09:00:00.000Z",
      "2026-05-31T09:00:00.000Z",
    ]);
    expect(
      expandRecurringEvents(
        [
          {
            ...monthly,
            start: "2026-01-05T09:00:00.000Z",
            end: "2026-01-05T10:00:00.000Z",
            recurrenceRule: "FREQ=MONTHLY;BYDAY=1MO;INTERVAL=2;COUNT=2",
          },
        ],
        months,
      ).map((item) => item.start),
    ).toEqual(["2026-01-05T09:00:00.000Z", "2026-03-02T09:00:00.000Z"]);
  });

  it("T9 honours provider-exposed cancelled and moved instances", () => {
    const cancelled = event({
      id: "cancelled",
      recurringEventId: weekly.providerId,
      originalStart: "2026-10-19T09:00:00.000Z",
      start: "2026-10-19T09:00:00.000Z",
      status: "cancelled",
    });
    const moved = event({
      id: "moved",
      recurringEventId: weekly.providerId,
      originalStart: "2026-10-21T09:00:00.000Z",
      start: "2026-10-22T10:00:00.000Z",
      end: "2026-10-22T11:00:00.000Z",
    });
    expect(
      expandRecurringEvents([weekly, cancelled, moved], range).map((item) => item.start),
    ).toEqual([moved.start]);
  });

  it("T9 fails closed on unsupported recurrence instead of proposing occupied slots", () => {
    expect(() =>
      expandRecurringEvents([{ ...weekly, recurrenceRule: "FREQ=YEARLY" }], range),
    ).toThrow(expect.objectContaining({ code: "UNSUPPORTED_RECURRENCE" }));
  });
});

it("T9 preserves weekly wall time through daylight-saving changes", () => {
  const series = event({
    start: "2026-10-26T13:00:00.000Z",
    end: "2026-10-26T14:00:00.000Z",
    timeZone: "America/New_York",
    recurrenceRule: "FREQ=WEEKLY;BYDAY=MO;COUNT=3",
  });
  expect(
    expandRecurringEvents([series], {
      start: "2026-10-26T00:00:00.000Z",
      end: "2026-11-10T00:00:00.000Z",
    }).map((item) => item.start),
  ).toEqual(["2026-10-26T13:00:00.000Z", "2026-11-02T14:00:00.000Z", "2026-11-09T14:00:00.000Z"]);
});

it("T9 an instance moved outside the window still suppresses its original occurrence", async () => {
  const store = new MemoryStore();
  const moved = event({
    id: "moved-outside",
    recurringEventId: weekly.providerId,
    originalStart: "2026-10-19T09:00:00.000Z",
    start: "2026-11-01T09:00:00.000Z",
    end: "2026-11-01T10:00:00.000Z",
  });
  await store.events.upsertMany([weekly, moved]);
  expect((await availability(store, range)).busy).toEqual([
    { start: "2026-10-21T09:00:00.000Z", end: "2026-10-21T10:00:00.000Z" },
  ]);
});
