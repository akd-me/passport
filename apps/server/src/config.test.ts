import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, saveConfig } from "./config.js";
import { createDemoBackend } from "./demo/index.js";
import { createRealBackend } from "./compose.js";

describe("configuration and composition", () => {
  const paths: string[] = [];
  afterEach(async () => {
    await Promise.all(
      paths.splice(0).map((p) => rm(p, { recursive: true, force: true })),
    );
  });
  async function dataDir() {
    const path = await mkdtemp(join(tmpdir(), "passport-test-"));
    paths.push(path);
    return path;
  }
  it("loads a data-dir file, applies environment overrides, and keeps API keys environment-only", async () => {
    const path = await dataDir();
    await writeFile(
      join(path, "passport.config.json"),
      JSON.stringify({
        port: 9000,
        dailyDigestHour: 9,
        llm: {
          provider: "openai",
          model: "file-model",
          apiKey: "ignore-file-secret",
        },
      }),
    );
    const config = await loadConfig({
      PASSPORT_DATA_DIR: path,
      PASSPORT_PORT: "4000",
      PASSPORT_LLM_MODEL: "env-model",
      PASSPORT_LLM_API_KEY: "private-env-secret",
    });
    expect(config).toMatchObject({
      port: 4000,
      dailyDigestHour: 9,
      llm: {
        provider: "openai",
        model: "env-model",
        apiKey: "private-env-secret",
      },
    });
    await saveConfig(config);
    const saved = await readFile(join(path, "passport.config.json"), "utf8");
    expect(saved).not.toContain("secret");
    expect(
      (await loadConfig({ PASSPORT_DATA_DIR: path })).llm.apiKey,
    ).toBeUndefined();
  });
  it("rejects invalid config instead of silently substituting defaults", async () => {
    const path = await dataDir();
    await writeFile(join(path, "passport.config.json"), "{");
    await expect(loadConfig({ PASSPORT_DATA_DIR: path })).rejects.toThrow();
    await rm(join(path, "passport.config.json"));
    await expect(
      loadConfig({ PASSPORT_DATA_DIR: path, PASSPORT_PORT: "nope" }),
    ).rejects.toThrow("port");
    await expect(
      loadConfig({ PASSPORT_DATA_DIR: path, PASSPORT_DIGEST_HOUR: "24" }),
    ).rejects.toThrow("dailyDigestHour");
  });
  it("demo changes are ephemeral and real composition fails explicitly", async () => {
    const path = await dataDir(),
      config = defaultConfig(path),
      backend = await createDemoBackend(config);
    await backend.updateConfig({
      llm: { provider: "ollama", model: "new-model" },
    });
    await expect(
      readFile(join(path, "passport.config.json")),
    ).rejects.toThrow();
    await backend.close();
    await expect(createRealBackend(config)).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
  });
});
