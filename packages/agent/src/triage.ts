import { availability, availabilityEvents, categorize } from "@passport/tools";
import type { ActionCategory, Counterparty, DraftInput, Email, Matter, Person, Store, TimeRange } from "@passport/types";
import type { RunContext } from "./context.js";
import { allEmails, normalizeAddress, overlaps } from "./data.js";
import { recordDecision } from "./decisions.js";
import { AgentError } from "./errors.js";
import type { AgentMatterAttachParams, AgentMatterCreateParams } from "./integration.js";
import { isObject } from "./llm/json.js";
import { resolvePeople, serviceSender } from "./people.js";
import { formatDraft } from "./profile.js";
import { classificationPrompt, matterPrompt, replyPrompt, schedulingPrompt } from "./prompts/index.js";
import { classificationSchema, matterSchema, replySchema, scheduleSchema } from "./schemas.js";

/** Cheap, deterministic categories; undefined delegates to the fast model. */
export function heuristicCategory(email: Email): ActionCategory | undefined {
  if (email.headers.listUnsubscribe) return "newsletters";
  if (/\b(receipt|invoice|order\s+(confirmation|confirmed|#|number)|payment\s+(received|receipt)|purchase\s+confirmation)\b/i.test(`${email.subject}\n${email.preview}`)) return "receipts";
  if (email.attachments.some(a => /text\/calendar/i.test(a.type) || /\.ics$/i.test(a.name)) || /text\/calendar/i.test(email.headers.extra?.["content-type"] ?? "") || /\b(invitation|invite|calendar|meeting request)\b/i.test(email.subject)) return "scheduling";
  if (serviceSender(email)) return "notifications";
  return undefined;
}

export function emailCounterparty(email: Email, people: Person[], downgraded = false): Counterparty {
  const counterparty = categorize({ type: "archive", emails: [email], people }).counterparty ?? { emails: [], class: "stranger" as const };
  return downgraded ? { ...counterparty, class: "stranger" } : counterparty;
}

async function candidates(store: Store, email: Email, personIds: string[]): Promise<Matter[]> {
  const matters = new Map<string, Matter>();
  const addId = async (id?: string | null): Promise<void> => {
    if (id && !matters.has(id)) { const matter = await store.matters.get(id); if (matter) matters.set(id, matter); }
  };
  await addId(email.matterId);
  const thread = await store.emails.query({ threadId: email.threadId, limit: 30 });
  for (const item of thread.items) await addId(item.matterId);
  for (const personId of personIds) {
    for (const matter of await store.matters.list({ personId, status: ["active", "waiting"], limit: 8 })) matters.set(matter.id, matter);
  }
  // Quote individual tokens, never interpolate a subject as executable FTS syntax.
  const words = email.subject.match(/[\p{L}\p{N}]{3,}/gu)?.slice(0, 6) ?? [];
  if (words.length) {
    const similar = await store.emails.query({ text: words.map(word => `"${word}"`).join(" OR "), limit: 12 });
    for (const item of similar.items) await addId(item.matterId);
  }
  return [...matters.values()].slice(0, 12);
}

async function attachMatter(ctx: RunContext, email: Email, category: ActionCategory, personIds: string[], counterparty: Counterparty): Promise<{ id?: string; summary: string }> {
  const options = await candidates(ctx.store, email, personIds);
  const vendor = (email.from[0]?.name || email.from[0]?.email.split("@")[1] || "Unknown vendor").replace(/[\r\n/\\]/g, " ").trim();
  const purchaseTitle = `Purchases/${vendor}`;
  if (category === "receipts") {
    for (const matter of await ctx.store.matters.list({ text: purchaseTitle, limit: 10 })) if (!options.some(m => m.id === matter.id)) options.push(matter);
  }
  const proposal = await ctx.structured(matterSchema, matterPrompt(email, options));
  const selected = category === "receipts" ? options.find(matter => matter.title === purchaseTitle) : options.find(matter => matter.id === proposal.matterId);
  if (category !== "receipts" && proposal.matterId !== null && !selected) throw new AgentError("Model selected a matter outside the candidate set", "LLM_MATTER");
  const summary = String(proposal.summary);
  const emailPatch = { category, personIds };
  if (selected) {
    const params: AgentMatterAttachParams = { matterId: selected.id, emailIds: [email.id], personIds, emailPatch };
    await ctx.callTool("attach_to_matter", { accountId: email.accountId, matterId: params.matterId, emailIds: params.emailIds, personIds: params.personIds, reason: `Organize “${email.subject}” in ${selected.title}` }, { emailPatch, matterId: selected.id });
    return { id: selected.id, summary };
  }
  const params: AgentMatterCreateParams = {
    matter: { title: category === "receipts" ? purchaseTitle : String(proposal.title), kind: category === "receipts" ? "purchase" : String(proposal.kind), summary, nextStep: String(proposal.nextStep), status: "active", personIds, emailIds: [email.id], eventIds: [] }, emailPatch,
  };
  await ctx.callTool("create_matter", { accountId: email.accountId, matter: params.matter, reason: `Create matter: ${params.matter.title}. ${summary}` }, { emailPatch });
  const record = ctx.actions.at(-1)!;
  if (record.status !== "executed") return { summary };
  const result = record.result;
  const resultMatter = isObject(result?.matter) ? result.matter : undefined;
  const id = typeof result?.matterId === "string" ? result.matterId : typeof resultMatter?.id === "string" ? resultMatter.id : typeof result?.id === "string" ? result.id : undefined;
  const attached = await ctx.store.emails.get(email.id);
  const persisted = id ? await ctx.store.matters.get(id) : attached?.matterId ? await ctx.store.matters.get(attached.matterId) : (await ctx.store.matters.list()).find(matter => matter.emailIds.includes(email.id));
  if (!persisted) throw new AgentError("Executed matter_create did not persist or return a discoverable matter", "EXECUTOR_RESULT");
  return { id: persisted.id, summary };
}

export async function readThread(store: Store, email: Email): Promise<Email[]> {
  const thread = await store.threads.get(email.threadId);
  if (thread) {
    const items = await Promise.all(thread.emailIds.map(id => store.emails.get(id, { includeBodies: true })));
    return items.filter((item): item is Email => item !== null).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }
  return allEmails(store, { threadId: email.threadId, includeBodies: true, sort: "receivedAt_asc" });
}

export function replyDraft(ctx: RunContext, email: Email, textBody: string): DraftInput {
  return { accountId: email.accountId, inReplyToEmailId: email.id, to: (email.replyTo.length ? email.replyTo : email.from).filter(address => !ctx.selfAddresses.has(normalizeAddress(address.email))), subject: /^re:/i.test(email.subject) ? email.subject : `Re: ${email.subject}`, textBody: formatDraft(textBody, ctx.profile, ctx.drafts) };
}

async function scheduling(ctx: RunContext, email: Email, counterparty: Counterparty, matterId?: string): Promise<void> {
  const start = ctx.now();
  const range = { start, end: new Date(Date.parse(start) + 14 * 86_400_000).toISOString() };
  const events = await availabilityEvents(ctx.store, range);
  const event = events.find(item => item.sourceEmailId === email.id && item.status !== "cancelled");
  const { busy } = await availability(ctx.store, range, { freeBusy: ctx.freeBusy, excludeEventId: event?.id });
  const response = await ctx.structured(scheduleSchema, schedulingPrompt(email, busy, range, event));
  if (event) {
    const conflict = busy.some(slot => overlaps(slot, event));
    const status = response.status === "accepted" && conflict ? "tentative" : response.status as "accepted" | "tentative" | "declined";
    await ctx.callTool("respond_to_event", { eventId: event.id, status, comment: formatDraft(String(response.textBody), ctx.profile, ctx.drafts), reason: `Propose ${status} for “${event.title}”${conflict ? "; calendar conflict requires review" : ""}` }, { matterId });
  } else {
    const slots = response.slots as TimeRange[];
    for (const slot of slots) {
      const from = Date.parse(slot.start), to = Date.parse(slot.end);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || from < Date.parse(range.start) || to > Date.parse(range.end) || busy.some(item => overlaps(item, slot))) {
        throw new AgentError("Model proposed an invalid or busy meeting slot", "LLM_SCHEDULE");
      }
    }
    if (!slots.length) {
      await ctx.callTool("create_draft", { draft: replyDraft(ctx, email, String(response.textBody)), reason: `Draft scheduling response without available slots: ${email.subject}` }, { classification: "scheduling", matterId });
      return;
    }
    await ctx.callTool("propose_meeting", { draft: replyDraft(ctx, email, String(response.textBody)), slots, reason: `Draft a scheduling proposal for “${email.subject}”` }, { matterId });
  }
}

export async function triage(ctx: RunContext, emailId: string, bus: import("@passport/types").EventBus): Promise<void> {
  const email = await ctx.store.emails.get(emailId, { includeBodies: true });
  if (!email) throw new AgentError("Received email was not found in the store", "EMAIL_NOT_FOUND");
  const resolved = await resolvePeople({ email, store: ctx.store, bus, selfAddresses: ctx.selfAddresses, now: ctx.now(), savePerson: async (person, reason) => {
    await ctx.callTool("update_person", { accountId: email.accountId, personId: person.id, patch: { displayName: person.displayName }, reason }, { personSnapshot: person, projectedPeople: [person] });
  } });
  ctx.downgrades.push(...resolved.downgraded);
  let category = heuristicCategory(email);
  if (!category) category = (await ctx.structured(classificationSchema, classificationPrompt(email, resolved.people), "fast")).category as ActionCategory;
  const downgraded = resolved.downgraded.length > 0 || email.verification.passport === "downgraded";
  const counterparty = emailCounterparty(email, resolved.people, downgraded);
  if (counterparty.personId && !resolved.persistedIds.includes(counterparty.personId)) counterparty.personId = null;
  const knownSender = resolved.people.some(person => (person.relationship === "known" || person.relationship === "self" && (person.verifiedSelf || person.emails.every(address => ctx.selfAddresses.has(normalizeAddress(address))))) && email.from.some(address => person.emails.includes(normalizeAddress(address.email))));
  if (category === "replies_known" && (!knownSender || downgraded)) category = "replies_stranger";
  const matter = await attachMatter(ctx, email, category, resolved.persistedIds, counterparty);
  const common = { accountId: email.accountId, emailIds: [email.id] };
  const toolContext = { classification: category, projectedPeople: resolved.people, matterId: matter.id };
  if (category === "newsletters" || category === "receipts") {
    if ((await ctx.store.accounts.get(email.accountId))?.capabilities.labels) await ctx.callTool("label_emails", { ...common, label: category === "receipts" ? "Receipts" : "Newsletters", reason: `Label ${category}: ${email.subject}` }, toolContext);
    await ctx.callTool("archive_emails", { ...common, reason: `Archive routine ${category}: ${email.subject}` }, toolContext);
  } else if (category === "notifications") {
    await ctx.callTool("mark_read", { ...common, reason: `Mark routine notification read: ${email.subject}` }, toolContext);
    await ctx.callTool("archive_emails", { ...common, reason: `Archive routine notification: ${email.subject}` }, toolContext);
  } else if (category === "scheduling") {
    await scheduling(ctx, email, counterparty, matter.id);
  } else if (category === "replies_known") {
    const response = await ctx.structured(replySchema, replyPrompt(email, await readThread(ctx.store, email)));
    await ctx.callTool("create_draft", { draft: replyDraft(ctx, email, String(response.textBody)), reason: `Draft a reply for review: ${email.subject}` }, toolContext);
  } else {
    const decision = { emailId: email.id, ...(matter.id ? { matterId: matter.id } : {}), summary: matter.summary };
    ctx.decisions.push(decision);
    await recordDecision(ctx.store, ctx.run.id, decision);
  }
  ctx.notes.push(`Triaged ${email.id} as ${category}${ctx.decisions.some(d => d.emailId === email.id) ? "; decision needed" : ""}.`);
}
