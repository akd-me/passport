import { afterEach, describe, expect, it } from "vitest";
import { grepLimits } from "./attachments/run-worker.js";
import { limitResponse } from "./response-budget.js";
import { regexRisk } from "./safe-regex.js";
import { onDemandHarness } from "./testing/ondemand.js";

type Row = Record<string, unknown>;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe("R4-6 model-supplied regular expressions", () => {
  const timeout = grepLimits.timeoutMs;
  afterEach(() => {
    grepLimits.timeoutMs = timeout;
  });

  it("R4-6 rejects backtracking-prone patterns before matching", async () => {
    for (const pattern of ["^(a+)+$", "(\\w+\\s?)*$", "(a|aa)*b", "(x)\\1", "(?<n>a)\\k<n>"]) {
      expect(regexRisk(pattern), pattern).not.toBeNull();
    }
    for (const pattern of [
      "invoice #\\d+",
      "^(re|fwd):",
      "(foo|bar)?baz",
      "\\p{L}{2,}",
      "[(+*]+",
    ]) {
      expect(regexRisk(pattern), pattern).toBeNull();
    }
    expect(regexRisk("a".repeat(201))).toMatch(/longer/);
    const { call, provider } = await onDemandHarness();
    provider().injectEmail({ providerId: "g1", textBody: `${"a".repeat(28)}!` });
    const grep = await call("mail_grep", { ids: ["account-1:email:g1"], pattern: "^(a+)+$" });
    expect(grep).toMatchObject({ isError: true, error: "INVALID_INPUT" });
    expect(String(grep.reason)).toMatch(/too complex/);
    const notes = await call("notes_search", { pattern: "^(a+)+$", regex: true });
    expect(notes).toMatchObject({ isError: true, error: "INVALID_INPUT" });
  });

  it("R4-6 stops a slow mail_grep pattern in its worker without blocking the event loop", async () => {
    grepLimits.timeoutMs = 1500;
    const { call, provider } = await onDemandHarness();
    provider().injectEmail({ providerId: "g1", textBody: "a".repeat(1999) });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const started = Date.now();
    const result = await call("mail_grep", {
      ids: ["account-1:email:g1"],
      pattern: "\\w*\\w*\\w*\\w*!",
    });
    clearInterval(timer);
    expect(result).toMatchObject({ isError: true, error: "PATTERN_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(ticks).toBeGreaterThan(10);
    const ok = await call("mail_grep", { ids: ["account-1:email:g1"], pattern: "a{3}" });
    expect(ok).toMatchObject({ matchCount: 1 });
  });
});

describe("R4-16 results over the budget are clipped, not refused", () => {
  it("R4-16 mail_grep drops trailing matches with omittedItems", async () => {
    const { call, provider } = await onDemandHarness({ responseByteBudget: 64 * 1024 });
    const lines = Array.from({ length: 220 }, (_, i) => `hit ${i} ${"y".repeat(480)}`).join("\n");
    provider().injectEmail({ providerId: "g1", textBody: lines });
    const result = await call("mail_grep", {
      ids: ["account-1:email:g1"],
      pattern: "hit",
      context: 5,
      maxMatches: 200,
    });
    expect(result.isError).toBeUndefined();
    expect(size(result)).toBeLessThanOrEqual(64 * 1024);
    const matches = result.matches as Row[];
    expect(matches.length).toBeGreaterThan(1);
    expect(result).toMatchObject({ truncated: true, matchCount: 200 });
    expect(result.omittedItems).toBe(200 - matches.length);
    expect(matches[0]).toMatchObject({ line: 1, before: [], after: expect.any(Array) });
    expect((matches[0]?.text as string).length).toBeGreaterThan(400);
  });

  it("R4-16 provider_get trims long lists and clips an unstructured body", async () => {
    let body: unknown = {
      messages: Array.from({ length: 3000 }, (_, i) => ({ id: `id${i}`, threadId: `t${i}` })),
      resultSizeEstimate: 3000,
    };
    const { call, store } = await onDemandHarness({
      responseByteBudget: 64 * 1024,
      wrapReader: (_id, reader) =>
        Object.assign(Object.create(reader), {
          rawGet: async () => ({
            value: { status: 200, body },
            source: "provider",
            cost: { gmailUnits: 5 },
          }),
        }),
    });
    const account = (await store.accounts.list())[0] as Row;
    await store.accounts.upsert({ ...account, kind: "gmail" } as never);
    const listed = await call("provider_get", { path: "users/me/messages" });
    expect(listed).toMatchObject({
      status: 200,
      truncated: true,
      body: { resultSizeEstimate: 3000 },
    });
    expect(size(listed)).toBeLessThanOrEqual(64 * 1024);
    expect(((listed.body as Row).messages as Row[]).length).toBeGreaterThan(100);
    body = { payload: { body: { data: "A".repeat(200_000) } } };
    const blob = await call("provider_get", { path: "users/me/messages/m1" });
    expect(blob).toMatchObject({ status: 200, body: null, truncated: true });
    expect(blob.totalBytes).toBeGreaterThan(200_000);
    expect(String(blob.bodyText)).toMatch(/^\{"payload"/);
    expect(size(blob)).toBeLessThanOrEqual(64 * 1024);
  });

  it("R4-16 limitResponse shrinks string arrays", () => {
    const limited = limitResponse(
      { matches: [{ before: Array(50).fill("z".repeat(2000)) }] },
      64 * 1024,
    ) as Row;
    expect(size(limited)).toBeLessThanOrEqual(64 * 1024);
    expect((limited.matches as Row[])[0]?.before).toHaveLength(32);
    expect(limited).toMatchObject({ truncated: true, omittedItems: 18 });
  });

  it("R4-15 a second budget pass moves the top-level continueFrom back to the clipped text", () => {
    const first = {
      messages: [{ id: "m", offset: 0, text: '"'.repeat(30_000), continueFrom: 30_000 }],
      truncated: true,
      continueFrom: 30_000,
    };
    const second = limitResponse(first, 32 * 1024) as Row;
    const message = (second.messages as Row[])[0] as Row;
    expect((message.text as string).length).toBeLessThan(30_000);
    expect(second.continueFrom).toBe(message.continueFrom);
    expect(second.continueFrom).toBe((message.text as string).length);
  });
});
