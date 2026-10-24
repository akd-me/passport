import type { AgentTrigger } from "@passport/types";
import type { RunContext } from "./context.js";
import { AgentError } from "./errors.js";
import type { LlmMessage } from "./llm/types.js";
import { manualPrompt, systemPrompt } from "./prompts/index.js";
import { orchestrationPrompt } from "./prompts/orchestration.js";
import { prepareToolInput } from "./tool-input.js";

/** The selected messages and matter a manual trigger names, read for its first prompt. */
export async function manualContext(
  ctx: RunContext,
  trigger: Extract<AgentTrigger, { kind: "manual" }>,
) {
  const emails = await Promise.all(
    (trigger.emailIds ?? []).map((id) => ctx.store.emails.get(id, ctx.reads.storeRead())),
  );
  const matter = trigger.matterId ? await ctx.store.matters.get(trigger.matterId) : undefined;
  return { emails, matter };
}

/**
 * The completion loop (API providers, and host agents outside task sessions): the registry's
 * tools as native tool definitions, bounded by the run budget instead of a fixed call count.
 */
export async function manual(
  ctx: RunContext,
  trigger: Extract<AgentTrigger, { kind: "manual" }>,
  options: { orchestration?: boolean } = {},
): Promise<void> {
  const { budget } = ctx;
  const messages: LlmMessage[] = [
    {
      role: "user",
      content: manualPrompt(trigger.instruction, await manualContext(ctx, trigger), {
        maxToolCalls: budget.limits.maxToolCalls,
      }),
    },
  ];
  const tools = ctx.tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  const system = [
    systemPrompt(
      ctx.profile,
      ctx.drafts,
      tools.map((tool) => tool.name),
    ),
    options.orchestration ? orchestrationPrompt(budget.limits, false) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  while (budget.checkTime()) {
    const response = await ctx.complete({ system, messages, tools, model: "main" });
    if (!response.toolCalls.length) {
      ctx.notes.push(`Manual instruction completed with ${budget.used} tool calls.`);
      return;
    }
    messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });
    for (const call of response.toolCalls) {
      if (!budget.take()) {
        break;
      }
      try {
        const result = await ctx.callTool(
          call.name,
          prepareToolInput(ctx, call.name, call.arguments),
        );
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify(result),
          isError: result.isError,
        });
      } catch (error) {
        // Input validation failures become tool feedback; unrelated agent failures propagate.

        if (!(error instanceof AgentError) || !error.code.startsWith("INPUT_")) {
          throw error;
        }
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify({ error: error.message, code: error.code }),
          isError: true,
        });
      }
    }
    if (budget.exhausted) {
      break;
    }
  }
  budgetExhausted(ctx);
}

/** The run stops at its budget: a note on the run and a `BUDGET_EXHAUSTED` timeline notice. */
export function budgetExhausted(ctx: RunContext): void {
  const notice = ctx.budget.notice();
  ctx.notes.push(
    `Run budget reached (${ctx.budget.exhausted === "time" ? "time" : `${ctx.budget.limits.maxToolCalls} tool calls`}); remaining work requires another run.`,
  );
  ctx.observer?.notice?.(notice);
}
