import type { MailChanges } from "@passport/types";
import { decodeCursor, encodeCursor, ProviderError } from "./errors.js";
import {
  DELTA_SELECT,
  type GraphCall,
  graphUrl,
  IMMUTABLE_ID,
  type ReaderMessage,
} from "./graph-reader-support.js";

/**
 * `MailReader.changes` over Graph message delta, one delta link per tracked folder (Inbox by
 * default). Delta does not say whether an item was created or updated: an item received after
 * the folder's previous round (minus `ARRIVAL_SKEW_MS`) is an arrival, anything else (read
 * state, categories, a move into the folder) is a label change. `@removed` items left the folder.
 */

/** Tolerates index lag between a message's receivedDateTime and its appearance in delta. */
export const ARRIVAL_SKEW_MS = 2 * 60_000;
/** Safety stop while draining the initial round (1,000 rows per page). */
const MAX_DRAIN_PAGES = 1_000;

interface FolderState {
  /** Next link to fetch: a deltaLink when `done`, otherwise a nextLink mid-round. */
  link: string;
  done: boolean;
  /** Start of the round `link` belongs to, ISO UTC. */
  at: string;
}

/** Cursor payload. `folders` keys are folder ids or well-known names, so folders can be added. */
interface GraphChangeCursor {
  account: string;
  kind: "graph-changes";
  v: 1;
  folders: Record<string, FolderState>;
}

interface DeltaPage {
  value?: ReaderMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

const prefer = (pageSize: number) => ({ Prefer: `${IMMUTABLE_ID}, odata.maxpagesize=${pageSize}` });

/** Runs a folder's initial delta round to the end without returning items ("start at now"). */
async function drain(call: GraphCall, folder: string, at: string): Promise<FolderState> {
  let link = graphUrl(`/me/mailFolders/${encodeURIComponent(folder)}/messages/delta`, {
    $select: DELTA_SELECT,
  });
  for (let pages = 0; pages < MAX_DRAIN_PAGES; pages++) {
    const page = await call.get<DeltaPage>(link, prefer(1_000));
    if (page["@odata.deltaLink"]) {
      return { link: call.transport.safeLink(page["@odata.deltaLink"]), done: true, at };
    }
    if (!page["@odata.nextLink"]) {
      throw new ProviderError("INVALID_RESPONSE", "Graph did not return a final deltaLink");
    }
    link = page["@odata.nextLink"];
  }
  throw new ProviderError("INVALID_RESPONSE", "Graph delta did not finish its initial round");
}

async function freshCursor(call: GraphCall, folders: readonly string[], at: string) {
  const state: Record<string, FolderState> = {};
  for (const folder of folders) {
    state[folder] = await drain(call, folder, at);
  }
  return encode(call.transport.accountId(), state);
}

function encode(account: string, folders: Record<string, FolderState>): string {
  return encodeCursor({
    account,
    kind: "graph-changes",
    v: 1,
    folders,
  } satisfies GraphChangeCursor);
}

function decode(cursor: string, account: string): Record<string, FolderState> {
  const c = decodeCursor<GraphChangeCursor>(cursor);
  const valid =
    c.account === account &&
    c.kind === "graph-changes" &&
    c.v === 1 &&
    c.folders &&
    typeof c.folders === "object" &&
    Object.values(c.folders).every((f) => typeof f?.link === "string" && typeof f.at === "string");
  if (!valid) {
    throw new ProviderError("INVALID_CURSOR", "Change cursor does not belong to this mailbox");
  }
  return { ...c.folders };
}

class ChangeSet {
  readonly added = new Set<string>();
  readonly changed = new Set<string>();
  readonly deleted = new Set<string>();

  apply(message: ReaderMessage, sinceMs: number): void {
    const id = message.id;
    if (message["@removed"]) {
      this.added.delete(id);
      this.changed.delete(id);
      this.deleted.add(id);
      return;
    }
    this.deleted.delete(id);
    const received = Date.parse(message.receivedDateTime ?? "");
    if (this.added.has(id)) {
      return;
    }
    if (Number.isFinite(received) && received >= sinceMs) {
      this.changed.delete(id);
      this.added.add(id);
    } else {
      this.changed.add(id);
    }
  }
}

/** Fetches one folder's changes until `budget` items were seen or its round completed. */
async function readFolder(
  call: GraphCall,
  state: FolderState,
  budget: number,
  set: ChangeSet,
  now: string,
): Promise<{ state: FolderState; seen: number }> {
  const sinceMs = Date.parse(state.at) - ARRIVAL_SKEW_MS;
  let link = state.link;
  let seen = 0;
  while (seen < budget) {
    const page = await call.get<DeltaPage>(link, prefer(Math.min(budget - seen, 200)));
    for (const message of page.value ?? []) {
      set.apply(message, sinceMs);
    }
    seen += page.value?.length ?? 0;
    if (page["@odata.deltaLink"]) {
      // Round complete: the next round classifies arrivals relative to this call.
      return {
        state: { link: call.transport.safeLink(page["@odata.deltaLink"]), done: true, at: now },
        seen,
      };
    }
    if (!page["@odata.nextLink"]) {
      throw new ProviderError("INVALID_RESPONSE", "Graph did not return a final deltaLink");
    }
    link = call.transport.safeLink(page["@odata.nextLink"]);
  }
  return { state: { link, done: false, at: state.at }, seen };
}

/** `MailReader.changes` for the folders in `tracked` (and any already in the cursor). */
export async function readChanges(
  call: GraphCall,
  cursor: string | null,
  limit: number,
  tracked: readonly string[],
): Promise<MailChanges> {
  const account = call.transport.accountId();
  const now = call.transport.now().toISOString();
  const empty = { added: [], labelChanged: [], deleted: [] };
  if (cursor === null) {
    return { ...empty, cursor: await freshCursor(call, tracked, now) };
  }
  const folders = decode(cursor, account);
  for (const folder of tracked) {
    // A folder added to the tracked set starts at "now" like a fresh cursor.
    folders[folder] ??= await drain(call, folder, now);
  }
  const set = new ChangeSet();
  let remaining = Math.max(1, Math.floor(limit));
  let unvisited = false;
  try {
    for (const [folder, state] of Object.entries(folders)) {
      if (remaining <= 0) {
        unvisited = true;
        break;
      }
      const result = await readFolder(call, state, remaining, set, now);
      folders[folder] = result.state;
      remaining -= result.seen;
    }
  } catch (error) {
    if (error instanceof ProviderError && error.status === 410) {
      return {
        ...empty,
        cursor: await freshCursor(call, Object.keys(folders), now),
        expired: true,
      };
    }
    throw error;
  }
  const hasMore = unvisited || Object.values(folders).some((f) => !f.done);
  return {
    added: [...set.added],
    labelChanged: [...set.changed],
    deleted: [...set.deleted],
    cursor: encode(account, folders),
    ...(hasMore ? { hasMore: true } : {}),
  };
}
