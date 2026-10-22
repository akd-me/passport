import { describe, expect, it } from "vitest";
import { decodeCursor } from "./errors.js";
import { QuotaGovernor } from "./quota.js";
import { ManualClock } from "./quota-clock.js";
import { FakeGraph } from "./test/graph-reader-fake.js";
import { account } from "./test/helpers.js";

const listing = (path: string) => (url: URL) =>
  url.pathname.endsWith(path) && !url.pathname.includes("/messages/") ? url : undefined;

describe("GraphMailReader counts, lookups and costs", () => {
  it("counts the $filter path with $count minus hidden folders", async () => {
    const graph = new FakeGraph();
    graph.routes.push((url) => {
      if (!url.pathname.endsWith("/messages") || !url.searchParams.get("$count")) {
        return undefined;
      }
      const count = url.pathname.includes("id-junk")
        ? 2
        : url.pathname.includes("id-deleted")
          ? 1
          : 10;
      return { status: 200, body: { value: [], "@odata.count": count } };
    });
    const reader = await graph.connect();
    const exact = await reader.countIds("is:unread", 100);
    expect(exact.value).toEqual({ count: 7, capped: false });
    expect(exact.cost.graphRequests).toBe(9);
    const counts = graph.gets("/messages");
    expect(counts).toHaveLength(3);
    expect(counts[0]?.headers.get("ConsistencyLevel")).toBe("eventual");
    expect(counts[0]?.url.searchParams.get("$top")).toBe("1");
    const capped = await reader.countIds("is:unread", 5);
    expect(capped.value).toEqual({ count: 5, capped: true });
    expect(capped.cost.graphRequests).toBe(3);
  });

  it("counts the $search path by paging ids", async () => {
    const graph = new FakeGraph();
    graph.routes.push((url) => {
      if (!listing("/me/messages")(url)) {
        return undefined;
      }
      return url.searchParams.get("$skiptoken")
        ? { status: 200, body: { value: [{ id: "c", parentFolderId: "id-junk" }] } }
        : {
            status: 200,
            body: {
              value: [
                { id: "a", parentFolderId: "id-inbox" },
                { id: "b", parentFolderId: "id-sent" },
              ],
              "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=2",
            },
          };
    });
    const reader = await graph.connect();
    const result = await reader.countIds("budget", 100);
    expect(result.value).toEqual({ count: 2, capped: false });
    expect(graph.gets("/me/messages")[0]?.url.searchParams.get("$select")).toBe(
      "id,parentFolderId",
    );
    expect(result.translation).toBe("graph:$search");
    const one = await reader.countIds("budget", 1);
    expect(one.value).toEqual({ count: 1, capped: true });
  });

  it("finds a message by internetMessageId, preferring the received copy", async () => {
    const graph = new FakeGraph();
    graph.routes.push((url) =>
      listing("/me/messages")(url)
        ? {
            status: 200,
            body: {
              value: [
                { id: "sent-copy", parentFolderId: "id-sent" },
                { id: "inbox-copy", parentFolderId: "id-inbox" },
              ],
            },
          }
        : undefined,
    );
    const reader = await graph.connect();
    const found = await reader.findByRfc822("abc@host");
    expect(graph.gets("/me/messages")[0]?.url.searchParams.get("$filter")).toBe(
      "internetMessageId eq '<abc@host>'",
    );
    expect(found.value).toBe("inbox-copy");
  });

  it("spends every request through the governor and reacts to throttle headers", async () => {
    const clock = new ManualClock(Date.parse("2026-10-22T12:00:00Z"));
    const governor = new QuotaGovernor({ clock });
    governor.configure(account.id, "graph");
    const graph = new FakeGraph();
    const reader = await graph.connect({ governor });
    const labels = await reader.labels();
    expect(labels.cost).toMatchObject({ graphRequests: 9, budgetRemaining: 241 });
    graph.routes.push(() => ({
      status: 200,
      body: { value: [] },
      headers: { "x-ms-throttle-limit-percentage": "0.95" },
    }));
    const listed = await reader.list(null, {}, 5, undefined, { lane: "background" });
    expect(listed.cost.graphRequests).toBe(1);
    expect(listed.cost.budgetRemaining).toBeLessThanOrEqual(Math.floor(250 * 0.05));
    expect(reader.costLog).toEqual([
      { method: "labels", graphRequests: 9, lane: "interactive" },
      { method: "list", graphRequests: 1, lane: "background" },
    ]);
    expect(reader.totalRequests).toBe(10);
  });
});

describe("GraphMailReader changes", () => {
  const delta = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta";

  it("starts at now, classifies delta items and recovers from 410", async () => {
    const graph = new FakeGraph();
    let phase: "drain" | "poll" | "expired" = "drain";
    graph.routes.push((url) => {
      if (!url.pathname.endsWith("/messages/delta")) {
        return undefined;
      }
      const token = url.searchParams.get("$deltatoken");
      const skip = url.searchParams.get("$skiptoken");
      if (phase === "expired" && token === "d1") {
        return { status: 410, body: { error: {} } };
      }
      if (phase === "poll" && token === "d1") {
        return {
          status: 200,
          body: {
            value: [
              { id: "new", receivedDateTime: "2026-10-22T11:59:00Z" },
              { id: "old", receivedDateTime: "2026-01-01T00:00:00Z", isRead: true },
              { id: "gone", "@removed": { reason: "deleted" } },
            ],
            "@odata.deltaLink": `${delta}?$deltatoken=d2`,
          },
        };
      }
      return skip
        ? {
            status: 200,
            body: { value: [{ id: "x" }], "@odata.deltaLink": `${delta}?$deltatoken=d1` },
          }
        : {
            status: 200,
            body: { value: [{ id: "y" }], "@odata.nextLink": `${delta}?$skiptoken=s1` },
          };
    });
    const reader = await graph.connect();
    const start = await reader.changes(null, 50);
    expect(start.value).toMatchObject({ added: [], labelChanged: [], deleted: [] });
    expect(start.cost.graphRequests).toBe(2);
    expect(graph.gets("/messages/delta")[0]?.url.searchParams.get("$select")).toBe(
      "id,conversationId,isRead,parentFolderId,categories,receivedDateTime",
    );
    const cursor = decodeCursor<{ folders: Record<string, { link: string; done: boolean }> }>(
      start.value.cursor,
    );
    expect(cursor.folders.inbox).toMatchObject({ link: `${delta}?$deltatoken=d1`, done: true });

    phase = "poll";
    const polled = await reader.changes(start.value.cursor, 50);
    expect(polled.value).toMatchObject({
      added: ["new"],
      labelChanged: ["old"],
      deleted: ["gone"],
    });
    expect(polled.value.hasMore).toBeUndefined();
    expect(polled.cost.graphRequests).toBe(1);

    phase = "expired";
    const expired = await reader.changes(start.value.cursor, 50);
    expect(expired.value).toMatchObject({
      expired: true,
      added: [],
      labelChanged: [],
      deleted: [],
    });
    expect(decodeCursor<typeof cursor>(expired.value.cursor).folders.inbox?.link).toBe(
      `${delta}?$deltatoken=d1`,
    );
    // The 410 request plus a fresh two-page drain.
    expect(expired.cost.graphRequests).toBe(3);
  });

  it("stops at the limit mid-round and reports hasMore", async () => {
    const graph = new FakeGraph();
    graph.routes.push((url, request) => {
      if (!url.pathname.endsWith("/messages/delta")) {
        return undefined;
      }
      expect(request.headers.get("Prefer")).toContain("odata.maxpagesize=");
      if (url.searchParams.get("$deltatoken") === "d0") {
        return {
          status: 200,
          body: {
            value: [{ id: "a", receivedDateTime: "2026-10-22T11:59:00Z" }],
            "@odata.nextLink": `${delta}?$skiptoken=more`,
          },
        };
      }
      return { status: 200, body: { value: [], "@odata.deltaLink": `${delta}?$deltatoken=d0` } };
    });
    const reader = await graph.connect();
    const start = await reader.changes(null, 1);
    const page = await reader.changes(start.value.cursor, 1);
    expect(page.value).toMatchObject({ added: ["a"], hasMore: true });
    await expect(reader.changes("bogus", 1)).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
});
