// The store's credential key, protected by the macOS Keychain through safeStorage. The server
// already accepts it as PASSPORT_MASTER_KEY, so its AES-GCM design is unchanged. Never log it.
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import { log } from "./paths";

export type MasterKeySource = "keychain" | "imported" | "generated";

/** One sealed key per data directory, so a test or second workspace never borrows another's key. */
function sealedPath(dataDir: string): string {
  let canonical = dataDir;
  try {
    canonical = realpathSync(dataDir);
  } catch (error) {
    // A data directory that does not exist yet is identified by its resolved path.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const id = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
  return join(app.getPath("userData"), "master-keys", `${id}.bin`);
}

function seal(path: string, key: string): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temp, safeStorage.encryptString(key), { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}

/**
 * Returns the key for the child's PASSPORT_MASTER_KEY, or null to let the server keep its
 * master.key file behaviour. Order: an existing sealed key; a one-time import of
 * <dataDir>/master.key (left in place); a fresh 32-byte key for a brand-new workspace.
 */
export function desktopMasterKey(dataDir: string): { key: string; source: MasterKeySource } | null {
  if (process.env.PASSPORT_MASTER_KEY) {
    return null;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    log("warn", "Keychain encryption is unavailable; the server keeps using master.key");
    return null;
  }
  const sealed = sealedPath(dataDir);
  if (existsSync(sealed)) {
    return { key: safeStorage.decryptString(readFileSync(sealed)), source: "keychain" };
  }
  const file = join(dataDir, "master.key");
  if (existsSync(file)) {
    const key = readFileSync(file, "utf8").trim();
    if (!key) {
      return null;
    }
    seal(sealed, key);
    log("info", "Imported master.key into the Keychain; the file was left in place");
    return { key, source: "imported" };
  }
  if (existsSync(join(dataDir, "passport.sqlite"))) {
    // A store without master.key was opened with an environment key the app cannot see.
    // Generating one would make its credentials unreadable, so leave the server's behaviour.
    log("warn", "Existing workspace has no master.key; not generating a Keychain key");
    return null;
  }
  const key = randomBytes(32).toString("base64url");
  seal(sealed, key);
  log("info", "Generated a Keychain-protected master key for a new workspace");
  return { key, source: "generated" };
}
