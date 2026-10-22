import type {
  Account,
  Email,
  EventBus,
  MailChanges,
  MailEnvelope,
  MailLabel,
  MailReader,
  MailReaderResolver,
  MailReadOptions,
  Store,
} from "@passport/types";
import { parseMailHandle } from "@passport/types";
import { persistArrival } from "../arrivals.js";
import { cachedEmail, refreshLabelCache } from "../ondemand-wiring.js";
import { readCursors, updateCursors } from "../sync/state.js";
import { type ArrivalContext, alreadyHandled, arrivalContext, isInboxArrival } from "./arrival.js";
import { backoffDelayMs, INVALID_CURSOR, REAUTHORIZE, rateLimited, safeCode } from "./failure.js";
import {
  labelsKey,
  lastTickKey,
  stateKey,
  summarizeLabels,
  type WatchState,
  watcherTickKey,
} from "./status.js";

export interface MailWatcherOptions {
  store: Store;
  bus: EventBus;
  readers: MailReaderResolver;
  /** Maps an envelope onto its cached identity, keeping local annotations (`SyncService.email`). */
  normalize: (accountId: string, email: Email) => Promise<Email>;
  /** Changes requested per `changes()` page. */
  pageSize?: number;
  /** Pages followed per tick while `hasMore`; the rest waits for the next tick. */
  maxPages?: number;
  /** Label tree + counts refresh period. */
  labelsEveryMs?: number;
  now?: () => number;
}
export interface WatchTickResult {
  status: "started" | "ok" | "expired" | "skipped" | "backoff" | "paused" | "unsupported";
  added: number;
  arrivals: number;
  summary: string;
}

/** Recent inbox mail checked once after a provider expires the cursor (research 03 §3.3). */
export const EXPIRY_SWEEP = { query: "in:inbox newer_than:2d", limit: 100 } as const;
/**
 * Follows new mail per account with `MailReader.changes` in the `arrivals` lane. The first tick
 * takes a cursor at "now" and never backfills. Added inbox mail becomes a durable arrival; label
 * changes and deletions patch the envelope cache only. Owner process only.
 */
export class MailWatcher {
  private active = new Map<string, Promise<WatchTickResult>>();
  private backoff = new Map<string, { until: number; attempt: number }>();
  private labelsAt = new Map<string, number>();
  private labels = new Map<string, MailLabel[]>();
  private unhealthy = new Set<string>();
  private retired = new Set<string>();
  private controller = new AbortController();
  private stopped = false;
  private readonly now: () => number;
  constructor(private readonly options: MailWatcherOptions) {
    this.now = options.now ?? Date.now;
  }

  /** One tick; concurrent calls share it. `force` ignores a pending backoff ("Check now"). */
  tick(accountId: string, opts: { force?: boolean } = {}): Promise<WatchTickResult> {
    if (this.stopped || this.retired.has(accountId)) {
      return Promise.resolve({ status: "skipped", added: 0, arrivals: 0, summary: "Stopped" });
    }
    const current = this.active.get(accountId);
    if (current) {
      return current;
    }
    const job = this.run(accountId, !!opts.force).finally(() => this.active.delete(accountId));
    this.active.set(accountId, job);
    return job;
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.active.values()]);
  }
  /** Shutdown: abort governor waits, then let in-flight ticks settle. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    await this.drain();
  }
  /** Account removal: stop ticking and drop watcher-owned keys (sync_state goes with the account). */
  async remove(accountId: string): Promise<void> {
    this.retired.add(accountId);
    await this.active.get(accountId)?.catch(() => undefined);
    for (const key of [watcherTickKey, lastTickKey, labelsKey, stateKey]) {
      await this.options.store.kv.delete(key(accountId));
    }
    this.backoff.delete(accountId);
    this.labels.delete(accountId);
    this.labelsAt.delete(accountId);
  }

  private iso() {
    return new Date(this.now()).toISOString();
  }
  private lane(): MailReadOptions {
    return { lane: "arrivals", signal: this.controller.signal };
  }

  private async run(accountId: string, force: boolean): Promise<WatchTickResult> {
    const { store, bus } = this.options;
    const account = await store.accounts.get(accountId);
    if (!account?.capabilities.mail) {
      return { status: "skipped", added: 0, arrivals: 0, summary: "Not a mail account" };
    }
    if (account.settings.reauthorizationRequired === true) {
      return { status: "paused", added: 0, arrivals: 0, summary: "Needs sign-in" };
    }
    const pending = this.backoff.get(accountId);
    if (pending && pending.until > this.now() && !force) {
      return { status: "backoff", added: 0, arrivals: 0, summary: "Backing off after rate limit" };
    }
    try {
      const reader = await this.options.readers(accountId);
      if (!reader) {
        await this.setState(accountId, { status: "unsupported" });
        return {
          status: "unsupported",
          added: 0,
          arrivals: 0,
          summary: "Provider has no on-demand reader",
        };
      }
      const cursors = await readCursors(store, accountId);
      if (!cursors.mail) {
        // Never backfill: the watermark is "now".
        const start = await reader.changes(null, 1, this.lane());
        const since = this.iso();
        await updateCursors(store, accountId, {
          mail: start.value.cursor,
          since,
          cursorAt: since,
        });
        await this.refreshLabels(accountId, reader, true);
        await this.succeed(account);
        bus.emit({ type: "account.watch.started", accountId, since });
        return { status: "started", added: 0, arrivals: 0, summary: "Watching for new mail" };
      }
      await this.refreshLabels(accountId, reader, false);
      const since = cursors.since ?? this.iso();
      let cursor = cursors.mail;
      let added = 0;
      let arrivals = 0;
      let expired = false;
      for (let page = 0; page < (this.options.maxPages ?? 10); page++) {
        const value = await this.changes(reader, cursor);
        if (value.expired) {
          expired = true;
          const result = await this.recover(account, reader, since);
          added += result.added;
          arrivals += result.arrivals;
          await updateCursors(store, accountId, { mail: value.cursor, cursorAt: this.iso() });
          bus.emit({
            type: "account.watch.expired",
            accountId,
            at: this.iso(),
            swept: result.added,
            arrivals: result.arrivals,
          });
          break;
        }
        const result = await this.apply(account, reader, value);
        added += result.added;
        arrivals += result.arrivals;
        cursor = value.cursor;
        // Persist only after the page was handled.
        await updateCursors(store, accountId, { mail: cursor, cursorAt: this.iso() });
        if (!value.hasMore) {
          break;
        }
      }
      await this.succeed(account);
      bus.emit({ type: "account.watch.tick", accountId, at: this.iso(), added, arrivals });
      return {
        status: expired ? "expired" : "ok",
        added,
        arrivals,
        summary: `${arrivals} new ${arrivals === 1 ? "arrival" : "arrivals"}`,
      };
    } catch (error) {
      return this.fail(account, error);
    }
  }

  /** A cursor the provider rejects outright is handled like an expired one: start again at now. */
  private async changes(reader: MailReader, cursor: string): Promise<MailChanges> {
    try {
      return (await reader.changes(cursor, this.options.pageSize ?? 100, this.lane())).value;
    } catch (error) {
      if (!INVALID_CURSOR.includes((error as { code?: string })?.code ?? "")) {
        throw error;
      }
      const fresh = (await reader.changes(null, 1, this.lane())).value;
      return { ...fresh, added: [], labelChanged: [], deleted: [], expired: true };
    }
  }

  /** Cursor expired: mark cached labels stale, then one bounded sweep deduped against arrivals. */
  private async recover(account: Account, reader: MailReader, since: string) {
    await this.options.store.kv.set(watcherTickKey(account.id), this.iso());
    const found = await reader.search({ ...EXPIRY_SWEEP }, this.lane());
    const ids = found.items
      // Mail older than the watermark is never an arrival.
      .filter((row) => row.date >= since)
      .map((row) => parseMailHandle(row.id)?.providerId)
      .filter((id): id is string => !!id);
    return this.ingestAdded(account, reader, ids);
  }

  private async apply(account: Account, reader: MailReader, changes: MailChanges) {
    const { store, bus } = this.options;
    const result = await this.ingestAdded(account, reader, changes.added);
    // Label changes patch rows already cached; uncached ids are ignored.
    const cached = (
      await Promise.all(changes.labelChanged.map((id) => cachedEmail(store, account.id, id)))
    ).filter((email): email is Email => !!email);
    if (cached.length) {
      const fresh = await reader.envelopes(
        cached.map((email) => email.providerId),
        this.lane(),
      );
      for (const email of cached) {
        const envelope = fresh.value.get(email.providerId);
        if (envelope) {
          await store.emails.upsertMany([await this.options.normalize(account.id, envelope)]);
          bus.emit({ type: "email.updated", emailId: email.id });
        } else {
          await this.forget(email);
        }
      }
    }
    // Deletions drop the cached row; there are no tombstones without a mirror.
    for (const providerId of changes.deleted) {
      const email = await cachedEmail(store, account.id, providerId);
      if (email) {
        await this.forget(email);
      }
    }
    return result;
  }

  private async ingestAdded(account: Account, reader: MailReader, providerIds: string[]) {
    if (!providerIds.length) {
      return { added: 0, arrivals: 0 };
    }
    const { store, bus } = this.options;
    const envelopes = await reader.envelopes(providerIds, this.lane());
    let ctx: ArrivalContext | undefined;
    let added = 0;
    let arrivals = 0;
    for (const providerId of providerIds) {
      const envelope = envelopes.value.get(providerId);
      if (!envelope) {
        continue;
      }
      ctx ??= await arrivalContext(store, account.id, this.labels.get(account.id) ?? []);
      const existing = await cachedEmail(store, account.id, providerId);
      const email = await this.options.normalize(account.id, envelope as MailEnvelope as Email);
      const arrival =
        isInboxArrival(email, [...envelope.mailboxIds, ...email.mailboxIds], ctx) &&
        !(await alreadyHandled(store, email.id));
      if (arrival) {
        // Registered before the row is cached, so an interrupted tick re-finds it.
        await persistArrival(store, email);
      }
      await store.emails.upsertMany([email]);
      const thread = await store.threads.get(email.threadId);
      await store.threads.upsertMany([
        {
          id: email.threadId,
          accountId: account.id,
          emailIds: [...new Set([...(thread?.emailIds ?? []), email.id])],
        },
      ]);
      added++;
      if (arrival) {
        arrivals++;
        bus.emit({ type: "email.received", email });
      } else if (existing) {
        bus.emit({ type: "email.updated", emailId: email.id });
      }
    }
    return { added, arrivals };
  }

  private async forget(email: Email) {
    const { store, bus } = this.options;
    await store.emails.deleteMany([email.id]);
    const thread = await store.threads.get(email.threadId);
    if (thread) {
      await store.threads.upsertMany([
        { ...thread, emailIds: thread.emailIds.filter((id) => id !== email.id) },
      ]);
    }
    bus.emit({ type: "email.updated", emailId: email.id });
  }

  /** On connect and every 10 minutes: label tree with counts → store label cache + inbox count. */
  private async refreshLabels(accountId: string, reader: MailReader, force: boolean) {
    const last = this.labelsAt.get(accountId);
    if (
      !force &&
      last !== undefined &&
      this.now() - last < (this.options.labelsEveryMs ?? 600_000)
    ) {
      return;
    }
    const { items } = await reader.labels(true, this.lane());
    this.labels.set(accountId, items);
    this.labelsAt.set(accountId, this.now());
    await refreshLabelCache(this.options.store, accountId, items);
    await this.options.store.kv.set(
      labelsKey(accountId),
      JSON.stringify(summarizeLabels(items, this.iso())),
    );
  }

  private async setState(accountId: string, state: WatchState) {
    this.unhealthy.add(accountId);
    await this.options.store.kv.set(stateKey(accountId), JSON.stringify(state));
  }

  private async succeed(account: Account) {
    const { store } = this.options;
    await store.kv.set(lastTickKey(account.id), this.iso());
    this.backoff.delete(account.id);
    if (this.unhealthy.delete(account.id) || (await store.kv.get(stateKey(account.id)))) {
      await store.kv.delete(stateKey(account.id));
    }
    if (account.lastSyncError && account.lastSyncError !== "REAUTHORIZE_REQUIRED") {
      const fresh = await store.accounts.get(account.id);
      if (fresh) {
        await store.accounts.upsert({ ...fresh, lastSyncError: null, updatedAt: this.iso() });
      }
    }
  }

  private async fail(account: Account, error: unknown): Promise<WatchTickResult> {
    const { store, bus } = this.options;
    if (this.stopped) {
      return { status: "skipped", added: 0, arrivals: 0, summary: "Stopped" };
    }
    if (rateLimited(error)) {
      // Back off the tick and never fail the account; the governor's hint wins when larger.
      const previous = this.backoff.get(account.id);
      const attempt = (previous?.attempt ?? 0) + 1;
      const delayMs = backoffDelayMs(attempt, error);
      const until = this.now() + delayMs;
      this.backoff.set(account.id, { until, attempt });
      await this.setState(account.id, {
        status: "backoff",
        error: "RATE_LIMITED",
        retryAt: new Date(until).toISOString(),
      });
      const retryAfterSeconds = Math.ceil(delayMs / 1000);
      bus.emit({ type: "account.watch.backoff", accountId: account.id, retryAfterSeconds });
      return {
        status: "backoff",
        added: 0,
        arrivals: 0,
        summary: `Rate limited; next check in ${retryAfterSeconds}s`,
      };
    }
    const code = safeCode(error);
    const fresh = (await store.accounts.get(account.id)) ?? account;
    if (REAUTHORIZE.includes(code)) {
      // Revoked tokens need human consent, not another scheduled attempt.
      await store.accounts.upsert({
        ...fresh,
        settings: { ...fresh.settings, reauthorizationRequired: true },
        lastSyncError: "REAUTHORIZE_REQUIRED",
        updatedAt: this.iso(),
      });
      bus.emit({
        type: "account.watch.failed",
        accountId: account.id,
        error: "REAUTHORIZE_REQUIRED",
      });
      bus.emit({
        type: "account.sync.failed",
        accountId: account.id,
        error: "REAUTHORIZE_REQUIRED",
      });
      throw error;
    }
    await this.setState(account.id, { status: "error", error: code });
    if (fresh.lastSyncError !== code) {
      await store.accounts.upsert({ ...fresh, lastSyncError: code, updatedAt: this.iso() });
    }
    bus.emit({ type: "account.watch.failed", accountId: account.id, error: code });
    throw error;
  }
}

const watchers = new WeakMap<object, MailWatcher>();
export function attachMailWatcher<T extends object>(backend: T, watcher: MailWatcher): T {
  watchers.set(backend, watcher);
  return backend;
}
export const mailWatcher = (backend: object): MailWatcher | undefined => watchers.get(backend);
