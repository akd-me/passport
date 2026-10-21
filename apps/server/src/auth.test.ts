import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "./app.js";
import { apiToken, checkBind, getAuth, PassportAuth } from "./auth.js";
import { main } from "./cli.js";
import { defaultConfig } from "./config.js";
import { createDemoBackend } from "./demo/index.js";
import { startServer } from "./server.js";

describe("local token security", () => {
  let dataDir: string;
  let backend: Awaited<ReturnType<typeof createDemoBackend>>;
  let auth: PassportAuth;
  let app: ReturnType<typeof createApp>;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "passport-auth-"));
    backend = await createDemoBackend({ ...defaultConfig(dataDir), port: 0 });
    auth = new PassportAuth(backend, {});
    app = createApp(backend, { auth });
  });
  afterEach(async () => {
    await backend.close();
    await rm(dataDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const json = (token: unknown) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const bearer = () => ({ Authorization: `Bearer ${auth.token}` });
  async function login() {
    const response = await app.request("/api/auth/login", json(auth.token));
    expect(response.status).toBe(303);
    return response.headers.get("set-cookie")!.split(";")[0]!;
  }

  it("creates a durable 32-byte hex token with private permissions and reuses it", async () => {
    const token = apiToken(dataDir, { env: {} });
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(dataDir, "api-token"), "utf8")).toBe(`${token}\n`);
    expect((await stat(join(dataDir, "api-token"))).mode & 0o777).toBe(0o600);
    expect(apiToken(dataDir, { env: {} })).toBe(token);
    expect(apiToken(dataDir, { rotate: true, env: {} })).not.toBe(token);
    expect((await stat(join(dataDir, "api-token"))).mode & 0o777).toBe(0o600);
  });
  it("honors explicit tokens without persisting them and refuses ineffective rotation", async () => {
    const env = { PASSPORT_API_TOKEN: "explicit-test-token" };
    expect(apiToken(dataDir, { env })).toBe(env.PASSPORT_API_TOKEN);
    expect(() => apiToken(dataDir, { env, rotate: true })).toThrow(/PASSPORT_API_TOKEN/);
    await expect(stat(join(dataDir, "api-token"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("rejects malformed token files instead of disabling authentication", async () => {
    await writeFile(join(dataDir, "api-token"), "");
    expect(() => apiToken(dataDir, { env: {} })).toThrow(/Invalid api-token/);
  });
  it("keeps demo tokens in memory and gives independent demo servers fresh tokens", async () => {
    expect(new PassportAuth(backend, {}).token).not.toBe(auth.token);
    await expect(stat(join(dataDir, "api-token"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(getAuth(backend)).toBe(getAuth(backend));
  });
  it("prints and rotates durable tokens through the CLI without opening a backend", async () => {
    vi.stubEnv("PASSPORT_DATA_DIR", dataDir);
    vi.stubEnv("PASSPORT_API_TOKEN", "");
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["token"]);
    const original = output.mock.calls[0]![0] as string;
    expect(original).toBe(apiToken(dataDir, { env: {} }));
    await main(["token", "--rotate"]);
    expect(output.mock.calls[1]![0]).not.toBe(original);
    await expect(stat(join(dataDir, "passport.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it.each(["/api", "/api/health", "/api/emails", "/api/not-a-route"])(
    "returns JSON 401 without credentials at %s",
    async (path) => {
      const response = await app.request(path);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { code: "UNAUTHORIZED" },
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
  );
  it("accepts bearer tokens but rejects incorrect and query-only API credentials", async () => {
    expect((await app.request("/api/health", { headers: bearer() })).status).toBe(200);
    expect(
      (
        await app.request("/api/health", {
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
    expect((await app.request(`/api/health?token=${auth.token}`)).status).toBe(401);
  });
  it("exchanges the startup URL for an opaque strict HttpOnly cookie and a clean redirect", async () => {
    const response = await app.request(`/?token=${auth.token}`);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly; SameSite=Strict; Path=/");
    expect(cookie).not.toContain(auth.token);
    expect(cookie).not.toContain("Secure");
    expect(
      (
        await app.request("/api/health", {
          headers: { Cookie: cookie.split(";")[0]! },
        })
      ).status,
    ).toBe(200);
    expect((await app.request("/?token=wrong")).status).toBe(401);
  });
  it("supports JSON login, reports status without secrets, and revokes logout sessions", async () => {
    const cookie = await login();
    const status = await app.request("/api/auth/status", {
      headers: { Cookie: cookie },
    });
    expect(await status.json()).toEqual({
      authenticated: true,
      tokenPath: join(dataDir, "api-token"),
    });
    expect(await (await app.request("/api/auth/status")).json()).toMatchObject({
      authenticated: false,
    });
    const response = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie, "X-Requested-With": "passport" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await app.request("/api/health", { headers: { Cookie: cookie } })).status).toBe(401);
  });
  it("rejects malformed or wrong-token login without setting a cookie", async () => {
    for (const init of [json("wrong"), json(null), { method: "POST", body: "{" }]) {
      const response = await app.request("/api/auth/login", init);
      expect([400, 401]).toContain(response.status);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });
  it("requires the CSRF header for cookie writes and logout, while exempting bearer clients", async () => {
    const cookie = await login();
    const update = {
      method: "PUT",
      body: JSON.stringify({ globalMode: "full_access" }),
    };
    expect(
      (
        await app.request("/api/trust/config", {
          ...update,
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("/api/auth/logout", {
          method: "POST",
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("/api/trust/config", {
          ...update,
          headers: {
            Cookie: cookie,
            "X-Requested-With": "passport",
            Origin: "http://localhost:5173",
          },
        })
      ).status,
    ).toBe(200);
    expect((await app.request("/api/trust/config", { ...update, headers: bearer() })).status).toBe(
      200,
    );
  });
  it("does not fall back to a valid cookie when the bearer token is invalid", async () => {
    const cookie = await login();
    expect(
      (
        await app.request("/api/health", {
          headers: { Cookie: cookie, Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
  });
  it.each([
    "attacker.example",
    "localhost.attacker.example:3000",
    "localhost@attacker.example",
    "127.0.0.1.attacker.example",
    "127.0.0.2",
    "localhost:99999",
  ])("rejects a foreign or malformed Host: %s", async (host) => {
    expect(
      (
        await app.request("/api/health", {
          headers: { ...bearer(), Host: host },
        })
      ).status,
    ).toBe(421);
    expect((await app.request("/", { headers: { Host: host } })).status).toBe(421);
  });
  it.each(["127.0.0.1", "127.0.0.1:3000", "localhost:5173", "LOCALHOST", "[::1]", "[::1]:3000"])(
    "accepts allowed loopback Host: %s",
    async (host) => {
      expect(
        (
          await app.request("/api/health", {
            headers: { ...bearer(), Host: host },
          })
        ).status,
      ).toBe(200);
    },
  );
  it.each([
    "https://attacker.example",
    "null",
    "http://localhost.attacker.example",
    "http://localhost/",
    "file://localhost",
  ])("rejects foreign/malformed Origin on POST even with bearer auth: %s", async (origin) => {
    expect(
      (
        await app.request("/api/agent/run", {
          method: "POST",
          headers: { ...bearer(), Origin: origin },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("/api/auth/login", {
          ...json(auth.token),
          headers: { Origin: origin },
        })
      ).status,
    ).toBe(403);
  });
  it("allows exact configured LAN/proxy names and ports without suffix or wildcard matching", () => {
    const remote = new PassportAuth(backend, {
      PASSPORT_ALLOWED_HOSTS: "passport.tailnet.test, mail.lan:8443",
    });
    expect(remote.allowsHost("passport.tailnet.test:3000")).toBe(true);
    expect(remote.allowsOrigin("https://mail.lan:8443")).toBe(true);
    expect(remote.allowsHost("mail.lan:3000")).toBe(false);
    expect(remote.allowsHost("passport.tailnet.test.attacker.example")).toBe(false);
    expect(() => new PassportAuth(backend, { PASSPORT_ALLOWED_HOSTS: "*" })).toThrow(
      /PASSPORT_ALLOWED_HOSTS/,
    );
  });
  it("only trusts forwarded HTTPS when explicitly enabled", async () => {
    const request = json(auth.token);
    request.headers = {
      ...request.headers,
      ...{ "X-Forwarded-Proto": "https" },
    };
    expect((await app.request("/api/auth/login", request)).headers.get("set-cookie")).not.toContain(
      "Secure",
    );
    const trusted = new PassportAuth(backend, { PASSPORT_TRUST_PROXY: "true" });
    const trustedApp = createApp(backend, { auth: trusted });
    const response = await trustedApp.request("/api/auth/login", {
      ...json(trusted.token),
      headers: { "X-Forwarded-Proto": "https" },
    });
    expect(response.headers.get("set-cookie")).toContain("Secure");
    const tls = await app.request("https://localhost/api/auth/login", json(auth.token));
    expect(tls.headers.get("set-cookie")).toContain("Secure");
  });
  it("sets conservative security headers on API failures and UI assets", async () => {
    for (const path of ["/api/health", "/"]) {
      const response = await app.request(path);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      const csp = response.headers.get("content-security-policy")!;
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("unsafe-eval");
    }
  });
  it("rejects expired sessions and malformed upgrades without crashing the listener", async () => {
    const cookie = await login();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 25 * 60 * 60 * 1000);
    expect((await app.request("/api/health", { headers: { Cookie: cookie } })).status).toBe(401);
    expect(
      auth.upgradeStatus({
        url: "//[",
        headers: { host: "localhost" },
      } as IncomingMessage),
    ).toBe(401);
    const durable = new PassportAuth({ mode: "real", config: backend.config }, {});
    await writeFile(join(dataDir, "api-token"), "invalid");
    expect(
      durable.upgradeStatus({
        url: "/ws",
        headers: { host: "localhost" },
      } as IncomingMessage),
    ).toBe(401);
  });
  it("revokes both bearer tokens and existing cookies immediately after file rotation", async () => {
    auth = new PassportAuth({ mode: "real", config: backend.config }, {});
    app = createApp(backend, { auth });
    const old = auth.token;
    const cookie = await login();
    const rotated = apiToken(dataDir, { rotate: true, env: {} });
    expect(
      (
        await app.request("/api/health", {
          headers: { Authorization: `Bearer ${old}` },
        })
      ).status,
    ).toBe(401);
    expect((await app.request("/api/health", { headers: { Cookie: cookie } })).status).toBe(401);
    expect(
      (
        await app.request("/api/health", {
          headers: { Authorization: `Bearer ${rotated}` },
        })
      ).status,
    ).toBe(200);
  });
  it("refuses non-loopback starts unless explicitly authorized and warns when authorized", () => {
    vi.stubEnv("PASSPORT_API_TOKEN", "");
    backend.config.host = "0.0.0.0";
    expect(() => startServer(backend)).toThrow(/Non-loopback/);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkBind("0.0.0.0", true, {});
    checkBind("192.168.1.20", false, { PASSPORT_API_TOKEN: "explicit" });
    expect(warning).toHaveBeenCalledTimes(2);
    for (const host of ["localhost", "127.0.0.1", "127.0.0.2", "::1"]) {
      expect(() => checkBind(host, false, {})).not.toThrow();
    }
    expect(auth.loginUrl("::1", 3000)).toContain("http://[::1]:3000/?token=");
    expect(auth.loginUrl("0.0.0.0", 3000)).toContain("http://127.0.0.1:3000/?token=");
  });
  it("blocks the review's exact DNS-rebinding trust escalation on a live listener", async () => {
    const handle = startServer(backend);
    try {
      await once(handle.server, "listening");
      const address = handle.server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected listener");
      }
      const original = (await backend.policy.getConfig()).globalMode;
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: "/api/trust/config",
            method: "PUT",
            headers: {
              Host: "attacker.example",
              Origin: "http://attacker.example",
              "Content-Type": "application/json",
            },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode!);
          },
        );
        request.on("error", reject);
        request.end(JSON.stringify({ globalMode: "full_access" }));
      });
      expect(status).toBe(421);
      expect((await backend.policy.getConfig()).globalMode).toBe(original);
    } finally {
      await handle.close();
    }
  });
  it("authenticates live WebSocket upgrades with bearer, session cookie, or query token", async () => {
    const handle = startServer(backend);
    try {
      await once(handle.server, "listening");
      const address = handle.server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected listener");
      }
      const root = `http://127.0.0.1:${address.port}`;
      const token = getAuth(backend).token;
      const response = await fetch(`${root}/?token=${token}`, {
        redirect: "manual",
      });
      const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      const cases: [string, Record<string, string>, number][] = [
        ["/ws", {}, 401],
        ["/ws?token=wrong", {}, 401],
        ["/ws", { Authorization: `Bearer ${token}` }, 101],
        [`/ws?token=${token}`, {}, 101],
        ["/ws", { Cookie: cookie, Origin: root }, 101],
        ["/ws", { Cookie: cookie, Origin: "http://attacker.example" }, 403],
        [
          "/ws",
          {
            Authorization: `Bearer ${token}`,
            Host: "attacker.example",
            Origin: "http://attacker.example",
          },
          421,
        ],
      ];
      for (const [path, headers, expected] of cases) {
        const status = await new Promise<number>((resolve) => {
          const socket = new WebSocket(`${root.replace("http", "ws")}${path}`, {
            headers,
          });
          socket.on("error", () => {});
          socket.once("open", () => {
            socket.close();
            resolve(101);
          });
          socket.once("unexpected-response", (_request, response) => {
            response.resume();
            socket.terminate();
            resolve(response.statusCode!);
          });
        });
        expect(status, path).toBe(expected);
      }
    } finally {
      await handle.close();
    }
  });
});
