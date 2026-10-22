import type { MailChanges } from "@passport/types";
import type { FetchMessageObject } from "imapflow";
import { decodeCursor, encodeCursor, ProviderError } from "./errors.js";
import { imapIdentity } from "./imap-reader-shared.js";
import { type ImapSession, packUids, type SelectedBox, unpackUids } from "./imap-reader-support.js";

/** Without QRESYNC, deletions are found by diffing the UID list at most this often. */
export const IMAP_DELETE_SWEEP_MS = 5 * 60_000;
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
  /** Known UIDs as a sequence set, kept only without QRESYNC (for the deletion sweep). */
  uids?: string;
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

/** Without QRESYNC: diff the known UID list every `IMAP_DELETE_SWEEP_MS`. */
async function sweepDeleted(session: ImapSession, c: ChangeCursor, step: Step, now: number) {
  let known = new Set(unpackUids(c.uids ?? ""));
  let sweptAt = c.sweptAt ?? 0;
  if (now - sweptAt >= IMAP_DELETE_SWEEP_MS) {
    const current = new Set(await session.uids({ query: {} }));
    step.deleted.push(...[...known].filter((uid) => !current.has(uid)));
    known = new Set([...current].filter((uid) => uid < c.uidNext));
    sweptAt = now;
  }
  for (const entry of step.taken) {
    if (entry.added) {
      known.add(entry.uid);
    }
  }
  step.next = { ...step.next, uids: packUids(known), sweptAt };
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
        ...(qresync ? {} : { uids: packUids(await session.uids({ query: {} })), sweptAt: now }),
      });
    const empty = { added: [], labelChanged: [], deleted: [] };
    if (cursor === null) {
      return { ...empty, cursor: await fresh() };
    }
    const c = decodeCursor<ChangeCursor>(cursor);
    if (c.account !== accountId || c.kind !== "imap-changes" || c.path !== box.path) {
      throw new ProviderError("INVALID_CURSOR", "Change cursor does not belong to this mailbox");
    }
    if (c.validity !== box.validity) {
      return { ...empty, cursor: await fresh(), expired: true };
    }
    const budget = Math.max(1, Math.floor(limit));
    const step =
      condstore && c.modseq !== undefined
        ? await modseqStep(session, c, box, budget)
        : await uidNextStep(session, c, box, budget, condstore);
    if (!qresync) {
      await sweepDeleted(session, c, step, now);
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
