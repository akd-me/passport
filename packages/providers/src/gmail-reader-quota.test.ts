import { describe, expect, it } from "vitest";
import { RateLimitedError } from "./errors.js";
import type { GmailMessage } from "./gmail-reader-normalize.js";
import { connectedReader, meta, type Route } from "./gmail-reader-testkit.js";
import { QuotaGovernor } from "./quota.js";
import { ManualClock } from "./quota-clock.js";
import { response } from "./test/helpers.js";

/** `n` messages listed newest first; `threads` answers `threads.get` with one message each. */
function inbox(n: number): Route {
  const ids = Array.from({ length: n }, (_, i) => `m${i}`);
  const messages = new Map<string, GmailMessage>(ids.map((id) => [id, meta(id)]));
  return (url) => {
    const path = url.pathname.replace("/gmail/v1/users/me/", "");
    if (path === "messages" || path === "threads") {
      const key = path === "messages" ? "messages" : "threads";
      return response({ [key]: ids.map((id) => ({ id })), resultSizeEstimate: n });
    }
    if (path === "labels") {
      return response({ labels: [] });
    }
    const thread = /^threads\/(.+)$/.exec(path)?.[1];
    if (thread) {
      return response({ id: thread, messages: [messages.get(thread)] });
    }
    const id = /^messages\/(.+)$/.exec(path)?.[1] ?? "";
    return messages.has(id) ? response(messages.get(id)) : response({}, 404);
  };
}

async function governed() {
  const clock = new ManualClock();
  const governor = new QuotaGovernor({ clock });
  governor.configure("account-1", "gmail");
  return { clock, governor };
}

describe("Gmail interactive search within the quota window", () => {
  it("R1-1: limit 100 on a full bucket returns the hydrated rows and resumes the rest", async () => {
    const { clock, governor } = await governed();
    const { reader, calls } = await connectedReader(inbox(100), { governor });
    const first = await reader.search({ query: "", limit: 100 });
    // list 5 + one 50-part batch (1,000); the second batch would need 5.05 s, so it is not sent.
    expect(first.items).toHaveLength(50);
    expect(first.cost.gmailUnits).toBe(1_005);
    expect(first.translation).toMatch(/^gmail:partial .*50 of 100 rows/);
    expect(first.nextPageToken).toBeDefined();
    expect(governor.snapshot("account-1").budgetRemaining).toBe(495);

    await clock.advance(6_000);
    const listed = calls.filter((c) => c.startsWith("GET messages?")).length;
    const second = await reader.search({ query: "", limit: 100, pageToken: first.nextPageToken });
    // The token carries the 50 unhydrated ids: no second list call, no duplicate rows.
    expect(calls.filter((c) => c.startsWith("GET messages?"))).toHaveLength(listed);
    expect(second.items.map((r) => r.subject)).toEqual(
      Array.from({ length: 50 }, (_, i) => `Subject m${i + 50}`),
    );
    expect(second.cost.gmailUnits).toBe(1_000);
    expect(second.nextPageToken).toBeUndefined();
    expect(new Set([...first.items, ...second.items].map((r) => r.id)).size).toBe(100);
  });

  it("R1-1: threads search splits threads.get batches and never runs the bucket into debt", async () => {
    const { governor } = await governed();
    const { reader, batches } = await connectedReader(inbox(60), { governor });
    const result = await reader.search({ query: "", limit: 60, threads: true });
    // 25 × 40 = 1,000 units per batch; the second batch does not fit within 5 s.
    expect(batches).toEqual([25]);
    expect(result.items).toHaveLength(25);
    expect(result.cost.gmailUnits).toBe(10 + 1_000);
    expect(governor.snapshot("account-1").budgetRemaining).toBe(490);
  });

  it("R1-1: a page that hydrated nothing still fails with RateLimitedError", async () => {
    const { governor } = await governed();
    const { reader } = await connectedReader(inbox(100), { governor });
    // 5 + 1,000 + 400 units leave 95: the next page's first batch cannot start within 5 s.
    expect((await reader.search({ query: "", limit: 70 })).items).toHaveLength(70);
    const error = await reader.search({ query: "", limit: 70 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
  });

  it("R1-2: throttled batch parts share one 5 s budget and are charged once", async () => {
    const sleeps: number[] = [];
    const tries = new Map<string, number>();
    const route: Route = (url, init) => {
      const path = url.pathname.replace("/gmail/v1/users/me/", "");
      if (path === "messages") {
        return response({ messages: Array.from({ length: 10 }, (_, i) => ({ id: `m${i}` })) });
      }
      if (path === "labels") {
        return response({ labels: [] });
      }
      const id = /^messages\/(.+)$/.exec(path)?.[1] ?? "";
      // Inner batch parts arrive without headers; direct GETs carry the bearer token.
      if (!init.headers) {
        return response({ error: { errors: [{ reason: "rateLimitExceeded" }] } }, 429);
      }
      const n = (tries.get(id) ?? 0) + 1;
      tries.set(id, n);
      return n === 1 ? response({ error: {} }, 429) : response(meta(id));
    };
    const { reader } = await connectedReader(route, {
      sleep: async (ms) => void sleeps.push(ms),
    });
    const result = await reader.search({ query: "", limit: 10 });
    // Before the fix: 10 rows after 20 s of sleeping, 405 units reported.
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5_000);
    expect(result.items.map((r) => r.subject)).toEqual(["Subject m0", "Subject m1"]);
    expect(result.cost.gmailUnits).toBe(5 + 2 * 20);
    expect(result.nextPageToken).toBeDefined();
  });

  it("R1-20: a malformed id in envelopes() maps to null instead of failing the batch", async () => {
    const route: Route = (url) =>
      url.pathname.endsWith("/messages/bad%20id") || url.pathname.endsWith("/messages/bad id")
        ? response({ error: { code: 400, message: "Invalid id value" } }, 400)
        : response(meta("m1"));
    const { reader } = await connectedReader(route);
    const result = await reader.envelopes(["m1", "bad id"]);
    expect(result.value.get("m1")?.subject).toBe("Subject m1");
    expect(result.value.get("bad id")).toBeNull();
  });
});
