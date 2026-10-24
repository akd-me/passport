import type { Tool, ToolResult } from "@passport/tools";
import type {
  AgentRunOptions,
  AgentTrigger,
  HostAgentEvent,
  HostAgentMcpServer,
  HostAgentSessionResult,
} from "@passport/types";
import type { RunContext } from "./context.js";
import { AgentError } from "./errors.js";
import type { SessionLlmClient } from "./host/client.js";
import { validateJson } from "./llm/json.js";
import { budgetExhausted, manualContext } from "./manual.js";
import { manualPrompt, systemPrompt } from "./prompts/index.js";
import { orchestrationPrompt } from "./prompts/orchestration.js";
import { prepareToolInput } from "./tool-input.js";

/** `setTimeout` holds at most a signed 32-bit delay. */
const MAX_TIMER_MS = 2_147_483_647 - 60_000;

/** MCP server name of the tool belt; the CLI sees its tools as `mcp__passport__<tool>`. */
export const TOOL_BELT_SERVER = "passport";

/** One run's tools, as the session's MCP server should list and call them. */
export interface ToolBelt {
  tools: Tool[];
  /** Runs a tool under the run's identity, task and budget. Never throws. */
  call(name: string, input: unknown): Promise<ToolResult>;
}

export interface ToolBeltBinding {
  /** How the CLI reaches the belt (URL plus a per-run bearer, for the HTTP listener). */
  server: HostAgentMcpServer;
  /** Revokes the binding; later calls are refused. */
  release(): Promise<void>;
}

/** Serves tool belts to host-agent sessions. `@passport/mcp` implements it (`ToolBeltListener`). */
export interface ToolBeltHost {
  bind(belt: ToolBelt): Promise<ToolBeltBinding>;
}

const stopped = (reason: string, error = "RUN_STOPPED"): ToolResult => ({
  isError: true,
  error,
  reason,
});

/**
 * A manual trigger as one agentic host session (W1A): the CLI calls the run's registry tools
 * natively through the tool belt, events stream to the observer, and a resumable provider
 * session is recorded. A failed resume that did nothing yet falls back to a fresh session with
 * the full instruction.
 */
export async function agenticSession(
  ctx: RunContext,
  trigger: Extract<AgentTrigger, { kind: "manual" }>,
  llm: SessionLlmClient,
  host: ToolBeltHost,
  options: AgentRunOptions,
): Promise<void> {
  const { budget, observer } = ctx;
  const signal = options.signal;
  const controller = new AbortController();
  const sessionSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const inflight = new Set<Promise<unknown>>();
  let fatal: AgentError | undefined;
  let activity = false;

  const call = async (name: string, input: unknown): Promise<ToolResult> => {
    if (sessionSignal.aborted || fatal) {
      return stopped("This run has ended. Stop now and do not call more tools.");
    }
    if (!budget.take()) {
      controller.abort();
      return stopped("The run budget is spent. Stop now and summarize.", "BUDGET_EXHAUSTED");
    }
    activity = true;
    const tool = ctx.tools.find((candidate) => candidate.name === name);
    if (!tool) {
      return stopped("Unknown Passport tool.", "UNKNOWN_TOOL");
    }
    try {
      validateJson(input ?? {}, tool.inputSchema);
    } catch {
      // The model's arguments do not match the schema; it can correct them.
      return stopped("Arguments do not match the tool's input schema.", "INVALID_INPUT");
    }
    try {
      return await ctx.callTool(name, prepareToolInput(ctx, name, input ?? {}));
    } catch (error) {
      if (error instanceof AgentError && error.code.startsWith("INPUT_")) {
        // Input validation failures become tool feedback, as in the completion loop.
        return stopped(error.message, error.code);
      }
      // A dependency or executor failure fails the run, as in the completion loop.
      fatal =
        error instanceof AgentError
          ? error
          : new AgentError("Agent operation failed", "AGENT_COLLABORATOR");
      controller.abort();
      return stopped("The run failed. Stop now.", "RUN_FAILED");
    }
  };
  const system = [
    systemPrompt(
      ctx.profile,
      ctx.drafts,
      ctx.tools.map((tool) => tool.name),
    ),
    orchestrationPrompt(budget.limits, true),
  ].join("\n\n");
  const context = await manualContext(ctx, trigger);
  const fresh = manualPrompt(trigger.instruction, context);
  const requested = options.session?.resume ?? (await options.session?.resolveResume?.());
  const resume = requested?.kind === llm.hostKind ? requested : undefined;
  // A resumed turn is the follow-up alone, plus any composer context this run was given.
  const resumed =
    resume && (context.emails.length || context.matter)
      ? manualPrompt(resume.instruction, context)
      : resume?.instruction;

  const binding = await host.bind({
    tools: ctx.tools,
    call: (name, input) => {
      const pending = call(name, input);
      inflight.add(pending);
      void pending.finally(() => inflight.delete(pending));
      return pending;
    },
  });

  const attempt = (prompt: string, resumeSessionId?: string): Promise<HostAgentSessionResult> => {
    const remaining = Math.min(budget.remainingMs(), MAX_TIMER_MS);
    const timer = setTimeout(() => {
      budget.expire();
      controller.abort();
    }, remaining);
    const onEvent = (event: HostAgentEvent) => {
      if (event.type === "started" && event.sessionId) {
        observer?.providerSession?.({ kind: llm.hostKind, id: event.sessionId });
      } else if (event.type === "text" && event.text.trim() && !sessionSignal.aborted) {
        activity = true;
        observer?.assistantMessage?.(event.text);
      } else if (event.type === "tool_call") {
        activity = true;
      }
    };
    const session = llm.session(
      {
        prompt,
        systemPrompt: system,
        mcpServers: { [TOOL_BELT_SERVER]: binding.server },
        allowedTools: [`mcp__${TOOL_BELT_SERVER}`],
        ...(resumeSessionId ? { resumeSessionId } : {}),
        // The budget timer stops the session first; this only bounds a CLI that ignores it.
        timeoutMs: remaining + 60_000,
        signal: sessionSignal,
      },
      onEvent,
    );
    return session.done
      .then((result) => {
        if (result.usage) {
          ctx.usages.push({ ...result.usage });
        }
        return result;
      })
      .finally(() => clearTimeout(timer));
  };

  try {
    let result = await attempt(resumed ?? fresh, resume?.id);
    // Both CLIs report a missing session as a plain failure before any event; auth, limits and
    // timeouts would fail again, so they are not retried.
    const lost = !result.ok && result.error?.code === "HOST_AGENT_FAILED";
    if (resume && lost && !activity && !sessionSignal.aborted) {
      // The provider no longer has the session (expired, other machine): start over.
      ctx.notes.push("Provider session could not be resumed; started a fresh one.");
      result = await attempt(fresh);
    }
    await Promise.allSettled([...inflight]);
    if (signal?.aborted) {
      throw new AgentError("Run cancelled", "RUN_CANCELLED");
    }
    if (fatal) {
      throw fatal;
    }
    if (budget.exhausted) {
      budgetExhausted(ctx);
      return;
    }
    if (!result.ok) {
      throw new AgentError(
        result.error?.message ?? "Host agent session failed",
        result.error?.code ?? "HOST_AGENT_FAILED",
      );
    }
    ctx.notes.push(`Session completed with ${budget.used} tool calls.`);
  } finally {
    await binding.release();
  }
}
