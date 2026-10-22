import {
  type ActionParams,
  type DraftInput,
  type Email,
  PERSON_STATS_CAPS,
  PERSON_STATS_MAX_AGE_MS,
  type Person,
  type PersonWithStatsCache,
  type Store,
} from "@passport/types";
import { normalizeAddress } from "./data.js";
import { type AgentReader, queryAddress } from "./reads.js";

/** Relationship evidence for one address of the current message. */
export interface AddressEvidence {
  sent: number;
  received: number;
  /** Prior contact establishes `known` (the policy's `green_known`). */
  established: boolean;
  /** Set when the counts were just taken from the provider; undefined leaves the stamp alone. */
  statsRefreshedAt?: string;
  /** Runs once the projected person row is persisted. */
  persisted?: (person: Person, saved: Person) => Promise<void>;
}

export interface EvidenceInput {
  address: string;
  existing: Person | null;
  /** Every address of the person, normalized. */
  personAddresses: Set<string>;
  isSelf: boolean;
  /** The relationship is `service` whatever the counts say. */
  isService: boolean;
}

export type Evidence = (input: EvidenceInput) => Promise<AddressEvidence>;

/** The newest stored emails (and executed actions) the reader-less fallback inspects. */
export const PEOPLE_FALLBACK_SCAN = 200;

const enough = (stats: { sent: number; received: number }) =>
  stats.sent > 0 || stats.received >= PERSON_STATS_CAPS.received;

/**
 * Provider evidence (research report 03 §4.3): `countIds` over sent mail (cap 1, "have we ever
 * sent to them") and over their mail (cap 3, the received count class, including this message).
 * Counts are cached on the person row with `statsRefreshedAt` and reused for seven days once
 * they establish the relationship; weaker evidence is recounted on each arrival because one more
 * message can promote a stranger. A failed read keeps the cached counts and the old stamp.
 */
export function readerEvidence(reader: AgentReader, now: string, refresh = false): Evidence {
  return async ({ existing, personAddresses, isSelf, isService }) => {
    const cached = { sent: existing?.stats.sent ?? 0, received: existing?.stats.received ?? 0 };
    if (isSelf || isService) {
      return { ...cached, established: false };
    }
    const stamp = (existing as PersonWithStatsCache | null)?.statsRefreshedAt;
    const fresh = stamp ? Date.parse(now) - Date.parse(stamp) < PERSON_STATS_MAX_AGE_MS : false;
    if (!refresh && fresh && (existing?.relationship === "known" || enough(cached))) {
      return { ...cached, established: true };
    }
    const terms = [...personAddresses]
      .map(queryAddress)
      .filter((term): term is string => term !== null)
      .slice(0, 5);
    if (!terms.length) {
      return { ...cached, established: enough(cached) };
    }
    const recipients = terms.flatMap((term) => [`to:${term}`, `cc:${term}`, `bcc:${term}`]);
    const sent = await reader.call((r, opts) =>
      r.countIds(`in:sent (${recipients.join(" OR ")})`, PERSON_STATS_CAPS.sent, opts),
    );
    const received = await reader.call((r, opts) =>
      r.countIds(
        `(${terms.map((term) => `from:${term}`).join(" OR ")})`,
        PERSON_STATS_CAPS.received,
        opts,
      ),
    );
    const counts = {
      sent: sent ? sent.value.count : cached.sent,
      received: received ? received.value.count : cached.received,
    };
    return {
      ...counts,
      established: enough(counts),
      ...(sent && received ? { statsRefreshedAt: now } : {}),
    };
  };
}

/**
 * Reader-less fallback: the v0.2 store scan, bounded to the newest `PEOPLE_FALLBACK_SCAN` emails
 * at or before this message and the newest `PEOPLE_FALLBACK_SCAN` executed actions. Older history
 * survives only through the per-person contribution ledger in kv (`person-stats:<id>`), so a
 * contact last seen beyond the bound can read as a stranger until they write again.
 */
export async function storeEvidence(
  store: Store,
  email: Email,
  isSent: (item: Email) => boolean,
): Promise<Evidence> {
  const before = new Date(Date.parse(email.receivedAt) + 1).toISOString();
  const recent = await store.emails.query({
    includeDeleted: true,
    before,
    sort: "receivedAt_desc",
    limit: PEOPLE_FALLBACK_SCAN,
  });
  const stored = [
    ...new Map([...recent.items, email].map((item) => [item.id, item])).values(),
  ].filter((item) => item.receivedAt <= email.receivedAt && !item.keywords.$draft);
  // A From header is never evidence that the owner sent a message.
  const sent = stored.filter(isSent).map((item) => ({
    id: `email:${item.id}`,
    recipients: [...item.to, ...item.cc, ...item.bcc],
  }));
  const sentAliases = new Map<string, string>();
  const actions = await store.actions.query({ status: ["executed"], limit: PEOPLE_FALLBACK_SCAN });
  for (const action of actions.items) {
    if (
      action.request.type !== "send" ||
      (action.executedAt ?? action.createdAt) > email.receivedAt
    ) {
      continue;
    }
    const params = action.request.params as ActionParams["send"];
    const draft = params.draft ?? (action.approvedSnapshot as DraftInput | undefined);
    if (!draft) {
      continue;
    }
    const copy = stored.find(
      (item) =>
        isSent(item) &&
        item.accountId === action.request.accountId &&
        (item.providerId === action.result?.providerId ||
          (item.headers.messageId && item.headers.messageId === action.result?.messageId)),
    );
    if (copy) {
      sentAliases.set(`email:${copy.id}`, `action:${action.id}`);
      continue;
    }
    sent.push({
      id: `action:${action.id}`,
      recipients: [...draft.to, ...(draft.cc ?? []), ...(draft.bcc ?? [])],
    });
  }
  return async ({ existing, personAddresses, isSelf }) => {
    const matches = (a: { email: string }) => personAddresses.has(normalizeAddress(a.email));
    let sentIds = new Set(
      isSelf ? [] : sent.filter((item) => item.recipients.some(matches)).map((item) => item.id),
    );
    let receivedIds = new Set(
      stored.filter((item) => !isSent(item) && item.from.some(matches)).map((item) => item.id),
    );
    const currentSentId = sentAliases.get(`email:${email.id}`) ?? `email:${email.id}`;
    sentIds = new Set([...sentIds].map((id) => sentAliases.get(id) ?? id));
    const saved = existing ? await store.kv.get(`person-stats:${existing.id}`) : null;
    const baseline: {
      sent: number;
      received: number;
      sentIds?: string[];
      receivedIds?: string[];
    } = saved
      ? JSON.parse(saved)
      : {
          sent: 0,
          received: Math.max(
            0,
            (existing?.stats.received ?? 0) -
              receivedIds.size +
              (receivedIds.has(email.id) ? 1 : 0),
          ),
        };
    // Retain contributions even if an older message leaves the bounded scan.
    sentIds = new Set(
      [...(baseline.sentIds ?? []), ...sentIds].map((id) => sentAliases.get(id) ?? id),
    );
    receivedIds = new Set([...(baseline.receivedIds ?? []), ...receivedIds]);
    const priorSent = sentIds.size - (sentIds.has(currentSentId) ? 1 : 0);
    const priorReceived = receivedIds.size - (receivedIds.has(email.id) ? 1 : 0);
    const counts = { sent: sentIds.size, received: baseline.received + receivedIds.size };
    return {
      ...counts,
      established: priorSent > 0 || priorReceived + baseline.received >= 2,
      persisted: async (person, persisted) => {
        if (persisted.stats.sent === counts.sent && persisted.stats.received === counts.received) {
          await store.kv.set(
            `person-stats:${person.id}`,
            JSON.stringify({ ...baseline, sentIds: [...sentIds], receivedIds: [...receivedIds] }),
          );
        }
      },
    };
  };
}
