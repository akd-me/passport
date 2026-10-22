import { dirname, resolve } from "node:path";
import type {
  Attachment,
  Email,
  MailAttachmentData,
  MailReader,
  ReadMeta,
  ReadValue,
} from "@passport/types";
import { MAIL_ATTACHMENT_MAX_BYTES, MAIL_READ_ERROR_CODES } from "@passport/types";
import type { Context } from "../context.js";
import { neutralize } from "../ondemand-support.js";
import { ToolError } from "../presentation.js";
import { privateDir, writeNew } from "../scratch-fs.js";

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
  private ready: Promise<string> | null = null;

  constructor(
    private readonly ctx: Context,
    private readonly dir: string,
    private readonly metas: ReadMeta[],
    /** Real path of the scratch root; `attachments/` must resolve inside it. */
    private readonly realRoot: string,
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
      // A real 0700 directory, never a planted symlink (R4-2).
      this.ready ??= privateDir(this.dir, "attachments", this.realRoot);
      await this.ready;
      for (const [index, attachment] of attachments.entries()) {
        const reason = await this.write(reader, email, attachment, `${tag(email)}-${index}`);
        if (reason) {
          this.skipped.push({ messageId: email.id, name: neutralize(attachment.name), reason });
        }
      }
    }
  }

  /** Downloads and writes one attachment; returns the reason it was skipped, if it was. */
  private async write(
    reader: MailReader,
    email: Email,
    attachment: Attachment,
    prefix: string,
  ): Promise<string | null> {
    if (!reader.attachment) {
      return "NOT_IMPLEMENTED";
    }
    if (attachment.size > MAIL_ATTACHMENT_MAX_BYTES) {
      return "ATTACHMENT_TOO_LARGE";
    }
    if (this.total + attachment.size > exportLimits.totalBytes) {
      return "TOTAL_LIMIT";
    }
    let read: ReadValue<MailAttachmentData>;
    try {
      read = await reader.attachment(email.providerId, { attachmentId: attachment.id });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === MAIL_READ_ERROR_CODES.RATE_LIMITED) {
        throw error;
      }
      return typeof code === "string" && /^[A-Z_]{1,40}$/.test(code) ? code : "DOWNLOAD_FAILED";
    }
    this.metas.push(read);
    const { value } = read;
    if (this.total + value.size > exportLimits.totalBytes) {
      return "TOTAL_LIMIT";
    }
    const path = resolve(this.root, `${prefix}-${safeFileName(value.name)}`);
    if (dirname(path) !== this.root) {
      throw new ToolError("INVALID_PATH", "Attachment file name escaped the export directory.");
    }
    // Never write through a pre-existing file or symlink.
    await writeNew(path, value.data);
    this.total += value.size;
    this.written.push({
      path,
      messageId: email.id,
      name: neutralize(value.name),
      type: value.type,
      size: value.size,
    });
    return null;
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
