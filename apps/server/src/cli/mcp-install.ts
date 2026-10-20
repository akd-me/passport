import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
const sensitive = /authorization|token|secret|key|password/i;
/** Apply to decoded JSON values, TOML strings/comments and displayed file paths. */
function redactString(source: string): string {
  return source
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>\\]+/gi, raw => {
      try {
        const url = new URL(raw);
        if (url.username || url.password) { url.username = "<redacted>"; url.password = ""; }
        for (const name of new Set(url.searchParams.keys())) url.searchParams.set(name, "<redacted>");
        if (url.hash) url.hash = "<redacted>";
        return url.href;
      } catch { return "<redacted-url>"; }
    })
    .replace(/((?:--)?(?:api[-_]?key|token|key|secret)\s*=\s*|Bearer\s+)[^\s"'<>\\,;&]+/gi, "$1<redacted>")
    // Treat path separators as boundaries; a complete slash-prefixed base64
    // value is still redacted. UUID backup names are not contiguous hex/base64.
    .replace(/[A-Za-z0-9+_]{32,}={0,2}|(?<![\w/])[A-Za-z0-9+][A-Za-z0-9+/]{31,}={0,2}|(?<![\w/])\/[A-Za-z0-9+/]{31,}={0,2}(?=$|[\s"'\\])/g, "<redacted>");
}
function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (typeof value === "string") return redactString(value);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [redactString(key), sensitive.test(key)
    ? typeof child === "string" && /^Bearer\s/i.test(child) ? "Bearer <redacted>" : "<redacted>"
    : redactJson(child)]));
}
function quotedEnd(source: string, start: number): number {
  const quote = source[start]!, triple = source.slice(start, start + 3) === quote.repeat(3);
  for (let i = start + (triple ? 3 : 1); i < source.length; i++) {
    if (quote === '"' && source[i] === "\\") { i++; continue; }
    if (source[i] === quote && (!triple || source.slice(i, i + 3) === quote.repeat(3))) return i + (triple ? 3 : 1);
  }
  return source.length;
}
function valueEnd(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (char === '"' || char === "'") { i = quotedEnd(source, i) - 1; continue; }
    if (depth === 0 && [",", "}", "]", "\n"].includes(char!)) return i;
    if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth--;
  }
  return source.length;
}
/** Scan assignments outside string values, preserving nested inline TOML tables. */
function redactAssignments(source: string): string {
  let output = "";
  for (let i = 0; i < source.length;) {
    const assignment = /^("(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*/.exec(source.slice(i));
    if (assignment) {
      let key = assignment[1]!;
      if (key.startsWith('"')) key = JSON.parse(key);
      output += assignment[0];
      i += assignment[0].length;
      if (sensitive.test(key)) {
        const end = valueEnd(source, i), value = source.slice(i, end);
        output += /^["']Bearer\s/i.test(value) ? '"Bearer <redacted>"' : '"<redacted>"';
        i = end;
      }
    } else if (source[i] === '"' || source[i] === "'") {
      const end = quotedEnd(source, i);
      output += source.slice(i, end); i = end;
    } else { output += source[i]; i++; }
  }
  return output;
}
function redactToml(source: string): string {
  let secretTable = false;
  return tomlStatements(source).map(statement => {
    if (/^\s*\[/.test(statement)) {
      secretTable = sensitive.test(statement);
      return statement;
    }
    const assignment = /^(\s*(?:[A-Za-z0-9_.-]+|"[^"]+"|'[^']+')\s*=)([\s\S]*)$/.exec(statement);
    if (!assignment) return statement;
    if (secretTable) return `${assignment[1]} "<redacted>"\n`;
    return redactAssignments(statement);
  }).join("");
}

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
  const envField = fields.find(field => field.startsWith("env.PASSPORT_DATA_DIR = "));
  const envValue = envField?.slice("env.PASSPORT_DATA_DIR = ".length);
  const table = (statement: string) => /^\s*\[([^\]\n]+)\]/.exec(statement)?.[1]?.split(".").map(key => key.trim().replace(/^["']|["']$/g, "")).join(".");
  const hasEnvTable = tomlStatements(source).some(statement => table(statement) === "mcp_servers.passport.env");
  let section = "";
  const hasInlineEnv = tomlStatements(source).some(statement => {
    if (statement.trimStart().startsWith("[")) section = table(statement) ?? "";
    return section === "mcp_servers.passport" && /^\s*env\s*=/.test(statement);
  });
  if (envField && (hasEnvTable || hasInlineEnv)) fields = fields.filter(field => field !== envField);
  let inPassport = false, skipHeaders = false, found = false, inserted = false;
  let inEnv = false;
  const output: string[] = [];
  const insert = () => { if (inPassport && !inserted) { output.push(`\n${fields.join("\n")}\n`); inserted = true; } };
  for (const statement of tomlStatements(source)) {
    const header = /^\s*(\[\[?)([^\]\n]+)\]\]?\s*(?:#[^\n]*)?\s*$/.exec(statement);
    if (statement.trimStart().startsWith("[") && !header) invalid("Unsupported TOML table syntax; config was not changed.");
    if (header) {
      insert();
      const path = header[2]!.split(".").map(key => key.trim().replace(/^["']|["']$/g, ""));
      inPassport = header[1] === "[" && path.length === 2 && path[0] === "mcp_servers" && path[1] === "passport";
      inEnv = path.join(".") === "mcp_servers.passport.env";
      skipHeaders = path.length >= 3 && path[0] === "mcp_servers" && path[1] === "passport" && ["http_headers", "env_http_headers"].includes(path[2]!);
      if (inPassport) {
        if (found) invalid("Duplicate Passport TOML table; config was not changed.");
        found = true;
      }
      if (!skipHeaders) output.push(statement);
      if (inEnv && envValue) output.push(`PASSPORT_DATA_DIR = ${envValue}\n`);
      continue;
    }
    if (skipHeaders) continue;
    const key = /^\s*([A-Za-z0-9_.-]+|"[^"]+"|'[^']+')\s*=/.exec(statement)?.[1]?.replace(/^["']|["']$/g, "");
    if (key === "mcp_servers" || key?.startsWith("mcp_servers.passport") || key === "passport" && !inPassport) invalid("Use [mcp_servers.passport] tables instead of inline/dotted Passport TOML configuration; config was not changed.");
    if (inPassport && key && connectionKeys.has(key)) continue;
    if (envValue && (inEnv && key === "PASSPORT_DATA_DIR" || inPassport && key === "env.PASSPORT_DATA_DIR")) continue;
    if (envValue && inPassport && key === "env") {
      const match = /^(\s*env\s*=\s*\{)([\s\S]*)(\}\s*(?:#[^\n]*)?\s*)$/.exec(statement);
      if (!match) invalid("Use an inline env table or [mcp_servers.passport.env]; config was not changed.");
      const body = match![2]!.replace(/(?:^|,)\s*(?:PASSPORT_DATA_DIR|"PASSPORT_DATA_DIR"|'PASSPORT_DATA_DIR')\s*=\s*(?:"(?:\\.|[^"\\])*"|'[^']*')\s*(?=,|$)/g, "").trim().replace(/^,|,$/g, "");
      output.push(`${match![1]}${body}${body ? ", " : ""}PASSPORT_DATA_DIR = ${envValue}${match![3]}`);
      continue;
    }
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
  const entry = options.entryPath ?? (import.meta.url.endsWith("/cli.js")
    ? fileURLToPath(import.meta.url) // Bundled distribution: this module is in the CLI entry.
    : fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../dist/cli.js" : "../cli.js", import.meta.url)));
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
  const dataDir = resolve(options.dataDir ?? (await loadConfig()).dataDir);
  const workspaceEnv = dataDir !== resolve(homedir(), ".passport") ? { PASSPORT_DATA_DIR: dataDir } : {};
  // Desktop's local JSON configuration supports stdio; bridge HTTP without another dependency.
  const connection: JsonObject = http && client !== "claude-desktop"
    ? { ...(client === "claude-code" ? { type: "http" } : {}), url, headers: { Authorization: `Bearer ${token}` } }
    : { ...(client === "claude-code" ? { type: "stdio" } : {}), command: node,
      args: http ? [...argsList, "proxy", "--url", url!] : argsList,
      ...(http || Object.keys(workspaceEnv).length ? { env: { ...workspaceEnv, ...(http ? { PASSPORT_MCP_TOKEN: token } : {}) } } : {}) };
  const content = client === "codex" ? mergeCodexConfig(before, http
    ? [`url = ${JSON.stringify(url)}`, `http_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }`]
    : [`command = ${JSON.stringify(node)}`, `args = ${JSON.stringify(argsList)}`,
      ...(Object.keys(workspaceEnv).length ? [`env.PASSPORT_DATA_DIR = ${JSON.stringify(dataDir)}`] : [])]) : mergeJson(before, connection);
  let backup: string | undefined;
  if (!dryRun) {
    await mkdir(dirname(path), { recursive: true });
    if (exists) { backup = `${path}.bak-${Date.now()}-${randomUUID()}`; await copyFile(path, backup, constants.COPYFILE_EXCL); }
    const temp = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, content, { mode: 0o600, flag: "wx" }); await rename(temp, path); }
    finally { await rm(temp, { force: true }); }
  }
  const redacted = client === "codex" ? redactString(redactToml(content)) : JSON.stringify(redactJson(JSON.parse(content)), null, 2) + "\n";
  const visible = token ? redacted.split(token).join("<redacted>") : redacted;
  const result = { path, content: visible, dryRun, ...(backup ? { backup } : {}) };
  console.log(JSON.stringify({ ...result, path: redactString(path), ...(backup ? { backup: redactString(backup) } : {}) }, null, 2));
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
