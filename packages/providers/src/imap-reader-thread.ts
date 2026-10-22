import type { Email } from "@passport/types";
import type { FetchMessageObject, FetchQueryObject, SearchObject } from "imapflow";
import { ProviderError } from "./errors.js";
import type { ImapMailboxes } from "./imap-reader-scan.js";
import {
  normalizeImapSource,
  parseImapIdentity,
  SERVER_THREAD_PREFIX,
} from "./imap-reader-shared.js";
import type { ImapSession } from "./imap-reader-support.js";
import type { PassportVerifier } from "./verification.js";

/** Messages fetched at most per mailbox when assembling a thread. */
export const IMAP_THREAD_CAP = 100;

export interface ImapBodyContext {
  session: ImapSession;
  accountId: string;
  verifier?: PassportVerifier | undefined;
}

/** `UID FETCH (UID FLAGS INTERNALDATE BODY.PEEK[])`, plus the server thread id when there is one. */
function sourceQuery(session: ImapSession): FetchQueryObject {
  const threads = session.ext.has("OBJECTID") || session.ext.has("X-GM-EXT-1");
  return {
    uid: true,
    flags: true,
    internalDate: true,
    source: true,
    ...(threads ? { threadId: true } : {}),
  };
}

function normalize(
  ctx: ImapBodyContext,
  message: FetchMessageObject,
  path: string,
  validity: string,
): Promise<Email> {
  return normalizeImapSource(message, {
    accountId: ctx.accountId,
    path,
    validity,
    verifier: ctx.verifier,
    serverThreadId: message.threadId,
  });
}

/** Full message by provider id. `STALE_ID` after a UIDVALIDITY change, `NOT_FOUND` if gone. */
export async function fetchImapEmail(ctx: ImapBodyContext, providerId: string): Promise<Email> {
  const [path, validity, uid] = parseImapIdentity(providerId);
  return ctx.session.select(path, async (box) => {
    if (box.validity !== validity) {
      throw new ProviderError("STALE_ID", "IMAP UIDVALIDITY changed; find the message again");
    }
    const [message] = await ctx.session.fetch([uid], sourceQuery(ctx.session));
    if (!message) {
      throw new ProviderError("NOT_FOUND", "Message does not exist");
    }
    return normalize(ctx, message, path, validity);
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
      for (const message of await session.fetch(uids, sourceQuery(session))) {
        const email = await normalize(ctx, message, path, box.validity);
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
