import type { Store, StoreSecrets } from "@passport/types";
import { ApiError } from "../errors.js";

/** Store extension local to this stream until the shared contract adds these methods. */
export interface SecretReferenceStore extends StoreSecrets {
  peek(ref: string): Promise<string | null>;
  consume(refs: string[]): Promise<boolean>;
  sweepExpired?(): Promise<number>;
}

export function secretReferences(store: Store): SecretReferenceStore {
  const secrets = store.secrets as SecretReferenceStore | undefined;
  if (!secrets?.peek || !secrets.consume) {
    throw new ApiError(
      "SECRETS_UNAVAILABLE",
      "Secret references require encrypted persistence",
      501,
    );
  }
  return secrets;
}

export async function consumeSecretReferences(store: Store, refs: string[]) {
  if (refs.length && !(await secretReferences(store).consume(refs))) {
    throw new ApiError(
      "SECRET_REF_INVALID",
      "Secret reference is missing, expired or already used",
    );
  }
}
