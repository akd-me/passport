import { newId } from "@passport/store";
import type {
  Account,
  AccountCapabilities,
  AccountCredentials,
  ProviderKind,
} from "@passport/types";
import type { Backend } from "./backend.js";
import { ApiError } from "./errors.js";
import { isSecretReference, resolveAccountSecrets } from "./schedulers/account-secrets.js";
import { member, object, string } from "./validation.js";

/** Descriptor fields marked secret are sent exclusively to the credential store. */
export async function addAccount(
  backend: Backend,
  input: unknown,
  oauthCredentials?: AccountCredentials,
): Promise<Account> {
  const body = object(input),
    kind = member(body.kind, backend.providerKinds, "provider") as ProviderKind;
  const descriptor = backend.providers.describe(kind),
    fields = object(body.fields);
  const settings: Account["settings"] = {},
    credentials: AccountCredentials = {};
  for (const key of Object.keys(fields)) {
    if (!descriptor.fields.some((f) => f.id === key)) {
      throw new ApiError("INVALID_FIELD", `Unknown provider field ${key}`);
    }
  }
  for (const field of descriptor.fields) {
    const value = fields[field.id];
    if (
      field.required &&
      !(field.secret && isSecretReference(value)) &&
      (typeof value !== "string" || !value.trim())
    ) {
      throw new ApiError("MISSING_FIELD", `${field.label} is required`);
    }
    if (value === undefined || value === "") {
      continue;
    }
    if (field.secret && isSecretReference(value)) {
      continue;
    }
    const text = string(value, field.label);
    if (field.secret) {
      credentials[field.id] = text;
    } else if (["port", "smtpPort"].includes(field.id)) {
      const port = Number(text);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ApiError("INVALID_FIELD", `${field.label} must be 1–65535`);
      }
      settings[field.id] = port;
    } else if (["tls", "smtpTls"].includes(field.id)) {
      if (!["true", "false"].includes(text)) {
        throw new ApiError("INVALID_FIELD", `${field.label} must be true or false`);
      }
      settings[field.id] = text === "true";
    } else {
      settings[field.id] = text;
    }
  }
  const emailAddress = string(body.emailAddress ?? settings.emailAddress, "emailAddress");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress)) {
    throw new ApiError("INVALID_FIELD", "Enter a valid email address");
  }
  const capabilities: AccountCapabilities =
    kind === "mock" && backend.mode === "demo"
      ? {
          mail: true,
          calendar: true,
          contacts: true,
          push: false,
          labels: true,
          submit: true,
        }
      : ["google-calendar", "graph-calendar", "caldav", "jmap-calendar"].includes(kind)
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
    id: newId(),
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
  const resolvedFields = await resolveAccountSecrets(backend.store, descriptor, fields);
  for (const field of descriptor.fields) {
    if (field.secret && isSecretReference(fields[field.id])) {
      credentials[field.id] = resolvedFields[field.id] as string;
    }
  }
  await backend.store.accounts.upsert(account);
  try {
    delete credentials.codeVerifier;
    await backend.store.accounts.setCredentials(account.id, {
      ...credentials,
      ...oauthCredentials,
    });
    await backend.updateConfig({
      accounts: await backend.store.accounts.list(),
    });
  } catch (error) {
    // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

    await backend.store.accounts.delete(account.id);
    throw error;
  }
  return account;
}
