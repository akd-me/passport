import { randomBytes } from "node:crypto";
import type { Account } from "@passport/types";
import type { Backend } from "../backend.js";
import { ApiError, required } from "../errors.js";
import {
  connectOAuthAccount,
  type OAuthKind,
  SETUP_ENDED_MESSAGE,
  scopesFor,
} from "./oauth-account.js";

export {
  connectOAuthAccount,
  persistOAuthCredentials,
  SETUP_ENDED_MESSAGE,
  scopesFor,
} from "./oauth-account.js";

export const oauthCookie = (state: string) => `passport_oauth_${state.slice(0, 24)}`;

interface Pending {
  kind: OAuthKind;
  clientId: string;
  clientSecret?: string;
  calendar: boolean;
  accountId?: string;
  nonce: string;
  expiresAt: number;
  redirectUri: string;
  codeVerifier: string;
  /** Set for setup-task attempts: false once the task has ended. */
  active?: () => boolean;
}

/** In-memory, single-use attempts expire after ten minutes, including any client secret. */
export class BrowserOAuth {
  private pending = new Map<string, Pending>();
  private statuses = new Map<
    string,
    {
      nonce: string;
      expiresAt: number;
      accountId?: string;
      error?: string;
      status: string;
      revoked?: boolean;
    }
  >();
  constructor(
    private backend: Backend,
    private options: { now?: () => number; fetch?: typeof fetch } = {},
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private prune() {
    for (const [state, entry] of this.pending) {
      if (entry.expiresAt <= this.now()) {
        this.pending.delete(state);
      }
    }
    for (const [state, entry] of this.statuses) {
      if (entry.expiresAt <= this.now()) {
        this.statuses.delete(state);
      }
    }
  }
  /** `owner` binds the attempt to a setup task; its callback re-checks `active()` before persisting. */
  async start(input: Record<string, unknown>, origin: string, owner?: { active(): boolean }) {
    this.prune();
    if (this.pending.size >= 100) {
      throw new ApiError("OAUTH_BUSY", "Too many pending connections; try again later", 409);
    }
    if (input.kind !== "gmail" && input.kind !== "graph") {
      throw new ApiError("INVALID_PROVIDER", "Choose Gmail or Outlook");
    }
    if (this.backend.mode === "demo") {
      throw new ApiError("DEMO_ONLY", "Start passport serve to connect real accounts");
    }
    if (typeof input.clientId !== "string" || !input.clientId.trim()) {
      throw new ApiError("MISSING_FIELD", "Client ID is required");
    }
    if (input.clientSecret !== undefined && typeof input.clientSecret !== "string") {
      throw new ApiError("INVALID_FIELD", "Client secret must be text");
    }
    if (input.calendar !== undefined && typeof input.calendar !== "boolean") {
      throw new ApiError("INVALID_FIELD", "Calendar must be a checkbox value");
    }
    const url = new URL(origin);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new ApiError(
        "INVALID_REDIRECT",
        "Open Passport on an HTTP loopback address to connect accounts",
      );
    }
    const accountId = typeof input.accountId === "string" ? input.accountId : undefined;
    if (
      accountId &&
      required(await this.backend.store.accounts.get(accountId), "Account").kind !== input.kind
    ) {
      throw new ApiError("INVALID_PROVIDER", "Re-authorize using the account's provider");
    }
    const state = randomBytes(32).toString("base64url");
    const entry: Pending = {
      kind: input.kind,
      clientId: input.clientId.trim(),
      clientSecret: input.clientSecret || undefined,
      calendar: input.calendar !== false,
      accountId,
      nonce: randomBytes(32).toString("base64url"),
      expiresAt: this.now() + 600000,
      redirectUri: `${url.origin}/oauth/callback`,
      codeVerifier: randomBytes(48).toString("base64url"),
      ...(owner ? { active: () => owner.active() } : {}),
    };
    this.pending.set(state, entry);
    this.statuses.set(state, {
      nonce: entry.nonce,
      expiresAt: entry.expiresAt,
      status: "authorizing",
    });
    const oauth = this.backend.providers.describe(entry.kind).oauth!;
    const authUrl = oauth.buildAuthUrl(
      {
        clientId: entry.clientId,
        codeVerifier: entry.codeVerifier,
        tenantId: "common",
        scopes: scopesFor(entry.kind, entry.calendar).join(" "),
      },
      entry.redirectUri,
      state,
    );
    return {
      authUrl,
      attemptId: state,
      redirectUri: entry.redirectUri,
      nonce: entry.nonce,
    };
  }
  status(state: string, nonce?: string) {
    this.prune();
    const status = this.statuses.get(state);
    if (!status || !nonce || status.nonce !== nonce) {
      throw new ApiError("OAUTH_STATE", "Authorization expired or belongs to another browser");
    }
    const { nonce: _nonce, expiresAt: _expires, revoked: _revoked, ...safe } = status;
    return safe;
  }
  /** Server-side progress of an attempt, without the browser binding. Undefined once expired. */
  peek(state: string) {
    this.prune();
    const status = this.statuses.get(state);
    if (!status) {
      return;
    }
    const { nonce: _nonce, expiresAt: _expires, revoked: _revoked, ...safe } = status;
    return safe;
  }
  /**
   * End an attempt that has not reached its callback, dropping its client secret. A callback
   * already in flight is stopped by its owner check instead.
   */
  revoke(state: string): void {
    if (!this.pending.delete(state)) {
      return;
    }
    const status = this.statuses.get(state);
    if (status) {
      status.status = "failed";
      status.error = SETUP_ENDED_MESSAGE;
      status.revoked = true;
    }
  }
  async callback(url: URL, nonce?: string): Promise<Account> {
    const state = url.searchParams.get("state") ?? "";
    const entry = this.pending.get(state);
    if (
      !entry ||
      entry.expiresAt <= this.now() ||
      !nonce ||
      entry.nonce !== nonce ||
      url.origin !== new URL(entry.redirectUri).origin
    ) {
      if (!entry && this.statuses.get(state)?.revoked) {
        throw new ApiError("OAUTH_SETUP_ENDED", SETUP_ENDED_MESSAGE, 409);
      }
      this.prune();
      throw new ApiError(
        "OAUTH_STATE",
        "Authorization state is invalid or expired; reconnect from Accounts",
      );
    }
    this.pending.delete(state); // consume before any network work; callbacks cannot race or replay
    const status = this.statuses.get(state)!;
    try {
      if (url.searchParams.has("error") || !url.searchParams.get("code")) {
        throw new ApiError("OAUTH_DENIED", "Authorization was not completed");
      }
      const credentials = await this.backend.providers.describe(entry.kind).oauth!.exchangeCode(
        {
          clientId: entry.clientId,
          ...(entry.clientSecret ? { clientSecret: entry.clientSecret } : {}),
          codeVerifier: entry.codeVerifier,
          tenantId: "common",
          scopes: scopesFor(entry.kind, entry.calendar).join(" "),
        },
        entry.redirectUri,
        url.searchParams.get("code")!,
      );
      const account = await connectOAuthAccount(
        this.backend,
        entry,
        credentials,
        this.options.fetch,
      );
      status.accountId = account.id;
      status.status = "connected";
      return account;
    } catch (error) {
      // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

      status.status = "failed";
      status.error =
        error instanceof ApiError
          ? error.message
          : "Authorization failed. Check your OAuth client and try again.";
      throw error;
    }
  }
}

const instances = new WeakMap<Backend, BrowserOAuth>();

/** One attempt table per backend, so routes and setup tasks see the same callbacks. */
export function browserOAuth(backend: Backend): BrowserOAuth {
  let oauth = instances.get(backend);
  if (!oauth) {
    oauth = new BrowserOAuth(backend);
    instances.set(backend, oauth);
  }
  return oauth;
}
