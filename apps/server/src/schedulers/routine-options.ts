import type { Schedule } from "@passport/scheduler";
import type { RoutineRunOn, Store } from "@passport/types";
import { ApiError } from "../errors.js";
import { consumeSecretReferences, secretReferences } from "./secret-references.js";

export function validateRunOn(value: unknown): RoutineRunOn {
  if (value === undefined) {
    return "bound";
  }
  if (value !== "bound" && value !== "fresh") {
    throw new ApiError("INVALID_FIELD", "runOn must be bound or fresh");
  }
  return value;
}
/** A one-use ref installs the signing secret into a private, persistent consumer slot. */
export async function prepareRoutineSignature(
  store: Store,
  id: string,
  schedule: Schedule,
  previous?: Schedule,
) {
  const key = "webhook-signature:" + id;
  const unchanged = { commit: async () => {}, rollback: async () => {} };
  if (schedule.type !== "webhook" || !schedule.signature) {
    const previousSecret = await store.encryptedKv?.get(key);
    await store.encryptedKv?.delete(key);
    return {
      ...unchanged,
      rollback: async () => {
        if (previousSecret != null) {
          await store.encryptedKv?.set(key, previousSecret);
        }
      },
    };
  }
  if (
    previous?.type === "webhook" &&
    previous.signature?.secretRef === schedule.signature.secretRef
  ) {
    return unchanged;
  }
  if (!store.encryptedKv || !store.secrets) {
    throw new ApiError(
      "SECRETS_UNAVAILABLE",
      "Webhook signatures require encrypted persistence",
      501,
    );
  }
  const secret = await secretReferences(store).peek(schedule.signature.secretRef);
  if (secret === null) {
    throw new ApiError("SECRET_REF_INVALID", "Secret reference is missing or already used");
  }
  const previousSecret = await store.encryptedKv.get(key);
  const rollback = async () => {
    if (previousSecret === null) {
      await store.encryptedKv!.delete(key);
    } else {
      await store.encryptedKv!.set(key, previousSecret);
    }
  };
  try {
    await store.encryptedKv.set(key, secret);
  } catch (error) {
    await rollback();
    throw error;
  }
  return {
    commit: () => consumeSecretReferences(store, [schedule.signature!.secretRef]),
    rollback,
  };
}
