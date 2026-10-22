import { describe, expect, it } from "vitest";
import { FakeGraph, message } from "./test/graph-reader-fake.js";
import { account } from "./test/helpers.js";

const listing = (path: string) => (url: URL) =>
  url.pathname.endsWith(path) && !url.pathname.includes("/messages/") ? url : undefined;

describe("GraphMailReader search and list", () => {
  it("runs mixed queries as $search with a client-side filter and folder labels", async () => {
    const graph = new FakeGraph();
    graph.routes.push((url) =>
      listing("/me/messages")(url)
        ? {
            status: 200,
            body: {
              value: [
                message("old", { receivedDateTime: "2026-10-01T00:00:00Z", categories: ["Work"] }),
                message("read", { isRead: true }),
                message("junk", { parentFolderId: "id-junk" }),
                message("new", { receivedDateTime: "2026-10-21T00:00:00Z", hasAttachments: true }),
              ],
            },
          }
        : undefined,
    );
    const reader = await graph.connect();
    const result = await reader.search({ query: "budget is:unread", limit: 25 });
    const request = graph.gets("/me/messages")[0];
    expect(request?.url.searchParams.get("$search")).toBe('"budget"');
    expect(request?.url.searchParams.has("$filter")).toBe(false);
    expect(request?.url.searchParams.has("$orderby")).toBe(false);
    expect(request?.headers.get("Prefer")).toBe('IdType="ImmutableId"');
    expect(result.translation).toBe("graph:$search+clientFilter");
    // Read and junk rows are dropped; the page is sorted newest first.
    expect(result.items.map((row) => row.id)).toEqual([
      `${account.id}:email:new`,
      `${account.id}:email:old`,
    ]);
    expect(result.items[1]).toMatchObject({
      threadId: `${account.id}:thread:conv-old`,
      rfc822Id: "<old@example.com>",
      from: "Sam <sam@example.com>",
      labels: ["Inbox", "Work"],
      unread: true,
      attachments: 0,
    });
    expect(result.items[0]?.attachments).toBe(1);
    // 6 well-known folder lookups (one $batch) + folders + childFolders + the search.
    expect(result.cost.graphRequests).toBe(9);
  });

  it("lists on the $filter path and round-trips nextLink through the page token", async () => {
    const graph = new FakeGraph();
    const next = "https://graph.microsoft.com/v1.0/me/mailFolders/id-inbox/messages?$skiptoken=p2";
    graph.routes.push((url) => {
      if (!listing("/me/mailFolders/id-inbox/messages")(url)) {
        return undefined;
      }
      return url.searchParams.get("$skiptoken")
        ? { status: 200, body: { value: [message("c")], "@odata.count": 3 } }
        : {
            status: 200,
            body: {
              value: [message("a"), message("b")],
              "@odata.count": 3,
              "@odata.nextLink": next,
            },
          };
    });
    const reader = await graph.connect();
    const first = await reader.list("inbox", { unread: true }, 2);
    const request = graph.gets("/messages")[0];
    expect(request?.url.searchParams.get("$filter")).toBe(
      "receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false",
    );
    expect(request?.url.searchParams.get("$orderby")).toBe("receivedDateTime desc");
    expect(request?.url.searchParams.get("$count")).toBe("true");
    expect(request?.url.searchParams.get("$top")).toBe("2");
    expect(first).toMatchObject({ approxTotal: 3, translation: "graph:$filter" });
    expect(first.items.map((row) => row.subject)).toEqual(["Subject a", "Subject b"]);
    expect(first.nextPageToken).toBeDefined();
    const second = await reader.list("inbox", { unread: true }, 2, first.nextPageToken);
    expect(graph.gets("/messages").at(-1)?.url.href).toBe(next);
    expect(second.items.map((row) => row.subject)).toEqual(["Subject c"]);
    expect(second.nextPageToken).toBeUndefined();
    // Roles are cached, the tree is reused: the second page costs one request.
    expect(second.cost.graphRequests).toBe(1);
    await expect(
      reader.list("inbox", { unread: false }, 2, first.nextPageToken),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("reports the $search ceiling as capped", async () => {
    const graph = new FakeGraph();
    let page = 0;
    graph.routes.push((url) => {
      if (!listing("/me/messages")(url)) {
        return undefined;
      }
      page++;
      const value = Array.from({ length: 250 }, (_, i) =>
        message(`p${page}-${i}`, { isRead: true }),
      );
      return {
        status: 200,
        body: {
          value,
          "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/messages?$skiptoken=${page}`,
        },
      };
    });
    const reader = await graph.connect();
    const result = await reader.search({ query: "budget is:unread", limit: 10 });
    expect(result.items).toEqual([]);
    expect(result).toMatchObject({ capped: true, approxTotal: 1000 });
    expect(result.translation).toContain("capped at 1000");
    expect(graph.gets("/me/messages")[0]?.url.searchParams.get("$top")).toBe("100");
  });

  it("returns nothing when container and in: name different folders", async () => {
    const graph = new FakeGraph();
    const reader = await graph.connect();
    const result = await reader.search({ query: "in:sent budget", container: "inbox", limit: 5 });
    expect(result.items).toEqual([]);
    expect(graph.gets("/messages")).toEqual([]);
  });
});

describe("GraphMailReader labels and envelopes", () => {
  it("builds the folder tree with roles, counts and categories", async () => {
    const graph = new FakeGraph();
    const reader = await graph.connect();
    const result = await reader.labels(true);
    expect(result.items).toContainEqual({
      id: "id-inbox",
      name: "Inbox",
      role: "inbox",
      parentId: null,
      counts: { total: 10, unread: 3 },
    });
    expect(result.items).toContainEqual({
      id: "id-projects",
      name: "Projects",
      role: null,
      parentId: "id-inbox",
      counts: { total: 5, unread: 1 },
    });
    expect(result.items.find((l) => l.id === "id-junk")?.role).toBe("junk");
    expect(result.items.find((l) => l.id === "id-deleted")?.role).toBe("trash");
    expect(
      result.items.filter((l) => l.parentId === null && l.role === null).map((l) => l.id),
    ).toEqual(["Work", "Travel"]);
    // 6 (well-known $batch) + folders + childFolders + masterCategories.
    expect(result.cost.graphRequests).toBe(9);
    const plain = await reader.labels();
    expect(plain.items[0]?.counts).toBeUndefined();
    expect(plain.cost.graphRequests).toBe(3);
  });

  it("batches envelopes, maps 404 to null and retries an inner 429", async () => {
    const graph = new FakeGraph();
    for (const id of ["a", "c", ...Array.from({ length: 22 }, (_, i) => `x${i}`)]) {
      graph.messages.set(
        id,
        message(id, { internetMessageHeaders: [{ name: "List-Id", value: "<news.example.com>" }] }),
      );
    }
    let throttled = false;
    graph.routes.push((url, request) => {
      if (request.batch && url.pathname.endsWith("/messages/c") && !throttled) {
        throttled = true;
        return { status: 429, headers: { "Retry-After": "1" }, body: { error: {} } };
      }
      return undefined;
    });
    const reader = await graph.connect();
    const ids = ["a", "b", "c", ...Array.from({ length: 22 }, (_, i) => `x${i}`)];
    const result = await reader.envelopes(ids);
    expect(result.value.get("b")).toBeNull();
    expect(result.value.get("a")).toMatchObject({ providerId: "a", subject: "Subject a" });
    expect(result.value.get("a")).not.toHaveProperty("textBody");
    expect(result.value.get("a")?.headers.listId).toBe("<news.example.com>");
    expect(result.value.get("c")?.providerId).toBe("c");
    expect(graph.sleeps).toEqual([1000]);
    const batches = graph.seen.filter((r) => r.url.pathname.endsWith("/$batch"));
    // 25 ids → 20 + 5, plus one retry batch for the throttled request.
    expect(batches).toHaveLength(3);
    expect(result.cost.graphRequests).toBe(26);
    const inner = graph.seen.find((r) => r.batch && r.url.pathname.endsWith("/messages/a"));
    expect(inner?.url.searchParams.get("$expand")).toContain("attachments");
    expect(inner?.headers.get("Prefer")).toBe('IdType="ImmutableId"');
  });
});

describe("GraphMailReader bodies", () => {
  const threadMessages = [
    message("second", {
      receivedDateTime: "2026-10-21T00:00:00Z",
      body: { contentType: "text", content: "Thanks!\n\n> Original text" },
      uniqueBody: { contentType: "text", content: "Thanks!" },
    }),
    message("first", {
      receivedDateTime: "2026-10-20T00:00:00Z",
      body: { contentType: "text", content: "Original text" },
      attachments: [{ id: "att", name: "plan.pdf", contentType: "application/pdf", size: 9 }],
    }),
  ];

  it("fetches a conversation, sorts it client-side and prefers uniqueBody", async () => {
    const graph = new FakeGraph();
    graph.routes.push((url) =>
      listing("/me/messages")(url) ? { status: 200, body: { value: threadMessages } } : undefined,
    );
    const reader = await graph.connect();
    const result = await reader.thread("conv-1", { format: "text" });
    const request = graph.gets("/me/messages")[0];
    expect(request?.url.searchParams.get("$filter")).toBe("conversationId eq 'conv-1'");
    expect(request?.url.searchParams.has("$orderby")).toBe(false);
    expect(request?.url.searchParams.get("$select")).toContain("uniqueBody");
    expect(request?.url.searchParams.get("$expand")).toBe(
      "attachments($select=id,name,contentType,size,isInline)",
    );
    expect(request?.headers.get("Prefer")).toContain('outlook.body-content-type="text"');
    expect(result.value.map((e) => e.providerId)).toEqual(["first", "second"]);
    expect(result.value[1]).toMatchObject({ textBody: "Thanks!", htmlBody: null });
    expect(result.value[0]?.textBody).toBe("Original text");
    expect(result.value[0]?.attachments[0]).toMatchObject({ name: "plan.pdf", size: 9 });
    expect(result.cost.graphRequests).toBe(1);
  });

  it("keeps the HTML body for format html and throws NOT_FOUND for empty threads", async () => {
    const graph = new FakeGraph();
    graph.routes.push((url) => {
      if (!listing("/me/messages")(url)) {
        return undefined;
      }
      const empty = url.searchParams.get("$filter")?.includes("missing");
      const html = message("h", {
        body: { contentType: "html", content: "<p>Reply</p><blockquote>Old</blockquote>" },
        uniqueBody: { contentType: "html", content: "<p>Reply</p>" },
      });
      return { status: 200, body: { value: empty ? [] : [html] } };
    });
    const reader = await graph.connect();
    const result = await reader.thread("conv-h", { format: "html" });
    expect(graph.gets("/me/messages")[0]?.headers.get("Prefer")).toBe('IdType="ImmutableId"');
    expect(result.value[0]?.htmlBody).toContain("<blockquote>");
    expect(result.value[0]?.textBody).toBe("Reply");
    await expect(reader.thread("missing", { format: "text" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("reads one body and maps 404 to NOT_FOUND", async () => {
    const graph = new FakeGraph();
    graph.messages.set("first", threadMessages[1] as Record<string, unknown>);
    const reader = await graph.connect();
    const body = await reader.body("first");
    expect(body.value).toMatchObject({ textBody: "Original text", htmlBody: null });
    expect(body.value.attachments).toHaveLength(1);
    expect(graph.gets("/messages/first")[0]?.headers.get("Prefer")).toContain("body-content-type");
    await expect(reader.body("gone")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
