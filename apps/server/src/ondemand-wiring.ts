/**
 * Adapters for v0.3 on-demand options that other packages add in parallel (store read-through,
 * label cache, tool registry / MCP / agent `readers`). Every name owned by another package is
 * referenced only here, behind feature checks, so this branch typechecks on its own and a merge
 * fixes names in one place.
 */
import { join } from "node:path";
import { sweepScratchDir } from "@passport/mcp";
import {
  type Email,
  type Mailbox,
  type MailLabel,
  type MailReaderResolver,
  parseMailHandle,
  type Store,
  type TimeRange,
} from "@passport/types";

/** MCP output budget (~16k tokens); research 03 §5.5. The built-in agent keeps its default. */
export const MCP_RESPONSE_BYTE_BUDGET = 64 * 1024;

/** `Store.setMailReaderResolver?(resolver)` enables read-through `emails.get`. */
export function installReaderResolver(store: Store, readers: MailReaderResolver): void {
  store.setMailReaderResolver?.(readers);
}

/**
 * `Store.mailboxes.refreshFromLabels?(accountId, labels)`. Stores without it get mailbox rows
 * keyed like adapter mailbox ids so policy destination checks keep working.
 */
export async function refreshLabelCache(
  store: Store,
  accountId: string,
  labels: MailLabel[],
): Promise<void> {
  if (store.mailboxes.refreshFromLabels) {
    await store.mailboxes.refreshFromLabels(accountId, labels);
    return;
  }
  const id = (providerId: string) => `${accountId}:mailbox:${encodeURIComponent(providerId)}`;
  const existing = new Map(
    (await store.mailboxes.list(accountId)).map((box) => [box.providerId, box]),
  );
  await store.mailboxes.upsertMany(
    labels.map(
      (label): Mailbox => ({
        // v0.2 rows keep their ids so cached mail stays linked.
        id: existing.get(label.id)?.id ?? id(label.id),
        accountId,
        providerId: label.id,
        name: label.name,
        role: label.role ?? null,
        parentId: label.parentId ? (existing.get(label.parentId)?.id ?? id(label.parentId)) : null,
        totalEmails: label.counts?.total ?? existing.get(label.id)?.totalEmails ?? 0,
        unreadEmails: label.counts?.unread ?? existing.get(label.id)?.unreadEmails ?? 0,
      }),
    ),
  );
}

/** A cached row by provider id, never a provider round trip. */
export function cachedEmail(store: Store, accountId: string, providerId: string) {
  return store.emails.getByProviderId(accountId, providerId, { cacheOnly: true });
}

/**
 * `GET /api/emails/:id` and triage: the read-through get, then (before the store's read-through
 * lands, or for handles it does not resolve) a direct envelope + body read.
 */
export async function readEmail(
  store: Store,
  readers: MailReaderResolver | undefined,
  id: string,
): Promise<Email | null> {
  const cached = await store.emails.get(id, { includeBodies: true, lane: "interactive" });
  const handle = parseMailHandle(id);
  if (cached || !readers || handle?.type !== "email") {
    return cached;
  }
  const reader = await readers(handle.accountId);
  if (!reader) {
    return null;
  }
  const envelope = (await reader.envelopes([handle.providerId])).value.get(handle.providerId);
  if (!envelope) {
    return null;
  }
  const body = (await reader.body(handle.providerId)).value;
  return { ...envelope, ...body };
}

/** Options the tools agent adds to `createToolRegistry` (not yet in `ToolRegistryOptions`). */
export interface ToolReaderOptions {
  readers?: MailReaderResolver;
  scratchDir?: string;
}
/** `createMailboxMcpServer({ readers, scratchDir, responseByteBudget })`. */
export interface McpReaderOptions extends ToolReaderOptions {
  responseByteBudget?: number;
}

export function scratchDirFor(dataDir: string): string {
  return join(dataDir, "scratch");
}

export function toolReaderOptions(readers: MailReaderResolver, dataDir: string): ToolReaderOptions {
  return { readers, scratchDir: scratchDirFor(dataDir) };
}

/** Removes `mail_export` sessions older than 24 h (startup and `tasks.maintenance`, R4-14). */
export async function sweepExports(dataDir: string): Promise<number> {
  return (await sweepScratchDir(scratchDirFor(dataDir))).length;
}

/** MCP dependencies plus the on-demand options; extra keys are ignored until the tools agent lands. */
export function withMcpReaders<T extends object>(
  deps: T,
  readers: MailReaderResolver,
  dataDir: string,
): T & McpReaderOptions {
  return {
    ...deps,
    ...toolReaderOptions(readers, dataDir),
    responseByteBudget: MCP_RESPONSE_BYTE_BUDGET,
  };
}

/** `FreeBusyResolver` from `@passport/tools`: null means no connected calendar for the account. */
export type FreeBusy = (accountId: string, range: TimeRange) => Promise<TimeRange[] | null>;
