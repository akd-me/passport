import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderRegistry } from "@passport/providers";
import type { ProviderRegistry } from "@passport/types";
import { Hono } from "hono";
import { createRealBackend, type RealBackend } from "../compose.js";
import { defaultConfig } from "../config.js";
import { createApp } from "../auth.test-client.js";
import { BrowserOAuth, persistOAuthCredentials } from "./oauth.js";
import { registerOnboarding } from "./routes.js";
import { ApiError } from "../errors.js";

interface Attempt {
  authUrl: string;
  attemptId: string;
  redirectUri: string;
}

describe("browser account OAuth", () => {
  let backend: RealBackend,
    fetcher: ReturnType<typeof vi.fn<typeof fetch>>,
    now: number;
  beforeEach(async () => {
    now = Date.now();
    fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/token"))
        return Response.json({
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          expires_in: 3600,
        });
      return Response.json({
        email: "alex@example.com",
        email_verified: true,
        mail: "alex@example.com",
      });
    });
    const registry = createProviderRegistry({ fetch: fetcher });
    const offline: ProviderRegistry = {
      ...registry,
      mail: (kind) =>
        registry.mail(kind === "gmail" || kind === "graph" ? "mock" : kind),
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
  const post = (app: ReturnType<typeof createApp>, input: unknown) =>
    app.request("http://127.0.0.1:3000/api/accounts/oauth/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  function appFor(oauth: BrowserOAuth) {
    const app = new Hono();
    app.onError((error, c) =>
      c.json(
        { error: { code: error instanceof ApiError ? error.code : "FAILED" } },
        400,
      ),
    );
    registerOnboarding(app, backend, { oauth });
    return app;
  }
  it.each(["gmail", "graph"] as const)(
    "exchanges %s with a nonce-bound state and S256 verifier; creates mail/calendar with encrypted shared tokens",
    async (kind) => {
      const app = appFor(
        new BrowserOAuth(backend, { now: () => now, fetch: fetcher }),
      );
      const response = await post(app, {
        kind,
        clientId: "own-client",
        calendar: true,
      });
      const result = (await response.json()) as Attempt,
        cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
      expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
      const auth = new URL(result.authUrl);
      expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
      expect(auth.searchParams.get("scope")).toContain(
        kind === "gmail" ? "calendar.events" : "Calendars.ReadWrite",
      );
      expect(auth.searchParams.get("scope")).toContain(
        kind === "gmail" ? "email" : "User.Read",
      );
      const callback = `http://127.0.0.1:3000/oauth/callback?state=${result.attemptId}&code=once`;
      const connected = await app.request(callback, { headers: { cookie } });
      expect(connected.status).toBe(303);
      const exchange = fetcher.mock.calls.find(([url]) =>
        String(url).includes("/token"),
      )!;
      const fields = new URLSearchParams(String(exchange[1]!.body));
      expect(fields.get("client_secret")).toBeNull();
      expect(
        createHash("sha256")
          .update(fields.get("code_verifier")!)
          .digest("base64url"),
      ).toBe(auth.searchParams.get("code_challenge"));
      expect(fields.get("redirect_uri")).toBe(
        "http://127.0.0.1:3000/oauth/callback",
      );
      const accounts = await backend.store.accounts.list();
      expect(accounts).toHaveLength(2);
      const mail = accounts.find((a) => a.kind === kind)!,
        calendar = accounts.find((a) => a.kind.endsWith("calendar"))!;
      expect(mail.capabilities.mail).toBe(true);
      expect(calendar.capabilities).toMatchObject({
        mail: false,
        calendar: true,
      });
      expect(calendar.settings.mailAccountId).toBe(mail.id);
      expect(JSON.stringify(accounts)).not.toContain("access-secret");
      expect(JSON.stringify(accounts)).not.toContain("codeVerifier");
      expect(await backend.store.accounts.getCredentials(calendar.id)).toEqual(
        await backend.store.accounts.getCredentials(mail.id),
      );
      expect(backend.syncAccount).toHaveBeenCalledWith(mail.id);
      expect(connected.headers.get("location")).toBe(
        `/accounts?connected=${mail.id}`,
      );
      expect(
        (await app.request(callback, { headers: { cookie } })).status,
      ).toBe(400);
      await persistOAuthCredentials(backend.store, mail.id, {
        access_token: "rotated",
      });
      expect(await backend.store.accounts.getCredentials(calendar.id)).toEqual({
        access_token: "rotated",
      });
    },
  );
  it("rejects mismatched states, missing/foreign nonce cookies and expired attempts before exchanging a code", async () => {
    const app = appFor(
      new BrowserOAuth(backend, { now: () => now, fetch: fetcher }),
    );
    const started = await post(app, { kind: "gmail", clientId: "client" }),
      result = (await started.json()) as Attempt;
    const callback = `http://127.0.0.1:3000/oauth/callback?state=${result.attemptId}&code=code`;
    expect((await app.request(callback)).status).toBe(400);
    expect(
      (
        await app.request(callback, {
          headers: { cookie: "passport_oauth_wrong=foreign" },
        })
      ).status,
    ).toBe(400);
    const cookie = started.headers.get("set-cookie")!.split(";")[0]!;
    expect(
      (
        await app.request(callback.replace(result.attemptId, "wrong"), {
          headers: { cookie },
        })
      ).status,
    ).toBe(400);
    now += 600001;
    expect((await app.request(callback, { headers: { cookie } })).status).toBe(
      400,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps simultaneous accounts independent and handles denial without creating accounts", async () => {
    const app = appFor(new BrowserOAuth(backend, { fetch: fetcher }));
    const first = await post(app, { kind: "gmail", clientId: "a" }),
      second = await post(app, { kind: "graph", clientId: "b" });
    const a = (await first.json()) as Attempt,
      b = (await second.json()) as Attempt;
    expect(first.headers.get("set-cookie")?.split("=")[0]).not.toBe(
      second.headers.get("set-cookie")?.split("=")[0],
    );
    const denied = await app.request(
      `http://127.0.0.1:3000/oauth/callback?state=${a.attemptId}&error=access_denied`,
      { headers: { cookie: first.headers.get("set-cookie")!.split(";")[0]! } },
    );
    expect(denied.status).toBe(400);
    expect(await backend.store.accounts.list()).toHaveLength(0);
    expect(
      (
        await app.request(
          `http://127.0.0.1:3000/api/accounts/oauth/status/${b.attemptId}`,
          {
            headers: {
              cookie: second.headers.get("set-cookie")!.split(";")[0]!,
            },
          },
        )
      ).status,
    ).toBe(200);
  });
  it("honors mail-only consent and does not create a calendar for a reduced grant", async () => {
    fetcher.mockImplementation(async (url) =>
      String(url).includes("/token")
        ? Response.json({
            access_token: "access",
            refresh_token: "refresh",
            scope: "openid email https://www.googleapis.com/auth/gmail.modify",
          })
        : Response.json({ email: "alex@example.com" }),
    );
    const app = appFor(new BrowserOAuth(backend, { fetch: fetcher }));
    const response = await post(app, {
        kind: "gmail",
        clientId: "client",
        calendar: false,
      }),
      result = (await response.json()) as Attempt;
    expect(new URL(result.authUrl).searchParams.get("scope")).not.toContain(
      "calendar",
    );
    expect(
      (
        await app.request(
          `http://127.0.0.1:3000/oauth/callback?state=${result.attemptId}&code=code`,
          {
            headers: {
              cookie: response.headers.get("set-cookie")!.split(";")[0]!,
            },
          },
        )
      ).status,
    ).toBe(303);
    expect(await backend.store.accounts.list()).toHaveLength(1);
  });
  it("re-authorizes in place, rejects a different identity, and pauses a calendar when consent is removed", async () => {
    const oauth = new BrowserOAuth(backend, { fetch: fetcher });
    const first = await oauth.start(
      { kind: "gmail", clientId: "client" },
      "http://127.0.0.1:3000",
    );
    const mail = await oauth.callback(
      new URL(
        `http://127.0.0.1:3000/oauth/callback?state=${first.attemptId}&code=first`,
      ),
      first.nonce,
    );
    const next = await oauth.start(
      {
        kind: "gmail",
        clientId: "client",
        accountId: mail.id,
        calendar: false,
      },
      "http://127.0.0.1:3000",
    );
    const reconnected = await oauth.callback(
      new URL(
        `http://127.0.0.1:3000/oauth/callback?state=${next.attemptId}&code=second`,
      ),
      next.nonce,
    );
    expect(reconnected.id).toBe(mail.id);
    expect(await backend.store.accounts.list()).toHaveLength(2);
    const calendar = (await backend.store.accounts.list()).find(
      (a) => a.kind === "google-calendar",
    )!;
    expect(calendar.settings.reauthorizationRequired).toBe(true);
    const wrong = await oauth.start(
      { kind: "gmail", clientId: "client", accountId: mail.id },
      "http://127.0.0.1:3000",
    );
    fetcher.mockImplementation(async (url) =>
      String(url).includes("/token")
        ? Response.json({ access_token: "access", refresh_token: "refresh" })
        : Response.json({ email: "someone-else@example.com" }),
    );
    await expect(
      oauth.callback(
        new URL(
          `http://127.0.0.1:3000/oauth/callback?state=${wrong.attemptId}&code=third`,
        ),
        wrong.nonce,
      ),
    ).rejects.toMatchObject({ code: "OAUTH_IDENTITY_MISMATCH" });
    expect((await backend.store.accounts.get(mail.id))?.emailAddress).toBe(
      "alex@example.com",
    );
  });
  it("rejects cross-origin start requests, malformed options and non-loopback redirects", async () => {
    const app = createApp(backend);
    const cross = await app.request(
      "http://127.0.0.1:3000/api/accounts/oauth/start",
      {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ kind: "gmail", clientId: "client" }),
      },
    );
    expect(cross.status).toBe(403);
    expect(
      (
        await post(app, {
          kind: "gmail",
          clientId: "client",
          calendar: "false",
        })
      ).status,
    ).toBe(400);
    const oauth = new BrowserOAuth(backend);
    await expect(
      oauth.start(
        { kind: "gmail", clientId: "client" },
        "http://remote.example:3000",
      ),
    ).rejects.toMatchObject({ code: "INVALID_REDIRECT" });
  });
});
