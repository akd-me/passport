import type { MailEnvelope, MailRow } from "@passport/types";
import { ProviderError } from "./errors.js";
import type { ImapMailboxes } from "./imap-reader-mailboxes.js";
import { type ImapRowRecord, imapRecord, imapRowQuery } from "./imap-reader-rows.js";
import type { ImapCriteria, ImapSession } from "./imap-reader-support.js";
import type { QueryNode } from "./query.js";
import { type MatchLabel, matchesQuery } from "./query-match.js";
import { openToken, sealToken } from "./reader-tokens.js";
import type { PassportVerifier } from "./verification.js";

/** Newest candidates per mailbox scanned when a query needs local evaluation (research §5.6). */
export const IMAP_SCAN_CAP = 500;

export type { ImapReaderHost } from "./imap-reader-mailboxes.js";
export { ImapMailboxes } from "./imap-reader-mailboxes.js";

const MAX_LIMIT = 100;

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

/**
 * Sealed page token (R1-10). Pages are anchored on UIDs, not offsets: each mailbox keeps the
 * highest UID it had on the first page (later arrivals wait for a new search) and the last UID
 * consumed from its newest-first list; local-filter scans resume strictly after the last row.
 */
interface PageToken {
  account: string;
  kind: "search" | "list";
  key: string;
  /** `[path, uidvalidity, maxUid, lastUid]` of every mailbox searched; `lastUid` 0 = none yet. */
  boxes: Array<[string, string, number, number]>;
  /** Local-filter scans: the last row returned, in `byNewest` order. */
  after?: [receivedAt: string, uid: number, path: string];
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
  b.envelope.receivedAt.localeCompare(a.envelope.receivedAt) ||
  b.uid - a.uid ||
  b.path.localeCompare(a.path);

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
  const c = openToken<PageToken>(token);
  if (
    c.account !== accountId ||
    c.kind !== req.kind ||
    c.key !== req.key ||
    !Array.isArray(c.boxes) ||
    !c.boxes.every((b) => Array.isArray(b) && Number.isInteger(b[2]) && Number.isInteger(b[3]))
  ) {
    throw new ProviderError("INVALID_CURSOR", "Page token belongs to a different query");
  }
  return c;
}

/** Position after `last` in a newest-first UID list (or after where it was, if expunged). */
function after(uids: readonly number[], last: number): number {
  if (last === 0) {
    return 0;
  }
  const at = uids.indexOf(last);
  if (at >= 0) {
    return at + 1;
  }
  const older = uids.findIndex((uid) => uid < last);
  return older < 0 ? uids.length : older;
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
 * Runs a search or list: `UID SORT`/`UID SEARCH` per mailbox, then pages along the UID lists and
 * hydrates only the page. Local filters (and `threads`) scan the newest `IMAP_SCAN_CAP`
 * candidates per mailbox instead.
 */
export async function scan(ctx: ImapScanContext, req: ImapScanRequest): Promise<ImapScanResult> {
  const token = req.pageToken ? decodePage(req.pageToken, ctx.accountId, req) : null;
  const size = Math.min(MAX_LIMIT, Math.max(1, Math.floor(req.limit)));
  const hits: BoxHits[] = [];
  const state = new Map<string, { maxUid: number; last: number }>();
  for (const path of req.boxes) {
    await ctx.session.select(path, async (box) => {
      const pinned = token?.boxes.find(([p]) => p === path);
      if (token && pinned?.[1] !== box.validity) {
        throw new ProviderError(
          "INVALID_CURSOR",
          "Mailbox changed since the first page; search again",
        );
      }
      let uids = await ctx.session.uids(req.criteria);
      const maxUid = pinned ? pinned[2] : uids.reduce((max, uid) => Math.max(max, uid), 0);
      // Mail that arrived after the first page waits for a new search (R1-10).
      uids = uids.filter((uid) => uid <= maxUid);
      state.set(path, { maxUid, last: pinned?.[3] ?? 0 });
      hits.push({ path, validity: box.validity, uids });
    });
  }
  let page: ImapRowRecord[];
  let total: number;
  let more: boolean;
  let anchor: PageToken["after"];
  const extra: Pick<ImapScanResult, "scanned" | "capped"> = {};
  if (req.local.length > 0 || req.threads) {
    const local = await scanLocally(ctx, req, hits);
    total = local.list.length;
    const from = token?.after;
    const start = from
      ? local.list.findIndex(
          (r) =>
            byNewest(r, {
              uid: from[1],
              path: from[2],
              envelope: { receivedAt: from[0] },
            } as ImapRowRecord) > 0,
        )
      : 0;
    const rest = start < 0 ? [] : local.list.slice(start);
    page = rest.slice(0, size);
    more = rest.length > page.length;
    const last = page.at(-1);
    anchor = last ? [last.envelope.receivedAt, last.uid, last.path] : undefined;
    Object.assign(extra, { scanned: local.scanned, capped: local.capped });
  } else {
    total = hits.reduce((sum, h) => sum + h.uids.length, 0);
    // Each mailbox's remaining list, after the last UID consumed from it.
    const rest = hits.map((hit) => ({
      ...hit,
      uids: hit.uids.slice(after(hit.uids, state.get(hit.path)?.last ?? 0)),
    }));
    const taken = new Map<string, number[]>();
    if (rest.length === 1 && rest[0]) {
      taken.set(rest[0].path, rest[0].uids.slice(0, size));
    } else {
      // Merge by INTERNALDATE, then take a prefix of each mailbox's list so nothing is skipped.
      const heads = (await mergeByDate(ctx, rest, size)).slice(0, size);
      for (const hit of rest) {
        taken.set(hit.path, hit.uids.slice(0, heads.filter((h) => h.hit === hit).length));
      }
    }
    page = [];
    for (const hit of rest) {
      const uids = taken.get(hit.path) ?? [];
      page.push(...(await hydrate(ctx, hit.path, hit.validity, uids)));
      const last = uids.at(-1);
      if (last !== undefined) {
        (state.get(hit.path) as { last: number }).last = last;
      }
    }
    if (rest.length > 1) {
      page.sort(byNewest);
    }
    more = rest.some((hit) => hit.uids.length > (taken.get(hit.path)?.length ?? 0));
  }
  const result: ImapScanResult = { items: page.map((r) => r.row), approxTotal: total, ...extra };
  // A page whose rows were all expunged meanwhile still advances the anchors.
  if (more) {
    result.nextPageToken = sealToken({
      account: ctx.accountId,
      kind: req.kind,
      key: req.key,
      boxes: hits.map((h) => {
        const s = state.get(h.path);
        return [h.path, h.validity, s?.maxUid ?? 0, s?.last ?? 0];
      }),
      ...(anchor ? { after: anchor } : {}),
    } satisfies PageToken);
  }
  return result;
}
