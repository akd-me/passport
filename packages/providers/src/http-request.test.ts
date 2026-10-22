import { describe, expect, it } from "vitest";
import { RateLimitedError } from "./errors.js";
import { request, waitBudget } from "./http-request.js";
import { FakeGraph, message } from "./test/graph-reader-fake.js";
import { response } from "./test/helpers.js";

describe("request() timeouts, cancellation and replay", () => {
  it("R1-8: the caller's signal is combined with a per-attempt network timeout", async () => {
    const seen: AbortSignal[] = [];
    const controller = new AbortController();
    const fetcher = (async (_url: string, init: RequestInit) => {
      seen.push(init.signal as AbortSignal);
      return response({ ok: true });
    }) as unknown as typeof fetch;
    await request(fetcher, "https://example.test/", { signal: controller.signal });
    await request(fetcher, "https://example.test/");
    // Before the fix the caller's signal replaced the timeout (no timeout at all).
    expect(seen[0]).not.toBe(controller.signal);
    expect(seen[0]?.aborted).toBe(false);
    controller.abort();
    expect(seen[0]?.aborted).toBe(true);
    expect(seen[1]).toBeInstanceOf(AbortSignal);
  });

  it("R1-8: an abort during the retry sleep rejects at once with ABORTED", async () => {
    const controller = new AbortController();
    const fetcher = (async () => response({}, 429)) as unknown as typeof fetch;
    const never = () => new Promise<void>(() => {});
    const pending = request(fetcher, "https://example.test/", { signal: controller.signal }, never);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("R1-8: a fetch aborted by the caller is ABORTED, not NETWORK_ERROR", async () => {
    const controller = new AbortController();
    const fetcher = (async (_url: string, init: RequestInit) => {
      controller.abort();
      throw init.signal?.reason ?? new Error("aborted");
    }) as unknown as typeof fetch;
    await expect(
      request(fetcher, "https://example.test/", { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("R1-14: an idempotent POST is replayed after a 429; other POSTs are not", async () => {
    let calls = 0;
    const fetcher = (async () =>
      ++calls === 1 ? response({}, 429) : response({ ok: true })) as unknown as typeof fetch;
    const sleep = async () => {};
    const ok = await request(fetcher, "https://x.test/", { method: "POST" }, sleep, {
      idempotent: true,
    });
    expect(ok.status).toBe(200);
    expect(calls).toBe(2);
    calls = 0;
    await expect(
      request(fetcher, "https://x.test/", { method: "POST" }, sleep),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(calls).toBe(1);
  });

  it("R1-2: retries draw on a shared budget across requests", async () => {
    const budget = waitBudget("interactive");
    const sleeps: number[] = [];
    let calls = 0;
    const fetcher = (async () =>
      ++calls % 2 === 1 ? response({}, 429) : response({ ok: true })) as unknown as typeof fetch;
    const sleep = async (ms: number) => void sleeps.push(ms);
    const options = { lane: "interactive" as const, budget };
    await request(fetcher, "https://x.test/1", {}, sleep, options);
    await request(fetcher, "https://x.test/2", {}, sleep, options);
    // 2 + 2 s spent; the third request's 2 s backoff no longer fits the 5 s budget.
    await expect(request(fetcher, "https://x.test/3", {}, sleep, options)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(sleeps).toEqual([2_000, 2_000]);
    expect(budget?.remainingMs).toBe(1_000);
  });

  it("R1-2: Graph $batch chunks of one call share the 5 s interactive budget", async () => {
    const graph = new FakeGraph();
    const attempts = new Map<string, number>();
    graph.routes.push((url, request) => {
      const id = /\/me\/messages\/([^/]+)$/.exec(url.pathname)?.[1];
      if (!id || !request.batch) {
        return undefined;
      }
      const n = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, n);
      return n === 1
        ? { status: 429, headers: { "Retry-After": "3" } }
        : { status: 200, body: message(id) };
    });
    const reader = await graph.connect();
    const ids = Array.from({ length: 40 }, (_, i) => `m${i}`);
    const error = await reader.envelopes(ids).catch((e: unknown) => e);
    // Before the fix each 20-request chunk had its own 5 s budget: 6 s of sleeping in one call.
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(graph.sleeps).toEqual([3_000]);
  });
});
