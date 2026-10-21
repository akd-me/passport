import type { CalendarProvider, EventBus, MailProvider, Store } from "@passport/types";
import { ApiError, required } from "../errors.js";
import { logger } from "../logger.js";
import { SyncService } from "../sync/index.js";
import { initialDays } from "./config.js";

/** Retries ingestion only. Provider mutations and submissions are never replayed. */
export class AccountSyncService extends SyncService {
  private jobs = new Map<string, Promise<void>>();
  private windows: Map<string, number>;
  private snapshots: Map<string, string>;
  private defaultDays: number;
  private retired = new Set<string>();
  constructor(
    private accountStore: Store,
    private events: EventBus,
    private mailProvider: (id: string) => Promise<MailProvider>,
    private calendarProvider: (id: string) => Promise<CalendarProvider>,
    config: { sync?: { initialDays?: number } },
    private timing = {
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      random: () => Math.random(),
    },
  ) {
    const windows = new Map<string, number>();
    const snapshots = new Map<string, string>();
    const days = initialDays(config);
    super(
      accountStore,
      events,
      async (id) => {
        const provider = await mailProvider(id);
        return new Proxy(provider, {
          get(target, property) {
            if (property === "sync") {
              return async function* (cursor: string | null) {
                const account = required(await accountStore.accounts.get(id), "Account");
                const window = windows.get(id) ?? Number(account.settings.syncDays ?? days);
                const since = new Date(Date.now() - window * 86400000).toISOString();
                snapshots.set(id, since);
                yield* target.sync(cursor, { since });
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      calendarProvider,
    );
    this.windows = windows;
    this.snapshots = snapshots;
    this.defaultDays = days;
  }
  isSyncing(id: string): boolean {
    return this.jobs.has(id);
  }
  protected override mailSnapshotSince(id: string): string | undefined {
    return this.snapshots.get(id);
  }
  override syncAccount(id: string): Promise<void> {
    if (this.retired.has(id)) {
      return Promise.resolve();
    }
    const active = this.jobs.get(id);
    if (active) {
      return active;
    }
    const job = this.runAccount(id).finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
    return job;
  }
  private async runAccount(id: string): Promise<void> {
    const account = required(await this.accountStore.accounts.get(id), "Account");
    // Revoked tokens need human consent, not another scheduled attempt.
    if (account.settings.reauthorizationRequired === true) {
      return;
    }
    this.events.emit({ type: "account.sync.started", accountId: id });
    for (let retry = 0; ; retry++) {
      try {
        await super.syncAccount(id);
        return;
      } catch (error) {
        // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

        const failure = error as { code?: string; status?: number };
        const transient =
          [429, 503].includes(failure.status ?? 0) ||
          ["RATE_LIMITED", "HTTP_429", "HTTP_503"].includes(failure.code ?? "");
        if (transient && retry < 5) {
          const delayMs = Math.round(1000 * 2 ** retry * (0.5 + this.timing.random()));
          this.events.emit({
            type: "account.sync.retry",
            accountId: id,
            attempt: retry + 1,
            delayMs,
          });
          await this.timing.sleep(delayMs);
          continue;
        }
        const fresh = required(await this.accountStore.accounts.get(id), "Account");
        const reauthorize = ["AUTH_FAILED", "OAUTH_REFRESH_FAILED", "TOKEN_EXPIRED"].includes(
          failure.code ?? "",
        );
        await this.accountStore.accounts.upsert({
          ...fresh,
          settings: {
            ...fresh.settings,
            ...(reauthorize ? { reauthorizationRequired: true } : {}),
          },
          lastSyncError: reauthorize
            ? "REAUTHORIZE_REQUIRED"
            : (fresh.lastSyncError ?? "SYNC_FAILED"),
        });
        this.events.emit({
          type: "account.sync.failed",
          accountId: id,
          error: reauthorize ? "REAUTHORIZE_REQUIRED" : (fresh.lastSyncError ?? "SYNC_FAILED"),
        });
        throw error;
      }
    }
  }
  /** Widen the mail snapshot without deleting already ingested messages. */
  async backfill(id: string, days: number): Promise<void> {
    if (!Number.isInteger(days) || days < 1 || days > 36500) {
      throw new ApiError("INVALID_QUERY", "days must be 1–36500");
    }
    if (this.jobs.has(id)) {
      throw new ApiError("SYNC_BUSY", "Wait for the current sync to finish", 409);
    }
    const job = (async () => {
      const account = required(await this.accountStore.accounts.get(id), "Account");
      if (!account.capabilities.mail) {
        throw new ApiError("ACCOUNT_CAPABILITY", "Backfill requires a mail account");
      }
      if (account.settings.reauthorizationRequired) {
        throw new ApiError("REAUTHORIZE_REQUIRED", "Re-authorize this account first", 409);
      }
      const saved = await this.accountStore.syncState.get(id);
      const prefix = "passport-sync-v1:";
      const cursors = saved?.cursor?.startsWith(prefix)
        ? JSON.parse(saved.cursor.slice(prefix.length))
        : { calendar: null };
      await this.accountStore.syncState.set({
        accountId: id,
        cursor: prefix + JSON.stringify({ ...cursors, mail: null }),
        updatedAt: new Date().toISOString(),
      });
      this.windows.set(id, Math.max(days, Number(account.settings.syncDays ?? this.defaultDays)));
      try {
        await this.runAccount(id);
        const fresh = required(await this.accountStore.accounts.get(id), "Account");
        await this.accountStore.accounts.upsert({
          ...fresh,
          settings: { ...fresh.settings, syncDays: this.windows.get(id)! },
        });
      } catch (error) {
        // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

        await this.accountStore.syncState.set(
          saved ?? {
            accountId: id,
            cursor: null,
            updatedAt: new Date().toISOString(),
          },
        );
        throw error;
      } finally {
        this.windows.delete(id);
      }
    })().finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
    return job;
  }
  /** Explicit reconnect updates the retained provider after browser re-authorization. */
  async reconnect(id: string): Promise<void> {
    await this.jobs.get(id)?.catch(() => {
      // Backfill job failed while pausing.
      logger.warn("Backfill job failed while pausing");
      return undefined;
    });
    const account = required(await this.accountStore.accounts.get(id), "Account");
    const credentials = (await this.accountStore.accounts.getCredentials(id)) ?? {};
    for (const kind of ["mail", "calendar"] as const) {
      if (account.capabilities[kind]) {
        const provider = await (kind === "mail"
          ? this.mailProvider(id)
          : this.calendarProvider(id));
        await provider.disconnect().catch(() => {
          // Provider disconnect failed after backfill.
          logger.warn("Provider disconnect failed after backfill");
          return undefined;
        });
        await provider.connect(account, credentials);
      }
    }
  }
  async remove(id: string): Promise<void> {
    this.retired.add(id);
    await this.jobs.get(id)?.catch(() => {
      // Backfill job failed while removing the account.
      logger.warn("Backfill job failed while removing the account");
      return undefined;
    });
    const account = required(await this.accountStore.accounts.get(id), "Account");
    if (account.capabilities.mail) {
      await (await this.mailProvider(id)).disconnect().catch(() => {
        // Mail provider disconnect failed during removal.
        logger.warn("Mail provider disconnect failed during removal");
        return undefined;
      });
    }
    if (account.capabilities.calendar) {
      await (await this.calendarProvider(id)).disconnect().catch(() => {
        // Calendar provider disconnect failed during removal.
        logger.warn("Calendar provider disconnect failed during removal");
        return undefined;
      });
    }
  }
  override async drain(): Promise<void> {
    await Promise.allSettled([...this.jobs.values()]);
    await super.drain();
  }
}

const services = new WeakMap<object, AccountSyncService>();
export function attachAccountSync<T extends object>(backend: T, service: AccountSyncService): T {
  services.set(backend, service);
  return backend;
}
export const accountSync = (backend: object): AccountSyncService | undefined =>
  services.get(backend);
