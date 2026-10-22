import type { Account, MailboxRole, MailEnvelope, MailRow } from "@passport/types";
import type { ImapFlow, ListResponse } from "imapflow";
import { decodeCursor, encodeCursor, ProviderError } from "./errors.js";
import { type ImapRowRecord, imapRecord, imapRowQuery } from "./imap-reader-rows.js";
import { imapRole, imapRoles } from "./imap-reader-shared.js";
import type { ImapCriteria, ImapExtension, ImapSession } from "./imap-reader-support.js";
import type { QueryNode } from "./query.js";
import { type MatchLabel, matchesQuery } from "./query-match.js";
import type { QuotaGovernor } from "./quota.js";
import type { PassportVerifier } from "./verification.js";

/** Newest candidates per mailbox scanned when a query needs local evaluation (research §5.6). */
export const IMAP_SCAN_CAP = 500;
const MAX_LIMIT = 100;

/** What the reader needs from `ImapMailProvider`. */
export interface ImapReaderHost {
  /** The connected account; throws `NOT_CONNECTED` otherwise. */
  account(): Account;
  /** The live connection; throws when disconnected or failed. */
  client(): ImapFlow;
  /** Extensions probed on connect. */
  extensions(): ReadonlySet<ImapExtension>;
  /** Destinations of recent moves/copies (searched by `findByRfc822`). */
  moveTargets(): ReadonlySet<string>;
  options: { verifier?: PassportVerifier; governor?: QuotaGovernor; now?: () => Date };
}

/** LIST cache and container resolution (paths, SPECIAL-USE attributes, roles, handles). */
export class ImapMailboxes {
  private cache?: { client: ImapFlow; list: ListResponse[] };
  constructor(private readonly host: ImapReaderHost) {}

  /** `LIST "" *`, cached per connection unless `refresh`. */
  async list(session: ImapSession, refresh = false): Promise<ListResponse[]> {
    const client = this.host.client();
    if (refresh || this.cache?.client !== client) {
      session.commands++;
      this.cache = { client, list: await client.list() };
    }
    return this.cache.list;
  }

  /** Display name and role of a path, from the cached LIST. */
  describe(path: string): { name: string; role: MailboxRole } {
    const folder = this.cache?.list.find((f) => f.path === path);
    if (!folder) {
      return { name: path, role: path.toUpperCase() === "INBOX" ? "inbox" : null };
    }
    return { name: folder.name || folder.path, role: imapRole(folder) };
  }

  /**
   * Resolves a container to a path: a SPECIAL-USE attribute (`\Archive` falls back to `\All`), a
   * `<role>Folder` account setting, a role name (`"sent"`, `"spam"`), a path or name (any case),
   * or a mailbox handle. Null when nothing matches.
   */
  async resolve(session: ImapSession, spec: string): Promise<string | null> {
    const account = this.host.account();
    const prefix = `${account.id}:mailbox:`;
    const wanted = spec.startsWith(prefix) ? decodeURIComponent(spec.slice(prefix.length)) : spec;
    if (wanted.toUpperCase() === "INBOX" || wanted === "\\Inbox") {
      return "INBOX";
    }
    const list = (await this.list(session)).filter((f) => !f.flags.has("\\Noselect"));
    const lower = wanted.toLowerCase();
    const byPath = list.find(
      (f) => f.path.toLowerCase() === lower || f.name.toLowerCase() === lower,
    );
    if (byPath && !wanted.startsWith("\\")) {
      return byPath.path;
    }
    const attribute = wanted.startsWith("\\")
      ? wanted
      : Object.entries(imapRoles).find(
          ([, role]) => role === (lower === "spam" ? "junk" : lower),
        )?.[0];
    if (!attribute) {
      return null;
    }
    const role = imapRoles[attribute];
    const configured = role ? account.settings[`${role}Folder`] : undefined;
    if (typeof configured === "string" && configured) {
      return configured;
    }
    const fallbacks = attribute === "\\Archive" ? ["\\Archive", "\\All"] : [attribute];
    for (const use of fallbacks) {
      const found = list.find((f) => f.specialUse === use);
      if (found) {
        return found.path;
      }
    }
    return null;
  }

  /** Resolves several containers, dropping duplicates and symbolic ones the server lacks. */
  async resolveAll(session: ImapSession, specs: string[]): Promise<string[]> {
    const paths: string[] = [];
    for (const spec of specs) {
      const path = await this.resolve(session, spec);
      if (path === null && !spec.startsWith("\\")) {
        throw new ProviderError("NOT_FOUND", "Label or folder does not exist");
      }
      if (path !== null && !paths.includes(path)) {
        paths.push(path);
      }
    }
    if (paths.length === 0) {
      throw new ProviderError("NOT_FOUND", "Label or folder does not exist");
    }
    return paths;
  }
}

/** One scan: mailboxes to search, server criteria and the predicates evaluated locally. */
export interface ImapScanRequest {
  boxes: string[];
  criteria: ImapCriteria;
  local: QueryNode[];
  threads: boolean;
  kind: "search" | "list";
  /** Serialized query; a page token only works with the same key. */
  key: string;
  limit: number;
  pageToken?: string | undefined;
}

export interface ImapScanResult {
  items: MailRow[];
  nextPageToken?: string;
  approxTotal: number;
  /** Candidates evaluated locally, when a local filter ran. */
  scanned?: number;
  /** Some mailbox had more candidates than `IMAP_SCAN_CAP`. */
  capped?: boolean;
}

interface PageToken {
  account: string;
  kind: "search" | "list";
  key: string;
  offset: number;
  /** `[path, uidvalidity]` of every mailbox searched for the first page. */
  boxes: Array<[string, string]>;
}

interface BoxHits {
  path: string;
  validity: string;
  uids: number[];
}

export interface ImapScanContext {
  session: ImapSession;
  mailboxes: ImapMailboxes;
  accountId: string;
  verifier?: PassportVerifier | undefined;
  now: Date;
}

function containsText(node: QueryNode): boolean {
  switch (node.kind) {
    case "text":
      return true;
    case "and":
    case "or":
      return node.nodes.some(containsText);
    case "not":
      return containsText(node.node);
    default:
      return false;
  }
}

const byNewest = (a: ImapRowRecord, b: ImapRowRecord) =>
  b.envelope.receivedAt.localeCompare(a.envelope.receivedAt) || b.uid - a.uid;

/** Fetches rows for `uids` of one mailbox (one SELECT + one UID FETCH), in `uids` order. */
export async function hydrate(
  ctx: ImapScanContext,
  path: string,
  validity: string | null,
  uids: number[],
  grep = false,
): Promise<ImapRowRecord[]> {
  if (uids.length === 0) {
    return [];
  }
  const { session } = ctx;
  return session.select(path, async (box) => {
    if (validity !== null && box.validity !== validity) {
      throw new ProviderError("INVALID_CURSOR", "Mailbox UIDVALIDITY changed; search again");
    }
    const messages = await session.fetch(uids, imapRowQuery(session.ext, grep));
    const { name } = ctx.mailboxes.describe(path);
    const records = new Map<number, ImapRowRecord>();
    for (const message of messages) {
      records.set(
        message.uid,
        await imapRecord(message, {
          accountId: ctx.accountId,
          path,
          mailboxName: name,
          validity: box.validity,
          verifier: ctx.verifier,
        }),
      );
    }
    return uids.flatMap((uid) => records.get(uid) ?? []);
  });
}

function decodePage(token: string, accountId: string, req: ImapScanRequest): PageToken {
  const c = decodeCursor<PageToken>(token);
  if (
    c.account !== accountId ||
    c.kind !== req.kind ||
    c.key !== req.key ||
    !Number.isInteger(c.offset) ||
    c.offset < 0 ||
    !Array.isArray(c.boxes)
  ) {
    throw new ProviderError("INVALID_CURSOR", "Page token belongs to a different query");
  }
  return c;
}

/** Evaluates the local filter over the newest candidates of every mailbox. */
async function scanLocally(ctx: ImapScanContext, req: ImapScanRequest, hits: BoxHits[]) {
  const grep = req.local.some(containsText);
  const labels = new Map<MailEnvelope, MatchLabel[]>();
  const records: ImapRowRecord[] = [];
  let capped = false;
  for (const hit of hits) {
    capped ||= hit.uids.length > IMAP_SCAN_CAP;
    const found = await hydrate(
      ctx,
      hit.path,
      hit.validity,
      hit.uids.slice(0, IMAP_SCAN_CAP),
      grep,
    );
    const label = ctx.mailboxes.describe(hit.path);
    for (const record of found) {
      labels.set(record.envelope, [label]);
      records.push(record);
    }
  }
  const match = { now: ctx.now, labels: (e: MailEnvelope) => labels.get(e) ?? [] };
  const matched = records
    .filter((r) => req.local.every((node) => matchesQuery(node, r.envelope, match)))
    .sort(byNewest);
  const seen = new Set<string>();
  const list = req.threads
    ? matched.filter((r) => !seen.has(r.envelope.threadId) && seen.add(r.envelope.threadId))
    : matched;
  return { list, scanned: records.length, capped };
}

/** Newest-first rows across mailboxes, merged by INTERNALDATE (one extra FETCH per mailbox). */
async function mergeByDate(ctx: ImapScanContext, hits: BoxHits[], end: number) {
  const heads: Array<{ hit: BoxHits; uid: number; at: number }> = [];
  for (const hit of hits) {
    const head = hit.uids.slice(0, end);
    if (head.length === 0) {
      continue;
    }
    await ctx.session.select(hit.path, async () => {
      for (const m of await ctx.session.fetch(head, { uid: true, internalDate: true })) {
        heads.push({
          hit,
          uid: m.uid,
          at: m.internalDate ? new Date(m.internalDate).getTime() : 0,
        });
      }
    });
  }
  return heads.sort((a, b) => b.at - a.at || b.uid - a.uid);
}

/**
 * Runs a search or list: `UID SORT`/`UID SEARCH` per mailbox, then pages by slicing UIDs and
 * hydrates only the page. Local filters (and `threads`) scan the newest `IMAP_SCAN_CAP`
 * candidates per mailbox instead.
 */
export async function scan(ctx: ImapScanContext, req: ImapScanRequest): Promise<ImapScanResult> {
  const token = req.pageToken ? decodePage(req.pageToken, ctx.accountId, req) : null;
  const offset = token?.offset ?? 0;
  const size = Math.min(MAX_LIMIT, Math.max(1, Math.floor(req.limit)));
  const hits: BoxHits[] = [];
  for (const path of req.boxes) {
    await ctx.session.select(path, async (box) => {
      const pinned = token?.boxes.find(([p]) => p === path)?.[1];
      if (token && pinned !== box.validity) {
        throw new ProviderError(
          "INVALID_CURSOR",
          "Mailbox changed since the first page; search again",
        );
      }
      hits.push({ path, validity: box.validity, uids: await ctx.session.uids(req.criteria) });
    });
  }
  let page: ImapRowRecord[];
  let total: number;
  const extra: Pick<ImapScanResult, "scanned" | "capped"> = {};
  if (req.local.length > 0 || req.threads) {
    const local = await scanLocally(ctx, req, hits);
    total = local.list.length;
    page = local.list.slice(offset, offset + size);
    Object.assign(extra, { scanned: local.scanned, capped: local.capped });
  } else if (hits.length === 1 && hits[0]) {
    const hit = hits[0];
    total = hit.uids.length;
    page = await hydrate(ctx, hit.path, hit.validity, hit.uids.slice(offset, offset + size));
  } else {
    total = hits.reduce((sum, h) => sum + h.uids.length, 0);
    const heads = (await mergeByDate(ctx, hits, offset + size)).slice(offset, offset + size);
    const records = new Map<string, ImapRowRecord>();
    for (const hit of hits) {
      const uids = heads.filter((h) => h.hit === hit).map((h) => h.uid);
      for (const record of await hydrate(ctx, hit.path, hit.validity, uids)) {
        records.set(`${hit.path}\n${record.uid}`, record);
      }
    }
    page = heads.flatMap((h) => records.get(`${h.hit.path}\n${h.uid}`) ?? []);
  }
  const next = offset + page.length;
  const result: ImapScanResult = { items: page.map((r) => r.row), approxTotal: total, ...extra };
  if (page.length > 0 && next < total) {
    result.nextPageToken = encodeCursor({
      account: ctx.accountId,
      kind: req.kind,
      key: req.key,
      offset: next,
      boxes: hits.map((h) => [h.path, h.validity]),
    } satisfies PageToken);
  }
  return result;
}
