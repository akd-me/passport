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
  ReadCost,
  ReadResult,
  ReadValue,
} from "@passport/types";
import { ProviderError } from "./errors.js";
import { fetchImapAttachment } from "./imap-reader-attachments.js";
import { imapChanges } from "./imap-reader-changes.js";
import { withoutText } from "./imap-reader-rows.js";
import {
  hydrate,
  IMAP_SCAN_CAP,
  ImapMailboxes,
  type ImapReaderHost,
  type ImapScanContext,
  type ImapScanResult,
  scan,
} from "./imap-reader-scan.js";
import { imapIdentity, imapRole, parseImapIdentity } from "./imap-reader-shared.js";
import { type ImapCriteria, ImapSession } from "./imap-reader-support.js";
import {
  fetchImapEmail,
  fetchImapThread,
  findImapByRfc822,
  type ImapBodyContext,
} from "./imap-reader-thread.js";
import { parsePortableQuery } from "./query.js";
import { type ImapQueryPlan, listFilterToAst, renderImapQuery } from "./query-render.js";
import { clampCap } from "./reader-limits.js";

export type { ImapReaderHost } from "./imap-reader-scan.js";

interface Scope {
  boxes: string[];
  criteria: ImapCriteria;
  local: ImapQueryPlan["localFilter"];
  translation: string;
}

/**
 * `MailReader` over IMAP (research 03 §1.5, §5.3, §5.6). Adapts to the extensions probed on
 * connect: `UID SORT` for newest-first, `ESEARCH RETURN (COUNT)`, CONDSTORE/QRESYNC for
 * changes, `X-GM-RAW` / `X-GM-THRID` on Gmail and `THREADID` with OBJECTID. Every call holds one
 * governor lease (IMAP is one pipeline per connection) and reports `cost.imapCommands`.
 */
export class ImapMailReader implements MailReader {
  private readonly mailboxes: ImapMailboxes;
  constructor(private readonly host: ImapReaderHost) {
    this.mailboxes = new ImapMailboxes(host);
  }

  async search(input: MailSearchInput, opts: MailReadOptions = {}): Promise<ReadResult<MailRow>> {
    if (input.query !== undefined && input.rawQuery !== undefined) {
      throw new ProviderError("INVALID_QUERY", "Supply query or rawQuery, not both");
    }
    return this.call(opts, async (session) => {
      const scope = await this.scope(session, input.query, input.rawQuery, {
        container: input.container,
        includeSpamTrash: input.includeSpamTrash,
      });
      const key = JSON.stringify([
        input.query ?? null,
        input.rawQuery ?? null,
        input.container ?? null,
        Boolean(input.includeSpamTrash),
        Boolean(input.threads),
      ]);
      const result = await scan(this.context(session), {
        ...scope,
        threads: Boolean(input.threads),
        kind: "search",
        key,
        limit: input.limit,
        pageToken: input.pageToken,
      });
      return this.page(session, result, scope.translation);
    });
  }

  async list(
    container: string | null,
    filter: MailListFilter,
    limit: number,
    pageToken?: string,
    opts: MailReadOptions = {},
  ): Promise<ReadResult<MailRow>> {
    return this.call(opts, async (session) => {
      const plan = this.plan(listFilterToAst(filter));
      const boxes = container ? [container] : this.defaultBoxes(false);
      const scope = {
        boxes: await this.mailboxes.resolveAll(session, boxes),
        criteria: { query: plan.criteria },
        local: plan.localFilter,
        translation: plan.translation,
      };
      const key = JSON.stringify([container, filter]);
      const result = await scan(this.context(session), {
        ...scope,
        threads: false,
        kind: "list",
        key,
        limit,
        pageToken,
      });
      return this.page(session, result, scope.translation);
    });
  }

  async labels(counts = false, opts: MailReadOptions = {}): Promise<ReadResult<MailLabel>> {
    return this.call(opts, async (session) => {
      const folders = await this.mailboxes.list(session, true);
      const items: MailLabel[] = [];
      for (const folder of folders) {
        const label: MailLabel = {
          id: folder.path,
          name: folder.name || folder.path,
          role: imapRole(folder),
          parentId: folder.parentPath || null,
        };
        if (counts && !folder.flags.has("\\Noselect")) {
          session.commands++;
          const status = await session.client.status(folder.path, { messages: true, unseen: true });
          label.counts = {
            total: status ? (status.messages ?? 0) : 0,
            unread: status ? (status.unseen ?? 0) : 0,
          };
        }
        items.push(label);
      }
      return { items };
    });
  }

  async envelopes(
    providerIds: string[],
    opts: MailReadOptions = {},
  ): Promise<ReadValue<Map<string, MailEnvelope | null>>> {
    return this.call(opts, async (session) => {
      const value = new Map<string, MailEnvelope | null>(providerIds.map((id) => [id, null]));
      const groups = new Map<string, { validity: string; uids: Map<number, string> }>();
      for (const id of providerIds) {
        const parsed = this.parse(id);
        if (!parsed) {
          continue;
        }
        const [path, validity, uid] = parsed;
        const key = `${path}\n${validity}`;
        const group = groups.get(key) ?? { validity, uids: new Map() };
        group.uids.set(uid, id);
        groups.set(key, group);
      }
      await this.mailboxes.list(session);
      const context = this.context(session);
      for (const [key, group] of groups) {
        const path = key.slice(0, key.lastIndexOf("\n"));
        const valid = await session.select(path, async (box) => box.validity === group.validity);
        if (!valid) {
          continue;
        }
        for (const record of await hydrate(context, path, group.validity, [...group.uids.keys()])) {
          value.set(group.uids.get(record.uid) as string, withoutText(record.envelope));
        }
      }
      return { value };
    });
  }

  async thread(
    threadProviderId: string,
    opts: { format: "text" | "html" } & MailReadOptions,
  ): Promise<ReadValue<Email[]>> {
    return this.call(opts, async (session) => {
      const emails = await fetchImapThread(
        this.bodyContext(session),
        this.mailboxes,
        threadProviderId,
        this.gmail(),
      );
      if (emails.length === 0) {
        throw new ProviderError("NOT_FOUND", "Thread does not exist");
      }
      emails.sort(
        (a, b) =>
          a.receivedAt.localeCompare(b.receivedAt) || a.providerId.localeCompare(b.providerId),
      );
      const value = opts.format === "text" ? emails.map((e) => ({ ...e, htmlBody: null })) : emails;
      return { value };
    });
  }

  async body(providerId: string, opts: MailReadOptions = {}): Promise<ReadValue<MailBody>> {
    return this.call(opts, async (session) => {
      const email = await fetchImapEmail(this.bodyContext(session), providerId);
      return {
        value: {
          textBody: email.textBody ?? null,
          htmlBody: email.htmlBody ?? null,
          attachments: email.attachments,
        },
      };
    });
  }

  /** `UID FETCH (BODYSTRUCTURE)` then `BODY.PEEK[<part>]` (2 commands plus SELECT). */
  async attachment(
    providerId: string,
    attachmentRef: MailAttachmentRef,
    opts: MailReadOptions = {},
  ): Promise<ReadValue<MailAttachmentData>> {
    return this.call(opts, async (session) => ({
      value: await fetchImapAttachment(this.bodyContext(session), providerId, attachmentRef),
    }));
  }

  // No `rawGet`: IMAP has no REST surface and raw commands cannot be confined to reads.

  async countIds(
    query: string,
    cap: number,
    opts: MailCountOptions = {},
  ): Promise<ReadValue<{ count: number; capped: boolean }>> {
    return this.call(opts, async (session) => {
      const scope = await this.scope(
        session,
        opts.raw ? undefined : query,
        opts.raw ? query : undefined,
        { includeSpamTrash: opts.includeSpamTrash },
      );
      const limit = clampCap(cap);
      let total: number;
      let truncated = false;
      let scanned: ImapScanResult | undefined;
      if (scope.local.length > 0) {
        // Count locally over the scanned candidates; `capped` reports the scan cap too.
        const result = await scan(this.context(session), {
          ...scope,
          threads: false,
          kind: "search",
          key: query,
          limit: 1,
        });
        total = result.approxTotal;
        truncated = Boolean(result.capped);
        scanned = result;
      } else {
        total = 0;
        for (const path of scope.boxes) {
          total += await session.select(path, () => session.count(scope.criteria));
        }
      }
      const count = Math.min(total, limit);
      return {
        value: { count, capped: total > count || truncated },
        translation: this.translation(session, scope.translation, scanned),
      };
    });
  }

  async changes(
    cursor: string | null,
    limit: number,
    opts: MailReadOptions = {},
  ): Promise<ReadValue<MailChanges>> {
    return this.call(opts, async (session) => ({
      value: await imapChanges(
        session,
        this.host.account().id,
        cursor,
        limit,
        this.now().getTime(),
      ),
    }));
  }

  async findByRfc822(
    rfc822Id: string,
    opts: MailReadOptions = {},
  ): Promise<ReadValue<string | null>> {
    return this.call(opts, async (session) => {
      return { value: await findImapByRfc822(session, this.mailboxes, this.host, rfc822Id) };
    });
  }

  // -------------------------------------------------------------------------

  private now(): Date {
    return this.host.options.now?.() ?? new Date();
  }

  private gmail(): boolean {
    return this.host.extensions().has("X-GM-EXT-1");
  }

  private plan(ast: ReturnType<typeof parsePortableQuery>): ImapQueryPlan {
    return renderImapQuery(ast, { gmail: this.gmail(), now: this.now() });
  }

  /** INBOX by default (Gmail: All Mail), plus Spam and Trash when asked for. */
  private defaultBoxes(includeSpamTrash: boolean): string[] {
    const base = this.gmail() ? ["\\All"] : ["INBOX"];
    return includeSpamTrash ? [...base, "\\Junk", "\\Trash"] : base;
  }

  /** Mailboxes, criteria and local filter for a portable or raw query. */
  private async scope(
    session: ImapSession,
    query: string | undefined,
    rawQuery: string | undefined,
    options: { container?: string | undefined; includeSpamTrash?: boolean | undefined },
  ): Promise<Scope> {
    const spamTrash = Boolean(options.includeSpamTrash);
    if (rawQuery !== undefined) {
      const criteria: ImapCriteria = this.gmail()
        ? { query: { gmraw: rawQuery } }
        : { raw: rawQuery };
      const boxes = options.container ? [options.container] : this.defaultBoxes(spamTrash);
      return {
        boxes: await this.mailboxes.resolveAll(session, boxes),
        criteria,
        local: [],
        translation: this.gmail() ? "imap:X-GM-RAW(raw)" : "imap:SEARCH(raw)",
      };
    }
    const ast = parsePortableQuery(query ?? "");
    const plan = this.plan(ast);
    // An explicit `in:` wins over includeSpamTrash, as on Gmail.
    const boxes = options.container
      ? [options.container]
      : plan.mailboxes.length > 0
        ? plan.mailboxes
        : this.defaultBoxes(spamTrash);
    return {
      boxes: await this.mailboxes.resolveAll(session, boxes),
      criteria: { query: plan.criteria },
      local: plan.localFilter,
      translation: plan.translation,
    };
  }

  private context(session: ImapSession): ImapScanContext {
    return {
      session,
      mailboxes: this.mailboxes,
      accountId: this.host.account().id,
      verifier: this.host.options.verifier,
      now: this.now(),
    };
  }

  private bodyContext(session: ImapSession): ImapBodyContext {
    return { session, accountId: this.host.account().id, verifier: this.host.options.verifier };
  }

  /** `imap:SORT+localGrep; caps=…; scanned=500 capped`: what ran, shown to agents verbatim. */
  private translation(session: ImapSession, base: string, result?: ImapScanResult): string {
    const ext = [...session.ext].sort();
    const sorted = session.ext.has("SORT") ? base.replace("imap:SEARCH", "imap:SORT") : base;
    const parts = [sorted, `caps=${ext.length ? ext.join(",") : "none"}`];
    if (result?.scanned !== undefined) {
      parts.push(
        `scanned=${result.scanned}${result.capped ? ` capped(${IMAP_SCAN_CAP}/mailbox)` : ""}`,
      );
    }
    return parts.join("; ");
  }

  private page(session: ImapSession, result: ImapScanResult, base: string) {
    return {
      items: result.items,
      approxTotal: result.approxTotal,
      ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
      translation: this.translation(session, base, result),
    };
  }

  /** Parses a provider id; null for ids that are not IMAP identities. */
  private parse(providerId: string): [string, string, number] | null {
    try {
      return parseImapIdentity(providerId);
    } catch {
      // Not an IMAP identity: report it as missing rather than failing the whole batch.
      return null;
    }
  }

  /** One governor lease per call (IMAP is a single pipeline), then `source` and `cost`. */
  private async call<R extends object>(
    opts: MailReadOptions,
    fn: (session: ImapSession) => Promise<R>,
  ): Promise<R & { source: "provider"; cost: ReadCost }> {
    const account = this.host.account();
    const governor = this.host.options.governor;
    const lease = governor
      ? await governor.acquire(account.id, opts.lane ?? "interactive", 1, {
          ...(opts.signal ? { signal: opts.signal } : {}),
        })
      : undefined;
    if (!lease && opts.signal?.aborted) {
      throw new ProviderError("ABORTED", "The read was cancelled");
    }
    const session = new ImapSession(this.host.client(), this.host.extensions());
    try {
      const result = await fn(session);
      return {
        ...result,
        source: "provider",
        cost: { imapCommands: session.commands, ...governor?.snapshot(account.id) },
      };
    } catch (e) {
      // Library errors can carry server text; surface only stable codes.
      if (e instanceof ProviderError) {
        throw e;
      }
      throw new ProviderError("IMAP_ERROR", "IMAP read failed");
    } finally {
      lease?.release();
    }
  }
}
