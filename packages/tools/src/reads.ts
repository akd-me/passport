import { getEffectiveProfile } from "@passport/types";
import { labelsAlias, readAlias, searchAlias } from "./aliases.js";
import { availability } from "./availability.js";
import type { Context } from "./context.js";
import {
  actionView,
  emailView,
  eventView,
  json,
  required,
  stripTrackingPixels,
} from "./presentation.js";
import { register } from "./register.js";
import { schema as z } from "./schema.js";
import * as s from "./schemas.js";

export function registerReads(ctx: Context) {
  const { store } = ctx;
  register(
    ctx,
    "search_emails",
    "Deprecated: use mail_search. With on-demand reads it aliases mail_search (compact rows, cursor = pageToken); otherwise searches the local store with EmailQuery filters and FTS5. full=true includes full bodies on the store path.",
    s.emailQuery,
    false,
    async ({ full, ...query }, ctx) => {
      const alias = await searchAlias(ctx, query);
      if (alias) {
        return alias;
      }
      const page = await store.emails.query({
        ...query,
        includeBodies: full || query.includeBodies,
      });
      return json({ ...page, items: page.items.map((email) => emailView(email, full)) });
    },
  );
  register(
    ctx,
    "get_email",
    'Deprecated: use mail_read({view:"message"}). Read one email. Bodies are clipped to 2000 characters unless full=true.',
    { emailId: s.id, full: s.full },
    false,
    async ({ emailId, full }, ctx) =>
      (await readAlias(ctx, emailId, "message", { full }, 'mail_read({view:"message"})')) ??
      json(emailView(await ctx.email(emailId, true), full)),
  );
  register(
    ctx,
    "get_email_body",
    "Deprecated: use mail_read offset/length. Read body chunks using UTF-16 offsets; continue with continueFrom until truncated=false. The response byte budget still applies.",
    {
      emailId: s.id,
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
      length: z.number().int().min(1).max(1_000_000).default(16_000),
    },
    false,
    async ({ emailId, offset, length }, ctx) => {
      const alias = await readAlias(
        ctx,
        emailId,
        "message",
        { full: true, offset, length },
        'mail_read({view:"message",offset,length})',
      );
      if (alias) {
        return alias;
      }
      const email = await ctx.email(emailId, true);
      const text = email.textBody ?? "",
        html = stripTrackingPixels(email.htmlBody ?? "");
      const end = Math.min(offset + length, Math.max(text.length, html.length));
      const textBody = text.slice(offset, offset + length),
        htmlBody = html.slice(offset, offset + length);
      const truncated =
        offset + textBody.length < text.length || offset + htmlBody.length < html.length;
      const ends = [
        text.length > offset + textBody.length ? offset + textBody.length : end,
        html.length > offset + htmlBody.length ? offset + htmlBody.length : end,
      ];
      return json({
        emailId,
        offset,
        textBody,
        htmlBody,
        totalLength: Math.max(text.length, html.length),
        truncated,
        ...(truncated ? { continueFrom: Math.min(...ends) } : {}),
      });
    },
  );
  register(
    ctx,
    "get_thread",
    "Deprecated: use mail_read. Read a thread as chronological emails; continue with nextCursor. Bodies are clipped unless full=true.",
    { threadId: s.id, full: s.full, limit: s.limit, cursor: z.string().nullable().optional() },
    false,
    async ({ threadId, full, limit, cursor }, ctx) => {
      const alias = await readAlias(ctx, threadId, "thread", { full }, "mail_read");
      if (alias) {
        return alias;
      }
      const thread = required(await store.threads.get(threadId), "Thread");
      const page = await store.emails.query({
        threadId,
        accountId: thread.accountId,
        includeDeleted: true,
        sort: "receivedAt_asc",
        includeBodies: true,
        limit,
        cursor,
      });
      return json({
        id: thread.id,
        accountId: thread.accountId,
        ...page,
        items: page.items.map((email) => emailView(email, full)),
      });
    },
  );
  register(
    ctx,
    "list_mailboxes",
    "Deprecated: use mail_labels. List mailboxes and counts for one account, or all accounts when accountId is omitted.",
    { accountId: s.id.optional() },
    false,
    async ({ accountId }, ctx) => {
      const alias = await labelsAlias(ctx, accountId);
      if (alias) {
        return alias;
      }
      const accounts = accountId ? [await ctx.account(accountId)] : await store.accounts.list();
      return json({
        items: (
          await Promise.all(accounts.map((account) => store.mailboxes.list(account.id)))
        ).flat(),
      });
    },
  );
  register(
    ctx,
    "list_matters",
    "List living workspaces, optionally filtering status, participant or text.",
    {
      status: z.array(s.matterStatus).optional(),
      personId: s.id.optional(),
      text: z.string().max(2000).optional(),
      limit: s.limit,
    },
    false,
    async (query, ctx) => json({ items: await store.matters.list(query) }),
  );
  register(
    ctx,
    "get_matter",
    "Read a matter with its attached and linked emails, calendar events and people. Email cursor is an ID from this matter; linkedEmailsNextCursor continues search_emails(matterId).",
    { matterId: s.id, full: s.full, limit: s.limit, cursor: s.id.nullable().optional() },
    false,
    async ({ matterId, full, limit, cursor }, ctx) => {
      const bundle = await ctx.matterBundle(matterId, limit, cursor, true);
      return json({
        ...bundle,
        emails: bundle.emails.map((email) => emailView(email, full)),
        events: bundle.events.map((event) => eventView(event, full)),
      });
    },
  );
  register(
    ctx,
    "list_people",
    "Find people by relationship or text, including their verification and contact history.",
    {
      relationship: s.relationship.optional(),
      text: z.string().max(2000).optional(),
      limit: s.limit,
    },
    false,
    async (query, ctx) => json({ items: await store.people.list(query) }),
  );
  register(
    ctx,
    "get_person",
    "Read a person's identity, relationships, verification and notes.",
    { personId: s.id },
    false,
    async ({ personId }, ctx) => json(required(await store.people.get(personId), "Person")),
  );
  register(
    ctx,
    "list_events",
    "List local calendar events overlapping a UTC time range, optionally scoped to an account or matter.",
    {
      accountId: s.id.optional(),
      range: s.range,
      matterId: s.id.optional(),
      limit: s.limit,
      full: s.full,
    },
    false,
    async ({ full, ...query }, ctx) =>
      json({ items: (await store.events.query(query)).map((event) => eventView(event, full)) }),
  );
  register(
    ctx,
    "free_busy",
    "Compute merged busy intervals, preferring connected provider availability and expanding stored recurring events as fallback.",
    {
      accountId: s.id.optional(),
      range: s.range,
    },
    false,
    async ({ accountId, range }, ctx) => {
      return json({
        range,
        ...(await availability(store, range, { accountId, freeBusy: ctx.deps.freeBusy })),
      });
    },
  );
  register(
    ctx,
    "list_pending_decisions",
    "List actions awaiting human approval (proposed) or outbox release (held); no approval capability is exposed.",
    {
      limit: s.limit,
      cursor: z.string().nullable().optional(),
    },
    false,
    async (query, ctx) => {
      const page = await store.actions.query({ ...query, status: ["proposed", "held"] });
      return json({ ...page, items: page.items.map(actionView) });
    },
  );
  register(
    ctx,
    "list_actions",
    "Read the action audit log with policy decisions. Action parameters, provider results and raw errors are omitted.",
    s.actionQuery,
    false,
    async (query, ctx) => {
      const page = await store.actions.query(query);
      return json({ ...page, items: page.items.map(actionView) });
    },
  );
  register(
    ctx,
    "get_trust",
    "Read the per-category trust ladder and global configuration, including the external-agent ceiling.",
    {},
    false,
    async (_input, ctx) => {
      const [ladder, config] = await Promise.all([
        ctx.deps.policy.getTrust(),
        ctx.deps.policy.getConfig(),
      ]);
      return json({ ladder, config });
    },
  );
  register(
    ctx,
    "get_user_profile",
    "Read USER.md standing instructions from the user_profile store key.",
    {},
    false,
    async (_input, ctx) => json({ markdown: await getEffectiveProfile(store) }),
  );
}
