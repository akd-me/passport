import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkBind, PassportAuth } from "./auth.js";
import { createApp } from "./auth.test-client.js";
import { loadConfig } from "./config.js";
import { createDemoBackend } from "./demo/index.js";

const hostname = "passport.example-tailnet.ts.net";
const origin = `https://${hostname}`;

describe("documented loopback + Tailscale Serve recipe (offline proxy fixtures)", () => {
  let dataDir: string;
  let backend: Awaited<ReturnType<typeof createDemoBackend>>;
  let app: ReturnType<typeof createApp>;
  let token: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "passport-remote-"));
    // These are the same native-server environment values as docs/deploy.md.
    vi.stubEnv("PASSPORT_HOST", "127.0.0.1");
    vi.stubEnv("PASSPORT_PORT", "3000");
    vi.stubEnv("PASSPORT_ALLOWED_HOSTS", hostname);
    vi.stubEnv("PASSPORT_TRUST_PROXY", "true");
    const config = await loadConfig({
      PASSPORT_DATA_DIR: dataDir,
      PASSPORT_HOST: "127.0.0.1",
      PASSPORT_PORT: "3000",
    });
    backend = await createDemoBackend(config);
    const auth = new PassportAuth(backend, {
      PASSPORT_ALLOWED_HOSTS: hostname,
      PASSPORT_TRUST_PROXY: "true",
      PASSPORT_API_TOKEN: "offline-fixture-token",
    });
    app = createApp(backend, { auth, staticDir: join(dataDir, "no-ui") });
    token = auth.token;
  });

  afterEach(async () => {
    await backend.close();
    await rm(dataDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("parses the documented configuration and keeps Passport on loopback", async () => {
    await writeFile(
      join(dataDir, "passport.config.json"),
      JSON.stringify({ host: "0.0.0.0", port: 4444 }),
    );
    const config = await loadConfig({
      PASSPORT_DATA_DIR: dataDir,
      PASSPORT_HOST: "127.0.0.1",
      PASSPORT_PORT: "3000",
    });
    expect(config).toMatchObject({ host: "127.0.0.1", port: 3000 });
    expect(() => checkBind(config.host, false, {})).not.toThrow();
    await expect(
      loadConfig({ PASSPORT_DATA_DIR: dataDir, PASSPORT_PORT: "invalid" }),
    ).rejects.toHaveProperty("code", "INVALID_CONFIG");
    expect(() => new PassportAuth(backend, { PASSPORT_ALLOWED_HOSTS: "*" })).toThrow(
      /PASSPORT_ALLOWED_HOSTS/,
    );
    expect(() => new PassportAuth(backend, { PASSPORT_ALLOWED_HOSTS: origin })).toThrow(
      /PASSPORT_ALLOWED_HOSTS/,
    );
  });

  it.each([
    [hostname, 200],
    [`${hostname}:443`, 200],
    ["127.0.0.1:3000", 200],
    ["attacker.example", 421],
    [`${hostname}.attacker.example`, 421],
    ["other.example-tailnet.ts.net", 421],
  ])("Host %s returns %s even with a valid bearer", async (host, status) => {
    const response = await app.request("/api/health", { headers: { Host: host } });
    expect(response.status).toBe(status);
  });

  it.each([
    [origin, 200],
    ["http://127.0.0.1:3000", 200],
    ["https://attacker.example", 403],
    [`https://${hostname}.attacker.example`, 403],
    ["null", 403],
    [`${origin}/`, 403],
  ])("write Origin %s returns %s", async (requestOrigin, status) => {
    const response = await app.request("/api/trust/config", {
      method: "PUT",
      headers: { Host: hostname, Origin: requestOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ globalMode: "supervised" }),
    });
    expect(response.status).toBe(status);
  });

  it("exchanges the remote token URL for a Secure cookie and still enforces authentication and CSRF", async () => {
    const login = await app.request(`http://127.0.0.1:3000/?token=${encodeURIComponent(token)}`, {
      headers: { Host: hostname, "X-Forwarded-Proto": "https" },
    });
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/");
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly; SameSite=Strict; Path=/; Secure");
    expect(setCookie).not.toContain(token);
    const cookie = setCookie.split(";")[0] ?? "";
    // fetch bypasses the helper's injected bearer so cookie-only browser requests stay real.
    const browser = (path: string, init?: RequestInit) =>
      app.fetch(new Request(`http://127.0.0.1:3000${path}`, init));
    expect((await browser("/api/health", { headers: { Host: hostname } })).status).toBe(401);
    expect(
      (await browser(`/api/health?token=${token}`, { headers: { Host: hostname } })).status,
    ).toBe(401);
    expect(
      (await browser("/api/health", { headers: { Host: hostname, Cookie: cookie } })).status,
    ).toBe(200);
    const write = (extra: Record<string, string>) =>
      browser("/api/trust/config", {
        method: "PUT",
        headers: {
          Host: hostname,
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
          ...extra,
        },
        body: JSON.stringify({ globalMode: "supervised" }),
      });
    expect((await write({})).status).toBe(403);
    expect((await write({ "X-Requested-With": "passport" })).status).toBe(200);
    expect(
      (await write({ "X-Requested-With": "passport", Origin: "https://attacker.example" })).status,
    ).toBe(403);
    expect((await app.request("/?token=wrong", { headers: { Host: hostname } })).status).toBe(401);
  });

  it("only treats forwarded HTTPS as secure when trustProxy is explicitly enabled", () => {
    const untrusted = new PassportAuth(backend, { PASSPORT_TRUST_PROXY: "false" });
    const headers = new Headers({ "X-Forwarded-Proto": "https" });
    expect(untrusted.cookie(headers, "http://127.0.0.1:3000/")).not.toContain("Secure");
  });

  it.each([
    [hostname, origin, "correct", undefined],
    [hostname, "https://attacker.example", "correct", 403],
    ["attacker.example", origin, "correct", 421],
    [hostname, origin, "wrong", 401],
  ])(
    "checks WebSocket Host, Origin and token (%s, %s, %s)",
    (host, requestOrigin, credential, status) => {
      const auth = new PassportAuth(backend, {
        PASSPORT_ALLOWED_HOSTS: hostname,
        PASSPORT_API_TOKEN: "correct",
      });
      expect(
        auth.upgradeStatus({
          url: `/ws?token=${credential}`,
          headers: { host, origin: requestOrigin },
        } as IncomingMessage),
      ).toBe(status);
    },
  );
});
