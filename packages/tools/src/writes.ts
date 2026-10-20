import type { DraftInput, EmailAddress } from "@passport/types";
import { schema as z } from "./schema.js";
import type { Context } from "./context.js";
import { ToolError, required, writeResult } from "./presentation.js";
import { register } from "./register.js";
import * as s from "./schemas.js";

const recipients = (draft: DraftInput) => [...draft.to, ...draft.cc ?? [], ...draft.bcc ?? []].map(address => address.email);
const normalize = (email: string) => email.trim().toLowerCase();

export function registerWrites(ctx: Context) {
  const { store } = ctx;
  const batchShape = { emailIds: s.ids, accountId: s.id.optional(), reason: s.reason };
  for (const [name, type, description] of [
    ["archive_emails", "archive", "Archive emails under policy; requires approval when trust is supervised."],
    ["mark_read", "mark_read", "Mark emails as read under policy."],
  ] as const) {
    register(ctx, name, description, batchShape, true, async ({ emailIds, accountId, reason }, ctx) => {
      const batch = await ctx.emailBatch(emailIds, accountId);
      return writeResult(await ctx.submit(type, batch.accountId, { emailIds: batch.emails.map(email => email.id) }, reason, batch));
    });
  }
  register(ctx, "label_emails", "Add a label, or remove it with remove=true; every change passes through policy.", {
    ...batchShape, label: z.string().trim().min(1).max(200), remove: z.boolean().default(false),
  }, true, async ({ emailIds, accountId, reason, label, remove }, ctx) => {
    const batch = await ctx.emailBatch(emailIds, accountId);
    return writeResult(await ctx.submit(remove ? "unlabel" : "label", batch.accountId, { emailIds: batch.emails.map(email => email.id), label }, reason, batch));
  });
  register(ctx, "move_emails", "Move emails to a mailbox in the same account. Trash/junk destinations are unavailable through MCP.", {
    ...batchShape, toMailboxId: s.id,
  }, true, async ({ emailIds, accountId, reason, toMailboxId }, ctx) => {
    const batch = await ctx.emailBatch(emailIds, accountId);
    const mailbox = required(await store.mailboxes.get(toMailboxId), "Destination mailbox");
    if (mailbox.accountId !== batch.accountId) throw new ToolError("ACCOUNT_MISMATCH", "Destination mailbox belongs to another account.");
    return writeResult(await ctx.submit("move", batch.accountId, { emailIds, toMailboxId }, reason, batch));
  });

  async function draftContext(draft: DraftInput) {
    await ctx.account(draft.accountId);
    const emails = draft.inReplyToEmailId ? [(await ctx.emailBatch([draft.inReplyToEmailId], draft.accountId)).emails[0]!] : [];
    return { emails, recipientEmails: recipients(draft) };
  }
  register(ctx, "create_draft", "Create a draft under policy. Returns an action ID; the resulting draft can be found using search_emails with keyword $draft.", {
    draft: s.draft, reason: s.reason,
  }, true, async ({ draft, reason }, ctx) => writeResult(await ctx.submit("draft_create", draft.accountId, { draft }, reason, await draftContext(draft))));

  register(ctx, "reply_draft", "Draft a threaded reply, using Reply-To/From; replyAll also includes original To/CC, deduplicated and excluding all own addresses. Quotes the original text by default. Never sends.", {
    emailId: s.id, textBody: z.string().max(1_000_000), replyAll: z.boolean().default(false),
    quoteOriginal: z.boolean().default(true), reason: s.reason,
  }, true, async ({ emailId, textBody, replyAll, quoteOriginal, reason }, ctx) => {
    const original = await ctx.email(emailId, true);
    const [accounts, ownPeople] = await Promise.all([store.accounts.list(), store.people.list({ relationship: "self", limit: 100 })]);
    const self = new Set([...accounts.map(account => account.emailAddress), ...ctx.deps.selfAddresses, ...ownPeople.filter(person => person.verifiedSelf).flatMap(person => person.emails)].map(normalize));
    await ctx.account(original.accountId);
    // Replying to our own sent mail targets the original recipients, never ourselves.
    const fromSelf = original.from.length > 0 && original.from.every(address => self.has(normalize(address.email)));
    const primary = fromSelf ? original.to : original.replyTo.length ? original.replyTo : original.from;
    const seen = new Set(self);
    const unique = (addresses: EmailAddress[]) => addresses.filter(address => {
      const email = normalize(address.email);
      if (seen.has(email)) return false;
      seen.add(email); return true;
    });
    const to = unique([...primary, ...(replyAll ? original.to : [])]);
    const cc = replyAll ? unique(original.cc) : [];
    if (to.length === 0) throw new ToolError("NO_REPLY_RECIPIENT", "The email has no reply recipient other than the account owner.");
    const source = original.textBody ?? original.preview;
    const attribution = `On ${original.sentAt ?? original.receivedAt}, ${original.from.map(address => address.email).join(", ")} wrote:`;
    const draft: DraftInput = {
      accountId: original.accountId, inReplyToEmailId: original.id, to, ...(cc.length ? { cc } : {}),
      subject: /^\s*re\s*:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`,
      textBody: quoteOriginal ? `${textBody}\n\n${attribution}\n${source.replace(/\r\n/g, "\n").split("\n").map(line => `> ${line}`).join("\n")}` : textBody,
    };
    return writeResult(await ctx.submit("draft_create", draft.accountId, { draft }, reason, { emails: [original], recipientEmails: recipients(draft) }));
  });

  register(ctx, "send", "Submit exactly one existing draftEmailId or inline draft. Policy may ask or hold in the delayed outbox; held/proposed is not sent.", {
    draftEmailId: s.id.optional(), draft: s.draft.optional(), reason: s.reason,
  }, true, async ({ draftEmailId, draft, reason }, ctx) => {
    if (Boolean(draftEmailId) === Boolean(draft)) throw new ToolError("INVALID_INPUT", "Provide exactly one of draftEmailId or draft.");
    if (draft) return writeResult(await ctx.submit("send", draft.accountId, { draft }, reason, await draftContext(draft)));
    const saved = await ctx.email(required(draftEmailId, "Draft ID"));
    if (!saved.keywords.$draft) throw new ToolError("NOT_A_DRAFT", "draftEmailId must refer to an email with the $draft keyword.");
    await ctx.account(saved.accountId);
    const target = [...saved.to, ...saved.cc, ...saved.bcc].map(address => address.email);
    if (!target.length) throw new ToolError("NO_RECIPIENT", "Draft has no recipients.");
    return writeResult(await ctx.submit("send", saved.accountId, { draftEmailId: saved.id }, reason, { emails: [saved], recipientEmails: target }));
  });
  register(ctx, "unsubscribe", "Propose unsubscribing from one email. Header method requires List-Unsubscribe; executor handles provider dispatch and policy.", {
    emailId: s.id, method: z.enum(["header", "link", "reply"]).default("header"), reason: s.reason,
  }, true, async ({ emailId, method, reason }, ctx) => {
    const email = await ctx.email(emailId);
    if (method === "header" && !email.headers.listUnsubscribe) throw new ToolError("NO_UNSUBSCRIBE_HEADER", "Email does not have a List-Unsubscribe header.");
    await ctx.account(email.accountId);
    return writeResult(await ctx.submit("unsubscribe", email.accountId, { emailId, method }, reason, { emails: [email] }));
  });
  register(ctx, "respond_to_event", "Propose accepting, declining or tentatively responding to an invitation; may notify the organizer after policy approval.", {
    eventId: s.id, status: z.enum(["accepted", "declined", "tentative"]), comment: z.string().max(5000).optional(), reason: s.reason,
  }, true, async ({ eventId, status, comment, reason }, ctx) => {
    const event = required(await store.events.get(eventId), "Event");
    await ctx.account(event.accountId);
    return writeResult(await ctx.submit("calendar_respond", event.accountId, { eventId, status, ...(comment ? { comment } : {}) }, reason,
      { recipientEmails: event.organizer ? [event.organizer.email] : event.participants.map(person => person.email), matterId: event.matterId ?? undefined }));
  });
  register(ctx, "propose_meeting", "Submit meeting slots plus an invitation draft through policy. Does not independently reserve calendar time; check free_busy first.", {
    draft: s.draft, slots: z.array(s.range).min(1).max(20), reason: s.reason,
  }, true, async ({ draft, slots, reason }, ctx) => writeResult(await ctx.submit("calendar_propose", draft.accountId, { draft, slots }, reason, await draftContext(draft))));

  async function validateAttachments(input: { emailIds?: string[]; eventIds?: string[]; personIds?: string[] }, accountId: string) {
    if (input.emailIds?.length) await ctx.emailBatch(input.emailIds, accountId);
    for (const id of input.eventIds ?? []) {
      const event = required(await store.events.get(id), "Event");
      if (event.accountId !== accountId) throw new ToolError("ACCOUNT_MISMATCH", "Attached event belongs to another account.");
    }
    for (const id of input.personIds ?? []) required(await store.people.get(id), "Person");
  }
  register(ctx, "create_matter", "Create a living workspace under policy. accountId is required when multiple accounts exist.", {
    accountId: s.id.optional(), matter: z.strictObject({ ...s.matterFields, summary: s.matterFields.summary.default(""), status: s.matterStatus.default("active"),
      personIds: s.matterFields.personIds.default([]), emailIds: s.matterFields.emailIds.default([]), eventIds: s.matterFields.eventIds.default([]) }), reason: s.reason,
  }, true, async ({ accountId, matter, reason }, ctx) => {
    const account = await ctx.account(accountId);
    await validateAttachments(matter, account.id);
    const params = { matter, ...(ctx.actor().kind === "agent" && ctx.callContext.emailPatch ? { emailPatch: ctx.callContext.emailPatch } : {}) };
    return writeResult(await ctx.submit("matter_create", account.id, params, reason, { personIds: matter.personIds }));
  });
  register(ctx, "update_matter", "Patch a matter's user-editable fields under policy. IDs and timestamps cannot be changed.", {
    accountId: s.id.optional(), matterId: s.id, patch: s.matterPatch, reason: s.reason,
  }, true, async ({ accountId, matterId, patch, reason }, ctx) => {
    required(await store.matters.get(matterId), "Matter");
    const account = await ctx.account(accountId);
    await validateAttachments(patch, account.id);
    return writeResult(await ctx.submit("matter_update", account.id, { matterId, patch }, reason, { matterId, personIds: patch.personIds }));
  });
  register(ctx, "attach_to_matter", "Attach emails, events or people to a matter through an audited action. Provide at least one attachment.", {
    accountId: s.id.optional(), matterId: s.id, emailIds: s.ids.optional(), eventIds: s.ids.optional(), personIds: s.ids.optional(), reason: s.reason,
  }, true, async ({ accountId, matterId, emailIds, eventIds, personIds, reason }, ctx) => {
    required(await store.matters.get(matterId), "Matter");
    if (!emailIds && !eventIds && !personIds) throw new ToolError("INVALID_INPUT", "Provide emailIds, eventIds or personIds.");
    const account = await ctx.account(accountId ?? (emailIds ? (await ctx.email(emailIds[0]!)).accountId : undefined));
    await validateAttachments({ emailIds, eventIds, personIds }, account.id);
    const params = { matterId, emailIds, eventIds, personIds, ...(ctx.actor().kind === "agent" && ctx.callContext.emailPatch ? { emailPatch: ctx.callContext.emailPatch } : {}) };
    return writeResult(await ctx.submit("matter_attach", account.id, params, reason, { matterId, personIds }));
  });
  register(ctx, "update_person", "Update contact notes, names, addresses or relationship through policy. Cryptographic verification, stats, IDs and timestamps are not editable.", {
    accountId: s.id.optional(), personId: s.id, patch: s.personPatch, reason: s.reason,
  }, true, async ({ accountId, personId, patch, reason }, ctx) => {
    const snapshot = ctx.actor().kind === "agent" ? ctx.callContext.personSnapshot : undefined;
    if (snapshot && snapshot.id !== personId) throw new ToolError("INVALID_INPUT", "Person snapshot ID mismatch.");
    const person = required(await store.people.get(personId) ?? snapshot, "Person");
    const emails = patch.emails ?? person.emails;
    if (!emails.some(email => normalize(email) === normalize(patch.primaryEmail ?? person.primaryEmail))) throw new ToolError("INVALID_INPUT", "primaryEmail must be included in emails.");
    const account = await ctx.account(accountId);
    return writeResult(await ctx.submit("person_update", account.id, { personId, patch: snapshot ?? patch }, reason, { personIds: [personId] }));
  });
  register(ctx, "snooze", "Snooze emails, a matter, or both until a future UTC timestamp, subject to policy.", {
    accountId: s.id.optional(), emailIds: s.ids.optional(), matterId: s.id.optional(), until: s.timestamp, reason: s.reason,
  }, true, async ({ accountId, emailIds, matterId, until, reason }, ctx) => {
    if (!emailIds && !matterId) throw new ToolError("INVALID_INPUT", "Provide emailIds or matterId.");
    if (Date.parse(until) <= Date.parse(ctx.now())) throw new ToolError("INVALID_INPUT", "Snooze time must be in the future.");
    if (matterId) required(await store.matters.get(matterId), "Matter");
    const batch = emailIds ? await ctx.emailBatch(emailIds, accountId) : { accountId: (await ctx.account(accountId)).id, emails: [] };
    return writeResult(await ctx.submit("snooze", batch.accountId, { emailIds, matterId, until }, reason, { ...batch, matterId }));
  });
  register(ctx, "undo_action", "Undo an executed action by ID through the executor's trusted inverse and actor-aware policy gate. Policy may ask or deny.", {
    actionId: s.id, reason: s.reason,
  }, true, async ({ actionId, reason }, ctx) => {
    const action = required(await store.actions.get(actionId), "Action");
    if (action.status !== "executed" || !action.inverse) throw new ToolError("NOT_REVERSIBLE", "Only executed actions with a stored inverse can be undone.");
    await ctx.account(action.request.accountId);
    return writeResult(await ctx.deps.executor.undo(actionId, { actor: ctx.actor(), reason: ctx.auditReason(reason) }));
  });
  register(ctx, "cancel_held_action", "Cancel this MCP client's held outbox action before release, using executor.cancelHold(). No approval or outbox release capability is exposed.", {
    actionId: s.id,
  }, true, async ({ actionId }, ctx) => {
    const action = required(await store.actions.get(actionId), "Action");
    const actor = ctx.actor();
    if (action.status !== "held") throw new ToolError("NOT_HELD", "Only held actions can be cancelled.");
    if (action.request.actor.kind !== actor.kind || action.request.actor.id !== actor.id) throw new ToolError("NOT_OWNER", "Only the originating MCP client's held actions can be cancelled.");
    return writeResult(await ctx.deps.executor.cancelHold(actionId));
  });
}
