import type { Email } from "@passport/types";
import { ProviderError } from "./errors.js";

/** Resolve store IDs first, then adapter-scoped IDs or native provider IDs. */
export async function resolveReplyEmail(
  accountId: string,
  id: string | null | undefined,
  getEmail: (providerId: string) => Promise<Email | null>,
  resolveEmail?: (id: string) => Promise<Email | null>,
): Promise<Email | null> {
  if (!id) return null;
  const prefix = `${accountId}:email:`;
  const email = await resolveEmail?.(id) ?? await getEmail(id.startsWith(prefix) ? decodeURIComponent(id.slice(prefix.length)) : id);
  if (!email || email.accountId !== accountId) throw new ProviderError("REPLY_NOT_FOUND", "Reply email does not exist in this account; provide resolveEmail for store IDs");
  return email;
}
