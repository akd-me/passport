import type { IncomingMessage } from "node:http";
import type { Context, Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { Backend } from "../backend.js";
import { ApiError } from "../errors.js";
import { object } from "../validation.js";
import { browserOAuth, oauthCookie } from "../onboarding/oauth.js";
import { parseSetupInput, SetupTaskRunner, type SetupRunnerOptions } from "./runner.js";

const runners = new WeakMap<object, SetupTaskRunner>();

/** The backend's setup-task runner, created on first use. */
export function setupTasks(backend: Backend, overrides: Partial<SetupRunnerOptions> = {}): SetupTaskRunner {
  let runner = runners.get(backend);
  if (!runner) {
    runner = new SetupTaskRunner({
      mode: backend.mode,
      dataDir: backend.config.dataDir,
      bus: backend.bus,
      oauth: browserOAuth(backend),
      listAccounts: () => backend.store.accounts.list(),
      ...overrides,
    });
    runners.set(backend, runner);
  }
  return runner;
}

/** Cancel running setup tasks (and their browsers) before the backend closes. */
export function attachSetupTasks<T extends Backend>(backend: T): T {
  const close = backend.close.bind(backend);
  Object.assign(backend, {
    close: async () => {
      try { await runners.get(backend)?.close(); }
      finally { await close(); }
    },
  });
  return backend;
}

/**
 * The origin the setup agent's browser uses for Passport: this server's own loopback
 * listener. Not the request Host, which may be a development proxy that does not forward
 * `/oauth/*`.
 */
function serverOrigin(c: Context, backend: Backend): string {
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  const port = incoming?.socket.localPort ?? backend.config.port;
  const host = ["::1", "[::1]"].includes(backend.config.host) ? "[::1]" : "127.0.0.1";
  return `http://${host}:${port}`;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try { return object(await request.json()); }
  catch { throw new ApiError("INVALID_JSON", "Expected a JSON object"); }
}

export function registerSetup(app: Hono, backend: Backend): void {
  const runner = () => setupTasks(backend);
  app.post("/api/setup/tasks", async c => {
    const task = runner().start(parseSetupInput(await body(c.req.raw)), serverOrigin(c, backend));
    return c.json({ id: task.id }, 201);
  });
  app.get("/api/setup/tasks", c => c.json(runner().list()));
  app.get("/api/setup/tasks/:id", c => c.json(runner().get(c.req.param("id"))));
  app.post("/api/setup/tasks/:id/respond", async c => {
    const input = await body(c.req.raw);
    return c.json(runner().respond(c.req.param("id"), input.promptId, input.answer));
  });
  app.post("/api/setup/tasks/:id/cancel", c => c.json(runner().cancel(c.req.param("id"))));
  // Opened by the setup agent's browser: binds this browser to the OAuth attempt the way the
  // Accounts page does, then forwards to the provider's consent page.
  app.get("/oauth/setup/:ticket", c => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const launch = runner().launch(c.req.param("ticket"));
    if (!launch) return c.text("This setup link has expired or was already used. Return to Passport.", 404);
    setCookie(c, oauthCookie(launch.state), launch.nonce, { path: "/", httpOnly: true, sameSite: "Lax", maxAge: 600 });
    return c.redirect(launch.authUrl, 302);
  });
}
