import { describe, expect, it } from "vitest";
import { RateLimitedError } from "./errors.js";
import { GMAIL_UNIT_COSTS, type QuotaConfig, QuotaGovernor, type QuotaLease } from "./quota.js";
import { ManualClock } from "./quota-clock.js";

const start = Date.parse("2026-10-22T12:00:00Z");

function setup(limits: Parameters<QuotaGovernor["configure"]>[1] = "gmail") {
  const clock = new ManualClock(start);
  const governor = new QuotaGovernor({ clock });
  governor.configure("acc", limits);
  return { clock, governor };
}

/** Records when a pending acquire settles, without awaiting it. */
function track(promise: Promise<QuotaLease>) {
  const state: { lease?: QuotaLease; error?: unknown } = {};
  promise.then(
    (lease) => {
      state.lease = lease;
    },
    (error: unknown) => {
      state.error = error;
    },
  );
  return state;
}

const small: QuotaConfig = {
  capacity: 100,
  refillPerSecond: 10,
  maxInFlight: Infinity,
  scope: "passport:governor",
};

describe("GMAIL_UNIT_COSTS", () => {
  it("matches the published Gmail quota table", () => {
    expect(GMAIL_UNIT_COSTS).toMatchObject({
      messagesGetMetadata: 20,
      messagesGetFull: 60,
      threadsGetMetadata: 40,
      threadsGetFull: 120,
      messagesList: 5,
      historyList: 2,
      batchModify: 50,
      messagesSend: 100,
      labelsList: 1,
      draftsCreate: 10,
      draftsUpdate: 15,
      attachmentsGet: 20,
      messagesModify: 5,
      messagesTrash: 20,
      getProfile: 1,
    });
  });
});

describe("QuotaGovernor", () => {
  it("grants a Gmail burst immediately and refills at 100 units/s", async () => {
    const { clock, governor } = setup();
    const burst = await governor.acquire("acc", "interactive", 1_500);
    burst.release();
    expect(governor.snapshot("acc")).toEqual({
      budgetRemaining: 0,
      windowResetsAt: new Date(start + 15_000).toISOString(),
    });
    const next = track(governor.acquire("acc", "interactive", 100));
    await clock.advance(999);
    expect(next.lease).toBeUndefined();
    await clock.advance(1);
    expect(next.lease).toMatchObject({ lane: "interactive", cost: 100, waitedMs: 1_000 });
    expect(governor.snapshot("acc").budgetRemaining).toBe(0);
    await clock.advance(2_500);
    expect(governor.snapshot("acc").budgetRemaining).toBe(250);
  });

  it("refuses interactive waits over 5 s with a structured RATE_LIMITED error", async () => {
    const { governor } = setup();
    (await governor.acquire("acc", "background", 1_500)).release();
    const error = await governor.acquire("acc", "interactive", 600).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSeconds: 6,
      scope: "gmail:user-quota",
    });
    // Background lanes wait instead; an explicit maxWaitMs bounds them too.
    const background = track(governor.acquire("acc", "background", 600));
    await expect(
      governor.acquire("acc", "arrivals", 600, { maxWaitMs: 1_000 }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(background.error).toBeUndefined();
  });

  it("gives other lanes at most 30% of the refill while interactive waits", async () => {
    const { clock, governor } = setup(small);
    (await governor.acquire("acc", "background", 100)).release();
    const interactive = track(governor.acquire("acc", "interactive", 100, { maxWaitMs: 60_000 }));
    const background = track(governor.acquire("acc", "background", 3));
    const later = track(governor.acquire("acc", "background", 3));
    await clock.advance(999);
    expect(background.lease).toBeUndefined();
    await clock.advance(1); // 10 units refilled, 3 of them are background's share
    expect(background.lease).toMatchObject({ waitedMs: 1_000 });
    await clock.advance(1_000);
    expect(later.lease).toMatchObject({ waitedMs: 2_000 });
    // Interactive got the other 14 of 20 units and needs 86 more at 10/s.
    await clock.advance(8_599);
    expect(interactive.lease).toBeUndefined();
    await clock.advance(1);
    expect(interactive.lease).toMatchObject({ waitedMs: 10_600 });
  });

  it("serves interactive first when it fits and background never dips into its share", async () => {
    const { clock, governor } = setup(small);
    (await governor.acquire("acc", "interactive", 10)).release(); // 90 left
    const interactive = track(governor.acquire("acc", "interactive", 95));
    const background = track(governor.acquire("acc", "background", 10));
    await clock.advance(0);
    expect(background.lease).toBeUndefined(); // no share credit accrued yet
    await clock.advance(500);
    expect(interactive.lease).toBeDefined();
    await clock.advance(999);
    expect(background.lease).toBeUndefined();
    await clock.advance(1); // interactive done: background takes the whole refill
    expect(background.lease).toMatchObject({ waitedMs: 1_500 });
  });

  it("serves arrivals before background and each lane in FIFO order", async () => {
    const { clock, governor } = setup(small);
    (await governor.acquire("acc", "background", 100)).release();
    const order: string[] = [];
    const queue = (lane: "arrivals" | "background", name: string) =>
      governor.acquire("acc", lane, 10).then((lease) => {
        order.push(name);
        lease.release();
      });
    const all = Promise.all([
      queue("background", "b1"),
      queue("arrivals", "a1"),
      queue("background", "b2"),
      queue("arrivals", "a2"),
    ]);
    await clock.advance(4_000);
    await all;
    expect(order).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("caps Graph at 4 in-flight requests per mailbox", async () => {
    const { clock, governor } = setup("graph");
    const leases = await Promise.all(
      [1, 2, 3, 4].map(() => governor.acquire("acc", "interactive", 1)),
    );
    const fifth = track(governor.acquire("acc", "interactive", 1));
    await clock.advance(1_000);
    expect(fifth.lease).toBeUndefined();
    const [first] = leases;
    first?.release();
    first?.release(); // idempotent
    await clock.advance(0);
    expect(fifth.lease).toBeDefined();
    const sixth = track(governor.acquire("acc", "interactive", 1));
    await clock.advance(5_000);
    expect(sixth.error).toMatchObject({ code: "RATE_LIMITED", scope: "graph:mailbox" });
  });

  it("serialises IMAP to one pipeline and reports no unit budget", async () => {
    const { clock, governor } = setup("imap");
    const first = await governor.acquire("acc", "background", 1);
    const second = track(governor.acquire("acc", "background", 1));
    await clock.advance(0);
    expect(second.lease).toBeUndefined();
    first.release();
    await clock.advance(0);
    expect(second.lease).toBeDefined();
    expect(governor.snapshot("acc")).toEqual({});
  });

  it("blocks every lane after a provider Retry-After", async () => {
    const { clock, governor } = setup("graph");
    governor.report("acc", { retryAfterSeconds: 30 });
    expect(governor.snapshot("acc")).toEqual({
      budgetRemaining: 0,
      windowResetsAt: new Date(start + 30_000 + 15_000).toISOString(),
    });
    await expect(governor.acquire("acc", "interactive", 1)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSeconds: 31,
    });
    const background = track(governor.acquire("acc", "background", 1));
    await clock.advance(30_000);
    expect(background.lease).toBeUndefined();
    await clock.advance(60);
    expect(background.lease).toBeDefined();
  });

  it("slows down on Graph's throttle percentage and recovers below 0.9", async () => {
    const { clock, governor } = setup("graph");
    governor.report("acc", { throttlePercentage: 0.95 });
    expect(governor.snapshot("acc").budgetRemaining).toBe(12);
    await clock.advance(6_000); // half speed: 50 requests in 6 s
    expect(governor.snapshot("acc").budgetRemaining).toBe(62);
    governor.report("acc", { throttlePercentage: 0.5 });
    await clock.advance(6_000);
    expect(governor.snapshot("acc").budgetRemaining).toBe(162);
  });

  it("runs an oversized request on a full bucket and carries the debt", async () => {
    const { clock, governor } = setup(small);
    (await governor.acquire("acc", "background", 150)).release();
    expect(governor.snapshot("acc").budgetRemaining).toBe(0);
    await clock.advance(5_000);
    expect(governor.snapshot("acc").budgetRemaining).toBe(0);
    await clock.advance(5_000);
    expect(governor.snapshot("acc").budgetRemaining).toBe(50);
  });

  it("cancels a queued wait when its signal aborts", async () => {
    const { clock, governor } = setup(small);
    (await governor.acquire("acc", "background", 100)).release();
    const controller = new AbortController();
    const waiting = track(governor.acquire("acc", "background", 50, { signal: controller.signal }));
    controller.abort();
    await clock.advance(0);
    expect(waiting.error).toMatchObject({ code: "ABORTED" });
    // The aborted request no longer holds a place in the queue.
    const next = track(governor.acquire("acc", "background", 10));
    await clock.advance(1_000);
    expect(next.lease).toBeDefined();
    await expect(
      governor.acquire("acc", "background", 1, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("requires configuration and ignores reports for unknown accounts", async () => {
    const { governor } = setup();
    await expect(governor.acquire("other", "interactive", 1)).rejects.toMatchObject({
      code: "QUOTA_NOT_CONFIGURED",
    });
    expect(() => governor.report("other", { retryAfterSeconds: 5 })).not.toThrow();
    expect(governor.snapshot("other")).toEqual({});
    await expect(governor.acquire("acc", "interactive", -1)).rejects.toMatchObject({
      code: "INVALID_COST",
    });
  });

  it("rejects queued waiters when an account is removed", async () => {
    const { clock, governor } = setup(small);
    (await governor.acquire("acc", "background", 100)).release();
    const waiting = track(governor.acquire("acc", "background", 50));
    governor.remove("acc");
    await clock.advance(0);
    expect(waiting.error).toMatchObject({ code: "QUOTA_NOT_CONFIGURED" });
    expect(governor.isConfigured("acc")).toBe(false);
    expect(clock.pending).toBe(0);
  });
});
