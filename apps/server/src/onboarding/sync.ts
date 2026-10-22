import type { CalendarProvider, EventBus, MailProvider, Store } from "@passport/types";
import { required } from "../errors.js";
import { logger } from "../logger.js";
import { SyncService } from "../sync/index.js";

/**
 * Retries the bounded calendar sync only; mail is followed by `MailWatcher`. Provider mutations
 * and submissions are never replayed.
 */
export class AccountSyncService extends SyncService {
  private jobs = new Map<string, Promise<void>>();
  private retired = new Set<string>();
  constructor(
    private accountStore: Store,
    private events: EventBus,
    private mailProvider: (id: string) => Promise<MailProvider>,
    private calendarProvider: (id: string) => Promise<CalendarProvider>,
    private timing = {
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      random: () => Math.random(),
    },
  ) {
    super(accountStore, events, calendarProvider);
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
    if (account.settings.reauthorizationRequired === true || !account.capabilities.calendar) {
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
  /** Explicit reconnect updates the retained provider after browser re-authorization. */
  async reconnect(id: string): Promise<void> {
    await this.jobs.get(id)?.catch(() => {
      // Calendar sync failed while pausing.
      logger.warn("Calendar sync failed while pausing");
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
          // Provider disconnect failed during reconnect.
          logger.warn("Provider disconnect failed during reconnect");
          return undefined;
        });
        await provider.connect(account, credentials);
      }
    }
  }
  async remove(id: string): Promise<void> {
    this.retired.add(id);
    await this.jobs.get(id)?.catch(() => {
      // Calendar sync failed while removing the account.
      logger.warn("Calendar sync failed while removing the account");
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
