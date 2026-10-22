import type {
  Email,
  EmailGetOptions,
  MailEnvelope,
  MailReader,
  MailReadOptions,
} from "@passport/types";
import type { StoreDatabase } from "./store-database.js";
import type { EmailRows } from "./store-email-rows.js";
import type { Row } from "./store-query.js";
import { unique } from "./store-query.js";

/** Provider ids per `MailReader.envelopes` call when revalidating or filling many rows. */
export const ENVELOPE_BATCH = 50;
/** Body errors that mean "this provider id no longer resolves" (moved / UID changed). */
const GONE = new Set(["NOT_FOUND", "STALE_ID"]);

export const readOptions = (opts: EmailGetOptions): MailReadOptions =>
  opts.lane ? { lane: opts.lane } : {};

const codeOf = (error: unknown) => (error as { code?: unknown })?.code;

/** Maps adapter mailbox ids (`account:mailbox:<providerId>`) to cached mailbox rows. */
export function localMailboxIds(db: StoreDatabase, accountId: string, ids: string[]): string[] {
  const prefix = `${accountId}:mailbox:`;
  return unique(
    ids.map((id) => {
      if (!id.startsWith(prefix)) {
        return id;
      }
      let providerId: string;
      try {
        providerId = decodeURIComponent(id.slice(prefix.length));
      } catch {
        // Not an id we issued; keep it verbatim.
        return id;
      }
      const row = db.one("SELECT id FROM mailboxes WHERE account_id = ? AND provider_id = ?", [
        accountId,
        providerId,
      ]);
      return (row?.id as string | undefined) ?? id;
    }),
  );
}

/**
 * Label revalidation and body fills for cached rows. Every label write is compare-and-set against
 * the row's label token taken before the provider read, so a concurrent local write wins.
 */
export function createRevalidation(db: StoreDatabase, rows: EmailRows) {
  const applyLabels = (
    id: string,
    token: string | null,
    envelope: MailEnvelope,
    providerId?: string,
  ): void =>
    db.transaction(() => {
      const email = rows.labelToken(id) === token ? rows.getEmail(id, false) : null;
      if (email) {
        rows.saveEmail(
          {
            ...email,
            ...(providerId ? { providerId } : {}),
            keywords: envelope.keywords,
            mailboxIds: localMailboxIds(db, email.accountId, envelope.mailboxIds),
          },
          { labelsFresh: true },
        );
      }
    });
  const tombstone = (id: string, token: string | null): void =>
    db.transaction(() => {
      const email = rows.labelToken(id) === token ? rows.getEmail(id, false) : null;
      if (email) {
        rows.saveEmail(
          { ...email, keywords: { ...email.keywords, $deleted: true } },
          { labelsFresh: true },
        );
      }
    });
  /**
   * Re-finds a message whose provider id stopped resolving (IMAP UID or Graph id changed by a
   * move) by its Message-ID. Null when there is no other match, or when another cached row
   * already owns the new provider id. Reader errors propagate.
   */
  const rebind = async (
    reader: MailReader,
    email: Email,
    opts: EmailGetOptions,
  ): Promise<{ providerId: string; envelope: MailEnvelope } | null> => {
    const messageId = email.headers.messageId;
    if (!messageId) {
      return null;
    }
    const found = (await reader.findByRfc822(messageId, readOptions(opts))).value;
    if (!found || found === email.providerId || rows.rowByProvider(email.accountId, found)) {
      return null;
    }
    const envelope = (await reader.envelopes([found], readOptions(opts))).value.get(found);
    return envelope ? { providerId: found, envelope } : null;
  };
  /**
   * Revalidates one account's rows in envelope batches. Returns the ids served from cache: a
   * failed batch (rethrown when `fresh`) or a failed per-id rebind.
   */
  const refresh = async (
    reader: MailReader,
    targets: Row[],
    opts: EmailGetOptions,
  ): Promise<Set<string>> => {
    const stale = new Set<string>();
    for (let i = 0; i < targets.length; i += ENVELOPE_BATCH) {
      const chunk = targets.slice(i, i + ENVELOPE_BATCH);
      const tokens = new Map(
        chunk.map((row) => [row.id as string, rows.labelToken(row.id as string)]),
      );
      let found: Map<string, MailEnvelope | null>;
      try {
        found = (
          await reader.envelopes(
            chunk.map((row) => row.provider_id as string),
            readOptions(opts),
          )
        ).value;
      } catch (error) {
        // Offline or throttled: serve the cached rows unless the caller needs provider truth.
        if (opts.fresh) {
          throw error;
        }
        for (const row of chunk) {
          stale.add(row.id as string);
        }
        continue;
      }
      for (const row of chunk) {
        const id = row.id as string;
        const token = tokens.get(id) ?? null;
        const envelope = found.get(row.provider_id as string) ?? null;
        if (envelope) {
          applyLabels(id, token, envelope);
          continue;
        }
        const email = rows.getEmail(id, false);
        if (!email) {
          continue;
        }
        try {
          const moved = await rebind(reader, email, opts);
          if (moved) {
            applyLabels(id, token, moved.envelope, moved.providerId);
          } else {
            tombstone(id, token);
          }
        } catch {
          stale.add(id);
        }
      }
    }
    return stale;
  };
  /**
   * Fills the row's bodies. A gone provider id is rebound by Message-ID and retried once.
   * Returns false when the provider could not supply them (rethrown when `fresh`).
   */
  const fetchBody = async (
    reader: MailReader,
    id: string,
    opts: EmailGetOptions,
  ): Promise<boolean> => {
    const email = rows.getEmail(id, false);
    if (!email) {
      return false;
    }
    let body: Awaited<ReturnType<MailReader["body"]>>["value"];
    try {
      try {
        body = (await reader.body(email.providerId, readOptions(opts))).value;
      } catch (error) {
        const token = rows.labelToken(id);
        const moved = GONE.has(codeOf(error) as string) ? await rebind(reader, email, opts) : null;
        if (!moved) {
          throw error;
        }
        applyLabels(id, token, moved.envelope, moved.providerId);
        body = (await reader.body(moved.providerId, readOptions(opts))).value;
      }
    } catch (error) {
      if (opts.fresh) {
        throw error;
      }
      return false;
    }
    db.transaction(() => {
      const current = rows.getEmail(id, false);
      if (current) {
        rows.saveEmail(
          {
            ...current,
            textBody: body.textBody ?? null,
            htmlBody: body.htmlBody ?? null,
            attachments: body.attachments ?? current.attachments,
          },
          { labelsFresh: false },
        );
      }
    });
    return true;
  };
  return { refresh, fetchBody };
}
