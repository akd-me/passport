import type { Email, MailBody } from "@passport/types";
import { ProviderError } from "./errors.js";
import { normalizeGraph } from "./graph.js";
import {
  ATTACHMENTS_EXPAND,
  ENVELOPE_SELECT,
  type GraphCall,
  graphUrl,
  PREFER_TEXT,
  type ReaderMessage,
} from "./graph-reader-support.js";
import { htmlToText } from "./normalize/index.js";

export type BodyFormat = "text" | "html";

const THREAD_SELECT = `${ENVELOPE_SELECT},body,uniqueBody`;
/** Bodies make pages heavy; Graph recommends ≤50 rows when selecting them. */
const THREAD_PAGE = 50;
const MAX_THREAD_PAGES = 10;

/** Graph returns HTML bodies by default; `text` asks Exchange to convert body and uniqueBody. */
function preferBodies(format: BodyFormat): Record<string, string> {
  return format === "text" ? { Prefer: PREFER_TEXT } : {};
}

/** Normalizes a message with bodies; `unique` prefers `uniqueBody` as the message's own text. */
async function withBodies(
  call: GraphCall,
  message: ReaderMessage,
  format: BodyFormat,
  unique: boolean,
): Promise<Email> {
  const { transport } = call;
  const email = await normalizeGraph(message, transport.accountId(), transport.verifier);
  const own = unique ? message.uniqueBody : undefined;
  if (own?.content.trim()) {
    email.textBody =
      own.contentType.toLowerCase() === "html" ? htmlToText(own.content) : own.content;
  }
  if (format === "text") {
    email.htmlBody = null;
  }
  return email;
}

/**
 * Every message of a conversation, oldest first. `$filter=conversationId` is never combined with
 * `$orderby` (Graph answers InefficientFilter), so the sort is client-side.
 */
export async function fetchThread(
  call: GraphCall,
  conversationId: string,
  format: BodyFormat,
): Promise<Email[]> {
  let link: string | undefined = graphUrl("/me/messages", {
    $filter: `conversationId eq '${conversationId.replaceAll("'", "''")}'`,
    $select: THREAD_SELECT,
    $expand: ATTACHMENTS_EXPAND,
    $top: String(THREAD_PAGE),
  });
  const messages: ReaderMessage[] = [];
  for (let pages = 0; link && pages < MAX_THREAD_PAGES; pages++) {
    const page: { value?: ReaderMessage[]; "@odata.nextLink"?: string } = await call.get(
      link,
      preferBodies(format),
    );
    messages.push(...(page.value ?? []));
    link = page["@odata.nextLink"];
  }
  if (messages.length === 0) {
    throw new ProviderError("NOT_FOUND", "Thread does not exist");
  }
  messages.sort(
    (a, b) =>
      (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? "") ||
      a.id.localeCompare(b.id),
  );
  const emails: Email[] = [];
  for (const message of messages) {
    emails.push(await withBodies(call, message, format, true));
  }
  return emails;
}

/** One message's full body (quoted history included) and attachment manifest. */
export async function fetchBody(
  call: GraphCall,
  providerId: string,
  format: BodyFormat,
): Promise<MailBody> {
  let message: ReaderMessage;
  try {
    message = await call.get<ReaderMessage>(
      graphUrl(`/me/messages/${encodeURIComponent(providerId)}`, {
        $select: "id,body,hasAttachments,internetMessageId",
        $expand: ATTACHMENTS_EXPAND,
      }),
      preferBodies(format),
    );
  } catch (error) {
    if (error instanceof ProviderError && error.status === 404) {
      throw new ProviderError("NOT_FOUND", "Message does not exist", 404);
    }
    throw error;
  }
  const email = await withBodies(call, message, format, false);
  return { textBody: email.textBody, htmlBody: email.htmlBody, attachments: email.attachments };
}
