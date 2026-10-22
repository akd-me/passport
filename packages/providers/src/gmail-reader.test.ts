import { describe, expect, it } from "vitest";
import { RateLimitedError } from "./errors.js";
import { GmailMailProvider } from "./gmail.js";
import {
  account,
  connectedReader,
  fakeGmail,
  mailbox,
  meta,
  type Route,
  response,
} from "./gmail-reader-testkit.js";
import { parsePortableQuery } from "./query.js";
import { renderGmailQuery } from "./query-render.js";
import { QuotaGovernor } from "./quota.js";
import { ManualClock } from "./quota-clock.js";

const labels = [
  { id: "INBOX", name: "INBOX" },
  { id: "SENT", name: "SENT" },
  { id: "Label_1", name: "Work" },
  { id: "Label_2", name: "Work/Clients" },
];
const listOf = (ids: string[], extra: Record<string, unknown> = {}): Route =>
  mailbox(
    Object.fromEntries(ids.map((id) => [id, meta(id, { labels: ["INBOX", "UNREAD", "Label_1"] })])),
    labels,
    (url) =>
      url.pathname.endsWith("/messages")
        ? response({ messages: ids.map((id) => ({ id })), resultSizeEstimate: 42, ...extra })
        : response({}, 404),
  );

describe("GmailMailReader.search", () => {
  it("translates portable queries, hydrates rows via the batch endpoint and reports cost", async () => {
    const { reader, calls, batches } = await connectedReader(listOf(["m1", "m2"]));
    const query = 'from:sam@example.com is:flagged after:2026-01-01 subject:"design review"';
    const result = await reader.search({ query, container: "inbox", limit: 10 });
    const list = new URL(`https://x/${calls[0]?.slice(4)}`);
    expect(list.pathname).toBe("/messages");
    expect(list.searchParams.get("q")).toBe(renderGmailQuery(parsePortableQuery(query)));
    expect(list.searchParams.get("q")).toContain("is:starred after:1767225600");
    expect(list.searchParams.get("labelIds")).toBe("INBOX");
    expect(list.searchParams.get("maxResults")).toBe("10");
    expect(list.searchParams.has("includeSpamTrash")).toBe(false);
    expect(batches).toEqual([2]);
    const get = new URL(`https://x/${calls[1]?.slice(4)}`);
    expect(get.searchParams.get("format")).toBe("metadata");
    expect(get.searchParams.getAll("metadataHeaders")).toEqual(
      expect.arrayContaining(["From", "Message-ID", "List-Id", "Authentication-Results"]),
    );
    expect(result.items.map((r) => r.id)).toEqual([
      `${account.id}:email:m1`,
      `${account.id}:email:m2`,
    ]);
    expect(result.items[0]).toMatchObject({
      threadId: `${account.id}:thread:t-m1`,
      rfc822Id: "<m1@example.com>",
      from: "Rivera, Sam <sam@example.com>",
      to: ["Alex <alex@example.com>"],
      subject: "Subject m1",
      snippet: "Snippet of m1",
      labels: ["INBOX", "Work"],
      unread: true,
      flagged: false,
    });
    expect(result.approxTotal).toBe(42);
    expect(result.nextPageToken).toBeUndefined();
    // messages.list 5 + 2 metadata gets × 20 + labels.list 1 (to name Label_1).
    expect(result.cost.gmailUnits).toBe(46);
    expect(result.source).toBe("provider");
  });

  it("round-trips opaque page tokens bound to the query", async () => {
    const seen: Array<string | null> = [];
    const { reader } = await connectedReader(
      mailbox({ m1: meta("m1"), m2: meta("m2") }, [], (url) => {
        seen.push(url.searchParams.get("pageToken"));
        return url.searchParams.has("pageToken")
          ? response({ messages: [{ id: "m2" }] })
          : response({ messages: [{ id: "m1" }], nextPageToken: "gmail-p2" });
      }),
    );
    const first = await reader.search({ query: "budget", limit: 1 });
    expect(first.nextPageToken).toBeDefined();
    expect(first.nextPageToken).not.toBe("gmail-p2");
    const second = await reader.search({
      query: "budget",
      limit: 1,
      pageToken: first.nextPageToken,
    });
    expect(second.items.map((r) => r.subject)).toEqual(["Subject m2"]);
    expect(second.nextPageToken).toBeUndefined();
    expect(seen).toEqual([null, "gmail-p2"]);
    await expect(
      reader.search({ query: "other", limit: 1, pageToken: first.nextPageToken }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(reader.list(null, {}, 1, first.nextPageToken)).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
  });

  it("passes rawQuery through and scopes spam/trash only when asked", async () => {
    const { reader, calls } = await connectedReader(listOf([]));
    await reader.search({ rawQuery: "category:promotions in:spam", limit: 5 });
    await reader.search({ query: "invoice", includeSpamTrash: true, limit: 5 });
    await reader.search({ query: "invoice -in:spam", limit: 5 });
    const params = calls.map((c) => new URL(`https://x/${c.slice(4)}`).searchParams);
    expect(params[0]?.get("q")).toBe("category:promotions in:spam");
    expect(params[0]?.get("includeSpamTrash")).toBe("true");
    expect(params[1]?.get("includeSpamTrash")).toBe("true");
    await expect(reader.search({ query: "a", rawQuery: "b", limit: 5 })).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
  });

  it("returns one row per thread from threads.list + threads.get(metadata)", async () => {
    const thread = {
      id: "t1",
      messages: [
        meta("old", { threadId: "t1", date: Date.parse("2026-10-01T00:00:00Z") }),
        meta("new", { threadId: "t1", date: Date.parse("2026-10-03T00:00:00Z") }),
        meta("trashed", {
          threadId: "t1",
          labels: ["TRASH"],
          date: Date.parse("2026-10-05T00:00:00Z"),
        }),
      ],
    };
    const { reader, calls } = await connectedReader((url) => {
      if (url.pathname.endsWith("/threads")) {
        return response({ threads: [{ id: "t1" }, { id: "t2" }], resultSizeEstimate: 2 });
      }
      if (url.pathname.endsWith("/threads/t1")) {
        expect(url.searchParams.get("format")).toBe("metadata");
        return response(thread);
      }
      return response({}, 404);
    });
    const result = await reader.search({ query: "plan", threads: true, limit: 25 });
    expect(calls[0]).toMatch(/^GET threads\?/);
    expect(result.items.map((r) => r.id)).toEqual([`${account.id}:email:new`]);
    expect(result.approxTotal).toBe(2);
    // threads.list 10 + 2 threads.get(metadata) × 40.
    expect(result.cost.gmailUnits).toBe(90);
  });

  it("retries a throttled batch part on its own and fails on other part errors", async () => {
    let throttled = 1;
    const base = mailbox({ m1: meta("m1"), m3: meta("m3") }, [], () =>
      response({ messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] }),
    );
    const route: Route = (url, init) => {
      if (!url.pathname.endsWith("/messages/m2")) {
        return base(url, init);
      }
      return throttled-- > 0
        ? response({ error: { errors: [{ reason: "rateLimitExceeded" }] } }, 403)
        : response(meta("m2"));
    };
    const { reader, calls } = await connectedReader(route, { sleep: async () => {} });
    const result = await reader.search({ query: "x", limit: 3 });
    expect(result.items.map((r) => r.subject)).toEqual(["Subject m1", "Subject m2", "Subject m3"]);
    expect(calls.filter((c) => c.startsWith("GET messages/m2"))).toHaveLength(2);
    expect(result.cost.gmailUnits).toBe(5 + 3 * 20 + 20);

    const broken = await connectedReader((url) =>
      url.pathname.endsWith("/messages")
        ? response({ messages: [{ id: "m1" }, { id: "m2" }] })
        : url.pathname.endsWith("/m2")
          ? response({ error: { code: 500 } }, 500)
          : response(meta("m1")),
    );
    await expect(broken.reader.search({ query: "x", limit: 2 })).rejects.toMatchObject({
      code: "HTTP_500",
      status: 500,
    });
  });

  it("surfaces interactive-lane throttling as RateLimitedError instead of waiting", async () => {
    const waits: number[] = [];
    const { reader } = await connectedReader(
      (url) =>
        url.pathname.endsWith("/messages")
          ? response({ messages: [{ id: "m1" }, { id: "m2" }] })
          : url.pathname.endsWith("/m2")
            ? response({}, 429, { "retry-after": "30" })
            : response(meta("m1")),
      { sleep: async (ms) => void waits.push(ms) },
    );
    const error = await reader.search({ query: "x", limit: 2 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({ retryAfterSeconds: 30, scope: "gmail:user-quota" });
    expect(waits).toEqual([]);
  });
});

describe("GmailMailReader.list and labels", () => {
  it("renders structural filters and resolves containers", async () => {
    const { reader, calls } = await connectedReader(listOf(["m1"]));
    await reader.list("Work", { fromDomain: "example.com", unread: true }, 25);
    await reader.list("archive", {}, 25);
    await reader.list(`${account.id}:mailbox:SENT`, {}, 25);
    await expect(reader.list("Nope", {}, 25)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const lists = calls
      .filter((c) => c.startsWith("GET messages?"))
      .map((c) => new URL(`https://x/${c.slice(4)}`).searchParams);
    expect(lists[0]?.get("q")).toBe("from:@example.com is:unread");
    expect(lists[0]?.get("labelIds")).toBe("Label_1");
    expect(lists[1]?.get("q")).toBe("in:archive");
    expect(lists[1]?.has("labelIds")).toBe(false);
    expect(lists[2]?.get("labelIds")).toBe("SENT");
  });

  it("maps system labels to roles, nests user labels and fetches counts in a batch", async () => {
    const { reader, batches } = await connectedReader((url) => {
      const path = url.pathname.replace("/gmail/v1/users/me/", "");
      if (path === "labels") {
        return response({
          labels: [
            { id: "INBOX", name: "INBOX" },
            { id: "SPAM", name: "SPAM" },
            { id: "DRAFT", name: "DRAFT" },
            { id: "STARRED", name: "STARRED" },
            { id: "IMPORTANT", name: "IMPORTANT" },
            ...labels.slice(2),
          ],
        });
      }
      return response({ messagesTotal: 9, messagesUnread: 2 });
    });
    const plain = await reader.labels();
    expect(plain.cost.gmailUnits).toBe(1);
    expect(plain.items.map((l) => [l.id, l.role, l.parentId])).toEqual([
      ["INBOX", "inbox", null],
      ["SPAM", "junk", null],
      ["DRAFT", "drafts", null],
      ["STARRED", null, null],
      ["IMPORTANT", "important", null],
      ["Label_1", null, null],
      ["Label_2", null, "Label_1"],
    ]);
    expect(plain.items[0]?.counts).toBeUndefined();
    const counted = await reader.labels(true);
    expect(counted.items.every((l) => l.counts?.total === 9 && l.counts.unread === 2)).toBe(true);
    expect(counted.cost.gmailUnits).toBe(1 + 7);
    expect(batches).toEqual([7]);
  });
});

describe("GmailMailReader envelopes, thread and body", () => {
  it("returns envelopes keyed by provider id with null for 404, 50 calls per batch", async () => {
    const messages = Object.fromEntries(
      Array.from({ length: 120 }, (_, i) => [`m${i}`, meta(`m${i}`)]),
    );
    const { reader, batches } = await connectedReader(mailbox(messages));
    const ids = [...Object.keys(messages), "gone", "m0"];
    const { value, cost } = await reader.envelopes(ids);
    expect(batches).toEqual([50, 50, 21]);
    expect(value.size).toBe(121);
    expect(value.get("gone")).toBeNull();
    expect(value.get("m7")).toMatchObject({ providerId: "m7", subject: "Subject m7" });
    expect(value.get("m7")).not.toHaveProperty("textBody");
    expect(cost.gmailUnits).toBe(121 * 20);
  });

  it("reads a thread chronologically with externalized bodies and text format", async () => {
    const full = (id: string, date: string, body: Record<string, string>) => ({
      ...meta(id, { threadId: "t1", date: Date.parse(date) }),
      payload: {
        mimeType: "text/html",
        headers: meta(id).payload?.headers,
        body,
      },
    });
    const { reader } = await connectedReader((url) => {
      if (url.pathname.endsWith("/threads/t1")) {
        expect(url.searchParams.get("format")).toBe("full");
        return response({
          id: "t1",
          messages: [
            full("b", "2026-10-02T00:00:00Z", { attachmentId: "big" }),
            full("a", "2026-10-01T00:00:00Z", {
              data: Buffer.from("<p>first</p>").toString("base64url"),
            }),
          ],
        });
      }
      if (url.pathname.endsWith("/messages/b/attachments/big")) {
        return response({ data: Buffer.from("<p>second</p>").toString("base64url") });
      }
      return response({}, 404);
    });
    const html = await reader.thread("t1", { format: "html" });
    expect(html.value.map((e) => [e.providerId, e.htmlBody])).toEqual([
      ["a", "<p>first</p>"],
      ["b", "<p>second</p>"],
    ]);
    expect(html.cost.gmailUnits).toBe(120 + 20);
    const text = await reader.thread("t1", { format: "text" });
    expect(text.value.map((e) => [e.textBody, e.htmlBody])).toEqual([
      ["first", null],
      ["second", null],
    ]);
    await expect(reader.thread("missing", { format: "text" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("returns a message body and manifest for 60 units", async () => {
    const message = {
      ...meta("m1"),
      payload: {
        mimeType: "multipart/mixed",
        headers: meta("m1").payload?.headers,
        parts: [
          {
            partId: "0",
            mimeType: "text/plain",
            body: { data: Buffer.from("hi").toString("base64url") },
          },
          {
            partId: "1",
            mimeType: "application/pdf",
            filename: "a.pdf",
            body: { attachmentId: "x", size: 5 },
          },
        ],
      },
    };
    const { reader } = await connectedReader(mailbox({ m1: message }));
    const { value, cost } = await reader.body("m1");
    expect(value.textBody).toBe("hi");
    expect(value.attachments.map((a) => a.name)).toEqual(["a.pdf"]);
    expect(cost.gmailUnits).toBe(60);
    await expect(reader.body("gone")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("GmailMailProvider.reader", () => {
  it("is bound to the connection, defaults to the interactive lane and reports the budget", async () => {
    const clock = new ManualClock(Date.parse("2026-10-22T00:00:00Z"));
    const governor = new QuotaGovernor({ clock });
    governor.configure(account.id, "gmail");
    const fake = fakeGmail(listOf(["m1", "m2"]));
    const provider = new GmailMailProvider({ fetch: fake.fetcher, governor });
    await expect(provider.reader().labels()).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    await provider.connect(account, { access_token: "token" });
    const reader = provider.reader();
    expect(provider.reader()).toBe(reader);
    expect(provider.capabilities).toMatchObject({ search: true, onDemand: true });
    const result = await reader.search({ query: "x", limit: 2 });
    expect(result.cost).toMatchObject({ gmailUnits: 46, budgetRemaining: 1_500 - 46 });
    await reader.labels(false, { lane: "background" });
    expect(reader.costLog).toEqual([
      { method: "search", gmailUnits: 46, lane: "interactive" },
      { method: "labels", gmailUnits: 1, lane: "background" },
    ]);
    expect(reader.totalUnits).toBe(47);
    governor.report(account.id, { retryAfterSeconds: 30 });
    await expect(reader.search({ query: "x", limit: 2 })).rejects.toBeInstanceOf(RateLimitedError);
  });
});
