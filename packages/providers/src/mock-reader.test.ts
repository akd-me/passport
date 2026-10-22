import { parseMailHandle } from "@passport/types";
import { describe, expect, it } from "vitest";
import { RateLimitedError } from "./errors.js";
import { type MockMailOptions, MockMailProvider } from "./mock-mail.js";
import { QuotaGovernor } from "./quota.js";
import { ManualClock } from "./quota-clock.js";
import { account } from "./test/helpers.js";

async function connected(options: MockMailOptions = {}) {
  const provider = new MockMailProvider(options);
  await provider.connect(account, {});
  return { provider, reader: provider.reader() };
}

const pid = (handle: string) => parseMailHandle(handle)?.providerId;

describe("MockMailReader.search", () => {
  it("returns compact rows, newest first, priced like Gmail", async () => {
    const { reader } = await connected();
    const result = await reader.search({ query: "from:sam subject:garden", limit: 25 });
    expect(result.items.map((row) => pid(row.id))).toEqual([
      "fixture-22",
      "fixture-21",
      "fixture-20",
      "fixture-19",
    ]);
    expect(result.items[0]).toEqual({
      id: "account-1:email:fixture-22",
      threadId: "account-1:thread:garden",
      rfc822Id: "<fixture-22@mock.passport>",
      account: "account-1",
      date: "2026-01-16T06:00:00.000Z",
      from: "Sam Rivera <sam@example.com>",
      to: ["alex@example.com"],
      subject: "Re: Garden project 4",
      snippet: expect.stringContaining("Thanks Alex!"),
      labels: ["Inbox"],
      unread: false,
      flagged: false,
      attachments: 0,
      auth: "pass",
    });
    expect(result).toMatchObject({ source: "provider", approxTotal: 4, cost: { gmailUnits: 85 } });
    expect(result.nextPageToken).toBeUndefined();
  });

  it("pages with opaque tokens bound to the query", async () => {
    const { reader } = await connected();
    const seen: string[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const page = await reader.search({ limit: 15, ...(pageToken ? { pageToken } : {}) });
      seen.push(...page.items.map((row) => row.id));
      pageToken = page.nextPageToken;
      pages++;
    } while (pageToken);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(40);
    const first = await reader.search({ query: "is:unread", limit: 5 });
    await expect(
      reader.search({ query: "is:read", limit: 5, pageToken: first.nextPageToken ?? "" }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(reader.search({ limit: 5, pageToken: "garbage" })).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
    await expect(reader.list(null, {}, 5, first.nextPageToken)).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
  });

  it("collapses threads and prices threads.list + threads.get", async () => {
    const { reader } = await connected();
    const result = await reader.search({ query: "from:sam", limit: 100, threads: true });
    // 4 garden replies + 4 scheduling messages + 3 invitations collapse to 2 + 3 threads.
    expect(result.items).toHaveLength(5);
    expect(result.cost.gmailUnits).toBe(10 + 5 * 40);
  });

  it("hides Spam and Trash unless asked for or explicitly scoped", async () => {
    const { provider, reader } = await connected();
    await provider.applyChanges([{ op: "delete", providerIds: ["fixture-01"] }]);
    const count = async (input: Parameters<typeof reader.search>[0]) =>
      (await reader.search(input)).approxTotal;
    expect(await count({ query: '"Systems Weekly"', limit: 1 })).toBe(9);
    expect(await count({ query: '"Systems Weekly"', limit: 1, includeSpamTrash: true })).toBe(10);
    expect(await count({ query: "in:trash", limit: 1 })).toBe(1);
    expect(await count({ query: "in:anywhere", limit: 1 })).toBe(40);
    expect(await count({ container: "Trash", limit: 1 })).toBe(1);
  });

  it("supports the portable operators against the fixture clock", async () => {
    const { provider, reader } = await connected();
    const total = async (query: string) => (await reader.search({ query, limit: 1 })).approxTotal;
    expect(await total("in:inbox")).toBe(22);
    expect(await total("label:Receipts is:unread")).toBe(6);
    // Three invites plus the fixture-11 receipt PDF.
    expect(await total("has:attachment")).toBe(4);
    expect(await total("after:2026-01-16 before:2026-01-17")).toBe(24);
    expect(await total("newer_than:1d")).toBe(24);
    provider.setNow("2026-01-16T09:00:00Z");
    expect(await total("newer_than:1d")).toBe(40);
    expect(await total('"usual room" OR subject:"Build 312"')).toBe(2);
    expect(
      (await reader.search({ rawQuery: "from:billing@shop.example", limit: 1 })).approxTotal,
    ).toBe(8);
    await expect(reader.search({ query: "a", rawQuery: "b", limit: 1 })).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
    await expect(reader.search({ query: "category:social", limit: 1 })).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
  });
});

describe("MockMailReader.list and labels", () => {
  it("lists a container by role, name or handle with structural filters", async () => {
    const { reader } = await connected();
    expect((await reader.list("inbox", {}, 5)).approxTotal).toBe(22);
    expect((await reader.list("NEWSLETTERS", {}, 5)).approxTotal).toBe(10);
    expect((await reader.list("account-1:mailbox:Receipts", {}, 5)).approxTotal).toBe(8);
    const filtered = await reader.list("Receipts", { fromDomain: "shop.example", unread: true }, 3);
    expect(filtered.items).toHaveLength(3);
    expect(filtered.items.every((row) => row.unread && row.labels[0] === "Receipts")).toBe(true);
    expect(filtered).toMatchObject({ approxTotal: 6, cost: { gmailUnits: 5 + 3 * 20 } });
    expect(filtered.nextPageToken).toBeDefined();
    expect((await reader.list(null, { hasAttachment: true, unread: false }, 5)).approxTotal).toBe(
      1,
    );
    await expect(reader.list("Nowhere", {}, 5)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lists labels with roles, and counts only when asked", async () => {
    const { reader } = await connected();
    const plain = await reader.labels();
    expect(plain.items[0]).toEqual({ id: "Inbox", name: "Inbox", role: "inbox" });
    expect(plain.items.find((l) => l.name === "Receipts")?.role).toBeNull();
    expect(plain.cost.gmailUnits).toBe(1);
    const counted = await reader.labels(true);
    expect(counted.items[0]?.counts).toEqual({ total: 22, unread: 14 });
    expect(counted.cost.gmailUnits).toBe(1 + 8);
  });
});

describe("MockMailReader reads", () => {
  it("returns envelopes without bodies and null for unknown ids", async () => {
    const { reader } = await connected();
    const result = await reader.envelopes(["fixture-01", "missing"]);
    const envelope = result.value.get("fixture-01");
    expect(envelope).toMatchObject({ subject: "Systems Weekly #101" });
    expect(envelope && "textBody" in envelope).toBe(false);
    expect(result.value.get("missing")).toBeNull();
    expect(result.cost.gmailUnits).toBe(40);
  });

  it("reads a thread chronologically in text or html", async () => {
    const { reader } = await connected();
    const text = await reader.thread("garden", { format: "text" });
    expect(text.value.map((e) => e.providerId)).toEqual([
      "fixture-19",
      "fixture-20",
      "fixture-21",
      "fixture-22",
    ]);
    expect(text.value[0]).toMatchObject({ htmlBody: null, textBody: expect.any(String) });
    expect(text.cost.gmailUnits).toBe(120);
    const html = await reader.thread("garden", { format: "html" });
    expect(html.value[0]?.htmlBody).toContain("<p>");
    await expect(reader.thread("nope", { format: "text" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("reads one body with its attachment manifest", async () => {
    const { reader } = await connected();
    const result = await reader.body("fixture-36");
    expect(result.value.attachments).toEqual([expect.objectContaining({ name: "invite.ics" })]);
    expect(result.value.textBody).toContain("design review");
    expect(result.cost.gmailUnits).toBe(60);
    await expect(reader.body("missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("counts ids up to a cap", async () => {
    const { reader } = await connected();
    expect((await reader.countIds("from:@weekly.example", 1_000)).value).toEqual({
      count: 10,
      capped: false,
    });
    const capped = await reader.countIds("", 5);
    expect(capped.value).toEqual({ count: 5, capped: true });
    expect(capped.cost.gmailUnits).toBe(5);
  });

  it("re-finds a message by Message-ID, preferring the received copy", async () => {
    const { provider, reader } = await connected();
    const original = (await reader.envelopes(["fixture-05"])).value.get("fixture-05");
    if (!original) {
      throw new Error("fixture-05 is missing");
    }
    provider.injectEmail({
      providerId: "sent-copy",
      headers: { ...original.headers },
      mailboxIds: ["account-1:mailbox:Sent"],
      receivedAt: "2026-01-16T00:00:00.000Z",
    });
    expect((await reader.findByRfc822("<fixture-05@mock.passport>")).value).toBe("fixture-05");
    expect((await reader.findByRfc822("fixture-05@mock.passport")).value).toBe("fixture-05");
    const missing = await reader.findByRfc822("<nope@x>");
    expect(missing).toMatchObject({ value: null, cost: { gmailUnits: 5 } });
  });
});

describe("MockMailReader.changes", () => {
  it("starts at now and classifies arrivals, label changes and deletions", async () => {
    const { provider, reader } = await connected();
    const start = await reader.changes(null, 50);
    expect(start.value).toMatchObject({ added: [], labelChanged: [], deleted: [] });
    expect(start.cost.gmailUnits).toBe(2);
    provider.injectEmail({ providerId: "new-1" });
    await provider.applyChanges([
      { op: "setKeywords", providerIds: ["fixture-02"], add: ["$seen"] },
    ]);
    const draft = await provider.createDraft({
      accountId: account.id,
      to: [{ email: "sam@example.com" }],
      subject: "Draft",
      textBody: "x",
    });
    await provider.deleteDraft(draft.providerId);
    const next = await reader.changes(start.value.cursor, 50);
    expect(next.value).toEqual({
      added: ["new-1"],
      labelChanged: ["fixture-02"],
      deleted: [draft.providerId],
      cursor: expect.any(String),
    });
    const idle = await reader.changes(next.value.cursor, 50);
    expect(idle.value).toMatchObject({ added: [], labelChanged: [], deleted: [] });
  });

  it("pages large change sets with hasMore", async () => {
    const { provider, reader } = await connected();
    const start = await reader.changes(null, 2);
    for (const id of ["a", "b", "c"]) {
      provider.injectEmail({ providerId: id });
    }
    const first = await reader.changes(start.value.cursor, 2);
    expect(first.value).toMatchObject({ added: ["a", "b"], hasMore: true });
    const second = await reader.changes(first.value.cursor, 2);
    expect(second.value.added).toEqual(["c"]);
    expect(second.value.hasMore).toBeUndefined();
  });

  it("expires cursors older than a week on the fixture clock", async () => {
    const { provider, reader } = await connected();
    const start = await reader.changes(null, 10);
    provider.injectEmail({ providerId: "late" });
    provider.setNow("2026-01-25T02:00:00Z");
    const expired = await reader.changes(start.value.cursor, 10);
    expect(expired.value).toMatchObject({ expired: true, added: [] });
    provider.injectEmail({ providerId: "later" });
    expect((await reader.changes(expired.value.cursor, 10)).value.added).toEqual(["later"]);
    await expect(reader.changes("garbage", 10)).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    const other = new MockMailProvider();
    await other.connect({ ...account, id: "account-2" }, {});
    await expect(other.reader().changes(start.value.cursor, 10)).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
  });
});

describe("MockMailReader cost accounting", () => {
  it("records every priced call with its lane", async () => {
    const { reader } = await connected();
    await reader.labels(false, { lane: "background" });
    await reader.body("fixture-01");
    expect(reader.costLog).toEqual([
      { method: "labels", gmailUnits: 1, lane: "background" },
      { method: "body", gmailUnits: 60, lane: "interactive" },
    ]);
    expect(reader.totalUnits).toBe(61);
  });

  it("spends through the governor and surfaces RATE_LIMITED for interactive calls", async () => {
    const clock = new ManualClock(Date.parse("2026-10-22T12:00:00Z"));
    const governor = new QuotaGovernor({ clock });
    governor.configure(account.id, "gmail");
    const { reader } = await connected({ governor });
    const body = await reader.body("fixture-01");
    expect(body.cost).toEqual({
      gmailUnits: 60,
      budgetRemaining: 1_440,
      windowResetsAt: "2026-10-22T12:00:00.600Z",
    });
    governor.report(account.id, { retryAfterSeconds: 30 });
    const error = await reader.thread("garden", { format: "text" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({ retryAfterSeconds: 32, scope: "gmail:user-quota" });
    // Background reads wait out the block instead.
    const labels = reader.labels(false, { lane: "background" });
    await clock.advance(30_010);
    await expect(labels).resolves.toMatchObject({ cost: { gmailUnits: 1, budgetRemaining: 0 } });
    expect(reader.costLog.map((entry) => entry.method)).toEqual(["body", "labels"]);
  });

  it("requires a connected provider", async () => {
    const provider = new MockMailProvider();
    await expect(provider.reader().labels()).rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });
});
