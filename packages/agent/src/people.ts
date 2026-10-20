import type { ActionRecord, ActionRequest, Email, EventBus, Person, Relationship, Store } from "@passport/types";
import { allEmails, normalizeAddress } from "./data.js";
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
  submit: (request: Omit<ActionRequest<"person_update">, "actor" | "runId">) => Promise<ActionRecord>;
}): Promise<PeopleResult> {
  const { email, store, bus, selfAddresses, now } = opts;
  const addresses = new Map([...email.from, ...email.to, ...email.cc].map(address => [normalizeAddress(address.email), address]));
  const senders = new Set(email.from.map(address => normalizeAddress(address.email)));
  const outgoing = email.from.some(address => selfAddresses.has(normalizeAddress(address.email)));
  const history = (await allEmails(store)).filter(item => item.id !== email.id && item.receivedAt <= email.receivedAt && !item.keywords.$draft);
  const result: PeopleResult = { people: [], persistedIds: [], downgraded: [] };
  for (const [address, named] of addresses) {
    const existing = await store.people.getByEmail(address);
    const priorReceived = history.filter(item => item.from.some(a => normalizeAddress(a.email) === address) && !item.from.some(a => selfAddresses.has(normalizeAddress(a.email)))).length;
    const priorSent = history.filter(item => item.from.some(a => selfAddresses.has(normalizeAddress(a.email))) && [...item.to, ...item.cc, ...item.bcc].some(a => normalizeAddress(a.email) === address)).length;
    const sent = Math.max(existing?.stats.sent ?? 0, priorSent);
    const received = Math.max(existing?.stats.received ?? 0, priorReceived);
    const isSender = senders.has(address);
    const relationship: Relationship = selfAddresses.has(address) ? "self"
      : (isSender && serviceSender(email)) || existing?.relationship === "service" ? "service"
      : existing?.relationship === "known" || sent > 0 || received >= 2 ? "known" : "stranger";
    const wasBlue = existing?.verification === "blue";
    const downgrade = isSender && wasBlue && email.verification.passport !== "blue";
    const blue = isSender && email.verification.passport === "blue";
    const person: Person = {
      ...existing,
      id: existing?.id ?? newAgentId(), displayName: existing?.displayName || named.name || address,
      emails: [...new Set([...(existing?.emails ?? []), address])], primaryEmail: existing?.primaryEmail ?? address,
      verification: isSender ? blue ? "blue" : "green" : existing?.verification ?? "unknown",
      lastSeenBlueAt: blue ? email.receivedAt : existing?.lastSeenBlueAt ?? (wasBlue ? existing?.updatedAt : null),
      relationship,
      stats: { sent: sent + (outgoing && !selfAddresses.has(address) ? 1 : 0), received: received + (!outgoing && isSender ? 1 : 0), lastContactAt: [existing?.stats.lastContactAt, email.receivedAt].filter((at): at is string => Boolean(at)).sort().at(-1) ?? null },
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
    await opts.submit({ type: "person_update", accountId: email.accountId, category: "matters", params: { personId: person.id, patch: person }, reason: `Resolve ${address} as ${relationship}${downgrade ? "; previously blue sender is now green" : ""}`, counterparty: { emails: [address], ...(existing ? { personId: existing.id } : {}), class: relationship === "self" ? "self" : downgrade ? "stranger" : blue ? "blue" : relationship === "service" ? "service" : relationship === "known" ? "green_known" : "stranger" } });
    result.people.push(person);
    if (await store.people.get(person.id)) result.persistedIds.push(person.id);
    if (downgrade) {
      bus.emit({ type: "person.downgraded", person, emailId: email.id });
      result.downgraded.push(person.displayName);
    }
  }
  return result;
}
