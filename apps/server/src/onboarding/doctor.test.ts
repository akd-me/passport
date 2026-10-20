import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRealBackend } from "../compose.js";
import { defaultConfig } from "../config.js";
import { addAccount } from "../accounts.js";
import { createApp } from "../app.js";
import { doctorCommand, runDoctor } from "../doctor.js";

describe("passport doctor", () => {
  const paths: string[] = [];
  afterEach(async () => {
    await Promise.all(
      paths.splice(0).map((p) => rm(p, { recursive: true, force: true })),
    );
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it("reports a missing key without creating one during CLI diagnostics", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "passport-doctor-empty-"));
    paths.push(dataDir);
    vi.stubEnv("PASSPORT_DATA_DIR", dataDir);
    vi.stubEnv("PASSPORT_MASTER_KEY", "");
    const table = vi.spyOn(console, "table").mockImplementation(() => {});
    const previous = process.exitCode;
    try {
      await doctorCommand();
      expect(process.exitCode).toBe(1);
      expect(table).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ Check: "Master key", Status: "error" }),
        ]),
      );
      await expect(
        import("node:fs/promises").then((fs) =>
          fs.stat(join(dataDir, "master.key")),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.exitCode = previous;
    }
  });
  it("reports mixed healthy/unhealthy accounts and handles a missing model key", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "passport-doctor-"));
    paths.push(dataDir);
    await writeFile(join(dataDir, "master.key"), "a".repeat(43), {
      mode: 0o600,
    });
    const backend = await createRealBackend(defaultConfig(dataDir), {
      storePath: ":memory:",
    });
    try {
      const good = await addAccount(backend, {
        kind: "mock",
        emailAddress: "good@example.com",
        fields: {},
      });
      const bad = await addAccount(backend, {
        kind: "mock",
        emailAddress: "bad@example.com",
        fields: {},
      });
      await backend.store.accounts.upsert({
        ...good,
        lastSyncAt: new Date().toISOString(),
      });
      const fetcher = vi.fn<typeof fetch>();
      const report = await runDoctor(backend, {
        fetch: fetcher,
        probe: async (_backend, account) => {
          if (account.id === bad.id) throw new Error("token=secret");
        },
      });
      expect(report.ok).toBe(false);
      expect(report.checks).toContainEqual(
        expect.objectContaining({ name: "Master key", status: "ok" }),
      );
      expect(report.checks).toContainEqual(
        expect.objectContaining({ accountId: good.id, status: "ok" }),
      );
      expect(report.checks).toContainEqual(
        expect.objectContaining({ accountId: bad.id, status: "error" }),
      );
      expect(report.checks).toContainEqual(
        expect.objectContaining({ name: "LLM", status: "warning" }),
      );
      expect(fetcher).not.toHaveBeenCalled();
      expect(JSON.stringify(report)).not.toContain("secret");
      await chmod(join(dataDir, "master.key"), 0o644);
      const insecure = await runDoctor(backend, { probe: async () => {} });
      expect(insecure.checks).toContainEqual(
        expect.objectContaining({ name: "Master key", status: "error" }),
      );
      expect((await createApp(backend).request("/api/doctor")).status).toBe(
        200,
      );
    } finally {
      await backend.close();
    }
  });
  it("makes a bounded one-token LLM ping and reports failure without credentials", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "passport-doctor-"));
    paths.push(dataDir);
    const config = defaultConfig(dataDir);
    config.llm = {
      provider: "anthropic",
      model: "test-model",
      apiKey: "private-key",
    };
    const backend = await createRealBackend(config, { storePath: ":memory:" });
    try {
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        expect(JSON.parse(String(init!.body)).max_tokens).toBe(1);
        return Response.json({ error: "private-key" }, { status: 401 });
      });
      const report = await runDoctor(backend, { fetch: fetcher });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(report.checks).toContainEqual(
        expect.objectContaining({ name: "LLM", status: "error" }),
      );
      expect(JSON.stringify(report)).not.toContain("private-key");
    } finally {
      await backend.close();
    }
  });
});
