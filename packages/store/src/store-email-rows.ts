import type { Email } from "@passport/types";
import { nowIso } from "@passport/types";
import type { StoreDatabase } from "./store-database.js";
import type { Row } from "./store-query.js";

/** Columns every email read selects; bodies are added only when requested. */
export const EMAIL_COLUMNS =
  "id, account_id, provider_id, data, matter_id, labels_fresh_at, body_fetched_at";

export function createEmailRows(db: StoreDatabase) {
  function readEmail(row: Row, includeBodies = true): Email {
    const email = db.parse<Email>(row);
    email.mailboxIds = db.ids("email_mailboxes", "email_id", email.id, "mailbox_id");
    email.personIds = db.ids("email_people", "email_id", email.id, "person_id");
    if (row.matter_id !== null || email.matterId !== undefined) {
      email.matterId = row.matter_id as string | null;
    }
    if (includeBodies) {
      if (row.textBody !== null && row.textBody !== undefined) {
        email.textBody = row.textBody as string;
      }
      if (row.html_body !== null && row.html_body !== undefined) {
        email.htmlBody = row.html_body as string;
      }
    } else {
      delete email.textBody;
      delete email.htmlBody;
    }
    return email;
  }
  function rowById(id: string, includeBodies = true): Row | undefined {
    return db.one(
      `SELECT ${EMAIL_COLUMNS}${includeBodies ? ", textBody, html_body" : ""} FROM emails WHERE id = ?`,
      [id],
    );
  }
  function rowByProvider(accountId: string, providerId: string): Row | undefined {
    return db.one(
      `SELECT ${EMAIL_COLUMNS}, textBody, html_body FROM emails WHERE account_id = ? AND provider_id = ?`,
      [accountId, providerId],
    );
  }
  function getEmail(id: string, includeBodies = true): Email | null {
    const row = rowById(id, includeBodies);
    return row ? readEmail(row, includeBodies) : null;
  }
  /**
   * Writes a full email. `labelsFresh` stamps keywords/mailboxIds as confirmed by the provider
   * (sync, executor mirror, read-through); local patches keep the previous stamp. The body stamp
   * moves only when bodies were supplied and differ from the cached ones.
   */
  /** Cache stamps for a write: labels (provider-confirmed?) and bodies (new content?). */
  function stampsFor(input: Email, merged: Email, previous: Email | null, labelsFresh: boolean) {
    const stamps = db.one("SELECT labels_fresh_at, body_fetched_at FROM emails WHERE id = ?", [
      input.id,
    ]);
    const at = nowIso();
    const previousBodyAt = (stamps?.body_fetched_at as string | null | undefined) ?? null;
    const suppliedBodies = input.textBody !== undefined || input.htmlBody !== undefined;
    const bodyChanged =
      previousBodyAt === null ||
      (merged.textBody ?? null) !== (previous?.textBody ?? null) ||
      (merged.htmlBody ?? null) !== (previous?.htmlBody ?? null);
    return {
      touched_at: at,
      labels_fresh_at: labelsFresh
        ? at
        : ((stamps?.labels_fresh_at as string | null | undefined) ?? null),
      body_fetched_at: suppliedBodies && bodyChanged ? at : previousBodyAt,
    };
  }
  function saveEmail(input: Email, opts: { labelsFresh: boolean }): void {
    const previous = getEmail(input.id);
    const pending = db.one("SELECT matter_id FROM matter_emails WHERE email_id = ?", [input.id]);
    const email = { ...input };
    if (email.textBody === undefined && previous?.textBody !== undefined) {
      email.textBody = previous.textBody;
    }
    if (email.htmlBody === undefined && previous?.htmlBody !== undefined) {
      email.htmlBody = previous.htmlBody;
    }
    const stamps = stampsFor(input, email, previous, opts.labelsFresh);
    const matterId =
      email.matterId === undefined
        ? ((pending?.matter_id as string | undefined) ?? previous?.matterId ?? null)
        : email.matterId;
    const data = { ...email };
    // Store only presence markers in JSON; bodies live in separately selectable columns.
    if (data.textBody !== undefined) {
      data.textBody = null;
    }
    if (data.htmlBody !== undefined) {
      data.htmlBody = null;
    }
    db.put("emails", email.id, data, {
      account_id: email.accountId,
      provider_id: email.providerId,
      thread_id: email.threadId,
      matter_id: matterId,
      category: email.category ?? null,
      received_at: email.receivedAt,
      subject: email.subject,
      '"from"': email.from.map((from) => `${from.name ?? ""} ${from.email}`).join(" "),
      preview: email.preview,
      textBody: email.textBody ?? null,
      html_body: email.htmlBody ?? null,
      ...stamps,
    });
    db.replaceIds("email_mailboxes", "email_id", email.id, "mailbox_id", email.mailboxIds);
    db.replaceIds("email_people", "email_id", email.id, "person_id", email.personIds);
    db.setMatterLink("emails", email.id, matterId);
  }
  function deleteEmail(id: string): void {
    db.run("DELETE FROM matter_emails WHERE email_id = ?", [id]);
    db.run("DELETE FROM emails WHERE id = ?", [id]);
    for (const row of db.all(
      "SELECT id, data FROM threads WHERE EXISTS (SELECT 1 FROM json_each(data, '$.emailIds') WHERE value = ?)",
      [id],
    )) {
      const thread = db.parse<{ id: string; accountId: string; emailIds: string[] }>(row);
      thread.emailIds = thread.emailIds.filter((emailId) => emailId !== id);
      db.put("threads", thread.id, thread, { account_id: thread.accountId });
    }
  }
  function touch(id: string): void {
    db.run("UPDATE emails SET touched_at = ? WHERE id = ?", [nowIso(), id]);
  }
  return { readEmail, rowById, rowByProvider, getEmail, saveEmail, deleteEmail, touch };
}
export type EmailRows = ReturnType<typeof createEmailRows>;
