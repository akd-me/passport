import { describe, expect, it } from "vitest";
import { GmailMailProvider } from "./gmail.js";
import { buildBatchBody, isThrottledPart, parseBatchResponse } from "./gmail-reader-batch.js";
import { encodeChangeCursor } from "./gmail-reader-support.js";
import { account, connectedReader, response } from "./gmail-reader-testkit.js";
import { fixtureFetch, jsonBody } from "./test/helpers.js";

const params = (call: string | undefined) => new URL(`https://x/${call?.slice(4)}`).searchParams;
const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `m${from + i}` }));

describe("GmailMailReader.countIds", () => {
  it("pages ids 500 at a time until the cap", async () => {
    const { reader, calls } = await connectedReader((url) => {
      const page = Number(url.searchParams.get("pageToken") ?? 0);
      const size = Number(url.searchParams.get("maxResults"));
      return response({ messages: ids(size, page * 500), nextPageToken: String(page + 1) });
    });
    const capped = await reader.countIds("from:news@example.com", 1200);
    expect(capped.value).toEqual({ count: 1200, capped: true });
    expect(calls.map((c) => params(c).get("maxResults"))).toEqual(["500", "500", "201"]);
    expect(params(calls[0]).get("q")).toBe("from:news@example.com");
    expect(capped.cost.gmailUnits).toBe(15);
  });

  it("counts exactly below the cap and passes raw queries through", async () => {
    const { reader, calls } = await connectedReader((url) =>
      url.searchParams.has("pageToken")
        ? response({ messages: ids(20, 500) })
        : response({ messages: ids(500), nextPageToken: "p2" }),
    );
    const exact = await reader.countIds("category:social in:trash", 2000, { raw: true });
    expect(exact.value).toEqual({ count: 520, capped: false });
    expect(params(calls[0]).get("q")).toBe("category:social in:trash");
    expect(params(calls[0]).get("includeSpamTrash")).toBe("true");
    expect(exact.cost.gmailUnits).toBe(10);
  });
});

describe("GmailMailReader.changes", () => {
  it("starts at now for a null cursor without reading history", async () => {
    const { reader, calls } = await connectedReader((url) =>
      url.pathname.endsWith("/profile") ? response({ historyId: "500" }) : response({}, 500),
    );
    const { value, cost } = await reader.changes(null, 50);
    expect(value).toEqual({
      added: [],
      labelChanged: [],
      deleted: [],
      cursor: encodeChangeCursor(account.id, "500"),
    });
    expect(calls).toEqual(["GET profile"]);
    expect(cost.gmailUnits).toBe(1);
  });

  it("coalesces paged history into added / labelChanged / deleted", async () => {
    const { reader, calls } = await connectedReader((url) =>
      url.searchParams.has("pageToken")
        ? response({
            historyId: "120",
            history: [
              { id: "111", labelsRemoved: [{ message: { id: "old" } }] },
              { id: "112", messagesDeleted: [{ message: { id: "gone" } }] },
            ],
          })
        : response({
            historyId: "120",
            nextPageToken: "h2",
            history: [
              { id: "101", messagesAdded: [{ message: { id: "new" } }] },
              { id: "102", labelsAdded: [{ message: { id: "new" } }, { message: { id: "old" } }] },
              { id: "103", messagesAdded: [{ message: { id: "gone" } }] },
            ],
          }),
    );
    const { value, cost } = await reader.changes(encodeChangeCursor(account.id, "100"), 50);
    expect(value).toEqual({
      added: ["new"],
      labelChanged: ["old"],
      deleted: ["gone"],
      cursor: encodeChangeCursor(account.id, "120"),
    });
    expect(params(calls[0]).get("startHistoryId")).toBe("100");
    expect(params(calls[0]).getAll("historyTypes")).toEqual([
      "messageAdded",
      "labelAdded",
      "labelRemoved",
      "messageDeleted",
    ]);
    expect(params(calls[1]).get("startHistoryId")).toBe("100");
    expect(cost.gmailUnits).toBe(4);
  });

  it("stops at the limit with hasMore and a resumable cursor", async () => {
    const { reader } = await connectedReader(() =>
      response({
        historyId: "300",
        history: [
          { id: "201", messagesAdded: [{ message: { id: "a" } }] },
          { id: "202", messagesAdded: [{ message: { id: "b" } }] },
          { id: "203", messagesAdded: [{ message: { id: "c" } }] },
        ],
      }),
    );
    const { value } = await reader.changes("200", 2);
    expect(value).toEqual({
      added: ["a", "b"],
      labelChanged: [],
      deleted: [],
      cursor: encodeChangeCursor(account.id, "202"),
      hasMore: true,
    });
  });

  it("reports an expired cursor with a fresh one and no backfill", async () => {
    const { reader, calls } = await connectedReader((url) =>
      url.pathname.endsWith("/profile")
        ? response({ historyId: "9000" })
        : response({ error: { code: 404 } }, 404),
    );
    const { value, cost } = await reader.changes(encodeChangeCursor(account.id, "1"), 50);
    expect(value).toEqual({
      added: [],
      labelChanged: [],
      deleted: [],
      cursor: encodeChangeCursor(account.id, "9000"),
      expired: true,
    });
    expect(calls.map((c) => c.split("?")[0])).toEqual(["GET history", "GET profile"]);
    expect(cost.gmailUnits).toBe(3);
    await expect(
      reader.changes(encodeChangeCursor("other-account", "1"), 50),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
});

describe("GmailMailReader.findByRfc822", () => {
  it("looks up rfc822msgid across spam/trash and prefers the non-SENT copy", async () => {
    const { reader, calls } = await connectedReader((url) => {
      const q = url.searchParams.get("q") ?? "";
      if (q.includes("unique@")) {
        return response({ messages: [{ id: "only" }] });
      }
      if (q.includes("dup@")) {
        return response({
          messages: q.includes("-in:sent")
            ? [{ id: "inbox-copy" }]
            : [{ id: "sent-copy" }, { id: "inbox-copy" }],
        });
      }
      return response({ resultSizeEstimate: 0 });
    });
    const single = await reader.findByRfc822("<unique@example.com>");
    expect(single.value).toBe("only");
    expect(params(calls[0]).get("q")).toBe("rfc822msgid:unique@example.com");
    expect(params(calls[0]).get("includeSpamTrash")).toBe("true");
    expect(single.cost.gmailUnits).toBe(5);
    const dup = await reader.findByRfc822("<dup@example.com>");
    expect(dup.value).toBe("inbox-copy");
    expect(dup.cost.gmailUnits).toBe(10);
    expect((await reader.findByRfc822("<missing@example.com>")).value).toBeNull();
  });
});

describe("GmailMailProvider.applyChanges with batchModify", () => {
  it("chunks label changes on many ids into ≤1,000-id batchModify calls", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const p = new GmailMailProvider({
      fetch: fixtureFetch((url, init) => {
        calls.push({ path: url.pathname, body: init.body ? jsonBody(init) : {} });
        return url.pathname.endsWith("/batchModify") ? response(null, 204) : response({});
      }),
    });
    await p.connect(account, { access_token: "token" });
    const many = Array.from({ length: 2_500 }, (_, i) => `m${i}`);
    await p.applyChanges([
      { op: "setKeywords", providerIds: many, add: ["$seen"], remove: ["$flagged"] },
      { op: "setKeywords", providerIds: ["a", "b"], add: ["$flagged"] },
    ]);
    const batch = calls.filter((c) => c.path.endsWith("/messages/batchModify"));
    expect(batch.map((c) => (c.body.ids as string[]).length)).toEqual([1000, 1000, 500]);
    expect(batch[2]?.body).toMatchObject({
      addLabelIds: [],
      removeLabelIds: ["UNREAD", "STARRED"],
    });
    expect(batch[0]?.body.ids).toEqual(many.slice(0, 1000));
    expect(batch[2]?.body.ids).toEqual(many.slice(2000));
    expect(calls.slice(3).map((c) => c.path)).toEqual([
      "/gmail/v1/users/me/messages/a/modify",
      "/gmail/v1/users/me/messages/b/modify",
    ]);
  });
});

describe("Gmail batch multipart", () => {
  it("builds one application/http part per call", () => {
    const body = buildBatchBody(["messages/a?format=metadata", "labels/INBOX"], "b1");
    expect(body).toBe(
      "--b1\r\nContent-Type: application/http\r\nContent-ID: <item-0>\r\n\r\n" +
        "GET /gmail/v1/users/me/messages/a?format=metadata\r\n\r\n" +
        "--b1\r\nContent-Type: application/http\r\nContent-ID: <item-1>\r\n\r\n" +
        "GET /gmail/v1/users/me/labels/INBOX\r\n\r\n--b1--\r\n",
    );
  });

  it("maps reordered parts back by Content-ID and keeps failing parts", () => {
    const text = [
      "--batch_x",
      "Content-Type: application/http",
      "Content-ID: <response-item-2>",
      "",
      "HTTP/1.1 429 Too Many Requests",
      "Content-Type: application/json",
      "Retry-After: 7",
      "",
      '{"error":{"code":429}}',
      "--batch_x",
      "Content-Type: application/http",
      "Content-ID: <response-item-0>",
      "",
      "HTTP/1.1 200 OK",
      "Content-Type: application/json; charset=UTF-8",
      "",
      '{"id":"a"}',
      "--batch_x--",
      "",
    ].join("\n");
    const parts = parseBatchResponse(text, 'multipart/mixed; boundary="batch_x"', 3);
    expect(parts[0]).toMatchObject({ status: 200, body: { id: "a" } });
    expect(parts[1]).toBeUndefined();
    expect(parts[2]?.status).toBe(429);
    expect(parts[2]?.headers.get("retry-after")).toBe("7");
    expect(parts[2] && isThrottledPart(parts[2])).toBe(true);
    expect(
      isThrottledPart({
        status: 403,
        headers: new Headers(),
        body: { error: { errors: [{ reason: "forbidden" }] } },
      }),
    ).toBe(false);
    expect(() => parseBatchResponse(text, "application/json", 3)).toThrow(
      expect.objectContaining({ code: "INVALID_RESPONSE" }),
    );
  });
});
