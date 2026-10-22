import type {
  CalendarProvider,
  MailProvider,
  MailReader,
  ProviderRegistry,
  Store,
} from "@passport/types";
import { ApiError, required } from "../errors.js";
import { logger } from "../logger.js";

/** Reader errors that mean the shared connection is unusable, not that one read failed. */
const CONNECTION_FAILURES = new Set(["IMAP_CONNECTION_ERROR", "NOT_CONNECTED", "NETWORK_ERROR"]);

type Provider = MailProvider | CalendarProvider;
interface Entry {
  raw: Provider;
  connected?: Promise<void>;
  proxy: Provider;
}

/** One adapter and one connect promise per account. Failed operations are never replayed. */
export class ProviderConnections {
  private entries = new Map<string, Entry>();
  private stopped = false;
  constructor(
    private store: Store,
    private registry: ProviderRegistry,
    private normalize: (accountId: string, method: string, result: unknown) => Promise<unknown>,
  ) {}

  mail = async (id: string): Promise<MailProvider> => this.get(id, "mail") as Promise<MailProvider>;
  calendar = async (id: string): Promise<CalendarProvider> =>
    this.get(id, "calendar") as Promise<CalendarProvider>;

  private async get(id: string, kind: "mail" | "calendar"): Promise<Provider> {
    if (this.stopped) {
      throw new ApiError("BACKEND_CLOSED", "Backend is closed");
    }
    const account = required(await this.store.accounts.get(id), "Account");
    if (!account.capabilities[kind]) {
      throw new ApiError("ACCOUNT_CAPABILITY", `Account does not support ${kind}`);
    }
    const key = `${kind}:${id}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const raw =
        kind === "mail"
          ? this.registry.mail(account.kind as MailProvider["kind"])
          : this.registry.calendar(account.kind as CalendarProvider["kind"]);
      entry = { raw, proxy: raw };
      const current = entry;
      const connect = async () => {
        if (this.stopped) {
          throw new ApiError("BACKEND_CLOSED", "Backend is closed");
        }
        current.connected ??= (async () => {
          const fresh = required(await this.store.accounts.get(id), "Account");
          await raw.connect(fresh, (await this.store.accounts.getCredentials(id)) ?? {});
        })().catch(async (error) => {
          // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

          current.connected = undefined;
          await raw.disconnect().catch(() => {
            // Provider disconnect failed after connection failure.
            logger.warn("Provider disconnect failed after connection failure");
            return undefined;
          });
          throw error;
        });
        await current.connected;
      };
      // Operations share one adapter: a failure invalidates it only once no other operation is
      // using it, so a rejected agent call cannot disconnect a sync mid-flight. A truly broken
      // connection fails those operations too, and the last one invalidates it.
      let active = 0;
      const fail = async () => {
        if (active > 0) {
          return;
        }
        current.connected = undefined;
        await raw.disconnect().catch(() => {
          // Provider disconnect failed while invalidating a connection.
          logger.warn("Provider disconnect failed while invalidating a connection");
          return undefined;
        });
      };
      current.proxy = new Proxy(raw, {
        get: (target, property) => {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") {
            return value;
          }
          if (property === "sync") {
            return async function* (...args: unknown[]) {
              await connect();
              active++;
              let failed = false;
              try {
                yield* value.apply(target, args);
              } catch (error) {
                // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

                failed = true;
                throw error;
              } finally {
                active--;
                if (failed) {
                  await fail();
                }
              }
            };
          }
          if (property === "connect" || property === "disconnect") {
            return value.bind(target);
          }
          if (property === "reader") {
            // The reader shares this adapter: its calls count as active operations. A failed
            // read (NOT_FOUND, RATE_LIMITED) keeps the connection; a broken one is replaced so
            // the watcher recovers without the push job (R4-31).
            return async () => {
              await connect();
              const reader = value.apply(target) as MailReader;
              return new Proxy(reader, {
                get: (inner, method) => {
                  const fn = Reflect.get(inner, method, inner);
                  if (typeof fn !== "function") {
                    return fn;
                  }
                  return async (...args: unknown[]) => {
                    await connect();
                    active++;
                    let broken = false;
                    try {
                      return await fn.apply(inner, args);
                    } catch (error) {
                      broken = CONNECTION_FAILURES.has((error as { code?: string })?.code ?? "");
                      throw error;
                    } finally {
                      active--;
                      if (broken) {
                        await fail();
                      }
                    }
                  };
                },
              });
            };
          }
          return async (...args: unknown[]) => {
            await connect();
            active++;
            let failed = false;
            try {
              const result = await value.apply(target, args);
              return await this.normalize(id, String(property), result);
            } catch (error) {
              // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

              // Invalidate for the next operation. Retrying a send here could deliver twice.
              failed = true;
              throw error;
            } finally {
              active--;
              if (failed) {
                await fail();
              }
            }
          };
        },
      });
      this.entries.set(key, current);
    }
    // Connection itself is lazy, shared even when sync/push/executor request it concurrently.
    const proxy = entry.proxy;
    return proxy;
  }
  async close() {
    this.stopped = true;
    await Promise.allSettled(
      [...this.entries.values()].map(async (entry) => {
        await entry.connected?.catch(() => {
          // Provider connection failed before shutdown.
          logger.warn("Provider connection failed before shutdown");
          return undefined;
        });
        await entry.raw.disconnect();
      }),
    );
    this.entries.clear();
  }
}
