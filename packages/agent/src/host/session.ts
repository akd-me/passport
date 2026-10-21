import { mkdir } from "node:fs/promises";
import type {
  HostAgentEvent,
  HostAgentSessionRequest,
  HostAgentSessionResult,
} from "@passport/types";
import { claudeInvocation, createClaudeParser } from "./claude.js";
import { codexInvocation, createCodexParser } from "./codex.js";
import { HOST_AGENT_FIXES, resolveHostAgentBinary } from "./detect.js";
import { hostAgentEnv } from "./env.js";
import { runCli } from "./process.js";
import type { HostRunOutcome, HostRunSpec } from "./types.js";

export interface HostRunEnvironment {
  /** Source environment; only an allowlist reaches the child. */
  env?: NodeJS.ProcessEnv;
  /** Use this binary instead of resolving one. */
  binaryPath?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface HostRunResult extends HostRunOutcome {
  /** Whether the CLI enforced `jsonSchema` itself. */
  schemaEnforced: boolean;
}

const NAMES = { "claude-code": "Claude Code", codex: "Codex" } as const;

function processFailure(
  spec: HostRunSpec,
  result: { timedOut: boolean; aborted: boolean; stderr: string; code: number | null },
): { message: string; code: string } {
  const name = NAMES[spec.kind];
  if (result.aborted) {
    return { code: "HOST_AGENT_CANCELLED", message: `${name} run was cancelled` };
  }
  if (result.timedOut) {
    return { code: "HOST_AGENT_TIMEOUT", message: `${name} did not finish in time` };
  }
  // stderr can echo configuration or tokens; classify it, never forward it.
  if (
    /not logged in|log ?in required|please (log|sign) in|unauthori[sz]ed|authentication|invalid api key|oauth/i.test(
      result.stderr,
    )
  ) {
    return {
      code: "HOST_AGENT_AUTH",
      message: `${name} is not logged in. ${HOST_AGENT_FIXES[spec.kind].login}`,
    };
  }
  if (/unrecognized_model|unknown model|model .*not (found|supported)/i.test(result.stderr)) {
    return { code: "HOST_AGENT_MODEL", message: `${name} rejected the configured model` };
  }
  return {
    code: "HOST_AGENT_FAILED",
    message: `${name} exited unexpectedly (code ${result.code ?? "none"})`,
  };
}

/** One CLI invocation, streamed through the kind's parser. Resolves; never rejects. */
export function runHostAgent(
  spec: HostRunSpec,
  runtime: HostRunEnvironment,
  onEvent: (event: HostAgentEvent) => void = () => {},
): { done: Promise<HostRunResult>; cancel(): void } {
  const controller = new AbortController();
  const signal = runtime.signal
    ? AbortSignal.any([runtime.signal, controller.signal])
    : controller.signal;
  const emit = (event: HostAgentEvent) => {
    try {
      onEvent(event);
    } catch {
      /* a listener failure must not break the run */
    }
  };
  const done = (async (): Promise<HostRunResult> => {
    const source = runtime.env ?? process.env;
    const binary = runtime.binaryPath ?? resolveHostAgentBinary(spec.kind, source);
    if (!binary) {
      return {
        text: "",
        finished: false,
        schemaEnforced: false,
        error: {
          code: "HOST_AGENT_NOT_INSTALLED",
          message: `${NAMES[spec.kind]} is not installed. ${HOST_AGENT_FIXES[spec.kind].install}`,
        },
      };
    }
    if (signal.aborted) {
      return {
        text: "",
        finished: false,
        schemaEnforced: false,
        error: { code: "HOST_AGENT_CANCELLED", message: `${NAMES[spec.kind]} run was cancelled` },
      };
    }
    await mkdir(spec.cwd, { recursive: true, mode: 0o700 });
    const invocation =
      spec.kind === "claude-code" ? await claudeInvocation(spec) : await codexInvocation(spec);
    const parser = spec.kind === "claude-code" ? createClaudeParser() : createCodexParser();
    try {
      const child = runCli({
        binary,
        args: invocation.args,
        input: invocation.input,
        cwd: spec.cwd,
        env: { ...hostAgentEnv(source, binary), ...invocation.env },
        timeoutMs: runtime.timeoutMs,
        signal,
        onLine: (line) => {
          for (const event of parser.push(line)) {
            emit(event);
          }
        },
      });
      let result;
      try {
        result = await child.done;
      } catch {
        return {
          text: "",
          finished: false,
          schemaEnforced: invocation.schemaEnforced,
          error: { code: "HOST_AGENT_SPAWN", message: `${NAMES[spec.kind]} could not be started` },
        };
      }
      const outcome = parser.outcome();
      if (result.aborted || result.timedOut) {
        return {
          ...outcome,
          schemaEnforced: invocation.schemaEnforced,
          error: processFailure(spec, result),
        };
      }
      if (!outcome.error && (!outcome.finished || result.code !== 0)) {
        outcome.error = processFailure(spec, result);
      }
      return { ...outcome, schemaEnforced: invocation.schemaEnforced };
    } finally {
      await invocation.cleanup().catch(() => undefined);
    }
  })().catch((error: unknown): HostRunResult => {
    const code =
      typeof (error as { code?: unknown })?.code === "string" &&
      String((error as { code: string }).code).startsWith("HOST_AGENT")
        ? (error as { code: string }).code
        : "HOST_AGENT_FAILED";
    return {
      text: "",
      finished: false,
      schemaEnforced: false,
      error: {
        code,
        message:
          code === "HOST_AGENT_CONFIG"
            ? (error as Error).message
            : `${NAMES[spec.kind]} run could not be prepared`,
      },
    };
  });
  return { done, cancel: () => controller.abort() };
}

/**
 * Run an agentic host-agent session: the CLI plans, calls tools on the supplied MCP servers
 * and finishes with a message. Events stream to `onEvent`; `done` always resolves.
 */
export function runHostAgentSession(
  request: HostAgentSessionRequest,
  onEvent: (event: HostAgentEvent) => void = () => {},
  options: { env?: NodeJS.ProcessEnv; binaryPath?: string } = {},
): { done: Promise<HostAgentSessionResult>; cancel(): void } {
  const emit = (event: HostAgentEvent) => {
    try {
      onEvent(event);
    } catch {
      /* ignore listener failures */
    }
  };
  const run = runHostAgent(
    {
      kind: request.kind,
      model: request.model,
      reasoning: request.reasoning,
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
      cwd: request.cwd,
      mcpServers: request.mcpServers,
      allowedTools: request.allowedTools,
      maxTurns: request.maxTurns,
      completion: false,
    },
    { ...options, timeoutMs: request.timeoutMs ?? 15 * 60_000, signal: request.signal },
    emit,
  );
  const done = run.done.then((outcome): HostAgentSessionResult => {
    if (outcome.error) {
      emit({ type: "error", ...outcome.error });
      return {
        kind: request.kind,
        ok: false,
        text: outcome.text,
        error: outcome.error,
        ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
        ...(outcome.usage ? { usage: outcome.usage } : {}),
      };
    }
    emit({
      type: "completed",
      text: outcome.text,
      ...(outcome.usage ? { usage: outcome.usage } : {}),
    });
    return {
      kind: request.kind,
      ok: true,
      text: outcome.text,
      ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
      ...(outcome.usage ? { usage: outcome.usage } : {}),
    };
  });
  return { done, cancel: run.cancel };
}
