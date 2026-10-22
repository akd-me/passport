import type { MailboxRole } from "@passport/types";
import { ProviderError } from "./errors.js";
import { GRAPH_WELL_KNOWN } from "./graph-reader-query.js";
import type { GraphScope } from "./graph-reader-rows.js";
import {
  batchError,
  type GraphCall,
  type GraphReaderTransport,
  graphUrl,
} from "./graph-reader-support.js";
import { type QueryAst, queryScopesSpamTrash } from "./query.js";
import type { GraphQueryPlan } from "./query-render.js";

// ---------------------------------------------------------------------------

export interface GraphFolderInfo {
  id: string;
  name: string;
  role: MailboxRole;
  parentId: string | null;
  total: number;
  unread: number;
}

interface RawFolder {
  id: string;
  displayName?: string;
  parentFolderId?: string;
  childFolderCount?: number;
  totalItemCount?: number;
  unreadItemCount?: number;
  /** Returned by Graph beta; v1.0 roles come from well-known folder lookups. */
  wellKnownName?: string;
}

/** Graph well-known folder name → Passport role. */
export const WELL_KNOWN_ROLES: Readonly<Record<string, MailboxRole>> = {
  inbox: "inbox",
  archive: "archive",
  drafts: "drafts",
  sentitems: "sent",
  deleteditems: "trash",
  junkemail: "junk",
};

const FOLDER_SELECT =
  "id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount";

/** Resolves well-known folder ids in one `$batch` (absent folders, e.g. archive, are skipped). */
export async function loadRoleIds(call: GraphCall): Promise<Map<string, MailboxRole>> {
  const names = Object.keys(WELL_KNOWN_ROLES);
  const responses = await call.batch(
    names.map((name) => ({ id: name, url: `/me/mailFolders/${name}?$select=id` })),
  );
  const roles = new Map<string, MailboxRole>();
  for (const name of names) {
    const inner = responses.get(name);
    const id = (inner?.body as { id?: unknown } | undefined)?.id;
    if (inner && inner.status < 300 && typeof id === "string") {
      roles.set(id, WELL_KNOWN_ROLES[name] ?? null);
    } else if (inner && inner.status !== 404) {
      throw batchError(inner);
    }
  }
  return roles;
}

/** The whole folder tree: top-level folders, then `childFolders` breadth-first. */
export async function loadFolderTree(
  call: GraphCall,
  roleIds: ReadonlyMap<string, MailboxRole>,
): Promise<Map<string, GraphFolderInfo>> {
  const out = new Map<string, GraphFolderInfo>();
  const queue = [graphUrl("/me/mailFolders", { $top: "250", $select: FOLDER_SELECT })];
  for (let link = queue.shift(); link; link = queue.shift()) {
    const page = await call.get<{ value?: RawFolder[]; "@odata.nextLink"?: string }>(link);
    for (const f of page.value ?? []) {
      out.set(f.id, {
        id: f.id,
        name: f.displayName ?? f.id,
        role: roleIds.get(f.id) ?? WELL_KNOWN_ROLES[f.wellKnownName?.toLowerCase() ?? ""] ?? null,
        parentId: f.parentFolderId && f.parentFolderId !== f.id ? f.parentFolderId : null,
        total: f.totalItemCount ?? 0,
        unread: f.unreadItemCount ?? 0,
      });
      if ((f.childFolderCount ?? 0) > 0) {
        const path = `/me/mailFolders/${encodeURIComponent(f.id)}/childFolders`;
        queue.push(graphUrl(path, { $top: "250", $select: FOLDER_SELECT }));
      }
    }
    if (page["@odata.nextLink"]) {
      queue.unshift(page["@odata.nextLink"]);
    }
  }
  // Top-level folders hang off the hidden root; only parents we know are kept.
  for (const folder of out.values()) {
    if (folder.parentId && !out.has(folder.parentId)) {
      folder.parentId = null;
    }
  }
  return out;
}

/**
 * Per-reader folder knowledge: well-known folder ids (fetched once) and the folder tree used for
 * row labels and container resolution (reused for `cacheMs`).
 */
export class GraphFolderCache {
  private roles?: Map<string, MailboxRole>;
  private cached?: { at: number; folders: Map<string, GraphFolderInfo> };
  constructor(
    private readonly transport: GraphReaderTransport,
    private readonly cacheMs = 5 * 60_000,
  ) {}

  async roleIds(call: GraphCall): Promise<Map<string, MailboxRole>> {
    this.roles ??= await loadRoleIds(call);
    return this.roles;
  }

  async tree(call: GraphCall, fresh = false): Promise<Map<string, GraphFolderInfo>> {
    const now = this.transport.now().getTime();
    if (fresh || !this.cached || now - this.cached.at > this.cacheMs) {
      const roles = await this.roleIds(call);
      this.cached = { at: now, folders: await loadFolderTree(call, roles) };
    }
    return this.cached.folders;
  }

  /** Resolves a folder id, display name, role, well-known name or mailbox handle to an id. */
  async resolveFolder(call: GraphCall, container: string): Promise<string> {
    const lower = container.toLowerCase();
    const wellKnown = GRAPH_WELL_KNOWN[lower === "junk" ? "spam" : lower] ?? lower;
    const role = WELL_KNOWN_ROLES[wellKnown];
    if (role) {
      for (const [id, r] of await this.roleIds(call)) {
        if (r === role) {
          return id;
        }
      }
      throw new ProviderError("NOT_FOUND", "Label or folder does not exist");
    }
    const prefix = `${this.transport.accountId()}:mailbox:`;
    const wanted = container.startsWith(prefix)
      ? decodeURIComponent(container.slice(prefix.length))
      : container;
    const folders = await this.tree(call);
    const found =
      folders.get(wanted) ??
      [...folders.values()].find((f) => f.name.toLowerCase() === wanted.toLowerCase());
    if (!found) {
      throw new ProviderError("NOT_FOUND", "Label or folder does not exist");
    }
    return found.id;
  }

  async scope(
    call: GraphCall,
    plan: GraphQueryPlan,
    container: string | null,
    ast: QueryAst,
    includeSpamTrash: boolean,
  ): Promise<GraphScope> {
    const fromContainer = container ? await this.resolveFolder(call, container) : null;
    const fromQuery = plan.folder ? await this.resolveFolder(call, plan.folder) : null;
    const folderId = fromContainer ?? fromQuery;
    const hidden = new Set<string>();
    if (!folderId && !includeSpamTrash && !queryScopesSpamTrash(ast)) {
      for (const [id, role] of await this.roleIds(call)) {
        if (role === "junk" || role === "trash") {
          hidden.add(id);
        }
      }
    }
    // A Graph message lives in exactly one folder.
    const empty = Boolean(fromContainer && fromQuery && fromContainer !== fromQuery);
    return { folderId, hidden, empty };
  }
}
