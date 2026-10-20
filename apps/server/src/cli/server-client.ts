import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PassportConfig } from "../config.js";
import { activeOwner } from "../owner-lock.js";
import { ApiError } from "../errors.js";

/** Never turn a reachable server's auth/error response into a second local writer. */
export async function serverClient(config: PassportConfig) {
  let token = process.env.PASSPORT_API_TOKEN;
  if (!token) {
    try { token = (await readFile(join(config.dataDir, "api-token"), "utf8")).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const host = ["0.0.0.0", "::"].includes(config.host) ? "127.0.0.1" : config.host;
  const base = `http://${host.includes(":") ? `[${host}]` : host}:${config.port}`;
  const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const decode = async (response: Response): Promise<unknown> => {
    if (response.status === 401)
      throw new ApiError("API_UNAUTHORIZED", `Server rejected the API token. Use the server's PASSPORT_DATA_DIR (${config.dataDir}), run passport token, or set PASSPORT_API_TOKEN to its token; remove a stale environment override.`);
    const result = await response.json() as { error?: { code?: string; message?: string } };
    if (!response.ok) throw new ApiError(result.error?.code ?? "REQUEST_FAILED", result.error?.message ?? "Server request failed");
    return result;
  };
  let health: Response;
  try { health = await fetch(`${base}/api/health`, { headers, signal: AbortSignal.timeout(1000) }); }
  catch {
    if (activeOwner(config.dataDir))
      throw new ApiError("SERVER_UNAVAILABLE", "This data directory has a live owner, but its server is unreachable. Wait for startup or stop that process before using local commands.");
    console.error("No running server (owner.lock absent/stale); using the local store without background jobs.");
    return null;
  }
  const info = await decode(health) as { ok?: boolean; mode?: string };
  if (!info.ok || info.mode !== "real") throw new ApiError("WRONG_SERVER", "The configured port is not a persistent Passport server; check PASSPORT_PORT and PASSPORT_DATA_DIR.");
  return async (path: string, method = "GET", body?: unknown) => decode(await fetch(`${base}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(300000),
  }));
}
