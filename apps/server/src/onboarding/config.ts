import { ApiError } from "../errors.js";

export function initialDays(config: { sync?: { initialDays?: number } }): number {
  const days = config.sync?.initialDays ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 36500)
    throw new ApiError("INVALID_CONFIG", "sync.initialDays must be 1–36500");
  return days;
}
