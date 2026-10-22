import { ApiError } from "../errors.js";
import { logger } from "../logger.js";

export const DEFAULT_WATCH_INTERVAL_SECONDS = 30;
let warnedInitialDays = false;

/** `sync.initialDays` configured the retired mail mirror. It is accepted and ignored. */
export function warnDeprecatedSyncConfig(config: { sync?: { initialDays?: number } }): void {
  if (config.sync?.initialDays !== undefined && !warnedInitialDays) {
    warnedInitialDays = true;
    logger.warn(
      "sync.initialDays is deprecated and ignored: Passport no longer backfills mail. Remove it from passport.config.json.",
    );
  }
}
/** Test hook: lets one process observe the one-time warning again. */
export function resetDeprecationWarnings(): void {
  warnedInitialDays = false;
}

export function watchIntervalSeconds(config: { watch?: { intervalSeconds?: number } }): number {
  const seconds = config.watch?.intervalSeconds ?? DEFAULT_WATCH_INTERVAL_SECONDS;
  if (!Number.isFinite(seconds) || seconds < 5 || seconds > 86400) {
    throw new ApiError("INVALID_CONFIG", "watch.intervalSeconds must be 5–86400");
  }
  return seconds;
}
