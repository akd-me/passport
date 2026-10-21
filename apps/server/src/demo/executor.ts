import type {
  ActionExecutor,
  ActionParams,
  ActionRecord,
  ActionRequest,
  ActionType,
  DraftInput,
  Email,
  EventBus,
  PolicyEngine,
  Store,
} from "@passport/types";
import { BASE_REVERSIBILITY } from "@passport/types";
import { ApiError, NotImplementedError, required } from "../errors.js";

const now = () => new Date().toISOString();
const params = <T extends ActionType>(r: ActionRequest, _type: T) => r.params as ActionParams[T];

/** In-memory action gate. Unsupported mutations fail visibly; nothing is sent to a network. */
export function createDemoExecutor(
  store: Store,
  policy: PolicyEngine,
  bus: EventBus,
): ActionExecutor {
  const restorers = new Map<string, () => Promise<void>>(),
    busy = new Set<string>();
  async function lock<T>(id: string, task: () => Promise<T>): Promise<T> {
    if (busy.has(id)) {
      throw new ApiError("ACTION_BUSY", "This action is already being processed", 409);
    }
    busy.add(id);
    try {
      return await task();
    } finally {
      busy.delete(id);
    }
  }
  async function get(id: string, status: ActionRecord["status"]): Promise<ActionRecord> {
    const record = required(await store.actions.get(id), "Action");
    if (record.status !== status) {
      throw new ApiError("INVALID_ACTION_STATE", `Expected ${status}, found ${record.status}`, 409);
    }
    return record;
  }
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
  async function execute(record: ActionRecord): Promise<ActionRecord> {
    await store.actions.update(record.id, { status: "executing" });
    try {
      const inverse = await apply(record);
      const action = await store.actions.update(record.id, {
        status: "executed",
        inverse,
        executedAt: now(),
        holdUntil: null,
        decision: {
          ...record.decision,
          reversibility: inverse ? "reversible" : "irreversible",
        },
      });
      bus.emit({ type: "action.executed", action });
      return action;
    } catch (error) {
      const action = await store.actions.update(record.id, {
        status: "failed",
        error: error instanceof ApiError ? error.message : "Demo execution failed",
      });
      bus.emit({ type: "action.failed", action });
      throw error;
    }
  }
  async function approved(record: ActionRecord): Promise<ActionRecord> {
    const config = await policy.getConfig();
    if (BASE_REVERSIBILITY[record.request.type] === "delayed" && config.outboxHoldMinutes > 0) {
      const holdUntil = new Date(Date.now() + config.outboxHoldMinutes * 60000).toISOString();
      const action = await store.actions.update(record.id, {
        status: "held",
        holdUntil,
        decision: { ...record.decision, outcome: "hold", holdUntil },
      });
      bus.emit({ type: "action.held", action });
      return action;
    }
    return execute(record);
  }
  const executor: ActionExecutor = {
    submit: async (request) => {
      const decision = await policy.evaluate(request);
      const record = await store.actions.insert({
        id: crypto.randomUUID(),
        request,
        decision,
        status: decision.outcome === "deny" ? "rejected" : "proposed",
        createdAt: now(),
      });
      if (decision.outcome === "ask" || decision.outcome === "deny") {
        bus.emit({ type: "action.proposed", action: record });
      }
      if (decision.promotionOffer) {
        bus.emit({
          type: "trust.promotion_offered",
          offer: decision.promotionOffer,
        });
      }
      return decision.outcome === "allow" || decision.outcome === "hold"
        ? approved(record)
        : record;
    },
    approve: (id, edited) =>
      lock(id, async () => {
        const record = await get(id, "proposed");
        if (
          edited &&
          (edited.type !== record.request.type || edited.accountId !== record.request.accountId)
        ) {
          throw new ApiError(
            "INVALID_EDIT",
            "Edited approvals must preserve action type and account",
          );
        }
        const changed =
          edited && JSON.stringify(edited.params) !== JSON.stringify(record.request.params);
        const action = await store.actions.update(id, {
          request: edited ? { ...record.request, params: edited.params } : record.request,
          status: "approved",
          decidedAt: now(),
          editDistance: changed ? 0.25 : 0,
        });
        await policy.recordOutcome(id, changed ? "approved_edited" : "approved_unchanged");
        bus.emit({ type: "action.decided", action });
        return approved(action);
      }),
    reject: (id, reason) =>
      lock(id, async () => {
        await get(id, "proposed");
        const action = await store.actions.update(id, {
          status: "rejected",
          decidedAt: now(),
          error: reason ?? null,
        });
        await policy.recordOutcome(id, "rejected");
        bus.emit({ type: "action.decided", action });
        return action;
      }),
    cancelHold: (id) =>
      lock(id, async () => {
        await get(id, "held");
        const action = await store.actions.update(id, {
          status: "rejected",
          decidedAt: now(),
          holdUntil: null,
          error: "Cancelled before release",
        });
        bus.emit({ type: "action.decided", action });
        return action;
      }),
    undo: (id) =>
      lock(id, async () => {
        const record = await get(id, "executed");
        if (!record.inverse || !restorers.has(id)) {
          throw new ApiError("NOT_UNDOABLE", "This action cannot be undone", 409);
        }
        const inverseRecord = await store.actions.insert({
          id: crypto.randomUUID(),
          request: record.inverse,
          decision: {
            ...record.decision,
            outcome: "allow",
            reversibility: "reversible",
          },
          status: "executing",
          createdAt: now(),
        });
        await restorers.get(id)!();
        const undoAction = await store.actions.update(inverseRecord.id, {
          status: "executed",
          executedAt: now(),
          inverse: record.request,
          result: { undoes: id },
        });
        restorers.set(inverseRecord.id, async () => {
          await apply(record);
        });
        bus.emit({ type: "action.executed", action: undoAction });
        const action = await store.actions.update(id, {
          status: "undone",
          undoneAt: now(),
        });
        bus.emit({ type: "action.undone", action });
        return action;
      }),
    releaseDue: async (at = now()) => {
      const released: ActionRecord[] = [];
      for (const record of await store.actions.dueHeld(at)) {
        if (busy.has(record.id)) {
          continue;
        }
        await lock(record.id, async () => {
          if ((await store.actions.get(record.id))?.status === "held") {
            try {
              released.push(await execute(record));
            } catch {
              /* execute persisted failure and emitted action.failed. */
            }
          }
        });
      }
      return released;
    },
  };
  return executor;
}
