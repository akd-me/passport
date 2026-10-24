import { createToolRegistry } from "@passport/tools";
import type {
  AgentRunOptions,
  AgentRunPriority,
  AgentRuntime,
  AgentTrigger,
  QuotaLane,
} from "@passport/types";
import { RunBudget, resolveBudget } from "./budget.js";
import type {
  AgentRunResult,
  AgentRuntimeOptions,
  RegistryAgentRuntime,
  RunContext,
} from "./context.js";
import { normalizeAddress } from "./data.js";
import { AgentError } from "./errors.js";
import { isSessionLlmClient } from "./host/client.js";
import { newAgentId } from "./id.js";
import type { AgentFinishedEvent } from "./integration.js";
import { createLlmClient } from "./llm/client.js";
import { extractJson, isObject, validateJson } from "./llm/json.js";
import type { LlmClient } from "./llm/types.js";
import { manual } from "./manual.js";
import { getUserProfile, setUserProfile } from "./profile.js";
import { digestRenderPrompt } from "./prompts/digest.js";
import { systemPrompt } from "./prompts/index.js";
import { RunQueue } from "./queue.js";
import { createRunReads } from "./reads.js";
import { dailyDigest, getJournal, type Journal, reviewMatters } from "./schedules.js";
import { agenticSession } from "./session-run.js";
import { triage } from "./triage.js";

class PersonalAgentRuntime implements AgentRuntime {
  private readonly llm: LlmClient;
  private readonly now: () => string;
  private readonly queue: RunQueue;

  constructor(private readonly options: AgentRuntimeOptions) {
    if (
      options.matterReviewDays !== undefined &&
      (!Number.isFinite(options.matterReviewDays) || options.matterReviewDays <= 0)
    ) {
      throw new AgentError("matterReviewDays must be positive", "AGENT_CONFIG");
    }
    this.llm =
      "complete" in options.llm ? options.llm : createLlmClient(options.llm, { log: options.log });
    this.now = options.now ?? (() => new Date().toISOString());
    this.queue = new RunQueue(options.log);
    // Validate the configured ceiling once, at construction.
    resolveBudget(options.budget);
  }

  getUserProfile(): Promise<string> {
    return getUserProfile(this.options.store);
  }
  setUserProfile(markdown: string): Promise<void> {
    return setUserProfile(this.options.store, markdown);
  }

  run(trigger: AgentTrigger, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    // Serialize per-runtime inference and KV journals without subscribing to the bus implicitly.
    const priority = options.priority ?? (trigger.kind === "manual" ? "interactive" : "background");
    return this.queue.enqueue(priority, () => this.runInternal(trigger, priority, options));
  }

  queued(): Record<AgentRunPriority, number> {
    return this.queue.depth();
  }

  private async runInternal(
    trigger: AgentTrigger,
    priority: AgentRunPriority,
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    const { store, executor, policy, bus } = this.options;
    const run: AgentRunResult = {
      toolBudget: { callsMade: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      id: options.runId ?? this.options.runId?.(trigger) ?? newAgentId(),
      trigger,
      startedAt: this.now(),
      actionIds: [],
      summary: "Started.",
    };
    const lane: QuotaLane =
      priority === "interactive"
        ? "interactive"
        : trigger.kind === "email.received"
          ? "arrivals"
          : "background";
    const ctx: RunContext = {
      run,
      lane,
      reads: createRunReads({ readers: this.options.readers, lane, log: this.options.log }),
      store,
      policy,
      now: this.now,
      freeBusy: this.options.freeBusy,
      triageStep: this.options.triageStep,
      profile: "",
      selfAddresses: new Set(this.options.selfAddresses.map(normalizeAddress)),
      drafts: this.options.drafts ?? {},
      tools: [],
      toolCalls: 0,
      budget: new RunBudget(resolveBudget(this.options.budget), () => Date.parse(this.now())),
      ...(options.observer ? { observer: options.observer } : {}),
      actions: [],
      decisions: [],
      downgrades: [],
      notes: [],
      usages: [],
      complete: async (opts) => {
        cancelled(options.signal);
        const response = await this.llm.complete(opts);
        ctx.usages.push(response.usage);
        // A steer or stop during the call discards its answer.
        cancelled(options.signal);
        if (!opts.json && response.text.trim()) {
          options.observer?.assistantMessage?.(response.text);
        }
        if (opts.json) {
          response.json ??= extractJson(response.text);
          validateJson(response.json, opts.json);
        }
        for (const call of response.toolCalls) {
          const tool = opts.tools?.find((item) => item.name === call.name);
          if (!tool) {
            throw new AgentError("Model requested an unknown tool", "LLM_TOOL");
          }
          validateJson(call.arguments, tool.inputSchema);
        }
        return response;
      },
      structured: async (schema, content, model = "main") => {
        const response = await ctx.complete({
          system: systemPrompt(
            ctx.profile,
            ctx.drafts,
            ctx.tools.map((tool) => tool.name),
          ),
          messages: [{ role: "user", content }],
          json: schema,
          model,
        });
        if (!isObject(response.json)) {
          throw new AgentError("Expected structured object output", "LLM_SCHEMA");
        }
        return response.json;
      },
      callTool: async (name, input, context) => {
        const tool = ctx.tools.find((tool) => tool.name === name);
        if (!tool) {
          throw new AgentError("Unknown registry tool", "INPUT_TOOL");
        }
        cancelled(options.signal);
        ctx.toolCalls++;
        const result = await tool.handler(input, {
          ...(options.signal ? { signal: options.signal } : {}),
          ...context,
          runId: run.id,
          ...(options.taskId ? { taskId: options.taskId } : {}),
        });
        const data = result;
        if (data.error === "DEPENDENCY_ERROR" || data.status === "failed") {
          throw new AgentError("Tool dependency failed", "ACTION_FAILED");
        }
        if (result.isError && data.error) {
          throw new AgentError(
            typeof data.reason === "string" ? data.reason : "Invalid tool input",
            "INPUT_TOOL",
          );
        }
        return result;
      },
    };
    ctx.tools = createToolRegistry({
      log: this.options.log,
      store,
      policy,
      bus,
      selfAddresses: this.options.selfAddresses,
      now: this.now,
      freeBusy: this.options.freeBusy,
      // The same on-demand readers the run's own reads use; without them every `mail_*` tool
      // fails with ON_DEMAND_UNSUPPORTED and the model falls back to the local cache.
      readers: this.options.readers,
      actor: { kind: "agent", id: run.id },
      observer: options.observer?.toolCall?.bind(options.observer),
      readOnly: options.readOnly,
      executor: {
        ...executor,
        submit: async (request) => {
          const record = await executor.submit(request);
          run.actionIds.push(record.id);
          ctx.actions.push(record);
          await store.kv.set(`run:${run.id}`, JSON.stringify(run));
          if (record.status === "failed") {
            throw new AgentError("Action executor reported a failed action", "ACTION_FAILED");
          }
          return record;
        },
        approve: (...args) => executor.approve(...args),
        reject: (...args) => executor.reject(...args),
        cancelHold: (...args) => executor.cancelHold(...args),
        undo: (...args) => executor.undo(...args),
        releaseDue: (...args) => executor.releaseDue(...args),
      },
    });
    await store.kv.set(`run:${run.id}`, JSON.stringify(run));
    let failure: AgentError | undefined;
    let journal: Journal | undefined;
    try {
      bus.emit({
        type: "agent.run.started",
        runId: run.id,
        trigger: trigger.kind === "schedule" ? `schedule:${trigger.name}` : trigger.kind,
      });
      ctx.profile = await this.getUserProfile();
      journal = await getJournal(ctx, policy);
      switch (trigger.kind) {
        case "email.received":
          await triage(ctx, trigger.emailId, bus);
          break;
        case "manual":
          if (options.session && this.options.toolBelt && isSessionLlmClient(this.llm)) {
            await agenticSession(ctx, trigger, this.llm, this.options.toolBelt, options);
          } else {
            await manual(ctx, trigger, { orchestration: !!options.session });
          }
          break;
        case "schedule":
          switch (trigger.name) {
            case "daily_digest":
              await dailyDigest(ctx, policy);
              if (options.taskId && store.tasks && ctx.digest) {
                const digest = {
                  kind: "manual" as const,
                  instruction: digestRenderPrompt(ctx.digest.markdown),
                };
                if (this.options.toolBelt && isSessionLlmClient(this.llm)) {
                  await agenticSession(ctx, digest, this.llm, this.options.toolBelt, {
                    ...options,
                    session: {},
                  });
                } else {
                  await manual(ctx, digest, { orchestration: true });
                }
              }
              break;
            case "matter_review":
              await reviewMatters(ctx, this.options.matterReviewDays ?? 7);
              break;
            case "outbox": {
              const released = await executor.releaseDue(this.now());
              ctx.notes.push(`Released ${released.length} due outbox actions.`);
              break;
            }
            default:
              throw new AgentError("Unknown schedule trigger", "AGENT_TRIGGER");
          }
          break;
        default:
          throw new AgentError("Unknown agent trigger", "AGENT_TRIGGER");
      }
    } catch (error) {
      // Agent operation failed; retaining the safe run error.
      this.options.log?.("Agent operation failed; retaining the safe run error");

      // Unknown collaborators may include sensitive payloads in their errors. Keep them private.
      failure =
        error instanceof AgentError
          ? error
          : new AgentError("Agent operation failed", "AGENT_COLLABORATOR");
      run.error = failure.message;
    }
    run.toolBudget = {
      callsMade: ctx.toolCalls,
      llmCalls: ctx.usages.length,
      inputTokens: ctx.usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
      outputTokens: ctx.usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
      totalTokens: ctx.usages.reduce((sum, usage) => sum + usage.totalTokens, 0),
      ...(ctx.reads.usage.calls || ctx.reads.usage.skipped
        ? { reads: { ...ctx.reads.usage } }
        : {}),
    };
    run.finishedAt = this.now();
    run.summary = `${ctx.notes.join(" ") || (failure ? "Run failed." : "Run completed.")} ${ctx.actions.length} actions submitted; ${ctx.usages.length} LLM calls.`;
    await store.kv.set(`run:${run.id}`, JSON.stringify(run));
    await store.kv.set(
      `run_usage:${run.id}`,
      JSON.stringify({
        calls: ctx.usages.length,
        inputTokens: ctx.usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
        outputTokens: ctx.usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
        costUsd: ctx.usages.some((usage) => usage.costUsd === null)
          ? null
          : ctx.usages.reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0),
      }),
    );
    if (journal) {
      journal.runs.push({
        id: run.id,
        summary: run.summary,
        downgrades: ctx.downgrades,
        decisions: ctx.decisions,
      });
      await store.kv.set(`agent:journal:${run.startedAt.slice(0, 10)}`, JSON.stringify(journal));
    }
    const event: AgentFinishedEvent = {
      type: "agent.run.finished",
      runId: run.id,
      proposed: ctx.actions.filter((action) => action.status === "proposed").length,
      executed: ctx.actions.filter((action) => action.status === "executed").length,
      ...(failure ? { error: run.error } : {}),
      ...(ctx.decisions.length ? { decisions: ctx.decisions } : {}),
      ...(ctx.digest ? { digest: ctx.digest } : {}),
    };
    bus.emit(event);
    if (failure) {
      throw failure;
    }
    return run;
  }
}

/** Cooperative cancellation for task runs: checked around each model call and before tool calls. */
function cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AgentError("Run cancelled", "RUN_CANCELLED");
  }
}

/** Build an injected personal agent. The composition root owns subscriptions and scheduling. */
export function createAgentRuntime(options: AgentRuntimeOptions): RegistryAgentRuntime {
  return new PersonalAgentRuntime(options);
}
