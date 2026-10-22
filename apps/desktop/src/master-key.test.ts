import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { masterKeyVerifier as serverVerifier } from "../../server/src/master-key";

const userData = mkdtempSync(join(tmpdir(), "passport-desktop-keys-"));
vi.mock("electron", () => ({ app: { getPath: () => userData, isPackaged: false } }));
const { desktopMasterKey, KEYCHAIN_MARKER, MasterKeyError, masterKeyVerifier } = await import(
  "./master-key"
);

/** A stand-in for safeStorage: reversible, and able to fail like a reset Keychain item. */
function sealer(options: { available?: boolean; broken?: boolean } = {}) {
  return {
    isEncryptionAvailable: () => options.available ?? true,
    encryptString: (plain: string) => Buffer.from(`sealed:${plain}`),
    decryptString: (sealed: Buffer) => {
      if (options.broken) {
        throw new Error("Error while decrypting the ciphertext provided to safeStorage");
      }
      return sealed.toString().replace(/^sealed:/, "");
    },
  };
}

describe("desktopMasterKey", () => {
  let dataDir: string;
  let keys: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "passport-desktop-ws-"));
    keys = mkdtempSync(join(tmpdir(), "passport-desktop-ud-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(keys, { recursive: true, force: true });
  });
  /** A store the server opened with `key`: its kv verifier row. */
  const store = (key: string) => {
    const db = new DatabaseSync(join(dataDir, "passport.sqlite"));
    db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO kv VALUES (?, ?)").run("master_key_verifier", masterKeyVerifier(key));
    db.close();
  };
  const env = {};

  it("R3-2: computes the same verifier as the server", () => {
    expect(masterKeyVerifier("some key")).toBe(serverVerifier("some key"));
  });

  it("R3-2: a new workspace's key is sealed and marked for the CLI; no master.key is written", () => {
    const first = desktopMasterKey(dataDir, sealer(), keys, env);
    expect(first?.source).toBe("generated");
    expect(existsSync(join(dataDir, KEYCHAIN_MARKER))).toBe(true);
    expect(existsSync(join(dataDir, "master.key"))).toBe(false);
    expect(desktopMasterKey(dataDir, sealer(), keys, env)).toEqual({
      key: first?.key,
      source: "keychain",
    });
  });

  it("R3-2: prefers the key the store was written with when master.key and the Keychain disagree", () => {
    desktopMasterKey(dataDir, sealer(), keys, env); // seals K1
    store("K2");
    writeFileSync(join(dataDir, "master.key"), "K2\n");
    expect(desktopMasterKey(dataDir, sealer(), keys, env)).toEqual({
      key: "K2",
      source: "recovered",
    });
    expect(desktopMasterKey(dataDir, sealer(), keys, env)?.source).toBe("keychain");
    rmSync(join(dataDir, "master.key"));
    writeFileSync(join(dataDir, "master.key"), "K3\n");
    rmSync(join(dataDir, "passport.sqlite"));
    store("K4");
    expect(() => desktopMasterKey(dataDir, sealer(), keys, env)).toThrow(MasterKeyError);
  });

  it("R3-2: refuses to import a master.key that does not open the store", () => {
    store("K1");
    writeFileSync(join(dataDir, "master.key"), "K2\n");
    expect(() => desktopMasterKey(dataDir, sealer(), keys, env)).toThrow(/does not match/);
    writeFileSync(join(dataDir, "master.key"), "K1\n");
    expect(desktopMasterKey(dataDir, sealer(), keys, env)).toEqual({
      key: "K1",
      source: "imported",
    });
  });

  it("R3-13: a Keychain that will not unseal falls back to a matching master.key and reseals", () => {
    writeFileSync(join(dataDir, "master.key"), "K1\n");
    store("K1");
    expect(desktopMasterKey(dataDir, sealer(), keys, env)?.source).toBe("imported");
    expect(desktopMasterKey(dataDir, sealer({ broken: true }), keys, env)).toEqual({
      key: "K1",
      source: "recovered",
    });
    rmSync(join(dataDir, "master.key"));
    expect(() => desktopMasterKey(dataDir, sealer({ broken: true }), keys, env)).toThrow(
      /did not release/,
    );
  });

  it("R3-13: a sealed key with Keychain encryption unavailable refuses to start", () => {
    desktopMasterKey(dataDir, sealer(), keys, env);
    expect(() => desktopMasterKey(dataDir, sealer({ available: false }), keys, env)).toThrow(
      MasterKeyError,
    );
  });

  it("R3-13: filesystem errors keep their errno instead of reading as Keychain failures", () => {
    mkdirSync(join(dataDir, "master.key"));
    let error: unknown;
    try {
      desktopMasterKey(dataDir, sealer(), keys, env);
    } catch (caught) {
      error = caught;
    }
    expect(error).not.toBeInstanceOf(MasterKeyError);
    expect(error).toMatchObject({ code: "EISDIR" });
  });

  it("R3-2: an existing store with neither master.key nor a sealed key is never given a new key", () => {
    store("K1");
    expect(() => desktopMasterKey(dataDir, sealer(), keys, env)).toThrow(/no master.key/);
    expect(existsSync(join(dataDir, KEYCHAIN_MARKER))).toBe(false);
  });
});
