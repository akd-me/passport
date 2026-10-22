import type { Mailbox, MailLabel, RefreshLabelsOptions } from "@passport/types";
import type { StoreDatabase } from "./store-database.js";

/** Caches `mail_labels` output as mailbox rows (contract: `StoreMailboxesOnDemand`). */
export function refreshFromLabels(
  db: StoreDatabase,
  accountId: string,
  labels: MailLabel[],
  opts: RefreshLabelsOptions = {},
): Mailbox[] {
  return db.transaction(() => {
    const existing = new Map(
      db
        .rows<Mailbox>("SELECT data FROM mailboxes WHERE account_id = ?", [accountId])
        .map((box) => [box.providerId, box]),
    );
    const idOf = (providerId: string) =>
      existing.get(providerId)?.id ?? `${accountId}:mailbox:${encodeURIComponent(providerId)}`;
    for (const label of labels) {
      const previous = existing.get(label.id);
      const mailbox: Mailbox = {
        ...previous,
        id: idOf(label.id),
        accountId,
        providerId: label.id,
        name: label.name,
        role: label.role !== undefined ? label.role : (previous?.role ?? null),
        parentId: label.parentId ? idOf(label.parentId) : null,
        totalEmails: label.counts?.total ?? previous?.totalEmails ?? 0,
        unreadEmails: label.counts?.unread ?? previous?.unreadEmails ?? 0,
      };
      db.put("mailboxes", mailbox.id, mailbox, {
        account_id: accountId,
        provider_id: mailbox.providerId,
      });
    }
    if (opts.prune) {
      const current = new Set(labels.map((label) => label.id));
      for (const box of existing.values()) {
        if (!current.has(box.providerId)) {
          db.run("DELETE FROM email_mailboxes WHERE mailbox_id = ?", [box.id]);
          db.run("DELETE FROM mailboxes WHERE id = ?", [box.id]);
        }
      }
    }
    return db.rows<Mailbox>("SELECT data FROM mailboxes WHERE account_id = ? ORDER BY id", [
      accountId,
    ]);
  });
}
