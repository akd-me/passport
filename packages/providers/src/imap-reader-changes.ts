import type { MailChanges } from "@passport/types";
import type { FetchMessageObject } from "imapflow";
import { decodeCursor, encodeCursor, ProviderError } from "./errors.js";
import { imapIdentity } from "./imap-reader-shared.js";
import {
  type ImapSession,
  MAX_PACKED_UIDS,
  missingUids,
  packUids,
  parseUidSet,
  type SelectedBox,
  uidSetSize,
} from "./imap-reader-support.js";

/** Without QRESYNC, deletions are found by diffing the UID list at most this often. */
export const IMAP_DELETE_SWEEP_MS = 5 * 60_000;
/** More deletions than this in one sweep expire the cursor instead of listing them. */
const MAX_SWEEP_DELETIONS = 5_000;
/** The watched mailbox. Other folders are read on demand. */
const WATCHED = "INBOX";

interface ChangeCursor {
  account: string;
  kind: "imap-changes";
  path: string;
  validity: string;
  uidNext: number;
  /** HIGHESTMODSEQ (CONDSTORE), as a decimal string. */
  modseq?: string;
  /**
   * Known UIDs below `uidNext` as a sequence set, kept only without QRESYNC (for the deletion
   * sweep) and only while it packs into `MAX_PACKED_UIDS` characters (R1-3, R1-5).
   */
  uids?: string;
  /**
   * Instead of `uids` for fragmented mailboxes: how many UIDs below `uidNext` existed. UIDs are
   * never reused, so a smaller count at the next sweep means something was deleted; the cursor
   * then expires (labels stale, bounded sweep) because the ids are unknown.
   */
  count?: number;
  /** When the UID list was last diffed (epoch ms). */
  sweptAt?: number;
}

interface Entry {
  uid: number;
  modseq: bigint;
  added: boolean;
}

/** `UID FETCH 1:* (UID FLAGS) (CHANGEDSINCE m VANISHED)`; VANISHED arrives as expunge events. */
async function changedSince(session: ImapSession, modseq: bigint) {
  const client = session.client;
  const vanished: number[] = [];
  const onExpunge = (event: { path?: string; uid?: number; vanished?: boolean }) => {
    if (event.vanished && event.uid && (!event.path || event.path === WATCHED)) {
      vanished.push(event.uid);
    }
  };
  session.commands++;
  client.on("expunge", onExpunge);
  const messages: FetchMessageObject[] = [];
  try {
    for await (const m of client.fetch(
      "1:*",
      { uid: true, flags: true },
      { uid: true, changedSince: modseq },
    )) {
      messages.push(m);
    }
  } finally {
    client.off("expunge", onExpunge);
  }
  return { messages, vanished };
}

/**
 * Takes entries in modseq order up to `budget`, never splitting a modseq group, so the cursor can
 * resume at the last included modseq without skipping or repeating changes.
 */
function takeByModseq(entries: Entry[], budget: number): { taken: Entry[]; resumeAt?: bigint } {
  const sorted = [...entries].sort((a, b) =>
    a.modseq < b.modseq ? -1 : a.modseq > b.modseq ? 1 : 0,
  );
  if (sorted.length <= budget) {
    return { taken: sorted };
  }
  let end = budget;
  while (end > 0 && sorted[end - 1]?.modseq === sorted[end]?.modseq) {
    end--;
  }
  if (end === 0) {
    const first = sorted[0]?.modseq;
    end = sorted.findIndex((e) => e.modseq !== first);
  }
  const taken = sorted.slice(0, end);
  return { taken, resumeAt: taken[taken.length - 1]?.modseq ?? 0n };
}

type CursorState = Omit<ChangeCursor, "account" | "kind" | "path" | "validity">;

/** One change step: what the server reported and the cursor state after the included part. */
interface Step {
  deleted: number[];
  entries: Entry[];
  taken: Entry[];
  next: CursorState;
}

/** CONDSTORE: everything with a higher modseq; QRESYNC adds expunged UIDs. */
async function modseqStep(
  session: ImapSession,
  c: ChangeCursor,
  box: SelectedBox,
  budget: number,
): Promise<Step> {
  const changed = await changedSince(session, BigInt(c.modseq ?? 0));
  const entries = changed.messages.map((m) => ({
    uid: m.uid,
    modseq: m.modseq ?? 0n,
    added: m.uid >= c.uidNext,
  }));
  const page = takeByModseq(entries, Math.max(1, budget - changed.vanished.length));
  return {
    deleted: changed.vanished,
    entries,
    taken: page.taken,
    next:
      page.resumeAt === undefined
        ? { uidNext: box.uidNext, modseq: String(box.modseq) }
        : { uidNext: c.uidNext, modseq: String(page.resumeAt) },
  };
}

/** Without CONDSTORE: arrivals are UIDs at or above the cursor's UIDNEXT. */
async function uidNextStep(
  session: ImapSession,
  c: ChangeCursor,
  box: SelectedBox,
  budget: number,
  condstore: boolean,
): Promise<Step> {
  session.commands++;
  const found = await session.client.search({ uid: `${c.uidNext}:*` }, { uid: true });
  const entries = (Array.isArray(found) ? found : [])
    .filter((uid) => uid >= c.uidNext)
    .sort((a, b) => a - b)
    .map((uid) => ({ uid, modseq: 0n, added: true }));
  const taken = entries.slice(0, budget);
  const last = taken[taken.length - 1];
  return {
    deleted: [],
    entries,
    taken,
    next: {
      uidNext: taken.length < entries.length && last ? last.uid + 1 : box.uidNext,
      ...(condstore ? { modseq: String(box.modseq) } : {}),
    },
  };
}

/** The compact known-UID snapshot for a cursor: the packed set when it fits, else its size. */
function snapshot(uids: number[]): Pick<ChangeCursor, "uids" | "count"> {
  const packed = packUids(uids);
  return packed.length <= MAX_PACKED_UIDS ? { uids: packed } : { count: uids.length };
}

/**
 * Without QRESYNC: diff the known UIDs every `IMAP_DELETE_SWEEP_MS`. Returns false when
 * deletions happened that the cursor cannot name (count-only snapshot, or too many).
 */
async function sweepDeleted(
  session: ImapSession,
  c: ChangeCursor,
  step: Step,
  now: number,
): Promise<boolean> {
  const known = c.uids === undefined ? null : parseUidSet(c.uids, c.uidNext);
  const arrivals = step.taken
    .filter((e) => e.added && e.uid < step.next.uidNext)
    .map((e) => e.uid)
    .sort((a, b) => a - b);
  if (now - (c.sweptAt ?? 0) < IMAP_DELETE_SWEEP_MS) {
    // Not due: extend the snapshot with this step's arrivals (all above the known set).
    const packed = known && [c.uids, packUids(arrivals)].filter(Boolean).join(",");
    const fits = packed !== null && packed.length <= MAX_PACKED_UIDS;
    const size = known ? uidSetSize(known) : c.count;
    step.next = {
      ...step.next,
      ...(fits ? { uids: packed } : size !== undefined ? { count: size + arrivals.length } : {}),
      sweptAt: c.sweptAt ?? now,
    };
    return true;
  }
  const current = (await session.uids({ query: {} }))
    .filter((uid) => uid < c.uidNext)
    .sort((a, b) => a - b);
  if (known) {
    const gone = missingUids(known, current, MAX_SWEEP_DELETIONS);
    if (gone === null) {
      return false;
    }
    step.deleted.push(...gone);
  } else if (c.count !== undefined && current.length < c.count) {
    return false;
  }
  step.next = { ...step.next, ...snapshot([...current, ...arrivals]), sweptAt: now };
  return true;
}

/** Validates a decoded cursor's fields; anything off is `INVALID_CURSOR` (R1-3). */
function validCursor(c: ChangeCursor): boolean {
  const uidNext = c.uidNext;
  return (
    Number.isInteger(uidNext) &&
    uidNext >= 1 &&
    uidNext < 2 ** 32 &&
    typeof c.validity === "string" &&
    (c.modseq === undefined || /^\d{1,20}$/.test(String(c.modseq))) &&
    (c.sweptAt === undefined || Number.isFinite(c.sweptAt)) &&
    (c.count === undefined || (Number.isInteger(c.count) && c.count >= 0 && c.count < uidNext)) &&
    (c.uids === undefined || (typeof c.uids === "string" && c.uids.length <= MAX_PACKED_UIDS))
  );
}

/**
 * Changes in INBOX since `cursor`: CONDSTORE `CHANGEDSINCE` (+ QRESYNC `VANISHED`) when available,
 * otherwise a UIDNEXT diff for arrivals and a periodic UID-list diff for deletions (flag changes
 * are invisible without CONDSTORE). `null` starts at "now". A UIDVALIDITY change expires the
 * cursor. Deletions are always reported in full; arrivals and flag changes share `limit`.
 */
export async function imapChanges(
  session: ImapSession,
  accountId: string,
  cursor: string | null,
  limit: number,
  now: number,
): Promise<MailChanges> {
  const qresync = session.ext.has("QRESYNC");
  return session.select(WATCHED, async (box) => {
    const condstore = session.ext.has("CONDSTORE") && box.modseq !== undefined;
    const id = (uid: number) => imapIdentity(box.path, box.validity, uid);
    const encode = (state: CursorState) =>
      encodeCursor({
        account: accountId,
        kind: "imap-changes",
        path: box.path,
        validity: box.validity,
        ...state,
      } satisfies ChangeCursor);
    const fresh = async () =>
      encode({
        uidNext: box.uidNext,
        ...(condstore ? { modseq: String(box.modseq) } : {}),
        ...(qresync ? {} : { ...snapshot(await session.uids({ query: {} })), sweptAt: now }),
      });
    const empty = { added: [], labelChanged: [], deleted: [] };
    if (cursor === null) {
      return { ...empty, cursor: await fresh() };
    }
    const c = decodeCursor<ChangeCursor>(cursor);
    if (
      c.account !== accountId ||
      c.kind !== "imap-changes" ||
      c.path !== box.path ||
      !validCursor(c)
    ) {
      throw new ProviderError("INVALID_CURSOR", "Change cursor does not belong to this mailbox");
    }
    if (c.validity !== box.validity) {
      return { ...empty, cursor: await fresh(), expired: true };
    }
    if (c.uids !== undefined) {
      // Parse (bounded) before any command so a malformed set fails as INVALID_CURSOR.
      parseUidSet(c.uids, c.uidNext);
    }
    const budget = Math.max(1, Math.floor(limit));
    const step =
      condstore && c.modseq !== undefined
        ? await modseqStep(session, c, box, budget)
        : await uidNextStep(session, c, box, budget, condstore);
    if (!qresync && !(await sweepDeleted(session, c, step, now))) {
      return { ...empty, cursor: await fresh(), expired: true };
    }
    const value: MailChanges = {
      added: step.taken.filter((e) => e.added).map((e) => id(e.uid)),
      labelChanged: step.taken.filter((e) => !e.added).map((e) => id(e.uid)),
      deleted: [...new Set(step.deleted)].map(id),
      cursor: encode(step.next),
    };
    if (step.taken.length < step.entries.length) {
      value.hasMore = true;
    }
    return value;
  });
}
