import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AccountCredentials, ProviderSetupDescriptor } from "@passport/types";
import { ApiError } from "./errors.js";

/** One-shot loopback OAuth flow. Temporary state/PKCE data never enters account settings. */
export async function authorizeOAuth(
  descriptor: ProviderSetupDescriptor,
  fields: Record<string, string>,
  options: {
    redirectUri?: string;
    timeoutMs?: number;
    onAuthUrl: (url: string, redirectUri: string) => void;
  },
): Promise<AccountCredentials> {
  if (!descriptor.oauth) {
    throw new ApiError("OAUTH_UNSUPPORTED", "Provider does not use OAuth");
  }
  const redirect = new URL(options.redirectUri ?? "http://127.0.0.1:53682/oauth/callback");
  if (
    redirect.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(redirect.hostname) ||
    !redirect.port ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash
  ) {
    throw new ApiError(
      "INVALID_REDIRECT",
      "OAuth redirect must be an HTTP loopback URL with an explicit port",
    );
  }
  const state = randomBytes(32).toString("base64url");
  const settings = {
    ...fields,
    codeVerifier: randomBytes(48).toString("base64url"),
  };
  let settle!: (code: string) => void, fail!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", redirect.origin);
    if (request.method !== "GET" || url.pathname !== redirect.pathname) {
      response.writeHead(404).end();
      return;
    }
    if (url.searchParams.get("state") !== state) {
      response.writeHead(400).end("Invalid OAuth state.");
      return;
    }
    if (url.searchParams.has("error") || !url.searchParams.get("code")) {
      response.writeHead(400).end("Authorization was not completed.");
      fail(new ApiError("OAUTH_DENIED", "Provider authorization was not completed"));
      return;
    }
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("Passport authorization received. You can return to the terminal.");
    settle(url.searchParams.get("code")!);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(redirect.port), redirect.hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const timeout = setTimeout(
    () => fail(new ApiError("OAUTH_TIMEOUT", "OAuth authorization timed out")),
    options.timeoutMs ?? 300000,
  );
  const interrupt = () => fail(new ApiError("OAUTH_CANCELLED", "OAuth authorization cancelled"));
  process.once("SIGINT", interrupt);
  try {
    options.onAuthUrl(descriptor.oauth.buildAuthUrl(settings, redirect.href, state), redirect.href);
    return await descriptor.oauth.exchangeCode(settings, redirect.href, await code);
  } finally {
    clearTimeout(timeout);
    process.off("SIGINT", interrupt);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
