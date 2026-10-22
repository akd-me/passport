import type {
  Email,
  EventBus,
  Person,
  PersonWithStatsCache,
  Relationship,
  Store,
} from "@passport/types";
import { normalizeAddress } from "./data.js";
import { newAgentId } from "./id.js";
import { type AddressEvidence, readerEvidence, storeEvidence } from "./people-evidence.js";
import type { AgentReader } from "./reads.js";

export function serviceSender(email: Email): boolean {
  return Boolean(
    email.headers.listId ||
      /^(bulk|list|junk)$/i.test(email.headers.extra?.precedence?.trim() ?? "") ||
      email.from.some((address) =>
        /(^|[._+-])(no[._-]?reply|do[._-]?not[._-]?reply)([._+-]|@)/i.test(address.email),
      ),
  );
}

export interface PeopleResult {
  people: Person[];
  persistedIds: string[];
  downgraded: string[];
}

/** Fields whose change is worth a `person_update` action; `updatedAt` alone is not. */
function sameProjection(a: PersonWithStatsCache, b: PersonWithStatsCache): boolean {
  const view = (p: PersonWithStatsCache) =>
    JSON.stringify([
      p.displayName,
      p.emails,
      p.primaryEmail,
      p.verification,
      p.lastSeenBlueAt ?? null,
      p.relationship,
      p.stats.sent,
      p.stats.received,
      p.stats.lastContactAt,
      p.statsRefreshedAt ?? null,
    ]);
  return view(a) === view(b);
}

/** The person row this message implies, plus its identity warnings. */
function projectPerson(input: {
  email: Email;
  address: string;
  name: string | null | undefined;
  existing: PersonWithStatsCache | null;
  found: AddressEvidence;
  isSender: boolean;
  isSelf: boolean;
  isService: boolean;
  sentByOwner: boolean;
  now: string;
}): { person: PersonWithStatsCache; downgrade: boolean; forgedSelf: boolean } {
  const { email, address, existing, found, isSender, isSelf, now } = input;
  let relationship: Relationship = "stranger";
  if (isSelf) {
    relationship = "self";
  } else if (input.isService) {
    relationship = "service";
  } else if (existing?.relationship === "known" || found.established) {
    relationship = "known";
  }
  const wasBlue = existing?.verification === "blue";
  const blue = isSender && email.verification.passport === "blue";
  const lastSeenBlueAt = blue
    ? email.receivedAt
    : (existing?.lastSeenBlueAt ?? (wasBlue ? existing?.updatedAt : null));
  const acknowledged =
    existing?.downgradeAcknowledgedAt &&
    lastSeenBlueAt &&
    existing.downgradeAcknowledgedAt >= lastSeenBlueAt;
  const person: PersonWithStatsCache = {
    ...existing,
    id: existing?.id ?? newAgentId(),
    displayName: existing?.displayName || input.name || address,
    emails: [...new Set([...(existing?.emails ?? []), address])],
    primaryEmail: existing?.primaryEmail ?? address,
    verification: isSender ? (blue ? "blue" : "green") : (existing?.verification ?? "unknown"),
    lastSeenBlueAt,
    relationship,
    stats: {
      sent: found.sent,
      received: found.received,
      lastContactAt:
        [existing?.stats.lastContactAt, email.receivedAt]
          .filter((at): at is string => Boolean(at))
          .sort()
          .at(-1) ?? null,
    },
    ...(found.statsRefreshedAt ? { statsRefreshedAt: found.statsRefreshedAt } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return {
    person,
    downgrade: isSender && !blue && Boolean(lastSeenBlueAt) && !acknowledged,
    forgedSelf:
      isSender &&
      isSelf &&
      !input.sentByOwner &&
      (email.verification.dmarc === "fail" || email.verification.dkim === "fail"),
  };
}

/**
 * Projects inferred people for prompts; only the executor may persist them.
 *
 * With a `reader`, sent/received evidence comes from capped provider counts cached on the person
 * row (see `readerEvidence`); nothing scans the store. Without one, a bounded store scan is the
 * fallback (see `storeEvidence`). Verification and `lastSeenBlueAt` always come from this
 * message's headers. The executor takes one person per `person_update`, so each changed address
 * is submitted separately and unchanged rows are not resubmitted.
 */
export async function resolvePeople(opts: {
  email: Email;
  store: Store;
  bus: EventBus;
  selfAddresses: Set<string>;
  now: string;
  savePerson: (person: Person, reason: string) => Promise<void>;
  /** The account's metered reader; null or absent selects the bounded store fallback. */
  reader?: AgentReader | null;
  /** Recount provider evidence even when the cached counts are fresh. */
  refreshStats?: boolean;
}): Promise<PeopleResult> {
  const { email, store, bus, now } = opts;
  const selfAddresses = new Set(
    [
      ...opts.selfAddresses,
      ...(await store.people.list({ relationship: "self", limit: 2_147_483_647 }))
        .filter((person) => person.verifiedSelf)
        .flatMap((person) => person.emails),
    ].map(normalizeAddress),
  );
  const addresses = new Map(
    [...email.from, ...email.to, ...email.cc].map((address) => [
      normalizeAddress(address.email),
      address,
    ]),
  );
  const senders = new Set(email.from.map((address) => normalizeAddress(address.email)));
  const sentBoxes = new Set(
    (
      await Promise.all(
        (await store.accounts.list()).map((account) => store.mailboxes.list(account.id)),
      )
    )
      .flat()
      .filter((box) => box.role === "sent")
      .map((box) => box.id),
  );
  const isSent = (item: Email) =>
    !item.keywords.$draft &&
    (item.provenance === "sent" || item.mailboxIds.some((id) => sentBoxes.has(id)));
  const evidence = opts.reader
    ? readerEvidence(opts.reader, now, opts.refreshStats)
    : await storeEvidence(store, email, isSent);
  const result: PeopleResult = { people: [], persistedIds: [], downgraded: [] };
  // Senders first, so a spent read budget falls on recipients rather than the sender.
  const ordered = [...addresses].sort(
    ([a], [b]) => Number(senders.has(b)) - Number(senders.has(a)),
  );
  for (const [address, named] of ordered) {
    const existing = (await store.people.getByEmail(address)) as PersonWithStatsCache | null;
    const isSender = senders.has(address);
    const isSelf = selfAddresses.has(address);
    const isService =
      !isSelf && ((isSender && serviceSender(email)) || existing?.relationship === "service");
    const personAddresses = new Set(
      [address, ...(existing?.emails ?? []), ...(existing ? [existing.primaryEmail] : [])].map(
        normalizeAddress,
      ),
    );
    const found = await evidence({ address, existing, personAddresses, isSelf, isService });
    const { person, downgrade, forgedSelf } = projectPerson({
      email,
      address,
      name: named.name,
      existing,
      found,
      isSender,
      isSelf,
      isService,
      sentByOwner: isSent(email),
      now,
    });
    if (existing && sameProjection(existing, person)) {
      result.people.push(existing);
      result.persistedIds.push(existing.id);
    } else {
      await opts.savePerson(
        person,
        `Resolve ${address} as ${person.relationship}${forgedSelf ? "; unauthenticated inbound self From is stranger risk" : downgrade ? "; previously blue sender is now green" : ""}`,
      );
      result.people.push(person);
      const persisted = await store.people.get(person.id);
      if (persisted) {
        result.persistedIds.push(person.id);
        await found.persisted?.(person, persisted);
      }
    }
    if (downgrade || forgedSelf) {
      bus.emit({ type: "person.downgraded", person, emailId: email.id });
      result.downgraded.push(person.displayName);
    }
  }
  return result;
}
