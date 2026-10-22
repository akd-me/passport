import type { MailChanges } from "@passport/types";
import type { GmailCall } from "./gmail-reader-support.js";
import { GMAIL_UNIT_COSTS } from "./quota-presets.js";

const HISTORY_TYPES = ["messageAdded", "labelAdded", "labelRemoved", "messageDeleted"];

type HistoryRef = { message: { id: string } };
export interface GmailHistoryRecord {
  id: string;
  messagesAdded?: HistoryRef[];
  messagesDeleted?: HistoryRef[];
  labelsAdded?: HistoryRef[];
  labelsRemoved?: HistoryRef[];
}
export interface GmailHistoryPage {
  historyId?: string;
  nextPageToken?: string;
  history?: GmailHistoryRecord[];
}

/** Coalesces history records into `MailChanges` lists, the same way the mock reader does. */
export class HistoryCollector {
  private readonly added = new Set<string>();
  private readonly changed = new Set<string>();
  private readonly deleted = new Set<string>();

  get size(): number {
    return new Set([...this.added, ...this.changed, ...this.deleted]).size;
  }

  /** True when taking `record` keeps the total within `limit` (the first record always fits). */
  fits(record: GmailHistoryRecord, limit: number): boolean {
    const fresh = new Set(
      [
        ...(record.messagesAdded ?? []),
        ...(record.messagesDeleted ?? []),
        ...(record.labelsAdded ?? []),
        ...(record.labelsRemoved ?? []),
      ]
        .map((ref) => ref.message.id)
        .filter((id) => !this.added.has(id) && !this.changed.has(id) && !this.deleted.has(id)),
    );
    return this.size === 0 || this.size + fresh.size <= limit;
  }

  take(record: GmailHistoryRecord): void {
    for (const { message } of record.messagesAdded ?? []) {
      this.deleted.delete(message.id);
      this.changed.delete(message.id);
      this.added.add(message.id);
    }
    for (const { message } of [...(record.labelsAdded ?? []), ...(record.labelsRemoved ?? [])]) {
      if (!this.added.has(message.id) && !this.deleted.has(message.id)) {
        this.changed.add(message.id);
      }
    }
    for (const { message } of record.messagesDeleted ?? []) {
      this.added.delete(message.id);
      this.changed.delete(message.id);
      this.deleted.add(message.id);
    }
  }

  result(hasMore: boolean): Omit<MailChanges, "cursor"> {
    return {
      added: [...this.added],
      labelChanged: [...this.changed],
      deleted: [...this.deleted],
      ...(hasMore ? { hasMore: true } : {}),
    };
  }
}

/**
 * Pages `history.list` from `start` until `max` distinct ids are collected. `next` is the history
 * id to resume from: the mailbox's current id when every page was read, else the last record
 * taken (with `hasMore`). A 404 (history expired) propagates.
 */
export async function readHistory(
  call: GmailCall,
  start: string,
  max: number,
): Promise<Omit<MailChanges, "cursor"> & { next: string }> {
  const collector = new HistoryCollector();
  let next = start;
  let pageToken: string | undefined;
  for (;;) {
    const params = new URLSearchParams({
      startHistoryId: start,
      maxResults: String(Math.min(500, max)),
    });
    for (const type of HISTORY_TYPES) {
      params.append("historyTypes", type);
    }
    if (pageToken) {
      params.set("pageToken", pageToken);
    }
    const page = await call.get<GmailHistoryPage>(
      `history?${params}`,
      GMAIL_UNIT_COSTS.historyList,
    );
    for (const record of page.history ?? []) {
      if (!collector.fits(record, max)) {
        return { ...collector.result(true), next };
      }
      collector.take(record);
      next = record.id;
    }
    pageToken = page.nextPageToken;
    if (!pageToken) {
      return { ...collector.result(false), next: page.historyId ?? next };
    }
    if (collector.size >= max) {
      return { ...collector.result(true), next };
    }
  }
}
