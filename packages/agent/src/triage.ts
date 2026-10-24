import { availability, availabilityEvents, categorize } from "@passport/tools";
import type {
  ActionCategory,
  Counterparty,
  DraftInput,
  Email,
  Person,
  TimeRange,
} from "@passport/types";
import type { RunContext } from "./context.js";
import { normalizeAddress, overlaps } from "./data.js";
import { recordDecision } from "./decisions.js";
import { AgentError } from "./errors.js";
import { logArrival, watchedMatters } from "./knowledge.js";
import { attachMatter, readThread } from "./matters.js";
import { resolvePeople, serviceSender } from "./people.js";
import { formatDraft } from "./profile.js";
import { classificationPrompt, replyPrompt, schedulingPrompt } from "./prompts/index.js";
import type { AgentReader } from "./reads.js";
import { classificationSchema, replySchema, scheduleSchema } from "./schemas.js";

/** Cheap, deterministic categories; undefined delegates to the fast model. */
export function heuristicCategory(email: Email): ActionCategory | undefined {
  if (email.headers.listUnsubscribe) {
    return "newsletters";
  }
  if (
    /\b(receipt|invoice|order\s+(confirmation|confirmed|#|number)|payment\s+(received|receipt)|purchase\s+confirmation)\b/i.test(
      `${email.subject}\n${email.preview}`,
    )
  ) {
    return "receipts";
  }
  if (
    email.attachments.some((a) => /text\/calendar/i.test(a.type) || /\.ics$/i.test(a.name)) ||
    /text\/calendar/i.test(email.headers.extra?.["content-type"] ?? "") ||
    /\b(invitation|invite|calendar|meeting request)\b/i.test(email.subject)
  ) {
    return "scheduling";
  }
  if (serviceSender(email)) {
    return "notifications";
  }
  return undefined;
}

/** Sensitive evidence precedes bulk-mail signals. Routine receipts alone are not money requests. */
export function sensitiveCategory(
  email: Email,
  people: readonly Person[] = [],
): ActionCategory | undefined {
  if (email.category === "money" || email.category === "legal") {
    return email.category;
  }
  const text = `${email.subject}\n${email.preview}\n${email.textBody ?? ""}\n${email.htmlBody ?? ""}`;
  if (
    /\b(legal|lawsuit|litigation|subpoena|settlement|attorney|court order|contract|cease and desist)\b/i.test(
      text,
    )
  ) {
    return "legal";
  }
  if (
    /\b(wire transfer|bank account|payment required|payment due|overdue|pay now|send money|transfer funds|authorize payment)\b/i.test(
      text,
    )
  ) {
    return "money";
  }
  const stranger = email.from.some((address) =>
    people.some(
      (person) =>
        person.relationship === "stranger" &&
        person.emails.some(
          (candidate) => normalizeAddress(candidate) === normalizeAddress(address.email),
        ),
    ),
  );
  if (
    stranger &&
    /\b(?:please (?:send|provide|sign|approve)|(?:can|could|would) you (?:send|provide|sign|approve))\b/i.test(
      text,
    )
  ) {
    return "replies_stranger";
  }
  return undefined;
}

function emailCounterparty(email: Email, people: Person[], downgraded = false): Counterparty {
  const counterparty = categorize({ type: "archive", emails: [email], people }).counterparty ?? {
    emails: [],
    class: "stranger" as const,
  };
  return downgraded ? { ...counterparty, class: "stranger" } : counterparty;
}

function replyDraft(ctx: RunContext, email: Email, textBody: string): DraftInput {
  return {
    accountId: email.accountId,
    inReplyToEmailId: email.id,
    to: (email.replyTo.length ? email.replyTo : email.from).filter(
      (address) => !ctx.selfAddresses.has(normalizeAddress(address.email)),
    ),
    subject: /^re:/i.test(email.subject) ? email.subject : `Re: ${email.subject}`,
    textBody: formatDraft(textBody, ctx.profile, ctx.drafts),
  };
}

async function scheduling(
  ctx: RunContext,
  email: Email,
  counterparty: Counterparty,
  matterId?: string,
): Promise<void> {
  const start = ctx.now();
  const range = { start, end: new Date(Date.parse(start) + 14 * 86_400_000).toISOString() };
  const events = await availabilityEvents(ctx.store, range);
  const event = events.find(
    (item) => item.sourceEmailId === email.id && item.status !== "cancelled",
  );
  const { busy } = await availability(ctx.store, range, {
    freeBusy: ctx.freeBusy,
    excludeEventId: event?.id,
  });
  const response = await ctx.structured(
    scheduleSchema,
    schedulingPrompt(email, busy, range, event),
  );
  if (event) {
    const conflict = busy.some((slot) => overlaps(slot, event));
    const status =
      response.status === "accepted" && conflict
        ? "tentative"
        : (response.status as "accepted" | "tentative" | "declined");
    await ctx.callTool(
      "respond_to_event",
      {
        eventId: event.id,
        status,
        comment: formatDraft(String(response.textBody), ctx.profile, ctx.drafts),
        reason: `Propose ${status} for “${event.title}”${conflict ? "; calendar conflict requires review" : ""}`,
      },
      { matterId },
    );
  } else {
    const slots = response.slots as TimeRange[];
    for (const slot of slots) {
      const from = Date.parse(slot.start),
        to = Date.parse(slot.end);
      if (
        !Number.isFinite(from) ||
        !Number.isFinite(to) ||
        from >= to ||
        from < Date.parse(range.start) ||
        to > Date.parse(range.end) ||
        busy.some((item) => overlaps(item, slot))
      ) {
        throw new AgentError("Model proposed an invalid or busy meeting slot", "LLM_SCHEDULE");
      }
    }
    if (!slots.length) {
      await ctx.callTool(
        "create_draft",
        {
          draft: replyDraft(ctx, email, String(response.textBody)),
          reason: `Draft scheduling response without available slots: ${email.subject}`,
        },
        { classification: "scheduling", classificationEmailIds: [email.id], matterId },
      );
      return;
    }
    await ctx.callTool(
      "propose_meeting",
      {
        draft: replyDraft(ctx, email, String(response.textBody)),
        slots,
        reason: `Draft a scheduling proposal for “${email.subject}”`,
      },
      { matterId },
    );
  }
}

/**
 * The arrival may be an envelope only (v0.3 envelope cache). `store.emails.get` with bodies is
 * read-through; when it still has no bodies, one reader `body` call fills them. Without either,
 * triage proceeds on the subject and preview.
 */
async function withBodies(
  ctx: RunContext,
  email: Email,
  reader: AgentReader | null,
): Promise<Email> {
  if (email.textBody != null || email.htmlBody != null || !reader) {
    return email;
  }
  const body = await reader.call((r, opts) => r.body(email.providerId, opts));
  if (!body) {
    ctx.notes.push(`Bodies for ${email.id} were unavailable; triaged from the envelope.`);
    return email;
  }
  return {
    ...email,
    textBody: body.value.textBody ?? null,
    htmlBody: body.value.htmlBody ?? null,
    attachments: body.value.attachments.length ? body.value.attachments : email.attachments,
  };
}

export async function prepareTriage(
  ctx: RunContext,
  emailId: string,
  bus: import("@passport/types").EventBus,
) {
  const step = ctx.triageStep ?? (async <T>(_name: string, task: () => Promise<T>) => task());
  const stored = await ctx.store.emails.get(emailId, ctx.reads.storeRead({ includeBodies: true }));
  if (!stored) {
    throw new AgentError("Received email was not found in the store", "EMAIL_NOT_FOUND");
  }
  const reader = await ctx.reads.reader(stored.accountId);
  const email = await withBodies(ctx, stored, reader);
  // Relationship evidence draws from its own budget (bounded per arrival).
  const peopleReader = await ctx.reads.reader(stored.accountId, "people");
  const resolved = await step("people", () =>
    resolvePeople({
      email,
      store: ctx.store,
      bus,
      selfAddresses: ctx.selfAddresses,
      now: ctx.now(),
      reader: peopleReader,
      savePerson: async (person, reason) => {
        await ctx.callTool(
          "update_person",
          {
            accountId: email.accountId,
            personId: person.id,
            patch: { displayName: person.displayName },
            reason,
          },
          { personSnapshot: person, projectedPeople: [person] },
        );
      },
    }),
  );
  ctx.downgrades.push(...resolved.downgraded);
  return { email, reader, resolved };
}

export async function triage(
  ctx: RunContext,
  emailId: string,
  bus: import("@passport/types").EventBus,
  prepared?: Awaited<ReturnType<typeof prepareTriage>>,
  deterministic = false,
): Promise<void> {
  const step = ctx.triageStep ?? (async <T>(_name: string, task: () => Promise<T>) => task());
  const { email, reader, resolved } = prepared ?? (await prepareTriage(ctx, emailId, bus));
  const category = await step("classify", async () => {
    let category = sensitiveCategory(email, resolved.people);
    if (!category && deterministic) {
      category = heuristicCategory(email);
    }
    if (!category) {
      const modelCategory = (
        await ctx.structured(
          classificationSchema,
          classificationPrompt(email, resolved.people),
          "fast",
        )
      ).category as ActionCategory;
      // The fast model screens even routine-looking mail for sensitive or stranger requests.
      category = ["money", "legal", "replies_stranger"].includes(modelCategory)
        ? modelCategory
        : (heuristicCategory(email) ?? modelCategory);
    }
    const downgraded =
      resolved.downgraded.length > 0 || email.verification.passport === "downgraded";
    const knownSender = resolved.people.some(
      (person) =>
        (person.relationship === "known" ||
          (person.relationship === "self" &&
            (person.verifiedSelf ||
              person.emails.every((address) =>
                ctx.selfAddresses.has(normalizeAddress(address)),
              )))) &&
        email.from.some((address) => person.emails.includes(normalizeAddress(address.email))),
    );
    return category === "replies_known" && (!knownSender || downgraded)
      ? "replies_stranger"
      : category;
  });
  const downgraded = resolved.downgraded.length > 0 || email.verification.passport === "downgraded";
  const counterparty = emailCounterparty(email, resolved.people, downgraded);
  if (counterparty.personId && !resolved.persistedIds.includes(counterparty.personId)) {
    counterparty.personId = null;
  }
  // One durable step: watch checks, the matter decision and its notes line replay together.
  const matter = await step("matter", async () => {
    const watched = await watchedMatters(ctx, email, resolved.persistedIds, reader);
    const attached = await attachMatter(
      ctx,
      email,
      category,
      resolved.persistedIds,
      reader,
      watched,
      deterministic,
    );
    const sender = resolved.people.find(
      (person) =>
        resolved.persistedIds.includes(person.id) &&
        email.from.some((address) => person.emails.includes(normalizeAddress(address.email))),
    );
    await logArrival(ctx, { email, category, matter: attached, sender, watched });
    return attached;
  });
  const common = { accountId: email.accountId, emailIds: [email.id] };
  const toolContext = {
    classification: category,
    classificationEmailIds: [email.id],
    projectedPeople: resolved.people,
    matterId: matter.id,
  };
  await step(category === "scheduling" ? "scheduling" : "playbook", async () => {
    if ((await ctx.policy.getConfig()).alwaysAsk.includes(category)) {
      const proposal =
        category === "newsletters" || category === "receipts"
          ? `Propose labeling and archiving ${category}`
          : category === "notifications"
            ? "Propose marking read and archiving"
            : "Propose human review";
      const summary = `${matter.summary} ${proposal}: ${category} is in alwaysAsk and requires human approval.`;
      const decision = {
        emailId: email.id,
        ...(matter.id ? { matterId: matter.id } : {}),
        summary,
      };
      ctx.decisions.push(decision);
      await recordDecision(ctx.store, ctx.run.id, decision);
    } else if (category === "newsletters" || category === "receipts") {
      if ((await ctx.store.accounts.get(email.accountId))?.capabilities.labels) {
        await ctx.callTool(
          "label_emails",
          {
            ...common,
            label: category === "receipts" ? "Receipts" : "Newsletters",
            reason: `Label ${category}: ${email.subject}`,
          },
          toolContext,
        );
      }
      await ctx.callTool(
        "archive_emails",
        { ...common, reason: `Archive routine ${category}: ${email.subject}` },
        toolContext,
      );
    } else if (category === "notifications") {
      await ctx.callTool(
        "mark_read",
        { ...common, reason: `Mark routine notification read: ${email.subject}` },
        toolContext,
      );
      await ctx.callTool(
        "archive_emails",
        { ...common, reason: `Archive routine notification: ${email.subject}` },
        toolContext,
      );
    } else if (category === "scheduling") {
      await scheduling(ctx, email, counterparty, matter.id);
    } else if (category === "replies_known") {
      const response = await ctx.structured(
        replySchema,
        replyPrompt(email, await readThread(ctx.store, email, reader, ctx.reads.storeRead)),
      );
      await ctx.callTool(
        "create_draft",
        {
          draft: replyDraft(ctx, email, String(response.textBody)),
          reason: `Draft a reply for review: ${email.subject}`,
        },
        toolContext,
      );
    } else {
      const decision = {
        emailId: email.id,
        ...(matter.id ? { matterId: matter.id } : {}),
        summary: matter.summary,
      };
      ctx.decisions.push(decision);
      await recordDecision(ctx.store, ctx.run.id, decision);
    }
  });
  await step("done", async () => undefined);
  ctx.notes.push(
    `Triaged ${email.id} as ${category}${ctx.decisions.some((d) => d.emailId === email.id) ? "; decision needed" : ""}.`,
  );
}
