import type { Account, MailReaderResolver, Store } from "@passport/types";
import type { PassportConfig } from "../config.js";
import { ApiError, required } from "../errors.js";
import { watchIntervalSeconds } from "../onboarding/config.js";
import type { SyncService } from "../sync/index.js";
import { readWatchStatus } from "./status.js";
import type { MailWatcher } from "./watcher.js";

/** Backend members for the watcher (see `Backend.watchAccount` / `watchStatus` / `readers`). */
export function backendWatchHooks(input: {
  store: Store;
  config: PassportConfig;
  readers: MailReaderResolver;
  sync: SyncService;
  watcher: MailWatcher;
  closed: () => boolean;
}) {
  const { store, config, readers, sync, watcher } = input;
  return {
    readers,
    /** "Sync now": the bounded calendar sync first (availability), then a forced watcher tick. */
    async syncAccount(id: string): Promise<void> {
      if (input.closed()) {
        throw new ApiError("BACKEND_CLOSED", "Backend is closed");
      }
      const account = required(await store.accounts.get(id), "Account");
      let failure: unknown;
      if (account.capabilities.calendar) {
        await sync.syncAccount(id).catch((error: unknown) => {
          failure = error;
        });
      }
      if (account.capabilities.mail) {
        await watcher.tick(id, { force: true });
      }
      if (failure) {
        throw failure;
      }
    },
    watchAccount: (id: string) =>
      input.closed()
        ? Promise.reject(new ApiError("BACKEND_CLOSED", "Backend is closed"))
        : watcher.tick(id),
    watchStatus: (account: Account) =>
      readWatchStatus(store, account, watchIntervalSeconds(config)),
  };
}
