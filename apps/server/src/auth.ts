import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Backend } from "./backend.js";
import { ApiError } from "./errors.js";
import { logger } from "./logger.js";

const COOKIE = "passport_session";
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const fingerprint = (value: string) => createHash("sha256").update(value).digest();
const equal = (a: string, b: string) => timingSafeEqual(fingerprint(a), fingerprint(b));

/** Atomic publication prevents simultaneous first runs from choosing different tokens. */
export function apiToken(
  dataDir: string,
  options: { rotate?: boolean; demo?: boolean; env?: NodeJS.ProcessEnv } = {},
): string {
  const env = options.env ?? process.env;
  if (env.PASSPORT_API_TOKEN) {
    if (options.rotate) {
      throw new ApiError(
        "TOKEN_FROM_ENV",
        "Change PASSPORT_API_TOKEN to rotate an environment token.",
      );
    }
    return env.PASSPORT_API_TOKEN;
  }
  if (options.demo) {
    return randomBytes(32).toString("hex");
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "api-token");
  let missing = false;
  try {
    readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    missing = true;
  }
  if (missing || options.rotate) {
    const temp = `${path}.${randomBytes(16).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, `${randomBytes(32).toString("hex")}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      if (options.rotate) {
        renameSync(temp, path);
      } else {
        try {
          linkSync(temp, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
          }
        }
      }
    } finally {
      rmSync(temp, { force: true });
    }
  }
  chmodSync(path, 0o600);
  const token = readFileSync(path, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new ApiError("INVALID_API_TOKEN", "Invalid api-token file; run passport token --rotate.");
  }
  return token;
}

function authority(value: string): { host: string; port?: string } | undefined {
  const match = /^(\[[a-f\d:]+\]|[a-z\d](?:[a-z\d.-]*[a-z\d])?)(?::(\d{1,5}))?$/i.exec(value);
  if (!match || (match[2] && Number(match[2]) > 65535)) {
    return;
  }
  return { host: match[1]!.toLowerCase(), port: match[2] };
}

export class PassportAuth {
  private readonly allowed: { host: string; port?: string }[];
  private readonly sessions = new Map<string, number>();
  private sessionToken: string;
  private readonly readToken: () => string;
  readonly trustProxy: boolean;
  readonly tokenPath: string;

  constructor(backend: Pick<Backend, "config" | "mode">, env = process.env) {
    const { dataDir } = backend.config;
    const token = apiToken(dataDir, { demo: backend.mode === "demo", env });
    // Re-read durable tokens so CLI rotation also revokes running sessions.
    this.readToken =
      env.PASSPORT_API_TOKEN || backend.mode === "demo"
        ? () => token
        : () => apiToken(dataDir, { env: {} });
    this.sessionToken = token;
    this.tokenPath = join(dataDir, "api-token");
    this.trustProxy = env.PASSPORT_TRUST_PROXY === "1" || env.PASSPORT_TRUST_PROXY === "true";
    this.allowed = [
      "127.0.0.1",
      "localhost",
      "[::1]",
      ...(env.PASSPORT_ALLOWED_HOSTS?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? []),
    ].map((host) => {
      const parsed = authority(host);
      if (!parsed) {
        throw new ApiError(
          "INVALID_ALLOWED_HOST",
          "PASSPORT_ALLOWED_HOSTS must contain hostnames or host:port entries.",
        );
      }
      return parsed;
    });
  }

  get token(): string {
    const token = this.readToken();
    if (!equal(token, this.sessionToken)) {
      this.sessions.clear();
      this.sessionToken = token;
    }
    return token;
  }

  allowsHost(host: string): boolean {
    const parsed = authority(host);
    return (
      !!parsed &&
      this.allowed.some(
        (allowed) =>
          allowed.host === parsed.host && (!allowed.port || allowed.port === parsed.port),
      )
    );
  }

  allowsOrigin(origin: string | undefined): boolean {
    if (origin === undefined) {
      return true;
    }
    try {
      const url = new URL(origin);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        url.origin === origin &&
        this.allowsHost(url.host)
      );
    } catch {
      return false;
    }
  }

  authenticate(headers: Headers, queryToken?: string | null): "bearer" | "cookie" | undefined {
    const token = this.token;
    const authorization = headers.get("authorization");
    // Never silently fall back to cookies when a caller supplies bad credentials.
    if (authorization !== null) {
      return /^Bearer /i.test(authorization) && equal(authorization.slice(7), token)
        ? "bearer"
        : undefined;
    }
    if (queryToken != null) {
      return equal(queryToken, token) ? "bearer" : undefined;
    }
    const session = this.session(headers);
    const expires = session ? this.sessions.get(session) : undefined;
    if (session && expires !== undefined) {
      if (expires > Date.now()) {
        return "cookie";
      }
      this.sessions.delete(session);
    }
    return;
  }

  private session(headers: Headers): string | undefined {
    return headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
  }

  cookie(headers: Headers, url: string, logout = false): string {
    const session = this.session(headers);
    if (logout && session) {
      this.sessions.delete(session);
    }
    const value = logout ? "" : randomBytes(32).toString("hex");
    if (!logout) {
      const now = Date.now();
      for (const [id, expires] of this.sessions) {
        if (expires <= now) {
          this.sessions.delete(id);
        }
      }
      this.sessions.set(value, now + 24 * 60 * 60 * 1000);
    }
    const secure =
      new URL(url).protocol === "https:" ||
      (this.trustProxy && headers.get("x-forwarded-proto") === "https");
    return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}${logout ? "; Max-Age=0" : ""}`;
  }

  upgradeStatus(request: IncomingMessage): 401 | 403 | 404 | 421 | undefined {
    try {
      if (!this.allowsHost(request.headers.host ?? "")) {
        return 421;
      }
      if (!this.allowsOrigin(request.headers.origin)) {
        return 403;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/ws") {
        return 404;
      }
      const headers = new Headers();
      for (const name of ["authorization", "cookie"]) {
        const value = request.headers[name];
        if (typeof value === "string") {
          headers.set(name, value);
        }
      }
      if (!this.authenticate(headers, url.searchParams.get("token"))) {
        return 401;
      }
      return;
    } catch {
      // Upgrade callbacks run outside Hono's error boundary. Fail closed here too.
      return 401;
    }
  }

  loginUrl(host: string, port: number): string {
    // Wildcard bind addresses are not browser destinations or implicitly trusted hosts.
    if (["0.0.0.0", "::", "[::]"].includes(host)) {
      host = "127.0.0.1";
    }
    if (isIP(host) === 6) {
      host = `[${host}]`;
    }
    return `http://${host}:${port}/?token=${encodeURIComponent(this.token)}`;
  }
}

const instances = new WeakMap<Backend, PassportAuth>();
export function getAuth(backend: Backend): PassportAuth {
  let auth = instances.get(backend);
  if (!auth) {
    auth = new PassportAuth(backend);
    instances.set(backend, auth);
  }
  return auth;
}

export function checkBind(host: string, allowRemote = false, env = process.env, warn = true): void {
  const loopback =
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    (isIP(host) === 4 && host.startsWith("127."));
  if (loopback) {
    return;
  }
  if (!env.PASSPORT_API_TOKEN && !allowRemote) {
    throw new ApiError(
      "REMOTE_BIND_REFUSED",
      "Non-loopback bind requires PASSPORT_API_TOKEN or --allow-remote.",
    );
  }
  if (warn) {
    logger.warn(
      "WARNING: Passport is exposed beyond loopback. Anyone with the token can control your mail. Use HTTPS and restrict network access.",
    );
  }
}

/** Install before every route, including hooks added by other server features. */
export function installAuth(app: Hono, auth: PassportAuth): void {
  app.use("*", async (c, next) => {
    const api = c.req.path === "/api" || c.req.path.startsWith("/api/");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    // UI responses can carry a login redirect or sensitive application state too.
    c.header("Cache-Control", "no-store");
    const fail = (code: string, message: string, status: 401 | 403 | 421) =>
      c.json({ error: { code, message } }, status);
    if (!auth.allowsHost(c.req.header("host") ?? new URL(c.req.url).host)) {
      return fail("INVALID_HOST", "Host is not allowed", 421);
    }
    if (!safeMethods.has(c.req.method) && !auth.allowsOrigin(c.req.header("origin"))) {
      return fail("INVALID_ORIGIN", "Origin is not allowed", 403);
    }
    if (c.req.method === "GET" && c.req.path === "/" && c.req.query("token") !== undefined) {
      if (!auth.allowsOrigin(c.req.header("origin"))) {
        return fail("INVALID_ORIGIN", "Origin is not allowed", 403);
      }
      if (!equal(c.req.query("token")!, auth.token)) {
        return fail("UNAUTHORIZED", "Invalid API token", 401);
      }
      c.header("Set-Cookie", auth.cookie(c.req.raw.headers, c.req.url));
      return c.redirect("/", 303);
    }
    const method = auth.authenticate(c.req.raw.headers);
    const publicAuth =
      (c.req.path === "/api/auth/login" && c.req.method === "POST") ||
      (c.req.path === "/api/auth/status" && ["GET", "HEAD"].includes(c.req.method));
    if (api && !publicAuth) {
      if (!method) {
        return fail("UNAUTHORIZED", "Sign in with your Passport API token", 401);
      }
      if (
        method === "cookie" &&
        !safeMethods.has(c.req.method) &&
        c.req.header("x-requested-with") !== "passport"
      ) {
        return fail("CSRF_REQUIRED", "X-Requested-With: passport is required", 403);
      }
    }
    await next();
  });
  app.get("/api/auth/status", (c) =>
    c.json({
      authenticated: !!auth.authenticate(c.req.raw.headers),
      tokenPath: auth.tokenPath,
    }),
  );
  app.post("/api/auth/login", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_JSON", message: "Expected { token }" } }, 400);
    }
    const token = body && typeof body === "object" && "token" in body ? body.token : undefined;
    if (typeof token !== "string" || !equal(token, auth.token)) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid API token" } }, 401);
    }
    c.header("Set-Cookie", auth.cookie(c.req.raw.headers, c.req.url));
    return c.redirect("/", 303);
  });
  app.post("/api/auth/logout", (c) => {
    c.header("Set-Cookie", auth.cookie(c.req.raw.headers, c.req.url, true));
    return c.json({ authenticated: false });
  });
}
