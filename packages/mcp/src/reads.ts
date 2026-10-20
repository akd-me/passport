import { z } from "zod";
import type { Context } from "./context.js";
import { actionView, emailView, eventView, json, required } from "./presentation.js";
import { register } from "./register.js";
import * as s from "./schemas.js";

export function registerReads(ctx: Context) {
  const { store, server } = ctx;
  register(server, "search_emails", "Search local email using EmailQuery filters and FTS5; compact results, paginated by cursor. full=true includes full bodies.", s.emailQuery, false, async ({ full, ...query }) => {
    const page = await store.emails.query({ ...query, includeBodies: full || query.includeBodies });
    return json({ ...page, items: page.items.map(email => emailView(email, full)) });
  });
  register(server, "get_email", "Read one email. Bodies are clipped to 1200 characters unless full=true.", { emailId: s.id, full: s.full }, false,
    async ({ emailId, full }) => json(emailView(await ctx.email(emailId, true), full)));
  register(server, "get_thread", "Read a thread as chronological emails; continue with nextCursor. Bodies are clipped unless full=true.",
    { threadId: s.id, full: s.full, limit: s.limit, cursor: z.string().nullable().optional() }, false, async ({ threadId, full, limit, cursor }) => {
      const thread = required(await store.threads.get(threadId), "Thread");
      const page = await store.emails.query({ threadId, accountId: thread.accountId, sort: "receivedAt_asc", includeBodies: true, limit, cursor });
      return json({ id: thread.id, accountId: thread.accountId, ...page, items: page.items.map(email => emailView(email, full)) });
    });
  register(server, "list_mailboxes", "List mailboxes and counts for one account, or all accounts when accountId is omitted.", { accountId: s.id.optional() }, false, async ({ accountId }) => {
    const accounts = accountId ? [await ctx.account(accountId)] : await store.accounts.list();
    return json({ items: (await Promise.all(accounts.map(account => store.mailboxes.list(account.id)))).flat() });
  });
  register(server, "list_matters", "List living workspaces, optionally filtering status, participant or text.", {
    status: z.array(s.matterStatus).optional(), personId: s.id.optional(), text: z.string().max(2000).optional(), limit: s.limit,
  }, false, async query => json({ items: await store.matters.list(query) }));
  register(server, "get_matter", "Read a matter with its attached and linked emails, calendar events and people. Email cursor is an ID from this matter; linkedEmailsNextCursor continues search_emails(matterId).",
    { matterId: s.id, full: s.full, limit: s.limit, cursor: s.id.nullable().optional() }, false, async ({ matterId, full, limit, cursor }) => {
      const bundle = await ctx.matterBundle(matterId, limit, cursor, true);
      return json({ ...bundle, emails: bundle.emails.map(email => emailView(email, full)), events: bundle.events.map(event => eventView(event, full)) });
    });
  register(server, "list_people", "Find people by relationship or text, including their verification and contact history.", {
    relationship: s.relationship.optional(), text: z.string().max(2000).optional(), limit: s.limit,
  }, false, async query => json({ items: await store.people.list(query) }));
  register(server, "get_person", "Read a person's identity, relationships, verification and notes.", { personId: s.id }, false,
    async ({ personId }) => json(required(await store.people.get(personId), "Person")));
  register(server, "list_events", "List local calendar events overlapping a UTC time range, optionally scoped to an account or matter.", {
    accountId: s.id.optional(), range: s.range, matterId: s.id.optional(), limit: s.limit, full: s.full,
  }, false, async ({ full, ...query }) => json({ items: (await store.events.query(query)).map(event => eventView(event, full)) }));
  register(server, "free_busy", "Compute merged busy intervals from synced local events in a UTC range. Excludes cancelled/declined events; not a live provider availability check.", {
    accountId: s.id.optional(), range: s.range,
  }, false, async ({ accountId, range }) => {
    const events = await store.events.query({ accountId, range });
    const intervals = events.filter(event => event.status !== "cancelled" && event.myStatus !== "declined"
      && Date.parse(event.start) < Date.parse(range.end) && Date.parse(event.end) > Date.parse(range.start))
      .map(event => ({ start: new Date(Math.max(Date.parse(event.start), Date.parse(range.start))).toISOString(),
        end: new Date(Math.min(Date.parse(event.end), Date.parse(range.end))).toISOString() }))
      .sort((a, b) => a.start.localeCompare(b.start));
    const busy: Array<{ start: string; end: string }> = [];
    for (const interval of intervals) {
      const last = busy.at(-1);
      if (last && interval.start <= last.end) { if (interval.end > last.end) last.end = interval.end; }
      else busy.push({ ...interval });
    }
    return json({ range, busy, source: "local_store" });
  });
  register(server, "list_pending_decisions", "List actions awaiting human approval (proposed) or outbox release (held); no approval capability is exposed.", {
    limit: s.limit, cursor: z.string().nullable().optional(),
  }, false, async query => {
    const page = await store.actions.query({ ...query, status: ["proposed", "held"] });
    return json({ ...page, items: page.items.map(actionView) });
  });
  register(server, "list_actions", "Read the action audit log with policy decisions. Action parameters, provider results and raw errors are omitted.", s.actionQuery, false, async query => {
    const page = await store.actions.query(query);
    return json({ ...page, items: page.items.map(actionView) });
  });
  register(server, "get_trust", "Read the per-category trust ladder and global configuration, including the external-agent ceiling.", {}, false, async () => {
    const [ladder, config] = await Promise.all([ctx.deps.policy.getTrust(), ctx.deps.policy.getConfig()]);
    return json({ ladder, config });
  });
  register(server, "get_user_profile", "Read USER.md standing instructions from the user_profile store key.", {}, false,
    async () => json({ markdown: await store.kv.get("user_profile") ?? "" }));
}
