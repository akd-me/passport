import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializePassport } from "./init.js";

describe("passport init", () => {
  const paths: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(paths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
  });
  it("creates a private master key and config with no model or account", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "passport-init-"));
    paths.push(dataDir);
    vi.stubEnv("PASSPORT_DATA_DIR", dataDir);
    const replies = ["none", "skip"],
      close = vi.fn(),
      log = vi.fn();
    await initializePassport({ ask: async () => replies.shift()!, log, close });
    const config = JSON.parse(await readFile(join(dataDir, "passport.config.json"), "utf8"));
    expect(config.accounts).toEqual([]);
    expect(config.llm.apiKey).toBeUndefined();
    expect(config.sync).toBeUndefined();
    expect(config.watch.intervalSeconds).toBe(30);
    expect((await stat(join(dataDir, "master.key"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dataDir, "passport.config.json"))).mode & 0o777).toBe(0o600);
    expect(close).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("passport serve"));
  });
  it("persists an explicitly entered model key privately without printing it", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "passport-init-"));
    paths.push(dataDir);
    vi.stubEnv("PASSPORT_DATA_DIR", dataDir);
    vi.stubEnv("PASSPORT_LLM_API_KEY", "");
    const replies = ["anthropic", "test-model", "my-private-key", "skip"],
      log = vi.fn();
    await initializePassport({
      ask: async () => replies.shift()!,
      log,
      close() {},
    });
    const config = JSON.parse(await readFile(join(dataDir, "passport.config.json"), "utf8"));
    expect(config.llm).toMatchObject({
      model: "test-model",
      apiKey: "my-private-key",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("my-private-key");
  });
  it.each([true, false])(
    "INIT: works unattended with flags (%s) or buffered piped answers",
    async (flags) => {
      const dataDir = await mkdtemp(join(tmpdir(), "passport-init-pipe-"));
      paths.push(dataDir);
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("../cli.ts", import.meta.url)),
          "init",
          ...(flags ? ["--llm", "none", "--skip-account"] : []),
        ],
        {
          env: {
            ...process.env,
            PASSPORT_DATA_DIR: dataDir,
            PASSPORT_LLM_API_KEY: "",
            ANTHROPIC_API_KEY: "",
            OPENAI_API_KEY: "",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stdin.end(flags ? "" : "none\nskip\n");
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      expect(code, output).toBe(0);
      expect(
        JSON.parse(await readFile(join(dataDir, "passport.config.json"), "utf8")).accounts,
      ).toEqual([]);
      expect(output).toContain("Configuration saved");
    },
  );
});
