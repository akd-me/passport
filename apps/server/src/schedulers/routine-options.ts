import type { Schedule } from "@passport/scheduler";
import type { RoutineRunOn, Store } from "@passport/types";
import { ApiError } from "../errors.js";

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
  if (schedule.type !== "webhook" || !schedule.signature) {
    await store.encryptedKv?.delete("webhook-signature:" + id);
    return;
  }
  if (
    previous?.type === "webhook" &&
    previous.signature?.secretRef === schedule.signature.secretRef
  ) {
    return;
  }
  if (!store.encryptedKv || !store.secrets) {
    throw new ApiError(
      "SECRETS_UNAVAILABLE",
      "Webhook signatures require encrypted persistence",
      501,
    );
  }
  const secret = await store.secrets.take(schedule.signature.secretRef);
  if (secret === null) {
    throw new ApiError("SECRET_REF_INVALID", "Secret reference is missing or already used");
  }
  await store.encryptedKv.set("webhook-signature:" + id, secret);
}
