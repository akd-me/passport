import { randomBytes } from "node:crypto";
import { createApp as unauthenticatedApp } from "./app.js";
import { PassportAuth } from "./auth.js";
import type { Backend } from "./backend.js";

/** Real bearer authentication for route/e2e tests, without touching the user's token. */
export function createApp(
  backend: Backend,
  options: Parameters<typeof unauthenticatedApp>[1] = {},
) {
  const auth =
    options.auth ??
    new PassportAuth(backend, {
      PASSPORT_API_TOKEN: randomBytes(32).toString("hex"),
    });
  const app = unauthenticatedApp(backend, { ...options, auth });
  const request = app.request.bind(app);
  app.request = (input, init, env, executionCtx) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${auth.token}`);
    }
    return request(input, { ...init, headers }, env, executionCtx);
  };
  return app;
}
