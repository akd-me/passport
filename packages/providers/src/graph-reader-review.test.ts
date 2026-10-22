import { describe, expect, it } from "vitest";
import { encodeCursor } from "./errors.js";
import { MAX_COUNT_PAGES } from "./graph-reader-count.js";
import { FakeGraph, message } from "./test/graph-reader-fake.js";

const DELTA = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta";

describe("Graph reader hardening", () => {
  it("R1-4: a forged page token is rejected before anything is fetched", async () => {
    const fake = new FakeGraph();
    const reader = await fake.connect();
    const key = JSON.stringify(["hello", null, null, false, false]);
    const forged = encodeCursor({
      account: "account-1",
      kind: "search",
      key,
      link: "https://graph.microsoft.com/v1.0/users/ceo@contoso.com/messages?$select=body&$top=1000",
      skip: 0,
      scanned: 0,
    });
    const before = fake.seen.length;
    await expect(
      reader.search({ query: "hello", limit: 10, pageToken: forged }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(fake.seen.slice(before).some((r) => r.url.pathname.includes("/users/"))).toBe(false);
  });

  it("R1-4: genuine page tokens still resume, and an edited one is rejected", async () => {
    const fake = new FakeGraph();
    fake.routes.push((url) => {
      if (!/\/me\/messages$/.test(url.pathname)) {
        return undefined;
      }
      const page = url.searchParams.get("$skiptoken");
      return {
        status: 200,
        body: {
          value: [message(page ? "m2" : "m1")],
          ...(page
            ? {}
            : { "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=2" }),
        },
      };
    });
    const reader = await fake.connect();
    const first = await reader.search({ query: "from:sam", limit: 1 });
    const token = first.nextPageToken as string;
    const second = await reader.search({ query: "from:sam", limit: 1, pageToken: token });
    expect(second.items.map((r) => r.subject)).toEqual(["Subject m2"]);
    const [body, mac] = token.split(".");
    const tampered = `${body?.slice(0, -2)}AA.${mac}`;
    await expect(
      reader.search({ query: "from:sam", limit: 1, pageToken: tampered }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("R1-4: a change cursor's link is rebuilt for its folder, never fetched as given", async () => {
    const fake = new FakeGraph();
    fake.routes.push((url) =>
      url.pathname.endsWith("/messages/delta")
        ? { status: 200, body: { value: [], "@odata.deltaLink": `${DELTA}?$deltatoken=d1` } }
        : undefined,
    );
    const reader = await fake.connect();
    const cursor = encodeCursor({
      account: "account-1",
      kind: "graph-changes",
      v: 1,
      folders: {
        inbox: {
          link: "https://graph.microsoft.com/v1.0/me/contacts?$top=1000&$deltatoken=x",
          done: true,
          at: "2026-10-22T00:00:00Z",
        },
      },
    });
    await reader.changes(cursor, 10);
    expect(fake.seen.some((r) => r.url.pathname.endsWith("/me/contacts"))).toBe(false);
    const delta = fake.gets("/messages/delta").at(-1);
    expect(delta?.url.pathname).toBe("/v1.0/me/mailFolders/inbox/messages/delta");
    expect([...(delta?.url.searchParams.keys() ?? [])]).toEqual(["$deltatoken"]);
    const noToken = encodeCursor({
      account: "account-1",
      kind: "graph-changes",
      v: 1,
      folders: {
        inbox: {
          link: "https://graph.microsoft.com/v1.0/me/contacts",
          done: true,
          at: "2026-10-22T00:00:00Z",
        },
      },
    });
    await expect(reader.changes(noToken, 10)).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("R1-6: a message changed within the arrival window is reported added once", async () => {
    const fake = new FakeGraph();
    let now = new Date("2026-10-22T12:00:00Z");
    let round = 0;
    fake.routes.push((url) => {
      if (!url.pathname.endsWith("/messages/delta")) {
        return undefined;
      }
      if (!url.searchParams.get("$deltatoken")) {
        return { status: 200, body: { value: [], "@odata.deltaLink": `${DELTA}?$deltatoken=r0` } };
      }
      round++;
      const m1 = message("m1", { receivedDateTime: "2026-10-22T12:00:10Z", isRead: round >= 2 });
      return {
        status: 200,
        body: { value: [m1], "@odata.deltaLink": `${DELTA}?$deltatoken=r${round}` },
      };
    });
    const reader = await fake.connect({ now: () => now });
    const c0 = (await reader.changes(null, 50)).value;
    now = new Date("2026-10-22T12:00:30Z");
    const c1 = (await reader.changes(c0.cursor, 50)).value;
    now = new Date("2026-10-22T12:01:00Z");
    const c2 = (await reader.changes(c1.cursor, 50)).value;
    expect(c1.added).toEqual(["m1"]);
    // Before the fix: added again.
    expect(c2.added).toEqual([]);
    expect(c2.labelChanged).toEqual(["m1"]);
  });

  it("R1-7: a client-filtered count stops after MAX_COUNT_PAGES and reports capped", async () => {
    const fake = new FakeGraph();
    let pages = 0;
    fake.routes.push((url) => {
      if (!/\/me\/messages$/.test(url.pathname)) {
        return undefined;
      }
      pages++;
      const value = Array.from({ length: 250 }, (_, i) => message(`p${pages}-${i}`));
      return {
        status: 200,
        body: {
          value,
          "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/messages?$skiptoken=${pages}`,
        },
      };
    });
    const reader = await fake.connect();
    const result = await reader.countIds("list:announce", 2000);
    // Before the fix: 400 pages (the whole mailbox).
    expect(pages).toBe(MAX_COUNT_PAGES);
    expect(result.value).toEqual({ count: 0, capped: true });
    expect(result.translation).toMatch(/; scanned=2000 capped$/);
  });

  it("R1-11: the first change check scopes delta to recent arrivals", async () => {
    const fake = new FakeGraph();
    fake.routes.push((url) =>
      url.pathname.endsWith("/messages/delta")
        ? { status: 200, body: { value: [], "@odata.deltaLink": `${DELTA}?$deltatoken=d0` } }
        : undefined,
    );
    const reader = await fake.connect();
    await reader.changes(null, 10);
    const [first] = fake.gets("/messages/delta");
    expect(first?.url.searchParams.get("$filter")).toBe(
      "receivedDateTime ge 2026-10-22T11:58:00.000Z",
    );
  });

  it("R1-20: a malformed id in envelopes() maps to null", async () => {
    const fake = new FakeGraph();
    fake.routes.push((url, request) =>
      request.batch && url.pathname.endsWith("/messages/bad")
        ? { status: 400, body: { error: { code: "ErrorInvalidIdMalformed" } } }
        : request.batch && url.pathname.endsWith("/messages/m1")
          ? { status: 200, body: message("m1") }
          : undefined,
    );
    const reader = await fake.connect();
    const result = await reader.envelopes(["m1", "bad"]);
    expect(result.value.get("m1")?.subject).toBe("Subject m1");
    expect(result.value.get("bad")).toBeNull();
  });
});
