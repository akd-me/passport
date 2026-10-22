import type { MailAttachmentData, MailAttachmentRef, RawGetResponse } from "@passport/types";
import { encodeCursor, localId, ProviderError, RateLimitedError } from "./errors.js";
import { type GraphCall, graphUrl } from "./graph-reader-support.js";
import {
  type AttachmentEntry,
  assertAttachmentSize,
  attachmentData,
  cloudLinkHost,
  NotDownloadableError,
  pickAttachment,
  readLimited,
} from "./reader-attachments.js";
import { checkRawGet, rawGetBody } from "./reader-raw-get.js";

const enc = encodeURIComponent;
const MANIFEST_SELECT = "id,name,contentType,size,isInline";
const MANIFEST_CAP = 200;
const MAX_MANIFEST_PAGES = 5;
const REFERENCE = "#microsoft.graph.referenceAttachment";
const ITEM = "#microsoft.graph.itemAttachment";

interface GraphAttachmentMeta {
  id: string;
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
  isInline?: boolean | null;
  "@odata.type"?: string;
}

interface GraphAttachmentEntry extends AttachmentEntry {
  id: string;
  odataType: string | undefined;
}

function isNotFound(e: unknown): boolean {
  return e instanceof ProviderError && e.status === 404;
}

/**
 * Attachment manifests (`GET /me/messages/{id}/attachments?$select=…`) per message, so a second
 * attachment of the same message costs one request.
 */
export class GraphManifestCache {
  private readonly manifests = new Map<string, GraphAttachmentEntry[]>();

  async load(call: GraphCall, providerId: string): Promise<GraphAttachmentEntry[]> {
    const cached = this.manifests.get(providerId);
    if (cached) {
      return cached;
    }
    const account = call.transport.accountId();
    let link: string | undefined = graphUrl(`/me/messages/${enc(providerId)}/attachments`, {
      $select: MANIFEST_SELECT,
    });
    const list: GraphAttachmentMeta[] = [];
    try {
      for (let pages = 0; link && pages < MAX_MANIFEST_PAGES; pages++) {
        const page: { value?: GraphAttachmentMeta[]; "@odata.nextLink"?: string } =
          await call.get(link);
        list.push(...(page.value ?? []));
        link = page["@odata.nextLink"];
      }
    } catch (e) {
      throw isNotFound(e) ? new ProviderError("NOT_FOUND", "Message does not exist", 404) : e;
    }
    const entries = list.map((a): GraphAttachmentEntry => {
      const odataType = a["@odata.type"];
      return {
        id: a.id,
        odataType,
        name: a.name ?? "attachment",
        type: a.contentType ?? (odataType === ITEM ? "message/rfc822" : "application/octet-stream"),
        size: typeof a.size === "number" ? a.size : undefined,
        inline: Boolean(a.isInline),
        // Same handles `normalizeGraph` assigns to `Attachment.id` / `blobId`.
        keys: [
          a.id,
          localId(account, "attachment", `${providerId}:${a.id}`),
          `graph:${encodeCursor([providerId, a.id])}`,
        ],
      };
    });
    this.manifests.set(providerId, entries);
    if (this.manifests.size > MANIFEST_CAP) {
      const oldest = this.manifests.keys().next().value;
      if (oldest !== undefined) {
        this.manifests.delete(oldest);
      }
    }
    return entries;
  }
}

/**
 * `MailReader.attachment` for Graph: the manifest (1 request, cached per message), then
 * `/attachments/{id}/$value` (1 request). `size` is checked before the download. A
 * `referenceAttachment` costs one more request to read its link host and throws
 * `NOT_DOWNLOADABLE`. Graph does not return `contentId` in the manifest, so it is omitted.
 */
export async function readGraphAttachment(
  call: GraphCall,
  cache: GraphManifestCache,
  providerId: string,
  ref: MailAttachmentRef,
): Promise<MailAttachmentData> {
  const entry = pickAttachment(await cache.load(call, providerId), ref);
  const base = `/me/messages/${enc(providerId)}/attachments/${enc(entry.id)}`;
  if (entry.odataType === REFERENCE) {
    // v1.0 omits `sourceUrl` on most tenants; report the host when it is there.
    let link: unknown;
    try {
      link = (await call.get<{ sourceUrl?: unknown }>(graphUrl(base))).sourceUrl;
    } catch (e) {
      if (e instanceof RateLimitedError) {
        throw e;
      }
    }
    throw new NotDownloadableError(cloudLinkHost(link));
  }
  assertAttachmentSize(entry.size);
  let response: Response;
  try {
    response = await call.raw(graphUrl(`${base}/$value`));
  } catch (e) {
    throw isNotFound(e) ? new ProviderError("NOT_FOUND", "Attachment does not exist", 404) : e;
  }
  return attachmentData(entry, await readLimited(response));
}

/** `MailReader.rawGet` for Graph: one allowlisted GET (1 request). */
export async function graphRawGet(
  call: GraphCall,
  path: string,
  query: Record<string, string>,
): Promise<RawGetResponse> {
  const allowed = checkRawGet("graph", path, query);
  return rawGetBody(await call.raw(graphUrl(`/${allowed}`, query)));
}
