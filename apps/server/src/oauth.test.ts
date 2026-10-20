import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { ProviderSetupDescriptor } from "@passport/types";
import { authorizeOAuth } from "./oauth.js";

async function redirectUri() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${address.port}/oauth/callback`;
}

describe("CLI OAuth callback", () => {
  it("validates state, exchanges exactly one code with PKCE and closes the listener", async () => {
    const redirect = await redirectUri();
    const exchangeCode = vi.fn(async () => ({
      access_token: "fixture-token",
      refresh_token: "fixture-refresh",
    }));
    const callbacks: Promise<void>[] = [];
    const descriptor: ProviderSetupDescriptor = {
      kind: "gmail",
      label: "Gmail",
      fields: [],
      oauth: {
        scopes: ["mail"],
        exchangeCode,
        buildAuthUrl: (settings, uri, state) => {
          expect(settings.codeVerifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
          expect(uri).toBe(redirect);
          return `https://auth.example/authorize?state=${state}`;
        },
      },
    };
    const credentials = await authorizeOAuth(
      descriptor,
      { clientId: "client", clientSecret: "private" },
      {
        redirectUri: redirect,
        onAuthUrl: (url) => {
          callbacks.push(
            (async () => {
              expect(
                (await fetch(`${redirect}?state=wrong&code=evil`)).status,
              ).toBe(400);
              const state = new URL(url).searchParams.get("state");
              expect(
                (await fetch(`${redirect}?state=${state}&code=valid-code`))
                  .status,
              ).toBe(200);
            })(),
          );
        },
      },
    );
    await Promise.all(callbacks);
    expect(credentials).toEqual({
      access_token: "fixture-token",
      refresh_token: "fixture-refresh",
    });
    expect(exchangeCode).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        clientId: "client",
        clientSecret: "private",
        codeVerifier: expect.any(String),
      }),
      redirect,
      "valid-code",
    );
    await expect(fetch(redirect)).rejects.toThrow();
  });
  it("cleans up when authorization times out", async () => {
    const redirect = await redirectUri();
    const exchangeCode = vi.fn();
    const descriptor: ProviderSetupDescriptor = {
      kind: "gmail",
      label: "Gmail",
      fields: [],
      oauth: {
        scopes: [],
        buildAuthUrl: () => "https://auth.example",
        exchangeCode,
      },
    };
    await expect(
      authorizeOAuth(
        descriptor,
        {},
        { redirectUri: redirect, timeoutMs: 10, onAuthUrl: () => {} },
      ),
    ).rejects.toMatchObject({ code: "OAUTH_TIMEOUT" });
    expect(exchangeCode).not.toHaveBeenCalled();
    await expect(fetch(redirect)).rejects.toThrow();
  });
});
