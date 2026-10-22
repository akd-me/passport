import type {
  Account,
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
  ReadCost,
  ReadResult,
  ReadValue,
} from "@passport/types";
import { decodeCursor, encodeCursor, ProviderError } from "./errors.js";
import { type JmapEmail, normalizeJmap } from "./jmap.js";
import { fetchJmapAttachment, type JmapDownload } from "./jmap-reader-attachments.js";
import {
  JMAP_BODY_PROPERTIES,
  JMAP_ROW_PROPERTIES,
  type JmapMailboxInfo,
  renderJmapFilter,
  rowHeaders,
} from "./jmap-reader-filter.js";
import {
  type JmapInvocation,
  jmapFilterArg,
  jmapQueryFilter,
  list,
  ok,
  queryRows,
  type RowContext,
  ref,
  type Send,
  SORT,
} from "./jmap-reader-query.js";
import { listFilterToAst } from "./query-render.js";
import type { QuotaGovernor } from "./quota.js";
import type { PassportVerifier } from "./verification.js";

export type { JmapInvocation } from "./jmap-reader-query.js";

/** What the reader needs from `JmapMailProvider`. */
export interface JmapReaderHost {
  /** The connected account; throws `NOT_CONNECTED` otherwise. */
  account(): Account;
  /** One JMAP HTTP request carrying `calls` (back-references allowed). */
  invoke(
    calls: JmapInvocation[],
    policy: { lane?: QuotaLane; signal?: AbortSignal },
  ): Promise<JmapInvocation[]>;
  /** One governed blob download through the session's `downloadUrl` template. */
  download(
    blobId: string,
    meta: { name: string; type: string },
    policy: { lane?: QuotaLane; signal?: AbortSignal },
  ): Promise<Response>;
  governor?: QuotaGovernor;
  verifier?: PassportVerifier;
  now(): Date;
}

/** Mailbox names/roles are cached this long for filters and row labels. */
const MAILBOX_TTL_MS = 60_000;

/**
 * `MailReader` over JMAP (RFC 8621), the best-fitting backend: `Email/query` with a translated
 * filter, `receivedAt` sort, `collapseThreads` and anchor paging; `Email/get` (with
 * `SearchSnippet/get` for text queries) in the same HTTP request; `Thread/get` + `Email/get` for
 * threads; `Email/changes` for changes. Cost: one `graphRequests` unit per HTTP request ("treat
 * JMAP as Graph-like"), acquired from the governor in the call's lane.
 */
export class JmapMailReader implements MailReader {
  private boxes?: { at: number; account: string; list: JmapMailboxInfo[] };
  constructor(private readonly host: JmapReaderHost) {}

  async search(input: MailSearchInput, opts: MailReadOptions = {}): Promise<ReadResult<MailRow>> {
    if (input.query !== undefined && input.rawQuery !== undefined) {
      throw new ProviderError("INVALID_QUERY", "Supply query or rawQuery, not both");
    }
    return this.run(opts, async (send) => {
      const boxes = await this.mailboxes(send);
      const filter = jmapQueryFilter(input.query, input.rawQuery, boxes, this.host.now());
      const key = JSON.stringify([
        input.query ?? null,
        input.rawQuery ?? null,
        input.container ?? null,
        Boolean(input.includeSpamTrash),
        Boolean(input.threads),
      ]);
      return queryRows(send, this.rowContext(), boxes, {
        kind: "search",
        key,
        conditions: filter.conditions,
        container: input.container,
        hideSpamTrash: !input.includeSpamTrash && !filter.scopesSpamTrash,
        threads: Boolean(input.threads),
        snippets: filter.hasText,
        limit: input.limit,
        pageToken: input.pageToken,
        translation: filter.translation,
      });
    });
  }

  async list(
    container: string | null,
    filter: MailListFilter,
    limit: number,
    pageToken?: string,
    opts: MailReadOptions = {},
  ): Promise<ReadResult<MailRow>> {
    return this.run(opts, async (send) => {
      const boxes = await this.mailboxes(send);
      const { conditions } = renderJmapFilter(listFilterToAst(filter), {
        now: this.host.now(),
        boxes,
      });
      return queryRows(send, this.rowContext(), boxes, {
        kind: "list",
        key: JSON.stringify([container, filter]),
        conditions,
        container,
        hideSpamTrash: true,
        threads: false,
        snippets: false,
        limit,
        pageToken,
        translation: "jmap:Email/query",
      });
    });
  }

  async labels(counts = false, opts: MailReadOptions = {}): Promise<ReadResult<MailLabel>> {
    return this.run(opts, async (send) => {
      const boxes = await this.mailboxes(send, true);
      const items = boxes.map((m): MailLabel => {
        const label: MailLabel = {
          id: m.id,
          name: m.name,
          role: m.role ?? null,
          parentId: m.parentId ?? null,
        };
        if (counts) {
          label.counts = { total: m.totalEmails ?? 0, unread: m.unreadEmails ?? 0 };
        }
        return label;
      });
      return { items };
    });
  }

  async envelopes(
    providerIds: string[],
    opts: MailReadOptions = {},
  ): Promise<ReadValue<Map<string, MailEnvelope | null>>> {
    return this.run(opts, async (send) => {
      const value = new Map<string, MailEnvelope | null>(providerIds.map((id) => [id, null]));
      if (providerIds.length > 0) {
        const [get] = await send([
          ["Email/get", { ids: providerIds, properties: JMAP_ROW_PROPERTIES }],
        ]);
        for (const raw of list<JmapEmail & Record<string, unknown>>(ok(get, "Email/get"))) {
          const { textBody: _t, htmlBody: _h, ...envelope } = await this.normalizeRow(raw);
          value.set(raw.id, envelope);
        }
      }
      return { value };
    });
  }

  async thread(
    threadProviderId: string,
    opts: { format: "text" | "html" } & MailReadOptions,
  ): Promise<ReadValue<Email[]>> {
    return this.run(opts, async (send) => {
      const [thread, get] = await send([
        ["Thread/get", { ids: [threadProviderId] }],
        [
          "Email/get",
          {
            "#ids": ref(0, "Thread/get", "/list/*/emailIds"),
            properties: JMAP_BODY_PROPERTIES,
            fetchTextBodyValues: true,
            fetchHTMLBodyValues: true,
          },
        ],
      ]);
      if (list(ok(thread, "Thread/get")).length === 0) {
        throw new ProviderError("NOT_FOUND", "Thread does not exist");
      }
      const emails = await Promise.all(
        list<JmapEmail>(ok(get, "Email/get")).map((e) => this.normalize(e)),
      );
      emails.sort(
        (a, b) =>
          a.receivedAt.localeCompare(b.receivedAt) || a.providerId.localeCompare(b.providerId),
      );
      return {
        value: opts.format === "text" ? emails.map((e) => ({ ...e, htmlBody: null })) : emails,
      };
    });
  }

  async body(providerId: string, opts: MailReadOptions = {}): Promise<ReadValue<MailBody>> {
    return this.run(opts, async (send) => {
      const [get] = await send([
        [
          "Email/get",
          {
            ids: [providerId],
            properties: JMAP_BODY_PROPERTIES,
            fetchTextBodyValues: true,
            fetchHTMLBodyValues: true,
          },
        ],
      ]);
      const raw = list<JmapEmail>(ok(get, "Email/get"))[0];
      if (!raw) {
        throw new ProviderError("NOT_FOUND", "Message does not exist");
      }
      const email = await this.normalize(raw);
      return {
        value: {
          textBody: email.textBody ?? null,
          htmlBody: email.htmlBody ?? null,
          attachments: email.attachments,
        },
      };
    });
  }

  /** `Email/get` for the attachment manifest, then one blob download (2 requests). */
  async attachment(
    providerId: string,
    attachmentRef: MailAttachmentRef,
    opts: MailReadOptions = {},
  ): Promise<ReadValue<MailAttachmentData>> {
    return this.run(opts, async (send, download) => ({
      value: await fetchJmapAttachment(
        send,
        download,
        this.host.account().id,
        providerId,
        attachmentRef,
      ),
    }));
  }

  // No `rawGet`: JMAP is method calls, not REST paths; `provider_get` has no JMAP allowlist.

  async countIds(
    query: string,
    cap: number,
    opts: MailCountOptions = {},
  ): Promise<ReadValue<{ count: number; capped: boolean }>> {
    return this.run(opts, async (send) => {
      const boxes = await this.mailboxes(send);
      const filter = jmapQueryFilter(
        opts.raw ? undefined : query,
        opts.raw ? query : undefined,
        boxes,
        this.host.now(),
      );
      const hide = !opts.includeSpamTrash && !filter.scopesSpamTrash;
      const [response] = await send([
        [
          "Email/query",
          {
            ...jmapFilterArg(filter.conditions, boxes, undefined, hide),
            limit: 1,
            calculateTotal: true,
          },
        ],
      ]);
      const total = Number(ok(response, "Email/query").total ?? 0);
      const count = Math.min(total, Math.max(0, Math.floor(cap)));
      return { value: { count, capped: total > count }, translation: filter.translation };
    });
  }

  async changes(
    cursor: string | null,
    limit: number,
    opts: MailReadOptions = {},
  ): Promise<ReadValue<MailChanges>> {
    return this.run(opts, async (send) => {
      const account = this.host.account().id;
      const encode = (state: string) => encodeCursor({ account, kind: "jmap-changes", state });
      const current = async () => {
        const [get] = await send([["Email/get", { ids: [] }]]);
        return String(ok(get, "Email/get").state ?? "");
      };
      const empty = { added: [], labelChanged: [], deleted: [] };
      if (cursor === null) {
        return { value: { ...empty, cursor: encode(await current()) } };
      }
      const c = decodeCursor<{ account?: string; kind?: string; state?: string }>(cursor);
      if (c.account !== account || c.kind !== "jmap-changes" || typeof c.state !== "string") {
        throw new ProviderError("INVALID_CURSOR", "Change cursor does not belong to this mailbox");
      }
      const [response] = await send([
        ["Email/changes", { sinceState: c.state, maxChanges: Math.max(1, Math.floor(limit)) }],
      ]);
      let args: Record<string, unknown>;
      try {
        args = ok(response, "Email/changes");
      } catch (e) {
        if (e instanceof ProviderError && e.code === "CURSOR_EXPIRED") {
          return { value: { ...empty, cursor: encode(await current()), expired: true } };
        }
        throw e;
      }
      const value: MailChanges = {
        added: list<string>(args, "created"),
        labelChanged: list<string>(args, "updated"),
        deleted: list<string>(args, "destroyed"),
        cursor: encode(String(args.newState ?? c.state)),
      };
      if (args.hasMoreChanges) {
        value.hasMore = true;
      }
      return { value };
    });
  }

  async findByRfc822(
    rfc822Id: string,
    opts: MailReadOptions = {},
  ): Promise<ReadValue<string | null>> {
    return this.run(opts, async (send) => {
      const header = `<${rfc822Id.trim().replace(/^<|>$/g, "")}>`;
      const [response] = await send([
        ["Email/query", { filter: { header: ["Message-ID", header] }, sort: SORT, limit: 1 }],
      ]);
      return { value: list<string>(ok(response, "Email/query"), "ids")[0] ?? null };
    });
  }

  // -------------------------------------------------------------------------

  /** Mailboxes for filters and row labels, cached for `MAILBOX_TTL_MS` (refreshed by `labels`). */
  private async mailboxes(send: Send, refresh = false): Promise<JmapMailboxInfo[]> {
    const account = this.host.account().id;
    const now = this.host.now().getTime();
    const cached = this.boxes;
    if (!refresh && cached && cached.account === account && now - cached.at < MAILBOX_TTL_MS) {
      return cached.list;
    }
    const [response] = await send([["Mailbox/get", {}]]);
    const boxes = list<JmapMailboxInfo>(ok(response, "Mailbox/get"));
    this.boxes = { at: now, account, list: boxes };
    return boxes;
  }

  private rowContext(): RowContext {
    return { accountId: this.host.account().id, normalizeRow: (raw) => this.normalizeRow(raw) };
  }

  private normalize(raw: JmapEmail): Promise<Email> {
    return normalizeJmap(raw, this.host.account().id, this.host.verifier);
  }

  private normalizeRow(raw: JmapEmail & Record<string, unknown>): Promise<Email> {
    return this.normalize({ ...raw, headers: rowHeaders(raw) });
  }

  /** Counts HTTP requests (`graphRequests`, JMAP being Graph-like) and adds `source` / `cost`. */
  private async run<R extends object>(
    opts: MailReadOptions,
    fn: (send: Send, download: JmapDownload) => Promise<R>,
  ): Promise<R & { source: "provider"; cost: ReadCost }> {
    const account = this.host.account();
    if (opts.signal?.aborted) {
      throw new ProviderError("ABORTED", "The read was cancelled");
    }
    let requests = 0;
    const policy = {
      lane: opts.lane ?? "interactive",
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    const result = await fn(
      (calls) => {
        requests++;
        return this.host.invoke(calls, policy);
      },
      (blobId, name, type) => {
        requests++;
        return this.host.download(blobId, { name, type }, policy);
      },
    );
    return {
      ...result,
      source: "provider",
      cost: { graphRequests: requests, ...this.host.governor?.snapshot(account.id) },
    };
  }
}
