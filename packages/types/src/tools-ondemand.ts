/**
 * Additive contract (v0.3): pieces of the on-demand tool belt that providers implement and the
 * tool registry consumes (`provider_get`). Re-exported from `./index.ts`.
 */

import type { ProviderKind } from "./index.js";
import type { MailReadOptions, ReadValue } from "./ondemand.js";

/** Raw provider response returned by `MailReader.rawGet`. The body is untrusted provider data. */
export interface RawGetResponse {
  /** HTTP status of the provider response. */
  status: number;
  /** Parsed JSON body, or text for non-JSON responses. */
  body: unknown;
}

declare module "./ondemand.js" {
  interface MailReader {
    /**
     * Optional read-only escape hatch behind the `provider_get` tool: one HTTP GET against the
     * provider API, relative to its base URL (`https://gmail.googleapis.com/gmail/v1/`,
     * `https://graph.microsoft.com/v1.0/`). Callers check `isProviderGetAllowed` first and
     * implementations must check it again. Goes through the quota governor like every read.
     */
    rawGet?(
      path: string,
      query: Record<string, string>,
      opts?: MailReadOptions,
    ): Promise<ReadValue<RawGetResponse>>;
  }
}

/**
 * Path prefixes `provider_get` may read, per provider kind. A path is allowed when it equals a
 * prefix or continues it with `/`. Providers without an entry have no raw GET.
 */
export const PROVIDER_GET_ALLOWLIST: Readonly<Partial<Record<ProviderKind, readonly string[]>>> = {
  gmail: [
    "users/me/messages",
    "users/me/threads",
    "users/me/labels",
    "users/me/history",
    "users/me/drafts",
    "users/me/settings/filters",
    "users/me/settings/sendAs",
  ],
  graph: [
    "me/messages",
    "me/mailFolders",
    "me/events",
    "me/calendarView",
    "me/people",
    "me/contacts",
    "me/mailboxSettings",
    "me/outlook/masterCategories",
  ],
};

/**
 * Normalizes a `provider_get` path (strips leading `/`) and checks it against
 * `PROVIDER_GET_ALLOWLIST`. Returns the normalized path, or null when it is not allowed
 * (unknown prefix, `..`, `$batch`, a query string, or characters outside a safe set).
 */
export function isProviderGetAllowed(kind: ProviderKind, path: string): string | null {
  const normalized = path.trim().replace(/^\/+/, "");
  if (
    !/^[A-Za-z0-9_\-./=$@!]+$/.test(normalized) ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return null;
  }
  if (/\$batch/i.test(normalized)) {
    return null;
  }
  const prefixes = PROVIDER_GET_ALLOWLIST[kind] ?? [];
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))
    ? normalized
    : null;
}
