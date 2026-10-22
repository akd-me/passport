import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHostAgentBinary } from "./detect.js";
import { extraBinDirs, hostAgentEnv, isForwardedEnv } from "./env.js";
import {
  applyShellEnvironment,
  captureCommand,
  loginShellCandidates,
  mergePathValues,
  probeShellEnvironment,
} from "./shell-env.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "passport-shell-env-"));
  dirs.push(dir);
  return dir;
}

/** A fake login shell named `name`: prints rc chatter, sets variables, then runs `-ilc <cmd>`. */
async function fakeShell(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}
const runCommand = 'eval "$2"';

describe("probeShellEnvironment", () => {
  it("reads PATH and allowlisted variables between markers, ignoring rc chatter", async () => {
    const dir = await temp();
    const zsh = await fakeShell(
      dir,
      "zsh",
      [
        'echo "Welcome back! PATH=/not/this"',
        'test "$1" = "-ilc" || exit 9',
        "export PATH=/opt/homebrew/bin:/Users/u/.volta/bin:/usr/bin",
        "export HOMEBREW_PREFIX=/opt/homebrew __MISE_DIFF=abc LANG=en_GB.UTF-8",
        'test -z "$PASSPORT_MASTER_KEY" || exit 7',
        runCommand,
        'echo "goodbye"',
      ].join("\n"),
    );
    const result = await probeShellEnvironment({
      shells: [zsh],
      env: { PATH: "/usr/bin:/bin", PASSPORT_MASTER_KEY: "secret" },
      platform: "darwin",
    });
    expect(result).toMatchObject({
      source: "login-shell",
      shell: "zsh",
      PATH: "/opt/homebrew/bin:/Users/u/.volta/bin:/usr/bin:/bin",
      HOMEBREW_PREFIX: "/opt/homebrew",
      __MISE_DIFF: "abc",
      LANG: "en_GB.UTF-8",
    });
    expect(result).not.toHaveProperty("SSL_CERT_FILE");
  });

  it("skips non-POSIX shells and failing shells, then uses the next candidate", async () => {
    const dir = await temp();
    const nu = await fakeShell(dir, "nu", "echo should-not-run > ran; exit 1");
    const broken = await fakeShell(dir, "bash", "exit 3");
    const fishDir = join(dir, "fish-home");
    await mkdir(fishDir);
    const fish = await fakeShell(fishDir, "fish", `export PATH=/fish/bin:/usr/bin\n${runCommand}`);
    const logs: string[] = [];
    const result = await probeShellEnvironment({
      shells: [nu, broken, fish],
      env: { PATH: "/usr/bin" },
      platform: "linux",
      log: (message) => logs.push(message),
    });
    expect(result).toMatchObject({
      source: "login-shell",
      shell: "fish",
      PATH: "/fish/bin:/usr/bin",
    });
    expect(logs).toEqual([
      "Skipping unsupported login shell nu",
      "Login shell bash did not report PATH",
    ]);
  });

  it("terminates a hanging shell group within the timeout and grace period", async () => {
    const dir = await temp();
    // A background helper keeps stdout open after the shell itself is killed.
    const zsh = await fakeShell(dir, "zsh", "sleep 30 &\nsleep 30");
    const started = Date.now();
    const result = await probeShellEnvironment({
      shells: [zsh],
      timeoutMs: 200,
      env: { PATH: "/usr/bin" },
      platform: "linux",
    });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result).toEqual({ source: "fallback", shell: null, PATH: "/usr/bin" });
  });

  it("falls back to launchctl on macOS, then to the inherited PATH", async () => {
    const dir = await temp();
    const broken = await fakeShell(dir, "zsh", "exit 1");
    const launchctl = await fakeShell(
      dir,
      "launchctl",
      'test "$1 $2" = "getenv PATH" && echo /opt/homebrew/bin:/usr/bin',
    );
    expect(
      await probeShellEnvironment({
        shells: [broken],
        env: { PATH: "/usr/bin:/bin" },
        platform: "darwin",
        launchctlPath: launchctl,
      }),
    ).toEqual({ source: "launchctl", shell: null, PATH: "/opt/homebrew/bin:/usr/bin:/bin" });
    const empty = await fakeShell(dir, "empty-launchctl", "exit 0");
    expect(
      await probeShellEnvironment({
        shells: [broken],
        env: { PATH: "/usr/bin:/bin" },
        platform: "darwin",
        launchctlPath: empty,
      }),
    ).toEqual({ source: "fallback", shell: null, PATH: "/usr/bin:/bin" });
  });

  it("never interpolates unvalidated names", () => {
    expect(() => captureCommand(["PATH; rm -rf /"], "N")).toThrow(/Unsupported/);
    expect(captureCommand(["PATH"], "N")).toBe(
      "printf '%s\\n' '__PASSPORT_ENV_N_PATH_START__'; printenv PATH || true; printf '%s\\n' '__PASSPORT_ENV_N_PATH_END__'",
    );
  });

  it("lists $SHELL first and de-duplicates PATH entries", () => {
    const shells = loginShellCandidates({ SHELL: "/usr/local/bin/fish" }, "darwin");
    expect(shells[0]).toBe("/usr/local/bin/fish");
    expect(shells).toContain("/bin/zsh");
    expect(loginShellCandidates({ SHELL: "fish" }, "darwin")).not.toContain("fish");
    expect(mergePathValues(["/a:/b:", " /b:/c"], ":")).toBe("/a:/b:/c");
  });
});

describe("applyShellEnvironment", () => {
  it("writes the probed variables and adds a UTF-8 locale on macOS when none is set", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    applyShellEnvironment(
      { source: "login-shell", shell: "zsh", PATH: "/opt/homebrew/bin:/usr/bin", __MISE_DIFF: "d" },
      env,
      "darwin",
    );
    expect(env).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      __MISE_DIFF: "d",
      LC_CTYPE: "en_US.UTF-8",
    });
    const withLocale: NodeJS.ProcessEnv = { LANG: "fr_FR.UTF-8" };
    applyShellEnvironment(
      { source: "fallback", shell: null, PATH: "/usr/bin" },
      withLocale,
      "darwin",
    );
    expect(withLocale.LC_CTYPE).toBeUndefined();
    const linux: NodeJS.ProcessEnv = {};
    applyShellEnvironment({ source: "fallback", shell: null, PATH: "/usr/bin" }, linux, "linux");
    expect(linux.LC_CTYPE).toBeUndefined();
  });
});

describe("host CLI discovery fallbacks", () => {
  it("searches version-manager global bins and fnm's default alias when present", async () => {
    const home = await temp();
    await mkdir(join(home, ".fnm", "aliases", "default", "bin"), { recursive: true });
    const dirs = extraBinDirs({ HOME: home });
    expect(dirs).toEqual([
      join(home, ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      join(home, ".volta", "bin"),
      join(home, ".bun", "bin"),
      join(home, "Library", "pnpm"),
      join(home, ".npm-global", "bin"),
      join(home, ".local", "share", "mise", "shims"),
      join(home, ".asdf", "shims"),
      join(home, ".fnm", "aliases", "default", "bin"),
    ]);
    expect(extraBinDirs({ HOME: home, VOLTA_HOME: "/v" })).toContain("/v/bin");
    expect(extraBinDirs({ HOME: "/nonexistent-home" }).some((dir) => dir.includes("fnm"))).toBe(
      false,
    );
  });

  it("forwards version-manager state but still withholds Passport settings and API keys", () => {
    const env = hostAgentEnv({
      HOME: "/home/u",
      PATH: "/usr/bin",
      __MISE_DIFF: "d",
      HOMEBREW_PREFIX: "/opt/homebrew",
      HOMEBREW_CELLAR: "/opt/homebrew/Cellar",
      HOMEBREW_REPOSITORY: "/opt/homebrew",
      VOLTA_HOME: "/home/u/.volta",
      FNM_DIR: "/home/u/.fnm",
      FNM_MULTISHELL_PATH: "/tmp/fnm_multishells/1",
      NVM_DIR: "/home/u/.nvm",
      PASSPORT_MASTER_KEY: "k",
      PASSPORT_CLAUDE_PATH: "/x/claude",
      PASSPORT_SHELL_ENV_PREPARED: "1",
      ANTHROPIC_API_KEY: "k",
      OPENAI_API_KEY: "k",
      PASSPORT_LLM_API_KEY: "k",
    });
    expect(env).toMatchObject({
      __MISE_DIFF: "d",
      HOMEBREW_PREFIX: "/opt/homebrew",
      HOMEBREW_CELLAR: "/opt/homebrew/Cellar",
      HOMEBREW_REPOSITORY: "/opt/homebrew",
      VOLTA_HOME: "/home/u/.volta",
      FNM_DIR: "/home/u/.fnm",
      FNM_MULTISHELL_PATH: "/tmp/fnm_multishells/1",
      NVM_DIR: "/home/u/.nvm",
    });
    expect(
      Object.keys(env).filter((key) => key.startsWith("PASSPORT_") || key.endsWith("_API_KEY")),
    ).toEqual([]);
    expect(env.PATH!.split(":")).toContain("/home/u/.volta/bin");
    expect(isForwardedEnv("PASSPORT_CODEX_PATH")).toBe(false);
    expect(isForwardedEnv("OPENAI_API_KEY")).toBe(false);
  });
});

describe("probeShellEnvironment on this machine", () => {
  it.skipIf(process.platform === "win32")("returns a PATH from some source", async () => {
    const result = await probeShellEnvironment();
    expect(["login-shell", "launchctl", "fallback"]).toContain(result.source);
    expect(result.PATH.length).toBeGreaterThan(0);
  });
});

describe("R3-15: relative PATH entries and Electron's environment", () => {
  it("R3-15: drops relative PATH entries everywhere a binary could be resolved", async () => {
    expect(mergePathValues([".:/a:bin", "/b:./tools"], ":")).toBe("/a:/b");
    expect(hostAgentEnv({ PATH: ".:bin:/usr/bin" }).PATH?.split(":")).not.toContain(".");
    expect(hostAgentEnv({ PATH: ".:bin:/usr/bin" }).PATH?.split(":")).not.toContain("bin");
    const dir = await temp();
    await mkdir(join(dir, "bin"));
    await writeFile(join(dir, "bin", "claude"), "#!/bin/sh\nexit 0\n");
    await chmod(join(dir, "bin", "claude"), 0o755);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(resolveHostAgentBinary("claude-code", { PATH: "bin", HOME: dir })).toBeNull();
    } finally {
      process.chdir(cwd);
    }
  });

  it("R3-15: the login-shell probe does not inherit ELECTRON_RUN_AS_NODE", async () => {
    const dir = await temp();
    const zsh = await fakeShell(
      dir,
      "zsh",
      ['test -z "$ELECTRON_RUN_AS_NODE" || exit 7', "export PATH=/usr/bin", runCommand].join("\n"),
    );
    const result = await probeShellEnvironment({
      shells: [zsh],
      env: { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" },
      platform: "darwin",
    });
    expect(result.source).toBe("login-shell");
  });
});
