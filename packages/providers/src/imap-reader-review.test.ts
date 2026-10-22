import { describe, expect, it } from "vitest";
import { encodeCursor } from "./errors.js";
import { ImapMailProvider } from "./imap.js";
import { IMAP_WHOLE_BYTES } from "./imap-reader-bodies.js";
import { IMAP_DELETE_SWEEP_MS } from "./imap-reader-changes.js";
import { FakeImapServer } from "./imap-reader-fake.js";
import { imapIdentity } from "./imap-reader-shared.js";
import { missingUids, parseUidSet, unpackUids } from "./imap-reader-support.js";
import { account } from "./test/helpers.js";

const configured = { ...account, kind: "imap" as const, settings: { host: "imap.example" } };

async function setup(n: number, caps: string[] = []) {
  const server = new FakeImapServer(caps);
  for (let i = 0; i < n; i++) {
    server.add("INBOX", {
      from: "Sam <sam@example.com>",
      subject: `S${i}`,
      messageId: `<m${i}@x>`,
      date: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    });
  }
  let now = Date.parse("2026-01-20T00:00:00Z");
  const provider = new ImapMailProvider({
    imapFactory: () => server.client,
    now: () => new Date(now),
  });
  await provider.connect(configured, { password: "secret" });
  return {
    server,
    reader: provider.reader(),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const crafted = (fields: Record<string, unknown>) =>
  encodeCursor({
    account: "account-1",
    kind: "imap-changes",
    path: "INBOX",
    validity: "7",
    sweptAt: Date.parse("2026-01-20T00:00:00Z"),
    ...fields,
  });

describe("IMAP reader hardening", () => {
  it("R1-3: UID sets are never expanded without bound", () => {
    const started = Date.now();
    expect(() => unpackUids("1:2000000000")).toThrow(
      expect.objectContaining({ code: "INVALID_CURSOR" }),
    );
    expect(() => unpackUids("5:1")).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
    expect(() => parseUidSet("1:10", 5)).toThrow(
      expect.objectContaining({ code: "INVALID_CURSOR" }),
    );
    expect(() => parseUidSet("3,1", 9)).toThrow(
      expect.objectContaining({ code: "INVALID_CURSOR" }),
    );
    // A huge range diffed against a small mailbox is refused without enumerating it.
    expect(missingUids([[1, 2 ** 31]], [1, 2, 3], 5_000)).toBeNull();
    expect(missingUids([[1, 6]], [2, 3, 5], 10)).toEqual([1, 4, 6]);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("R1-3: a crafted change cursor is rejected before any work", async () => {
    const { reader, server } = await setup(1);
    const before = server.log.length;
    // Before the fix: accepted, 3M UIDs materialised.
    for (const fields of [
      { uidNext: 2, uids: "1:3000000" },
      { uidNext: 2, uids: "5:1" },
      { uidNext: 2 ** 40, uids: "1" },
      { uidNext: 2, uids: "1,".repeat(1_000) },
      { uidNext: 2, modseq: "1; DROP" },
    ]) {
      await expect(reader.changes(crafted(fields), 10)).rejects.toMatchObject({
        code: "INVALID_CURSOR",
      });
    }
    expect(server.log.slice(before).some((c) => c.startsWith("UID"))).toBe(false);
  });

  it("R1-5: cursors stay small on fragmented mailboxes and expire on unnamed deletions", async () => {
    const { reader, server, advance } = await setup(4_000);
    for (let uid = 2; uid <= 4_000; uid += 2) {
      server.expunge("INBOX", uid);
    }
    const start = await reader.changes(null, 10);
    // 2,000 isolated UIDs would pack to ~9,800 chars; the cursor carries a count instead.
    expect(start.value.cursor.length).toBeLessThan(4_096);
    server.add("INBOX", {
      from: "New <n@x>",
      subject: "NEW",
      messageId: "<new@x>",
      date: "2026-01-19T00:00:00Z",
    });
    const next = await reader.changes(start.value.cursor, 10);
    expect(next.value.added).toHaveLength(1);
    expect(next.value.cursor.length).toBeLessThan(4_096);
    server.expunge("INBOX", 1);
    advance(IMAP_DELETE_SWEEP_MS);
    const swept = await reader.changes(next.value.cursor, 10);
    expect(swept.value).toMatchObject({ expired: true, deleted: [] });
  });

  it("R1-5: small mailboxes still name their deletions", async () => {
    const { reader, server, advance } = await setup(5);
    const start = await reader.changes(null, 10);
    server.expunge("INBOX", 3);
    advance(IMAP_DELETE_SWEEP_MS);
    const swept = await reader.changes(start.value.cursor, 10);
    expect(swept.value.deleted).toEqual([imapIdentity("INBOX", "7", 3)]);
    expect(swept.value.expired).toBeUndefined();
  });

  it("R1-10: pages anchor on UIDs, so arrivals and expunges neither repeat nor skip rows", async () => {
    const { reader, server } = await setup(6);
    const p1 = await reader.list("INBOX", {}, 3);
    server.add("INBOX", {
      from: "New <n@x>",
      subject: "NEW",
      messageId: "<new@x>",
      date: "2026-01-19T00:00:00Z",
    });
    server.expunge("INBOX", 3);
    const p2 = await reader.list("INBOX", {}, 3, p1.nextPageToken);
    // Before the fix: page 2 repeated S3.
    expect(p1.items.map((r) => r.subject)).toEqual(["S5", "S4", "S3"]);
    expect(p2.items.map((r) => r.subject)).toEqual(["S1", "S0"]);
    expect(p2.nextPageToken).toBeUndefined();
  });

  it("R1-10: local-filter pages resume after the last row", async () => {
    const { reader, server } = await setup(6);
    const p1 = await reader.search({ query: "from:sam -subject:none", limit: 2 });
    server.add("INBOX", {
      from: "Sam <sam@example.com>",
      subject: "NEW",
      messageId: "<new@x>",
      date: "2026-01-19T00:00:00Z",
    });
    const p2 = await reader.search({
      query: "from:sam -subject:none",
      limit: 2,
      pageToken: p1.nextPageToken,
    });
    const subjects = [...p1.items, ...p2.items].map((r) => r.subject);
    expect(new Set(subjects).size).toBe(subjects.length);
    expect(subjects).not.toContain("NEW");
  });

  it("R1-10: an edited page token is rejected", async () => {
    const { reader } = await setup(6);
    const p1 = await reader.list("INBOX", {}, 3);
    const [body, mac] = (p1.nextPageToken as string).split(".");
    await expect(reader.list("INBOX", {}, 3, `${body}x.${mac}`)).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
  });

  it("R1-9: body() and thread() never load a large message whole", async () => {
    const server = new FakeImapServer([]);
    const uid = server.add("INBOX", {
      from: "Sam <sam@example.com>",
      subject: "Big",
      messageId: "<big@x>",
      date: "2026-01-10T00:00:00Z",
      body: `Start of the note. ${"x".repeat(3 * IMAP_WHOLE_BYTES)}`,
      attachment: "plan.pdf",
    });
    const provider = new ImapMailProvider({ imapFactory: () => server.client });
    await provider.connect(configured, { password: "secret" });
    const reader = provider.reader();
    const id = imapIdentity("INBOX", "7", uid);
    const body = await reader.body(id);
    // Before the fix: ~3 MB of source fetched and parsed.
    expect(server.fetchedBytes).toBeLessThanOrEqual(IMAP_WHOLE_BYTES + 1_024);
    expect(body.value.textBody).toMatch(/^Start of the note\./);
    expect(body.value.attachments.map((a) => a.name)).toEqual(["plan.pdf"]);
    server.fetchedBytes = 0;
    const thread = await reader.thread("<big@x>", { format: "text" });
    expect(thread.value).toHaveLength(1);
    expect(server.fetchedBytes).toBeLessThanOrEqual(IMAP_WHOLE_BYTES + 1_024);
  });

  it("R1-9: text search fetches a bounded body prefix, not the source", async () => {
    const { reader, server } = await setup(3);
    server.fetchedBytes = 0;
    const result = await reader.search({ query: "hello", limit: 5 });
    expect(result.items).toHaveLength(3);
    expect(result.translation).toContain("scanned=3");
    expect(server.fetchedBytes).toBeLessThan(100);
  });
});
