/**
 * Additive contract (v0.3): attachment downloads behind `mail_attachment_read` (research 03 §2.3
 * row 8, §2.6). Providers implement `MailReader.attachment`; the tool layer extracts text.
 * Re-exported from `./index.ts`.
 */

import type { MailReadOptions, ReadValue } from "./ondemand.js";

/** Hard download limit for one attachment (25 MiB). Larger attachments fail before download. */
export const MAIL_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** Stable error codes for attachment reads (used as `ProviderError.code`). */
export const MAIL_ATTACHMENT_ERROR_CODES = {
  /** The attachment exceeds `MAIL_ATTACHMENT_MAX_BYTES`; carries `AttachmentTooLargeDetail`. */
  ATTACHMENT_TOO_LARGE: "ATTACHMENT_TOO_LARGE",
  /**
   * The attachment has no bytes to download (a Graph `referenceAttachment` pointing at
   * OneDrive/SharePoint); carries `NotDownloadableDetail`.
   */
  NOT_DOWNLOADABLE: "NOT_DOWNLOADABLE",
  /** The reference names no attachment (none of `attachmentId`, `index`, `name`). */
  INVALID_ATTACHMENT_REF: "INVALID_ATTACHMENT_REF",
} as const;

export type MailAttachmentErrorCode =
  (typeof MAIL_ATTACHMENT_ERROR_CODES)[keyof typeof MAIL_ATTACHMENT_ERROR_CODES];

/** Detail of an `ATTACHMENT_TOO_LARGE` error. */
export interface AttachmentTooLargeDetail {
  /** Size in bytes as reported by the provider (or as downloaded). */
  size: number;
  limit: number;
}

/** Detail of a `NOT_DOWNLOADABLE` error. */
export interface NotDownloadableDetail {
  /** Host of the cloud link only (e.g. `"contoso.sharepoint.com"`), never the full URL; null when unknown. */
  cloudLink: string | null;
}

/**
 * Which attachment of a message to read. Resolution order: `attachmentId`, then `index`, then
 * `name`; at least one is required.
 */
export interface MailAttachmentRef {
  /**
   * The provider attachment id (Gmail `attachmentId` or MIME part id, Graph attachment id, IMAP
   * BODYSTRUCTURE part number, JMAP `blobId` or `partId`), or the `Attachment.id` / `blobId`
   * handle from `MailReader.body` / `thread`.
   */
  attachmentId?: string;
  /**
   * Position among the message's non-inline attachments, in manifest order (the `index` that
   * `mail_read` lists). Inline parts are addressed by `attachmentId` or `name`.
   */
  index?: number;
  /** File name: exact match first, then case-insensitive. The first match wins. */
  name?: string;
}

/** One downloaded attachment. `name`, `type` and `data` are untrusted provider data. */
export interface MailAttachmentData {
  name: string;
  /** MIME type as declared by the provider (lowercase, no parameters). */
  type: string;
  /** Decoded size in bytes (`data.byteLength`). */
  size: number;
  /** Decoded bytes (transfer encoding removed). */
  data: Uint8Array;
  /** True for `Content-Disposition: inline` / Graph `isInline` parts (embedded images). */
  inline: boolean;
  /** Content-ID without angle brackets, when the part has one. */
  contentId?: string;
}

declare module "./ondemand.js" {
  interface MailReader {
    /**
     * Downloads one attachment of the message `providerId`. Enforces `MAIL_ATTACHMENT_MAX_BYTES`
     * before downloading wherever the provider reports a size (`ATTACHMENT_TOO_LARGE`), throws
     * `NOT_DOWNLOADABLE` for cloud references, `NOT_FOUND` for an unknown message or attachment.
     * Goes through the quota governor like every read.
     */
    attachment?(
      providerId: string,
      attachmentRef: MailAttachmentRef,
      opts?: MailReadOptions,
    ): Promise<ReadValue<MailAttachmentData>>;
  }
}
