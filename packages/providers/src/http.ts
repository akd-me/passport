import type {
  Account,
  AccountCredentials,
  Email,
  QuotaLane,
  RateLimitScope,
} from "@passport/types";
import { ProviderError, required } from "./errors.js";
import { type RetryOptions, request, type WaitBudget } from "./http-request.js";
import type { QuotaGovernor } from "./quota.js";
import { resolveReplyEmail } from "./reply.js";
import type { PassportVerifier } from "./verification.js";

export interface ProviderOptions {
  fetch?: typeof fetch;
  /** Persist refreshed/rotated credentials through the store's encrypted credential API. */
  onCredentials?: (accountId: string, credentials: AccountCredentials) => Promise<void> | void;
  verifier?: PassportVerifier;
  now?: () => Date;
  /** Resolve store IDs (e.g. ULIDs) when composing a reply; omit when retaining adapter IDs. */
  resolveEmail?: (id: string) => Promise<Email | null>;
  /** Waits between rate-limited read retries; tests inject a fake clock. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Per-account quota governor (v0.3). When set, requests that declare a `cost` acquire it first,
   * and throttling responses are reported to it. The composition root configures the account.
   */
  governor?: QuotaGovernor;
}

/**
 * Per-request quota policy (v0.3). Omitting `lane` keeps the v0.2 behaviour: rate-limited GETs
 * retry for 2+4+8+16+32 s, and a governed request uses the background lane.
 */
export interface RequestPolicy {
  /**
   * `"interactive"` retries only while the cumulative wait stays within
   * `INTERACTIVE_MAX_WAIT_MS`, then throws `RateLimitedError`. Other lanes keep the long schedule.
   */
  lane?: QuotaLane;
  /** Units to acquire from `ProviderOptions.governor` (Gmail units, Graph requests). */
  cost?: number;
  /**
   * The reader call's shared wait budget: the governor queue and throttle backoff of every
   * request in the call draw from it, so the interactive ceiling covers the whole call.
   */
  budget?: WaitBudget | undefined;
  /** A read-only POST (batch of GETs) that may be retried after a 429 like a GET. */
  idempotent?: boolean;
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }
    return value as T;
  } catch {
    // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

    throw new ProviderError("INVALID_RESPONSE", "Provider returned invalid JSON");
  }
}

export const googleTokenUrl = "https://oauth2.googleapis.com/token";
export function microsoftTokenUrl(tenant = "common"): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
}

export async function exchangeToken(
  fetcher: typeof fetch,
  url: string,
  fields: Record<string, string>,
): Promise<AccountCredentials> {
  const token = await readJson<Record<string, unknown>>(
    await request(fetcher, url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    }),
  );
  if (typeof token.access_token !== "string") {
    throw new ProviderError("INVALID_RESPONSE", "OAuth response has no access_token");
  }
  const result: AccountCredentials = {};
  for (const key of ["access_token", "refresh_token", "token_type", "scope"]) {
    if (typeof token[key] === "string") {
      result[key] = token[key];
    }
  }
  if (typeof token.expires_in === "number" || typeof token.expires_in === "string") {
    result.expires_at = String(Date.now() + Number(token.expires_in) * 1000);
  }
  return result;
}

export class HttpConnection {
  protected account!: Account;
  protected credentials: AccountCredentials = {};
  protected connected = false;
  protected readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private refreshing?: Promise<void>;
  /**
   * Reported in `RateLimitedError.scope`. Defaults from the OAuth family (Google → Gmail quota,
   * Microsoft → Graph mailbox); subclasses such as calendars may override it.
   */
  protected rateLimitScope: RateLimitScope;
  constructor(
    protected readonly options: ProviderOptions = {},
    private readonly oauth?: "google" | "microsoft",
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.rateLimitScope =
      oauth === "google"
        ? "gmail:user-quota"
        : oauth === "microsoft"
          ? "graph:mailbox"
          : "provider:http";
  }
  async connect(account: Account, credentials: AccountCredentials): Promise<void> {
    if (this.connected && this.account.id !== account.id) {
      throw new ProviderError("ACCOUNT_MISMATCH", "Use a separate provider instance per account");
    }
    this.account = structuredClone(account);
    this.credentials = { ...credentials };
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    this.credentials = {};
  }
  protected check(): void {
    if (!this.connected) {
      throw new ProviderError("NOT_CONNECTED", "Connect the provider first");
    }
  }
  protected now(): Date {
    return this.options.now?.() ?? new Date();
  }
  protected async reply(
    id: string | null | undefined,
    getEmail: (providerId: string) => Promise<Email | null>,
  ): Promise<Email | null> {
    this.check();
    if (!id) {
      return null;
    }
    return resolveReplyEmail(this.account.id, id, getEmail, this.options.resolveEmail);
  }
  protected async refresh(): Promise<void> {
    if (this.refreshing) {
      return this.refreshing;
    }
    this.refreshing = (async () => {
      if (!this.oauth) {
        throw new ProviderError("AUTH_FAILED", "The provider token has expired");
      }
      if (!this.credentials.refresh_token) {
        throw new ProviderError(
          "OAUTH_REFRESH_FAILED",
          "Re-authorize this account to renew access",
        );
      }
      let token: AccountCredentials;
      try {
        token = await exchangeToken(
          this.fetcher,
          this.oauth === "google"
            ? googleTokenUrl
            : microsoftTokenUrl(String(this.account.settings.tenantId ?? "common")),
          {
            grant_type: "refresh_token",
            refresh_token: required(this.credentials.refresh_token, "refresh_token"),
            client_id: required(
              this.account.settings.clientId ?? this.credentials.client_id,
              "clientId",
            ),
            ...(this.credentials.clientSecret || this.credentials.client_secret
              ? { client_secret: this.credentials.clientSecret ?? this.credentials.client_secret! }
              : {}),
          },
        );
      } catch (error) {
        // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

        if (error instanceof ProviderError && [400, 401].includes(error.status ?? 0)) {
          throw new ProviderError(
            "OAUTH_REFRESH_FAILED",
            "Re-authorize this account to renew access",
          );
        }
        throw error;
      }
      this.credentials = { ...this.credentials, ...token };
      await this.options.onCredentials?.(this.account.id, { ...this.credentials });
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }
  /**
   * Authenticated request. With `policy.cost` and a governor, quota is acquired first (in
   * `policy.lane`, default background) and released when the response arrives.
   */
  protected async http(
    url: string,
    init: RequestInit = {},
    policy: RequestPolicy = {},
  ): Promise<Response> {
    this.check();
    const governor = this.options.governor;
    if (!governor || policy.cost === undefined) {
      return this.authorized(url, init, policy);
    }
    const lease = await governor.acquire(
      this.account.id,
      policy.lane ?? "background",
      policy.cost,
      {
        ...(init.signal ? { signal: init.signal } : {}),
        ...(policy.budget ? { maxWaitMs: Math.max(0, policy.budget.remainingMs) } : {}),
      },
    );
    if (policy.budget) {
      policy.budget.remainingMs -= lease.waitedMs;
    }
    try {
      return await this.authorized(url, init, policy);
    } finally {
      lease.release();
    }
  }
  private async authorized(
    url: string,
    init: RequestInit,
    policy: RequestPolicy,
  ): Promise<Response> {
    if (
      this.oauth &&
      (!this.credentials.access_token ||
        (this.credentials.expires_at &&
          Number(this.credentials.expires_at) < this.now().getTime() + 60_000))
    ) {
      await this.refresh();
    }
    const headers = new Headers(init.headers);
    const token = this.credentials.access_token ?? this.credentials.token;
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    } else if (this.credentials.password) {
      headers.set(
        "authorization",
        `Basic ${Buffer.from(`${this.account.settings.username ?? this.account.emailAddress}:${this.credentials.password}`).toString("base64")}`,
      );
    } else {
      throw new ProviderError("CONFIG_REQUIRED", "Missing provider credentials");
    }
    const accountId = this.account.id;
    const retry: RetryOptions = {
      scope: this.rateLimitScope,
      onThrottle: (signal) => this.options.governor?.report(accountId, signal),
      ...(policy.lane ? { lane: policy.lane } : {}),
      ...(policy.budget ? { budget: policy.budget } : {}),
      ...(policy.idempotent ? { idempotent: true } : {}),
    };
    try {
      return await request(this.fetcher, url, { ...init, headers }, this.sleep, retry);
    } catch (e) {
      // Only an authenticated 401 with refresh credentials is retried after refresh.

      if (
        !(e instanceof ProviderError) ||
        e.status !== 401 ||
        !this.oauth ||
        !this.credentials.refresh_token
      ) {
        throw e;
      }
      if (headers.get("authorization") === `Bearer ${this.credentials.access_token}`) {
        await this.refresh();
      }
      headers.set("authorization", `Bearer ${this.credentials.access_token}`);
      return request(this.fetcher, url, { ...init, headers }, this.sleep, retry);
    }
  }
  protected async json<T>(
    url: string,
    init: RequestInit = {},
    policy: RequestPolicy = {},
  ): Promise<T> {
    return readJson<T>(await this.http(url, init, policy));
  }
  protected body(value: unknown, method = "POST"): RequestInit {
    return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
  }
  protected safeLink(link: string, origin: string): string {
    const url = new URL(link, origin);
    if (url.origin !== new URL(origin).origin || url.protocol !== "https:") {
      throw new ProviderError(
        "INVALID_RESPONSE",
        "Provider supplied an untrusted continuation URL",
      );
    }
    return url.href;
  }
}
