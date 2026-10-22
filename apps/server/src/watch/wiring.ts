import type {
  CalendarProvider,
  EventBus,
  MailProvider,
  MailReader,
  MailReaderResolver,
  Store,
} from "@passport/types";
import { ApiError } from "../errors.js";
import { type FreeBusy, installReaderResolver } from "../ondemand-wiring.js";
import type { SyncService } from "../sync/index.js";
import { MailWatcher } from "./watcher.js";

/** Readers, the new-mail watcher and provider free/busy for the composition root. */
export function createOnDemandWiring(input: {
  store: Store;
  bus: EventBus;
  mailFor: (id: string) => Promise<MailProvider>;
  calendarFor: (id: string) => Promise<CalendarProvider>;
  sync: SyncService;
}) {
  const { store, bus, sync } = input;
  const readers: MailReaderResolver = async (id) => {
    try {
      // Through ProviderConnections: connects lazily and shares the account's adapter.
      return ((await (await input.mailFor(id)).reader?.()) as MailReader | undefined) ?? null;
    } catch (error) {
      if (error instanceof ApiError && error.code === "ACCOUNT_CAPABILITY") {
        return null;
      }
      throw error;
    }
  };
  installReaderResolver(store, readers);
  const watcher = new MailWatcher({
    store,
    bus,
    readers,
    normalize: (accountId, email) => sync.email(accountId, email),
  });
  /** Live calendar availability; null (local events) for accounts without a usable calendar. */
  const freeBusy: FreeBusy = async (accountId, range) => {
    const account = await store.accounts.get(accountId);
    if (!account?.capabilities.calendar || account.settings.reauthorizationRequired === true) {
      return null;
    }
    return (await input.calendarFor(accountId)).freeBusy(range);
  };
  return { readers, watcher, freeBusy };
}
