/**
 * Adapters for v0.3 on-demand options that other packages add in parallel (store read-through,
 * label cache, tool registry / MCP / agent `readers`). Every name owned by another package is
 * referenced only here, behind feature checks, so this branch typechecks on its own and a merge
 * fixes names in one place.
 */
import { join } from "node:path";
import {
  type Email,
  type Mailbox,
  type MailLabel,
  type MailReader,
  type MailReaderResolver,
  parseMailHandle,
  type Store,
  type TimeRange,
} from "@passport/types";

/** MCP output budget (~16k tokens); research 03 §5.5. The built-in agent keeps its default. */
export const MCP_RESPONSE_BYTE_BUDGET = 64 * 1024;

interface OnDemandStore {
  setMailReaderResolver?(resolver: MailReaderResolver): void;
}
interface OnDemandMailboxes {
  refreshFromLabels?(accountId: string, labels: MailLabel[]): Promise<void>;
}
type ReadOptions = { includeBodies?: boolean; fresh?: boolean };
type ReadThroughGet = (id: string, opts?: ReadOptions) => Promise<Email | null>;

/** Store agent: `Store.setMailReaderResolver?(resolver)` enables read-through `emails.get`. */
export function installReaderResolver(store: Store, readers: MailReaderResolver): void {
  (store as Store & OnDemandStore).setMailReaderResolver?.(readers);
}

/**
 * Store agent: `Store.mailboxes.refreshFromLabels?(accountId, labels)`. Until it exists, upsert
 * mailbox rows keyed like adapter mailbox ids so policy destination checks keep working.
 */
export async function refreshLabelCache(
  store: Store,
  accountId: string,
  labels: MailLabel[],
): Promise<void> {
  const mailboxes = store.mailboxes as Store["mailboxes"] & OnDemandMailboxes;
  if (mailboxes.refreshFromLabels) {
    await mailboxes.refreshFromLabels(accountId, labels);
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

/** Read-through `emails.get(handle | ulid, { includeBodies?, fresh? })` (store agent). */
export function readThroughGet(store: Store, id: string, opts: ReadOptions = {}) {
  return (store.emails.get as ReadThroughGet)(id, opts);
}

/** A cached row by provider id, without a provider round trip. */
export function cachedEmail(store: Store, accountId: string, providerId: string) {
  return store.emails.getByProviderId(accountId, providerId);
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
  const cached = await readThroughGet(store, id, { includeBodies: true });
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

/** Options the tools agent adds to `createToolRegistry` / `createMailboxMcpServer`. */
export function toolReaderOptions(readers: MailReaderResolver, dataDir: string) {
  return { readers, scratchDir: join(dataDir, "scratch") };
}

/** `createMailboxMcpServer({ readers, responseByteBudget })` (tools agent). */
export function mcpReaderOptions(readers: MailReaderResolver, dataDir: string) {
  return { ...toolReaderOptions(readers, dataDir), responseByteBudget: MCP_RESPONSE_BYTE_BUDGET };
}

/** `createAgentRuntime({ readers })` (agent-package agent). */
export function agentReaderOptions(readers: MailReaderResolver, dataDir: string) {
  return toolReaderOptions(readers, dataDir);
}

/** `FreeBusyResolver` from `@passport/tools`: null means no connected calendar for the account. */
export type FreeBusy = (accountId: string, range: TimeRange) => Promise<TimeRange[] | null>;

/** Reader accessor for a handle's account, or null for ULIDs and unsupported providers. */
export async function readerForHandle(
  readers: MailReaderResolver,
  id: string,
): Promise<{ reader: MailReader; accountId: string; providerId: string; type: string } | null> {
  const handle = parseMailHandle(id);
  if (!handle) {
    return null;
  }
  const reader = await readers(handle.accountId);
  return reader ? { reader, ...handle } : null;
}
