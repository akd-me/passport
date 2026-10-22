import type { Account } from "@passport/types";
import type { Backend } from "../backend.js";
import type { DoctorCheck } from "../doctor.js";
import { watchIntervalSeconds } from "../onboarding/config.js";
import { readWatchStatus } from "./status.js";

const minutes = (ms: number) => `${Math.max(0, Math.floor(ms / 60000))} minutes`;

/** Watcher health (cursor age, last tick) for mail; bounded sync age for calendars. */
export async function watchChecks(
  backend: Backend,
  account: Account,
  now: number,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  if (account.capabilities.mail) {
    const interval = watchIntervalSeconds(backend.config);
    const watch = await readWatchStatus(backend.store, account, interval, now);
    const lastTick = watch?.lastTickAt ? now - Date.parse(watch.lastTickAt) : null;
    const details: Record<string, string> = {
      watching: `Last check ${lastTick === null ? "never" : `${minutes(lastTick)} ago`}; cursor ${watch?.cursorAgeSeconds ?? 0}s old`,
      starting: "Watcher has not checked for new mail yet",
      stale: `No new-mail check for ${lastTick === null ? "a while" : minutes(lastTick)}`,
      backoff: `Rate limited; next check after ${watch?.retryAt ?? "a short wait"}`,
      error: `Last check failed: ${watch?.error ?? "WATCH_FAILED"}`,
      unsupported: "This provider cannot be watched yet",
      "needs-sign-in": "Paused until you re-authorize this account",
    };
    checks.push({
      name: `${account.emailAddress} watcher`,
      accountId: account.id,
      status: watch?.status === "watching" ? "ok" : "warning",
      detail: details[watch?.status ?? "starting"] ?? "Unknown watcher state",
    });
  }
  if (account.capabilities.calendar) {
    const age = account.lastSyncAt ? now - Date.parse(account.lastSyncAt) : Infinity;
    checks.push({
      name: `${account.emailAddress} calendar sync`,
      accountId: account.id,
      status:
        age <= Math.max(600000, backend.config.syncIntervalSeconds * 3000) && !account.lastSyncError
          ? "ok"
          : "warning",
      detail:
        account.lastSyncError ??
        (Number.isFinite(age) ? `Last success ${minutes(age)} ago` : "Calendar has not synced yet"),
    });
  }
  return checks;
}
