import type { MailAttachmentData, MailAttachmentRef } from "@passport/types";
import type { MessageStructureObject } from "imapflow";
import { localId, ProviderError } from "./errors.js";
import { parseImapIdentity } from "./imap-reader-shared.js";
import type { ImapBodyContext } from "./imap-reader-thread.js";
import {
  type AttachmentEntry,
  assertAttachmentSize,
  attachmentData,
  decodedSizeBound,
  mimeType,
  pickAttachment,
} from "./reader-attachments.js";

/**
 * `MailReader.attachment` over IMAP: `UID FETCH (BODYSTRUCTURE)`, then `UID FETCH
 * (BODY.PEEK[<part>])` for the one part, decoded locally (base64 / quoted-printable). The
 * reader has no `rawGet`: IMAP has no REST surface, and raw commands cannot be limited to reads.
 */

interface ImapPartEntry extends AttachmentEntry {
  part: string;
  encoding: string | undefined;
}

const BODY_TYPES = new Set(["text/plain", "text/html"]);

function filenameOf(node: MessageStructureObject): string | undefined {
  return node.dispositionParameters?.filename ?? node.parameters?.name ?? undefined;
}

/**
 * Attachment leaves in MIME order: anything with `Content-Disposition: attachment`, a file name,
 * or a type other than the text bodies (the same parts mailparser lists, so `index` agrees with
 * `MailReader.body`). An embedded `message/rfc822` is one attachment.
 */
function leaves(node: MessageStructureObject, out: MessageStructureObject[]): void {
  const type = node.type.toLowerCase();
  if (node.childNodes?.length && type !== "message/rfc822") {
    for (const child of node.childNodes) {
      leaves(child, out);
    }
    return;
  }
  if (
    node.disposition?.toLowerCase() === "attachment" ||
    filenameOf(node) ||
    !BODY_TYPES.has(type)
  ) {
    out.push(node);
  }
}

/** The manifest, keyed by part number and by the `Attachment.id` / `blobId` that `body` assigns. */
export function imapManifest(
  structure: MessageStructureObject,
  accountId: string,
  providerId: string,
): ImapPartEntry[] {
  const found: MessageStructureObject[] = [];
  leaves(structure, found);
  return found.map((node, index) => {
    const part = node.part ?? "1";
    return {
      part,
      encoding: node.encoding,
      name: filenameOf(node) ?? "attachment",
      type: mimeType(node.type),
      size: decodedSizeBound(node.size, node.encoding),
      inline: node.disposition?.toLowerCase() === "inline",
      contentId: node.id,
      keys: [
        part,
        localId(accountId, "attachment", `${providerId}:${index}`),
        `mime:${Buffer.from(JSON.stringify([providerId, index])).toString("base64url")}`,
      ],
    };
  });
}

/** Decodes quoted-printable bytes (RFC 2045 §6.7). */
export function decodeQuotedPrintable(raw: Uint8Array): Uint8Array {
  const text = Buffer.from(raw)
    .toString("latin1")
    .replace(/=\r?\n/g, "");
  const out = Buffer.alloc(text.length);
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const hex = text[i] === "=" ? text.slice(i + 1, i + 3) : "";
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out[length++] = Number.parseInt(hex, 16);
      i += 2;
    } else {
      out[length++] = text.charCodeAt(i) & 0xff;
    }
  }
  return new Uint8Array(out.subarray(0, length));
}

function decode(raw: Uint8Array, encoding: string | undefined): Uint8Array {
  switch (encoding?.toLowerCase()) {
    case "base64":
      return new Uint8Array(Buffer.from(Buffer.from(raw).toString("latin1"), "base64"));
    case "quoted-printable":
      return decodeQuotedPrintable(raw);
    default:
      return new Uint8Array(raw);
  }
}

/** One attachment by provider id. `STALE_ID` after a UIDVALIDITY change, `NOT_FOUND` if gone. */
export async function fetchImapAttachment(
  ctx: ImapBodyContext,
  providerId: string,
  ref: MailAttachmentRef,
): Promise<MailAttachmentData> {
  const [path, validity, uid] = parseImapIdentity(providerId);
  const { session } = ctx;
  return session.select(path, async (box) => {
    if (box.validity !== validity) {
      throw new ProviderError("STALE_ID", "IMAP UIDVALIDITY changed; find the message again");
    }
    const [message] = await session.fetch([uid], { bodyStructure: true });
    if (!message?.bodyStructure) {
      throw new ProviderError("NOT_FOUND", "Message does not exist");
    }
    const entry = pickAttachment(
      imapManifest(message.bodyStructure, ctx.accountId, providerId),
      ref,
    );
    assertAttachmentSize(entry.size);
    const [fetched] = await session.fetch([uid], { bodyParts: [entry.part] });
    const raw =
      fetched?.bodyParts?.get(entry.part) ?? fetched?.bodyParts?.get(entry.part.toLowerCase());
    if (!raw) {
      throw new ProviderError("NOT_FOUND", "Attachment does not exist");
    }
    return attachmentData(entry, decode(raw, entry.encoding));
  });
}
