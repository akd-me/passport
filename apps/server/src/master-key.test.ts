import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRealBackend } from "./compose.js";
import { defaultConfig } from "./config.js";
import {
  KEYCHAIN_MARKER,
  masterKeyVerifier,
  readBootstrap,
  resolveMasterKey,
  VERIFIER_KEY,
} from "./master-key.js";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

/** `passport <args>` as a separate process, the way a terminal runs it. */
function passport(dataDir: string, args: string[], key?: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("PASSPORT_")),
  );
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    env: {
      ...env,
      PASSPORT_DATA_DIR: dataDir,
      PASSPORT_SHELL_ENV_PREPARED: "1",
      PASSPORT_PORT: "1", // nothing listens: offline commands open the store themselves
      ...(key ? { PASSPORT_MASTER_KEY: key } : {}),
    },
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("master key policy", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "passport-key-"));
    vi.stubEnv("PASSPORT_MASTER_KEY", "");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dataDir, { recursive: true, force: true });
  });
  async function workspace(key: string) {
    vi.stubEnv("PASSPORT_MASTER_KEY", key);
    const backend = await createRealBackend({ ...defaultConfig(), dataDir }, { clientMode: true });
    await backend.store.accounts.upsert({
      id: "acct",
      kind: "mock",
      emailAddress: "a@example.com",
      displayName: "A",
      capabilities: { mail: true, calendar: false },
      settings: {},
    } as never);
    await backend.store.accounts.setCredentials("acct", { access_token: "secret" });
    await backend.close();
    vi.stubEnv("PASSPORT_MASTER_KEY", "");
  }

  it("R3-2: a CLI command never mints master.key for a workspace whose key it does not have", async () => {
    await workspace("K1");
    // The review's reproduction: before, this wrote a fresh 44-byte master.key (K2).
    const listed = passport(dataDir, ["accounts", "list"]);
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toContain("a@example.com");
    expect(existsSync(join(dataDir, "master.key"))).toBe(false);
    // Commands that need credentials refuse, with a message that says why.
    const synced = passport(dataDir, ["sync"]);
    expect(synced.status).toBe(1);
    expect(synced.stderr).toContain("master.key does not");
    expect(existsSync(join(dataDir, "master.key"))).toBe(false);
  }, 60_000);

  it("R3-2: an app (Keychain) workspace points the user at Passport.app", async () => {
    await writeFile(join(dataDir, KEYCHAIN_MARKER), "Passport.app\n");
    await expect(resolveMasterKey(dataDir)).rejects.toMatchObject({
      code: "MASTER_KEY_UNAVAILABLE",
      message: expect.stringContaining("macOS Keychain"),
    });
    const locked = await resolveMasterKey(dataDir, { readOnly: true });
    expect(locked.locked).toBe(true);
    expect(existsSync(join(dataDir, "master.key"))).toBe(false);
    // A brand-new CLI workspace still gets its own key.
    const fresh = await mkdtemp(join(tmpdir(), "passport-key-new-"));
    try {
      expect((await resolveMasterKey(fresh)).locked).toBe(false);
      expect(existsSync(join(fresh, "master.key"))).toBe(true);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it("R3-2: a locked read-only store refuses to write credentials", async () => {
    await workspace("K1");
    const backend = await createRealBackend(
      { ...defaultConfig(), dataDir },
      { clientMode: true, readOnly: true },
    );
    try {
      expect(await backend.store.accounts.list()).toHaveLength(1);
      await expect(
        backend.store.accounts.setCredentials("acct", { access_token: "k2" }),
      ).rejects.toMatchObject({ code: "MASTER_KEY_UNAVAILABLE" });
    } finally {
      await backend.close();
    }
  });

  it("R3-2: a wrong key fails with MASTER_KEY_MISMATCH instead of running", async () => {
    await workspace("K1");
    vi.stubEnv("PASSPORT_MASTER_KEY", "K2");
    await expect(
      createRealBackend({ ...defaultConfig(), dataDir }, { clientMode: true }),
    ).rejects.toMatchObject({ code: "MASTER_KEY_MISMATCH" });
    vi.stubEnv("PASSPORT_MASTER_KEY", "K1");
    const backend = await createRealBackend({ ...defaultConfig(), dataDir }, { clientMode: true });
    try {
      expect(await backend.store.kv.get(VERIFIER_KEY)).toBe(masterKeyVerifier("K1"));
      expect(await backend.store.kv.get(VERIFIER_KEY)).not.toContain("K1");
    } finally {
      await backend.close();
    }
  });

  it("R3-2: a pre-verifier workspace is checked against its stored credentials", async () => {
    await workspace("K1");
    vi.stubEnv("PASSPORT_MASTER_KEY", "K1");
    const backend = await createRealBackend({ ...defaultConfig(), dataDir }, { clientMode: true });
    await backend.store.kv.delete(VERIFIER_KEY);
    await backend.close();
    vi.stubEnv("PASSPORT_MASTER_KEY", "K2");
    await expect(
      createRealBackend({ ...defaultConfig(), dataDir }, { clientMode: true }),
    ).rejects.toMatchObject({ code: "MASTER_KEY_MISMATCH" });
  });

  it("R3-4: the app's key arrives on an inherited descriptor and never in the environment", async () => {
    const path = join(dataDir, "bootstrap.json");
    writeFileSync(path, JSON.stringify({ masterKey: "from-the-keychain" }));
    const fd = openSync(path, "r");
    const env: NodeJS.ProcessEnv = { PASSPORT_BOOTSTRAP_FD: String(fd) };
    readBootstrap(env);
    expect(env.PASSPORT_BOOTSTRAP_FD).toBeUndefined();
    expect(() => closeSync(fd)).toThrow(); // consumed and closed
    expect(await resolveMasterKey(dataDir)).toEqual({ key: "from-the-keychain", locked: false });
    expect(existsSync(join(dataDir, "master.key"))).toBe(false);
    expect(() => readBootstrap({ PASSPORT_BOOTSTRAP_FD: "1" })).toThrow(/inherited pipe/);
  });
});
