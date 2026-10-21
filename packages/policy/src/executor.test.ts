import type { ActionParams, Email, Person } from "@passport/types";
import { describe, expect, it, vi } from "vitest";
import {
  calendarEvent,
  draft,
  email,
  matter,
  person,
  request,
  setup,
  trustState,
} from "./testing/fixtures.js";

describe("mail action lifecycle", () => {
  it("allows archive, logs before mutation, and restores exact mailboxIds on undo", async () => {
    const { executor, store, mail, bus } = await setup();
    const initial = await store.emails.get("email");
    const record = await executor.submit(request("archive", { emailIds: ["email"] }));
    expect(record.status).toBe("executed");
    expect(record.inverse).not.toBeNull();
    expect((await store.emails.get("email"))?.mailboxIds).toEqual(["tag", "archive"]);
    expect(mail.changes[0]).toEqual([
      { op: "addToMailbox", providerIds: ["remote-email"], mailboxProviderId: "remote-archive" },
      { op: "removeFromMailbox", providerIds: ["remote-email"], mailboxProviderId: "remote-inbox" },
    ]);
    expect((await executor.undo(record.id)).status).toBe("undone");
    expect((await store.emails.get("email"))?.mailboxIds).toEqual(initial?.mailboxIds);
    const log = await store.actions.query({});
    expect(log.items).toHaveLength(2);
    expect(log.items.find((item) => item.id !== record.id)).toMatchObject({
      status: "executed",
      inverse: expect.any(Object),
    });
    expect(
      bus.events.filter((event) => event.type.startsWith("action.")).map((event) => event.type),
    ).toEqual([
      "action.decided",
      "action.executed",
      "action.decided",
      "action.executed",
      "action.undone",
    ]);
    await expect(executor.undo(record.id)).rejects.toMatchObject({ code: "INVALID_ACTION_STATE" });
  });

  it.each([
    "label",
    "unlabel",
    "unarchive",
    "mark_read",
    "mark_unread",
    "flag",
    "unflag",
    "move",
    "delete",
  ] as const)("dispatches %s and restores keywords/mailboxes", async (type) => {
    const { executor, store } = await setup();
    await store.emails.upsertMany([
      email({ keywords: { $seen: true, $flagged: true, custom: true } }),
    ]);
    const before = await store.emails.get("email");
    const params =
      type === "label" || type === "unlabel"
        ? { emailIds: ["email"], label: "tag" }
        : type === "move"
          ? { emailIds: ["email"], toMailboxId: "trash" }
          : { emailIds: ["email"] };
    const action = await executor.submit(request(type, params));
    expect(action.status).toBe("executed");
    await executor.undo(action.id);
    expect(await store.emails.get("email")).toMatchObject({
      keywords: before!.keywords,
      mailboxIds: before!.mailboxIds,
    });
  });

  it("captures prior state at execution after approval, rather than at proposal", async () => {
    const { executor, policy, store } = await setup();
    await policy.pinLevel("other", "supervised");
    const proposed = await executor.submit(request("archive", { emailIds: ["email"] }));
    await store.emails.patchMany(["email"], { mailboxIds: ["inbox", "sent"] });
    await executor.approve(proposed.id);
    await executor.undo(proposed.id);
    expect((await store.emails.get("email"))?.mailboxIds).toEqual(["inbox", "sent"]);
  });

  it("moves delete to trash rather than purging and permits undo", async () => {
    const { executor, mail, store } = await setup();
    const record = await executor.submit(request("delete", { emailIds: ["email"] }));
    expect(mail.changes[0]).toEqual([
      { op: "move", providerIds: ["remote-email"], toMailboxProviderId: "remote-trash" },
    ]);
    expect((await store.emails.get("email"))?.mailboxIds).toEqual(["trash"]);
    await executor.undo(record.id);
    expect((await store.emails.get("email"))?.mailboxIds).toEqual(["inbox", "tag"]);
  });

  it("denies external-agent delete without touching provider or mail state", async () => {
    const { executor, mail, store } = await setup();
    const before = await store.emails.get("email");
    const denied = await executor.submit(
      request("delete", { emailIds: ["email"] }, { actor: { kind: "external-agent", id: "mcp" } }),
    );
    expect(denied).toMatchObject({
      status: "rejected",
      decision: { outcome: "deny" },
      error: expect.stringContaining("external agent"),
    });
    expect(mail.changes).toEqual([]);
    expect(await store.emails.get("email")).toEqual(before);
    await expect(executor.approve(denied.id)).rejects.toMatchObject({
      code: "INVALID_ACTION_STATE",
    });
  });

  it("persists provider failures, emits action.failed, and rethrows the original error", async () => {
    const { executor, store, mail, bus } = await setup();
    const failure = Object.assign(new Error("Provider failed"), { code: "REMOTE_FAILURE" });
    mail.failure = failure;
    await expect(executor.submit(request("archive", { emailIds: ["email"] }))).rejects.toBe(
      failure,
    );
    const records = await store.actions.query({ status: ["failed"] });
    expect(records.items[0]).toMatchObject({
      error: "Provider failed",
      inverse: expect.any(Object),
    });
    expect((await store.emails.get("email"))?.mailboxIds).toEqual(["inbox", "tag"]);
    expect(bus.events.at(-1)?.type).toBe("action.failed");
  });
});

describe("delayed outbox", () => {
  it("holds send and permits cancellation without sending", async () => {
    const { executor, mail, store, bus } = await setup();
    const held = await executor.submit(request("send", { draft }));
    expect(held).toMatchObject({ status: "held", holdUntil: "2026-10-20T12:05:00.000Z" });
    expect(mail.sends).toEqual([]);
    const cancelled = await executor.cancelHold(held.id);
    expect(cancelled).toMatchObject({ status: "rejected", holdUntil: null });
    expect(await executor.releaseDue("2026-10-21T12:00:00.000Z")).toEqual([]);
    expect(mail.sends).toEqual([]);
    expect((await store.actions.get(held.id))?.error).toContain("Cancelled");
    expect(bus.events.some((event) => event.type === "action.held")).toBe(true);
    await expect(executor.cancelHold(held.id)).rejects.toMatchObject({
      code: "INVALID_ACTION_STATE",
    });
  });

  it("releases a due send once, marks it irreversible, and rejects undo", async () => {
    const { executor, mail, store, bus } = await setup();
    const held = await executor.submit(request("send", { draft }));
    expect(await executor.releaseDue("2026-10-20T12:04:59.000Z")).toEqual([]);
    mail.sentEmail = email({ id: "sent", providerId: "sent-1", mailboxIds: ["sent"] });
    const [executed] = await executor.releaseDue(held.holdUntil!);
    expect(executed).toMatchObject({
      status: "executed",
      inverse: null,
      holdUntil: null,
      decision: { reversibility: "irreversible" },
    });
    expect(mail.sends).toEqual([{ draft }]);
    expect(await store.emails.get("sent")).not.toBeNull();
    expect(await executor.releaseDue("2026-10-21T12:00:00.000Z")).toEqual([]);
    expect(mail.sends).toHaveLength(1);
    await expect(executor.undo(held.id)).rejects.toMatchObject({ code: "IRREVERSIBLE_ACTION" });
    expect(bus.events.at(-1)?.type).toBe("action.executed");
  });

  it("holds approved sends even if a human explicitly approved them", async () => {
    const { executor, policy, mail, store } = await setup();
    await policy.pinLevel("other", "supervised");
    const proposed = await executor.submit(request("send", { draft }));
    expect(proposed.status).toBe("proposed");
    expect((await executor.approve(proposed.id)).status).toBe("held");
    expect(mail.sends).toEqual([]);
    expect((await store.trust.get("other"))?.approvals).toBe(16);
  });

  it("executes a permitted send with a disabled outbox and preserves the inverse invariant", async () => {
    const { executor, policy, mail } = await setup();
    await policy.setConfig({ outboxHoldMinutes: 0 });
    expect(await executor.submit(request("send", { draft }))).toMatchObject({
      status: "executed",
      inverse: null,
      decision: { reversibility: "irreversible" },
    });
    expect(mail.sends).toHaveLength(1);
  });

  it("F3 sends the saved draft snapshot and removes the stale provider draft after sending", async () => {
    const { executor, store, mail } = await setup();
    await store.emails.upsertMany([
      email({ id: "draft", providerId: "remote-draft", keywords: { $draft: true } }),
    ]);
    const held = await executor.submit(request("send", { draftEmailId: "draft" }));
    await executor.releaseDue(held.holdUntil!);
    expect(mail.sends).toEqual([{ draft: held.approvedSnapshot }]);
    expect(mail.drafts).toContainEqual({ operation: "delete", providerId: "remote-draft" });
    expect(await store.emails.get("draft")).toBeNull();
  });

  it("serializes duplicate release calls and cancellation against release", async () => {
    const { executor, mail } = await setup();
    const first = await executor.submit(request("send", { draft }));
    const releases = await Promise.all([
      executor.releaseDue(first.holdUntil!),
      executor.releaseDue(first.holdUntil!),
    ]);
    expect(releases.flat()).toHaveLength(1);
    expect(mail.sends).toHaveLength(1);
    const second = await executor.submit(request("send", { draft }));
    const [cancelled, due] = await Promise.all([
      executor.cancelHold(second.id),
      executor.releaseDue(second.holdUntil!),
    ]);
    expect(cancelled.status).toBe("rejected");
    expect(due).toEqual([]);
    expect(mail.sends).toHaveLength(1);
  });

  it("continues releasing later due actions after a failure, then rethrows", async () => {
    const { executor, store, mail } = await setup();
    const invalid = await executor.submit(request("send", { draft }));
    await store.actions.update(invalid.id, { request: request("send", {}) });
    const valid = await executor.submit(request("send", { draft }));
    await expect(executor.releaseDue(valid.holdUntil!)).rejects.toMatchObject({
      code: "INVALID_PARAMS",
    });
    expect((await store.actions.get(invalid.id))?.status).toBe("failed");
    expect((await store.actions.get(valid.id))?.status).toBe("executed");
    expect(mail.sends).toHaveLength(1);
  });
});

describe("human decisions and drafts", () => {
  it("approves an edited proposal, lowers trust by text distance, and logs all events", async () => {
    const { executor, store, policy, mail, bus } = await setup();
    await store.trust.upsert(trustState({ score: 0.7, pinnedLevel: "supervised" }));
    const proposed = await executor.submit(request("draft_create", { draft }));
    expect(bus.events.at(-1)?.type).toBe("action.proposed");
    const edited = {
      ...proposed.request,
      params: {
        draft: { ...draft, subject: "New subject", textBody: "A completely different answer." },
      },
    };
    const executed = await executor.approve(proposed.id, edited);
    expect(executed.status).toBe("executed");
    expect(executed.editDistance).toBeGreaterThan(0.25);
    expect((await policy.getTrustFor("other")).score).toBeCloseTo(
      0.7 - 0.04 * executed.editDistance!,
    );
    expect(mail.drafts[0]?.draft).toEqual(edited.params.draft);
    await expect(executor.approve(proposed.id)).rejects.toMatchObject({
      code: "INVALID_ACTION_STATE",
    });
    await executor.undo(proposed.id);
    expect(await store.emails.get(executed.result!.emailId as string)).toBeNull();
  });

  it("restores updated and deleted drafts, preserving local identity", async () => {
    const { executor, store, mail } = await setup();
    const original = email({
      id: "draft",
      providerId: "remote-draft",
      keywords: { $draft: true },
      textBody: "Original",
    });
    await store.emails.upsertMany([original]);
    const updated = await executor.submit(
      request("draft_update", { draftEmailId: "draft", draft: { ...draft, textBody: "Updated" } }),
    );
    expect((await store.emails.get("draft"))?.textBody).toBe("Updated");
    await executor.undo(updated.id);
    expect((await store.emails.get("draft"))?.textBody).toBe("Original");
    const deleted = await executor.submit(request("draft_delete", { draftEmailId: "draft" }));
    expect(await store.emails.get("draft")).toBeNull();
    await executor.undo(deleted.id);
    expect(await store.emails.get("draft")).toMatchObject({
      id: "draft",
      textBody: "Original",
      providerId: expect.stringContaining("remote-draft-"),
    });
    expect(mail.drafts.map((call) => call.operation)).toEqual([
      "update",
      "update",
      "delete",
      "create",
    ]);
  });

  it("rejects proposals with trust feedback and a decided event", async () => {
    const { executor, policy, bus } = await setup();
    await policy.pinLevel("other", "supervised");
    const proposed = await executor.submit(request("archive", { emailIds: ["email"] }));
    expect(await executor.reject(proposed.id, "Keep this")).toMatchObject({
      status: "rejected",
      error: "Keep this",
    });
    expect((await policy.getTrustFor("other")).score).toBeCloseTo(0.8);
    expect(bus.events.at(-1)?.type).toBe("action.decided");
    await expect(executor.reject(proposed.id)).rejects.toMatchObject({
      code: "INVALID_ACTION_STATE",
    });
  });

  it("rejects edits that replace the action type or actor", async () => {
    const { executor, policy } = await setup();
    await policy.pinLevel("other", "supervised");
    const proposed = await executor.submit(request("archive", { emailIds: ["email"] }));
    await expect(
      executor.approve(proposed.id, request("delete", { emailIds: ["email"] })),
    ).rejects.toMatchObject({ code: "INVALID_EDIT" });
    await expect(
      executor.approve(proposed.id, { ...proposed.request, actor: { kind: "human", id: "user" } }),
    ).rejects.toMatchObject({ code: "INVALID_EDIT" });
  });

  it("rechecks the external ceiling before approving a previously proposed action", async () => {
    const { executor, policy, mail } = await setup();
    await policy.setConfig({ externalAgentCeiling: "auto_accept_edits" });
    const proposed = await executor.submit(
      request("send", { draft }, { actor: { kind: "external-agent", id: "mcp" } }),
    );
    expect(proposed.status).toBe("proposed");
    await policy.setConfig({ externalAgentCeiling: "supervised" });
    await expect(executor.approve(proposed.id)).rejects.toMatchObject({ code: "ACTION_DENIED" });
    expect(mail.sends).toEqual([]);
  });
});

describe("calendar dispatch", () => {
  it("creates and undoes an event through CalendarProvider", async () => {
    const { executor, store, calendar } = await setup();
    const { id: _id, providerId: _providerId, updatedAt: _updatedAt, ...event } = calendarEvent();
    const created = await executor.submit(request("calendar_create", { event }));
    expect((await store.events.get("event"))?.title).toBe("Lunch");
    await executor.undo(created.id);
    expect(await store.events.get("event")).toBeNull();
    expect(calendar.calls.map((call) => call.operation)).toEqual(["create", "delete"]);
  });

  it("updates and restores an event, and mirrors respond/delete after provider success", async () => {
    const { executor, store, calendar } = await setup();
    await store.events.upsertMany([calendarEvent()]);
    const updated = await executor.submit(
      request("calendar_update", { eventId: "event", patch: { title: "Dinner" } }),
    );
    expect((await store.events.get("event"))?.title).toBe("Dinner");
    await executor.undo(updated.id);
    expect((await store.events.get("event"))?.title).toBe("Lunch");
    const response = await executor.submit(
      request("calendar_respond", { eventId: "event", status: "accepted" }),
    );
    expect(response.inverse).toBeNull();
    expect((await store.events.get("event"))?.myStatus).toBe("accepted");
    const deleted = await executor.submit(request("calendar_delete", { eventId: "event" }));
    expect(deleted.status).toBe("executed");
    expect(deleted.inverse).toBeNull();
    expect(await store.events.get("event")).toBeNull();
    expect(calendar.calls.map((call) => call.operation)).toEqual([
      "update",
      "update",
      "respond",
      "delete",
    ]);
  });

  it("holds a calendar proposal and sends its draft only after release", async () => {
    const { executor, mail } = await setup();
    const held = await executor.submit(request("calendar_propose", { draft, slots: [] }));
    expect(held.status).toBe("held");
    await executor.releaseDue(held.holdUntil!);
    expect(mail.sends).toEqual([{ draft }]);
  });
});

describe("internal store actions", () => {
  it("creates a person from an agent snapshot and persists a deletion inverse through JSON", async () => {
    const { executor, store, mail, calendar } = await setup();
    const input = person({ id: "new-person", relationship: "stranger", notes: "New contact" });
    const created = await executor.submit(
      request("person_update", { personId: input.id, patch: input }, { category: "matters" }),
    );
    expect(created).toMatchObject({
      status: "executed",
      result: { personId: input.id },
      decision: { reversibility: "reversible" },
      inverse: { type: "person_update" },
    });
    expect(await store.people.get(input.id)).toEqual(input);
    await store.actions.update(created.id, {
      inverse: JSON.parse(JSON.stringify(created.inverse)),
    });
    await executor.undo(created.id);
    expect(await store.people.get(input.id)).toBeNull();
    expect(await store.people.getByEmail(input.primaryEmail)).toBeNull();
    expect(await store.people.list()).toEqual([]);
    expect((await store.actions.query({})).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.id, status: "undone" }),
        expect.objectContaining({
          status: "executed",
          result: { deletedPersonId: input.id },
          inverse: expect.any(Object),
        }),
      ]),
    );
    expect(mail.changes).toEqual([]);
    expect(calendar.calls).toEqual([]);
  });

  it("restores an existing person exactly when a complete agent snapshot updates it without delete support", async () => {
    const { executor, store, setTime } = await setup();
    const original = person({ notes: "Prior notes", avatarUrl: "avatar.png" });
    await store.people.upsert(original);
    delete store.people.delete;
    setTime("2026-10-21T12:00:00.000Z");
    const updated = await executor.submit(
      request(
        "person_update",
        {
          personId: original.id,
          patch: {
            ...original,
            notes: "Updated notes",
            relationship: "service",
            verification: "blue",
            stats: { sent: 1, received: 5, lastContactAt: null },
          },
        },
        { category: "matters" },
      ),
    );
    expect(await store.people.get(original.id)).toMatchObject({
      relationship: "service",
      verification: "blue",
      notes: "Updated notes",
    });
    await executor.undo(updated.id);
    expect(await store.people.get(original.id)).toEqual(original);
  });

  it("fails a partial patch for a missing person with a clear logged error", async () => {
    const { executor, store } = await setup();
    await expect(
      executor.submit(
        request("person_update", { personId: "missing", patch: { displayName: "Missing" } }),
      ),
    ).rejects.toMatchObject({
      code: "PERSON_NOT_FOUND",
      message: expect.stringContaining("complete Person patch"),
    });
    expect(await store.people.get("missing")).toBeNull();
    expect((await store.actions.query({ status: ["failed"] })).items[0]?.error).toContain(
      "complete Person patch",
    );
  });

  it.each(["stats", "createdAt", "emails"] as const)(
    "does not treat a person missing %s as complete",
    async (field) => {
      const { executor, store } = await setup();
      const patch: Partial<Person> = person();
      delete patch[field];
      await expect(
        executor.submit(request("person_update", { personId: "person", patch })),
      ).rejects.toThrow();
      expect(await store.people.list()).toEqual([]);
    },
  );

  it("rejects person creation before mutation when a store cannot delete it on undo", async () => {
    const { executor, store } = await setup();
    delete store.people.delete;
    await expect(
      executor.submit(request("person_update", { personId: "person", patch: person() })),
    ).rejects.toMatchObject({ code: "PERSON_DELETE_UNSUPPORTED" });
    expect(await store.people.list()).toEqual([]);
  });

  it("rejects mismatched person ids and external-agent identity snapshots", async () => {
    const { executor, store } = await setup();
    await expect(
      executor.submit(
        request("person_update", { personId: "person", patch: person({ id: "other" }) }),
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
    await expect(
      executor.submit(
        request(
          "person_update",
          { personId: "person", patch: person() },
          { actor: { kind: "external-agent", id: "mcp" } },
        ),
      ),
    ).rejects.toMatchObject({ code: "PROTECTED_IDENTITY" });
    await expect(
      executor.submit(
        request("person_update", { personId: "person", patch: { relationship: "known" } }),
      ),
    ).rejects.toMatchObject({ code: "PROTECTED_IDENTITY" });
    expect(await store.people.list()).toEqual([]);
  });

  it.each(["matter_create", "matter_attach"] as const)(
    "applies %s emailPatch and restores each email independently through a persisted inverse",
    async (type) => {
      const { executor, store } = await setup();
      const before = [
        email({ matterId: "previous-matter", category: "scheduling", personIds: ["old-person"] }),
        email({
          id: "second-email",
          providerId: "remote-second",
          matterId: null,
          category: null,
          personIds: [],
        }),
      ];
      await store.emails.upsertMany(before);
      await store.people.upsert(person());
      const originalMatter = matter();
      if (type === "matter_attach") {
        await store.matters.upsert(originalMatter);
      }
      const emailIds = before.map((email) => email.id);
      const emailPatch = { category: "receipts", personIds: ["person"] } as const;
      const params: (ActionParams["matter_create"] | ActionParams["matter_attach"]) & {
        emailPatch: Partial<Pick<Email, "category" | "personIds">>;
      } =
        type === "matter_create"
          ? {
              matter: {
                title: "Purchase",
                summary: "Receipt",
                status: "active",
                emailIds,
                eventIds: [],
                personIds: ["person"],
              },
              emailPatch: { ...emailPatch, personIds: ["person"] },
            }
          : {
              matterId: "matter",
              emailIds,
              personIds: ["person"],
              emailPatch: { ...emailPatch, personIds: ["person"] },
            };
      const created = await executor.submit(request(type, params, { category: "matters" }));
      const matterId = created.result!.matterId as string;
      expect(created.status).toBe("executed");
      expect(created.inverse).not.toBeNull();
      expect(await store.matters.get(matterId)).toMatchObject({ emailIds, personIds: ["person"] });
      if (type === "matter_create") {
        expect(created.result!.matter).toEqual(await store.matters.get(matterId));
      }
      for (const id of emailIds) {
        expect(await store.emails.get(id)).toMatchObject({ matterId, ...emailPatch });
      }
      expect((await store.actions.get(created.id))?.result).toEqual(created.result);
      await store.actions.update(created.id, {
        inverse: JSON.parse(JSON.stringify(created.inverse)),
      });
      // Undo owns the matter metadata, so unrelated mail changes made later survive.
      await store.emails.patchMany(["email"], {
        keywords: { $seen: true },
        mailboxIds: ["archive"],
      });
      await executor.undo(created.id);
      expect(await store.emails.get("email")).toEqual({
        ...before[0],
        keywords: { $seen: true },
        mailboxIds: ["archive"],
      });
      expect(await store.emails.get("second-email")).toEqual(before[1]);
      expect(await store.matters.get(matterId)).toEqual(
        type === "matter_create" ? null : originalMatter,
      );
    },
  );

  it.each(["matter_create", "matter_attach"] as const)(
    "rolls back %s when email metadata writes fail after a partial write",
    async (type) => {
      const { executor, store } = await setup();
      await store.emails.patchMany(["email"], {
        matterId: "previous-matter",
        category: "other",
        personIds: ["old-person"],
      });
      const before = await store.emails.get("email");
      const originalMatter = matter();
      if (type === "matter_attach") {
        await store.matters.upsert(originalMatter);
      }
      const patchMany = store.emails.patchMany.bind(store.emails);
      const failure = new Error("Email metadata write failed");
      vi.spyOn(store.emails, "patchMany").mockImplementationOnce(async (ids, patch) => {
        await patchMany(ids, patch);
        throw failure;
      });
      const params =
        type === "matter_create"
          ? {
              matter: {
                title: "Trip",
                summary: "",
                status: "active" as const,
                emailIds: ["email"],
                eventIds: [],
                personIds: [],
              },
            }
          : { matterId: "matter", emailIds: ["email"] };
      const extended = { ...params, emailPatch: { category: "receipts" as const, personIds: [] } };
      await expect(executor.submit(request(type, extended))).rejects.toBe(failure);
      expect(await store.emails.get("email")).toEqual(before);
      expect(await store.matters.list()).toEqual(type === "matter_create" ? [] : [originalMatter]);
      expect((await store.actions.query({ status: ["failed"] })).items[0]).toMatchObject({
        error: failure.message,
        inverse: expect.any(Object),
      });
    },
  );

  it("ignores unsupported emailPatch fields and preserves metadata that was omitted", async () => {
    const { executor, store } = await setup();
    await store.matters.upsert(matter());
    await store.emails.patchMany(["email"], { category: "scheduling", personIds: ["prior"] });
    const params = {
      matterId: "matter",
      emailIds: ["email"],
      emailPatch: {
        category: "invalid",
        personIds: [42],
        matterId: "injected",
        keywords: { $seen: true },
      },
    };
    await executor.submit(request("matter_attach", params));
    expect(await store.emails.get("email")).toMatchObject({
      matterId: "matter",
      category: "scheduling",
      personIds: ["prior"],
      keywords: {},
    });
    const clear: ActionParams["matter_attach"] & {
      emailPatch: { category: null; personIds: string[] };
    } = { matterId: "matter", emailIds: ["email"], emailPatch: { category: null, personIds: [] } };
    await executor.submit(request("matter_attach", clear));
    expect(await store.emails.get("email")).toMatchObject({
      matterId: "matter",
      category: null,
      personIds: [],
    });
  });

  it("creates a matter and deletes it on undo, with a separate undo ActionRecord", async () => {
    const { executor, store } = await setup();
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = matter();
    const created = await executor.submit(
      request("matter_create", { matter: input }, { category: "matters" }),
    );
    const id = created.result!.matterId as string;
    expect(await store.matters.get(id)).toMatchObject({ title: "Trip" });
    await executor.undo(created.id);
    expect(await store.matters.get(id)).toBeNull();
    expect((await store.actions.query({})).total).toBe(2);
  });

  it("restores previous matter patches and attachment backlinks", async () => {
    const { executor, store, bus } = await setup();
    await store.matters.upsert(matter());
    await store.events.upsertMany([calendarEvent()]);
    await store.people.upsert(person());
    const updated = await executor.submit(
      request("matter_update", {
        matterId: "matter",
        patch: { summary: "A plan", nextStep: "Book" },
      }),
    );
    expect((await store.matters.get("matter"))?.summary).toBe("A plan");
    await executor.undo(updated.id);
    expect((await store.matters.get("matter"))?.nextStep).toBeUndefined();
    const attached = await executor.submit(
      request("matter_attach", {
        matterId: "matter",
        emailIds: ["email"],
        eventIds: ["event"],
        personIds: ["person"],
      }),
    );
    expect((await store.matters.get("matter"))?.emailIds).toEqual(["email"]);
    expect((await store.emails.get("email"))?.matterId).toBe("matter");
    expect((await store.events.get("event"))?.matterId).toBe("matter");
    await executor.undo(attached.id);
    expect((await store.matters.get("matter"))?.emailIds).toEqual([]);
    expect((await store.emails.get("email"))?.matterId).toBeNull();
    expect((await store.events.get("event"))?.matterId).toBeUndefined();
    expect(bus.events.some((event) => event.type === "matter.updated")).toBe(true);
  });

  it("updates people and snoozes emails/matters without resolving providers, then restores them", async () => {
    const { executor, store, mail, calendar } = await setup();
    await store.people.upsert(person());
    await store.matters.upsert(matter());
    const updated = await executor.submit(
      request("person_update", { personId: "person", patch: { notes: "Colleague" } }),
    );
    expect((await store.people.get("person"))?.notes).toBe("Colleague");
    await executor.undo(updated.id);
    expect((await store.people.get("person"))?.notes).toBeUndefined();
    await store.kv.set("policy:snooze:email", "2026-10-21T12:00:00.000Z");
    const snoozed = await executor.submit(
      request("snooze", {
        emailIds: ["email"],
        matterId: "matter",
        until: "2026-10-22T12:00:00.000Z",
      }),
    );
    expect((await store.matters.get("matter"))?.status).toBe("snoozed");
    expect(await store.kv.get("policy:snooze:email")).toBe("2026-10-22T12:00:00.000Z");
    await executor.undo(snoozed.id);
    expect((await store.matters.get("matter"))?.status).toBe("active");
    expect(await store.kv.get("policy:snooze:email")).toBe("2026-10-21T12:00:00.000Z");
    expect(mail.changes).toEqual([]);
    expect(calendar.calls).toEqual([]);
  });

  it("keeps attachment inverses correct through JSON persistence", async () => {
    const { executor, store } = await setup();
    await store.matters.upsert(matter());
    const attached = await executor.submit(
      request("matter_attach", { matterId: "matter", emailIds: ["email"] }),
    );
    await store.actions.update(attached.id, {
      inverse: JSON.parse(JSON.stringify(attached.inverse)),
    });
    await executor.undo(attached.id);
    expect((await store.emails.get("email"))?.matterId).toBeNull();
    expect((await store.matters.get("matter"))?.emailIds).toEqual([]);
  });
});

describe("unsubscribe execution", () => {
  it("posts RFC 8058 one-click data, logs only the host, and creates no follow-up actions", async () => {
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const { executor, store, mail, bus } = await setup({ fetch: fetcher });
    const original = email({
      headers: {
        ...email().headers,
        listUnsubscribe:
          "<mailto:leave@example.com>, <https://lists.example/unsubscribe?token=secret>",
        listUnsubscribePost: "List-Unsubscribe=One-Click",
      },
    });
    await store.emails.upsertMany([original]);
    const getEmail = vi.spyOn(store.emails, "get");
    fetcher.mockImplementationOnce(async () => {
      expect((await store.actions.query({ status: ["executing"] })).items[0]).toMatchObject({
        inverse: null,
        request: { type: "unsubscribe" },
      });
      return new Response(null, { status: 204 });
    });
    const action = await executor.submit(
      request("unsubscribe", { emailId: "email", method: "header" }),
    );
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "https://lists.example/unsubscribe?token=secret",
      {
        method: "POST",
        body: "List-Unsubscribe=One-Click",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        redirect: "manual",
        signal: expect.any(AbortSignal),
      },
    );
    expect(getEmail).toHaveBeenCalledWith("email", { includeBodies: true });
    expect(action).toMatchObject({
      status: "executed",
      inverse: null,
      decision: { reversibility: "irreversible" },
      result: { method: "header", target: "lists.example", status: 204 },
    });
    expect((await store.actions.get(action.id))?.result).toEqual(action.result);
    expect((await store.actions.query({})).items).toHaveLength(1);
    expect(await store.emails.get("email", { includeBodies: true })).toEqual(original);
    expect(mail.sends).toEqual([]);
    expect(mail.changes).toEqual([]);
    expect(bus.events.at(-1)?.type).toBe("action.executed");
    await expect(executor.undo(action.id)).rejects.toMatchObject({ code: "IRREVERSIBLE_ACTION" });
  });

  it.each([
    {
      query: "?subject=Stop%20news&body=Please%20unsubscribe%0AThanks",
      subject: "Stop news",
      textBody: "Please unsubscribe\nThanks",
    },
    { query: "", subject: "unsubscribe", textBody: "unsubscribe" },
  ])(
    "F4 holds a mailto unsubscribe child with query $query before provider submission",
    async ({ query, subject, textBody }) => {
      const fetcher = vi.fn<typeof globalThis.fetch>();
      const { executor, store, mail, policy } = await setup({ fetch: fetcher });
      await policy.pinLevel("unsubscribe", "full_access");
      await store.emails.upsertMany([
        email({
          headers: {
            ...email().headers,
            listUnsubscribe: `<https://lists.example/u>, <mailto:leave%2Bnews@example.com${query}>`,
          },
        }),
      ]);
      const action = await executor.submit(
        request("unsubscribe", { emailId: "email", method: "header" }),
      );
      expect(mail.sends).toEqual([]);
      expect(action.status).toBe("executing");
      const child = (await store.actions.get(action.result!.childActionId as string))!;
      expect(child.status).toBe("held");
      await executor.releaseDue(child.holdUntil!);
      expect(mail.sends).toEqual([
        {
          draft: {
            accountId: "account",
            to: [{ email: "leave+news@example.com" }],
            subject,
            textBody,
          },
        },
      ]);
      expect(fetcher).not.toHaveBeenCalled();
      expect(await store.actions.get(action.id)).toMatchObject({
        status: "executed",
        inverse: null,
        result: {
          method: "header",
          target: "leave+news@example.com",
          status: "sent",
          childActionId: child.id,
        },
      });
      expect((await store.actions.query({})).items).toHaveLength(2);
    },
  );

  it("falls back to mailto when one-click offers only an insecure web URL", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>();
    const { executor, store, mail } = await setup({ fetch: fetcher });
    await store.emails.upsertMany([
      email({
        headers: {
          ...email().headers,
          listUnsubscribe: "<http://lists.example/u>, <mailto:leave@example.com>",
          listUnsubscribePost: "List-Unsubscribe=One-Click",
        },
      }),
    ]);
    expect(
      (await executor.submit(request("unsubscribe", { emailId: "email", method: "header" })))
        .result,
    ).toEqual({
      method: "header",
      target: "leave@example.com",
      status: "pending",
      childActionId: expect.any(String),
    });
    expect(mail.sends).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses GET for the link method even with a one-click header", async () => {
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const { executor, store, mail } = await setup({ fetch: fetcher });
    await store.emails.upsertMany([
      email({
        headers: {
          ...email().headers,
          listUnsubscribe: "<http://insecure.example/u>, <https://lists.example/u?token=secret>",
          listUnsubscribePost: "List-Unsubscribe=One-Click",
        },
      }),
    ]);
    const action = await executor.submit(
      request("unsubscribe", { emailId: "email", method: "link" }),
    );
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("https://lists.example/u?token=secret", {
      method: "GET",
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
    expect(action).toMatchObject({
      status: "executed",
      inverse: null,
      result: { method: "link", target: "lists.example", status: 200 },
    });
    expect(mail.sends).toEqual([]);
  });

  it.each([
    { method: "header" as const, listUnsubscribe: "<http://lists.example/u>" },
    { method: "link" as const, listUnsubscribe: "<http://lists.example/u>" },
    { method: "link" as const, listUnsubscribe: "<mailto:leave@example.com>" },
    { method: "header" as const, listUnsubscribe: undefined },
    { method: "link" as const, listUnsubscribe: undefined },
  ])(
    "fails $method with unsupported header $listUnsubscribe and records the error",
    async ({ method, listUnsubscribe }) => {
      const fetcher = vi.fn<typeof globalThis.fetch>();
      const { executor, store, mail, bus } = await setup({ fetch: fetcher });
      await store.emails.upsertMany([
        email({
          headers: {
            ...email().headers,
            listUnsubscribe,
            listUnsubscribePost: listUnsubscribe ? "List-Unsubscribe=One-Click" : undefined,
          },
        }),
      ]);
      await expect(
        executor.submit(request("unsubscribe", { emailId: "email", method })),
      ).rejects.toMatchObject({ code: "UNSUBSCRIBE_UNSUPPORTED" });
      expect((await store.actions.query({ status: ["failed"] })).items[0]).toMatchObject({
        status: "failed",
        error: `No supported unsubscribe target for method ${method}`,
      });
      expect(bus.events.at(-1)?.type).toBe("action.failed");
      expect(fetcher).not.toHaveBeenCalled();
      expect(mail.sends).toEqual([]);
    },
  );

  it("does not treat a web header without one-click as permission to GET", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>();
    const { executor, store } = await setup({ fetch: fetcher });
    await store.emails.upsertMany([
      email({ headers: { ...email().headers, listUnsubscribe: "<https://lists.example/u>" } }),
    ]);
    await expect(
      executor.submit(request("unsubscribe", { emailId: "email", method: "header" })),
    ).rejects.toMatchObject({ code: "UNSUBSCRIBE_UNSUPPORTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{ replyTo: [] }, { replyTo: [{ email: "reply@example.com", name: "List replies" }] }])(
    "F4 holds a threaded unsubscribe reply using reply-to or from ($replyTo)",
    async ({ replyTo }) => {
      const { executor, store, mail, policy } = await setup();
      await policy.pinLevel("unsubscribe", "full_access");
      await store.emails.upsertMany([email({ replyTo })]);
      const to = replyTo.length ? replyTo : email().from;
      const action = await executor.submit(
        request("unsubscribe", { emailId: "email", method: "reply" }),
      );
      expect(mail.sends).toEqual([]);
      const child = (await store.actions.get(action.result!.childActionId as string))!;
      await executor.releaseDue(child.holdUntil!);
      expect(mail.sends).toEqual([
        {
          draft: {
            accountId: "account",
            inReplyToEmailId: "email",
            to,
            subject: "unsubscribe",
            textBody: "unsubscribe",
          },
        },
      ]);
      expect(await store.actions.get(action.id)).toMatchObject({
        status: "executed",
        inverse: null,
        result: { method: "reply", target: to[0]!.email, status: "sent", childActionId: child.id },
      });
      expect((await store.actions.query({})).items).toHaveLength(2);
      expect(mail.changes).toEqual([]);
    },
  );

  it("fails a reply with no recipient instead of sending an empty draft", async () => {
    const { executor, store, mail } = await setup();
    await store.emails.upsertMany([email({ from: [], replyTo: [] })]);
    await expect(
      executor.submit(request("unsubscribe", { emailId: "email", method: "reply" })),
    ).rejects.toMatchObject({ code: "UNSUBSCRIBE_UNSUPPORTED" });
    expect(mail.sends).toEqual([]);
  });

  it.each(["header", "link"] as const)(
    "follows at most three HTTPS redirects for %s, preserving the method and deadline",
    async (method) => {
      const fetcher = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          new Response(null, { status: 302, headers: { location: "/step?token=second" } }),
        )
        .mockResolvedValueOnce(
          new Response(null, { status: 303, headers: { location: "https://final.example/u" } }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/done" } }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      const { executor, store } = await setup({ fetch: fetcher });
      await store.emails.upsertMany([
        email({
          headers: {
            ...email().headers,
            listUnsubscribe: "<https://lists.example/u?token=secret>",
            listUnsubscribePost: "List-Unsubscribe=One-Click",
          },
        }),
      ]);
      const action = await executor.submit(request("unsubscribe", { emailId: "email", method }));
      expect(action.result).toEqual({ method, target: "final.example", status: 204 });
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
        "https://lists.example/u?token=secret",
        "https://lists.example/step?token=second",
        "https://final.example/u",
        "https://final.example/done",
      ]);
      for (const [, init] of fetcher.mock.calls) {
        expect(init).toMatchObject({
          method: method === "header" ? "POST" : "GET",
          redirect: "manual",
          signal: fetcher.mock.calls[0]![1]!.signal,
        });
        expect(init?.body).toBe(method === "header" ? "List-Unsubscribe=One-Click" : undefined);
      }
    },
  );

  it.each([
    {
      response: () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://insecure.example/u?token=secret" },
        }),
      code: "UNSUBSCRIBE_UNSUPPORTED",
      calls: 1,
    },
    {
      response: () =>
        new Response(null, { status: 302, headers: { location: "/again?token=secret" } }),
      code: "UNSUBSCRIBE_REDIRECT_LIMIT",
      calls: 4,
    },
    { response: () => new Response(null, { status: 302 }), code: "UNSUBSCRIBE_FAILED", calls: 1 },
    {
      response: () => new Response(null, { status: 302, headers: { location: "https://[" } }),
      code: "UNSUBSCRIBE_FAILED",
      calls: 1,
    },
    {
      response: () => new Response("Secret response body", { status: 500 }),
      code: "UNSUBSCRIBE_HTTP_ERROR",
      calls: 1,
    },
  ])("persists $code without query strings when HTTP fails", async ({ response, code, calls }) => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response());
    const { executor, store } = await setup({ fetch: fetcher });
    await store.emails.upsertMany([
      email({
        headers: { ...email().headers, listUnsubscribe: "<https://lists.example/u?token=secret>" },
      }),
    ]);
    await expect(
      executor.submit(request("unsubscribe", { emailId: "email", method: "link" })),
    ).rejects.toMatchObject({ code });
    expect(fetcher).toHaveBeenCalledTimes(calls);
    const failed = (await store.actions.query({ status: ["failed"] })).items[0]!;
    expect(failed.error).toContain("lists.example");
    expect(failed.error).not.toMatch(/secret|token|Secret response body/);
    expect(failed.result).toBeUndefined();
  });

  it("redacts fetch errors that contain token-bearing URLs", async () => {
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error("Cannot fetch https://lists.example/u?token=secret"));
    const { executor, store } = await setup({ fetch: fetcher });
    await store.emails.upsertMany([
      email({
        headers: { ...email().headers, listUnsubscribe: "<https://lists.example/u?token=secret>" },
      }),
    ]);
    await expect(
      executor.submit(request("unsubscribe", { emailId: "email", method: "link" })),
    ).rejects.toMatchObject({
      code: "UNSUBSCRIBE_FAILED",
      message: "Unsubscribe request failed for lists.example",
    });
    expect((await store.actions.query({ status: ["failed"] })).items[0]?.error).toBe(
      "Unsubscribe request failed for lists.example",
    );
  });

  it("uses a 10-second abort deadline and records a safe timeout failure", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      const fetcher = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
        controller.abort();
        throw new Error("URL with secret token");
      });
      const { executor, store } = await setup({ fetch: fetcher });
      await store.emails.upsertMany([
        email({
          headers: {
            ...email().headers,
            listUnsubscribe: "<https://lists.example/u?token=secret>",
          },
        }),
      ]);
      await expect(
        executor.submit(request("unsubscribe", { emailId: "email", method: "link" })),
      ).rejects.toMatchObject({ code: "UNSUBSCRIBE_TIMEOUT" });
      expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
      expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
      expect((await store.actions.query({ status: ["failed"] })).items[0]?.error).toBe(
        "Unsubscribe request timed out for lists.example",
      );
    } finally {
      timeout.mockRestore();
    }
  });

  it("R6 retains an explicit injectable fetch for tests", async () => {
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const { executor, store } = await setup({ fetch: fetcher });
      await store.emails.upsertMany([
        email({ headers: { ...email().headers, listUnsubscribe: "<https://lists.example/u>" } }),
      ]);
      expect(
        (await executor.submit(request("unsubscribe", { emailId: "email", method: "link" })))
          .status,
      ).toBe("executed");
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("persists provider send failures and rethrows the original error", async () => {
    const { executor, store, mail, bus, policy } = await setup();
    await policy.pinLevel("unsubscribe", "full_access");
    await policy.setConfig({ outboxHoldMinutes: 0 });
    const failure = Object.assign(new Error("Unsubscribe send failed"), { code: "REMOTE_FAILURE" });
    mail.failure = failure;
    await expect(
      executor.submit(request("unsubscribe", { emailId: "email", method: "reply" })),
    ).rejects.toBe(failure);
    expect((await store.actions.query({ status: ["failed"] })).items[0]?.error).toBe(
      failure.message,
    );
    expect(bus.events.at(-1)?.type).toBe("action.failed");
  });

  it("F4 asks under supervised policy and queues a child for separate approval", async () => {
    const { executor, policy, mail, store } = await setup();
    await policy.pinLevel("other", "supervised");
    const proposed = await executor.submit(
      request("unsubscribe", { emailId: "email", method: "reply" }),
    );
    expect(proposed.status).toBe("proposed");
    expect(mail.sends).toEqual([]);
    const pending = await executor.approve(proposed.id);
    expect(pending.status).toBe("executing");
    expect(mail.sends).toHaveLength(0);
    const child = await executor.approve(pending.result!.childActionId as string);
    expect(child.status).toBe("held");
    await executor.releaseDue(child.holdUntil!);
    expect((await store.actions.get(proposed.id))?.status).toBe("executed");
    expect(mail.sends).toHaveLength(1);
  });
});

describe("gate invariants", () => {
  it("records an ActionRecord before a provider is called and never executes reversible actions without an inverse", async () => {
    const { executor, store, mail } = await setup();
    const original = mail.applyChanges.bind(mail);
    mail.applyChanges = async (changes) => {
      const executing = (await store.actions.query({ status: ["executing"] })).items;
      expect(executing).toHaveLength(1);
      expect(executing[0]?.inverse).not.toBeNull();
      await original(changes);
    };
    await executor.submit(request("archive", { emailIds: ["email"] }));
    for (const record of (await store.actions.query({ status: ["executed"] })).items) {
      expect(record.inverse !== null || record.decision.reversibility === "irreversible").toBe(
        true,
      );
    }
  });

  it("rejects private inverse payloads, cross-account operations, and forged verification", async () => {
    const { executor, store, mail } = await setup();
    const forged = request("archive", {
      emailIds: ["email"],
      __passportPolicyInverse: {},
    } as unknown as { emailIds: string[] });
    await expect(executor.submit(forged)).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await store.emails.upsertMany([email({ id: "other", accountId: "other-account" })]);
    await expect(
      executor.submit(request("archive", { emailIds: ["other"] })),
    ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
    await expect(
      executor.submit(
        request("person_update", { personId: "person", patch: { verification: "blue" } }),
      ),
    ).rejects.toMatchObject({ code: "PROTECTED_IDENTITY" });
    expect(mail.changes).toEqual([]);
  });

  it("emits every action event defined by the contract across success, hold, proposal, failure, and undo", async () => {
    const { executor, policy, bus, mail } = await setup();
    const archived = await executor.submit(request("archive", { emailIds: ["email"] }));
    await executor.undo(archived.id);
    await executor.submit(request("send", { draft }));
    mail.failure = new Error("Failure");
    await expect(executor.submit(request("archive", { emailIds: ["email"] }))).rejects.toThrow(
      "Failure",
    );
    await policy.pinLevel("other", "supervised");
    await executor.submit(request("archive", { emailIds: ["email"] }));
    const types = new Set(
      bus.events.filter((event) => event.type.startsWith("action.")).map((event) => event.type),
    );
    expect([...types].sort()).toEqual([
      "action.decided",
      "action.executed",
      "action.failed",
      "action.held",
      "action.proposed",
      "action.undone",
    ]);
  });
});
