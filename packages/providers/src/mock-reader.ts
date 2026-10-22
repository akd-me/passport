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
  SyncDelta,
} from "@passport/types";
import { mailHandle, toMailRow } from "@passport/types";
import { decodeCursor, encodeCursor, ProviderError } from "./errors.js";
import { clone, folderRoles } from "./mock-fixtures.js";
import {
  collectChanges,
  mailHandleForFolder,
  newestPerThread,
  pageOf,
  stripBrackets,
  withoutBodies,
} from "./mock-reader-support.js";
import { parsePortableQuery, type QueryAst, queryScopesSpamTrash } from "./query.js";
import { type MatchLabel, matchesQuery } from "./query-match.js";
import { listFilterToAst } from "./query-render.js";
import type { QuotaGovernor } from "./quota.js";
import { GMAIL_UNIT_COSTS } from "./quota-presets.js";
import { assertAttachmentSize, attachmentData, pickAttachment } from "./reader-attachments.js";
import { clampCap } from "./reader-limits.js";

/** Live view of `MockMailProvider` state that the reader reads from. */
export interface MockReaderSource {
  /** The connected account; throws `NOT_CONNECTED` otherwise. */
  account(): Account;
  emails(): Iterable<Email>;
  get(providerId: string): Email | undefined;
  folders(): readonly string[];
  /** Append-only change log; a change cursor is an index into it. */
  log(): ReadonlyArray<Extract<SyncDelta, { kind: "email" }>>;
  /** Bytes of an attachment blob a message references; undefined when unknown. */
  blob(blobId: string): { type: string; data: Uint8Array } | undefined;
  /** The mock's fixture clock. */
  now(): Date;
  /** Applies the configured verifier, if any. */
  verify(email: Email): Promise<Email>;
  governor?: QuotaGovernor;
}

/** One priced call, recorded so tests can assert cost accounting. */
export interface MockCostEntry {
  method: keyof MailReader;
  gmailUnits: number;
  lane: QuotaLane;
}

/** Change cursors older than this report `expired: true`, like Gmail's ~1 week of history. */
export const MOCK_CHANGE_RETENTION_MS = 7 * 24 * 3600_000;

interface ChangeCursor {
  account: string;
  kind: "changes";
  revision: number;
  at: number;
}

interface Scope {
  container?: string | null | undefined;
  includeSpamTrash?: boolean | undefined;
}

/**
 * `MailReader` over the mock's fixtures. Prices every call as Gmail would (`GMAIL_UNIT_COSTS`),
 * acquires the units from the optional governor in the requested lane, and records them in
 * `costLog`. Paging tokens are opaque and bound to their query.
 */
export class MockMailReader implements MailReader {
  private readonly costs: MockCostEntry[] = [];
  constructor(private readonly source: MockReaderSource) {}

  /** Every priced call so far, oldest first. */
  get costLog(): readonly MockCostEntry[] {
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
    // The mock's native syntax is the portable one, so rawQuery parses the same way.
    const ast = parsePortableQuery(input.query ?? input.rawQuery ?? "");
    const key = JSON.stringify([
      input.query ?? null,
      input.rawQuery ?? null,
      input.container ?? null,
      Boolean(input.includeSpamTrash),
      Boolean(input.threads),
    ]);
    const scope = { container: input.container, includeSpamTrash: input.includeSpamTrash };
    const matches = this.match(ast, scope);
    const page = pageOf(
      this.source.account().id,
      input.threads ? newestPerThread(matches) : matches,
      "search",
      key,
      input.limit,
      input.pageToken,
    );
    const units = input.threads
      ? GMAIL_UNIT_COSTS.threadsList + page.items.length * GMAIL_UNIT_COSTS.threadsGetMetadata
      : GMAIL_UNIT_COSTS.messagesList + page.items.length * GMAIL_UNIT_COSTS.messagesGetMetadata;
    return {
      ...page,
      items: page.items.map((e) => this.row(e)),
      ...(await this.spend("search", units, opts)),
    };
  }

  async list(
    container: string | null,
    filter: MailListFilter,
    limit: number,
    pageToken?: string,
    opts: MailReadOptions = {},
  ): Promise<ReadResult<MailRow>> {
    const matches = this.match(listFilterToAst(filter), { container });
    const key = JSON.stringify([container, filter]);
    const page = pageOf(this.source.account().id, matches, "list", key, limit, pageToken);
    const units =
      GMAIL_UNIT_COSTS.messagesList + page.items.length * GMAIL_UNIT_COSTS.messagesGetMetadata;
    return {
      ...page,
      items: page.items.map((e) => this.row(e)),
      ...(await this.spend("list", units, opts)),
    };
  }

  async labels(counts = false, opts: MailReadOptions = {}): Promise<ReadResult<MailLabel>> {
    const account = this.source.account();
    const emails = [...this.source.emails()];
    const items = this.source.folders().map((name): MailLabel => {
      const label: MailLabel = { id: name, name, role: folderRoles[name] ?? null };
      if (counts) {
        const id = mailHandleForFolder(account.id, name);
        const members = emails.filter((e) => e.mailboxIds.includes(id));
        label.counts = {
          total: members.length,
          unread: members.filter((e) => !e.keywords.$seen).length,
        };
      }
      return label;
    });
    const units =
      GMAIL_UNIT_COSTS.labelsList + (counts ? items.length * GMAIL_UNIT_COSTS.labelsGet : 0);
    return { items, ...(await this.spend("labels", units, opts)) };
  }

  async envelopes(
    providerIds: string[],
    opts: MailReadOptions = {},
  ): Promise<ReadValue<Map<string, MailEnvelope | null>>> {
    this.source.account();
    const value = new Map<string, MailEnvelope | null>();
    for (const id of providerIds) {
      const email = this.source.get(id);
      value.set(id, email ? withoutBodies(await this.source.verify(clone(email))) : null);
    }
    const units = providerIds.length * GMAIL_UNIT_COSTS.messagesGetMetadata;
    return { value, ...(await this.spend("envelopes", units, opts)) };
  }

  async thread(
    threadProviderId: string,
    opts: { format: "text" | "html" } & MailReadOptions,
  ): Promise<ReadValue<Email[]>> {
    const account = this.source.account();
    const threadId = mailHandle(account.id, "thread", threadProviderId);
    const members = [...this.source.emails()]
      .filter((e) => e.threadId === threadId)
      .sort(
        (a, b) =>
          a.receivedAt.localeCompare(b.receivedAt) || a.providerId.localeCompare(b.providerId),
      );
    if (members.length === 0) {
      throw new ProviderError("NOT_FOUND", "Thread does not exist");
    }
    const value: Email[] = [];
    for (const email of members) {
      const copy = await this.source.verify(clone(email));
      value.push(opts.format === "text" ? { ...copy, htmlBody: null } : copy);
    }
    return { value, ...(await this.spend("thread", GMAIL_UNIT_COSTS.threadsGetFull, opts)) };
  }

  async body(providerId: string, opts: MailReadOptions = {}): Promise<ReadValue<MailBody>> {
    this.source.account();
    const email = this.source.get(providerId);
    if (!email) {
      throw new ProviderError("NOT_FOUND", "Message does not exist");
    }
    const value: MailBody = clone({
      textBody: email.textBody ?? null,
      htmlBody: email.htmlBody ?? null,
      attachments: email.attachments,
    });
    return { value, ...(await this.spend("body", GMAIL_UNIT_COSTS.messagesGetFull, opts)) };
  }

  /** Priced like Gmail's `messages.attachments.get` (20 units); the manifest is local. */
  async attachment(
    providerId: string,
    attachmentRef: MailAttachmentRef,
    opts: MailReadOptions = {},
  ): Promise<ReadValue<MailAttachmentData>> {
    this.source.account();
    const email = this.source.get(providerId);
    if (!email) {
      throw new ProviderError("NOT_FOUND", "Message does not exist");
    }
    const entry = pickAttachment(
      email.attachments.map((a) => ({
        name: a.name,
        type: a.type,
        size: a.size,
        inline: a.disposition === "inline",
        contentId: a.cid ?? undefined,
        keys: [a.id, a.blobId],
        blobId: a.blobId,
      })),
      attachmentRef,
    );
    assertAttachmentSize(entry.size);
    const blob = this.source.blob(entry.blobId);
    if (!blob) {
      throw new ProviderError("NOT_FOUND", "Attachment does not exist");
    }
    const value = attachmentData(entry, blob.data);
    return { value, ...(await this.spend("attachment", GMAIL_UNIT_COSTS.attachmentsGet, opts)) };
  }

  async countIds(
    query: string,
    cap: number,
    opts: MailCountOptions = {},
  ): Promise<ReadValue<{ count: number; capped: boolean }>> {
    const total = this.match(parsePortableQuery(query), {
      includeSpamTrash: opts.includeSpamTrash,
    }).length;
    const count = Math.min(total, clampCap(cap));
    // Gmail pages ids 500 at a time; at least one list call is made.
    const units = GMAIL_UNIT_COSTS.messagesList * Math.max(1, Math.ceil(count / 500));
    return {
      value: { count, capped: total > count },
      ...(await this.spend("countIds", units, opts)),
    };
  }

  async changes(
    cursor: string | null,
    limit: number,
    opts: MailReadOptions = {},
  ): Promise<ReadValue<MailChanges>> {
    const account = this.source.account();
    const log = this.source.log();
    const now = this.source.now().getTime();
    const fresh = (revision: number) =>
      encodeCursor({
        account: account.id,
        kind: "changes",
        revision,
        at: now,
      } satisfies ChangeCursor);
    const value: MailChanges = {
      added: [],
      labelChanged: [],
      deleted: [],
      cursor: fresh(log.length),
    };
    if (cursor !== null) {
      const c = decodeCursor<ChangeCursor>(cursor);
      const valid =
        c.account === account.id &&
        c.kind === "changes" &&
        Number.isInteger(c.revision) &&
        c.revision >= 0 &&
        c.revision <= log.length;
      if (!valid) {
        throw new ProviderError("INVALID_CURSOR", "Change cursor does not belong to this mailbox");
      }
      if (now - c.at > MOCK_CHANGE_RETENTION_MS) {
        value.expired = true;
      } else {
        const { next, ...changes } = collectChanges(log, c.revision, Math.max(1, limit));
        Object.assign(value, changes, { cursor: fresh(next) });
      }
    }
    return { value, ...(await this.spend("changes", GMAIL_UNIT_COSTS.historyList, opts)) };
  }

  async findByRfc822(
    rfc822Id: string,
    opts: MailReadOptions = {},
  ): Promise<ReadValue<string | null>> {
    const account = this.source.account();
    const wanted = stripBrackets(rfc822Id).toLowerCase();
    const sent = mailHandleForFolder(account.id, "Sent");
    const candidates = [...this.source.emails()]
      .filter(
        (e) => e.headers.messageId && stripBrackets(e.headers.messageId).toLowerCase() === wanted,
      )
      // Duplicate Message-IDs (Sent and Inbox copies): prefer the received copy.
      .sort((a, b) => Number(a.mailboxIds.includes(sent)) - Number(b.mailboxIds.includes(sent)));
    const value = candidates[0]?.providerId ?? null;
    return { value, ...(await this.spend("findByRfc822", GMAIL_UNIT_COSTS.messagesList, opts)) };
  }

  /** Acquires units from the governor (when configured) and returns the result metadata. */
  private async spend(
    method: keyof MailReader,
    units: number,
    opts: MailReadOptions,
  ): Promise<{ source: "provider"; cost: ReadCost }> {
    const account = this.source.account();
    const lane = opts.lane ?? "interactive";
    const governor = this.source.governor;
    if (governor) {
      const lease = await governor.acquire(account.id, lane, units, {
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      lease.release();
    } else if (opts.signal?.aborted) {
      throw new ProviderError("ABORTED", "The read was cancelled");
    }
    this.costs.push({ method, gmailUnits: units, lane });
    return { source: "provider", cost: { gmailUnits: units, ...governor?.snapshot(account.id) } };
  }

  private labelsOf(email: MailEnvelope): MatchLabel[] {
    const prefix = mailHandleForFolder(email.accountId, "");
    return email.mailboxIds
      .filter((id) => id.startsWith(prefix))
      .map((id) => {
        const name = decodeURIComponent(id.slice(prefix.length));
        return { name, role: folderRoles[name] ?? null };
      });
  }

  private row(email: Email): MailRow {
    const prefix = mailHandleForFolder(email.accountId, "");
    return toMailRow(email, (id) =>
      id.startsWith(prefix) ? decodeURIComponent(id.slice(prefix.length)) : null,
    );
  }

  /** Resolves a container (folder id, display name, role, or mailbox handle) to a folder name. */
  private folder(container: string): string {
    const account = this.source.account();
    const wanted = container.startsWith(mailHandleForFolder(account.id, ""))
      ? decodeURIComponent(container.slice(mailHandleForFolder(account.id, "").length))
      : container;
    const lower = wanted.toLowerCase();
    const found = this.source
      .folders()
      .find((name) => name.toLowerCase() === lower || folderRoles[name] === lower);
    if (!found) {
      throw new ProviderError("NOT_FOUND", "Label or folder does not exist");
    }
    return found;
  }

  /** Matching emails, newest first, with Spam/Trash excluded unless asked for. */
  private match(ast: QueryAst, scope: Scope): Email[] {
    const account = this.source.account();
    const folder = scope.container ? this.folder(scope.container) : null;
    const folderId = folder ? mailHandleForFolder(account.id, folder) : null;
    const hideSpamTrash = !scope.includeSpamTrash && !queryScopesSpamTrash(ast) && !folder;
    const ctx = { now: this.source.now(), labels: (e: MailEnvelope) => this.labelsOf(e) };
    return [...this.source.emails()]
      .filter((email) => {
        if (folderId && !email.mailboxIds.includes(folderId)) {
          return false;
        }
        const hidden = this.labelsOf(email).some((l) => l.role === "trash" || l.role === "junk");
        if (hideSpamTrash && hidden) {
          return false;
        }
        return matchesQuery(ast, email, ctx);
      })
      .sort(
        (a, b) =>
          b.receivedAt.localeCompare(a.receivedAt) || b.providerId.localeCompare(a.providerId),
      );
  }
}
