import type {
  ActionRecord,
  ActionRequest,
  ActionType,
  DraftInput,
  Email,
  EventBus,
  Store,
} from "@passport/types";
import { ApiError, NotImplementedError, required } from "../errors.js";
import { now, params } from "./executor-shared.js";

export function createDemoApply(
  store: Store,
  bus: EventBus,
  restorers: Map<string, () => Promise<void>>,
) {
  async function apply(record: ActionRecord): Promise<ActionRequest | null> {
    const r = record.request;
    const inverse = (type: ActionType, value: ActionRequest["params"]): ActionRequest => ({
      ...r,
      type,
      params: value,
      actor: { kind: "human", id: "user" },
      reason: `Undo: ${r.reason}`,
    });
    if (r.type === "profile_update") {
      const old = (await store.kv.get("user-profile")) ?? "";
      await store.kv.set("user-profile", params(r, "profile_update").markdown);
      restorers.set(record.id, () => store.kv.set("user-profile", old));
      return inverse("profile_update", { markdown: old });
    }
    if (r.type === "matter_update") {
      const p = params(r, "matter_update"),
        old = required(await store.matters.get(p.matterId), "Matter");
      const updated = await store.matters.upsert({
        ...old,
        ...p.patch,
        id: old.id,
        updatedAt: now(),
      });
      bus.emit({ type: "matter.updated", matter: updated });
      restorers.set(record.id, async () => {
        await store.matters.upsert(old);
        bus.emit({ type: "matter.updated", matter: old });
      });
      return inverse("matter_update", { matterId: old.id, patch: old });
    }
    if (r.type === "person_update") {
      const p = params(r, "person_update"),
        old = required(await store.people.get(p.personId), "Person");
      await store.people.upsert({
        ...old,
        ...p.patch,
        id: old.id,
        updatedAt: now(),
      });
      restorers.set(record.id, async () => {
        await store.people.upsert(old);
      });
      return inverse("person_update", { personId: old.id, patch: old });
    }
    if (
      [
        "archive",
        "unarchive",
        "mark_read",
        "mark_unread",
        "flag",
        "unflag",
        "label",
        "unlabel",
        "move",
        "delete",
      ].includes(r.type)
    ) {
      const p = r.params as {
        emailIds: string[];
        label?: string;
        toMailboxId?: string;
      };
      const previous = await Promise.all(
        p.emailIds.map(async (id) =>
          required(await store.emails.get(id, { includeBodies: true }), "Email"),
        ),
      );
      for (const email of previous) {
        const patch = {
          keywords: { ...email.keywords },
          mailboxIds: [...email.mailboxIds],
        };
        if (r.type === "archive") {
          patch.mailboxIds = [
            ...patch.mailboxIds.filter((id) => id !== "mailbox-inbox"),
            "mailbox-archive",
          ];
        }
        if (r.type === "unarchive") {
          patch.mailboxIds = [
            ...patch.mailboxIds.filter((id) => id !== "mailbox-archive"),
            p.toMailboxId ?? "mailbox-inbox",
          ];
        }
        if (r.type === "move" || r.type === "delete") {
          patch.mailboxIds = [r.type === "delete" ? "mailbox-trash" : p.toMailboxId!];
        }
        const keyword = r.type.includes("read")
          ? "$seen"
          : r.type.includes("flag")
            ? "$flagged"
            : `label:${p.label}`;
        if (["mark_read", "mark_unread", "flag", "unflag", "label", "unlabel"].includes(r.type)) {
          patch.keywords[keyword] = ["mark_read", "flag", "label"].includes(r.type);
        }
        await store.emails.patchMany([email.id], patch);
        bus.emit({ type: "email.updated", emailId: email.id });
      }
      restorers.set(record.id, async () => {
        await store.emails.upsertMany(previous);
        previous.forEach((e) => {
          bus.emit({ type: "email.updated", emailId: e.id });
        });
      });
      const pairs: Partial<Record<ActionType, ActionType>> = {
        archive: "unarchive",
        unarchive: "archive",
        mark_read: "mark_unread",
        mark_unread: "mark_read",
        flag: "unflag",
        unflag: "flag",
        label: "unlabel",
        unlabel: "label",
        move: "move",
        delete: "move",
      };
      return inverse(pairs[r.type]!, {
        ...p,
        toMailboxId: previous[0]?.mailboxIds[0],
      });
    }
    if (r.type === "draft_create" || r.type === "send") {
      const p = r.params as { draft?: DraftInput; draftEmailId?: string };
      const draft: DraftInput | undefined =
        p.draft ??
        (p.draftEmailId
          ? await store.emails.get(p.draftEmailId, { includeBodies: true }).then((e) =>
              e
                ? {
                    accountId: e.accountId,
                    to: e.to,
                    cc: e.cc,
                    subject: e.subject,
                    textBody: e.textBody ?? "",
                  }
                : undefined,
            )
          : undefined);
      if (!draft) {
        throw new ApiError("INVALID_DRAFT", "A draft is required");
      }
      const account = required(await store.accounts.get(r.accountId), "Account"),
        id = crypto.randomUUID();
      const email: Email = {
        id,
        accountId: account.id,
        providerId: `demo-${id}`,
        threadId: draft.inReplyToEmailId
          ? ((await store.emails.get(draft.inReplyToEmailId))?.threadId ?? id)
          : id,
        mailboxIds: [r.type === "send" ? "mailbox-sent" : "mailbox-drafts"],
        keywords: r.type === "send" ? { $seen: true } : { $draft: true },
        from: [{ email: account.emailAddress, name: "Alex Morgan" }],
        to: draft.to,
        cc: draft.cc ?? [],
        bcc: draft.bcc ?? [],
        replyTo: [],
        subject: draft.subject,
        receivedAt: now(),
        sentAt: r.type === "send" ? now() : null,
        preview: draft.textBody.slice(0, 150),
        textBody: draft.textBody,
        attachments: [],
        headers: {
          messageId: `<${id}@passport.demo>`,
          inReplyTo: null,
          references: [],
        },
        size: draft.textBody.length,
        verification: {
          dkim: "pass",
          spf: "pass",
          dmarc: "pass",
          passport: "blue",
        },
        personIds: [],
        matterId: r.matterId,
      };
      await store.emails.upsertMany([email]);
      const thread = await store.threads.get(email.threadId);
      await store.threads.upsertMany([
        {
          id: email.threadId,
          accountId: account.id,
          emailIds: [...(thread?.emailIds ?? []), id],
        },
      ]);
      if (r.matterId) {
        const matter = await store.matters.get(r.matterId);
        if (matter) {
          const updated = await store.matters.upsert({
            ...matter,
            emailIds: [...matter.emailIds, id],
            updatedAt: now(),
          });
          bus.emit({ type: "matter.updated", matter: updated });
        }
      }
      bus.emit({ type: "email.updated", emailId: email.id });
      restorers.set(record.id, async () => {
        await store.emails.deleteMany([id]);
        await store.threads.upsertMany([
          {
            id: email.threadId,
            accountId: account.id,
            emailIds: thread?.emailIds ?? [],
          },
        ]);
        if (r.matterId) {
          const matter = await store.matters.get(r.matterId);
          if (matter) {
            await store.matters.upsert({
              ...matter,
              emailIds: matter.emailIds.filter((e) => e !== id),
            });
          }
        }
        bus.emit({ type: "email.updated", emailId: id });
      });
      await store.actions.update(record.id, {
        result: { emailId: id, demo: true },
      });
      return r.type === "send" ? null : inverse("draft_delete", { draftEmailId: id });
    }
    throw new NotImplementedError(
      `Demo execution does not implement ${r.type}. Use the real executor after integration.`,
    );
  }
  return apply;
}
