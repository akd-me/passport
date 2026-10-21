import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { installActionsRoutes } from "./actions-routes.js";
import { installAgentRoutes } from "./agent-routes.js";
import { getAuth, installAuth, type PassportAuth } from "./auth.js";
import type { Backend } from "./backend.js";
import { ApiError } from "./errors.js";
import { installLlmRoutes } from "./llm-routes.js";
import { logger } from "./logger.js";
import { installMailRoutes } from "./mail-routes.js";
import { installMattersRoutes } from "./matters-routes.js";
import { registerOnboarding } from "./onboarding/routes.js";
import { installJobRoutes } from "./schedulers/routes.js";
import { installSettingsRoutes } from "./settings-routes.js";
import { registerSetup } from "./setup/routes.js";

export function createApp(
  backend: Backend,
  options: { staticDir?: string; auth?: PassportAuth } = {},
) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    if (error instanceof HTTPException) {
      return c.json({ error: { code: "HTTP_ERROR", message: error.message } }, error.status);
    }
    const code =
      typeof (error as { code?: unknown }).code === "string"
        ? (error as unknown as { code: string }).code
        : "INTERNAL_ERROR";
    // Do not return or log provider error text; it may contain credential-bearing URLs.
    logger.error(`Request failed (${code})`);
    return c.json(
      {
        error: {
          code,
          message: "The operation failed. Check your provider connection and retry.",
        },
      },
      500,
    );
  });
  installAuth(app, options.auth ?? getAuth(backend));
  installJobRoutes(app, backend);
  registerOnboarding(app, backend);
  registerSetup(app, backend);
  installLlmRoutes(app, backend);
  app.get("/api/health", (c) => c.json({ ok: true, mode: backend.mode }));
  installActionsRoutes(app, backend);

  installMailRoutes(app, backend);

  installMattersRoutes(app, backend);

  installSettingsRoutes(app, backend);

  installAgentRoutes(app, backend);

  app.all("/api/*", (c) =>
    c.json({ error: { code: "NOT_FOUND", message: "Unknown API route" } }, 404),
  );
  const staticDir = options.staticDir ?? fileURLToPath(new URL("../../web/dist/", import.meta.url));
  if (existsSync(`${staticDir}/index.html`)) {
    app.use("*", serveStatic({ root: staticDir }));
    app.get("*", serveStatic({ path: `${staticDir}/index.html` }));
  } else {
    app.get("/", (c) =>
      c.text("Passport API is running. Build @passport/web or start its Vite dev server."),
    );
  }
  return app;
}
