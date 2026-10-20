import { randomBytes } from "node:crypto";
import { newId } from "@passport/store";
import type { Account, AccountCredentials, Store } from "@passport/types";
import type { Backend } from "../backend.js";
import { ApiError, required } from "../errors.js";
import { accountSync } from "./sync.js";

export type OAuthKind = "gmail" | "graph";
export const scopesFor = (kind: OAuthKind, calendar: boolean): string[] =>
  kind === "gmail"
    ? [
        "openid",
        "email",
        "https://www.googleapis.com/auth/gmail.modify",
        ...(calendar
          ? ["https://www.googleapis.com/auth/calendar.events"]
          : []),
      ]
    : [
        "openid",
        "email",
        "offline_access",
        "User.Read",
        "Mail.ReadWrite",
        "Mail.Send",
        ...(calendar ? ["Calendars.ReadWrite"] : []),
      ];
const calendarScope = (kind: OAuthKind) =>
  kind === "gmail"
    ? "https://www.googleapis.com/auth/calendar.events"
    : "Calendars.ReadWrite";
export const oauthCookie = (state: string) =>
  `passport_oauth_${state.slice(0, 24)}`;

/** Mail and calendar use one grant; persist rotations to both encrypted records. */
export async function persistOAuthCredentials(
  store: Store,
  id: string,
  credentials: AccountCredentials,
): Promise<void> {
  const account = await store.accounts.get(id);
  if (!account) return;
  const group = account.settings.oauthGroup;
  const accounts = group
    ? (await store.accounts.list()).filter(
        (a) => a.settings.oauthGroup === group,
      )
    : [account];
  for (const sibling of accounts)
    await store.accounts.setCredentials(sibling.id, credentials);
}

export async function accountIdentity(
  kind: OAuthKind,
  credentials: AccountCredentials,
  fetcher = globalThis.fetch,
): Promise<string> {
  const url =
    kind === "gmail"
      ? "https://openidconnect.googleapis.com/v1/userinfo"
      : "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName";
  const response = await fetcher(url, {
    headers: { authorization: `Bearer ${credentials.access_token}` },
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new ApiError(
      "OAUTH_IDENTITY_FAILED",
      "Could not read the authorized account identity",
    );
  const identity = (await response.json()) as {
    email?: string;
    mail?: string;
    userPrincipalName?: string;
    email_verified?: boolean;
  };
  const address =
    kind === "gmail"
      ? identity.email
      : identity.mail || identity.userPrincipalName;
  if (
    !address ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ||
    (kind === "gmail" && identity.email_verified === false)
  )
    throw new ApiError(
      "OAUTH_IDENTITY_FAILED",
      "Provider did not return a verified email address",
    );
  return address.toLowerCase();
}

/** Idempotent per provider+identity; re-authorization retains local account IDs. */
export async function connectOAuthAccount(
  backend: Backend,
  input: {
    kind: OAuthKind;
    clientId: string;
    calendar: boolean;
    accountId?: string;
  },
  credentials: AccountCredentials,
  fetcher = globalThis.fetch,
): Promise<Account> {
  const emailAddress = await accountIdentity(input.kind, credentials, fetcher);
  const accounts = await backend.store.accounts.list();
  const existing = input.accountId
    ? required(await backend.store.accounts.get(input.accountId), "Account")
    : accounts.find(
        (a) =>
          a.kind === input.kind &&
          a.emailAddress.toLowerCase() === emailAddress,
      );
  if (
    existing &&
    (existing.kind !== input.kind ||
      existing.emailAddress.toLowerCase() !== emailAddress)
  )
    throw new ApiError(
      "OAUTH_IDENTITY_MISMATCH",
      "Authorize the same address as the account being reconnected",
    );
  const oldCredentials = existing
    ? await backend.store.accounts.getCredentials(existing.id)
    : null;
  const sameClient = existing?.settings.clientId === input.clientId;
  const tokens: AccountCredentials = {
    ...(sameClient && oldCredentials?.clientSecret
      ? { clientSecret: oldCredentials.clientSecret }
      : {}),
    ...credentials,
    ...(!credentials.refresh_token &&
    sameClient &&
    oldCredentials?.refresh_token
      ? { refresh_token: oldCredentials.refresh_token }
      : {}),
    scope: credentials.scope ?? scopesFor(input.kind, input.calendar).join(" "),
  };
  const granted =
    tokens.scope
      ?.split(/\s+/)
      .map((s) => s.replace("https://graph.microsoft.com/", "")) ?? [];
  const calendar =
    input.calendar && granted.includes(calendarScope(input.kind));
  const mailScopes =
    input.kind === "gmail"
      ? ["https://www.googleapis.com/auth/gmail.modify"]
      : ["Mail.ReadWrite", "Mail.Send"];
  if (!mailScopes.every((scope) => granted.includes(scope)))
    throw new ApiError(
      "OAUTH_SCOPE_REQUIRED",
      "Grant the requested mail permissions to connect this account",
    );
  const at = new Date().toISOString(),
    group = existing?.id ?? newId();
  const mail: Account = {
    id: group,
    kind: input.kind,
    emailAddress,
    displayName: existing?.displayName ?? emailAddress,
    capabilities: backend.providers.mail(input.kind).capabilities,
    settings: {
      ...existing?.settings,
      clientId: input.clientId,
      tenantId: "common",
      oauthGroup: group,
      calendarGranted: calendar,
      reauthorizationRequired: false,
    },
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
    lastSyncAt: existing?.lastSyncAt,
    lastSyncError: null,
  };
  const created: string[] = [];
  try {
    await backend.store.accounts.upsert(mail);
    if (!existing) created.push(mail.id);
    await backend.store.accounts.setCredentials(mail.id, tokens);
    if (calendar) {
      const kind =
        input.kind === "gmail" ? "google-calendar" : "graph-calendar";
      const oldCalendar = accounts.find(
        (a) =>
          a.kind === kind &&
          (a.settings.oauthGroup === group ||
            a.settings.mailAccountId === group),
      );
      const companion: Account = {
        ...mail,
        id: oldCalendar?.id ?? newId(),
        kind,
        displayName: `${mail.displayName} calendar`,
        createdAt: oldCalendar?.createdAt ?? at,
        lastSyncAt: oldCalendar?.lastSyncAt,
        capabilities: {
          mail: false,
          calendar: true,
          contacts: false,
          push: false,
          labels: false,
          submit: false,
        },
        settings: { ...mail.settings, mailAccountId: group },
      };
      await backend.store.accounts.upsert(companion);
      if (!oldCalendar) created.push(companion.id);
      await backend.store.accounts.setCredentials(companion.id, tokens);
    }
    if (!calendar)
      for (const sibling of accounts.filter(
        (a) => a.settings.mailAccountId === group,
      )) {
        await backend.store.accounts.upsert({
          ...sibling,
          settings: { ...sibling.settings, reauthorizationRequired: true },
          lastSyncError: "CALENDAR_SCOPE_NOT_GRANTED",
        });
      }
    await persistOAuthCredentials(backend.store, mail.id, tokens);
    await backend.updateConfig({
      accounts: await backend.store.accounts.list(),
    });
  } catch (error) {
    for (const id of created.reverse()) await backend.store.accounts.delete(id);
    throw error;
  }
  const linked = (await backend.store.accounts.list()).filter(
    (a) =>
      a.settings.oauthGroup === group && !a.settings.reauthorizationRequired,
  );
  for (const account of linked) {
    await accountSync(backend)?.reconnect(account.id);
    backend.bus.emit({ type: "account.changed", accountId: account.id });
    void backend.syncAccount(account.id).catch(() => {
      /* Sync persists and broadcasts the bounded error code. */
    });
  }
  return mail;
}

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
    for (const [state, entry] of this.pending)
      if (entry.expiresAt <= this.now()) this.pending.delete(state);
    for (const [state, entry] of this.statuses)
      if (entry.expiresAt <= this.now()) this.statuses.delete(state);
  }
  async start(input: Record<string, unknown>, origin: string) {
    this.prune();
    if (this.pending.size >= 100)
      throw new ApiError(
        "OAUTH_BUSY",
        "Too many pending connections; try again later",
        409,
      );
    if (input.kind !== "gmail" && input.kind !== "graph")
      throw new ApiError("INVALID_PROVIDER", "Choose Gmail or Outlook");
    if (this.backend.mode === "demo")
      throw new ApiError(
        "DEMO_ONLY",
        "Start passport serve to connect real accounts",
      );
    if (typeof input.clientId !== "string" || !input.clientId.trim())
      throw new ApiError("MISSING_FIELD", "Client ID is required");
    if (
      input.clientSecret !== undefined &&
      typeof input.clientSecret !== "string"
    )
      throw new ApiError("INVALID_FIELD", "Client secret must be text");
    if (input.calendar !== undefined && typeof input.calendar !== "boolean")
      throw new ApiError("INVALID_FIELD", "Calendar must be a checkbox value");
    const url = new URL(origin);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      throw new ApiError(
        "INVALID_REDIRECT",
        "Open Passport on an HTTP loopback address to connect accounts",
      );
    const accountId =
      typeof input.accountId === "string" ? input.accountId : undefined;
    if (
      accountId &&
      required(await this.backend.store.accounts.get(accountId), "Account")
        .kind !== input.kind
    )
      throw new ApiError(
        "INVALID_PROVIDER",
        "Re-authorize using the account's provider",
      );
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
    if (!status || !nonce || status.nonce !== nonce)
      throw new ApiError(
        "OAUTH_STATE",
        "Authorization expired or belongs to another browser",
      );
    const { nonce: _nonce, expiresAt: _expires, ...safe } = status;
    return safe;
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
      this.prune();
      throw new ApiError(
        "OAUTH_STATE",
        "Authorization state is invalid or expired; reconnect from Accounts",
      );
    }
    this.pending.delete(state); // consume before any network work; callbacks cannot race or replay
    const status = this.statuses.get(state)!;
    try {
      if (url.searchParams.has("error") || !url.searchParams.get("code"))
        throw new ApiError("OAUTH_DENIED", "Authorization was not completed");
      const credentials = await this.backend.providers
        .describe(entry.kind)
        .oauth!.exchangeCode(
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
      status.status = "failed";
      status.error =
        error instanceof ApiError
          ? error.message
          : "Authorization failed. Check your OAuth client and try again.";
      throw error;
    }
  }
}
