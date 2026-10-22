import type { Email, MailRow } from "@passport/types";
import { RateLimitedError } from "./errors.js";
import { batchGetSome } from "./gmail-reader-batch.js";
import type { GmailLabelCache } from "./gmail-reader-labels.js";
import type { GmailMessage } from "./gmail-reader-normalize.js";
import {
  type GmailThread,
  type IdPage,
  type ListRequest,
  listParams,
  newestOf,
} from "./gmail-reader-query.js";
import {
  type GmailCall,
  type GmailPageState,
  gmailRow,
  metadataParams,
} from "./gmail-reader-support.js";
import { GMAIL_UNIT_COSTS as UNITS } from "./quota-presets.js";

const enc = encodeURIComponent;

/** One `search` / `list` page and where the next one starts. */
export interface GmailPage {
  items: MailRow[];
  next: GmailPageState | undefined;
  approxTotal: number | undefined;
  /** Set when quota ran out mid-hydration: the rows are a prefix and `next` resumes the rest. */
  cut?: string;
}

/**
 * One page of `messages.list` (or `threads.list`) plus batched metadata hydration. A page cut
 * short by quota keeps the hydrated rows and puts the unhydrated ids into `next` (R1-1); a page
 * that hydrated nothing rethrows the `RateLimitedError`.
 */
export async function readGmailPage(
  call: GmailCall,
  r: ListRequest & { ids?: string[] | undefined },
  labels: GmailLabelCache,
  normalize: (message: GmailMessage) => Promise<Email>,
): Promise<GmailPage> {
  let ids: string[];
  let token: string | undefined;
  let approxTotal: number | undefined;
  if (r.ids?.length) {
    ids = r.ids;
    token = r.pageToken;
  } else {
    const page = r.threads
      ? await call.get<IdPage>(`threads?${listParams(r, r.limit)}`, UNITS.threadsList)
      : await call.get<IdPage>(`messages?${listParams(r, r.limit)}`, UNITS.messagesList);
    ids = (r.threads ? (page.threads ?? []) : (page.messages ?? [])).map((m) => m.id);
    token = page.nextPageToken;
    approxTotal = page.resultSizeEstimate;
  }
  const wanted = ids.slice(0, r.limit);
  const { results, limited } = await batchGetSome<GmailThread | GmailMessage>(
    call,
    wanted.map((id) => `${r.threads ? "threads" : "messages"}/${enc(id)}?${metadataParams()}`),
    r.threads ? UNITS.threadsGetMetadata : UNITS.messagesGetMetadata,
  );
  // Messages deleted between the list and the get (null) are skipped.
  const messages = r.threads
    ? (results as Array<GmailThread | null | undefined>).flatMap((t) => {
        const newest = t?.messages ? newestOf(t.messages, r) : undefined;
        return newest ? [newest] : [];
      })
    : (results as Array<GmailMessage | null | undefined>).filter((m): m is GmailMessage =>
        Boolean(m),
      );
  const fetched = results.filter((x) => x !== undefined).length;
  if (limited && fetched === 0) {
    throw limited;
  }
  const pending = [...wanted.filter((_, i) => results[i] === undefined), ...ids.slice(r.limit)];
  const next: GmailPageState | undefined =
    pending.length > 0
      ? { ids: pending, ...(token ? { token } : {}) }
      : token
        ? { token }
        : undefined;
  const names = await labels
    .labelNames(
      call,
      messages.flatMap((m) => m.labelIds ?? []),
    )
    .catch((e: unknown) => {
      // Rows are worth more than label display names; ids name themselves.
      if (limited && e instanceof RateLimitedError) {
        return new Map<string, string>();
      }
      throw e;
    });
  const items: MailRow[] = [];
  for (const message of messages) {
    items.push(gmailRow(await normalize(message), names, message.payload?.mimeType));
  }
  return {
    items,
    next,
    approxTotal,
    ...(limited
      ? {
          cut:
            `gmail:partial (quota ran out after ${fetched} of ${wanted.length} rows; ` +
            `nextPageToken resumes in ~${limited.retryAfterSeconds}s)`,
        }
      : {}),
  };
}
