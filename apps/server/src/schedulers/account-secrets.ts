import type { ProviderSetupDescriptor, Store } from "@passport/types";
import { ApiError } from "../errors.js";

export function isSecretReference(value: unknown): value is { secretRef: string } {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    "secretRef" in value &&
    typeof value.secretRef === "string" &&
    !!value.secretRef
  );
}

/** IMAP and other secret descriptor fields accept {secretRef} instead of a plaintext value. */
export async function resolveAccountSecrets(
  store: Store,
  descriptor: Pick<ProviderSetupDescriptor, "fields">,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const resolved = { ...fields };
  for (const field of descriptor.fields) {
    const value = fields[field.id];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    if (!field.secret || !isSecretReference(value)) {
      throw new ApiError("INVALID_FIELD", "Only secret fields accept a secretRef");
    }
    const secret = await store.secrets?.take(value.secretRef);
    if (secret == null) {
      throw new ApiError("SECRET_REF_INVALID", "Secret reference is missing or already used");
    }
    resolved[field.id] = secret;
  }
  return resolved;
}
