import {
  type ActionParams,
  type DraftInput,
  type Email,
  type MailEnvelope,
  type MailRow,
  PERSON_STATS_CAPS,
  PERSON_STATS_MAX_AGE_MS,
  type Person,
  type PersonWithStatsCache,
  parseMailHandle,
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

/** Rows fetched per evidence search: the cap plus slack for lookalikes the provider also matched. */
const EVIDENCE_SLACK = 2;

/** The address part of a `MailRow` `"Name <addr>"` / `"addr"` string, normalized. */
function rowAddress(formatted: string): string {
  return normalizeAddress(/<([^<>]+)>\s*$/.exec(formatted)?.[1] ?? formatted);
}

/**
 * Provider evidence (research report 03 §4.3): one search over sent mail ("have we ever sent to
 * them", cap 1) and one over their mail (the received count class, cap 3, including this
 * message). Provider query matching is a substring match (IMAP SEARCH, display names), so the
 * counts are never trusted: every returned row is checked against the person's addresses
 * exactly, from the row when it shows enough and otherwise from one batched `envelopes` read.
 * Received mail that fails DMARC never counts. Counts are cached on the person row with
 * `statsRefreshedAt` and reused for seven days once they establish the relationship; weaker
 * evidence is recounted on each arrival. A failed read keeps the cached counts and the old stamp.
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
    const exact = (address: { email: string }) =>
      personAddresses.has(normalizeAddress(address.email));
    const recipients = terms.flatMap((term) => [`to:${term}`, `cc:${term}`, `bcc:${term}`]);
    const sentRows = await reader.call((r, opts) =>
      r.search(
        {
          query: `in:sent (${recipients.join(" OR ")})`,
          limit: PERSON_STATS_CAPS.sent + EVIDENCE_SLACK,
        },
        opts,
      ),
    );
    const receivedRows = await reader.call((r, opts) =>
      r.search(
        {
          query: `(${terms.map((term) => `from:${term}`).join(" OR ")})`,
          limit: PERSON_STATS_CAPS.received + EVIDENCE_SLACK,
        },
        opts,
      ),
    );
    // Rows show the sender and at most three To/Cc recipients (never Bcc); anything they cannot
    // settle is checked on the envelope.
    const sentShown = (sentRows?.items ?? []).filter((row) =>
      row.to.some((to) => personAddresses.has(rowAddress(to))),
    );
    const sentUnsure = sentShown.length ? [] : (sentRows?.items ?? []);
    const received = (receivedRows?.items ?? []).filter((row) =>
      personAddresses.has(rowAddress(row.from)),
    );
    const receivedShown = received.filter((row) => row.auth === "pass" || row.auth === "none");
    const receivedUnsure = received.filter((row) => row.auth === undefined);
    const providerIdOf = (row: MailRow) => parseMailHandle(row.id)?.providerId;
    const unsure = [...new Set([...sentUnsure, ...receivedUnsure].map(providerIdOf))].filter(
      (id): id is string => !!id,
    );
    const envelopes = unsure.length
      ? await reader.call((r, opts) => r.envelopes(unsure, opts))
      : null;
    const envelope = (row: MailRow): MailEnvelope | null => {
      const id = providerIdOf(row);
      return (id && envelopes?.value.get(id)) || null;
    };
    const sentCount =
      sentShown.length ||
      sentUnsure.filter((row) => {
        const found = envelope(row);
        return !!found && [...found.to, ...found.cc, ...found.bcc].some(exact);
      }).length;
    const receivedCount =
      receivedShown.length +
      receivedUnsure.filter((row) => {
        const found = envelope(row);
        return !!found && found.from.some(exact) && found.verification.dmarc !== "fail";
      }).length;
    // A kind whose rows (or the envelopes needed to check them) could not be read keeps its cache.
    const sentKnown = !!sentRows && (!sentUnsure.length || !!envelopes);
    const receivedKnown = !!receivedRows && (!receivedUnsure.length || !!envelopes);
    const counts = {
      sent: sentKnown ? Math.min(PERSON_STATS_CAPS.sent, sentCount) : cached.sent,
      received: receivedKnown
        ? Math.min(PERSON_STATS_CAPS.received, receivedCount)
        : cached.received,
    };
    const complete = sentKnown && receivedKnown;
    return {
      ...counts,
      established: enough(counts),
      ...(complete ? { statsRefreshedAt: now } : {}),
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
      stored
        // Mail that fails DMARC is never evidence of a relationship.
        .filter(
          (item) => !isSent(item) && item.verification.dmarc !== "fail" && item.from.some(matches),
        )
        .map((item) => item.id),
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
