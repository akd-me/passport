import { randomBytes } from "node:crypto";
import { createProviderRegistry } from "@passport/providers";
import type { ProviderRegistry } from "@passport/types";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { PassportAuth } from "../auth.js";
import { createRealBackend, type RealBackend } from "../compose.js";
import { defaultConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { BrowserOAuth } from "./oauth.js";
import { registerOnboarding } from "./routes.js";

interface Attempt {
  authUrl: string;
  launchUrl: string;
  attemptId: string;
}

const ORIGIN = "http://127.0.0.1:3000";
const cookieOf = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";

describe("OAuth launch URL for a browser without the starting tab's cookies", () => {
  let backend: RealBackend;
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeEach(async () => {
    fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/token")
        ? Response.json({ access_token: "a", refresh_token: "r", expires_in: 3600 })
        : Response.json({ email: "alex@example.com", email_verified: true }),
    );
    const registry = createProviderRegistry({ fetch: fetcher });
    const offline: ProviderRegistry = {
      ...registry,
      mail: (kind) => registry.mail(kind === "gmail" || kind === "graph" ? "mock" : kind),
      calendar: () => registry.calendar("mock"),
    };
    backend = await createRealBackend(defaultConfig(), {
      storePath: ":memory:",
      providers: offline,
    });
    vi.spyOn(backend, "syncAccount").mockResolvedValue();
  });
  afterEach(async () => {
    await backend.close();
    vi.restoreAllMocks();
  });

  it("R3-1: start in the app window (jar A), launch and callback in the system browser (jar B)", async () => {
    // The real app with real authentication: the system browser holds no session at all.
    const token = randomBytes(32).toString("hex");
    const app = createApp(backend, {
      auth: new PassportAuth(backend, { PASSPORT_API_TOKEN: token }),
    });
    const started = await app.request(`${ORIGIN}/api/accounts/oauth/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "gmail", clientId: "x.apps.googleusercontent.com" }),
    });
    expect(started.status).toBe(200);
    const jarA = cookieOf(started);
    const attempt = (await started.json()) as Attempt;
    expect(new URL(attempt.launchUrl).origin).toBe(ORIGIN);
    expect(attempt.launchUrl).not.toContain(attempt.attemptId);
    const denied = `${ORIGIN}/oauth/callback?state=${attempt.attemptId}&error=access_denied`;
    const code = async (response: Response) =>
      ((await response.json()) as { error: { code: string } }).error.code;

    // Before: the system browser reaches the callback without the binding cookie.
    expect(await code(await app.request(denied))).toBe("OAUTH_STATE");

    // After: it opens the launch URL first, which binds it and forwards to consent.
    const launched = await app.request(attempt.launchUrl);
    expect(launched.status).toBe(302);
    expect(launched.headers.get("location")).toBe(attempt.authUrl);
    expect(launched.headers.get("cache-control")).toContain("no-store");
    const jarB = cookieOf(launched);
    expect(jarB.split("=")[0]).toBe(jarA.split("=")[0]);
    // The nonce check still runs (no state-only fallback): this passes it and fails on denial.
    expect(await code(await app.request(denied, { headers: { cookie: jarB } }))).toBe(
      "OAUTH_DENIED",
    );
    // The window, polling with its own cookie, sees the outcome.
    const status = await app.request(`${ORIGIN}/api/accounts/oauth/status/${attempt.attemptId}`, {
      headers: { authorization: `Bearer ${token}`, cookie: jarA },
    });
    expect(await status.json()).toMatchObject({ status: "failed" });
    // The attempt is consumed, and its launch URL with it.
    expect((await app.request(attempt.launchUrl)).status).toBe(404);
    expect((await app.request(`${ORIGIN}/oauth/launch/unknown`)).status).toBe(404);
  });

  it("R3-1: a launched system browser completes the connection and the window sees it", async () => {
    const app = new Hono();
    app.onError((error, c) =>
      c.json({ error: { code: error instanceof ApiError ? error.code : "FAILED" } }, 400),
    );
    registerOnboarding(app, backend, { oauth: new BrowserOAuth(backend, { fetch: fetcher }) });
    const started = await app.request(`${ORIGIN}/api/accounts/oauth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "gmail", clientId: "own-client", calendar: false }),
    });
    const attempt = (await started.json()) as Attempt;
    // The launch URL may be reopened ("Open authorization tab") until the callback arrives.
    await app.request(attempt.launchUrl);
    const jarB = cookieOf(await app.request(attempt.launchUrl));
    const connected = await app.request(
      `${ORIGIN}/oauth/callback?state=${attempt.attemptId}&code=once`,
      { headers: { cookie: jarB } },
    );
    expect(connected.status).toBe(303);
    const status = await app.request(`${ORIGIN}/api/accounts/oauth/status/${attempt.attemptId}`, {
      headers: { cookie: cookieOf(started) },
    });
    expect(await status.json()).toMatchObject({ status: "connected" });
    expect(await backend.store.accounts.list()).toHaveLength(1);
  });
});
