import type { MailChanges, MailListFilter, MailRow } from "@passport/types";
import { mailHandle, toMailRow } from "@passport/types";
import type { Context } from "./context.js";
import {
  mailboxLabel,
  mergeMeta,
  neutralize,
  onDemand,
  readerTarget,
  readerTargets,
  safeRow,
  UNTRUSTED_NOTICE,
  wouldExceed,
} from "./ondemand-support.js";
import { json, required, ToolError } from "./presentation.js";
import { searchMail } from "./reads-ondemand-search.js";
import { register } from "./register.js";
import { schema as z } from "./schema.js";
import * as s from "./schemas.js";
import * as o from "./schemas-ondemand.js";

/** Provider reads touch the outside world; MCP clients see `openWorldHint`. */
export const PROVIDER_READ = { openWorldHint: true } as const;

/** Gmail units for one metadata row; used to estimate cold samples. */
const ROW_UNITS = 20;
/** Facet samples above this many cold rows need `confirmCost` (≈4,000 Gmail units). */
export const COLD_SAMPLE_GUARD = 200;
const FACETS = ["from", "fromDomain", "label", "month"] as const;

/** `mail_labels` for one account or all; shared with the `list_mailboxes` alias. */
export function mailLabels(
  ctx: Context,
  account: string | undefined,
  counts: boolean,
  extra: Record<string, unknown> = {},
) {
  return onDemand(async () => {
    const { targets, skipped } = await readerTargets(ctx, account);
    const results = await Promise.all(
      targets.map(async ({ account, reader }) => ({
        account,
        result: await reader.labels(counts),
      })),
    );
    return {
      items: results.flatMap(({ account, result }) =>
        result.items.map((label) => ({
          ...label,
          account: account.id,
          name: neutralize(label.name),
        })),
      ),
      ...mergeMeta(results.map(({ result }) => result)),
      ...(skipped.length ? { skippedAccounts: skipped } : {}),
      ...extra,
      untrusted: UNTRUSTED_NOTICE,
    };
  }, extra);
}

/** Portable query for a correspondent: `with:`/`from:`/`to:` over one or more addresses. */
export function peopleQuery(addresses: string[], direction: "both" | "from" | "to"): string {
  const operator = direction === "both" ? "with" : direction;
  const terms = [...new Set(addresses.map((address) => address.trim().toLowerCase()))]
    .filter(Boolean)
    .map((address) => `${operator}:"${address.replace(/"/g, "")}"`);
  if (!terms.length) {
    throw new ToolError("INVALID_INPUT", "Provide an email address.");
  }
  return terms.length === 1 ? (terms[0] as string) : `(${terms.join(" OR ")})`;
}

function facet(rows: MailRow[], pick: (row: MailRow) => string[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const value of new Set(pick(row))) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([value, count]) => ({ value: neutralize(value), count }));
}

const address = (row: MailRow) => (/<([^<>]+)>$/.exec(row.from)?.[1] ?? row.from).toLowerCase();
const pickers: Record<(typeof FACETS)[number], (row: MailRow) => string[]> = {
  from: (row) => [address(row)],
  fromDomain: (row) => [address(row).split("@")[1] ?? ""],
  label: (row) => row.labels,
  month: (row) => [row.date.slice(0, 7)],
};

interface CountInput {
  account?: string;
  query?: string;
  rawQuery?: string;
  cap: number;
  facets?: Array<(typeof FACETS)[number]>;
  sample: number;
  confirmCost: boolean;
}

/** `mail_count`: exact count via `countIds`, then facets over a guarded sample. */
function countMail(ctx: Context, input: CountInput) {
  const { account, query, rawQuery, cap, facets, sample, confirmCost } = input;
  return onDemand(async () => {
    if (query !== undefined && rawQuery !== undefined) {
      throw new ToolError("INVALID_INPUT", "Supply query or rawQuery, not both.");
    }
    const target = await readerTarget(ctx, account);
    const counted = await target.reader.countIds(rawQuery ?? query ?? "", cap, {
      ...(rawQuery !== undefined ? { raw: true } : {}),
    });
    const result = {
      account: target.account.id,
      count: counted.value.count,
      capped: counted.value.capped,
      cap,
    };
    if (!facets?.length || counted.value.count === 0) {
      return { ...result, ...mergeMeta([counted]) };
    }
    const rows = Math.min(sample, counted.value.count);
    const estimate = Math.ceil(rows / 100) * 5 + rows * ROW_UNITS;
    const remaining = counted.cost.budgetRemaining;
    if (
      !confirmCost &&
      (rows > COLD_SAMPLE_GUARD || (remaining !== undefined && estimate > remaining))
    ) {
      return {
        ...wouldExceed(
          estimate,
          `Facets over ${rows} rows cost about ${estimate} Gmail units. Lower sample, narrow the query, or pass confirmCost:true.`,
        ),
        ...result,
      };
    }
    const pages = [];
    const items: MailRow[] = [];
    let pageToken: string | undefined;
    do {
      const page = await target.reader.search({
        ...(rawQuery !== undefined ? { rawQuery } : { query: query ?? "" }),
        limit: Math.min(100, rows - items.length),
        ...(pageToken ? { pageToken } : {}),
      });
      pages.push(page);
      items.push(...page.items);
      pageToken = page.nextPageToken;
    } while (pageToken && items.length < rows);
    return {
      ...result,
      sampled: items.length,
      facets: Object.fromEntries(facets.map((name) => [name, facet(items, pickers[name])])),
      ...mergeMeta([counted, ...pages]),
      untrusted: UNTRUSTED_NOTICE,
    };
  });
}

export function registerOnDemandReads(ctx: Context) {
  const { store } = ctx;
  register(
    ctx,
    "mail_accounts",
    "List connected accounts with capabilities and whether on-demand reads are available. Local; free.",
    {},
    false,
    async (_input, call) => {
      const accounts = await store.accounts.list();
      return json({
        items: await Promise.all(
          accounts.map(async (account) => ({
            id: account.id,
            kind: account.kind,
            displayName: account.displayName,
            emailAddress: account.emailAddress,
            capabilities: account.capabilities,
            onDemand: (await call.maybeReader(account.id)) !== null,
          })),
        ),
      });
    },
  );
  register(
    ctx,
    "mail_labels",
    "ls /: label and folder tree with roles; counts=true adds total/unread (Gmail: +1 unit per label).",
    { account: o.accountOrAll.optional(), counts: z.boolean().default(false) },
    false,
    async ({ account, counts }, call) => mailLabels(call, account, counts),
    PROVIDER_READ,
  );
  register(
    ctx,
    "mail_list",
    "ls <label>: newest-first rows from one label/folder (default all mail except Spam/Trash) with structural filters only. Cheap; never touches bodies.",
    {
      account: o.account.optional(),
      container: o.container.optional(),
      filter: o.listFilter.optional(),
      limit: s.limit,
      pageToken: o.pageToken.optional(),
    },
    false,
    async ({ account, container, filter, limit, pageToken }, call) =>
      onDemand(async () => {
        const target = await readerTarget(call, account);
        const page = await target.reader.list(
          container ?? null,
          (filter ?? {}) as MailListFilter,
          limit,
          pageToken,
        );
        return {
          account: target.account.id,
          items: page.items.map(safeRow),
          ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
          ...(page.approxTotal !== undefined ? { approxTotal: page.approxTotal } : {}),
          ...mergeMeta([page]),
          untrusted: UNTRUSTED_NOTICE,
        };
      }),
    PROVIDER_READ,
  );
  register(
    ctx,
    "mail_search",
    'grep: server-side search with a portable query or provider-native rawQuery, newest first. account:"all" searches every account in parallel and merges by date. Rows are compact; read bodies with mail_read. approxTotal is an estimate; use mail_count for exact numbers.',
    {
      account: o.accountOrAll.optional(),
      query: o.query.optional(),
      rawQuery: o.rawQuery.optional(),
      container: o.container.optional(),
      limit: s.limit,
      pageToken: o.pageToken.optional(),
      includeSpamTrash: z.boolean().default(false),
      threads: z.boolean().default(false).describe("One row per thread (newest matching message)."),
    },
    false,
    async (input, call) => searchMail(call, input),
    PROVIDER_READ,
  );
  register(
    ctx,
    "mail_count",
    "wc / uniq -c: exact match count up to cap, plus optional top-10 facets over a sample of rows. Counting is cheap; facets fetch row metadata (~20 Gmail units per row).",
    {
      account: o.account.optional(),
      query: o.query.optional(),
      rawQuery: o.rawQuery.optional(),
      cap: z.number().int().min(1).max(10_000).default(2000),
      facets: z.array(z.enum(FACETS)).max(4).optional(),
      sample: z.number().int().min(1).max(500).default(200),
      confirmCost: o.confirmCost,
    },
    false,
    async (input, call) => countMail(call, input),
    PROVIDER_READ,
  );
  register(
    ctx,
    "mail_changes",
    "git status: what arrived, changed labels or was deleted since a cursor. Without a cursor it returns no changes and a cursor at now (never a backfill). Keep the returned cursor for the next call.",
    {
      account: o.account.optional(),
      cursor: z.string().max(8000).optional(),
      limit: z.number().int().min(1).max(200).default(50),
      kinds: z
        .array(z.enum(["added", "labelChanged", "deleted"]))
        .min(1)
        .max(3)
        .optional(),
    },
    false,
    async ({ account, cursor, limit, kinds }, call) =>
      onDemand(async () => {
        const target = await readerTarget(call, account);
        const changes = await target.reader.changes(cursor ?? null, limit);
        const wanted = new Set(kinds ?? ["added", "labelChanged", "deleted"]);
        const value: MailChanges = changes.value;
        const lookup = [
          ...(wanted.has("added") ? value.added : []),
          ...(wanted.has("labelChanged") ? value.labelChanged : []),
        ];
        const envelopes = lookup.length ? await target.reader.envelopes(lookup) : null;
        const rows = (ids: string[], kind: "added" | "labelChanged") =>
          wanted.has(kind)
            ? ids.flatMap((id) => {
                const envelope = envelopes?.value.get(id);
                return envelope ? [{ kind, ...safeRow(toMailRow(envelope, mailboxLabel)) }] : [];
              })
            : [];
        return {
          account: target.account.id,
          changes: [
            ...rows(value.added, "added"),
            ...rows(value.labelChanged, "labelChanged"),
            ...(wanted.has("deleted")
              ? value.deleted.map((id) => ({
                  kind: "deleted" as const,
                  id: mailHandle(target.account.id, "email", id),
                }))
              : []),
          ],
          cursor: value.cursor,
          ...(value.hasMore ? { hasMore: true } : {}),
          ...(value.expired ? { expired: true } : {}),
          ...mergeMeta(envelopes ? [changes, envelopes] : [changes]),
          untrusted: UNTRUSTED_NOTICE,
        };
      }),
    PROVIDER_READ,
  );
  register(
    ctx,
    "people_history",
    "What have we exchanged with someone: mail with (both), from or to an address or a known person's addresses, newest first. Same rows, paging and costs as mail_search.",
    {
      email: z.email().optional(),
      personId: s.id.optional(),
      account: o.accountOrAll.optional(),
      direction: z.enum(["both", "from", "to"]).default("both"),
      limit: s.limit,
      pageToken: o.pageToken.optional(),
    },
    false,
    async ({ email, personId, account, direction, limit, pageToken }, call) => {
      if (Boolean(email) === Boolean(personId)) {
        throw new ToolError("INVALID_INPUT", "Provide exactly one of email or personId.");
      }
      const addresses: string[] = email ? [email] : [];
      if (personId) {
        const person = required(await store.people.get(personId), "Person");
        addresses.push(person.primaryEmail, ...person.emails);
      }
      const query = peopleQuery(addresses, direction);
      return searchMail(call, {
        query,
        limit,
        ...(account ? { account } : {}),
        ...(pageToken ? { pageToken } : {}),
      });
    },
    PROVIDER_READ,
  );
}
