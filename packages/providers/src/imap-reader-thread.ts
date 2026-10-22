import type { Email } from "@passport/types";
import type { SearchObject } from "imapflow";
import { ProviderError } from "./errors.js";
import { fetchEmails } from "./imap-reader-bodies.js";
import type { ImapMailboxes, ImapReaderHost } from "./imap-reader-mailboxes.js";
import { imapIdentity, parseImapIdentity, SERVER_THREAD_PREFIX } from "./imap-reader-shared.js";
import type { ImapSession } from "./imap-reader-support.js";
import type { PassportVerifier } from "./verification.js";

/** Messages fetched at most per mailbox when assembling a thread. */
export const IMAP_THREAD_CAP = 100;

export interface ImapBodyContext {
  session: ImapSession;
  accountId: string;
  verifier?: PassportVerifier | undefined;
}

/** Full message by provider id. `STALE_ID` after a UIDVALIDITY change, `NOT_FOUND` if gone. */
export async function fetchImapEmail(ctx: ImapBodyContext, providerId: string): Promise<Email> {
  const [path, validity, uid] = parseImapIdentity(providerId);
  return ctx.session.select(path, async (box) => {
    if (box.validity !== validity) {
      throw new ProviderError("STALE_ID", "IMAP UIDVALIDITY changed; find the message again");
    }
    const [email] = await fetchEmails(ctx, path, validity, [uid]);
    if (!email) {
      throw new ProviderError("NOT_FOUND", "Message does not exist");
    }
    return email;
  });
}

/**
 * Thread members, unsorted. A message identity (`imap:…`) is a one-message thread. A server
 * thread id (`thrid:…`) searches `THREADID` / `X-GM-THRID`; any other id is the root Message-ID,
 * joined across INBOX + Sent + Archive with `SEARCH HEADER Message-ID / References /
 * In-Reply-To` (THREAD=REFERENCES is per mailbox and would miss replies in Sent). Duplicate
 * copies of one Message-ID are returned once, the first mailbox winning.
 */
export async function fetchImapThread(
  ctx: ImapBodyContext,
  mailboxes: ImapMailboxes,
  threadId: string,
  gmail: boolean,
): Promise<Email[]> {
  if (threadId.startsWith("imap:")) {
    return [await fetchImapEmail(ctx, threadId)];
  }
  const query: SearchObject = threadId.startsWith(SERVER_THREAD_PREFIX)
    ? { threadId: threadId.slice(SERVER_THREAD_PREFIX.length) }
    : {
        or: [
          { header: { "message-id": threadId } },
          { header: { references: threadId } },
          { header: { "in-reply-to": threadId } },
        ],
      };
  const { session } = ctx;
  const specs = gmail ? ["\\All"] : ["INBOX", "\\Sent", "\\Archive"];
  const seen = new Set<string>();
  const emails: Email[] = [];
  for (const path of await mailboxes.resolveAll(session, specs)) {
    await session.select(path, async (box) => {
      const uids = (await session.uids({ query })).slice(0, IMAP_THREAD_CAP);
      for (const email of await fetchEmails(ctx, path, box.validity, uids)) {
        const key = email.headers.messageId ?? email.providerId;
        if (!seen.has(key)) {
          seen.add(key);
          emails.push(email);
        }
      }
    });
  }
  return emails;
}

/** Provider id for a Message-ID: received copies first, the Sent copy last (duplicates). */
export async function findImapByRfc822(
  session: ImapSession,
  mailboxes: ImapMailboxes,
  host: Pick<ImapReaderHost, "moveTargets">,
  rfc822Id: string,
): Promise<string | null> {
  const header = `<${rfc822Id.trim().replace(/^<|>$/g, "")}>`;
  const boxes: string[] = [];
  for (const spec of ["INBOX", "\\Archive", ...host.moveTargets(), "\\Sent"]) {
    const path = await mailboxes.resolve(session, spec);
    if (path && !boxes.includes(path)) {
      boxes.push(path);
    }
  }
  for (const path of boxes) {
    const found = await session.select(path, async (box) => {
      const uids = await session.uids({ query: { header: { "message-id": header } } });
      return uids[0] ? imapIdentity(box.path, box.validity, uids[0]) : null;
    });
    if (found) {
      return found;
    }
  }
  return null;
}
