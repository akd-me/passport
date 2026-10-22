/**
 * Additive contract (v0.3): people and matters as agent-maintained notes. Re-exported from
 * `./index.ts`. See `docs/design/on-demand.md` §2 principle 5 and research report 03 §4.3.
 *
 * Each unit is split in two:
 *
 *  - **Security state** (structured, policy-owned). On `Person` these fields are read by the
 *    policy engine and the executor and MUST NOT be free text or be derived from message content:
 *    `relationship`, `verification`, `verifiedSelf`, `lastSeenBlueAt`, `downgradeAcknowledgedAt`
 *    and `stats` (see `PERSON_SECURITY_FIELDS`). Their write rules are unchanged.
 *  - **Knowledge** (markdown, agent-owned). `Person.notes`, `Matter.notes`, `Matter.refs` and
 *    `Matter.watch` are not policy-relevant. Writes are still `person_update` / `matter_update` /
 *    `matter_create` actions in category `matters` (low risk, reversible); the inverse of a
 *    knowledge-only update is the prior content, as `profile_update` does for USER.md.
 */

import type { Email, Id, Matter, Person, Timestamp } from "./index.js";
import { mailHandle, parseMailHandle } from "./mail-row.js";

/**
 * A provider-addressed reference to one message. It survives envelope-cache eviction: the store
 * re-reads the row through `mailRefHandle(ref)` and a stale `providerId` can be re-found with
 * `MailReader.findByRfc822(rfc822Id)`. All strings except ids are provider-derived (untrusted).
 */
export interface MailRef {
  /** Account id the message lives in. */
  account: Id;
  /** Provider message id (Gmail id, Graph id, IMAP `uidvalidity:uid`). */
  providerId: string;
  /** RFC 822 Message-ID, when known. */
  rfc822Id?: string | null;
  /** Provider thread id (Gmail threadId, Graph conversationId), when known. */
  threadPid?: string;
  /** When the message was received (ISO-8601 UTC). */
  date: Timestamp;
  /** Subject at the time of reference. Untrusted provider data. */
  subject: string;
}

/** The two note-bearing units. */
export type NoteKind = "person" | "matter";

declare module "./index.js" {
  interface Matter {
    /** Markdown knowledge the agent maintains (where things stand, a dated log). Not policy state. */
    notes?: string | null;
    /**
     * Provider-addressed references: the source of truth for which conversations belong to this
     * matter. `emailIds` is kept for v0.2 rows and compatibility.
     */
    refs?: MailRef[];
    /**
     * A saved portable query the triage agent checks on arrival for open matters, e.g.
     * `from:dana@acme.com newer_than:30d`. Null or absent: no watch.
     */
    watch?: string | null;
  }

  interface Store {
    /** Local, cache-only search over person and matter notes (v0.3). */
    notes?: StoreNotes;
  }
}

/** Input of `Store.notes.search`. Provide `text` or `pattern`. */
export interface NotesSearchInput {
  /** Case-insensitive substring over names, addresses, titles, summaries and notes. */
  text?: string;
  /** JavaScript regular expression (case-insensitive, multiline) over the same fields. */
  pattern?: string;
  kind?: NoteKind;
  /** Default 25, maximum 200. */
  limit?: number;
}

/** One match of `Store.notes.search`. */
export interface NotesSearchHit {
  kind: NoteKind;
  id: Id;
  /** Person display name or matter title. */
  name: string;
  /** Which field matched first. */
  field: "name" | "email" | "summary" | "notes";
  /** The matching line (or the start of the field), at most `NOTES_SNIPPET_MAX` characters. */
  snippet: string;
  updatedAt: Timestamp;
}

/** Matter lookups by provider reference. At least one of the optional fields is required. */
export interface MatterRefQuery {
  account: Id;
  providerId?: string;
  threadPid?: string;
  rfc822Id?: string;
}

/** Notes helpers on `Store`; optional so other Store implementations still conform. */
export interface StoreNotes {
  search(input: NotesSearchInput): Promise<NotesSearchHit[]>;
  /** Matters whose `refs` name this message or thread, newest first. */
  mattersByRef?(query: MatterRefQuery, limit?: number): Promise<Matter[]>;
}

/** `Person` fields the policy engine reads. Never free text; never written by `notes_write`. */
export const PERSON_SECURITY_FIELDS = [
  "relationship",
  "verification",
  "verifiedSelf",
  "lastSeenBlueAt",
  "downgradeAcknowledgedAt",
  "stats",
] as const satisfies readonly (keyof Person)[];

/** Knowledge fields per unit. An update touching only these gets a prior-content inverse. */
export const KNOWLEDGE_FIELDS = {
  person: ["notes"],
  matter: ["notes", "refs", "watch"],
} as const satisfies { person: readonly (keyof Person)[]; matter: readonly (keyof Matter)[] };

/** Maximum notes length in characters. */
export const NOTES_MAX_LENGTH = 64_000;
/** Maximum `Matter.refs` entries. */
export const MATTER_REFS_MAX = 500;
/** Maximum `Matter.watch` length. */
export const MATTER_WATCH_MAX_LENGTH = 500;
/** Maximum `NotesSearchHit.snippet` length. */
export const NOTES_SNIPPET_MAX = 200;
/** Open matters whose `watch` query triage checks per arrival. */
export const MATTER_WATCH_PER_ARRIVAL = 5;

/** The mail handle the store reads a reference through (`acc:email:<providerId>`). */
export function mailRefHandle(ref: Pick<MailRef, "account" | "providerId">): string {
  return mailHandle(ref.account, "email", ref.providerId);
}

/** The reference for a cached email (envelope only; bodies are never needed). */
export function mailRefOf(email: Email): MailRef {
  const thread = parseMailHandle(email.threadId);
  const threadPid =
    thread?.type === "thread" && thread.accountId === email.accountId
      ? thread.providerId
      : undefined;
  return {
    account: email.accountId,
    providerId: email.providerId,
    rfc822Id: email.headers.messageId ?? null,
    ...(threadPid ? { threadPid } : {}),
    date: email.receivedAt,
    subject: email.subject,
  };
}

/** `refs` plus `added`, deduplicated by `(account, providerId)`, oldest first, capped. */
export function mergeMailRefs(refs: readonly MailRef[], added: readonly MailRef[]): MailRef[] {
  const merged = new Map<string, MailRef>();
  for (const ref of [...refs, ...added]) {
    merged.set(`${ref.account}\u0000${ref.providerId}`, ref);
  }
  return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-MATTER_REFS_MAX);
}

/** One dated log line: `- 2026-10-20: text`, single-line. */
export function datedNoteLine(at: Timestamp, text: string): string {
  return `- ${at.slice(0, 10)}: ${text.replace(/\s+/g, " ").trim()}`;
}

/**
 * Appends a line to notes. Keeps the newest content when the result would exceed
 * `NOTES_MAX_LENGTH` (older lines are dropped from the top).
 */
export function appendNoteLine(notes: string | null | undefined, line: string): string {
  const base = (notes ?? "").replace(/\s+$/, "");
  const next = base ? `${base}\n${line}` : line;
  if (next.length <= NOTES_MAX_LENGTH) {
    return next;
  }
  const tail = next.slice(next.length - NOTES_MAX_LENGTH);
  const cut = tail.indexOf("\n");
  return cut >= 0 ? tail.slice(cut + 1) : tail;
}
