import type { Email } from "@passport/types";
import { describe, expect, it } from "vitest";
import { email, request, setup } from "./testing/fixtures.js";

/** Model actual membership so a copy/remove sequence cannot pass as a folder move. */
async function mailboxFixture(labels: boolean) {
  const fixture = await setup({ labels });
  const { store, mail } = fixture;
  const original = email({
    mailboxIds: labels ? ["inbox", "tag"] : ["inbox"],
    keywords: { $seen: true, $flagged: true },
  });
  await store.emails.upsertMany([original]);
  const remote = new Map<string, { mailboxIds: string[]; keywords: Email["keywords"] }>();
  const seed = async (message: Email) => {
    await store.emails.upsertMany([message]);
    remote.set(message.providerId, {
      mailboxIds: await Promise.all(
        message.mailboxIds.map(async (id) => (await store.mailboxes.get(id))!.providerId),
      ),
      keywords: { ...message.keywords },
    });
  };
  await seed(original);
  const recordChanges = mail.applyChanges.bind(mail);
  mail.applyChanges = async (changes) => {
    await recordChanges(changes);
    for (const change of changes)
      for (const id of change.providerIds) {
        const message = remote.get(id)!;
        if (change.op === "setKeywords") {
          for (const key of change.add ?? []) message.keywords[key] = true;
          for (const key of change.remove ?? []) delete message.keywords[key];
        } else if (change.op === "move") message.mailboxIds = [change.toMailboxProviderId];
        else if (!labels)
          throw new Error("Folder provider requires move; add copies and remove can trash mail");
        else if (change.op === "addToMailbox")
          message.mailboxIds = [...new Set([...message.mailboxIds, change.mailboxProviderId])];
        else if (change.op === "removeFromMailbox")
          message.mailboxIds = message.mailboxIds.filter((box) => box !== change.mailboxProviderId);
        else throw new Error("Must never purge mail");
      }
  };
  const expectMirror = async (id = original.id) => {
    const message = (await store.emails.get(id))!;
    expect([...remote.get(message.providerId)!.mailboxIds].sort()).toEqual(
      (
        await Promise.all(
          message.mailboxIds.map(async (box) => (await store.mailboxes.get(box))!.providerId),
        )
      ).sort(),
    );
    expect(remote.get(message.providerId)!.keywords).toEqual(message.keywords);
  };
  return { ...fixture, original, remote, seed, expectMirror };
}

describe("provider-aware mailbox actions", () => {
  it.each(["archive", "move", "delete"] as const)(
    "F6 persists replacement provider IDs for %s and moves the replacement back on undo",
    async (type) => {
      const { executor, store, mail } = await setup({ labels: false });
      await store.emails.upsertMany([email({ mailboxIds: ["inbox"] })]);
      const live = new Set(["remote-email"]);
      let sequence = 0;
      mail.applyChanges = async (changes) => {
        mail.changes.push(structuredClone(changes));
        return changes.flatMap((change) =>
          change.providerIds.map((providerId) => {
            expect(live.has(providerId)).toBe(true);
            if (change.op !== "move") throw new Error("Expected a move");
            live.delete(providerId);
            const newProviderId = `replacement-${++sequence}`;
            live.add(newProviderId);
            return {
              op: change.op,
              providerId,
              newProviderId,
              newMailboxProviderId: change.toMailboxProviderId,
            };
          }),
        );
      };
      const action = await executor.submit(
        request(type, { emailIds: ["email"], toMailboxId: "trash" }),
      );
      expect((await store.emails.get("email"))?.providerId).toBe("replacement-1");
      expect(action.inverse?.params).toMatchObject({
        __passportPolicyInverse: {
          emails: [{ providerId: "replacement-1", mailboxIds: ["inbox"] }],
        },
      });
      // Undo reads its durable snapshot, including after a process restart.
      await store.actions.update(action.id, {
        inverse: JSON.parse(JSON.stringify(action.inverse)),
      });
      await executor.undo(action.id);
      expect(mail.changes[1]).toEqual([
        { op: "move", providerIds: ["replacement-1"], toMailboxProviderId: "remote-inbox" },
      ]);
      expect(await store.emails.get("email")).toMatchObject({
        providerId: "replacement-2",
        mailboxIds: ["inbox"],
      });
    },
  );
  it("archives label mail without an archive mailbox and restores every prior label", async () => {
    const { executor, store, mail, expectMirror } = await mailboxFixture(true);
    await store.mailboxes.deleteMany(["archive"]);
    const archived = await executor.submit(request("archive", { emailIds: ["email"] }));
    expect(mail.changes[0]).toEqual([
      { op: "removeFromMailbox", providerIds: ["remote-email"], mailboxProviderId: "remote-inbox" },
    ]);
    expect((await store.emails.get("email"))!.mailboxIds).toEqual(["tag"]);
    await expectMirror();
    await executor.undo(archived.id);
    expect(mail.changes[1]).toEqual([
      { op: "addToMailbox", providerIds: ["remote-email"], mailboxProviderId: "remote-inbox" },
    ]);
    // Compare membership rather than label order, which has no provider meaning.
    expect((await store.emails.get("email"))!.mailboxIds).toEqual(["inbox", "tag"]);
    await expectMirror();
  });

  it.each(["archive", "all", "name"] as const)(
    "moves folder mail to the %s archive fallback and undoes via move",
    async (fallback) => {
      const { executor, store, mail, expectMirror } = await mailboxFixture(false);
      const archive = (await store.mailboxes.get("archive"))!;
      await store.mailboxes.upsertMany([
        { ...archive, role: fallback === "archive" ? "archive" : null, name: "Filed" },
        { ...archive, id: "all", providerId: "remote-all", role: "all", name: "All mail" },
        { ...archive, id: "named", providerId: "remote-named", role: null, name: "Archive" },
      ]);
      if (fallback === "name") await store.mailboxes.deleteMany(["all"]);
      const action = await executor.submit(request("archive", { emailIds: ["email"] }));
      const destination = fallback === "name" ? "named" : fallback;
      expect(mail.changes[0]).toEqual([
        { op: "move", providerIds: ["remote-email"], toMailboxProviderId: `remote-${destination}` },
      ]);
      expect((await store.emails.get("email"))!.mailboxIds).toEqual([destination]);
      await expectMirror();
      await store.actions.update(action.id, {
        inverse: JSON.parse(JSON.stringify(action.inverse)),
      });
      await executor.undo(action.id);
      expect(mail.changes[1]).toEqual([
        { op: "move", providerIds: ["remote-email"], toMailboxProviderId: "remote-inbox" },
      ]);
      await expectMirror();
    },
  );

  it("fails folder archive before changing mail when no archive destination exists", async () => {
    const { executor, store, mail, original, expectMirror, bus } = await mailboxFixture(false);
    await store.mailboxes.deleteMany(["archive"]);
    await expect(
      executor.submit(request("archive", { emailIds: ["email"] })),
    ).rejects.toMatchObject({
      code: "ARCHIVE_MAILBOX_MISSING",
      message: expect.stringContaining("refusing to remove mail"),
    });
    expect(mail.changes).toEqual([]);
    expect(await store.emails.get("email")).toEqual(original);
    expect((await store.actions.query({ status: ["failed"] })).items).toHaveLength(1);
    expect(bus.events.at(-1)?.type).toBe("action.failed");
    await expectMirror();
  });

  it.each([undefined, "tag"])(
    "unarchives folder mail by moving to %s and restores the archive on undo",
    async (toMailboxId) => {
      const { executor, store, mail, seed, expectMirror } = await mailboxFixture(false);
      await seed(email({ mailboxIds: ["archive"] }));
      const action = await executor.submit(
        request("unarchive", { emailIds: ["email"], toMailboxId }),
      );
      const destination = toMailboxId ?? "inbox";
      expect(mail.changes[0]).toEqual([
        { op: "move", providerIds: ["remote-email"], toMailboxProviderId: `remote-${destination}` },
      ]);
      expect((await store.emails.get("email"))!.mailboxIds).toEqual([destination]);
      await expectMirror();
      await executor.undo(action.id);
      expect(mail.changes[1]).toEqual([
        { op: "move", providerIds: ["remote-email"], toMailboxProviderId: "remote-archive" },
      ]);
      await expectMirror();
    },
  );

  it.each(["move", "delete"] as const)(
    "uses moves in both directions for folder %s",
    async (type) => {
      const { executor, store, mail, expectMirror } = await mailboxFixture(false);
      const action = await executor.submit(
        request(type, { emailIds: ["email"], toMailboxId: "trash" }),
      );
      expect(mail.changes[0]).toEqual([
        { op: "move", providerIds: ["remote-email"], toMailboxProviderId: "remote-trash" },
      ]);
      expect((await store.emails.get("email"))!.mailboxIds).toEqual(["trash"]);
      await expectMirror();
      await executor.undo(action.id);
      expect(mail.changes[1]).toEqual([
        { op: "move", providerIds: ["remote-email"], toMailboxProviderId: "remote-inbox" },
      ]);
      await expectMirror();
    },
  );

  it("restores each folder message to its own previous mailbox from the inverse snapshot", async () => {
    const { executor, mail, seed, expectMirror } = await mailboxFixture(false);
    await seed(email({ id: "second", providerId: "remote-second", mailboxIds: ["tag"] }));
    const action = await executor.submit(request("archive", { emailIds: ["email", "second"] }));
    await expectMirror();
    await expectMirror("second");
    await executor.undo(action.id);
    expect(mail.changes[1]).toEqual([
      { op: "move", providerIds: ["remote-email"], toMailboxProviderId: "remote-inbox" },
      { op: "move", providerIds: ["remote-second"], toMailboxProviderId: "remote-tag" },
    ]);
    await expectMirror();
    await expectMirror("second");
  });

  it("keeps the store unchanged when a folder move fails", async () => {
    const { executor, store, mail, original, expectMirror } = await mailboxFixture(false);
    mail.failure = new Error("Move failed");
    await expect(executor.submit(request("archive", { emailIds: ["email"] }))).rejects.toThrow(
      "Move failed",
    );
    expect(await store.emails.get("email")).toEqual(original);
    await expectMirror();
  });
});
