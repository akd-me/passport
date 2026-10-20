import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultConfig } from "../config.js";
import { serverClient } from "./server-client.js";
import { acquireOwner } from "../owner-lock.js";
import { main } from "../cli.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "passport-cli-http-"));
  directories.push(directory);
  return defaultConfig(directory);
}
it("R3: reads api-token without generating a new one and authenticates health and requests", async () => {
  const config = await fixture();
  vi.stubEnv("PASSPORT_API_TOKEN", "");
  await writeFile(join(config.dataDir, "api-token"), "file-token\n");
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true, mode: "real" }));
  vi.stubGlobal("fetch", fetcher);
  const request = await serverClient(config);
  await request!("/api/decisions");
  for (const [, init] of fetcher.mock.calls) expect(init?.headers).toHaveProperty("Authorization", "Bearer file-token");
});
it("R3/R9: unreachable live owner refuses fallback; absent owner announces local access", async () => {
  const config = await fixture();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Connection refused")));
  const owner = acquireOwner(config.dataDir);
  try { await expect(serverClient(config)).rejects.toHaveProperty("code", "SERVER_UNAVAILABLE"); }
  finally { owner.release(); }
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await serverClient(config)).toBeNull();
  expect(output).toHaveBeenCalledWith(expect.stringContaining("local store without background jobs"));
});
it.each(["trust", "decisions", "sync", "triage"])("R3: %s uses authenticated HTTP while the server is reachable", async command => {
  const config = await fixture();
  vi.stubEnv("PASSPORT_DATA_DIR", config.dataDir);
  vi.stubEnv("PASSPORT_API_TOKEN", "shared-token");
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => Response.json(url.endsWith("health") ? { ok: true, mode: "real" } : url.endsWith("accounts") ? { accounts: [{ id: "account" }] } : { ok: true }));
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(console, "log").mockImplementation(() => {});
  await main([command, ...(command === "triage" ? ["email"] : [])]);
  expect(fetcher.mock.calls.length).toBeGreaterThan(1);
  for (const [, init] of fetcher.mock.calls) expect(init?.headers).toHaveProperty("Authorization", "Bearer shared-token");
  expect(fetcher.mock.calls.at(-1)?.[0]).toContain(command === "sync" ? "/api/accounts/account/sync" : command === "triage" ? "/api/agent/triage/email" : `/api/${command}`);
});
