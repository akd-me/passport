// Finds a Passport server for a data directory without importing server code. This mirrors
// apps/server/src/owner-lock.ts (activeOwner) and cli/server-client.ts (address, token, health).
import { readFileSync } from "node:fs";
import { join } from "node:path";

const OWNER_STALE_MS = 60_000;

export interface OwnerLease {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  id: string;
}

export interface ServerAddress {
  /** e.g. http://127.0.0.1:3000 */
  origin: string;
  port: number;
}

export type Health = "ok" | "unauthorized" | "wrong-server" | "down";

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    // Missing or malformed files mean "no record", exactly as the server treats them.
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** The live `passport serve`/`demo` lease holder, or null when absent, stale or dead. */
export function activeOwner(dataDir: string): OwnerLease | null {
  const owner = readJson<OwnerLease>(join(dataDir, "owner.lock"));
  const heartbeat = owner ? Date.parse(owner.heartbeatAt) : Number.NaN;
  if (
    !owner ||
    !Number.isInteger(owner.pid) ||
    owner.pid < 1 ||
    !Number.isFinite(heartbeat) ||
    Date.now() - heartbeat >= OWNER_STALE_MS
  ) {
    return null;
  }
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    // ESRCH: the owner died without releasing the lease. EPERM still proves it is alive.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return null;
    }
  }
  return owner;
}

/** Same precedence as loadConfig: environment, then passport.config.json, then defaults. */
export function serverAddress(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ServerAddress {
  const saved = readJson<{ host?: unknown; port?: unknown }>(join(dataDir, "passport.config.json"));
  const configuredHost = env.PASSPORT_HOST || (typeof saved?.host === "string" ? saved.host : "");
  const port = Number(env.PASSPORT_PORT || (typeof saved?.port === "number" ? saved.port : 3000));
  // Wildcard binds are reachable on loopback; anything else is used as configured.
  let host =
    !configuredHost || ["0.0.0.0", "::"].includes(configuredHost) ? "127.0.0.1" : configuredHost;
  if (host.includes(":") && !host.startsWith("[")) {
    host = `[${host}]`;
  }
  return { origin: `http://${host}:${port}`, port };
}

/** PASSPORT_API_TOKEN wins, as in the server; otherwise the 0600 api-token file. */
export function readToken(dataDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.PASSPORT_API_TOKEN) {
    return env.PASSPORT_API_TOKEN;
  }
  try {
    const token = readFileSync(join(dataDir, "api-token"), "utf8").trim();
    return /^[a-f0-9]{64}$/.test(token) ? token : null;
  } catch (error) {
    // The server creates the file on startup; until then there is no token to use.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function health(origin: string, token: string | null): Promise<Health> {
  let response: Response;
  try {
    response = await fetch(`${origin}/api/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // Connection refused or timed out: nothing (yet) answers on this port.
    return "down";
  }
  if (response.status === 401) {
    return "unauthorized";
  }
  try {
    const body = (await response.json()) as { ok?: boolean; mode?: string };
    return response.ok && body.ok && body.mode === "real" ? "ok" : "wrong-server";
  } catch {
    // A non-JSON answer means some other program owns the port.
    return "wrong-server";
  }
}

/** The ?token= login URL: the server swaps it for an HttpOnly session cookie and redirects to /. */
export function loginUrl(origin: string, token: string): string {
  return `${origin}/?token=${encodeURIComponent(token)}`;
}
