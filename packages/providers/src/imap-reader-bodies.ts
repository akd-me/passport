import type { Email } from "@passport/types";
import type { FetchMessageObject, FetchQueryObject, MessageStructureObject } from "imapflow";
import { imapManifest } from "./imap-reader-attachments.js";
import { imapIdentity, normalizeImapSource } from "./imap-reader-shared.js";
import type { ImapBodyContext } from "./imap-reader-thread.js";

/**
 * Bounded body reads for `body()` and `thread()` (R1-9). A message up to `IMAP_WHOLE_BYTES` is
 * fetched whole (`BODY.PEEK[]`) as before. A larger one is never loaded whole: its BODYSTRUCTURE
 * picks the first text/plain and text/html parts, each fetched as `BODY.PEEK[<part>]<0.N>` with
 * `N = IMAP_TEXT_PART_BYTES`, and the attachment manifest comes from BODYSTRUCTURE. Attachment
 * bytes are left to `MailReader.attachment`.
 */

/** Messages up to this RFC822.SIZE are fetched whole. */
export const IMAP_WHOLE_BYTES = 1_048_576;
/** Bytes fetched per text part of a larger message. */
export const IMAP_TEXT_PART_BYTES = 1_048_576;

const BOUNDARY = "passport-text-parts";

function threadQuery(ctx: ImapBodyContext): Pick<FetchQueryObject, "threadId"> {
  const ext = ctx.session.ext;
  return ext.has("OBJECTID") || ext.has("X-GM-EXT-1") ? { threadId: true } : {};
}

/** First text/plain and text/html leaves that are bodies (not attachments), in MIME order. */
function textParts(root: MessageStructureObject): MessageStructureObject[] {
  const found = new Map<string, MessageStructureObject>();
  const walk = (node: MessageStructureObject) => {
    const type = node.type.toLowerCase();
    if (node.childNodes?.length) {
      if (type !== "message/rfc822") {
        node.childNodes.forEach(walk);
      }
      return;
    }
    const named = node.dispositionParameters?.filename ?? node.parameters?.name;
    const body = node.disposition?.toLowerCase() !== "attachment" && !named;
    if (body && (type === "text/plain" || type === "text/html") && !found.has(type)) {
      found.set(type, node);
    }
  };
  walk(root);
  return [...found.values()];
}

/** The message's own headers without its MIME framing, so a synthetic body can follow. */
function envelopeHeaders(block: Buffer): string {
  const unfolded = block.toString("latin1").replace(/\r?\n[ \t]+/g, " ");
  return unfolded
    .split(/\r?\n/)
    .filter((line) => line && !/^(content-type|content-transfer-encoding)\s*:/i.test(line))
    .join("\r\n");
}

function partBytes(message: FetchMessageObject, part: string): Buffer | undefined {
  const parts = message.bodyParts;
  return parts?.get(part) ?? parts?.get(part.toLowerCase());
}

/** A multipart/mixed message holding only the text parts (each capped), for normalizeMime. */
function synthesize(message: FetchMessageObject, parts: MessageStructureObject[]): Buffer {
  const chunks: Buffer[] = [
    Buffer.from(
      `${envelopeHeaders(message.headers ?? Buffer.alloc(0))}\r\n` +
        `Content-Type: multipart/mixed; boundary="${BOUNDARY}"\r\n\r\n`,
      "latin1",
    ),
  ];
  for (const node of parts) {
    const charset = node.parameters?.charset ?? "utf-8";
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Type: ${node.type}; charset="${charset.replace(/"/g, "")}"\r\n` +
          `Content-Transfer-Encoding: ${node.encoding ?? "7bit"}\r\n\r\n`,
        "latin1",
      ),
      partBytes(message, node.part ?? "1") ?? Buffer.alloc(0),
      Buffer.from("\r\n", "latin1"),
    );
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, "latin1"));
  return Buffer.concat(chunks);
}

/** Full emails for `uids` of the selected mailbox `path`, in the order the server returns them. */
export async function fetchEmails(
  ctx: ImapBodyContext,
  path: string,
  validity: string,
  uids: number[],
): Promise<Email[]> {
  const { session } = ctx;
  const sizes = await session.fetch(uids, { size: true, bodyStructure: true });
  const whole = sizes.filter((m) => (m.size ?? 0) <= IMAP_WHOLE_BYTES).map((m) => m.uid);
  const context = { accountId: ctx.accountId, path, validity, verifier: ctx.verifier };
  const out: Email[] = [];
  const base: FetchQueryObject = {
    uid: true,
    flags: true,
    internalDate: true,
    ...threadQuery(ctx),
  };
  for (const message of await session.fetch(whole, { ...base, source: true })) {
    out.push(await normalizeImapSource(message, { ...context, serverThreadId: message.threadId }));
  }
  for (const large of sizes.filter((m) => (m.size ?? 0) > IMAP_WHOLE_BYTES)) {
    const structure = large.bodyStructure;
    const parts = structure ? textParts(structure) : [];
    const [message] = await session.fetch([large.uid], {
      ...base,
      headers: true,
      bodyParts: parts.map((p) => ({ key: p.part ?? "1", maxLength: IMAP_TEXT_PART_BYTES })),
    });
    if (!message) {
      continue;
    }
    const email = await normalizeImapSource(
      { ...message, source: synthesize(message, parts) },
      { ...context, serverThreadId: message.threadId },
    );
    const providerId = imapIdentity(path, validity, large.uid);
    email.attachments = structure
      ? imapManifest(structure, ctx.accountId, providerId).map((entry) => ({
          id: entry.keys[1] as string,
          name: entry.name,
          type: entry.type,
          size: entry.size ?? 0,
          blobId: entry.keys[2] as string,
          disposition: entry.inline ? "inline" : "attachment",
          cid: entry.contentId ?? null,
        }))
      : [];
    email.size = large.size ?? email.size;
    out.push(email);
  }
  return out;
}
