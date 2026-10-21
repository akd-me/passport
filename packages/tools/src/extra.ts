import type { ActionRecord, EmailQuery, TimeRange } from "@passport/types";
import { getEffectiveProfile } from "@passport/types";
import { availability } from "./availability.js";
import type { Context } from "./context.js";
import { actionView, emailView, json, required, ToolError, writeResult } from "./presentation.js";
import { register } from "./register.js";
import { schema as z } from "./schema.js";
import * as s from "./schemas.js";
import { editStandingRule, standingRules } from "./standing-rules.js";

const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm working hours.");
const day = z.number().int().min(0).max(6);

export function registerExtra(ctx: Context) {
  const { store } = ctx;
  register(
    ctx,
    "summarize_thread",
    "Summarize a stored thread without an LLM: participants, chronological previews, candidate open questions and last message. Questions are heuristic, not confirmed unresolved.",
    {
      threadId: s.id,
      full: s.full,
      limit: s.limit,
      cursor: z.string().nullable().optional(),
    },
    false,
    async ({ threadId, full, limit, cursor }) => {
      const thread = required(await store.threads.get(threadId), "Thread");
      const page = await store.emails.query({
        threadId,
        accountId: thread.accountId,
        includeDeleted: true,
        includeBodies: true,
        sort: "receivedAt_asc",
        limit,
        cursor,
      });
      const last = await store.emails.query({
        threadId,
        accountId: thread.accountId,
        includeDeleted: true,
        includeBodies: true,
        sort: "receivedAt_desc",
        limit: 1,
      });
      const participants = [
        ...new Map(
          page.items
            .flatMap((email) => [...email.from, ...email.to, ...email.cc])
            .map((address) => [address.email.toLowerCase(), address]),
        ).values(),
      ];
      const questions = page.items
        .slice(-10)
        .flatMap((email) =>
          (email.textBody ?? email.preview)
            .split(/\r?\n/)
            .filter((line) => !/^\s*>/.test(line))
            .flatMap((line) => line.match(/[^.!?]*\?/g) ?? [])
            .slice(0, 5)
            .map((text) => ({ emailId: email.id, question: text.trim().slice(0, 240) })),
        )
        .slice(-20);
      return json({
        threadId,
        participants,
        timeline: page.items.map((email) => ({
          emailId: email.id,
          at: email.sentAt ?? email.receivedAt,
          from: email.from,
          preview: email.preview.slice(0, 240),
        })),
        openQuestions: questions,
        questionsAreHeuristic: true,
        lastMessage: last.items[0] ? emailView(last.items[0], full) : null,
        nextCursor: page.nextCursor ?? null,
        total: page.total,
      });
    },
  );
  register(
    ctx,
    "find_free_slots",
    "Find duration-sized free slots from synced events, within a UTC window and IANA-zone working hours. Days use 0=Sunday. Prefers connected provider availability; expands local recurring events as fallback; maximum window 31 days.",
    {
      accountId: s.id.optional(),
      durationMinutes: z.number().int().min(1).max(1440),
      window: s.range,
      workingHours: z
        .strictObject({
          start: clock,
          end: clock,
          days: z.array(day).min(1).max(7).default([1, 2, 3, 4, 5]),
        })
        .default({ start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] }),
      timeZone: z.string().max(100).default("UTC"),
      limit: s.limit,
    },
    false,
    async ({ accountId, durationMinutes, window, workingHours, timeZone, limit }) => {
      if (
        Date.parse(window.end) - Date.parse(window.start) > 31 * 86_400_000 ||
        minutes(workingHours.start) >= minutes(workingHours.end)
      )
        throw new ToolError(
          "INVALID_INPUT",
          "Use a window of at most 31 days and start before end working hours.",
        );
      let formatter: Intl.DateTimeFormat;
      try {
        formatter = new Intl.DateTimeFormat("en-US", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        });
      } catch {
        throw new ToolError("INVALID_INPUT", "Unknown IANA time zone.");
      }
      const local = (time: number) => {
        const parts = Object.fromEntries(
          formatter.formatToParts(time).map((part) => [part.type, part.value]),
        );
        return {
          date: `${parts.year}-${parts.month}-${parts.day}`,
          day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!),
          minute: Number(parts.hour) * 60 + Number(parts.minute),
        };
      };
      const { busy, source } = await availability(store, window, {
        accountId,
        freeBusy: ctx.deps.freeBusy,
      });
      const slots: TimeRange[] = [];
      const duration = durationMinutes * 60_000;
      for (
        let start = Math.ceil(Date.parse(window.start) / 60_000) * 60_000;
        start + duration <= Date.parse(window.end);
        start += 60_000
      ) {
        const from = local(start),
          to = local(start + duration);
        if (
          from.date !== to.date ||
          !workingHours.days.includes(from.day) ||
          from.minute < minutes(workingHours.start) ||
          to.minute > minutes(workingHours.end)
        )
          continue;
        if (
          busy.some(
            (event) => Date.parse(event.start) < start + duration && Date.parse(event.end) > start,
          )
        )
          continue;
        slots.push({
          start: new Date(start).toISOString(),
          end: new Date(start + duration).toISOString(),
        });
        if (slots.length === limit) break;
        start += duration - 60_000;
      }
      return json({ slots, timeZone, source, limitReached: slots.length === limit });
    },
  );
  register(
    ctx,
    "list_recent_from_person",
    "List recent incoming mail from a person's known addresses, excluding messages merely addressed to them.",
    {
      personId: s.id,
      accountId: s.id.optional(),
      limit: s.limit,
      cursor: z.string().nullable().optional(),
      full: s.full,
    },
    false,
    async ({ personId, accountId, limit, cursor, full }) => {
      const person = required(await store.people.get(personId), "Person");
      const addresses = new Set(
        [...person.emails, person.primaryEmail].map((email) => email.toLowerCase()),
      );
      const items: Awaited<ReturnType<typeof store.emails.query>>["items"] = [];
      let next = cursor ?? undefined;
      const seen = new Set<string>();
      do {
        const page = await store.emails.query({
          accountId,
          limit: limit - items.length,
          cursor: next,
          includeBodies: full,
          sort: "receivedAt_desc",
        });
        items.push(
          ...page.items.filter((email) =>
            email.from.some((address) => addresses.has(address.email.toLowerCase())),
          ),
        );
        next = page.nextCursor ?? undefined;
        if (next && seen.has(next))
          throw new ToolError("INVALID_CURSOR", "Store returned a repeated email cursor.");
        if (next) seen.add(next);
      } while (next && items.length < limit);
      return json({
        items: items.map((email) => emailView(email, full)),
        nextCursor: next ?? null,
      });
    },
  );
  register(
    ctx,
    "search_people",
    "Search local people by name or email; returns identities and relationship context.",
    {
      text: z.string().trim().min(1).max(2000),
      relationship: s.relationship.optional(),
      limit: s.limit,
    },
    false,
    async (query) => json({ items: await store.people.list(query) }),
  );

  const { full: _full, includeBodies: _bodies, ...queryFields } = s.emailQuery;
  const query = z.strictObject(queryFields);
  for (const [name, type, description] of [
    [
      "batch_archive_by_query",
      "archive",
      "Archive matches of an EmailQuery in one audited action, capped at 200. dryRun returns count and sample without submitting.",
    ],
    [
      "apply_label_by_query",
      "label",
      "Label matches of an EmailQuery in one audited action, capped at 200. dryRun returns count and sample without submitting.",
    ],
  ] as const) {
    register(
      ctx,
      name,
      description,
      {
        query,
        dryRun: z.boolean().default(false),
        reason: s.reason,
        ...(type === "label" ? { label: z.string().trim().min(1).max(200) } : {}),
      },
      true,
      async (input, call) => {
        const page = await store.emails.query({
          ...(input.query as EmailQuery),
          limit: 200,
          includeBodies: false,
        });
        const items = page.items.slice(0, 200);
        const preview = {
          count: items.length,
          total: page.total,
          capped: Boolean(page.nextCursor) || (page.total ?? 0) > items.length,
          sample: items.slice(0, 5).map((email) => ({
            id: email.id,
            subject: email.subject,
            preview: email.preview.slice(0, 160),
          })),
        };
        if (input.dryRun || !items.length) return json({ dryRun: input.dryRun, ...preview });
        const batch = await call.emailBatch(
          items.map((email) => email.id),
          input.query.accountId,
        );
        const result =
          type === "archive"
            ? await call.submit(
                "archive",
                batch.accountId,
                { emailIds: items.map((email) => email.id) },
                input.reason,
                batch,
              )
            : await call.submit(
                "label",
                batch.accountId,
                { emailIds: items.map((email) => email.id), label: required(input.label, "Label") },
                input.reason,
                batch,
              );
        return writeResult(result);
      },
    );
  }
  register(
    ctx,
    "get_standing_rules",
    "Read bullet rules from the Standing rules section of USER.md.",
    {},
    false,
    async () => json({ rules: standingRules(await getEffectiveProfile(store)).rules }),
  );
  for (const [name, remove] of [
    ["add_standing_rule", false],
    ["remove_standing_rule", true],
  ] as const) {
    register(
      ctx,
      name,
      `${remove ? "Remove" : "Add"} one exact bullet rule in USER.md; submits a reversible matters/profile_update action. Other sections are preserved.`,
      {
        rule: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .regex(/^[^\r\n]+$/, "Rule must be one line."),
        accountId: s.id.optional(),
        reason: s.reason,
      },
      true,
      async ({ rule, accountId, reason }, call) => {
        const markdown = editStandingRule(await getEffectiveProfile(store), rule, remove);
        return writeResult(
          await call.submit(
            "profile_update",
            (await call.account(accountId)).id,
            { markdown },
            reason,
          ),
        );
      },
    );
  }
  register(
    ctx,
    "get_daily_log",
    "Read actions proposed or executed on a UTC calendar date, grouped by current status. Includes actions released today from an earlier day.",
    {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD."),
    },
    false,
    async ({ date }) => {
      const start = Date.parse(`${date}T00:00:00.000Z`);
      if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== date)
        throw new ToolError("INVALID_INPUT", "Invalid calendar date.");
      const records: ActionRecord[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await store.actions.query({ limit: 200, cursor });
        records.push(
          ...page.items.filter(
            (action) =>
              action.createdAt.slice(0, 10) === date || action.executedAt?.slice(0, 10) === date,
          ),
        );
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor))
          throw new ToolError("INVALID_CURSOR", "Store returned a repeated action cursor.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      const groups: Record<string, ReturnType<typeof actionView>[]> = {};
      for (const action of records) (groups[action.status] ??= []).push(actionView(action));
      return json({ date, count: records.length, groups });
    },
  );
  register(
    ctx,
    "explain_decision",
    "Explain a persisted policy decision with current category trust, policy constraints and changes that could affect future decisions. Does not approve or change trust.",
    {
      actionId: s.id,
    },
    false,
    async ({ actionId }) => {
      const action = required(await store.actions.get(actionId), "Action");
      const [trust, config] = await Promise.all([
        ctx.deps.policy.getTrustFor(action.request.category),
        ctx.deps.policy.getConfig(),
      ]);
      const changes = [
        "Human approval can authorize a proposed action; held actions wait for the outbox deadline.",
      ];
      if (config.alwaysAsk.includes(action.request.category))
        changes.push("This category is in alwaysAsk; earned trust cannot remove that requirement.");
      if (trust.level === "supervised" || config.globalMode === "supervised")
        changes.push(
          "Supervised trust requires human review. Approvals without edits build category evidence; the user controls promotions and the global mode.",
        );
      if (action.request.actor.kind === "external-agent")
        changes.push(
          `External-agent trust is capped at ${config.externalAgentCeiling}; category trust cannot exceed that ceiling.`,
        );
      if (action.decision.outcome === "deny")
        changes.push(
          "A fixed policy restriction may still deny the action at higher trust; use the human UI to inspect it.",
        );
      return json({
        ...actionView(action),
        trust,
        config,
        whatWouldChangeIt: changes,
        historicalDecision: true,
      });
    },
  );
  register(
    ctx,
    "preview_unsubscribe",
    "Preview supported unsubscribe methods from normalized headers only. Returns a host/address, never token-bearing URLs. Makes no requests and sends no mail.",
    {
      emailId: s.id,
    },
    false,
    async ({ emailId }, call) => {
      const email = await call.email(emailId);
      const targets = (email.headers.listUnsubscribe ?? "").match(/<([^<>]+)>/g) ?? [];
      let https: string | undefined, mailto: string | undefined;
      for (const target of targets) {
        try {
          const url = new URL(target.slice(1, -1).trim());
          if (url.username || url.password) continue;
          if (url.protocol === "https:") https ??= url.host;
          if (
            url.protocol === "mailto:" &&
            /^[^\s<>@,;?]+@[^\s<>@,;?]+$/.test(decodeURIComponent(url.pathname))
          )
            mailto ??= decodeURIComponent(url.pathname);
        } catch {
          /* An invalid header target provides no capability. */
        }
      }
      const oneClick = /(?:^|[;\s])List-Unsubscribe\s*=\s*One-Click(?:$|[;\s])/i.test(
        email.headers.listUnsubscribePost ?? "",
      );
      const method = oneClick && https ? "header" : mailto ? "header" : https ? "link" : null;
      const reply = email.replyTo[0]?.email ?? email.from[0]?.email;
      return json({
        emailId,
        method,
        transport:
          method === "header"
            ? oneClick && https
              ? "https_post"
              : "mailto"
            : method === "link"
              ? "https_get"
              : null,
        target: method === "link" || (oneClick && https) ? https : mailto,
        supported: method !== null,
        ...(reply ? { explicitReplyAlternative: { method: "reply", target: reply } } : {}),
        sideEffects: false,
      });
    },
  );
}
