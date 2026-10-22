import type { MailAttachmentData, MailAttachmentRef, RawGetResponse } from "@passport/types";
import { ProviderError } from "./errors.js";
import { GMAIL_API_BASE, type GmailMessage, gmailAttachments } from "./gmail-reader-normalize.js";
import { type GmailCall, isNotFound } from "./gmail-reader-support.js";
import { GMAIL_UNIT_COSTS as UNITS } from "./quota-presets.js";
import {
  type AttachmentEntry,
  assertAttachmentSize,
  attachmentData,
  pickAttachment,
} from "./reader-attachments.js";
import { checkRawGet, gmailRawGetUnits, rawGetBody } from "./reader-raw-get.js";

const enc = encodeURIComponent;
/** Part manifests kept per reader (oldest evicted first). */
const MANIFEST_CAP = 200;

interface GmailAttachmentEntry extends AttachmentEntry {
  /** Gmail attachment id; absent when the bytes are inline in the part (`body.data`). */
  attachmentId?: string | undefined;
  data?: string | undefined;
}

/**
 * Part manifests of messages this reader has seen in `format=full` (`body`, `thread`,
 * `attachment`), so an attachment named by index or name costs one `attachments.get` (20 units).
 */
export class GmailManifestCache {
  private readonly manifests = new Map<string, GmailAttachmentEntry[]>();

  /** Records the manifest of a `format=full` message. */
  remember(message: GmailMessage, accountId: string): GmailAttachmentEntry[] {
    const entries = gmailAttachments(message, accountId).map(({ attachment, part }) => {
      const keys = [attachment.id, attachment.blobId];
      if (part.partId) {
        keys.push(part.partId);
      }
      if (part.body?.attachmentId) {
        keys.push(part.body.attachmentId);
      }
      return {
        name: attachment.name,
        type: attachment.type,
        size: part.body?.size,
        inline: attachment.disposition === "inline",
        contentId: attachment.cid ?? undefined,
        keys,
        attachmentId: part.body?.attachmentId,
        data: part.body?.attachmentId ? undefined : part.body?.data,
      };
    });
    this.manifests.delete(message.id);
    this.manifests.set(message.id, entries);
    if (this.manifests.size > MANIFEST_CAP) {
      const oldest = this.manifests.keys().next().value;
      if (oldest !== undefined) {
        this.manifests.delete(oldest);
      }
    }
    return entries;
  }

  get(messageId: string): GmailAttachmentEntry[] | undefined {
    return this.manifests.get(messageId);
  }
}

/**
 * `MailReader.attachment` for Gmail: the part manifest (cached, else one `messages.get` full at
 * 60 units — `format=metadata` has no MIME tree), then `messages.attachments.get` (20 units)
 * unless the bytes are inline in the part. The size limit is checked against the part size first.
 */
export async function readGmailAttachment(
  call: GmailCall,
  cache: GmailManifestCache,
  accountId: string,
  providerId: string,
  ref: MailAttachmentRef,
): Promise<MailAttachmentData> {
  let entries = cache.get(providerId);
  if (!entries) {
    let message: GmailMessage;
    try {
      message = await call.get<GmailMessage>(
        `messages/${enc(providerId)}?format=full`,
        UNITS.messagesGetFull,
      );
    } catch (e) {
      throw isNotFound(e) ? new ProviderError("NOT_FOUND", "Message does not exist", 404) : e;
    }
    entries = cache.remember(message, accountId);
  }
  const entry = pickAttachment(entries, ref);
  assertAttachmentSize(entry.size);
  let data = entry.data;
  if (entry.attachmentId) {
    try {
      data = (
        await call.get<{ data?: unknown }>(
          `messages/${enc(providerId)}/attachments/${enc(entry.attachmentId)}`,
          UNITS.attachmentsGet,
        )
      ).data as string | undefined;
    } catch (e) {
      throw isNotFound(e) ? new ProviderError("NOT_FOUND", "Attachment does not exist", 404) : e;
    }
  }
  if (typeof data !== "string") {
    throw new ProviderError("INVALID_RESPONSE", "Gmail omitted the attachment data");
  }
  return attachmentData(entry, new Uint8Array(Buffer.from(data, "base64url")));
}

/** `MailReader.rawGet` for Gmail: one allowlisted GET priced by `gmailRawGetUnits`. */
export async function gmailRawGet(
  call: GmailCall,
  path: string,
  query: Record<string, string>,
): Promise<RawGetResponse> {
  const allowed = checkRawGet("gmail", path, query);
  const search = new URLSearchParams(query).toString();
  const url = `${GMAIL_API_BASE}/${allowed.replace(/^users\/me\//, "")}${search ? `?${search}` : ""}`;
  return rawGetBody(await call.send(url, { method: "GET" }, gmailRawGetUnits(allowed, query)));
}
