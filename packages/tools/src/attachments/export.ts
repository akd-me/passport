import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Email, MailAttachmentData, ReadMeta, ReadValue } from "@passport/types";
import { MAIL_ATTACHMENT_MAX_BYTES, MAIL_READ_ERROR_CODES } from "@passport/types";
import type { Context } from "../context.js";
import { neutralize } from "../ondemand-support.js";
import { ToolError } from "../presentation.js";

/** Total attachment bytes one `mail_export` call writes (200 MiB); tests lower it. */
export const exportLimits = { totalBytes: 200 * 1024 * 1024 };

/**
 * A file name that cannot leave its directory: path components, control and shell-hostile
 * characters and leading dots are removed; long names keep their extension. Empty → `fallback`.
 */
export function safeFileName(name: string, fallback = "attachment"): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  let clean = base
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}<>:"|?*]/gu, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (clean.length > 120) {
    const extension = /\.[\p{L}\p{N}]{1,10}$/u.exec(clean)?.[0] ?? "";
    clean = clean.slice(0, 120 - extension.length) + extension;
  }
  return clean || fallback;
}

export interface ExportedAttachment {
  path: string;
  messageId: string;
  name: string;
  type: string;
  size: number;
}

export interface SkippedAttachment {
  messageId: string;
  name: string;
  reason: string;
}

/** Shared across the threads of one export so the total cap holds for the whole call. */
export class AttachmentExport {
  readonly written: ExportedAttachment[] = [];
  readonly skipped: SkippedAttachment[] = [];
  private total = 0;
  private readonly root: string;

  constructor(
    private readonly ctx: Context,
    dir: string,
    private readonly metas: ReadMeta[],
  ) {
    this.root = resolve(dir, "attachments");
  }

  /** Downloads and writes the non-inline attachments of `emails` (files 0600). */
  async add(emails: Email[], tag: (email: Email) => string): Promise<void> {
    for (const email of emails) {
      const attachments = email.attachments.filter((a) => a.disposition !== "inline");
      if (!attachments.length) {
        continue;
      }
      const reader = await this.ctx.reader(email.accountId);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      for (const [index, attachment] of attachments.entries()) {
        const skip = (reason: string) =>
          this.skipped.push({ messageId: email.id, name: neutralize(attachment.name), reason });
        if (!reader.attachment) {
          skip("NOT_IMPLEMENTED");
          continue;
        }
        if (attachment.size > MAIL_ATTACHMENT_MAX_BYTES) {
          skip("ATTACHMENT_TOO_LARGE");
          continue;
        }
        if (this.total + attachment.size > exportLimits.totalBytes) {
          skip("TOTAL_LIMIT");
          continue;
        }
        let read: ReadValue<MailAttachmentData>;
        try {
          read = await reader.attachment(email.providerId, { attachmentId: attachment.id });
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (code === MAIL_READ_ERROR_CODES.RATE_LIMITED) {
            throw error;
          }
          skip(typeof code === "string" && /^[A-Z_]{1,40}$/.test(code) ? code : "DOWNLOAD_FAILED");
          continue;
        }
        this.metas.push(read);
        const { value } = read;
        if (this.total + value.size > exportLimits.totalBytes) {
          skip("TOTAL_LIMIT");
          continue;
        }
        const path = resolve(this.root, `${tag(email)}-${index}-${safeFileName(value.name)}`);
        if (dirname(path) !== this.root) {
          throw new ToolError("INVALID_PATH", "Attachment file name escaped the export directory.");
        }
        // Never write through a pre-existing file or symlink.
        await rm(path, { force: true });
        await writeFile(path, value.data, { mode: 0o600, flag: "wx" });
        this.total += value.size;
        this.written.push({
          path,
          messageId: email.id,
          name: neutralize(value.name),
          type: value.type,
          size: value.size,
        });
      }
    }
  }

  /** Result fields for `mail_export`. */
  result() {
    return {
      attachmentsDir: this.root,
      attachments: this.written,
      ...(this.skipped.length ? { skippedAttachments: this.skipped } : {}),
    };
  }
}
