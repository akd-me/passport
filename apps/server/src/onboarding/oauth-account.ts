import { newId } from "@passport/store";
import type { Account, AccountCredentials, Store } from "@passport/types";
import type { Backend } from "../backend.js";
import { ApiError, required } from "../errors.js";
import { logger } from "../logger.js";
import { accountSync } from "./sync.js";

export type OAuthKind = "gmail" | "graph";

export const scopesFor = (kind: OAuthKind, calendar: boolean): string[] =>
  kind === "gmail"
    ? [
        "openid",
        "email",
        "https://www.googleapis.com/auth/gmail.modify",
        ...(calendar ? ["https://www.googleapis.com/auth/calendar.events"] : []),
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

export const calendarScope = (kind: OAuthKind) =>
  kind === "gmail" ? "https://www.googleapis.com/auth/calendar.events" : "Calendars.ReadWrite";

/** Mail and calendar use one grant; persist rotations to both encrypted records. */
export async function persistOAuthCredentials(
  store: Store,
  id: string,
  credentials: AccountCredentials,
): Promise<void> {
  const account = await store.accounts.get(id);
  if (!account) {
    return;
  }
  const group = account.settings.oauthGroup;
  const accounts = group
    ? (await store.accounts.list()).filter((a) => a.settings.oauthGroup === group)
    : [account];
  for (const sibling of accounts) {
    await store.accounts.setCredentials(sibling.id, credentials);
  }
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
  if (!response.ok) {
    throw new ApiError("OAUTH_IDENTITY_FAILED", "Could not read the authorized account identity");
  }
  const identity = (await response.json()) as {
    email?: string;
    mail?: string;
    userPrincipalName?: string;
    email_verified?: boolean;
  };
  const address = kind === "gmail" ? identity.email : identity.mail || identity.userPrincipalName;
  if (
    !address ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ||
    (kind === "gmail" && identity.email_verified === false)
  ) {
    throw new ApiError("OAUTH_IDENTITY_FAILED", "Provider did not return a verified email address");
  }
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
    : accounts.find((a) => a.kind === input.kind && a.emailAddress.toLowerCase() === emailAddress);
  if (
    existing &&
    (existing.kind !== input.kind || existing.emailAddress.toLowerCase() !== emailAddress)
  ) {
    throw new ApiError(
      "OAUTH_IDENTITY_MISMATCH",
      "Authorize the same address as the account being reconnected",
    );
  }
  const oldCredentials = existing ? await backend.store.accounts.getCredentials(existing.id) : null;
  const sameClient = existing?.settings.clientId === input.clientId;
  const tokens: AccountCredentials = {
    ...(sameClient && oldCredentials?.clientSecret
      ? { clientSecret: oldCredentials.clientSecret }
      : {}),
    ...credentials,
    ...(!credentials.refresh_token && sameClient && oldCredentials?.refresh_token
      ? { refresh_token: oldCredentials.refresh_token }
      : {}),
    scope: credentials.scope ?? scopesFor(input.kind, input.calendar).join(" "),
  };
  const granted =
    tokens.scope?.split(/\s+/).map((s) => s.replace("https://graph.microsoft.com/", "")) ?? [];
  const calendar = input.calendar && granted.includes(calendarScope(input.kind));
  const mailScopes =
    input.kind === "gmail"
      ? ["https://www.googleapis.com/auth/gmail.modify"]
      : ["Mail.ReadWrite", "Mail.Send"];
  if (!mailScopes.every((scope) => granted.includes(scope))) {
    throw new ApiError(
      "OAUTH_SCOPE_REQUIRED",
      "Grant the requested mail permissions to connect this account",
    );
  }
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
    if (!existing) {
      created.push(mail.id);
    }
    await backend.store.accounts.setCredentials(mail.id, tokens);
    if (calendar) {
      const kind = input.kind === "gmail" ? "google-calendar" : "graph-calendar";
      const oldCalendar = accounts.find(
        (a) =>
          a.kind === kind &&
          (a.settings.oauthGroup === group || a.settings.mailAccountId === group),
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
      if (!oldCalendar) {
        created.push(companion.id);
      }
      await backend.store.accounts.setCredentials(companion.id, tokens);
    }
    if (!calendar) {
      for (const sibling of accounts.filter((a) => a.settings.mailAccountId === group)) {
        await backend.store.accounts.upsert({
          ...sibling,
          settings: { ...sibling.settings, reauthorizationRequired: true },
          lastSyncError: "CALENDAR_SCOPE_NOT_GRANTED",
        });
      }
    }
    await persistOAuthCredentials(backend.store, mail.id, tokens);
    await backend.updateConfig({
      accounts: await backend.store.accounts.list(),
    });
  } catch (error) {
    // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

    for (const id of created.reverse()) {
      await backend.store.accounts.delete(id);
    }
    throw error;
  }
  const linked = (await backend.store.accounts.list()).filter(
    (a) => a.settings.oauthGroup === group && !a.settings.reauthorizationRequired,
  );
  for (const account of linked) {
    await accountSync(backend)?.reconnect(account.id);
    backend.bus.emit({ type: "account.changed", accountId: account.id });
    void backend.syncAccount(account.id).catch(() => {
      // Initial account sync failed; retaining its recorded failure.
      logger.warn("Initial account sync failed; retaining its recorded failure");

      /* Sync persists and broadcasts the bounded error code. */
    });
  }
  return mail;
}
