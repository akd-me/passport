import type { QuotaLane } from "@passport/types";
import { describe, expect, it } from "vitest";
import { RateLimitedError } from "./errors.js";
import { HttpConnection, type ProviderOptions, type RequestPolicy } from "./http.js";
import { QuotaGovernor } from "./quota.js";
import { ManualClock } from "./quota-clock.js";
import { account, fixtureFetch, response } from "./test/helpers.js";

/** Exposes the protected request helper; Google OAuth gives the Gmail rate-limit scope. */
class Probe extends HttpConnection {
  constructor(options: ProviderOptions) {
    super(options, "google");
  }
  get(policy: RequestPolicy = {}, method = "GET"): Promise<{ ok: boolean }> {
    return this.json("https://gmail.googleapis.com/probe", { method }, policy);
  }
}

const quota = { error: { errors: [{ reason: "rateLimitExceeded" }] } };

async function probe(handler: () => Response, extra: Partial<ProviderOptions> = {}) {
  const waits: number[] = [];
  const fetcher = fixtureFetch(handler);
  const p = new Probe({
    fetch: fetcher,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...extra,
  });
  await p.connect(account, { access_token: "token" });
  return { p, waits, fetcher };
}

describe("lane-aware retries", () => {
  it("keeps the 2/4/8/16/32 s schedule when no lane is given", async () => {
    const { p, waits, fetcher } = await probe(() => response(quota, 403));
    await expect(p.get()).rejects.toMatchObject({ code: "RATE_LIMITED", status: 403 });
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it.each<QuotaLane>(["arrivals", "background"])("keeps the long schedule for %s", async (lane) => {
    const { p, waits } = await probe(() => response({}, 429));
    await expect(p.get({ lane })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
  });

  it("retries interactive reads only within 5 s, then throws RateLimitedError", async () => {
    const { p, waits, fetcher } = await probe(() => response(quota, 403));
    const error = await p.get({ lane: "interactive" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSeconds: 4,
      scope: "gmail:user-quota",
      status: 403,
    });
    expect(waits).toEqual([2_000]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("succeeds when an interactive retry fits the budget", async () => {
    let throttled = 1;
    const { p, waits } = await probe(() =>
      throttled-- > 0 ? response({}, 429, { "retry-after": "5" }) : response({ ok: true }),
    );
    await expect(p.get({ lane: "interactive" })).resolves.toEqual({ ok: true });
    expect(waits).toEqual([5_000]);
  });

  it("reports the server's Retry-After when it exceeds the interactive budget", async () => {
    const { p, waits } = await probe(() => response({}, 429, { "retry-after": "24" }));
    await expect(p.get({ lane: "interactive" })).rejects.toMatchObject({
      retryAfterSeconds: 24,
      scope: "gmail:user-quota",
    });
    expect(waits).toEqual([]);
  });

  it("never replays an interactive mutation but still says when to retry", async () => {
    const { p, fetcher } = await probe(() => response({}, 429, { "retry-after": "3" }));
    await expect(p.get({ lane: "interactive" }, "POST")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSeconds: 3,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("governed requests", () => {
  function governed(kind: "gmail" | "graph" = "gmail") {
    const clock = new ManualClock(Date.parse("2026-10-22T12:00:00Z"));
    const governor = new QuotaGovernor({ clock });
    governor.configure(account.id, kind);
    return governor;
  }

  it("acquires the declared cost and leaves undeclared calls ungoverned", async () => {
    const governor = governed();
    const { p } = await probe(() => response({ ok: true }), { governor });
    await p.get({ lane: "interactive", cost: 120 });
    expect(governor.snapshot(account.id).budgetRemaining).toBe(1_380);
    await p.get();
    expect(governor.snapshot(account.id).budgetRemaining).toBe(1_380);
  });

  it("reports 429s so later interactive calls fail fast without a request", async () => {
    const governor = governed();
    const { p, fetcher } = await probe(() => response({}, 429, { "retry-after": "30" }), {
      governor,
    });
    await expect(p.get({ lane: "interactive", cost: 5 })).rejects.toMatchObject({
      retryAfterSeconds: 30,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(p.get({ lane: "interactive", cost: 5 })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      scope: "gmail:user-quota",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("slows down when Graph reports its throttle percentage", async () => {
    const governor = governed("graph");
    const { p } = await probe(
      () => response({ ok: true }, 200, { "x-ms-throttle-limit-percentage": "0.95" }),
      { governor },
    );
    await p.get({ lane: "background", cost: 1 });
    expect(governor.snapshot(account.id).budgetRemaining).toBe(12);
  });
});
