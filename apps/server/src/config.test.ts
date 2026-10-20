import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, saveConfig } from "./config.js";
import { createDemoBackend } from "./demo/index.js";
import { createRealBackend } from "./compose.js";
import { createApp } from "./app.js";
import { addAccount } from "./accounts.js";

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
  it("loads file keys, applies environment overrides, and never persists environment keys", async () => {
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
    expect(saved).not.toContain("private-env-secret");
    expect(saved).toContain("ignore-file-secret");
    expect((await loadConfig({ PASSPORT_DATA_DIR: path })).llm.apiKey).toBe(
      "ignore-file-secret",
    );
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
  it("demo changes are ephemeral; real composition migrates and persists an encrypted account across restart", async () => {
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
    const real = await createRealBackend(config);
    let accountId: string;
    try {
      const account = await addAccount(real, {
        kind: "mock",
        emailAddress: "alex@example.com",
        fields: {},
      });
      accountId = account.id;
      await real.store.accounts.setCredentials(account.id, {
        token: "test-credential",
      });
      await real.syncAccount(account.id);
      expect((await stat(join(path, "master.key"))).mode & 0o777).toBe(0o600);
      expect(
        (await stat(join(path, "passport.config.json"))).mode & 0o777,
      ).toBe(0o600);
    } finally {
      await real.close();
    }
    const restarted = await createRealBackend(
      await loadConfig({ PASSPORT_DATA_DIR: path }),
    );
    try {
      expect(await restarted.store.accounts.getCredentials(accountId!)).toEqual(
        { token: "test-credential" },
      );
      expect(
        (await restarted.store.emails.query({ limit: 100 })).items,
      ).toHaveLength(40);
    } finally {
      await restarted.close();
    }
  });
  it("starts without a key, reports missing inference configuration and redacts file keys", async () => {
    const config = await loadConfig({ PASSPORT_DATA_DIR: await dataDir() });
    expect(config.llm.provider).toBe("anthropic");
    const backend = await createRealBackend(config, { storePath: ":memory:" });
    try {
      const response = await createApp(backend).request("/api/accounts");
      expect(((await response.json()) as { llm: unknown }).llm).toMatchObject({
        apiKeyConfigured: false,
        configured: false,
      });
      await expect(
        backend.agent.run({ kind: "manual", instruction: "Review" }),
      ).rejects.toMatchObject({ code: "LLM_NOT_CONFIGURED" });
      await backend.updateConfig({
        llm: { ...config.llm, apiKey: "file-key" },
      });
      expect(
        await (await createApp(backend).request("/api/accounts")).text(),
      ).not.toContain("file-key");
    } finally {
      await backend.close();
    }
  });
  it("selects provider-specific environment credentials", async () => {
    const path = await dataDir();
    expect(
      (
        await loadConfig({
          PASSPORT_DATA_DIR: path,
          ANTHROPIC_API_KEY: "anthropic-key",
          OPENAI_API_KEY: "openai-key",
        })
      ).llm.apiKey,
    ).toBe("anthropic-key");
    expect(
      (
        await loadConfig({
          PASSPORT_DATA_DIR: path,
          PASSPORT_LLM_PROVIDER: "openai",
          OPENAI_API_KEY: "openai-key",
          ANTHROPIC_API_KEY: "anthropic-key",
        })
      ).llm.apiKey,
    ).toBe("openai-key");
  });
});
