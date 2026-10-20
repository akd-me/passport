import type { Email, EventBus, Person, Relationship, Store } from "@passport/types";
import { allActions, allEmails, normalizeAddress } from "./data.js";
import { newAgentId } from "./id.js";

export function serviceSender(email: Email): boolean {
  return Boolean(email.headers.listId || /^(bulk|list|junk)$/i.test(email.headers.extra?.precedence?.trim() ?? "") || email.from.some(address => /(^|[._+-])(no[._-]?reply|do[._-]?not[._-]?reply)([._+-]|@)/i.test(address.email)));
}

export interface PeopleResult {
  people: Person[];
  persistedIds: string[];
  downgraded: string[];
}

/** Projects inferred people for prompts; only the executor may persist them. */
export async function resolvePeople(opts: {
  email: Email; store: Store; bus: EventBus; selfAddresses: Set<string>; now: string;
  savePerson: (person: Person, reason: string) => Promise<void>;
}): Promise<PeopleResult> {
  const { email, store, bus, now } = opts;
  const selfAddresses = new Set([...opts.selfAddresses, ...(await store.people.list({ relationship: "self", limit: 2_147_483_647 })).filter(person => person.verifiedSelf).flatMap(person => person.emails)].map(normalizeAddress));
  const addresses = new Map([...email.from, ...email.to, ...email.cc].map(address => [normalizeAddress(address.email), address]));
  const senders = new Set(email.from.map(address => normalizeAddress(address.email)));
  const stored = [...new Map([...(await allEmails(store, { includeDeleted: true })), email].map(item => [item.id, item])).values()]
    .filter(item => item.receivedAt <= email.receivedAt && !item.keywords.$draft);
  const sentBoxes = new Set((await Promise.all((await store.accounts.list()).map(account => store.mailboxes.list(account.id)))).flat().filter(box => box.role === "sent").map(box => box.id));
  const isSent = (item: Email) => !item.keywords.$draft && (item.provenance === "sent" || item.mailboxIds.some(id => sentBoxes.has(id)));
  // A From header is never evidence that the owner sent a message.
  const sent = stored.filter(isSent).map(item => ({ id: `email:${item.id}`, at: item.receivedAt, recipients: [...item.to, ...item.cc, ...item.bcc] }));
  const sentAliases = new Map<string, string>();
  for (const action of await allActions(store, { status: ["executed"] })) {
    if (action.request.type !== "send" || (action.executedAt ?? action.createdAt) > email.receivedAt) continue;
    const params = action.request.params as import("@passport/types").ActionParams["send"];
    const draft = params.draft ?? action.approvedSnapshot as import("@passport/types").DraftInput | undefined;
    if (!draft) continue;
    const copy = stored.find(item => isSent(item) && item.accountId === action.request.accountId && (item.providerId === action.result?.providerId || item.headers.messageId && item.headers.messageId === action.result?.messageId));
    if (copy) {
      sentAliases.set(`email:${copy.id}`, `action:${action.id}`);
      continue;
    }
    sent.push({ id: `action:${action.id}`, at: action.executedAt ?? action.createdAt, recipients: [...draft.to, ...draft.cc ?? [], ...draft.bcc ?? []] });
  }
  const result: PeopleResult = { people: [], persistedIds: [], downgraded: [] };
  for (const [address, named] of addresses) {
    const existing = await store.people.getByEmail(address);
    const personAddresses = new Set([address, ...(existing?.emails ?? []), ...(existing ? [existing.primaryEmail] : [])].map(normalizeAddress));
    let sentIds = new Set(!selfAddresses.has(address) ? sent.filter(item => item.recipients.some(a => personAddresses.has(normalizeAddress(a.email)))).map(item => item.id) : []);
    let receivedIds = new Set(stored.filter(item => !isSent(item) && item.from.some(a => personAddresses.has(normalizeAddress(a.email)))).map(item => item.id));
    const currentSentId = sentAliases.get(`email:${email.id}`) ?? `email:${email.id}`;
    sentIds = new Set([...sentIds].map(id => sentAliases.get(id) ?? id));
    const saved = existing ? await store.kv.get(`person-stats:${existing.id}`) : null;
    const contributions: { sent: number; received: number; sentIds?: string[]; receivedIds?: string[] } = saved ? JSON.parse(saved) : {
      sent: 0,
      received: Math.max(0, (existing?.stats.received ?? 0) - receivedIds.size + (receivedIds.has(email.id) ? 1 : 0)),
    };
    // Retain contributions even if an older message leaves the local sync window.
    sentIds = new Set([...contributions.sentIds ?? [], ...sentIds].map(id => sentAliases.get(id) ?? id));
    receivedIds = new Set([...contributions.receivedIds ?? [], ...receivedIds]);
    const priorSent = sentIds.size - (sentIds.has(currentSentId) ? 1 : 0);
    const priorReceived = receivedIds.size - (receivedIds.has(email.id) ? 1 : 0);
    const baseline = contributions;
    const isSender = senders.has(address);
    const relationship: Relationship = selfAddresses.has(address) ? "self"
      : (isSender && serviceSender(email)) || existing?.relationship === "service" ? "service"
      : existing?.relationship === "known" || priorSent > 0 || priorReceived + baseline.received >= 2 ? "known" : "stranger";
    const wasBlue = existing?.verification === "blue";
    const blue = isSender && email.verification.passport === "blue";
    const lastSeenBlueAt = blue ? email.receivedAt : existing?.lastSeenBlueAt ?? (wasBlue ? existing?.updatedAt : null);
    const acknowledged = existing?.downgradeAcknowledgedAt && lastSeenBlueAt && existing.downgradeAcknowledgedAt >= lastSeenBlueAt;
    const downgrade = isSender && !blue && Boolean(lastSeenBlueAt) && !acknowledged;
    const forgedSelf = isSender && selfAddresses.has(address) && !isSent(email) && (email.verification.dmarc === "fail" || email.verification.dkim === "fail");
    const person: Person = {
      ...existing,
      id: existing?.id ?? newAgentId(), displayName: existing?.displayName || named.name || address,
      emails: [...new Set([...(existing?.emails ?? []), address])], primaryEmail: existing?.primaryEmail ?? address,
      verification: isSender ? blue ? "blue" : "green" : existing?.verification ?? "unknown",
      lastSeenBlueAt, relationship,
      stats: { sent: sentIds.size, received: baseline.received + receivedIds.size, lastContactAt: [existing?.stats.lastContactAt, email.receivedAt].filter((at): at is string => Boolean(at)).sort().at(-1) ?? null },
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
    await opts.savePerson(person, `Resolve ${address} as ${relationship}${forgedSelf ? "; unauthenticated inbound self From is stranger risk" : downgrade ? "; previously blue sender is now green" : ""}`);
    result.people.push(person);
    const persisted = await store.people.get(person.id);
    if (persisted) {
      result.persistedIds.push(person.id);
      if (persisted.stats.sent === person.stats.sent && persisted.stats.received === person.stats.received) await store.kv.set(`person-stats:${person.id}`, JSON.stringify({ ...baseline, sentIds: [...sentIds], receivedIds: [...receivedIds] }));
    }
    if (downgrade || forgedSelf) {
      bus.emit({ type: "person.downgraded", person, emailId: email.id });
      result.downgraded.push(person.displayName);
    }
  }
  return result;
}
