import { mailHandle } from "@passport/types";
import { describe, expect, it, vi } from "vitest";
import sample from "./fixtures/jmap.json" with { type: "json" };
import { JmapMailProvider, jmapCapabilities } from "./jmap.js";
import { type JmapMailboxInfo, renderJmapFilter } from "./jmap-reader-filter.js";
import { parsePortableQuery } from "./query.js";
import { QuotaGovernor } from "./quota.js";
import { account, fixtureFetch, jsonBody, response } from "./test/helpers.js";

const mail = "urn:ietf:params:jmap:mail";
const core = "urn:ietf:params:jmap:core";
const session = {
  apiUrl: "https://jmap.example/api",
  uploadUrl: "https://jmap.example/upload/{accountId}",
  downloadUrl: "https://jmap.example/download/{accountId}/{blobId}/{name}?type={type}",
  capabilities: { [core]: {}, [mail]: {} },
  primaryAccounts: { [mail]: "remote" },
  accounts: { remote: { name: "Alex", accountCapabilities: { [mail]: {} } } },
};
const boxes: JmapMailboxInfo[] = [
  { id: "inbox", name: "Inbox", role: "inbox", totalEmails: 3, unreadEmails: 1 },
  { id: "sent", name: "Sent", role: "sent", totalEmails: 1, unreadEmails: 0 },
  { id: "junk", name: "Spam", role: "junk", totalEmails: 1, unreadEmails: 1 },
  { id: "trash", name: "Trash", role: "trash", totalEmails: 0, unreadEmails: 0 },
  { id: "projects", name: "Projects", parentId: "inbox", totalEmails: 0, unreadEmails: 0 },
];

type Raw = Record<string, unknown> & { id: string; receivedAt: string; threadId: string };
function email(id: string, at: string, extra: Record<string, unknown> = {}): Raw {
  return {
    ...sample,
    id,
    threadId: `t-${id}`,
    receivedAt: at,
    messageId: [`${id}@example.com`],
    preview: `Preview of ${id}`,
    "header:List-Id:asText": id === "news" ? " <weekly.list.example> " : null,
    "header:Authentication-Results:asText:all": ["mx.example; dmarc=pass"],
    ...extra,
  };
}
const emails: Raw[] = [
  email("m1", "2026-01-10T00:00:00Z", { threadId: "t1", keywords: {} }),
  email("m2", "2026-01-12T00:00:00Z", { threadId: "t1", mailboxIds: { sent: true } }),
  email("news", "2026-01-13T00:00:00Z", { subject: "Weekly digest", attachments: [] }),
  email("spam", "2026-01-14T00:00:00Z", { mailboxIds: { junk: true } }),
  email("m3", "2026-01-15T00:00:00Z", { threadId: "t1" }),
];

function matches(e: Raw, f: Record<string, unknown>): boolean {
  if (f.operator) {
    const parts = (f.conditions as Record<string, unknown>[]).map((c) => matches(e, c));
    return f.operator === "AND"
      ? parts.every(Boolean)
      : f.operator === "OR"
        ? parts.some(Boolean)
        : !parts[0];
  }
  const inBoxes = (ids: string[]) =>
    ids.some((id) => (e.mailboxIds as Record<string, boolean>)[id]);
  return [
    f.inMailbox === undefined || inBoxes([f.inMailbox as string]),
    f.inMailboxOtherThan === undefined || !inBoxes(f.inMailboxOtherThan as string[]),
    f.subject === undefined ||
      String(e.subject).toLowerCase().includes(String(f.subject).toLowerCase()),
    f.text === undefined || String(e.preview).includes(String(f.text)),
    f.notKeyword === undefined || !(e.keywords as Record<string, boolean>)[f.notKeyword as string],
    f.after === undefined || e.receivedAt >= String(f.after),
    f.header === undefined ||
      (e.messageId as string[]).includes(String((f.header as string[])[1]).replace(/^<|>$/g, "")),
  ].every(Boolean);
}

function resolve(results: Record<string, unknown>[], value: { resultOf: string; path: string }) {
  const result = results[Number(value.resultOf)] ?? {};
  return value.path === "/ids"
    ? (result.ids as string[])
    : (result.list as Array<{ emailIds: string[] }>).flatMap((t) => t.emailIds);
}

function server(
  overrides: (method: string, args: Record<string, unknown>) => unknown = () => undefined,
) {
  const requests: string[][] = [];
  const fetch = fixtureFetch((url, init) => {
    if (url.pathname === "/.well-known/jmap") {
      return response(session);
    }
    const calls = jsonBody(init).methodCalls as Array<[string, Record<string, unknown>, string]>;
    requests.push(calls.map((c) => c[0]));
    const results: Record<string, unknown>[] = [];
    const out = calls.map(([method, args, tag]) => {
      const reference = Object.entries(args).find(([k]) => k.startsWith("#"))?.[1] as
        | { resultOf: string }
        | undefined;
      if (reference && results[Number(reference.resultOf)]?.error) {
        results.push({ error: true });
        return ["error", { type: "invalidResultReference" }, tag];
      }
      const ids = (key: string) =>
        (args[`#${key}`] ? resolve(results, args[`#${key}`] as never) : args[key]) as string[];
      let value = overrides(method, args) as Record<string, unknown> | undefined;
      if (!value && method === "Mailbox/get") {
        value = { list: boxes, state: "mb1" };
      } else if (!value && method === "Email/query") {
        let found = emails.filter((e) => !args.filter || matches(e, args.filter as never));
        found.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
        if (args.collapseThreads) {
          found = found.filter((e, i) => found.findIndex((o) => o.threadId === e.threadId) === i);
        }
        let position = Number(args.position ?? 0);
        if (args.anchor) {
          const at = found.findIndex((e) => e.id === args.anchor);
          position = at + Number(args.anchorOffset ?? 0);
          if (at < 0) {
            results.push({ error: true });
            return ["error", { type: "anchorNotFound" }, tag];
          }
        }
        const page = found.slice(position, position + Number(args.limit ?? 50)).map((e) => e.id);
        value = { ids: page, position, total: found.length, queryState: "q1" };
      } else if (!value && method === "Email/get") {
        const wanted = ids("ids");
        value = {
          state: "s1",
          list: emails.filter((e) => wanted.includes(e.id)),
          notFound: wanted.filter((id) => !emails.some((e) => e.id === id)),
        };
      } else if (!value && method === "SearchSnippet/get") {
        value = {
          list: ids("emailIds").map((emailId) => ({
            emailId,
            preview: `<mark>hit</mark> in ${emailId} &amp; more`,
          })),
        };
      } else if (!value && method === "Thread/get") {
        const wanted = ids("ids");
        const list = wanted
          .map((id) => ({ id, emailIds: emails.filter((e) => e.threadId === id).map((e) => e.id) }))
          .filter((t) => t.emailIds.length > 0);
        value = { list, notFound: wanted.filter((id) => !list.some((t) => t.id === id)) };
      }
      results.push(value ?? {});
      return [method, value ?? {}, tag];
    });
    return response({ methodResponses: out });
  });
  return { fetch, requests };
}

async function setup(overrides?: Parameters<typeof server>[0], governor?: QuotaGovernor) {
  const fake = server(overrides);
  const provider = new JmapMailProvider({
    fetch: fake.fetch,
    now: () => new Date("2026-01-20T00:00:00Z"),
    ...(governor ? { governor } : {}),
  });
  await provider.connect(
    { ...account, kind: "jmap", settings: { sessionUrl: "https://jmap.example/.well-known/jmap" } },
    { token: "token" },
  );
  return { ...fake, provider, reader: provider.reader() };
}

describe("renderJmapFilter", () => {
  it("maps portable operators to standard Email/query conditions", () => {
    const ast = parsePortableQuery(
      'from:sam -is:unread is:flagged has:attachment larger:1K after:2026-01-01 in:spam (subject:"a b" OR budget) filename:pdf rfc822msgid:x@y',
    );
    const { conditions, notes } = renderJmapFilter(ast, { now: new Date(), boxes });
    expect(conditions).toEqual([
      { from: "sam" },
      { operator: "NOT", conditions: [{ notKeyword: "$seen" }] },
      { hasKeyword: "$flagged" },
      { hasAttachment: true },
      { minSize: 1001 },
      { after: "2026-01-01T00:00:00.000Z" },
      { inMailbox: "junk" },
      { operator: "OR", conditions: [{ subject: "a b" }, { text: "budget" }] },
      { text: "pdf" },
      { header: ["Message-ID", "<x@y>"] },
    ]);
    expect(notes).toEqual(["filename→text"]);
    expect(() =>
      renderJmapFilter(parsePortableQuery("label:nope"), { now: new Date(), boxes }),
    ).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });
});

describe("JmapMailReader", () => {
  it("queries, gets rows and snippets in one request, newest first without Spam/Trash", async () => {
    const { reader, requests } = await setup();
    expect(jmapCapabilities).toMatchObject({ onDemand: true, search: true });
    const result = await reader.search({ query: "Preview", limit: 2 });
    expect(requests).toEqual([["Mailbox/get"], ["Email/query", "Email/get", "SearchSnippet/get"]]);
    expect(result.items.map((r) => r.id)).toEqual([
      mailHandle(account.id, "email", "m3"),
      mailHandle(account.id, "email", "news"),
    ]);
    expect(result.items[1]).toMatchObject({
      threadId: mailHandle(account.id, "thread", "t-news"),
      rfc822Id: "<news@example.com>",
      labels: ["Inbox"],
      snippet: "hit in news & more",
      listId: "<weekly.list.example>",
      auth: "pass",
      attachments: 0,
    });
    expect(result).toMatchObject({
      approxTotal: 4,
      source: "provider",
      translation: "jmap:Email/query",
    });
    expect(result.cost.graphRequests).toBe(2);
    const next = await reader.search({
      query: "Preview",
      limit: 2,
      pageToken: result.nextPageToken,
    });
    expect(next.items.map((r) => r.rfc822Id)).toEqual(["<m2@example.com>", "<m1@example.com>"]);
    expect(next.nextPageToken).toBeUndefined();
    expect(next.cost.graphRequests).toBe(1);
    await expect(
      reader.search({ query: "other", limit: 2, pageToken: result.nextPageToken }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("collapses threads, scopes containers and includes Spam on request", async () => {
    const { reader } = await setup();
    const threads = await reader.search({ query: "", limit: 10, threads: true });
    expect(threads.items.map((r) => r.rfc822Id)).toEqual([
      "<m3@example.com>",
      "<news@example.com>",
    ]);
    expect(threads.translation).toBe("jmap:Email/query+collapseThreads");
    const spam = await reader.search({ query: "", limit: 10, includeSpamTrash: true });
    expect(spam.items).toHaveLength(5);
    const sent = await reader.list("sent", {}, 10);
    expect(sent.items.map((r) => r.rfc822Id)).toEqual(["<m2@example.com>"]);
    const unread = await reader.list(null, { unread: true }, 10);
    expect(unread.items.map((r) => r.rfc822Id)).toEqual(["<m1@example.com>"]);
    await expect(reader.list("nope", {}, 10)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const raw = await reader.search({ rawQuery: '{"subject":"weekly"}', limit: 10 });
    expect(raw.items.map((r) => r.rfc822Id)).toEqual(["<news@example.com>"]);
    await expect(reader.search({ rawQuery: "subject:x", limit: 1 })).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
  });

  it("falls back to the position when the anchor message is gone", async () => {
    const { reader, requests } = await setup();
    const first = await reader.list(null, {}, 1);
    const removed = emails.splice(0, emails.length, ...emails.filter((e) => e.id !== "m3"));
    try {
      const second = await reader.list(null, {}, 1, first.nextPageToken);
      expect(second.items.map((r) => r.rfc822Id)).toEqual(["<m2@example.com>"]);
      expect(requests.slice(-2)).toEqual([
        ["Email/query", "Email/get"],
        ["Email/query", "Email/get"],
      ]);
    } finally {
      emails.splice(0, emails.length, ...removed);
    }
  });

  it("lists mailboxes with roles and counts", async () => {
    const { reader } = await setup();
    const labels = await reader.labels(true);
    expect(labels.items[4]).toEqual({
      id: "projects",
      name: "Projects",
      role: null,
      parentId: "inbox",
      counts: { total: 0, unread: 0 },
    });
    expect((await reader.labels()).items[2]).toEqual({
      id: "junk",
      name: "Spam",
      role: "junk",
      parentId: null,
    });
  });

  it("reads envelopes, bodies and threads (Thread/get + Email/get in one request)", async () => {
    const { reader, requests } = await setup();
    const envelopes = await reader.envelopes(["m1", "gone"]);
    expect(envelopes.value.get("m1")).toMatchObject({ subject: "Design review" });
    expect(envelopes.value.get("m1")).not.toHaveProperty("textBody");
    expect(envelopes.value.get("gone")).toBeNull();
    expect((await reader.body("m1")).value).toMatchObject({
      textBody: "Let's meet at 2pm.",
      htmlBody: "<p>Let's meet at 2pm.</p>",
    });
    await expect(reader.body("gone")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const thread = await reader.thread("t1", { format: "text" });
    expect(requests.at(-1)).toEqual(["Thread/get", "Email/get"]);
    expect(thread.value.map((e) => e.providerId)).toEqual(["m1", "m2", "m3"]);
    expect(thread.value.every((e) => e.htmlBody === null)).toBe(true);
    expect(thread.cost.graphRequests).toBe(1);
    await expect(reader.thread("nope", { format: "html" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("counts with calculateTotal and finds messages by Message-ID", async () => {
    const { reader } = await setup();
    expect((await reader.countIds("Preview", 10)).value).toEqual({ count: 4, capped: false });
    expect((await reader.countIds("Preview", 3)).value).toEqual({ count: 3, capped: true });
    expect((await reader.findByRfc822("news@example.com")).value).toBe("news");
    expect((await reader.findByRfc822("<missing@x>")).value).toBeNull();
  });

  it("starts changes at the current state and maps Email/changes, expiring old states", async () => {
    const { reader } = await setup((method, args) => {
      if (method === "Email/changes") {
        return args.sinceState === "old"
          ? undefined
          : {
              newState: "s2",
              hasMoreChanges: true,
              created: ["n1"],
              updated: ["m1"],
              destroyed: ["m9"],
            };
      }
      return undefined;
    });
    const start = await reader.changes(null, 10);
    expect(start.value).toMatchObject({ added: [], labelChanged: [], deleted: [] });
    const changes = await reader.changes(start.value.cursor, 10);
    expect(changes.value).toMatchObject({
      added: ["n1"],
      labelChanged: ["m1"],
      deleted: ["m9"],
      hasMore: true,
    });
    await expect(reader.changes("bogus", 10)).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("reports cannotCalculateChanges as an expired cursor with a fresh state", async () => {
    const fake = server();
    const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const calls = init.body ? (jsonBody(init).methodCalls as Array<[string]>) : [];
      if (calls[0]?.[0] === "Email/changes") {
        return response({ methodResponses: [["error", { type: "cannotCalculateChanges" }, "0"]] });
      }
      return fake.fetch(input, init);
    });
    const provider = new JmapMailProvider({ fetch: fetch as typeof globalThis.fetch });
    await provider.connect(
      {
        ...account,
        kind: "jmap",
        settings: { sessionUrl: "https://jmap.example/.well-known/jmap" },
      },
      { token: "token" },
    );
    const reader = provider.reader();
    const start = await reader.changes(null, 10);
    const expired = await reader.changes(start.value.cursor, 10);
    expect(expired.value).toMatchObject({ expired: true, added: [], deleted: [] });
    expect(expired.cost.graphRequests).toBe(2);
  });

  it("acquires one governor unit per HTTP request in the call's lane", async () => {
    const governor = new QuotaGovernor();
    governor.configure(account.id, "jmap");
    const acquire = vi.spyOn(governor, "acquire");
    const { reader } = await setup(undefined, governor);
    await reader.findByRfc822("m1@example.com", { lane: "arrivals" });
    expect(acquire).toHaveBeenCalledWith(account.id, "arrivals", 1, {});
  });
});
