import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { HostAgentMcpServer } from "@passport/types";
import { logger } from "../logger.js";

/** Pinned so a Playwright MCP release cannot change the agent's tools under us. */
export const PLAYWRIGHT_MCP_PACKAGE = "@playwright/mcp@0.0.83";

export type SetupBrowser = "chrome" | "msedge" | "chromium";

export interface BrowserDetectOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  list?: (dir: string) => string[];
}

function installs(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Record<Exclude<SetupBrowser, "chromium">, string[]> {
  const home = env.HOME || homedir();
  if (platform === "darwin") {
    return {
      chrome: [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      ],
      msedge: [
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        join(home, "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
      ],
    };
  }
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
      (root): root is string => !!root,
    );
    return {
      chrome: roots.map((root) => join(root, "Google", "Chrome", "Application", "chrome.exe")),
      msedge: roots.map((root) => join(root, "Microsoft", "Edge", "Application", "msedge.exe")),
    };
  }
  return {
    chrome: [
      "/opt/google/chrome/chrome",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
    ],
    msedge: [
      "/opt/microsoft/msedge/msedge",
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
    ],
  };
}

/** Where Playwright installs its own browsers. */
function playwrightCache(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0") {
    return env.PLAYWRIGHT_BROWSERS_PATH;
  }
  const home = env.HOME || homedir();
  if (platform === "darwin") {
    return join(home, "Library", "Caches", "ms-playwright");
  }
  if (platform === "win32") {
    return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "ms-playwright");
  }
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "ms-playwright");
}

/**
 * The user's installed Chrome, then Edge (no download, a familiar window), then a Playwright
 * Chromium. Null when none exists.
 */
export function detectSetupBrowser(options: BrowserDetectOptions = {}): SetupBrowser | null {
  const platform = options.platform ?? process.platform,
    env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const list =
    options.list ??
    ((dir: string) => {
      try {
        return readdirSync(dir);
      } catch {
        // Browser process discovery failed; using an empty process list.
        logger.warn("Browser process discovery failed; using an empty process list");

        return [];
      }
    });
  const known = installs(platform, env);
  for (const browser of ["chrome", "msedge"] as const) {
    if (known[browser].some(exists)) {
      return browser;
    }
  }
  return list(playwrightCache(platform, env)).some((name) => /^chromium-\d+$/.test(name))
    ? "chromium"
    : null;
}

export const NO_BROWSER_MESSAGE = `No supported browser found. Install Google Chrome or Microsoft Edge, or run \`npx -y ${PLAYWRIGHT_MCP_PACKAGE} install-browser chrome-for-testing\` (Playwright's Chromium), then start setup again.`;

/** `npx` next to the running Node, so the CLI's MCP launcher does not depend on its own PATH. */
function npxCommand(
  platform: NodeJS.Platform = process.platform,
  execPath = process.execPath,
): string {
  const local = join(dirname(execPath), platform === "win32" ? "npx.cmd" : "npx");
  return existsSync(local) ? local : platform === "win32" ? "npx.cmd" : "npx";
}

export interface BrowserMcpOptions {
  browser: SetupBrowser;
  /** Persistent profile, so a Google/Microsoft sign-in survives between setup tasks. */
  profileDir: string;
  /** Screenshots and downloads. */
  outputDir: string;
}

/**
 * The browser MCP server handed to the setup agent: Playwright MCP over stdio, headed, on a
 * persistent profile. Change the browser integration here only.
 */
export function browserMcpServer(options: BrowserMcpOptions): HostAgentMcpServer {
  const node = dirname(process.execPath);
  const path = [node, ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)].filter(
    (dir, index, all) => all.indexOf(dir) === index,
  );
  return {
    command: npxCommand(),
    args: [
      "-y",
      PLAYWRIGHT_MCP_PACKAGE,
      "--browser",
      options.browser,
      "--user-data-dir",
      options.profileDir,
      "--output-dir",
      options.outputDir,
      "--viewport-size",
      "1280x860",
    ],
    // npx needs Node on PATH and a home for its cache; neither is a secret.
    env: { PATH: path.join(delimiter), ...(process.env.HOME ? { HOME: process.env.HOME } : {}) },
    // The first start may download Playwright; tasks also warm the cache beforehand.
    timeouts: { startupSec: 180 },
  };
}

/** Download (or verify) the pinned Playwright MCP before the agent's CLI starts it. */
export function prepareBrowserMcp(
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      npxCommand(),
      ["-y", PLAYWRIGHT_MCP_PACKAGE, "--version"],
      {
        timeout: options.timeoutMs ?? 180_000,
        signal: options.signal,
        windowsHide: true,
        env: {
          ...process.env,
          PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
        },
      },
      (error) => (error ? reject(new Error("BROWSER_HELPER_UNAVAILABLE")) : resolve()),
    );
  });
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Stop every process still using the setup profile (the browser and its Playwright helper).
 * Cancelling the CLI's process group normally does this; a browser that outlived it would
 * otherwise keep the profile locked for the next task.
 */
export function closeSetupBrowser(profileDir: string): Promise<void> {
  if (process.platform === "win32") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile(
      "pkill",
      ["-f", `user-data-dir[= ]${escapeRegex(profileDir)}`],
      { timeout: 5000 },
      () => resolve(),
    );
  });
}
