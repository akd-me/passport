// The store's credential key, protected by the macOS Keychain through safeStorage. The server
// receives it on a bootstrap pipe (see server.ts), so its AES-GCM design is unchanged. Never log it.
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { log } from "./paths";

export type MasterKeySource = "environment" | "keychain" | "imported" | "recovered" | "generated";

/** The slice of Electron's safeStorage this module uses (injected so tests need no Keychain). */
export interface Sealer {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(sealed: Buffer): string;
}

/** A refusal to start, with a message for the window and menu bar. */
export class MasterKeyError extends Error {}

/** Mirrors apps/server/src/master-key.ts: the marker the CLI reads, and the kv verifier. */
export const KEYCHAIN_MARKER = "master.key.keychain";
const VERIFIER_KEY = "master_key_verifier";
export const masterKeyVerifier = (key: string): string =>
  `v1:${createHmac("sha256", key).update("passport/master-key-verifier/v1").digest("hex")}`;

/** One sealed key per data directory, so a test or second workspace never borrows another's key. */
function sealedPath(userData: string, dataDir: string): string {
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
  return join(userData, "master-keys", `${id}.bin`);
}

function seal(sealer: Sealer, path: string, key: string): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temp, sealer.encryptString(key), { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}

/** The verifier the server recorded in passport.sqlite, or null (no database or no row yet). */
export function storedVerifier(dataDir: string): string | null {
  const path = join(dataDir, "passport.sqlite");
  if (!existsSync(path)) {
    return null;
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(VERIFIER_KEY) as
      | { value?: unknown }
      | undefined;
    return typeof row?.value === "string" ? row.value : null;
  } catch (error) {
    // An older or busy database: the server still checks the key when it opens the store.
    log("warn", `Could not read the workspace's key check (${(error as Error).name})`);
    return null;
  } finally {
    db?.close();
  }
}

function readKeyFile(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8").trim() || null : null;
}

/**
 * The key for the server, or null to let it keep its own master.key behaviour (no Keychain).
 * Order: PASSPORT_MASTER_KEY; the sealed key; a one-time import of <dataDir>/master.key (left
 * in place); a fresh key for a brand-new workspace. Whatever is chosen must match the verifier
 * the server stored, so the app never starts a server that would write unreadable credentials.
 */
export function desktopMasterKey(
  dataDir: string,
  sealer: Sealer,
  userData: string,
  env: NodeJS.ProcessEnv = process.env,
): { key: string; source: MasterKeySource } | null {
  if (env.PASSPORT_MASTER_KEY) {
    return { key: env.PASSPORT_MASTER_KEY, source: "environment" };
  }
  const sealed = sealedPath(userData, dataDir);
  const file = join(dataDir, "master.key");
  const verifier = storedVerifier(dataDir);
  const matches = (key: string) => !verifier || masterKeyVerifier(key) === verifier;
  const fileKey = () => {
    const key = readKeyFile(file);
    return key && matches(key) ? key : null;
  };
  if (existsSync(sealed)) {
    if (!sealer.isEncryptionAvailable()) {
      throw new MasterKeyError(
        "This workspace's encryption key is in the Keychain, but macOS reports Keychain encryption as unavailable. Unlock your login keychain, then choose Restart Server.",
      );
    }
    let key: string | null = null;
    try {
      key = sealer.decryptString(readFileSync(sealed));
    } catch (error) {
      // A reset Keychain item or a re-signed app: master.key, if still present, recovers it.
      log("warn", `Could not unseal the Keychain key (${(error as Error).name})`);
    }
    if (key && matches(key)) {
      const other = readKeyFile(file);
      if (other && other !== key) {
        log("warn", "master.key differs from the Keychain key; using the one matching the store");
      }
      return { key, source: "keychain" };
    }
    const recovered = fileKey();
    if (recovered) {
      seal(sealer, sealed, recovered);
      log("info", "Recovered the Keychain key from master.key and sealed it again");
      return { key: recovered, source: "recovered" };
    }
    throw new MasterKeyError(
      key
        ? "The key in the Keychain does not match this workspace's credentials, and no matching master.key was found. Restore master.key from a backup, then choose Restart Server."
        : "macOS did not release Passport's encryption key from the Keychain. Allow access when asked, then choose Restart Server.",
    );
  }
  if (!sealer.isEncryptionAvailable()) {
    log("warn", "Keychain encryption is unavailable; the server keeps using master.key");
    return null;
  }
  const existing = readKeyFile(file);
  if (existing) {
    if (!matches(existing)) {
      throw new MasterKeyError(
        "master.key does not match this workspace's stored credentials. Restore the original master.key, then choose Restart Server.",
      );
    }
    seal(sealer, sealed, existing);
    log("info", "Imported master.key into the Keychain; the file was left in place");
    return { key: existing, source: "imported" };
  }
  if (existsSync(join(dataDir, "passport.sqlite"))) {
    // A store without master.key was opened with an environment key the app cannot see.
    throw new MasterKeyError(
      "This workspace has a database but no master.key, and its key is not in the Keychain. Restore master.key, or start Passport with PASSPORT_MASTER_KEY set to the workspace's key.",
    );
  }
  const key = randomBytes(32).toString("base64url");
  seal(sealer, sealed, key);
  // Tells the CLI the key lives in the Keychain, so it refuses rather than minting another.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dataDir, KEYCHAIN_MARKER),
    "Passport.app keeps this workspace's master key in the macOS Keychain.\n",
    { mode: 0o600 },
  );
  log("info", "Generated a Keychain-protected master key for a new workspace");
  return { key, source: "generated" };
}
