import type { Email, MailRow } from "@passport/types";
import { MAIL_ROW_SNIPPET_MAX, toMailRow } from "@passport/types";
import { decodeCursor, encodeCursor, localId, ProviderError } from "./errors.js";
import type { JmapEmail } from "./jmap.js";
import {
  andFilters,
  findMailbox,
  JMAP_ROW_PROPERTIES,
  type JmapFilter,
  type JmapMailboxInfo,
  renderJmapFilter,
} from "./jmap-reader-filter.js";
import { parsePortableQuery, queryScopesSpamTrash } from "./query.js";

/** Account and row normalization for `queryRows`. */
export interface RowContext {
  accountId: string;
  normalizeRow(raw: JmapEmail & Record<string, unknown>): Promise<Email>;
}

/** One JMAP method call or response: `[name, arguments]`. */
export type JmapInvocation = [string, Record<string, unknown>];

export type Send = (calls: JmapInvocation[]) => Promise<JmapInvocation[]>;

const MAX_LIMIT = 100;
export const SORT = [{ property: "receivedAt", isAscending: false }];

interface PageToken {
  account: string;
  kind: "search" | "list";
  key: string;
  position: number;
  /** Last id of the previous page; the next page starts right after it. */
  anchor?: string;
}

export interface QueryRequest {
  kind: "search" | "list";
  key: string;
  conditions: JmapFilter[];
  container?: string | null | undefined;
  /** Hide Spam and Trash (no container, no explicit `in:spam` / `in:trash`). */
  hideSpamTrash: boolean;
  threads: boolean;
  snippets: boolean;
  limit: number;
  pageToken?: string | undefined;
  translation: string;
}

export const ref = (resultOf: number, name: string, path: string) => ({
  resultOf: String(resultOf),
  name,
  path,
});

/** The arguments of a successful response; maps JMAP method errors to stable codes. */
export function ok(response: JmapInvocation | undefined, method: string): Record<string, unknown> {
  if (!response) {
    throw new ProviderError("INVALID_RESPONSE", `JMAP ${method} returned nothing`);
  }
  const [name, args] = response;
  if (name === "error") {
    const type = String(args.type ?? "");
    const code =
      type === "cannotCalculateChanges"
        ? "CURSOR_EXPIRED"
        : type === "anchorNotFound"
          ? "ANCHOR_NOT_FOUND"
          : type === "unsupportedFilter" || type === "invalidArguments"
            ? "INVALID_QUERY"
            : "JMAP_METHOD_ERROR";
    throw new ProviderError(code, `JMAP ${method} failed (${type || "error"})`);
  }
  if (name !== method) {
    throw new ProviderError("INVALID_RESPONSE", "JMAP returned an unexpected method");
  }
  return args;
}

export const list = <T>(args: Record<string, unknown>, key = "list") =>
  (Array.isArray(args[key]) ? args[key] : []) as T[];

function plainSnippet(html: unknown): string | null {
  if (typeof html !== "string") {
    return null;
  }
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Conditions for a portable query, or a provider-native `FilterCondition` JSON (`rawQuery`). */
export function jmapQueryFilter(
  query: string | undefined,
  rawQuery: string | undefined,
  boxes: JmapMailboxInfo[],
  now: Date,
) {
  if (rawQuery !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawQuery);
    } catch {
      // Not JSON: report a stable, actionable error.
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ProviderError(
        "INVALID_QUERY",
        "JMAP rawQuery must be a FilterCondition JSON object",
      );
    }
    return {
      conditions: [parsed as JmapFilter],
      scopesSpamTrash: false,
      hasText: "text" in parsed || "body" in parsed,
      translation: "jmap:Email/query(raw)",
    };
  }
  const ast = parsePortableQuery(query ?? "");
  const { conditions, notes } = renderJmapFilter(ast, { now: now, boxes });
  const hasText = /"(text|body|subject)":/.test(JSON.stringify(conditions));
  return {
    conditions,
    scopesSpamTrash: queryScopesSpamTrash(ast),
    hasText,
    translation: `jmap:Email/query${notes.length ? `; approx: ${notes.join(",")}` : ""}`,
  };
}

/** `filter` argument: the query, the container, and Spam/Trash exclusion. */
export function jmapFilterArg(
  conditions: JmapFilter[],
  boxes: JmapMailboxInfo[],
  container: string | null | undefined,
  hideSpamTrash: boolean,
): { filter?: JmapFilter } {
  const scope: JmapFilter[] = [];
  if (container) {
    const box = findMailbox(boxes, container);
    if (!box) {
      throw new ProviderError("NOT_FOUND", "Label or folder does not exist");
    }
    scope.push({ inMailbox: box.id });
  } else if (hideSpamTrash) {
    const hidden = boxes.filter((m) => m.role === "junk" || m.role === "trash").map((m) => m.id);
    if (hidden.length > 0) {
      scope.push({ inMailboxOtherThan: hidden });
    }
  }
  const filter = andFilters([...conditions, ...scope]);
  return filter ? { filter } : {};
}

/** `Email/query` + `Email/get` (+ `SearchSnippet/get`) in one request, paged by anchor. */
export async function queryRows(
  send: Send,
  ctx: RowContext,
  boxes: JmapMailboxInfo[],
  req: QueryRequest,
) {
  const account = ctx.accountId;
  let token: PageToken | null = null;
  if (req.pageToken) {
    token = decodeCursor<PageToken>(req.pageToken);
    if (
      token.account !== account ||
      token.kind !== req.kind ||
      token.key !== req.key ||
      !Number.isInteger(token.position)
    ) {
      throw new ProviderError("INVALID_CURSOR", "Page token belongs to a different query");
    }
  }
  const size = Math.min(MAX_LIMIT, Math.max(1, Math.floor(req.limit)));
  const filterArg = jmapFilterArg(req.conditions, boxes, req.container, req.hideSpamTrash);
  const ids = ref(0, "Email/query", "/ids");
  const calls = (anchored: boolean): JmapInvocation[] => [
    [
      "Email/query",
      {
        ...filterArg,
        sort: SORT,
        collapseThreads: req.threads,
        limit: size,
        calculateTotal: true,
        ...(anchored && token?.anchor
          ? { anchor: token.anchor, anchorOffset: 1 }
          : { position: token?.position ?? 0 }),
      },
    ],
    ["Email/get", { "#ids": ids, properties: JMAP_ROW_PROPERTIES }],
    ...(req.snippets
      ? [["SearchSnippet/get", { ...filterArg, "#emailIds": ids }] as JmapInvocation]
      : []),
  ];
  let responses = await send(calls(true));
  if (responses[0]?.[0] === "error" && responses[0][1].type === "anchorNotFound") {
    // The anchor message is gone: fall back to the position it had.
    responses = await send(calls(false));
  }
  const result = ok(responses[0], "Email/query");
  const found = list<string>(result, "ids");
  const raws = new Map(
    list<JmapEmail & Record<string, unknown>>(ok(responses[1], "Email/get")).map((e) => [e.id, e]),
  );
  const snippets = new Map<string, string>();
  if (req.snippets) {
    for (const s of list<{ emailId: string; preview?: string }>(
      ok(responses[2], "SearchSnippet/get"),
    )) {
      const text = plainSnippet(s.preview);
      if (text) {
        snippets.set(s.emailId, text);
      }
    }
  }
  const names = new Map(boxes.map((m) => [localId(account, "mailbox", m.id), m.name]));
  const items: MailRow[] = [];
  for (const id of found) {
    const raw = raws.get(id);
    if (!raw) {
      continue;
    }
    const row = toMailRow(await ctx.normalizeRow(raw), (h) => names.get(h) ?? null);
    const snippet = snippets.get(id);
    if (snippet) {
      row.snippet = snippet.slice(0, MAIL_ROW_SNIPPET_MAX);
    }
    items.push(row);
  }
  const position = Number(result.position ?? token?.position ?? 0);
  const total = Number(result.total ?? found.length);
  const next = position + found.length;
  const last = found[found.length - 1];
  return {
    items,
    approxTotal: total,
    ...(found.length > 0 && next < total && last
      ? {
          nextPageToken: encodeCursor({
            account,
            kind: req.kind,
            key: req.key,
            position: next,
            anchor: last,
          } satisfies PageToken),
        }
      : {}),
    translation: `${req.translation}${req.threads ? "+collapseThreads" : ""}`,
  };
}
