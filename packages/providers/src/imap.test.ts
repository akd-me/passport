import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { ImapFlow } from "imapflow";
import { describe, expect, it, vi } from "vitest";
import { ImapMailProvider, imapFlagsToKeywords } from "./imap.js";
import { createProviderRegistry } from "./registry.js";
import { account, collect, draft, lastCursor } from "./test/helpers.js";

const mime = readFileSync(new URL("./fixtures/invite.eml", import.meta.url));
function imapServer() {
  const events = new EventEmitter();
  let path = "INBOX",
    validity = 10n,
    modseq = 2n;
  const folders = ["INBOX", "Drafts", "Sent", "Trash"];
  const messages = new Map(
    folders.map((p) => [
      p,
      new Map<number, { source: Buffer; flags: Set<string> }>(
        p === "INBOX" ? [[1, { source: mime, flags: new Set(["\\Seen"]) }]] : [],
      ),
    ]),
  );
  const fake = Object.assign(events, {
    get mailbox() {
      return { path, uidValidity: validity, uidNext: 100, highestModseq: modseq };
    },
    connect: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    close: vi.fn(() => events.emit("close")),
    list: vi.fn(async () =>
      folders.map((p) => ({
        path: p,
        name: p,
        flags: new Set(),
        specialUse: `\\${p === "INBOX" ? "Inbox" : p}`,
        parentPath: "",
        childFolderCount: 0,
      })),
    ),
    getMailboxLock: vi.fn(async (selected: string) => {
      path = selected;
      return { release: vi.fn() };
    }),
    status: vi.fn(async () => ({ messages: messages.get(path)!.size, unseen: 0 })),
    search: vi.fn(async () => [...messages.get(path)!.keys()]),
    fetch: vi.fn(async function* (_range, _query, _options) {
      for (const [uid, m] of messages.get(path)!) {
        yield { uid, ...m, internalDate: new Date("2026-01-20T14:00:00Z") };
      }
    }),
    fetchOne: vi.fn(async (uid: number) => {
      const m = messages.get(path)!.get(uid);
      return m ? { uid, ...m } : false;
    }),
    messageFlagsAdd: vi.fn(async (uid: number, flags: string[]) => {
      flags.forEach((f) => {
        messages.get(path)!.get(uid)!.flags.add(f);
      });
      modseq++;
      return true;
    }),
    messageFlagsRemove: vi.fn(async (uid: number, flags: string[]) => {
      flags.forEach((f) => {
        messages.get(path)!.get(uid)!.flags.delete(f);
      });
      modseq++;
      return true;
    }),
    messageCopy: vi.fn(async (uid: number, destination: string) => {
      messages.get(destination)!.set(2, messages.get(path)!.get(uid)!);
      return { uidValidity: validity, uidMap: new Map([[uid, 2]]) };
    }),
    messageMove: vi.fn(async (uid: number, destination: string) => {
      messages.get(destination)!.set(2, messages.get(path)!.get(uid)!);
      messages.get(path)!.delete(uid);
      return { uidValidity: validity, uidMap: new Map([[uid, 2]]) };
    }),
    messageDelete: vi.fn(async (uid: number) => messages.get(path)!.delete(uid)),
    append: vi.fn(async (destination: string, source: Buffer, flags: string[]) => {
      const uid = Math.max(0, ...messages.get(destination)!.keys()) + 1;
      messages.get(destination)!.set(uid, { source, flags: new Set(flags) });
      return { uid, uidValidity: validity };
    }),
  });
  // Object.assign copies getters; keep the selected mailbox dynamic for this fake.
  Object.defineProperty(fake, "mailbox", {
    get: () => ({ path, uidValidity: validity, uidNext: 100, highestModseq: modseq }),
  });
  return {
    fake,
    messages,
    client: fake as unknown as ImapFlow,
    resetValidity: () => {
      validity++;
    },
  };
}
const configured = { ...account, settings: { host: "imap.example", smtpHost: "smtp.example" } };

describe("IMAP/SMTP adapter", () => {
  it.each(["move", "delete"] as const)(
    "F6 returns COPYUID replacement identities for %s and can move them back",
    async (op) => {
      const server = imapServer(),
        p = new ImapMailProvider({ imapFactory: () => server.client });
      await p.connect(configured, { password: "secret" });
      const delta = (await collect(p.sync(null))).find(
        (d) => d.kind === "email" && d.op === "upsert",
      );
      if (delta?.kind !== "email" || delta.op !== "upsert") {
        throw new Error("No fixture");
      }
      const original = delta.email;
      const [moved] = await p.applyChanges([
        op === "move"
          ? { op, providerIds: [original.providerId], toMailboxProviderId: "Trash" }
          : { op, providerIds: [original.providerId] },
      ]);
      expect(moved).toMatchObject({
        op,
        providerId: original.providerId,
        newMailboxProviderId: "Trash",
        newProviderId: expect.any(String),
      });
      expect(moved!.newProviderId).not.toBe(original.providerId);
      expect(await p.getEmail(original.providerId)).toBeNull();
      expect(await p.getEmail(moved!.newProviderId!)).toMatchObject({ subject: original.subject });
      const [restored] = await p.applyChanges([
        { op: "move", providerIds: [moved!.newProviderId!], toMailboxProviderId: "INBOX" },
      ]);
      expect(await p.getEmail(restored!.newProviderId!)).toMatchObject({
        mailboxIds: expect.any(Array),
        subject: original.subject,
      });
      expect(server.messages.get("INBOX")!.size).toBe(1);
      await p.disconnect();
    },
  );

  it("F6 fails explicitly if a move omits the COPYUID map", async () => {
    const server = imapServer(),
      p = new ImapMailProvider({ imapFactory: () => server.client });
    await p.connect(configured, { password: "secret" });
    const delta = (await collect(p.sync(null))).find(
      (d) => d.kind === "email" && d.op === "upsert",
    );
    if (delta?.kind !== "email" || delta.op !== "upsert") {
      throw new Error("No fixture");
    }
    server.fake.messageMove.mockResolvedValueOnce({ uidValidity: 10n, uidMap: new Map() });
    await expect(
      p.applyChanges([
        { op: "move", providerIds: [delta.email.providerId], toMailboxProviderId: "Trash" },
      ]),
    ).rejects.toMatchObject({ code: "IMAP_UIDPLUS_REQUIRED" });
    await p.disconnect();
  });
  it.each(["store", "provider", "adapter"] as const)(
    "resolves %s reply IDs through the registry before composing MIME",
    async (kind) => {
      const server = imapServer(),
        resolveEmail = vi.fn();
      const p = createProviderRegistry({ imapFactory: () => server.client, resolveEmail }).mail(
        "imap",
      );
      await p.connect(configured, { password: "secret" });
      const delta = (await collect(p.sync(null))).find(
        (d) => d.kind === "email" && d.op === "upsert",
      );
      if (delta?.kind !== "email" || delta.op !== "upsert") {
        throw new Error("No fixture");
      }
      const original = delta.email;
      const stored = { ...original, id: "store-email-ulid", threadId: "store-thread-ulid" };
      resolveEmail.mockImplementation(async (id) => (id === stored.id ? stored : null));
      const id =
        kind === "store" ? stored.id : kind === "provider" ? original.providerId : original.id;
      const reply = await p.createDraft({ ...draft, inReplyToEmailId: id });
      expect(resolveEmail).toHaveBeenCalledWith(id);
      expect(reply.headers.inReplyTo).toBe(original.headers.messageId);
      expect(reply.headers.references).toEqual([
        ...original.headers.references,
        original.headers.messageId,
      ]);
      await p.disconnect();
    },
  );
  it("searches the initial date window, fetches matching UID pages and preserves that window in the cursor", async () => {
    const server = imapServer(),
      p = new ImapMailProvider({ imapFactory: () => server.client });
    await p.connect(configured, { password: "secret" });
    const since = "2026-01-20T13:00:00Z";
    const first = await collect(p.sync(null, { since }));
    expect(server.fake.search).toHaveBeenCalledWith({ since: new Date(since) }, { uid: true });
    expect(server.fake.fetch).toHaveBeenCalledWith("1", expect.anything(), { uid: true });
    await collect(p.sync(lastCursor(first), { since: "2026-02-01T00:00:00Z" }));
    expect(server.fake.search).toHaveBeenLastCalledWith({ since: new Date(since) }, { uid: true });
    const later = await collect(p.sync(null, { since: "2026-01-20T15:00:00Z" }));
    expect(later.filter((d) => d.kind === "email")).toHaveLength(0);
    await p.disconnect();
  });
  it("normalizes source MIME, maps flags and SPECIAL-USE, and tracks MODSEQ and expunges", async () => {
    const server = imapServer(),
      p = new ImapMailProvider({ imapFactory: () => server.client });
    await p.connect(configured, { password: "secret" });
    const first = await collect(p.sync(null)),
      email = first.find((d) => d.kind === "email" && d.op === "upsert");
    expect(email?.kind === "email" && email.op === "upsert" && email.email.subject).toBe(
      "Design review ✓",
    );
    const cursor = lastCursor(first);
    server.messages.get("INBOX")!.delete(1);
    const changes = await collect(p.sync(cursor));
    expect(changes.some((d) => d.kind === "email" && d.op === "delete")).toBe(true);
    lastCursor(changes);
    expect(
      first.some((d) => d.kind === "mailbox" && d.op === "upsert" && d.mailbox.role === "drafts"),
    ).toBe(true);
    await p.disconnect();
  });
  it("invalidates UID identities on UIDVALIDITY reset and uses CONDSTORE", async () => {
    const server = imapServer(),
      p = new ImapMailProvider({ imapFactory: () => server.client });
    await p.connect(configured, { password: "secret" });
    const deltas = await collect(p.sync(null)),
      cursor = lastCursor(deltas),
      e = deltas.find((d) => d.kind === "email" && d.op === "upsert");
    await collect(p.sync(cursor));
    expect(server.fake.fetch).toHaveBeenCalledWith(
      "1:*",
      expect.anything(),
      expect.objectContaining({ changedSince: 2n }),
    );
    server.resetValidity();
    const changes = await collect(p.sync(cursor));
    expect(changes.some((d) => d.kind === "email" && d.op === "delete")).toBe(true);
    if (e?.kind === "email" && e.op === "upsert") {
      expect(await p.getEmail(e.email.providerId)).toBeNull();
    }
  });
  it("supports flags, copy, move, draft replacement/deletion, and MIME blobs", async () => {
    const server = imapServer(),
      p = new ImapMailProvider({ imapFactory: () => server.client });
    await p.connect(configured, { password: "secret" });
    const e = (await collect(p.sync(null))).find((d) => d.kind === "email" && d.op === "upsert");
    if (e?.kind !== "email" || e.op !== "upsert") {
      throw new Error("No fixture");
    }
    expect(
      Buffer.from((await p.getBlob(e.email.attachments[0]!.blobId)).data).toString(),
    ).toContain("BEGIN:VEVENT");
    await p.applyChanges([
      {
        op: "setKeywords",
        providerIds: [e.email.providerId],
        add: ["$flagged"],
        remove: ["$seen"],
      },
      { op: "addToMailbox", providerIds: [e.email.providerId], mailboxProviderId: "Sent" },
      { op: "move", providerIds: [e.email.providerId], toMailboxProviderId: "Trash" },
    ]);
    expect(server.fake.messageFlagsAdd).toHaveBeenCalledWith(1, ["\\Flagged"], { uid: true });
    expect(server.fake.messageCopy).toHaveBeenCalled();
    expect(server.fake.messageMove).toHaveBeenCalled();
    const created = await p.createDraft(draft),
      updated = await p.updateDraft(created.providerId, { ...draft, textBody: "Updated" });
    expect(updated.textBody?.trim()).toBe("Updated");
    await p.deleteDraft(updated.providerId);
    expect(await p.getEmail(updated.providerId)).toBeNull();
  });
  it("submits SMTP with a private envelope, strips Bcc, and saves a sent copy", async () => {
    const server = imapServer(),
      sendMail = vi.fn(async () => ({ messageId: "<sent@example>" }));
    const p = new ImapMailProvider({
      imapFactory: () => server.client,
      smtpFactory: () => ({ sendMail, close() {} }),
    });
    await p.connect(configured, { password: "secret" });
    const result = await p.send({ draft: { ...draft, bcc: [{ email: "hidden@example.com" }] } });
    expect(result.providerId).toMatch(/^imap:/);
    expect(result.messageId).toBe("<sent@example>");
    const call = sendMail.mock.calls[0] as unknown as [{ raw: Buffer; envelope: { to: string[] } }];
    expect(call[0].envelope.to).toContain("hidden@example.com");
    expect(call[0].raw.toString()).not.toMatch(/^bcc:/im);
    expect(server.messages.get("Sent")!.size).toBe(1);
  });
  it("F7 reports accepted submission cleanup failures distinctly so callers cannot resend", async () => {
    const server = imapServer(),
      sendMail = vi.fn(async () => ({ messageId: "<accepted@example>" }));
    server.fake.append.mockRejectedValue(new Error("private server detail"));
    const p = new ImapMailProvider({
      imapFactory: () => server.client,
      smtpFactory: () => ({ sendMail, close() {} }),
    });
    await p.connect(configured, { password: "secret" });
    await expect(p.send({ draft })).rejects.toMatchObject({
      code: "SUBMISSION_ACCEPTED",
      messageId: "<accepted@example>",
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
  it("waits for IMAP events and aborts cleanly", async () => {
    const server = imapServer(),
      p = new ImapMailProvider({ imapFactory: () => server.client });
    await p.connect(configured, { password: "secret" });
    const wait = p.waitForChanges(new AbortController().signal);
    server.fake.emit("exists");
    await wait;
    const controller = new AbortController(),
      next = p.waitForChanges(controller.signal);
    controller.abort();
    await next;
    expect(server.fake.listenerCount("exists")).toBe(0);
  });
  it("does not leak library authentication errors and requires SMTP configuration", async () => {
    const server = imapServer();
    server.fake.connect.mockRejectedValue(new Error("password=secret"));
    const p = new ImapMailProvider({ imapFactory: () => server.client });
    await expect(p.connect(configured, { password: "secret" })).rejects.toMatchObject({
      code: "IMAP_CONNECT_FAILED",
      message: "IMAP connection or authentication failed",
    });
    const s = imapServer(),
      q = new ImapMailProvider({ imapFactory: () => s.client });
    await q.connect({ ...configured, settings: { host: "imap.example" } }, { password: "secret" });
    await expect(q.send({ draft })).rejects.toMatchObject({ code: "SMTP_NOT_CONFIGURED" });
  });
  it("maps standard and custom flags to JMAP keywords", () => {
    expect(
      imapFlagsToKeywords([
        "\\Seen",
        "\\Answered",
        "$Forwarded",
        "$Junk",
        "custom",
        "\\Deleted",
        "\\Recent",
      ]),
    ).toEqual({ $seen: true, $answered: true, $forwarded: true, $junk: true, custom: true });
  });
});
