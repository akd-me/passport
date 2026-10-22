import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Hono } from "hono";
import type { Backend } from "./backend.js";
import { AUTO_FALLBACK, type ConfigWithFallback, type PassportConfig } from "./config.js";
import { ApiError } from "./errors.js";
import { hostAgents, resolveLlmSelection } from "./llm-selection.js";
import { jsonBody } from "./route-input.js";
import {
  applyHostAgentPaths,
  hostAgentPathSettings,
  hydrateShellEnvironment,
  pathState,
} from "./shell-env.js";
import { string } from "./validation.js";

const FIELDS = ["claudePath", "codexPath"] as const;

function binaryPath(value: unknown, name: string): string | undefined {
  if (value === null) {
    return undefined;
  }
  const text = string(value, name).trim();
  if (!text) {
    return undefined;
  }
  const path = text === "~" || text.startsWith("~/") ? join(homedir(), text.slice(1)) : text;
  if (!isAbsolute(path)) {
    throw new ApiError("INVALID_FIELD", `${name} must be an absolute path`);
  }
  return path;
}

/** In `auto` selection, switch to an agent that became ready (or away from one that left). */
async function reselect(backend: Backend): Promise<void> {
  const current = backend.config as ConfigWithFallback;
  if (backend.mode === "demo" || (current.llmSelection ?? "auto") !== "auto") {
    return;
  }
  const next = { ...current } as ConfigWithFallback;
  await resolveLlmSelection(next);
  if (next.llm.provider === current.llm.provider && next.llm.model === current.llm.model) {
    return;
  }
  await backend.updateConfig({
    llm: next.llm,
    llmSelection: "auto",
    [AUTO_FALLBACK]: next[AUTO_FALLBACK],
  } as Partial<PassportConfig>);
}

/**
 * Settings → Model → Agent programs. `GET` returns where PATH came from, the configured and
 * environment binary paths, and detection; `PUT` saves `hostAgents.claudePath`/`codexPath`
 * (null or "" clears); `POST …/redetect` re-reads the login shell, then re-detects.
 */
export function installHostAgentRoutes(app: Hono, backend: Backend): void {
  const view = async (refresh = false) => ({
    pathSource: pathState(),
    paths: hostAgentPathSettings(backend.config),
    agents: await hostAgents({ refresh }),
  });
  const redetect = async () => {
    applyHostAgentPaths(backend.config);
    await hostAgents({ refresh: true });
    await reselect(backend);
    return view();
  };
  app.get("/api/settings/host-agents", async (c) =>
    c.json(await view(c.req.query("refresh") === "1")),
  );
  app.put("/api/settings/host-agents", async (c) => {
    const input = await jsonBody(c.req.raw);
    for (const key of Object.keys(input)) {
      if (!(FIELDS as readonly string[]).includes(key)) {
        throw new ApiError("INVALID_FIELD", `Unknown host-agent setting ${key}`);
      }
    }
    const paths: NonNullable<PassportConfig["hostAgents"]> = { ...backend.config.hostAgents };
    for (const key of FIELDS) {
      if (key in input) {
        const value = binaryPath(input[key], key);
        if (value) {
          paths[key] = value;
        } else {
          delete paths[key];
        }
      }
    }
    await backend.updateConfig({ hostAgents: Object.keys(paths).length ? paths : undefined });
    return c.json(await redetect());
  });
  app.post("/api/settings/host-agents/redetect", async (c) => {
    await hydrateShellEnvironment();
    return c.json(await redetect());
  });
}
