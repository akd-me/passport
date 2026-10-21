import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "./errors.js";
import { logger } from "./logger.js";

const OWNER_HEARTBEAT_MS = 10_000;
const OWNER_STALE_MS = 60_000;
export interface OwnerRecord {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  id: string;
}

function readOwner(dataDir: string): OwnerRecord | null {
  try {
    return JSON.parse(readFileSync(join(dataDir, "owner.lock"), "utf8"));
  } catch (error) {
    // Missing or malformed ownership metadata means there is no usable owner record.

    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
export function activeOwner(dataDir: string): OwnerRecord | null {
  const owner = readOwner(dataDir);
  if (
    !owner ||
    !Number.isInteger(owner.pid) ||
    owner.pid < 1 ||
    !Number.isFinite(Date.parse(owner.heartbeatAt)) ||
    Date.now() - Date.parse(owner.heartbeatAt) >= OWNER_STALE_MS
  ) {
    return null;
  }
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    // Owner process probe failed; retaining the conservative owner state.
    logger.warn("Owner process probe failed; retaining the conservative owner state");

    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return null;
    }
  }
  return owner;
}

/** A short synchronous critical section protects publication, takeover and deletion. */
function guarded<T>(dataDir: string, task: () => T): T {
  const guard = join(dataDir, "owner.lock.guard");
  try {
    mkdirSync(guard, { mode: 0o700 });
  } catch (error) {
    // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    if (Date.now() - statSync(guard).mtimeMs < OWNER_STALE_MS) {
      throw new ApiError("OWNER_BUSY", "Workspace ownership is being updated; retry the command.");
    }
    rmSync(guard, { recursive: true, force: true });
    mkdirSync(guard, { mode: 0o700 });
  }
  try {
    return task();
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}
function publish(dataDir: string, owner: OwnerRecord) {
  const path = join(dataDir, "owner.lock"),
    temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(owner) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Only serve/demo acquire this lease. Clients never heartbeat or remove it. */
export function acquireOwner(dataDir: string, onLost: () => void = () => {}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const owner: OwnerRecord = {
    pid: process.pid,
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  guarded(dataDir, () => {
    const existing = activeOwner(dataDir);
    if (existing) {
      throw new ApiError(
        "OWNER_RUNNING",
        `Passport already owns this data directory (pid ${existing.pid}). Use the running server or stop it first.`,
      );
    }
    publish(dataDir, owner);
  });
  let released = false;
  const timer = setInterval(() => {
    try {
      guarded(dataDir, () => {
        if (readOwner(dataDir)?.id !== owner.id) {
          throw new Error("Owner replaced");
        }
        owner.heartbeatAt = new Date().toISOString();
        publish(dataDir, owner);
      });
    } catch (error) {
      // Owner heartbeat failed; checking the existing ownership fallback.
      logger.warn("Owner heartbeat failed; checking the existing ownership fallback");

      if ((error as { code?: string }).code === "OWNER_BUSY") {
        return;
      }
      clearInterval(timer);
      onLost();
    }
  }, OWNER_HEARTBEAT_MS);
  timer.unref();
  return {
    release() {
      if (released) {
        return;
      }
      clearInterval(timer);
      guarded(dataDir, () => {
        if (readOwner(dataDir)?.id === owner.id) {
          rmSync(join(dataDir, "owner.lock"), { force: true });
        }
      });
      released = true;
    },
  };
}
