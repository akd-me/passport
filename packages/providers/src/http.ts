import type { Account, AccountCredentials, Email } from "@passport/types";
import { ProviderError, required } from "./errors.js";
import type { PassportVerifier } from "./verification.js";
import { resolveReplyEmail } from "./reply.js";

export interface ProviderOptions {
  fetch?: typeof fetch;
  /** Persist refreshed/rotated credentials through the store's encrypted credential API. */
  onCredentials?: (accountId: string, credentials: AccountCredentials) => Promise<void> | void;
  verifier?: PassportVerifier;
  now?: () => Date;
  /** Resolve store IDs (e.g. ULIDs) when composing a reply; omit when retaining adapter IDs. */
  resolveEmail?: (id: string) => Promise<Email | null>;
}

export async function request(fetcher: typeof fetch, url: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try { response = await fetcher(url, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(30_000) }); }
  catch { throw new ProviderError("NETWORK_ERROR", "Provider request failed or timed out"); }
  if (!response.ok) throw new ProviderError(response.status === 401 ? "AUTH_FAILED" : response.status === 429 ? "RATE_LIMITED" : `HTTP_${response.status}`, `Provider request failed (HTTP ${response.status})`, response.status);
  return response;
}

export async function readJson<T>(response: Response): Promise<T> {
  try { const value: unknown = await response.json(); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as T; }
  catch { throw new ProviderError("INVALID_RESPONSE", "Provider returned invalid JSON"); }
}

export const googleTokenUrl = "https://oauth2.googleapis.com/token";
export function microsoftTokenUrl(tenant = "common"): string { return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`; }

export async function exchangeToken(fetcher: typeof fetch, url: string, fields: Record<string, string>): Promise<AccountCredentials> {
  const token = await readJson<Record<string, unknown>>(await request(fetcher, url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) }));
  if (typeof token.access_token !== "string") throw new ProviderError("INVALID_RESPONSE", "OAuth response has no access_token");
  const result: AccountCredentials = {};
  for (const key of ["access_token", "refresh_token", "token_type", "scope"]) if (typeof token[key] === "string") result[key] = token[key];
  if (typeof token.expires_in === "number" || typeof token.expires_in === "string") result.expires_at = String(Date.now() + Number(token.expires_in) * 1000);
  return result;
}

export class HttpConnection {
  protected account!: Account;
  protected credentials: AccountCredentials = {};
  protected connected = false;
  protected readonly fetcher: typeof fetch;
  private refreshing?: Promise<void>;
  constructor(protected readonly options: ProviderOptions = {}, private readonly oauth?: "google" | "microsoft") { this.fetcher = options.fetch ?? globalThis.fetch; }
  async connect(account: Account, credentials: AccountCredentials): Promise<void> {
    if (this.connected && this.account.id !== account.id) throw new ProviderError("ACCOUNT_MISMATCH", "Use a separate provider instance per account");
    this.account = structuredClone(account); this.credentials = { ...credentials }; this.connected = true;
  }
  async disconnect(): Promise<void> { this.connected = false; this.credentials = {}; }
  protected check(): void { if (!this.connected) throw new ProviderError("NOT_CONNECTED", "Connect the provider first"); }
  protected now(): Date { return this.options.now?.() ?? new Date(); }
  protected async reply(id: string | null | undefined, getEmail: (providerId: string) => Promise<Email | null>): Promise<Email | null> {
    this.check(); if (!id) return null;
    return resolveReplyEmail(this.account.id, id, getEmail, this.options.resolveEmail);
  }
  protected async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      if (!this.oauth) throw new ProviderError("AUTH_FAILED", "The provider token has expired");
      if (!this.credentials.refresh_token) throw new ProviderError("OAUTH_REFRESH_FAILED", "Re-authorize this account to renew access");
      let token: AccountCredentials;
      try { token = await exchangeToken(this.fetcher, this.oauth === "google" ? googleTokenUrl : microsoftTokenUrl(String(this.account.settings.tenantId ?? "common")), {
        grant_type: "refresh_token", refresh_token: required(this.credentials.refresh_token, "refresh_token"),
        client_id: required(this.account.settings.clientId ?? this.credentials.client_id, "clientId"),
        ...(this.credentials.clientSecret || this.credentials.client_secret ? { client_secret: this.credentials.clientSecret ?? this.credentials.client_secret! } : {}),
      }); } catch (error) {
        if (error instanceof ProviderError && [400, 401].includes(error.status ?? 0)) throw new ProviderError("OAUTH_REFRESH_FAILED", "Re-authorize this account to renew access");
        throw error;
      }
      this.credentials = { ...this.credentials, ...token };
      await this.options.onCredentials?.(this.account.id, { ...this.credentials });
    })();
    try { await this.refreshing; } finally { this.refreshing = undefined; }
  }
  protected async http(url: string, init: RequestInit = {}): Promise<Response> {
    this.check();
    if (this.oauth && (!this.credentials.access_token || (this.credentials.expires_at && Number(this.credentials.expires_at) < this.now().getTime() + 60_000))) await this.refresh();
    const headers = new Headers(init.headers);
    const token = this.credentials.access_token ?? this.credentials.token;
    if (token) headers.set("authorization", `Bearer ${token}`);
    else if (this.credentials.password) headers.set("authorization", `Basic ${Buffer.from(`${this.account.settings.username ?? this.account.emailAddress}:${this.credentials.password}`).toString("base64")}`);
    else throw new ProviderError("CONFIG_REQUIRED", "Missing provider credentials");
    try { return await request(this.fetcher, url, { ...init, headers }); }
    catch (e) {
      if (!(e instanceof ProviderError) || e.status !== 401 || !this.oauth || !this.credentials.refresh_token) throw e;
      if (headers.get("authorization") === `Bearer ${this.credentials.access_token}`) await this.refresh();
      headers.set("authorization", `Bearer ${this.credentials.access_token}`);
      return request(this.fetcher, url, { ...init, headers });
    }
  }
  protected async json<T>(url: string, init: RequestInit = {}): Promise<T> { return readJson<T>(await this.http(url, init)); }
  protected body(value: unknown, method = "POST"): RequestInit { return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(value) }; }
  protected safeLink(link: string, origin: string): string {
    const url = new URL(link, origin);
    if (url.origin !== new URL(origin).origin || url.protocol !== "https:") throw new ProviderError("INVALID_RESPONSE", "Provider supplied an untrusted continuation URL");
    return url.href;
  }
}
