import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { app } from "electron";

const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

/** The same workspace the CLI uses: PASSPORT_DATA_DIR, else ~/.passport. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.PASSPORT_DATA_DIR || join(homedir(), ".passport"));
}

/** ~/Library/Logs/Passport on macOS. */
export function logDir(): string {
  const dir = app.getPath("logs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Keep one previous generation so a crash loop cannot fill the disk. */
export function rotatedLog(name: string): string {
  const path = join(logDir(), name);
  try {
    if (statSync(path).size > LOG_ROTATE_BYTES) {
      renameSync(path, `${path}.1`);
    }
  } catch (error) {
    // A missing log has nothing to rotate; other filesystem errors propagate.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return path;
}

/**
 * The server CLI entry. Packaged: the npm artifact staged outside app.asar in
 * Resources/server. Development: the workspace's own bin, which uses apps/server/dist.
 */
export function serverEntry(): string {
  if (process.env.PASSPORT_DESKTOP_SERVER_ENTRY) {
    return resolve(process.env.PASSPORT_DESKTOP_SERVER_ENTRY);
  }
  if (app.isPackaged) {
    return join(process.resourcesPath, "server", "bin", "passport.js");
  }
  return resolve(__dirname, "..", "..", "server", "bin", "passport.js");
}

let desktopLog: string | undefined;

/** Main-process diagnostics. Callers never pass tokens, keys, URLs with tokens or mail content. */
export function log(level: "info" | "warn" | "error", message: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
  console[level === "info" ? "log" : level](line);
  try {
    desktopLog ??= rotatedLog("desktop.log");
    appendFileSync(desktopLog, `${line}\n`, { mode: 0o600 });
  } catch {
    // The console copy above remains; a read-only log directory must not stop the app.
  }
}
