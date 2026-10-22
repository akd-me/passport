// The store's credential key: where it comes from, when a new one may be created, and a check
// that the key in use is the one this workspace's credentials were written with.
import { createHmac, randomBytes } from "node:crypto";
import { closeSync, existsSync, readFileSync } from "node:fs";
import { chmod, link, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "@passport/types";
import { ApiError } from "./errors.js";

/** Written by Passport.app when it keeps this workspace's key in the macOS Keychain. */
export const KEYCHAIN_MARKER = "master.key.keychain";
/** kv row holding an HMAC of a constant under the master key (never the key itself). */
export const VERIFIER_KEY = "master_key_verifier";

const KEYCHAIN_MESSAGE =
  "This workspace's encryption key is kept in the macOS Keychain by Passport.app, so this command cannot open its credentials. Open Passport.app: while it runs, `passport decisions`, `trust`, `sync` and `triage` use its server, and `passport mcp install --http` connects MCP clients to it.";
const MISSING_MESSAGE =
  "passport.sqlite exists but master.key does not, and a new key would make the stored credentials unreadable. Restore master.key from a backup, or set PASSPORT_MASTER_KEY to this workspace's key.";
const MISMATCH_MESSAGE =
  "This master key does not match the one this workspace's credentials were encrypted with. Use the original master.key or PASSPORT_MASTER_KEY (for an app workspace, start Passport.app).";

let bootstrapKey: string | undefined;
let environmentKey: string | undefined;

/**
 * Passport.app passes the key on an inherited pipe named by PASSPORT_BOOTSTRAP_FD (T3 Code's
 * fd-3 bootstrap), so it never appears in argv or in the environment `ps eww` shows.
 */
export function readBootstrap(env: NodeJS.ProcessEnv = process.env): void {
  const name = env.PASSPORT_BOOTSTRAP_FD;
  if (!name) {
    return;
  }
  delete env.PASSPORT_BOOTSTRAP_FD;
  const fd = Number(name);
  if (!Number.isInteger(fd) || fd < 3) {
    throw new ApiError("INVALID_BOOTSTRAP", "PASSPORT_BOOTSTRAP_FD must name an inherited pipe");
  }
  let input: { masterKey?: unknown };
  try {
    input = JSON.parse(readFileSync(fd, "utf8")) as { masterKey?: unknown };
  } catch {
    // Never echo the payload: it carries the key.
    throw new ApiError("INVALID_BOOTSTRAP", "Could not read the startup data from Passport.app");
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Already closed: nothing to release.
    }
  }
  if (typeof input.masterKey === "string" && input.masterKey.trim()) {
    bootstrapKey = input.masterKey;
  }
}

/** Moves PASSPORT_MASTER_KEY out of process.env so no child process inherits it. */
export function takeEnvironmentKey(env: NodeJS.ProcessEnv = process.env): void {
  if (env.PASSPORT_MASTER_KEY) {
    environmentKey = env.PASSPORT_MASTER_KEY;
    delete env.PASSPORT_MASTER_KEY;
  }
}

/** True when the key came from Passport.app or the environment rather than master.key. */
export const suppliedMasterKey = (): boolean =>
  !!(bootstrapKey || environmentKey || process.env.PASSPORT_MASTER_KEY);

export interface MasterKey {
  key: string;
  /** No key is available: a throwaway key opens the store, and credentials stay sealed. */
  locked: boolean;
}

/**
 * The key for `<dataDir>/passport.sqlite`. A new master.key is created only for a brand-new
 * workspace: never beside an existing database or an app (Keychain) workspace, where it would
 * strand credentials. `readOnly` commands then run locked instead of failing.
 */
export async function resolveMasterKey(
  dataDir: string,
  options: { readOnly?: boolean } = {},
): Promise<MasterKey> {
  const supplied = bootstrapKey ?? environmentKey ?? process.env.PASSPORT_MASTER_KEY;
  if (supplied) {
    return { key: supplied, locked: false };
  }
  const path = join(dataDir, "master.key");
  try {
    await readFile(path);
  } catch (error) {
    // An absent master key is initialized atomically; other filesystem errors propagate.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const keychain = existsSync(join(dataDir, KEYCHAIN_MARKER));
    if (keychain || existsSync(join(dataDir, "passport.sqlite"))) {
      if (options.readOnly) {
        return { key: randomBytes(32).toString("base64url"), locked: true };
      }
      throw new ApiError("MASTER_KEY_UNAVAILABLE", keychain ? KEYCHAIN_MESSAGE : MISSING_MESSAGE);
    }
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${randomBytes(32).toString("base64url")}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      try {
        await link(temp, path);
      } catch (error) {
        // Another process installed the key first; keep its existing key.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
    } finally {
      await rm(temp, { force: true });
    }
  }
  await chmod(path, 0o600);
  const key = (await readFile(path, "utf8")).trim();
  if (!key) {
    throw new ApiError("INVALID_MASTER_KEY", "Master key file is empty");
  }
  return { key, locked: false };
}

export const masterKeyVerifier = (key: string): string =>
  `v1:${createHmac("sha256", key).update("passport/master-key-verifier/v1").digest("hex")}`;

/**
 * Fails with MASTER_KEY_MISMATCH instead of silently writing credentials no other process can
 * read. Records the verifier on first use (after checking any existing credentials decrypt).
 * A locked store refuses to write credentials at all.
 */
export async function checkMasterKey(store: Store, master: MasterKey): Promise<void> {
  if (master.locked) {
    store.accounts.setCredentials = async () => {
      throw new ApiError("MASTER_KEY_UNAVAILABLE", KEYCHAIN_MESSAGE);
    };
    return;
  }
  const expected = masterKeyVerifier(master.key);
  const saved = await store.kv.get(VERIFIER_KEY);
  if (saved === expected) {
    return;
  }
  if (saved !== null) {
    throw new ApiError("MASTER_KEY_MISMATCH", MISMATCH_MESSAGE);
  }
  // A workspace from before verifiers: the key is wrong only if no stored credential opens.
  let opened = 0;
  let sealed = 0;
  for (const account of await store.accounts.list()) {
    try {
      opened += (await store.accounts.getCredentials(account.id)) ? 1 : 0;
    } catch (error) {
      // Only a failed decryption counts; any other store failure propagates as is.
      if ((error as { code?: string }).code !== "CREDENTIAL_DECRYPTION_FAILED") {
        throw error;
      }
      sealed += 1;
    }
  }
  if (sealed && !opened) {
    throw new ApiError("MASTER_KEY_MISMATCH", MISMATCH_MESSAGE);
  }
  await store.kv.set(VERIFIER_KEY, expected);
}
