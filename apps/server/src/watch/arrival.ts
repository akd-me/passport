import type { Email, MailboxRole, MailLabel, Store } from "@passport/types";

/** What one tick needs to classify new mail. Built once per tick. */
export interface ArrivalContext {
  roleOf(mailboxId: string): MailboxRole | undefined;
  /** The account has an inbox concept (Gmail label, IMAP/Graph folder). */
  hasInbox: boolean;
  self: Set<string>;
}

const mailboxHandle = (accountId: string, providerId: string) =>
  `${accountId}:mailbox:${encodeURIComponent(providerId)}`;
const excluded = new Set<MailboxRole>(["sent", "drafts", "junk", "trash"]);

export async function arrivalContext(
  store: Store,
  accountId: string,
  labels: readonly MailLabel[],
): Promise<ArrivalContext> {
  const roles = new Map<string, MailboxRole>();
  for (const label of labels) {
    if (label.role) {
      roles.set(label.id, label.role);
      roles.set(mailboxHandle(accountId, label.id), label.role);
    }
  }
  // v0.2 mailbox rows (ULID ids) and the store's label cache.
  for (const box of await store.mailboxes.list(accountId)) {
    if (box.role) {
      roles.set(box.id, box.role);
      roles.set(box.providerId, box.role);
    }
  }
  const self = new Set(
    (await store.accounts.list()).map((account) => account.emailAddress.trim().toLowerCase()),
  );
  for (const person of await store.people.list({ relationship: "self", limit: 2147483647 })) {
    if (person.verifiedSelf) {
      for (const address of person.emails) {
        self.add(address.trim().toLowerCase());
      }
    }
  }
  return {
    roleOf: (id) => roles.get(id),
    hasInbox: [...roles.values()].includes("inbox"),
    self,
  };
}

/**
 * New mail is triaged when it is in the Inbox (or, without an inbox concept, outside
 * Sent/Drafts/Spam/Trash) and not from the user. `mailboxIds` may mix adapter and cached ids.
 */
export function isInboxArrival(email: Email, mailboxIds: string[], ctx: ArrivalContext): boolean {
  if (email.keywords.$draft) {
    return false;
  }
  const roles = mailboxIds.map((id) => ctx.roleOf(id)).filter(Boolean);
  const placed = ctx.hasInbox
    ? roles.includes("inbox")
    : !roles.some((role) => excluded.has(role ?? null));
  return placed && !email.from.some((a) => ctx.self.has(a.email.trim().toLowerCase()));
}

/** Already queued, triaged (run journal) or acted on by its arrival run: never triage twice. */
export async function alreadyHandled(store: Store, emailId: string): Promise<boolean> {
  const runId = `arrival:${emailId}`;
  if ((await store.kv.get(runId)) || (await store.kv.get(`run:${runId}`))) {
    return true;
  }
  return (await store.actions.query({ runId, limit: 1 })).items.length > 0;
}
