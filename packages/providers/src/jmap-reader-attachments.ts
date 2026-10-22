import type { MailAttachmentData, MailAttachmentRef } from "@passport/types";
import { localId, ProviderError } from "./errors.js";
import type { JmapEmail } from "./jmap.js";
import { list, ok, type Send } from "./jmap-reader-query.js";
import {
  type AttachmentEntry,
  assertAttachmentSize,
  attachmentData,
  mimeType,
  pickAttachment,
  readLimited,
} from "./reader-attachments.js";

/**
 * `MailReader.attachment` over JMAP: `Email/get` with only the attachment manifest (1 request),
 * then one download of the part's `blobId` through the session's `downloadUrl` template. The
 * reader has no `rawGet`: JMAP's API is method calls, not REST paths, and `provider_get` has no
 * JMAP allowlist.
 */

/** Downloads a blob (`downloadUrl` with `{accountId}`, `{blobId}`, `{name}`, `{type}` filled in). */
export type JmapDownload = (blobId: string, name: string, type: string) => Promise<Response>;

const BODY_PROPERTIES = ["partId", "blobId", "size", "name", "type", "disposition", "cid"];

interface JmapAttachmentEntry extends AttachmentEntry {
  blobId: string;
}

export async function fetchJmapAttachment(
  send: Send,
  download: JmapDownload,
  accountId: string,
  providerId: string,
  ref: MailAttachmentRef,
): Promise<MailAttachmentData> {
  const [get] = await send([
    [
      "Email/get",
      { ids: [providerId], properties: ["id", "attachments"], bodyProperties: BODY_PROPERTIES },
    ],
  ]);
  const raw = list<JmapEmail>(ok(get, "Email/get"))[0];
  if (!raw) {
    throw new ProviderError("NOT_FOUND", "Message does not exist");
  }
  const entries = (raw.attachments ?? []).flatMap((a, i): JmapAttachmentEntry[] => {
    if (!a.blobId) {
      return [];
    }
    const keys = [a.blobId, localId(accountId, "attachment", `${raw.id}:${a.partId ?? i}`)];
    if (a.partId) {
      keys.push(a.partId);
    }
    return [
      {
        blobId: a.blobId,
        name: a.name ?? "attachment",
        type: mimeType(a.type),
        size: a.size,
        inline: a.disposition === "inline",
        contentId: a.cid ?? undefined,
        keys,
      },
    ];
  });
  const entry = pickAttachment(entries, ref);
  assertAttachmentSize(entry.size);
  let response: Response;
  try {
    response = await download(entry.blobId, entry.name, entry.type);
  } catch (e) {
    if (e instanceof ProviderError && e.status === 404) {
      throw new ProviderError("NOT_FOUND", "Attachment does not exist", 404);
    }
    throw e;
  }
  return attachmentData(entry, await readLimited(response));
}
