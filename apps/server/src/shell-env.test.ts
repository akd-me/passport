import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostAgentStatus } from "@passport/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./auth.test-client.js";
import { createRealBackend } from "./compose.js";
import { defaultConfig, loadConfig, validateConfig } from "./config.js";
import { type HostAgentDetector, setHostAgentDetector } from "./llm-selection.js";
import {
  applyHostAgentPaths,
  hostAgentPathSettings,
  pathState,
  prepareHostEnvironment,
  type ShellProbe,
  setShellProbe,
} from "./shell-env.js";

const probe = vi.fn<ShellProbe>(async () => ({
  source: "login-shell",
  shell: "zsh",
  PATH: "/opt/homebrew/bin:/usr/bin:/bin",
  HOMEBREW_PREFIX: "/opt/homebrew",
}));
let previousProbe: ShellProbe;
let detected: HostAgentStatus[] = [];
const detector = vi.fn<HostAgentDetector>(async () => detected);
let previousDetector: HostAgentDetector;
const savedEnv = { ...process.env };
const dirs: string[] = [];

beforeEach(() => {
  probe.mockClear();
  detector.mockClear();
  detected = [];
  previousProbe = setShellProbe(probe);
  previousDetector = setHostAgentDetector(detector);
});
afterEach(async () => {
  setShellProbe(previousProbe);
  setHostAgentDetector(previousDetector);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // Route handlers write the probe result into process.env; restore it exactly.
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
type View = {
  pathSource: { source: string; label: string; entries: number };
  paths: Record<"claude-code" | "codex", { configured: string | null; environment: string | null }>;
};
async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "passport-shell-env-"));
  dirs.push(dir);
  return dir;
}

describe("server shell environment", () => {
  it("probes only for serve/demo launched without a terminal or prepared environment", async () => {
    const info = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [command, env, isTTY] of [
      ["serve", { PATH: "/usr/bin" }, true],
      ["sync", { PATH: "/usr/bin" }, false],
      ["serve", { PATH: "/usr/bin", PASSPORT_SHELL_ENV_PREPARED: "1" }, false],
    ] as const) {
      await prepareHostEnvironment({}, command, { env: { ...env }, isTTY });
    }
    expect(probe).not.toHaveBeenCalled();
    expect(pathState({ PATH: "/a:/b", PASSPORT_SHELL_ENV_PREPARED: "1" })).toEqual({
      source: "desktop",
      label: "prepared by the app",
      entries: 2,
    });
    expect(
      pathState({
        PATH: "/a",
        PASSPORT_SHELL_ENV_PREPARED: "1",
        PASSPORT_SHELL_ENV_SOURCE: "launchctl",
      }).label,
    ).toBe("launchctl, prepared by the app");

    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    await prepareHostEnvironment({}, "serve", { env, isTTY: false });
    expect(probe).toHaveBeenCalledOnce();
    expect(env).toMatchObject({
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      HOMEBREW_PREFIX: "/opt/homebrew",
    });
    expect(pathState(env)).toEqual({
      source: "login-shell",
      label: "login shell (zsh)",
      entries: 3,
    });
    // One summary line: the source and a count, never the PATH itself.
    const lines = info.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual(["[passport] Host CLI PATH from login shell (zsh): 3 entries."]);
  });

  it("applies configured binary paths unless the environment already sets them", () => {
    const env: NodeJS.ProcessEnv = { PASSPORT_CODEX_PATH: "/env/codex" };
    const config = { hostAgents: { claudePath: "/cfg/claude", codexPath: "/cfg/codex" } };
    applyHostAgentPaths(config, env);
    expect(env).toEqual({ PASSPORT_CODEX_PATH: "/env/codex", PASSPORT_CLAUDE_PATH: "/cfg/claude" });
    expect(hostAgentPathSettings(config, env)).toEqual({
      "claude-code": { configured: "/cfg/claude", environment: null },
      codex: { configured: "/cfg/codex", environment: "/env/codex" },
    });
    applyHostAgentPaths({}, env);
    expect(env).toEqual({ PASSPORT_CODEX_PATH: "/env/codex" });
  });

  it("validates saved binary paths", () => {
    const config = defaultConfig("/tmp/passport-x");
    expect(() => validateConfig({ ...config, hostAgents: { claudePath: "claude" } })).toThrow(
      /absolute/,
    );
    expect(() => validateConfig({ ...config, hostAgents: [] as never })).toThrow(/object/);
    expect(validateConfig({ ...config, hostAgents: { codexPath: "/x/codex" } })).toBeTruthy();
  });
});

describe("host-agent settings routes", () => {
  it("persists binary overrides, re-detects, and switches auto selection to a ready agent", async () => {
    const dir = await dataDir();
    vi.stubEnv("PASSPORT_LLM_PROVIDER", "");
    vi.stubEnv("PASSPORT_CLAUDE_PATH", "");
    vi.stubEnv("PASSPORT_CODEX_PATH", "");
    const backend = await createRealBackend(defaultConfig(dir));
    try {
      const app = createApp(backend);
      const initial = (await (await app.request("/api/settings/host-agents")).json()) as View;
      expect(initial).toMatchObject({
        paths: {
          "claude-code": { configured: null, environment: null },
          codex: { configured: null, environment: null },
        },
        agents: [],
      });
      expect(initial.pathSource).toHaveProperty("entries");

      const invalid = await app.request("/api/settings/host-agents", {
        method: "PUT",
        body: JSON.stringify({ claudePath: "bin/claude" }),
      });
      expect(invalid.status).toBe(400);
      const unknown = await app.request("/api/settings/host-agents", {
        method: "PUT",
        body: JSON.stringify({ geminiPath: "/x" }),
      });
      expect(unknown.status).toBe(400);
      const claude = join(dir, "custom", "claude");
      await mkdir(join(dir, "custom"));
      await writeFile(claude, "#!/bin/sh\n", { mode: 0o755 });

      detected = [
        {
          kind: "claude-code",
          label: "Claude Code",
          installed: true,
          binaryPath: claude,
          version: "2.1.0",
          loggedIn: true,
          account: "claude.ai",
          ready: true,
          checkedAt: new Date().toISOString(),
        },
      ];
      const saved = await app.request("/api/settings/host-agents", {
        method: "PUT",
        body: JSON.stringify({ claudePath: ` ${claude} ` }),
      });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({
        paths: { "claude-code": { configured: claude, environment: null } },
        agents: detected,
      });
      expect(process.env.PASSPORT_CLAUDE_PATH).toBe(claude);
      expect(detector).toHaveBeenCalledWith({ refresh: true });
      expect(backend.config.llm.provider).toBe("claude-code");
      const file = JSON.parse(await readFile(join(dir, "passport.config.json"), "utf8"));
      expect(file.hostAgents).toEqual({ claudePath: claude });
      // The detected agent is runtime state; the file keeps the configured fallback.
      expect(file.llm.provider).toBe("anthropic");
      expect((await loadConfig({ PASSPORT_DATA_DIR: dir })).hostAgents).toEqual({
        claudePath: claude,
      });

      const redetected = await app.request("/api/settings/host-agents/redetect", {
        method: "POST",
      });
      expect(redetected.status).toBe(200);
      expect(probe).toHaveBeenCalledOnce();
      expect(((await redetected.json()) as View).pathSource).toEqual({
        source: "login-shell",
        label: "login shell (zsh)",
        entries: 3,
      });

      const cleared = await app.request("/api/settings/host-agents", {
        method: "PUT",
        body: JSON.stringify({ claudePath: null }),
      });
      expect(((await cleared.json()) as View).paths["claude-code"].configured).toBeNull();
      expect(process.env.PASSPORT_CLAUDE_PATH).toBeUndefined();
      const after = JSON.parse(await readFile(join(dir, "passport.config.json"), "utf8"));
      expect(after).not.toHaveProperty("hostAgents");
    } finally {
      await backend.close();
    }
  });

  it("R3-16: only an existing claude/codex file that only its owner can modify is accepted", async () => {
    const dir = await dataDir();
    const backend = await createRealBackend(defaultConfig(dir));
    try {
      const app = createApp(backend);
      const put = async (body: Record<string, string>) =>
        (
          await app.request("/api/settings/host-agents", {
            method: "PUT",
            body: JSON.stringify(body),
          })
        ).status;
      const shell = join(dir, "sh");
      await writeFile(shell, "#!/bin/sh\n", { mode: 0o755 });
      expect(await put({ claudePath: "/bin/sh" })).toBe(400); // any program but claude
      expect(await put({ claudePath: join(dir, "claude") })).toBe(400); // missing
      const writable = join(dir, "codex");
      await writeFile(writable, "#!/bin/sh\n");
      await chmod(writable, 0o777);
      expect(await put({ codexPath: writable })).toBe(400); // anyone could replace it
      await mkdir(join(dir, "claude-dir"));
      expect(await put({ claudePath: join(dir, "claude-dir") })).toBe(400); // not a file
      expect(backend.config.hostAgents).toBeUndefined();
    } finally {
      await backend.close();
    }
  });
});
