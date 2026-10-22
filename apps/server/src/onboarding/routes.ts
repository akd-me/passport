import type { Account } from "@passport/types";
import type { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { addAccount } from "../accounts.js";
import type { Backend } from "../backend.js";
import { probeAccount, runDoctor } from "../doctor.js";
import { ApiError, required } from "../errors.js";
import { publicLlm } from "../llm-selection.js";
import { object } from "../validation.js";
import { inboxCount } from "../watch/status.js";
import { mailWatcher } from "../watch/watcher.js";
import { registerAccountFilters } from "./filters.js";
import { type BrowserOAuth, browserOAuth, oauthCookie } from "./oauth.js";
import { accountSync } from "./sync.js";

async function body(request: Request) {
  try {
    return object(await request.json());
  } catch {
    // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

    throw new ApiError("INVALID_JSON", "Expected a JSON object");
  }
}

export function registerOnboarding(
  app: Hono,
  backend: Backend,
  options: { oauth?: BrowserOAuth } = {},
): void {
  const oauth = options.oauth ?? browserOAuth(backend);
  registerAccountFilters(app, backend);
  app.post("/api/accounts/oauth/start", async (c) => {
    const result = await oauth.start(await body(c.req.raw), new URL(c.req.url).origin);
    setCookie(c, oauthCookie(result.attemptId), result.nonce, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      maxAge: 600,
    });
    const { nonce: _nonce, ...safe } = result;
    return c.json(safe);
  });
  // Opened in the system browser by Passport.app (or any browser without the starting tab's
  // cookies): binds that browser to the attempt as `start` did, then forwards to consent.
  app.get("/oauth/launch/:ticket", (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const launch = oauth.launch(c.req.param("ticket"));
    if (!launch) {
      return c.text("This sign-in link has expired or was already used. Return to Passport.", 404);
    }
    setCookie(c, oauthCookie(launch.state), launch.nonce, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      maxAge: 600,
    });
    return c.redirect(launch.authUrl, 302);
  });
  app.get("/api/accounts/oauth/status/:state", (c) =>
    c.json(oauth.status(c.req.param("state"), getCookie(c, oauthCookie(c.req.param("state"))))),
  );
  app.get("/oauth/callback", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const state = c.req.query("state") ?? "";
    let account: Account;
    try {
      account = await oauth.callback(new URL(c.req.url), getCookie(c, oauthCookie(state)));
    } catch (error) {
      // The setup agent's browser lands here; show a page, not a JSON error.
      if (error instanceof ApiError && error.code === "OAUTH_SETUP_ENDED") {
        return c.text(error.message, 409);
      }
      throw error;
    }
    return c.redirect(`/accounts?connected=${encodeURIComponent(account.id)}`, 303);
  });
  app.get("/api/accounts", async (c) => {
    const accounts = await Promise.all(
      (await backend.store.accounts.list()).map(async (account) => ({
        ...account,
        // Provider inbox total from the last label refresh; Passport keeps no local mirror.
        messageCount: account.capabilities.mail
          ? await inboxCount(backend.store, account.id)
          : null,
        watch: (await backend.watchStatus?.(account)) ?? null,
      })),
    );
    return c.json({
      accounts,
      llm: publicLlm(backend.config),
      mode: backend.mode,
    });
  });
  app.post("/api/accounts/test", async (c) => {
    const input = await body(c.req.raw);
    if (input.kind !== "imap" && input.kind !== "mock") {
      throw new ApiError("INVALID_PROVIDER", "Test an IMAP account, or use mock for offline setup");
    }
    // Reuse descriptor validation against a temporary, non-persisting backend.
    let credentials = {};
    const transient: Backend = {
      ...backend,
      updateConfig: async () => {},
      store: {
        ...backend.store,
        accounts: {
          ...backend.store.accounts,
          upsert: async (account) => account,
          delete: async () => {},
          setCredentials: async (_id, value) => {
            credentials = value;
          },
        },
      },
    };
    const account = await addAccount(transient, input);
    try {
      await probeAccount(backend, account, credentials);
    } catch {
      // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

      throw new ApiError(
        "CONNECTION_FAILED",
        "Connection failed. Check host, port, TLS, username and app password.",
      );
    }
    return c.json({ ok: true });
  });
  app.delete("/api/accounts/:id", async (c) => {
    const id = c.req.param("id"),
      account = required(await backend.store.accounts.get(id), "Account");
    const all = await backend.store.accounts.list();
    const linked = all.filter((a) => a.id === id || a.settings.mailAccountId === id);
    for (const item of linked) {
      await accountSync(backend)?.remove(item.id);
      await mailWatcher(backend)?.remove(item.id);
      await backend.store.accounts.delete(item.id);
      backend.bus.emit({ type: "account.changed", accountId: item.id });
    }
    await backend.updateConfig({
      accounts: await backend.store.accounts.list(),
    });
    return c.json({ ok: true, removed: account.id });
  });
  app.post("/api/accounts/:id/sync", async (c) => {
    const account = required(await backend.store.accounts.get(c.req.param("id")), "Account");
    if (account.settings.reauthorizationRequired) {
      throw new ApiError("REAUTHORIZE_REQUIRED", "Re-authorize this account to resume sync", 409);
    }
    await backend.syncAccount(account.id);
    return c.json({ ok: true });
  });
  let diagnosis: Promise<Awaited<ReturnType<typeof runDoctor>>> | undefined;
  app.get("/api/doctor", async (c) => {
    diagnosis ??= runDoctor(backend).finally(() => {
      diagnosis = undefined;
    });
    return c.json(await diagnosis);
  });
}
