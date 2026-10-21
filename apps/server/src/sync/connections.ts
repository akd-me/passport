import type { CalendarProvider, MailProvider, ProviderRegistry, Store } from "@passport/types";
import { ApiError, required } from "../errors.js";

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
          current.connected = undefined;
          await raw.disconnect().catch(() => undefined);
          throw error;
        });
        await current.connected;
      };
      const fail = async () => {
        current.connected = undefined;
        await raw.disconnect().catch(() => undefined);
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
              try {
                yield* value.apply(target, args);
              } catch (error) {
                await fail();
                throw error;
              }
            };
          }
          if (property === "connect" || property === "disconnect") {
            return value.bind(target);
          }
          return async (...args: unknown[]) => {
            await connect();
            try {
              const result = await value.apply(target, args);
              return await this.normalize(id, String(property), result);
            } catch (error) {
              // Invalidate for the next operation. Retrying a send here could deliver twice.
              await fail();
              throw error;
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
        await entry.connected?.catch(() => undefined);
        await entry.raw.disconnect();
      }),
    );
    this.entries.clear();
  }
}
