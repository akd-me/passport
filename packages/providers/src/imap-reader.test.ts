import { mailHandle } from "@passport/types";
import { describe, expect, it, vi } from "vitest";
import { ImapMailProvider, imapCapabilities } from "./imap.js";
import { IMAP_DELETE_SWEEP_MS } from "./imap-reader-changes.js";
import { FakeImapServer } from "./imap-reader-fake.js";
import { imapIdentity } from "./imap-reader-shared.js";
import { packUids, rawCriteria, unpackUids } from "./imap-reader-support.js";
import { parsePortableQuery } from "./query.js";
import { renderImapQuery } from "./query-render.js";
import { QuotaGovernor } from "./quota.js";
import { account } from "./test/helpers.js";

const configured = { ...account, kind: "imap" as const, settings: { host: "imap.example" } };
const sam = "Sam <sam@example.com>";

function seed(server: FakeImapServer) {
  server.add("INBOX", {
    from: sam,
    subject: "Q3 plan",
    messageId: "<root@x>",
    date: "2026-01-10T09:00:00Z",
    body: "Budget draft attached",
    attachment: "plan.pdf",
    threadId: "T1",
  });
  server.add("INBOX", {
    from: "News <news@list.example>",
    subject: "Weekly digest",
    messageId: "<news@x>",
    date: "2026-01-12T09:00:00Z",
    listId: "<weekly.list.example>",
    flags: ["\\Seen", "receipts"],
  });
  server.add("INBOX", {
    from: "Kim <kim@example.com>",
    subject: "Re: Q3 plan",
    messageId: "<r2@x>",
    inReplyTo: "<r1@x>",
    references: "<root@x> <r1@x>",
    date: "2026-01-14T09:00:00Z",
    body: "Invoice numbers look fine",
    threadId: "T1",
  });
  server.add("Sent", {
    from: "Alex <alex@example.com>",
    to: sam,
    subject: "Re: Q3 plan",
    messageId: "<r1@x>",
    inReplyTo: "<root@x>",
    references: "<root@x>",
    date: "2026-01-11T09:00:00Z",
    flags: ["\\Seen"],
    threadId: "T1",
  });
}

async function setup(caps: string[] = [], options: { governor?: QuotaGovernor } = {}) {
  const server = new FakeImapServer(caps);
  seed(server);
  let now = new Date("2026-01-20T00:00:00Z");
  const provider = new ImapMailProvider({
    imapFactory: () => server.client,
    now: () => now,
    ...options,
  });
  await provider.connect(configured, { password: "secret" });
  return {
    server,
    provider,
    reader: provider.reader(),
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe("renderImapQuery", () => {
  it("pushes cheap keys to SEARCH and greps text, attachments and nested containers locally", () => {
    const plan = renderImapQuery(
      parsePortableQuery(
        'from:sam subject:"q3 plan" is:unread larger:5M after:2026-01-01 rfc822msgid:a@x budget has:attachment',
      ),
    );
    expect(plan.criteria).toEqual({
      from: "sam",
      subject: "q3 plan",
      seen: false,
      larger: 5_000_000,
      since: new Date("2026-01-01T00:00:00Z"),
      header: { "message-id": "<a@x>" },
    });
    expect(plan.localFilter.map((n) => n.kind)).toEqual(["text", "has"]);
    expect(plan).toMatchObject({ mailboxes: [], translation: "imap:SEARCH+localGrep" });
  });

  it("combines OR/NOT, keeps clashing keys local and maps containers", () => {
    const plan = renderImapQuery(
      parsePortableQuery("in:anywhere (from:a OR from:b) -is:flagged to:x to:y"),
    );
    expect(plan.mailboxes).toEqual(["INBOX", "\\Sent", "\\Archive"]);
    expect(plan.criteria).toEqual({
      or: [{ from: "a" }, { from: "b" }],
      not: { flagged: true },
      to: "x",
    });
    expect(plan.localFilter).toEqual([{ kind: "field", field: "to", value: "y", phrase: false }]);
    expect(renderImapQuery(parsePortableQuery("in:sent from:a")).translation).toBe("imap:SEARCH");
    expect(renderImapQuery(parsePortableQuery("label:Projects")).mailboxes).toEqual(["Projects"]);
  });

  it("uses X-GM-RAW over All Mail on Gmail IMAP", () => {
    const gmail = renderImapQuery(parsePortableQuery("from:sam budget is:flagged"), {
      gmail: true,
    });
    expect(gmail).toEqual({
      mailboxes: ["\\All"],
      criteria: { gmraw: "from:sam budget is:starred" },
      localFilter: [],
      translation: "imap:X-GM-RAW",
    });
    expect(renderImapQuery(parsePortableQuery("in:spam x"), { gmail: true }).mailboxes).toEqual([
      "\\Junk",
    ]);
  });
});

describe("ImapMailReader", () => {
  it("probes extensions on connect and advertises the reader", async () => {
    const { provider } = await setup(["SORT", "ESEARCH", "IMAP4rev2", "XLIST"]);
    expect([...provider.extensions].sort()).toEqual(["ESEARCH", "MOVE", "SORT"]);
    expect(imapCapabilities).toMatchObject({ onDemand: true, search: true });
  });

  it("lists INBOX newest first with compact rows and opaque UID paging tokens", async () => {
    const { reader, server } = await setup();
    const first = await reader.list(null, {}, 2);
    expect(first.items.map((r) => r.subject)).toEqual(["Re: Q3 plan", "Weekly digest"]);
    expect(first.items[1]).toMatchObject({
      account: account.id,
      from: "News <news@list.example>",
      to: ["Alex <alex@example.com>"],
      rfc822Id: "<news@x>",
      listId: "<weekly.list.example>",
      labels: ["INBOX", "receipts"],
      unread: false,
      date: "2026-01-12T09:00:00.000Z",
    });
    expect(first.items[0]?.threadId).toBe(mailHandle(account.id, "thread", "<root@x>"));
    expect(first).toMatchObject({ approxTotal: 3, source: "provider" });
    expect(first.translation).toBe("imap:SEARCH; caps=none");
    expect(first.cost.imapCommands).toBeGreaterThanOrEqual(3);
    const second = await reader.list(null, {}, 2, first.nextPageToken);
    expect(second.items.map((r) => r.subject)).toEqual(["Q3 plan"]);
    expect(second.items[0]).toMatchObject({ attachments: 1, unread: true });
    expect(second.nextPageToken).toBeUndefined();
    await expect(reader.list(null, { unread: true }, 2, first.nextPageToken)).rejects.toMatchObject(
      {
        code: "INVALID_CURSOR",
      },
    );
    server.resetValidity("INBOX");
    await expect(reader.list(null, {}, 2, first.nextPageToken)).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
  });

  it("uses UID SORT (REVERSE ARRIVAL) when the server has SORT", async () => {
    const { reader, server } = await setup(["SORT"]);
    const page = await reader.list("inbox", { from: "sam" }, 5);
    expect(server.log).toContain("UID SORT");
    expect(page.items.map((r) => r.subject)).toEqual(["Q3 plan"]);
    expect(page.translation).toBe("imap:SORT; caps=SORT");
  });

  it("greps free text locally over a capped candidate set and merges in:anywhere by date", async () => {
    const { reader } = await setup();
    const grep = await reader.search({ query: "invoice", limit: 10 });
    expect(grep.items.map((r) => r.rfc822Id)).toEqual(["<r2@x>"]);
    expect(grep.items[0]?.snippet).toContain("Invoice numbers");
    expect(grep.translation).toBe("imap:SEARCH+localGrep; caps=none; scanned=3");
    const everywhere = await reader.search({ query: "in:anywhere subject:plan", limit: 2 });
    expect(everywhere.items.map((r) => r.rfc822Id)).toEqual(["<r2@x>", "<r1@x>"]);
    expect(everywhere.items[1]?.labels).toEqual(["Sent"]);
    const next = await reader.search({
      query: "in:anywhere subject:plan",
      limit: 2,
      pageToken: everywhere.nextPageToken,
    });
    expect(next.items.map((r) => r.rfc822Id)).toEqual(["<root@x>"]);
    const attachments = await reader.search({ query: "has:attachment filename:plan", limit: 5 });
    expect(attachments.items.map((r) => r.rfc822Id)).toEqual(["<root@x>"]);
    const threads = await reader.search({ query: "in:anywhere plan", limit: 5, threads: true });
    expect(threads.items).toHaveLength(1);
  });

  it("passes rawQuery through as SEARCH criteria", async () => {
    expect(rawCriteria('OR FROM "a b" (UNSEEN) SUBJECT x')).toEqual([
      { type: "ATOM", value: "OR" },
      { type: "ATOM", value: "FROM" },
      { type: "STRING", value: "a b" },
      [{ type: "ATOM", value: "UNSEEN" }],
      { type: "ATOM", value: "SUBJECT" },
      { type: "ATOM", value: "x" },
    ]);
    expect(() => rawCriteria("FROM {3}\r\nabc")).toThrow(
      expect.objectContaining({ code: "INVALID_QUERY" }),
    );
    const { reader } = await setup(["SORT"]);
    const raw = await reader.search({ rawQuery: "FROM kim", limit: 5 });
    expect(raw.items.map((r) => r.rfc822Id)).toEqual(["<r2@x>"]);
    expect(raw.translation).toBe("imap:SORT(raw); caps=SORT");
  });

  it("lists folders with SPECIAL-USE roles and STATUS counts; keywords are not labels", async () => {
    const { reader, server } = await setup();
    const plain = await reader.labels();
    expect(plain.items.find((l) => l.id === "Sent")).toEqual({
      id: "Sent",
      name: "Sent",
      role: "sent",
      parentId: null,
    });
    expect(plain.items.map((l) => l.role)).toEqual([
      "inbox",
      "sent",
      "drafts",
      "trash",
      "archive",
      null,
    ]);
    expect(plain.items.some((l) => l.name === "receipts")).toBe(false);
    const counted = await reader.labels(true);
    expect(counted.items[0]?.counts).toEqual({ total: 3, unread: 2 });
    expect(server.log.filter((c) => c.startsWith("STATUS"))).toHaveLength(6);
    expect(counted.cost.imapCommands).toBe(7);
  });

  it("joins a thread on References / In-Reply-To across INBOX and Sent", async () => {
    const { reader } = await setup();
    const thread = await reader.thread("<root@x>", { format: "text" });
    expect(thread.value.map((e) => e.headers.messageId)).toEqual(["<root@x>", "<r1@x>", "<r2@x>"]);
    expect(thread.value.every((e) => e.htmlBody === null)).toBe(true);
    expect(thread.value[2]?.textBody).toContain("Invoice numbers");
    await expect(reader.thread("<nope@x>", { format: "text" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("threads by X-GM-THRID and runs X-GM-RAW on Gmail IMAP", async () => {
    const { reader, server } = await setup(["X-GM-EXT-1"]);
    server.folders.set("[Gmail]/All Mail", {
      ...server.folder("INBOX"),
      path: "[Gmail]/All Mail",
      specialUse: "\\All",
    });
    const rows = await reader.search({ query: "from:sam", limit: 5 });
    expect(server.log).toContain('UID SEARCH {"gmraw":"from:sam"}');
    expect(rows.translation).toBe("imap:X-GM-RAW; caps=X-GM-EXT-1");
    const threadId = rows.items[0]?.threadId ?? "";
    expect(threadId).toBe(mailHandle(account.id, "thread", "thrid:T1"));
    const thread = await reader.thread("thrid:T1", { format: "html" });
    expect(thread.value).toHaveLength(2);
    expect(server.log).toContain('UID SEARCH {"threadId":"T1"}');
  });

  it("returns envelopes and bodies, null / STALE_ID after a UIDVALIDITY reset", async () => {
    const { reader, server } = await setup();
    const known = imapIdentity("INBOX", "7", 1);
    const envelopes = await reader.envelopes([known, imapIdentity("INBOX", "7", 99), "bogus"]);
    expect(envelopes.value.get(known)).toMatchObject({
      subject: "Q3 plan",
      size: expect.any(Number),
    });
    expect(envelopes.value.get(known)).not.toHaveProperty("textBody");
    expect(envelopes.value.get(imapIdentity("INBOX", "7", 99))).toBeNull();
    expect(envelopes.value.get("bogus")).toBeNull();
    const body = await reader.body(known);
    expect(body.value.textBody).toContain("Budget draft");
    expect(body.value.attachments.map((a) => a.name)).toEqual(["plan.pdf"]);
    server.resetValidity("INBOX");
    expect((await reader.envelopes([known])).value.get(known)).toBeNull();
    await expect(reader.body(known)).rejects.toMatchObject({ code: "STALE_ID" });
  });

  it("counts with ESEARCH RETURN (COUNT) or the UID list, honouring the cap", async () => {
    const plain = await setup();
    expect((await plain.reader.countIds("subject:plan", 10)).value).toEqual({
      count: 2,
      capped: false,
    });
    expect((await plain.reader.countIds("subject:plan", 1)).value).toEqual({
      count: 1,
      capped: true,
    });
    expect(plain.server.log.some((c) => c.includes("RETURN"))).toBe(false);
    const esearch = await setup(["ESEARCH"]);
    const counted = await esearch.reader.countIds("from:kim", 10);
    expect(counted.value).toEqual({ count: 1, capped: false });
    expect(esearch.server.log).toContain("UID SEARCH RETURN (COUNT)");
    expect((await esearch.reader.countIds("invoice", 10)).value).toEqual({
      count: 1,
      capped: false,
    });
  });

  it("finds a message by Message-ID in INBOX, then Archive, move targets and Sent", async () => {
    const { reader } = await setup();
    expect((await reader.findByRfc822("root@x")).value).toBe(imapIdentity("INBOX", "7", 1));
    expect((await reader.findByRfc822("<r1@x>")).value).toBe(imapIdentity("Sent", "7", 1));
    expect((await reader.findByRfc822("<missing@x>")).value).toBeNull();
  });

  it("tracks changes by UIDNEXT and a periodic UID-list sweep without CONDSTORE", async () => {
    const { reader, server, advance } = await setup();
    const start = await reader.changes(null, 10);
    expect(start.value).toMatchObject({ added: [], labelChanged: [], deleted: [] });
    const a = server.add("INBOX", {
      from: sam,
      subject: "A",
      messageId: "<a@x>",
      date: "2026-01-21T00:00:00Z",
    });
    const b = server.add("INBOX", {
      from: sam,
      subject: "B",
      messageId: "<b@x>",
      date: "2026-01-21T01:00:00Z",
    });
    const first = await reader.changes(start.value.cursor, 1);
    expect(first.value).toMatchObject({ added: [imapIdentity("INBOX", "7", a)], hasMore: true });
    const second = await reader.changes(first.value.cursor, 10);
    expect(second.value.added).toEqual([imapIdentity("INBOX", "7", b)]);
    expect(second.value.hasMore).toBeUndefined();
    server.expunge("INBOX", 2);
    expect((await reader.changes(second.value.cursor, 10)).value.deleted).toEqual([]);
    advance(IMAP_DELETE_SWEEP_MS);
    const swept = await reader.changes(second.value.cursor, 10);
    expect(swept.value.deleted).toEqual([imapIdentity("INBOX", "7", 2)]);
    expect(unpackUids(packUids([5, 1, 2, 3, 9]))).toEqual([1, 2, 3, 5, 9]);
  });

  it("uses CHANGEDSINCE and VANISHED with CONDSTORE/QRESYNC", async () => {
    const { reader, server } = await setup(["CONDSTORE", "QRESYNC"]);
    const start = await reader.changes(null, 10);
    server.setFlags("INBOX", 1, ["\\Seen"]);
    const uid = server.add("INBOX", {
      from: sam,
      subject: "New",
      messageId: "<n@x>",
      date: "2026-01-21T00:00:00Z",
    });
    server.expunge("INBOX", 2);
    const changes = await reader.changes(start.value.cursor, 10);
    expect(server.log.some((c) => c.startsWith("UID FETCH CHANGEDSINCE"))).toBe(true);
    expect(changes.value).toMatchObject({
      added: [imapIdentity("INBOX", "7", uid)],
      labelChanged: [imapIdentity("INBOX", "7", 1)],
      deleted: [imapIdentity("INBOX", "7", 2)],
    });
    const quiet = await reader.changes(changes.value.cursor, 10);
    expect(quiet.value).toMatchObject({ added: [], labelChanged: [], deleted: [] });
    const limited = await (async () => {
      server.setFlags("INBOX", 1, []);
      server.setFlags("INBOX", 3, ["\\Flagged"]);
      return reader.changes(quiet.value.cursor, 1);
    })();
    expect(limited.value).toMatchObject({
      labelChanged: [imapIdentity("INBOX", "7", 1)],
      hasMore: true,
    });
    const rest = await reader.changes(limited.value.cursor, 10);
    expect(rest.value.labelChanged).toEqual([imapIdentity("INBOX", "7", 3)]);
  });

  it("expires change cursors when UIDVALIDITY changes", async () => {
    const { reader, server } = await setup(["CONDSTORE"]);
    const start = await reader.changes(null, 10);
    server.resetValidity("INBOX");
    const expired = await reader.changes(start.value.cursor, 10);
    expect(expired.value).toMatchObject({ expired: true, added: [], deleted: [] });
    const after = await reader.changes(expired.value.cursor, 10);
    expect(after.value.expired).toBeUndefined();
    await expect(reader.changes("bogus", 10)).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("lets the watcher call changes() right after IDLE wakes", async () => {
    const { provider, reader, server } = await setup();
    const start = await reader.changes(null, 10);
    const wait = provider.waitForChanges(new AbortController().signal);
    server.add("INBOX", {
      from: sam,
      subject: "Ping",
      messageId: "<p@x>",
      date: "2026-01-21T00:00:00Z",
    });
    server.emit("exists");
    await wait;
    expect((await reader.changes(start.value.cursor, 10)).value.added).toHaveLength(1);
  });

  it("holds one governor lease per call in the requested lane", async () => {
    const governor = new QuotaGovernor();
    governor.configure(account.id, "imap");
    const acquire = vi.spyOn(governor, "acquire");
    const { reader } = await setup([], { governor });
    const result = await reader.list(null, {}, 1, undefined, { lane: "background" });
    expect(acquire).toHaveBeenCalledWith(account.id, "background", 1, {});
    expect(result.cost.imapCommands).toBeGreaterThan(0);
    const controller = new AbortController();
    controller.abort();
    await expect(reader.labels(false, { signal: controller.signal })).rejects.toMatchObject({
      code: "ABORTED",
    });
  });
});
