import { createHash } from "node:crypto";
import type {
  Email,
  MailAttachmentData,
  MailAttachmentRef,
  MailBody,
  MailChanges,
  MailCountOptions,
  MailEnvelope,
  MailLabel,
  MailListFilter,
  MailReader,
  MailReadOptions,
  MailRow,
  MailSearchInput,
  QuotaLane,
  RawGetResponse,
  ReadResult,
  ReadValue,
} from "@passport/types";
import { ProviderError } from "./errors.js";
import {
  GraphManifestCache,
  graphRawGet,
  readGraphAttachment,
} from "./graph-reader-attachments.js";
import { fetchBody, fetchThread } from "./graph-reader-bodies.js";
import { readChanges } from "./graph-reader-changes.js";
import { readCount } from "./graph-reader-count.js";
import { GraphFolderCache, type GraphFolderInfo } from "./graph-reader-folders.js";
import { planRawGraphQuery } from "./graph-reader-query.js";
import {
  clientMatch,
  decodePageToken,
  encodePageToken,
  envelopeOf,
  type GraphPageToken,
  type GraphScope,
  messageLabels,
  needsHeaders,
  planUrl,
  rowOf,
  scanRows,
} from "./graph-reader-rows.js";
import {
  ATTACHMENTS_EXPAND,
  batchError,
  ENVELOPE_SELECT,
  GraphCall,
  type GraphReaderTransport,
  graphUrl,
  type ReaderMessage,
  ROW_SELECT,
} from "./graph-reader-support.js";
import { parsePortableQuery, type QueryAst } from "./query.js";
import { type GraphQueryPlan, listFilterToAst, renderGraphQuery } from "./query-render.js";

export interface GraphReaderOptions {
  /** Folders `changes` tracks (ids or well-known names). Default `["inbox"]`. */
  changeFolders?: string[];
  /** How long the folder tree used for row labels is reused. Default 5 minutes. */
  folderCacheMs?: number;
}

/** One priced call, recorded so tests and diagnostics can assert request accounting. */
export interface GraphCostEntry {
  method: keyof MailReader;
  graphRequests: number;
  lane: QuotaLane;
}

/**
 * `search` / `list` result. `capped` is set when `$search` reached its 1,000-result ceiling;
 * `approxTotal` is then 1,000 and `translation` says so.
 */
export type GraphReadResult<T> = ReadResult<T> & { capped?: boolean };

const EMPTY: QueryAst = { kind: "and", nodes: [] };
const MAX_ROW_PAGES = 4;
const MAX_SEEN = 200;

const hash = (value: string) => createHash("sha1").update(value).digest("base64url").slice(0, 10);

/**
 * `MailReader` over Microsoft Graph. Every HTTP request costs one `graphRequests` unit (a `$batch`
 * costs one per inner request) and is acquired from the governor in the call's lane.
 */
export class GraphMailReader implements MailReader {
  private readonly costs: GraphCostEntry[] = [];
  private readonly folders: GraphFolderCache;
  private readonly manifests = new GraphManifestCache();
  constructor(
    private readonly transport: GraphReaderTransport,
    private readonly options: GraphReaderOptions = {},
  ) {
    this.folders = new GraphFolderCache(transport, options.folderCacheMs);
  }

  /** Every priced call so far, oldest first. */
  get costLog(): readonly GraphCostEntry[] {
    return [...this.costs];
  }
  /** Sum of `costLog` requests. */
  get totalRequests(): number {
    return this.costs.reduce((sum, entry) => sum + entry.graphRequests, 0);
  }

  async search(
    input: MailSearchInput,
    opts: MailReadOptions = {},
  ): Promise<GraphReadResult<MailRow>> {
    if (input.query !== undefined && input.rawQuery !== undefined) {
      throw new ProviderError("INVALID_QUERY", "Supply query or rawQuery, not both");
    }
    const ast = input.rawQuery !== undefined ? EMPTY : parsePortableQuery(input.query ?? "");
    const plan =
      input.rawQuery !== undefined
        ? planRawGraphQuery(input.rawQuery)
        : renderGraphQuery(ast, this.transport.now());
    const key = JSON.stringify([
      input.query ?? null,
      input.rawQuery ?? null,
      input.container ?? null,
      Boolean(input.includeSpamTrash),
      Boolean(input.threads),
    ]);
    return this.rows("search", key, plan, ast, {
      container: input.container ?? null,
      includeSpamTrash: Boolean(input.includeSpamTrash),
      threads: Boolean(input.threads),
      limit: input.limit,
      pageToken: input.pageToken,
      opts,
    });
  }

  async list(
    container: string | null,
    filter: MailListFilter,
    limit: number,
    pageToken?: string,
    opts: MailReadOptions = {},
  ): Promise<GraphReadResult<MailRow>> {
    const ast = listFilterToAst(filter);
    const plan = renderGraphQuery(ast, this.transport.now());
    return this.rows("list", JSON.stringify([container, filter]), plan, ast, {
      container,
      includeSpamTrash: false,
      threads: false,
      limit,
      pageToken,
      opts,
    });
  }

  async labels(counts = false, opts: MailReadOptions = {}): Promise<ReadResult<MailLabel>> {
    const call = this.call(opts);
    const folders = await this.folders.tree(call, true);
    const items: MailLabel[] = [...folders.values()].map((f) => ({
      id: f.id,
      name: f.name,
      role: f.role,
      parentId: f.parentId,
      ...(counts ? { counts: { total: f.total, unread: f.unread } } : {}),
    }));
    const categories = await call.get<{ value?: Array<{ displayName?: string }> }>(
      graphUrl("/me/outlook/masterCategories"),
    );
    for (const c of categories.value ?? []) {
      if (c.displayName) {
        // Categories are label-like and have no counts; their id is the display name.
        items.push({ id: c.displayName, name: c.displayName, role: null, parentId: null });
      }
    }
    return { items, ...this.done("labels", call) };
  }

  async envelopes(
    providerIds: string[],
    opts: MailReadOptions = {},
  ): Promise<ReadValue<Map<string, MailEnvelope | null>>> {
    const call = this.call(opts);
    const unique = [...new Set(providerIds)];
    const responses = await call.batch(
      unique.map((id, i) => ({
        id: String(i),
        url: `/me/messages/${encodeURIComponent(id)}?$select=${ENVELOPE_SELECT}&$expand=${ATTACHMENTS_EXPAND}`,
      })),
    );
    const value = new Map<string, MailEnvelope | null>();
    for (const [i, id] of unique.entries()) {
      const inner = responses.get(String(i));
      if (!inner || inner.status === 404) {
        value.set(id, null);
      } else if (inner.status >= 300) {
        throw batchError(inner);
      } else {
        const email = await envelopeOf(call, inner.body as ReaderMessage);
        const { textBody: _t, htmlBody: _h, ...envelope } = email;
        value.set(id, envelope);
      }
    }
    return { value, ...this.done("envelopes", call) };
  }

  async thread(
    threadProviderId: string,
    opts: { format: "text" | "html" } & MailReadOptions,
  ): Promise<ReadValue<Email[]>> {
    const call = this.call(opts);
    const value = await fetchThread(call, threadProviderId, opts.format);
    return { value, ...this.done("thread", call) };
  }

  /**
   * Bodies and attachment manifest. Graph extension: `format: "html"` returns the HTML body (text
   * converted locally); the default `"text"` uses the server conversion and `htmlBody` is null.
   */
  async body(
    providerId: string,
    opts: MailReadOptions & { format?: "text" | "html" } = {},
  ): Promise<ReadValue<MailBody>> {
    const call = this.call(opts);
    const value = await fetchBody(call, providerId, opts.format ?? "text");
    return { value, ...this.done("body", call) };
  }

  async countIds(
    query: string,
    cap: number,
    opts: MailCountOptions = {},
  ): Promise<ReadValue<{ count: number; capped: boolean }>> {
    const call = this.call(opts);
    const ast = opts.raw ? EMPTY : parsePortableQuery(query);
    const plan = opts.raw ? planRawGraphQuery(query) : renderGraphQuery(ast, this.transport.now());
    const scope = await this.folders.scope(call, plan, null, ast, Boolean(opts.includeSpamTrash));
    const folders = plan.clientFilter.length ? await this.folders.tree(call) : new Map();
    const value = await readCount(call, plan, scope, Math.max(0, Math.floor(cap)), (m) =>
      this.keep(call, plan, scope, folders, m),
    );
    return { value, ...this.done("countIds", call, plan.translation) };
  }

  async changes(
    cursor: string | null,
    limit: number,
    opts: MailReadOptions = {},
  ): Promise<ReadValue<MailChanges>> {
    const call = this.call(opts);
    const value = await readChanges(call, cursor, limit, this.options.changeFolders ?? ["inbox"]);
    return { value, ...this.done("changes", call) };
  }

  async findByRfc822(
    rfc822Id: string,
    opts: MailReadOptions = {},
  ): Promise<ReadValue<string | null>> {
    const call = this.call(opts);
    const id = `<${rfc822Id.trim().replace(/^</, "").replace(/>$/, "")}>`;
    const page = await call.get<{ value?: ReaderMessage[] }>(
      graphUrl("/me/messages", {
        $filter: `internetMessageId eq '${id.replaceAll("'", "''")}'`,
        $select: "id,parentFolderId",
        $top: "10",
      }),
    );
    const found = page.value ?? [];
    let value = found[0]?.id ?? null;
    if (found.length > 1) {
      // Duplicate Message-IDs (Sent and Inbox copies): prefer a received, non-deleted copy.
      const roles = await this.folders.roleIds(call);
      const rank = (m: ReaderMessage) => {
        const role = roles.get(m.parentFolderId ?? "");
        return role === "sent" || role === "drafts" ? 2 : role === "trash" ? 1 : 0;
      };
      value = [...found].sort((a, b) => rank(a) - rank(b))[0]?.id ?? null;
    }
    return { value, ...this.done("findByRfc822", call) };
  }

  async attachment(
    providerId: string,
    attachmentRef: MailAttachmentRef,
    opts: MailReadOptions = {},
  ): Promise<ReadValue<MailAttachmentData>> {
    const call = this.call(opts);
    const value = await readGraphAttachment(call, this.manifests, providerId, attachmentRef);
    return { value, ...this.done("attachment", call) };
  }

  /** `provider_get`: one allowlisted GET, 1 request. */
  async rawGet(
    path: string,
    query: Record<string, string>,
    opts: MailReadOptions = {},
  ): Promise<ReadValue<RawGetResponse>> {
    const call = this.call(opts);
    const value = await graphRawGet(call, path, query);
    return { value, ...this.done("rawGet", call) };
  }

  // -------------------------------------------------------------------------

  private call(opts: MailReadOptions): GraphCall {
    this.transport.accountId();
    return new GraphCall(this.transport, opts.lane ?? "interactive", opts.signal);
  }

  private done(method: keyof MailReader, call: GraphCall, translation?: string) {
    this.costs.push({ method, graphRequests: call.requests, lane: call.lane });
    return call.meta(translation);
  }

  /** The row for a message, or null when Spam/Trash hiding or the client filter drops it. */
  private async keep(
    call: GraphCall,
    plan: GraphQueryPlan,
    scope: GraphScope,
    folders: ReadonlyMap<string, GraphFolderInfo>,
    message: ReaderMessage,
  ): Promise<MailRow | null> {
    if (message.parentFolderId && scope.hidden.has(message.parentFolderId)) {
      return null;
    }
    const email = await envelopeOf(call, message);
    const labels = messageLabels(message, folders);
    if (!clientMatch(plan, email, labels, this.transport.now())) {
      return null;
    }
    return rowOf(email, message, folders);
  }

  private async rows(
    kind: GraphPageToken["kind"],
    key: string,
    plan: GraphQueryPlan,
    ast: QueryAst,
    input: {
      container: string | null;
      includeSpamTrash: boolean;
      threads: boolean;
      limit: number;
      pageToken: string | undefined;
      opts: MailReadOptions;
    },
  ): Promise<GraphReadResult<MailRow>> {
    const call = this.call(input.opts);
    const account = this.transport.accountId();
    const token = input.pageToken ? decodePageToken(input.pageToken, { account, kind, key }) : null;
    const limit = Math.min(100, Math.max(1, Math.floor(input.limit)));
    const scope = await this.folders.scope(
      call,
      plan,
      input.container,
      ast,
      input.includeSpamTrash,
    );
    if (scope.empty) {
      return { items: [], approxTotal: 0, ...this.done(kind, call, plan.translation) };
    }
    const folders = await this.folders.tree(call);
    const dropsRows = plan.clientFilter.length > 0 || input.threads;
    const filtered = dropsRows || scope.hidden.size > 0;
    const select = needsHeaders(plan.clientFilter)
      ? `${ROW_SELECT},internetMessageHeaders`
      : ROW_SELECT;
    const seen = new Set(token?.seen ?? []);
    const result = await scanRows({
      call,
      url: planUrl(plan, scope, { top: dropsRows ? Math.max(limit, 100) : limit, select }),
      token,
      limit,
      search: plan.strategy !== "filter",
      maxPages: filtered ? MAX_ROW_PAGES : 1,
      keep: async (message) => {
        const row = await this.keep(call, plan, scope, folders, message);
        if (row && input.threads) {
          const h = hash(message.conversationId ?? message.id);
          if (seen.has(h)) {
            return null;
          }
          seen.add(h);
        }
        return row;
      },
    });
    const translation = result.capped
      ? `${plan.translation} (capped at 1000 results; narrow with after:/before:)`
      : plan.translation;
    const next = result.next
      ? encodePageToken({
          account,
          kind,
          key,
          ...result.next,
          ...(input.threads ? { seen: [...seen].slice(-MAX_SEEN) } : {}),
        })
      : undefined;
    return {
      items: result.rows,
      ...(next ? { nextPageToken: next } : {}),
      // Approximate: @odata.count includes Spam/Trash rows hidden client-side.
      ...(result.approxTotal !== undefined && (!dropsRows || result.capped)
        ? { approxTotal: result.approxTotal }
        : {}),
      ...(result.capped ? { capped: true } : {}),
      ...this.done(kind, call, translation),
    };
  }
}
