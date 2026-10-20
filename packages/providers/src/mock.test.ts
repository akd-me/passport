import { describe, expect, it } from "vitest";
import { MockCalendarProvider, MockMailProvider } from "./mock.js";
import { account, collect, draft, eventInput, lastCursor, range } from "./test/helpers.js";

describe("MockMailProvider lifecycle", () => {
  it("has forty deterministic fixtures covering each promised scenario", async () => {
    const p = new MockMailProvider(); await p.connect(account, {}); const deltas = await collect(p.sync(null)), emails = deltas.filter(d => d.kind === "email" && d.op === "upsert").map(d => d.kind === "email" && d.op === "upsert" ? d.email : null).filter(e => e !== null);
    expect(emails).toHaveLength(40); expect(emails.filter(e => e.headers.listUnsubscribe)).toHaveLength(10); expect(emails.some(e => e.from[0]?.email === "sam@example.com")).toBe(true); expect(emails.some(e => e.from[0]?.email.includes("recruiting"))).toBe(true); expect(emails.some(e => e.verification.dkim === "fail")).toBe(true); expect(emails.filter(e => e.attachments.some(a => a.type === "text/calendar"))).toHaveLength(3);
    const p2 = new MockMailProvider(); await p2.connect(account, {}); expect(await collect(p2.sync(null))).toEqual(deltas); lastCursor(deltas);
  });
  it("has a complete keyword, mailbox, draft, send, blob, and incremental lifecycle", async () => {
    const p = new MockMailProvider(); await p.connect(account, {}); const cursor = lastCursor(await collect(p.sync(null)));
    const original = (await p.getEmail("fixture-19"))!;
    await p.applyChanges([{ op: "setKeywords", providerIds: [original.providerId], add: ["$seen", "$flagged"], remove: ["$answered"] }, { op: "addToMailbox", providerIds: [original.providerId], mailboxProviderId: "Archive" }, { op: "removeFromMailbox", providerIds: [original.providerId], mailboxProviderId: "Inbox" }]);
    expect((await p.getEmail(original.providerId))?.keywords).toMatchObject({ $seen: true, $flagged: true });
    await p.applyChanges([{ op: "move", providerIds: [original.providerId], toMailboxProviderId: "Inbox" }, { op: "delete", providerIds: [original.providerId] }]); expect((await p.getEmail(original.providerId))?.mailboxIds[0]).toContain("Trash");
    const created = await p.createDraft({ ...draft, inReplyToEmailId: original.id }); expect(created.headers.inReplyTo).toBe(original.headers.messageId);
    const updated = await p.updateDraft(created.providerId, { ...draft, textBody: "Updated" }); expect(updated.preview).toBe("Updated");
    await p.send({ draftProviderId: updated.providerId }); expect(p.sentMail).toHaveLength(1); expect(p.sentMail[0]?.keywords.$draft).toBeUndefined();
    await p.send({ draft }); expect(p.sentMail).toHaveLength(2);
    const discard = await p.createDraft(draft); await p.deleteDraft(discard.providerId); expect(await p.getEmail(discard.providerId)).toBeNull();
    const invite = (await p.getEmail("fixture-36"))!; expect(Buffer.from((await p.getBlob(invite.attachments[0]!.blobId)).data).toString()).toContain("BEGIN:VEVENT");
    const changes = await collect(p.sync(cursor)); expect(changes).toContainEqual({ kind: "email", op: "delete", providerId: discard.providerId }); lastCursor(changes);
  });
  it("returns defensive copies", async () => { const p = new MockMailProvider(); await p.connect(account, {}); const e = (await p.getEmail("fixture-01"))!; e.subject = "bad"; expect((await p.getEmail("fixture-01"))?.subject).not.toBe("bad"); });
  it("injects attachment bytes for test drafts and returns defensive blob copies", async () => {
    const p = new MockMailProvider({ fixtures: false }); await p.connect(account, {}); const blobId = p.injectBlob(Buffer.from("report"), "text/plain");
    const e = await p.createDraft({ ...draft, attachments: [{ blobId, name: "report.txt", type: "text/plain" }] }); expect(e.attachments[0]?.size).toBe(6);
    const first = await p.getBlob(blobId); first.data[0] = 0; expect(Buffer.from((await p.getBlob(blobId)).data).toString()).toBe("report");
  });
  it("wakes on injection, cancellation, and disconnect", async () => {
    const p = new MockMailProvider({ fixtures: false }); await p.connect(account, {});
    const wait = p.waitForChanges(new AbortController().signal); p.injectEmail({ subject: "Arrival" }); await wait;
    const controller = new AbortController(), abort = p.waitForChanges(controller.signal); controller.abort(); await abort;
    const disconnected = p.waitForChanges(new AbortController().signal); await p.disconnect(); await disconnected;
  });
  it("never skips arrivals while a snapshot is being consumed", async () => {
    const p = new MockMailProvider({ fixtures: false }); await p.connect(account, {}); const iterator = p.sync(null)[Symbol.asyncIterator](); await iterator.next(); const added = p.injectEmail({ subject: "Concurrent arrival" });
    const rest = await collect({ [Symbol.asyncIterator]: () => iterator }); const cursor = lastCursor(rest);
    const changes = await collect(p.sync(cursor)); expect(changes.some(d => d.kind === "email" && d.op === "upsert" && d.email.providerId === added.providerId)).toBe(true);
  });
  it("rejects wrong accounts, missing emails, malformed cursors, and ambiguous sends", async () => { const p = new MockMailProvider(); await p.connect(account, {}); await expect(p.send({ draft, draftProviderId: "x" })).rejects.toMatchObject({ code: "INVALID_SEND" }); await expect(p.createDraft({ ...draft, accountId: "other" })).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" }); await expect(collect(p.sync("invalid"))).rejects.toMatchObject({ code: "INVALID_CURSOR" }); await expect(p.applyChanges([{ op: "delete", providerIds: ["missing"] }])).rejects.toMatchObject({ code: "NOT_FOUND" }); });
});

describe("MockCalendarProvider", () => {
  it("implements calendar CRUD, responses, incremental deletion, and free/busy", async () => {
    const p = new MockCalendarProvider(); await p.connect(account, {}); expect(await p.listCalendars()).toHaveLength(1); const cursor = lastCursor(await collect(p.sync(null)));
    const e = await p.createEvent(eventInput); const updated = await p.updateEvent(e.providerId, { title: "Updated" }); expect(updated.title).toBe("Updated"); await p.respond(e.providerId, "accepted"); expect((await p.freeBusy(range)).length).toBeGreaterThan(0);
    await p.deleteEvent(e.providerId); const deltas = await collect(p.sync(cursor)); expect(deltas).toContainEqual({ kind: "event", op: "delete", providerId: e.providerId }); lastCursor(deltas);
    await p.disconnect(); await expect(p.listCalendars()).rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });
  it("delivers incremental events moving outside a requested range", async () => { const p = new MockCalendarProvider(); await p.connect(account, {}); const e = await p.createEvent(eventInput), cursor = lastCursor(await collect(p.sync(null))); await p.updateEvent(e.providerId, { start: "2027-01-01T00:00:00Z", end: "2027-01-01T01:00:00Z" }); const changes = await collect(p.sync(cursor, range)); expect(changes.some(d => d.kind === "event" && d.op === "upsert" && d.event.providerId === e.providerId)).toBe(true); });
});
