import {
  type AttachmentTooLargeDetail,
  MAIL_ATTACHMENT_ERROR_CODES,
  MAIL_ATTACHMENT_MAX_BYTES,
  type MailAttachmentData,
  type MailAttachmentRef,
  type NotDownloadableDetail,
} from "@passport/types";
import { ProviderError } from "./errors.js";

/**
 * Shared pieces of `MailReader.attachment` (research 03 §2.3 row 8, §2.6): typed errors, the
 * attachment-reference resolution every reader uses, and the 25 MiB limit.
 */

/** The attachment is larger than `MAIL_ATTACHMENT_MAX_BYTES`. Raised before download when possible. */
export class AttachmentTooLargeError extends ProviderError {
  constructor(
    public readonly size: number,
    public readonly limit: number = MAIL_ATTACHMENT_MAX_BYTES,
  ) {
    super(
      MAIL_ATTACHMENT_ERROR_CODES.ATTACHMENT_TOO_LARGE,
      `Attachment is ${size} bytes; the download limit is ${limit} bytes`,
    );
    this.name = "AttachmentTooLargeError";
  }
  get detail(): AttachmentTooLargeDetail {
    return { size: this.size, limit: this.limit };
  }
}

/** The attachment has no downloadable bytes (Graph `referenceAttachment`). */
export class NotDownloadableError extends ProviderError {
  constructor(
    /** Host of the cloud link only, never the full URL; null when the provider omits it. */
    public readonly cloudLink: string | null,
  ) {
    super(
      MAIL_ATTACHMENT_ERROR_CODES.NOT_DOWNLOADABLE,
      `Attachment is a cloud link${cloudLink ? ` on ${cloudLink}` : ""}; open it in its service`,
    );
    this.name = "NotDownloadableError";
  }
  get detail(): NotDownloadableDetail {
    return { cloudLink: this.cloudLink };
  }
}

/** The host of a cloud-link URL, or null for anything that is not an http(s) URL. */
export function cloudLinkHost(url: unknown): string | null {
  if (typeof url !== "string") {
    return null;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.host : null;
  } catch {
    // Not a URL: report no host rather than echoing provider text.
    return null;
  }
}

/** One attachment of a message's manifest, in the order `MailReader.body` lists them. */
export interface AttachmentEntry {
  name: string;
  type: string;
  /** Provider-reported size in bytes; undefined when unknown. */
  size: number | undefined;
  inline: boolean;
  contentId?: string | undefined;
  /** Every id that addresses this entry (provider id, part id, `Attachment.id`, `blobId`). */
  keys: readonly string[];
}

/** Lowercase MIME type without parameters. */
export function mimeType(type: string | undefined | null): string {
  return (type ?? "").split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
}

/** Content-ID without angle brackets; undefined when empty. */
export function contentIdOf(cid: string | undefined | null): string | undefined {
  const value = cid?.trim().replace(/^<|>$/g, "");
  return value ? value : undefined;
}

/**
 * Picks the entry `ref` names: `attachmentId` (any of the entry's keys), else `index` among
 * non-inline entries, else `name` (exact, then case-insensitive). Throws
 * `INVALID_ATTACHMENT_REF` for an empty reference and `NOT_FOUND` when nothing matches.
 */
export function pickAttachment<T extends AttachmentEntry>(
  entries: readonly T[],
  ref: MailAttachmentRef,
): T {
  let found: T | undefined;
  if (ref.attachmentId !== undefined && ref.attachmentId !== "") {
    const id = ref.attachmentId;
    found = entries.find((entry) => entry.keys.includes(id));
  } else if (ref.index !== undefined) {
    if (!Number.isInteger(ref.index) || ref.index < 0) {
      throw invalidRef("Attachment index must be a non-negative integer");
    }
    found = entries.filter((entry) => !entry.inline)[ref.index];
  } else if (ref.name !== undefined && ref.name.trim() !== "") {
    const name = ref.name.trim();
    found =
      entries.find((entry) => entry.name === name) ??
      entries.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  } else {
    throw invalidRef("Name the attachment by attachmentId, index or name");
  }
  if (!found) {
    throw new ProviderError("NOT_FOUND", "Attachment does not exist", 404);
  }
  return found;
}

function invalidRef(message: string): ProviderError {
  return new ProviderError(MAIL_ATTACHMENT_ERROR_CODES.INVALID_ATTACHMENT_REF, message);
}

/** Throws `ATTACHMENT_TOO_LARGE` when a known size exceeds the limit. */
export function assertAttachmentSize(size: number | undefined): void {
  if (size !== undefined && Number.isFinite(size) && size > MAIL_ATTACHMENT_MAX_BYTES) {
    throw new AttachmentTooLargeError(size);
  }
}

/**
 * Upper bound of the decoded size of a transfer-encoded part (IMAP BODYSTRUCTURE reports the
 * encoded size): base64 shrinks by 3/4, everything else is at most its encoded size.
 */
export function decodedSizeBound(encodedSize: number | undefined, encoding: string | undefined) {
  if (encodedSize === undefined) {
    return undefined;
  }
  return encoding?.toLowerCase() === "base64" ? Math.floor((encodedSize * 3) / 4) : encodedSize;
}

/** Builds the result value, re-checking the limit against the downloaded bytes. */
export function attachmentData(entry: AttachmentEntry, data: Uint8Array): MailAttachmentData {
  assertAttachmentSize(data.byteLength);
  const value: MailAttachmentData = {
    name: entry.name,
    type: mimeType(entry.type),
    size: data.byteLength,
    data,
    inline: entry.inline,
  };
  const cid = contentIdOf(entry.contentId);
  if (cid) {
    value.contentId = cid;
  }
  return value;
}

/** Reads a download, failing with `ATTACHMENT_TOO_LARGE` once it passes the limit. */
export async function readLimited(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 0) {
    assertAttachmentSize(declared);
  }
  if (!response.body) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAIL_ATTACHMENT_MAX_BYTES) {
      await reader.cancel();
      throw new AttachmentTooLargeError(total);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
