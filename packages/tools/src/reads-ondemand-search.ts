import type { MailRow, MailSearchInput, ReadMeta, ReadResult } from "@passport/types";
import { MAIL_READ_ERROR_CODES } from "@passport/types";
import type { Context } from "./context.js";
import {
  mergeMeta,
  onDemand,
  type PartialRows,
  type ReaderTarget,
  readerTargets,
  safeRow,
  UNTRUSTED_NOTICE,
} from "./ondemand-support.js";
import { ToolError } from "./presentation.js";
import type { ToolResult } from "./types.js";

/** `mail_search` input after validation. */
export interface SearchInput {
  account?: string;
  query?: string;
  rawQuery?: string;
  container?: string;
  limit: number;
  pageToken?: string;
  includeSpamTrash?: boolean;
  threads?: boolean;
}

interface FanoutState {
  /** Provider page token of the page being consumed (absent = first page). */
  t?: string;
  /** Rows of that page already returned. */
  s: number;
}
interface FanoutToken {
  v: 1;
  key: string;
  accounts: Record<string, FanoutState>;
}

const encodeToken = (token: FanoutToken) =>
  Buffer.from(JSON.stringify(token), "utf8").toString("base64url");

function decodeToken(value: string, key: string): FanoutToken {
  try {
    const token = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as FanoutToken;
    if (
      token.v === 1 &&
      token.key === key &&
      token.accounts &&
      typeof token.accounts === "object"
    ) {
      return token;
    }
  } catch {
    // Fall through to the stable cursor error below.
  }
  throw new ToolError(
    "INVALID_CURSOR",
    "The page token or cursor does not belong to this query or account.",
  );
}

const newestFirst = (a: MailRow, b: MailRow) =>
  b.date.localeCompare(a.date) || b.id.localeCompare(a.id);

/** Searches one account, or fans out across accounts and merges rows newest first. */
export function searchMail(
  ctx: Context,
  input: SearchInput,
  extra: Record<string, unknown> = {},
): Promise<ToolResult> {
  return onDemand(async (partial) => {
    if (input.query !== undefined && input.rawQuery !== undefined) {
      throw new ToolError("INVALID_INPUT", "Supply query or rawQuery, not both.");
    }
    const base: SearchBase = {
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.rawQuery !== undefined ? { rawQuery: input.rawQuery } : {}),
      ...(input.container ? { container: input.container } : {}),
      ...(input.includeSpamTrash ? { includeSpamTrash: true } : {}),
      ...(input.threads ? { threads: true } : {}),
    };
    const { targets, skipped } = await readerTargets(ctx, input.account);
    const fanout = targets.length > 1 || skipped.length > 0;
    if (!fanout) {
      const target = targets[0] as ReaderTarget;
      const page = await target.reader.search({
        ...base,
        limit: input.limit,
        ...(input.pageToken ? { pageToken: input.pageToken } : {}),
      });
      return {
        account: target.account.id,
        items: page.items.map(safeRow),
        ...pageMeta(page),
        ...mergeMeta([page]),
        ...extra,
        untrusted: UNTRUSTED_NOTICE,
      };
    }
    return {
      ...(await fanoutSearch(targets, base, input, partial)),
      ...(skipped.length ? { skippedAccounts: skipped } : {}),
      ...extra,
      untrusted: UNTRUSTED_NOTICE,
    };
  }, extra);
}

type SearchBase = Omit<MailSearchInput, "limit" | "pageToken">;

/** One page per account in parallel, merged newest first; rate limits keep the merged rows. */
async function fanoutSearch(
  targets: ReaderTarget[],
  base: SearchBase,
  input: SearchInput,
  partial: PartialRows,
): Promise<ToolResult> {
  const key = JSON.stringify(base);
  const state: Record<string, FanoutState> = input.pageToken
    ? decodeToken(input.pageToken, key).accounts
    : Object.fromEntries(targets.map((target) => [target.account.id, { s: 0 }]));
  const active = targets.filter((target) => state[target.account.id]);
  const settled = await Promise.allSettled(
    active.map((target) => {
      const at = state[target.account.id] as FanoutState;
      return target.reader.search({
        ...base,
        limit: input.limit,
        ...(at.t ? { pageToken: at.t } : {}),
      });
    }),
  );
  const pages = new Map<string, ReadResult<MailRow>>();
  const failures: unknown[] = [];
  settled.forEach((result, index) => {
    const id = (active[index] as ReaderTarget).account.id;
    if (result.status === "fulfilled") {
      pages.set(id, result.value);
    } else {
      failures.push(result.reason);
    }
  });
  const merged = mergePages(pages, state, input.limit);
  if (failures.length) {
    partial.items = merged.items.map(safeRow);
    partial.source = "mixed";
    throw worstFailure(failures);
  }
  const totals = [...pages.values()].map((page) => page.approxTotal);
  return {
    account: "all",
    items: merged.items.map(safeRow),
    nextPageToken: Object.keys(merged.next).length
      ? encodeToken({ v: 1, key, accounts: merged.next })
      : null,
    ...(totals.every((total) => total !== undefined)
      ? { approxTotal: totals.reduce<number>((sum, total) => sum + (total ?? 0), 0) }
      : {}),
    ...([...pages.values()].some(isCapped) ? { capped: true } : {}),
    ...mergeMeta([...pages.values()] as ReadMeta[]),
  };
}

/** A non-rate-limit failure wins; otherwise the rate limit with the longest wait. */
function worstFailure(failures: unknown[]): unknown {
  const retry = (error: unknown) =>
    (error as { retryAfterSeconds?: number }).retryAfterSeconds ?? 0;
  return (
    failures.find(
      (error) => (error as { code?: unknown })?.code !== MAIL_READ_ERROR_CODES.RATE_LIMITED,
    ) ?? failures.reduce((longest, error) => (retry(error) > retry(longest) ? error : longest))
  );
}

/** Paging fields of one provider page; `capped` marks a provider result ceiling (Graph `$search`). */
export function pageMeta(page: ReadResult<unknown>) {
  return {
    nextPageToken: page.nextPageToken ?? null,
    ...(page.approxTotal !== undefined ? { approxTotal: page.approxTotal } : {}),
    ...(isCapped(page) ? { capped: true } : {}),
  };
}

const isCapped = (page: ReadResult<unknown>) => (page as { capped?: unknown }).capped === true;

/**
 * k-way merge of one page per account. Stops early when an account with more pages runs out of
 * buffered rows, so later rows can never be out of order. Returns the next per-account state.
 */
function mergePages(
  pages: Map<string, ReadResult<MailRow>>,
  state: Record<string, FanoutState>,
  limit: number,
): { items: MailRow[]; next: Record<string, FanoutState> } {
  const buffers = new Map(
    [...pages].map(([id, page]) => [
      id,
      { rows: page.items.slice(state[id]?.s ?? 0), taken: 0, more: Boolean(page.nextPageToken) },
    ]),
  );
  const items: MailRow[] = [];
  while (items.length < limit) {
    const open = [...buffers.values()];
    if (open.some((buffer) => buffer.taken === buffer.rows.length && buffer.more)) {
      break;
    }
    let best: { rows: MailRow[]; taken: number } | undefined;
    for (const buffer of open) {
      const head = buffer.rows[buffer.taken];
      const current = best?.rows[best.taken];
      if (head && (!current || newestFirst(head, current) < 0)) {
        best = buffer;
      }
    }
    if (!best) {
      break;
    }
    items.push(best.rows[best.taken++] as MailRow);
  }
  const next: Record<string, FanoutState> = {};
  for (const [id, buffer] of buffers) {
    const page = pages.get(id) as ReadResult<MailRow>;
    const at = state[id] as FanoutState;
    if (buffer.taken < buffer.rows.length) {
      next[id] = { ...(at.t ? { t: at.t } : {}), s: (at.s ?? 0) + buffer.taken };
    } else if (page.nextPageToken) {
      next[id] = { t: page.nextPageToken, s: 0 };
    }
  }
  return { items, next };
}
