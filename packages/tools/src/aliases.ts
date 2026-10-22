/**
 * Legacy mail reads as thin aliases over the on-demand tools (research 03 §4.1). Each helper
 * returns null when no reader serves the request, and the caller keeps its store path (demo,
 * tests, accounts without `MailProvider.reader()`).
 */
import type { Email, EmailQuery, MailRow } from "@passport/types";
import type { Context } from "./context.js";
import {
  emailQueryToPortable,
  neutralize,
  onDemand,
  resolveContainer,
  resolveMailTarget,
  UNTRUSTED_NOTICE,
} from "./ondemand-support.js";
import { required } from "./presentation.js";
import { mailLabels, peopleQuery } from "./reads-ondemand.js";
import { loadMail, MAX_READ_LENGTH, readMail, safeEmailView } from "./reads-ondemand-read.js";
import { searchMail } from "./reads-ondemand-search.js";
import type { ToolResult } from "./types.js";

export const deprecated = (replacement: string) => ({
  deprecated: `Deprecated alias; use ${replacement}.`,
});

/** True when a reader serves `accountId`, or any account when it is omitted. */
async function served(ctx: Context, accountId?: string): Promise<boolean> {
  if (!ctx.readers) {
    return false;
  }
  if (accountId) {
    return (await ctx.maybeReader(accountId)) !== null;
  }
  const accounts = await ctx.store.accounts.list();
  for (const account of accounts) {
    if (await ctx.maybeReader(account.id)) {
      return true;
    }
  }
  return false;
}

/** The account of a mail handle or legacy id, when a reader serves it. */
async function servedTarget(ctx: Context, id: string): Promise<boolean> {
  if (!ctx.readers) {
    return false;
  }
  const target = await resolveMailTarget(ctx, id).catch(() => null);
  return target !== null && (await served(ctx, target.accountId));
}

/** `search_emails` → `mail_search` when the EmailQuery translates to a portable query. */
export async function searchAlias(
  ctx: Context,
  query: Partial<EmailQuery>,
): Promise<ToolResult | null> {
  const portable = emailQueryToPortable(query);
  if (!portable || !(await served(ctx, query.accountId))) {
    return null;
  }
  return searchMail(
    ctx,
    {
      ...(query.accountId ? { account: query.accountId } : {}),
      query: portable.query,
      ...(portable.container ? { container: await resolveContainer(ctx, portable.container) } : {}),
      limit: query.limit ?? 25,
      ...(query.cursor ? { pageToken: query.cursor } : {}),
    },
    deprecated("mail_search"),
  );
}

/** `get_email` / `get_email_body` / `get_thread` → `mail_read`. */
export async function readAlias(
  ctx: Context,
  id: string,
  view: "thread" | "message",
  options: { full: boolean; offset?: number; length?: number },
  replacement: string,
): Promise<ToolResult | null> {
  if (!(await servedTarget(ctx, id))) {
    return null;
  }
  const result = await readMail(ctx, {
    id,
    view,
    format: "text",
    quoted: options.full ? "full" : "collapse",
    offset: options.offset ?? 0,
    length: Math.min(options.length ?? (options.full ? MAX_READ_LENGTH : 2000), MAX_READ_LENGTH),
  });
  return { ...result, ...deprecated(replacement) };
}

/** `list_mailboxes` → `mail_labels` with counts. */
export async function labelsAlias(ctx: Context, accountId?: string): Promise<ToolResult | null> {
  if (!(await served(ctx, accountId))) {
    return null;
  }
  return mailLabels(ctx, accountId ?? "all", true, deprecated("mail_labels"));
}

/** `list_recent_from_person` → `people_history({direction:"from"})`. */
export async function recentFromAlias(
  ctx: Context,
  input: { personId: string; accountId?: string; limit: number; cursor?: string | null },
): Promise<ToolResult | null> {
  if (!(await served(ctx, input.accountId))) {
    return null;
  }
  const person = required(await ctx.store.people.get(input.personId), "Person");
  return searchMail(
    ctx,
    {
      ...(input.accountId ? { account: input.accountId } : {}),
      query: peopleQuery([person.primaryEmail, ...person.emails], "from"),
      limit: input.limit,
      ...(input.cursor ? { pageToken: input.cursor } : {}),
    },
    deprecated('people_history({direction:"from"})'),
  );
}

/** LLM-free thread summary over chronological emails; shared by the store and reader paths. */
export function summarizeEmails(
  threadId: string,
  emails: Email[],
  last: Email | undefined,
  view: (email: Email) => unknown,
  clean: (text: string) => string = (text) => text,
) {
  const participants = [
    ...new Map(
      emails
        .flatMap((email) => [...email.from, ...email.to, ...email.cc])
        .map((address) => [
          address.email.toLowerCase(),
          address.name ? { ...address, name: clean(address.name) } : address,
        ]),
    ).values(),
  ];
  const openQuestions = emails
    .slice(-10)
    .flatMap((email) =>
      (email.textBody ?? email.preview)
        .split(/\r?\n/)
        .filter((line) => !/^\s*>/.test(line))
        .flatMap((line) => line.match(/[^.!?]*\?/g) ?? [])
        .slice(0, 5)
        .map((text) => ({ emailId: email.id, question: clean(text.trim().slice(0, 240)) })),
    )
    .slice(-20);
  return {
    threadId,
    participants,
    timeline: emails.map((email) => ({
      emailId: email.id,
      at: email.sentAt ?? email.receivedAt,
      from: email.from.map((address) =>
        address.name ? { ...address, name: clean(address.name) } : address,
      ),
      preview: clean(email.preview.slice(0, 240)),
    })),
    openQuestions,
    questionsAreHeuristic: true,
    lastMessage: last ? view(last) : null,
  };
}

/** `summarize_thread` over the provider thread. */
export async function summarizeAlias(
  ctx: Context,
  input: { threadId: string; full: boolean; limit: number },
): Promise<ToolResult | null> {
  if (!(await servedTarget(ctx, input.threadId))) {
    return null;
  }
  return onDemand(async () => {
    const { emails } = await loadMail(ctx, input.threadId, "thread");
    const page = emails.slice(-input.limit);
    return {
      ...summarizeEmails(
        input.threadId,
        page,
        emails.at(-1),
        (email) => safeEmailView(email, input.full),
        neutralize,
      ),
      nextCursor: null,
      total: emails.length,
      untrusted: UNTRUSTED_NOTICE,
      ...deprecated('mail_read({view:"thread"})'),
    };
  }, deprecated('mail_read({view:"thread"})'));
}

/** Query writes resolve at most this many provider ids (one Gmail batchModify). */
export const QUERY_WRITE_READER_CAP = 1000;
const STORE_QUERY_WRITE_CAP = 200;

/**
 * Matches of a query write. With a reader, ids are resolved server-side by paging
 * `reader.search` (cap 1,000); otherwise the local store is queried (cap 200). A rate-limited
 * resolution is returned as `error` and nothing is submitted.
 */
export async function queryWriteMatches(
  ctx: Context,
  query: EmailQuery,
): Promise<
  | { error: ToolResult }
  | {
      items: Array<{ id: string; subject: string; preview: string }>;
      total?: number | undefined;
      capped: boolean;
      source?: "provider";
    }
> {
  if (ctx.readers) {
    let resolved: Awaited<ReturnType<typeof queryWriteRows>> = null;
    const result = await onDemand(
      async () => {
        const accountId = (await ctx.account(query.accountId)).id;
        resolved = await queryWriteRows(ctx, accountId, query, QUERY_WRITE_READER_CAP);
        return {};
      },
      { policy_note: "No action was submitted; ids could not be resolved." },
    );
    if (result.isError) {
      return { error: result };
    }
    const found = resolved as Awaited<ReturnType<typeof queryWriteRows>>;
    if (found) {
      return {
        items: found.rows.map((row) => ({
          id: row.id,
          subject: neutralize(row.subject),
          preview: neutralize(row.snippet),
        })),
        total: found.total,
        capped: found.capped,
        source: "provider",
      };
    }
  }
  const page = await ctx.store.emails.query({
    ...query,
    limit: STORE_QUERY_WRITE_CAP,
    includeBodies: false,
  });
  const items = page.items.slice(0, STORE_QUERY_WRITE_CAP);
  return {
    items,
    total: page.total,
    capped: Boolean(page.nextCursor) || (page.total ?? 0) > items.length,
  };
}

/** Server-side id resolution for query writes: pages `reader.search`, at most `cap` rows. */
async function queryWriteRows(
  ctx: Context,
  accountId: string,
  query: Partial<EmailQuery>,
  cap: number,
): Promise<{ rows: MailRow[]; total?: number; capped: boolean } | null> {
  const portable = emailQueryToPortable(query);
  const reader = portable ? await ctx.maybeReader(accountId) : null;
  if (!portable || !reader) {
    return null;
  }
  const container = portable.container
    ? await resolveContainer(ctx, portable.container)
    : undefined;
  const rows: MailRow[] = [];
  let pageToken: string | undefined;
  let total: number | undefined;
  do {
    const page = await reader.search({
      query: portable.query,
      ...(container ? { container } : {}),
      limit: Math.min(100, cap - rows.length),
      ...(pageToken ? { pageToken } : {}),
    });
    rows.push(...page.items);
    total ??= page.approxTotal;
    pageToken = page.nextPageToken;
  } while (pageToken && rows.length < cap);
  return { rows, ...(total !== undefined ? { total } : {}), capped: Boolean(pageToken) };
}
