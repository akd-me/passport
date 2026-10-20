import type {
  Account,
  AccountCapabilities,
  AccountCredentials,
  ProviderKind,
} from "@passport/types";
import type { Backend } from "./backend.js";
import { ApiError } from "./errors.js";
import { member, object, string } from "./validation.js";

/** Descriptor fields marked secret are sent exclusively to the credential store. */
export async function addAccount(
  backend: Backend,
  input: unknown,
): Promise<Account> {
  const body = object(input),
    kind = member(body.kind, backend.providerKinds, "provider") as ProviderKind;
  const descriptor = backend.providers.describe(kind),
    fields = object(body.fields);
  const settings: Account["settings"] = {},
    credentials: AccountCredentials = {};
  for (const key of Object.keys(fields))
    if (!descriptor.fields.some((f) => f.id === key))
      throw new ApiError("INVALID_FIELD", `Unknown provider field ${key}`);
  for (const field of descriptor.fields) {
    const value = fields[field.id];
    if (field.required && (typeof value !== "string" || !value.trim()))
      throw new ApiError("MISSING_FIELD", `${field.label} is required`);
    if (value === undefined || value === "") continue;
    const text = string(value, field.label);
    if (field.secret) credentials[field.id] = text;
    else settings[field.id] = text;
  }
  const emailAddress = string(
    body.emailAddress ?? settings.emailAddress,
    "emailAddress",
  );
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress))
    throw new ApiError("INVALID_FIELD", "Enter a valid email address");
  const capabilities: AccountCapabilities =
    kind === "mock"
      ? {
          mail: true,
          calendar: true,
          contacts: true,
          push: false,
          labels: true,
          submit: true,
        }
      : [
            "google-calendar",
            "graph-calendar",
            "caldav",
            "jmap-calendar",
          ].includes(kind)
        ? {
            mail: false,
            calendar: true,
            contacts: false,
            push: false,
            labels: false,
            submit: false,
          }
        : backend.providers.mail(kind as "gmail").capabilities;
  const at = new Date().toISOString();
  const account: Account = {
    id: crypto.randomUUID(),
    kind,
    emailAddress,
    displayName:
      typeof body.displayName === "string"
        ? body.displayName
        : String(settings.displayName ?? descriptor.label),
    capabilities,
    settings,
    createdAt: at,
    updatedAt: at,
  };
  await backend.store.accounts.upsert(account);
  try {
    await backend.store.accounts.setCredentials(account.id, credentials);
    await backend.updateConfig({
      accounts: await backend.store.accounts.list(),
    });
  } catch (error) {
    await backend.store.accounts.delete(account.id);
    throw error;
  }
  return account;
}
