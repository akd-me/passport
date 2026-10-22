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
  ReadCost,
  ReadResult,
  ReadValue,
} from "@passport/types";
import { ProviderError } from "./errors.js";
import {
  GmailManifestCache,
  gmailRawGet,
  readGmailAttachment,
} from "./gmail-reader-attachments.js";
import { batchGet } from "./gmail-reader-batch.js";
import { gmailChanges } from "./gmail-reader-history.js";
import { GmailLabelCache, toMailLabels } from "./gmail-reader-labels.js";
import {
  type GmailLabel,
  type GmailMessage,
  hydrateTextParts,
  normalizeGmail,
} from "./gmail-reader-normalize.js";
import { type GmailPage, readGmailPage } from "./gmail-reader-page.js";
import {
  clampLimit,
  type GmailThread,
  type IdPage,
  joinQ,
  type ListRequest,
  listParams,
  RAW_SPAM_TRASH,
  scopesSpamTrash,
} from "./gmail-reader-query.js";
import {
  decodePageToken,
  encodePageToken,
  GmailCall,
  type GmailTransport,
  isNotFound,
  metadataParams,
  withoutBodies,
} from "./gmail-reader-support.js";
import { parsePortableQuery, queryScopesSpamTrash } from "./query.js";
import { listFilterToAst, renderGmailQuery } from "./query-render.js";
import { GMAIL_UNIT_COSTS as UNITS } from "./quota-presets.js";

/** One priced call, recorded so tests and callers can audit cost accounting. */
export interface GmailCostEntry {
  method: keyof MailReader;
  gmailUnits: number;
  lane: QuotaLane;
}

const enc = encodeURIComponent;

/**
 * `MailReader` over the Gmail API (research report 03 §1–2). Every request declares its
 * `GMAIL_UNIT_COSTS` price and runs through the provider's governed transport in the caller's
 * lane (default `interactive`); results report the units spent. Row hydration uses the batch
 * endpoint. Page tokens wrap Gmail's and are bound to the account and query.
 */
export class GmailMailReader implements MailReader {
  private readonly costs: GmailCostEntry[] = [];
  private readonly labelCache: GmailLabelCache;
  private readonly manifests = new GmailManifestCache();
  constructor(private readonly transport: GmailTransport) {
    this.labelCache = new GmailLabelCache(() => transport.accountId());
  }

  /** Every priced call so far, oldest first. */
  get costLog(): readonly GmailCostEntry[] {
    return [...this.costs];
  }
  /** Sum of `costLog` units. */
  get totalUnits(): number {
    return this.costs.reduce((sum, entry) => sum + entry.gmailUnits, 0);
  }

  async search(input: MailSearchInput, opts: MailReadOptions = {}): Promise<ReadResult<MailRow>> {
    if (input.query !== undefined && input.rawQuery !== undefined) {
      throw new ProviderError("INVALID_QUERY", "Supply query or rawQuery, not both");
    }
    const call = this.call(opts);
    let q: string;
    let spamTrash: boolean;
    if (input.rawQuery !== undefined) {
      q = input.rawQuery.trim();
      spamTrash = RAW_SPAM_TRASH.test(q);
    } else {
      const ast = parsePortableQuery(input.query ?? "");
      q = renderGmailQuery(ast);
      spamTrash = queryScopesSpamTrash(ast);
    }
    const key = JSON.stringify([
      input.query ?? null,
      input.rawQuery ?? null,
      input.container ?? null,
      Boolean(input.includeSpamTrash),
      Boolean(input.threads),
    ]);
    const account = this.transport.accountId();
    const state = decodePageToken(account, "search", key, input.pageToken);
    const scope = input.container ? await this.labelCache.scope(call, input.container) : {};
    const page = await this.page(call, {
      q: joinQ(q, scope.q),
      scope,
      limit: clampLimit(input.limit),
      pageToken: state?.token,
      ids: state?.ids,
      includeSpamTrash: Boolean(input.includeSpamTrash) || spamTrash || scopesSpamTrash(scope),
      threads: Boolean(input.threads),
    });
    return this.collection(
      "search",
      call,
      page,
      encodePageToken(account, "search", key, page.next),
    );
  }

  async list(
    container: string | null,
    filter: MailListFilter,
    limit: number,
    pageToken?: string,
    opts: MailReadOptions = {},
  ): Promise<ReadResult<MailRow>> {
    const call = this.call(opts);
    const account = this.transport.accountId();
    const key = JSON.stringify([container, filter]);
    const state = decodePageToken(account, "list", key, pageToken);
    const scope = container ? await this.labelCache.scope(call, container) : {};
    const page = await this.page(call, {
      q: joinQ(renderGmailQuery(listFilterToAst(filter)), scope.q),
      scope,
      limit: clampLimit(limit),
      pageToken: state?.token,
      ids: state?.ids,
      includeSpamTrash: scopesSpamTrash(scope),
      threads: false,
    });
    return this.collection("list", call, page, encodePageToken(account, "list", key, page.next));
  }

  async labels(counts = false, opts: MailReadOptions = {}): Promise<ReadResult<MailLabel>> {
    const call = this.call(opts);
    const labels = await this.labelCache.loadLabels(call);
    const items = toMailLabels(labels);
    if (counts) {
      const details = await batchGet<GmailLabel>(
        call,
        labels.map((l) => `labels/${enc(l.id)}`),
        UNITS.labelsGet,
      );
      for (const [i, item] of items.entries()) {
        const d = details[i];
        if (d) {
          item.counts = { total: d.messagesTotal ?? 0, unread: d.messagesUnread ?? 0 };
        }
      }
    }
    return { items, ...this.finish("labels", call) };
  }

  async envelopes(
    providerIds: string[],
    opts: MailReadOptions = {},
  ): Promise<ReadValue<Map<string, MailEnvelope | null>>> {
    const call = this.call(opts);
    const ids = [...new Set(providerIds)];
    const messages = await this.metadata(call, ids);
    const value = new Map<string, MailEnvelope | null>();
    for (const [i, id] of ids.entries()) {
      const message = messages[i];
      value.set(id, message ? withoutBodies(await this.normalize(message)) : null);
    }
    return { value, ...this.finish("envelopes", call) };
  }

  async thread(
    threadProviderId: string,
    opts: { format: "text" | "html" } & MailReadOptions,
  ): Promise<ReadValue<Email[]>> {
    const call = this.call(opts);
    let thread: GmailThread;
    try {
      thread = await call.get<GmailThread>(
        `threads/${enc(threadProviderId)}?format=full`,
        UNITS.threadsGetFull,
      );
    } catch (e) {
      throw isNotFound(e) ? new ProviderError("NOT_FOUND", "Thread does not exist", 404) : e;
    }
    if (!thread.messages?.length) {
      throw new ProviderError("NOT_FOUND", "Thread does not exist", 404);
    }
    const value: Email[] = [];
    for (const message of thread.messages) {
      const email = await this.full(call, message);
      value.push(opts.format === "text" ? { ...email, htmlBody: null } : email);
    }
    value.sort(
      (a, b) =>
        a.receivedAt.localeCompare(b.receivedAt) || a.providerId.localeCompare(b.providerId),
    );
    return { value, ...this.finish("thread", call) };
  }

  async body(providerId: string, opts: MailReadOptions = {}): Promise<ReadValue<MailBody>> {
    const call = this.call(opts);
    let message: GmailMessage;
    try {
      message = await call.get<GmailMessage>(
        `messages/${enc(providerId)}?format=full`,
        UNITS.messagesGetFull,
      );
    } catch (e) {
      throw isNotFound(e) ? new ProviderError("NOT_FOUND", "Message does not exist", 404) : e;
    }
    const email = await this.full(call, message);
    const value: MailBody = {
      textBody: email.textBody ?? null,
      htmlBody: email.htmlBody ?? null,
      attachments: email.attachments,
    };
    return { value, ...this.finish("body", call) };
  }

  async countIds(
    query: string,
    cap: number,
    opts: MailCountOptions = {},
  ): Promise<ReadValue<{ count: number; capped: boolean }>> {
    const call = this.call(opts);
    const ast = opts.raw ? null : parsePortableQuery(query);
    const q = ast ? renderGmailQuery(ast) : query.trim();
    const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 0;
    const request = {
      q,
      scope: {},
      limit,
      includeSpamTrash:
        Boolean(opts.includeSpamTrash) ||
        (ast ? queryScopesSpamTrash(ast) : RAW_SPAM_TRASH.test(q)),
    };
    let count = 0;
    let pageToken: string | undefined;
    do {
      const maxResults = Math.min(500, limit - count + 1);
      const page = await call.get<IdPage>(
        `messages?${listParams({ ...request, pageToken }, maxResults)}`,
        UNITS.messagesList,
      );
      count += page.messages?.length ?? 0;
      pageToken = page.nextPageToken;
    } while (pageToken && count <= limit);
    const value = { count: Math.min(count, limit), capped: count > limit };
    return { value, ...this.finish("countIds", call) };
  }

  async changes(
    cursor: string | null,
    limit: number,
    opts: MailReadOptions = {},
  ): Promise<ReadValue<MailChanges>> {
    const call = this.call(opts);
    const value = await gmailChanges(call, this.transport.accountId(), cursor, limit);
    return { value, ...this.finish("changes", call) };
  }

  async findByRfc822(
    rfc822Id: string,
    opts: MailReadOptions = {},
  ): Promise<ReadValue<string | null>> {
    const call = this.call(opts);
    const id = rfc822Id.trim().replace(/^</, "").replace(/>$/, "").replace(/["\s]/g, "");
    const lookup = async (q: string) =>
      (
        await call.get<IdPage>(
          `messages?${listParams({ q, scope: {}, pageToken: undefined, includeSpamTrash: true }, 10)}`,
          UNITS.messagesList,
        )
      ).messages ?? [];
    const matches = id ? await lookup(`rfc822msgid:${id}`) : [];
    // Duplicate Message-IDs (the Sent copy and the received copy): prefer the received one.
    const preferred =
      matches.length > 1 ? (await lookup(`rfc822msgid:${id} -in:sent`))[0] : undefined;
    const value = (preferred ?? matches[0])?.id ?? null;
    return { value, ...this.finish("findByRfc822", call) };
  }

  async attachment(
    providerId: string,
    attachmentRef: MailAttachmentRef,
    opts: MailReadOptions = {},
  ): Promise<ReadValue<MailAttachmentData>> {
    const call = this.call(opts);
    const account = this.transport.accountId();
    const value = await readGmailAttachment(
      call,
      this.manifests,
      account,
      providerId,
      attachmentRef,
    );
    return { value, ...this.finish("attachment", call) };
  }

  /** `provider_get`: one allowlisted GET, priced per method (`gmailRawGetUnits`). */
  async rawGet(
    path: string,
    query: Record<string, string>,
    opts: MailReadOptions = {},
  ): Promise<ReadValue<RawGetResponse>> {
    const call = this.call(opts);
    const value = await gmailRawGet(call, path, query);
    return { value, ...this.finish("rawGet", call) };
  }

  // -------------------------------------------------------------------------

  private call(opts: MailReadOptions): GmailCall {
    this.transport.accountId();
    return new GmailCall(this.transport, opts.lane ?? "interactive", opts.signal);
  }

  private finish(
    method: keyof MailReader,
    call: GmailCall,
  ): { source: "provider"; cost: ReadCost } {
    this.costs.push({ method, gmailUnits: call.units, lane: call.lane });
    return call.meta();
  }

  private collection(
    method: "search" | "list",
    call: GmailCall,
    page: GmailPage,
    nextPageToken: string | undefined,
  ): ReadResult<MailRow> {
    return {
      items: page.items,
      ...(nextPageToken ? { nextPageToken } : {}),
      ...(page.approxTotal !== undefined ? { approxTotal: page.approxTotal } : {}),
      ...this.finish(method, call),
      ...(page.cut ? { translation: page.cut } : {}),
    };
  }

  private page(call: GmailCall, r: ListRequest & { ids?: string[] | undefined }) {
    return readGmailPage(call, r, this.labelCache, (m) => this.normalize(m));
  }

  private metadata(call: GmailCall, ids: readonly string[]): Promise<Array<GmailMessage | null>> {
    return batchGet<GmailMessage>(
      call,
      ids.map((id) => `messages/${enc(id)}?${metadataParams()}`),
      UNITS.messagesGetMetadata,
    );
  }

  private normalize(message: GmailMessage): Promise<Email> {
    return normalizeGmail(message, this.transport.accountId(), this.transport.verifier);
  }

  /** Fetches externalized text bodies (20 units each) and normalizes a `format=full` message. */
  private async full(call: GmailCall, message: GmailMessage): Promise<Email> {
    await hydrateTextParts(message, (attachmentId) =>
      call.get<{ data?: unknown }>(
        `messages/${enc(message.id)}/attachments/${enc(attachmentId)}`,
        UNITS.attachmentsGet,
      ),
    );
    this.manifests.remember(message, this.transport.accountId());
    return this.normalize(message);
  }
}
