import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializePassport } from "./init.js";

describe("passport init", () => {
  const paths: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      paths.splice(0).map((p) => rm(p, { recursive: true, force: true })),
    );
  });
  it("creates a private master key and config with no model or account", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "passport-init-"));
    paths.push(dataDir);
    vi.stubEnv("PASSPORT_DATA_DIR", dataDir);
    const replies = ["none", "skip"],
      close = vi.fn(),
      log = vi.fn();
    await initializePassport({ ask: async () => replies.shift()!, log, close });
    const config = JSON.parse(
      await readFile(join(dataDir, "passport.config.json"), "utf8"),
    );
    expect(config.accounts).toEqual([]);
    expect(config.llm.apiKey).toBeUndefined();
    expect(config.sync.initialDays).toBe(30);
    expect((await stat(join(dataDir, "master.key"))).mode & 0o777).toBe(0o600);
    expect(
      (await stat(join(dataDir, "passport.config.json"))).mode & 0o777,
    ).toBe(0o600);
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
    const config = JSON.parse(
      await readFile(join(dataDir, "passport.config.json"), "utf8"),
    );
    expect(config.llm).toMatchObject({
      model: "test-model",
      apiKey: "my-private-key",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("my-private-key");
  });
});
