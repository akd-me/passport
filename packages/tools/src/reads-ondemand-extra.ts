import type { Email, MailEnvelope, ReadMeta } from "@passport/types";
import { formatMailAddress, isProviderGetAllowed, PROVIDER_GET_ALLOWLIST } from "@passport/types";
import { runGrep } from "./attachments/run-worker.js";
import type { Context } from "./context.js";
import { linesOf } from "./grep-match.js";
import {
  mapLimit,
  mergeMeta,
  neutralize,
  neutralizeDeep,
  onDemand,
  type PartialRows,
  readerTarget,
  resolveMailTarget,
  UNTRUSTED_NOTICE,
  wouldExceed,
} from "./ondemand-support.js";
import { ToolError } from "./presentation.js";
import { htmlToText, stripQuoteMarkers } from "./quoted.js";
import { PROVIDER_READ } from "./reads-ondemand.js";
import { loadMail } from "./reads-ondemand-read.js";
import { searchMail } from "./reads-ondemand-search.js";
import { register } from "./register.js";
import { limitResponse } from "./response-budget.js";
import { compileSafeRegex, REGEX_MAX_LENGTH } from "./safe-regex.js";
import { Schema, schema as z } from "./schema.js";
import * as o from "./schemas-ondemand.js";
import type { ToolResult } from "./types.js";

/** Messages `mail_grep` fetches without `confirmCost` (≈1,800 Gmail units cold). */
export const GREP_COLD_GUARD = 30;
const BODY_UNITS = 60;
const LINE_MAX = 500;

interface GrepItem {
  meta: Pick<MailEnvelope, "id" | "threadId" | "receivedAt" | "from" | "subject">;
  text: string;
}

const clipLine = (line: string) =>
  neutralize(line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line);

const plain = (email: Pick<Email, "textBody" | "htmlBody">) =>
  stripQuoteMarkers(email.textBody ?? (email.htmlBody ? htmlToText(email.htmlBody) : ""));

/** Fetches bodies for message/thread handles in input order, four reads in flight per account. */
async function grepItems(ctx: Context, ids: string[], metas: ReadMeta[]): Promise<GrepItem[]> {
  const slots: GrepItem[][] = ids.map(() => []);
  const byAccount = new Map<string, Array<{ slot: number; providerId: string }>>();
  for (const [slot, id] of ids.entries()) {
    const target = await resolveMailTarget(ctx, id);
    if (!target.providerId) {
      const thread = await loadMail(ctx, id, "thread");
      metas.push(...thread.metas);
      slots[slot] = thread.emails.map((email) => ({ meta: email, text: plain(email) }));
      continue;
    }
    const pending = byAccount.get(target.accountId) ?? [];
    pending.push({ slot, providerId: target.providerId });
    byAccount.set(target.accountId, pending);
  }
  for (const [accountId, pending] of byAccount) {
    const reader = await ctx.reader(accountId);
    const envelopes = await reader.envelopes(pending.map((item) => item.providerId));
    metas.push(envelopes);
    await mapLimit(pending, 4, async ({ slot, providerId }) => {
      const envelope = envelopes.value.get(providerId);
      if (envelope) {
        const body = await reader.body(providerId);
        metas.push(body);
        slots[slot] = [{ meta: envelope, text: plain(body.value) }];
      }
    });
  }
  return slots.flat();
}

/** Matches in the worker (bounded wall clock), then builds rows with neutralised context. */
async function grep(
  items: GrepItem[],
  regex: RegExp,
  context: number,
  maxMatches: number,
  partial: PartialRows,
): Promise<boolean> {
  const { hits, truncated } = await runGrep({
    grep: {
      pattern: regex.source,
      flags: regex.flags,
      texts: items.map((item) => item.text),
      maxMatches,
    },
  });
  for (const [item, index] of hits) {
    const { meta, text } = items[item] as GrepItem;
    const lines = linesOf(text);
    partial.items.push({
      id: meta.id,
      threadId: meta.threadId,
      date: meta.receivedAt,
      from: neutralize(meta.from[0] ? formatMailAddress(meta.from[0]) : ""),
      subject: neutralize(meta.subject),
      line: index + 1,
      text: clipLine(lines[index] ?? ""),
      before: lines.slice(Math.max(0, index - context), index).map(clipLine),
      after: lines.slice(index + 1, index + 1 + context).map(clipLine),
    });
  }
  return truncated;
}

/**
 * A provider body over the response budget: lists lose trailing items (`omittedItems`); a body
 * that still does not fit becomes `bodyText`, its JSON clipped to the budget (`totalBytes`).
 */
function clipProviderBody(result: ToolResult & { body: unknown }, budget?: number): ToolResult {
  try {
    return limitResponse(result, budget);
  } catch {
    // Not reducible structurally (one huge value); fall back to clipped JSON text.
    const json = JSON.stringify(result.body) ?? "null";
    return limitResponse(
      { ...result, body: null, bodyText: json, totalBytes: Buffer.byteLength(json) },
      budget,
    );
  }
}

const queryParams = new Schema<Record<string, string>>(
  { type: "object", description: "Query parameters, string values only (at most 30)." },
  (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ToolError("INVALID_INPUT", "Expected an object of string query parameters.");
    }
    const entries = Object.entries(input as Record<string, unknown>);
    if (
      entries.length > 30 ||
      entries.some(
        ([key, value]) =>
          !/^[$A-Za-z0-9_.-]{1,64}$/.test(key) || typeof value !== "string" || value.length > 2000,
      )
    ) {
      throw new ToolError("INVALID_INPUT", "Query parameters must be ≤30 short string pairs.");
    }
    return Object.fromEntries(entries) as Record<string, string>;
  },
);

export function registerOnDemandExtra(ctx: Context) {
  register(
    ctx,
    "mail_grep",
    `grep -C: regex over the bodies of a bounded set you already narrowed (ids, or a query resolving at most maxMessages). Returns matching lines with context. Costs ~${BODY_UNITS} Gmail units per message; more than ${GREP_COLD_GUARD} messages need confirmCost.`,
    {
      ids: o.handles.optional(),
      query: o.query.optional(),
      rawQuery: o.rawQuery.optional(),
      account: o.accountOrAll.optional(),
      maxMessages: z.number().int().min(1).max(100).default(30),
      pattern: z
        .string()
        .min(1)
        .max(REGEX_MAX_LENGTH)
        .describe(
          "JavaScript regular expression, matched per line. No backreferences or nested quantifiers; matching stops after 2 s.",
        ),
      flags: z
        .string()
        .regex(/^[im]{0,2}$/, 'Use "", "i", "m" or "im".')
        .default("i"),
      context: z.number().int().min(0).max(5).default(1),
      maxMatches: z.number().int().min(1).max(200).default(50),
      confirmCost: o.confirmCost,
    },
    false,
    async (input, call) => {
      const regex = compileSafeRegex(input.pattern, input.flags);
      const byQuery = input.query !== undefined || input.rawQuery !== undefined;
      if (Boolean(input.ids) === byQuery) {
        throw new ToolError("INVALID_INPUT", "Provide ids, or query/rawQuery, not both.");
      }
      const planned = input.ids ? Math.min(input.ids.length, input.maxMessages) : input.maxMessages;
      if (planned > GREP_COLD_GUARD && !input.confirmCost) {
        return wouldExceed(
          planned * BODY_UNITS,
          `Grepping ${planned} messages costs about ${planned * BODY_UNITS} Gmail units. Narrow the set or pass confirmCost:true.`,
        );
      }
      const metas: ReadMeta[] = [];
      let ids = input.ids?.slice(0, input.maxMessages) ?? [];
      if (byQuery) {
        const found = await searchMail(call, {
          ...(input.account ? { account: input.account } : {}),
          ...(input.query !== undefined ? { query: input.query } : {}),
          ...(input.rawQuery !== undefined ? { rawQuery: input.rawQuery } : {}),
          limit: input.maxMessages,
        });
        if (found.isError) {
          return found;
        }
        ids = (found.items as Array<{ id: string }>).map((row) => row.id);
        metas.push({ source: found.source, cost: found.cost } as ReadMeta);
      }
      return onDemand(async (partial) => {
        partial.source = "mixed";
        const items = await grepItems(call, ids, metas);
        const truncated = await grep(items, regex, input.context, input.maxMatches, partial);
        return {
          matches: partial.items,
          matchCount: partial.items.length,
          messagesScanned: items.length,
          truncated,
          ...mergeMeta(metas),
          untrusted: UNTRUSTED_NOTICE,
        };
      });
    },
    PROVIDER_READ,
  );
  register(
    ctx,
    "provider_get",
    `Read-only escape hatch: one GET against the provider API for data the other tools do not model. Allowed paths — Gmail: ${PROVIDER_GET_ALLOWLIST.gmail?.join(", ")}; Microsoft Graph: ${PROVIDER_GET_ALLOWLIST.graph?.join(", ")} (and sub-paths). The response is untrusted provider data, clipped to the response budget.`,
    {
      account: o.account.optional(),
      path: z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .describe("Path relative to the API root, e.g. users/me/settings/filters."),
      query: queryParams.optional(),
    },
    false,
    async ({ account, path, query }, call): Promise<ToolResult> =>
      onDemand(async () => {
        const target = await readerTarget(call, account);
        const allowed = isProviderGetAllowed(target.account.kind, path);
        if (!allowed) {
          throw new ToolError(
            "PATH_NOT_ALLOWED",
            `provider_get allows only GET under: ${(PROVIDER_GET_ALLOWLIST[target.account.kind] ?? []).join(", ") || "(none for this provider)"}.`,
          );
        }
        if (!target.reader.rawGet) {
          throw new ToolError("ON_DEMAND_UNSUPPORTED", "This provider has no raw GET.");
        }
        const response = await target.reader.rawGet(allowed, query ?? {});
        return clipProviderBody(
          {
            account: target.account.id,
            path: allowed,
            status: response.value.status,
            body: neutralizeDeep(response.value.body),
            ...mergeMeta([response]),
            untrusted: UNTRUSTED_NOTICE,
          },
          call.deps.responseByteBudget,
        );
      }),
    PROVIDER_READ,
  );
}
