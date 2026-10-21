import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/**
 * Variables a host CLI needs to find its login (keychain, config dir), the network, and
 * its own runtime. Everything else, notably `PASSPORT_*` secrets and provider API keys, is
 * withheld: an `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` would silently replace the
 * subscription login with metered API billing.
 */
const FORWARDED = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "__CF_USER_TEXT_ENCODING",
  // Windows equivalents of HOME/TMPDIR and the executable search order.
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "PATHEXT",
  "HOMEDRIVE",
  "HOMEPATH",
];

/** True for variables the host CLI itself receives (see {@link hostAgentEnv}). */
export function isForwardedEnv(key: string): boolean {
  return key === "PATH" || key === "Path" || key === "NO_COLOR" || FORWARDED.includes(key);
}

/** Extra directories searched for host CLIs, after `PATH`. */
export function extraBinDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || homedir();
  return [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

/** Minimal child environment. `binaryPath`'s directory is added so CLIs find their own helpers. */
export function hostAgentEnv(
  source: NodeJS.ProcessEnv = process.env,
  binaryPath?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of FORWARDED) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  const path = (source.PATH ?? source.Path ?? "").split(delimiter).filter(Boolean);
  for (const dir of [...(binaryPath ? [dirname(binaryPath)] : []), ...extraBinDirs(source)])
    if (!path.includes(dir)) path.push(dir);
  env.PATH = path.join(delimiter);
  env.NO_COLOR = "1";
  return env;
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\b(?:Bearer|Basic|token|apikey|api_key|api-key)[\s:="']+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:gh[pousr]|xox[abprs])_?[A-Za-z0-9-]{10,}/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9+_-]{40,}={0,2}/g,
];

/** Remove token-shaped strings and bound length before text reaches an error or log. */
export function redact(text: string, max = 300): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max)}…` : out;
}
