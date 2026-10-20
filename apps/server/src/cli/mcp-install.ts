import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { loadMcpToken } from "../mcp-token.js";

type Client = "claude-code" | "codex" | "cursor" | "claude-desktop";
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (message: string): never => { throw new ApiError("MCP_INSTALL", message); };
const connectionKeys = new Set(["command", "args", "url", "type", "headers", "http_headers", "env_http_headers", "bearer_token_env_var"]);

/** Lossless statement splitter for TOML tables/values, including multiline strings and arrays. */
function tomlStatements(source: string): string[] {
  const result: string[] = [];
  let start = 0, quote = "", triple = false, depth = 0, comment = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (comment && char !== "\n") continue;
    if (quote) {
      if (quote === '"' && char === "\\") { i++; continue; }
      if (char === quote && (!triple || source.slice(i, i + 3) === quote.repeat(3))) {
        if (triple) i += 2;
        quote = ""; triple = false;
      }
    } else if (char === "#") comment = true;
    else if (char === '"' || char === "'") {
      quote = char; triple = source.slice(i, i + 3) === char.repeat(3); if (triple) i += 2;
    } else if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth--;
    if (char === "\n") {
      comment = false;
      if (!quote && depth === 0) { result.push(source.slice(start, i + 1)); start = i + 1; }
    }
    if (depth < 0) invalid("Invalid TOML; config was not changed.");
  }
  if (quote || depth !== 0) invalid("Unterminated TOML value; config was not changed.");
  if (start < source.length) result.push(source.slice(start));
  return result;
}

/** Replace only Passport's connection fields, retaining other tables, comments and tool settings. */
export function mergeCodexConfig(source: string, fields: string[]): string {
  let inPassport = false, skipHeaders = false, found = false, inserted = false;
  const output: string[] = [];
  const insert = () => { if (inPassport && !inserted) { output.push(`\n${fields.join("\n")}\n`); inserted = true; } };
  for (const statement of tomlStatements(source)) {
    const header = /^\s*(\[\[?)([^\]\n]+)\]\]?\s*(?:#[^\n]*)?\s*$/.exec(statement);
    if (statement.trimStart().startsWith("[") && !header) invalid("Unsupported TOML table syntax; config was not changed.");
    if (header) {
      insert();
      const path = header[2]!.split(".").map(key => key.trim().replace(/^["']|["']$/g, ""));
      inPassport = header[1] === "[" && path.length === 2 && path[0] === "mcp_servers" && path[1] === "passport";
      skipHeaders = path.length >= 3 && path[0] === "mcp_servers" && path[1] === "passport" && ["http_headers", "env_http_headers"].includes(path[2]!);
      if (inPassport) {
        if (found) invalid("Duplicate Passport TOML table; config was not changed.");
        found = true;
      }
      if (!skipHeaders) output.push(statement);
      continue;
    }
    if (skipHeaders) continue;
    const key = /^\s*([A-Za-z0-9_.-]+|"[^"]+"|'[^']+')\s*=/.exec(statement)?.[1]?.replace(/^["']|["']$/g, "");
    if (key === "mcp_servers" || key?.startsWith("mcp_servers.passport") || key === "passport" && !inPassport) invalid("Use [mcp_servers.passport] tables instead of inline/dotted Passport TOML configuration; config was not changed.");
    if (inPassport && key && connectionKeys.has(key)) continue;
    output.push(statement);
  }
  insert();
  if (!found) output.push(`${source && !source.endsWith("\n") ? "\n" : ""}\n[mcp_servers.passport]\n${fields.join("\n")}\n`);
  return output.join("");
}

function mergeJson(source: string, connection: JsonObject): string {
  const config: unknown = source.trim() ? JSON.parse(source) : {};
  if (!object(config) || config.mcpServers !== undefined && !object(config.mcpServers)) invalid("Config and mcpServers must be JSON objects; config was not changed.");
  const root = config as JsonObject;
  const servers = (root.mcpServers ?? {}) as JsonObject;
  if (servers.passport !== undefined && !object(servers.passport)) invalid("Passport config must be an object; config was not changed.");
  const previous = (servers.passport ?? {}) as JsonObject;
  const keep = Object.fromEntries(Object.entries(previous).filter(([key]) => !connectionKeys.has(key)));
  const headers = object(connection.headers) ? { ...(object(previous.headers) ? previous.headers : {}), ...connection.headers } : undefined;
  const env = object(connection.env) ? { ...(object(previous.env) ? previous.env : {}), ...connection.env } : undefined;
  return `${JSON.stringify({ ...root, mcpServers: { ...servers, passport: { ...keep, ...connection, ...(headers ? { headers } : {}), ...(env ? { env } : {}) } } }, null, 2)}\n`;
}

function httpUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { return invalid("MCP URL must be an absolute HTTP URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid("MCP URL must use HTTP(S) without credentials, query or fragment.");
  return url;
}

export interface InstallOptions {
  cwd?: string; home?: string; nodePath?: string; entryPath?: string; platform?: string;
  /** Injectable for tests; command defaults to the normal Passport config directory. */
  dataDir?: string; httpUrl?: string;
}

/** Plan, back up and atomically merge an MCP client config. Dry runs never create files. */
export async function installMcp(args: string[], options: InstallOptions = {}): Promise<{ path: string; content: string; dryRun: boolean; backup?: string }> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (["--http", "--dry-run", "--user"].includes(arg)) flags.set(arg, "true");
    else if (["--client", "--url"].includes(arg) && args[i + 1] && !args[i + 1]!.startsWith("--")) flags.set(arg, args[++i]!);
    else invalid(`Unknown or incomplete option: ${arg}`);
  }
  const client = flags.get("--client") as Client;
  if (!["claude-code", "codex", "cursor", "claude-desktop"].includes(client)) invalid("Use --client claude-code|codex|cursor|claude-desktop.");
  if (flags.has("--user") && client !== "claude-code") invalid("--user is only supported for claude-code.");
  if (flags.has("--url") && !flags.has("--http")) invalid("--url requires --http.");
  const cwd = options.cwd ?? process.cwd(), home = options.home ?? homedir();
  const node = options.nodePath ?? process.execPath;
  const entry = options.entryPath ?? fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../dist/cli.js" : "../cli.js", import.meta.url));
  if (!isAbsolute(node) || !isAbsolute(entry)) invalid("Node and server entry paths must be absolute.");
  const dryRun = flags.has("--dry-run"), http = flags.has("--http");
  if (client === "claude-desktop" && (options.platform ?? process.platform) !== "darwin") invalid("Claude Desktop config installation currently supports macOS.");
  const path = client === "codex" ? join(home, ".codex", "config.toml")
    : client === "cursor" ? join(home, ".cursor", "mcp.json")
      : client === "claude-desktop" ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : flags.has("--user") ? join(home, ".claude.json") : join(cwd, ".mcp.json");
  let before = "", exists = true;
  try { before = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; exists = false; }
  let token: string | undefined;
  let url: string | undefined;
  if (http) {
    const config = options.dataDir ? undefined : await loadConfig();
    url = httpUrl(flags.get("--url") ?? options.httpUrl ?? process.env.PASSPORT_MCP_URL ?? `http://127.0.0.1:${config?.mcpPort ?? 4318}/mcp`).href;
    token = await loadMcpToken(options.dataDir ?? config!.dataDir, { create: !dryRun });
  }
  const argsList = [entry, "mcp"];
  // Desktop's local JSON configuration supports stdio; bridge HTTP without another dependency.
  const connection: JsonObject = http && client !== "claude-desktop"
    ? { ...(client === "claude-code" ? { type: "http" } : {}), url, headers: { Authorization: `Bearer ${token}` } }
    : { ...(client === "claude-code" ? { type: "stdio" } : {}), command: node,
      args: http ? [...argsList, "proxy", "--url", url!] : argsList,
      ...(http ? { env: { PASSPORT_MCP_TOKEN: token } } : {}) };
  const content = client === "codex" ? mergeCodexConfig(before, http
    ? [`url = ${JSON.stringify(url)}`, `http_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }`]
    : [`command = ${JSON.stringify(node)}`, `args = ${JSON.stringify(argsList)}`]) : mergeJson(before, connection);
  let backup: string | undefined;
  if (!dryRun) {
    await mkdir(dirname(path), { recursive: true });
    if (exists) { backup = `${path}.bak-${Date.now()}-${randomUUID()}`; await copyFile(path, backup, constants.COPYFILE_EXCL); }
    const temp = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, content, { mode: 0o600, flag: "wx" }); await rename(temp, path); }
    finally { await rm(temp, { force: true }); }
  }
  const visible = token ? content.split(token).join("<redacted>") : content;
  const result = { path, content: visible, dryRun, ...(backup ? { backup } : {}) };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function proxy(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "--url") invalid("Use passport mcp proxy --url <http-url>.");
  const config = await loadConfig();
  const token = await loadMcpToken(config.dataDir);
  const remote = new StreamableHTTPClientTransport(httpUrl(args[1]!), { requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: "error" } });
  const local = new StdioServerTransport();
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await remote.close(); await local.close(); };
  const fail = () => { console.error("Passport MCP HTTP bridge failed."); process.exitCode = 1; void close(); };
  let queue = Promise.resolve();
  local.onmessage = message => { queue = queue.then(() => remote.send(message)).catch(fail); };
  remote.onmessage = message => {
    if ("result" in message && typeof message.result.protocolVersion === "string") remote.setProtocolVersion(message.result.protocolVersion);
    void local.send(message).catch(fail);
  };
  local.onerror = remote.onerror = fail;
  local.onclose = remote.onclose = () => { void close(); };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  process.stdin.once("end", () => { void close(); });
  await remote.start(); await local.start();
}

/** One-line CLI hook runs before backend construction, so install requires no mailbox/LLM. */
export async function handleMcpCommand(args: string[]): Promise<void> {
  if (args[1] === "install") { await installMcp(args.slice(2)); return; }
  if (args[1] === "proxy") { await proxy(args.slice(2)); return; }
  invalid("Use passport mcp install or passport mcp proxy.");
}
