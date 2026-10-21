import type { AgentTrigger, DraftInput } from "@passport/types";
import type { RunContext } from "./context.js";
import { AgentError } from "./errors.js";
import { isObject } from "./llm/json.js";
import type { LlmMessage } from "./llm/types.js";
import { formatDraft } from "./profile.js";
import { manualPrompt, systemPrompt } from "./prompts/index.js";

/** The manual loop consumes the registry directly; no private tool schemas or dispatcher. */
export async function manual(
  ctx: RunContext,
  trigger: Extract<AgentTrigger, { kind: "manual" }>,
): Promise<void> {
  const selected = await Promise.all(
    (trigger.emailIds ?? []).map((id) => ctx.store.emails.get(id)),
  );
  const matter = trigger.matterId ? await ctx.store.matters.get(trigger.matterId) : undefined;
  const messages: LlmMessage[] = [
    { role: "user", content: manualPrompt(trigger.instruction, { emails: selected, matter }) },
  ];
  const tools = ctx.tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  let calls = 0;
  while (calls < 12) {
    const response = await ctx.complete({
      system: systemPrompt(
        ctx.profile,
        ctx.drafts,
        tools.map((tool) => tool.name),
      ),
      messages,
      tools,
      model: "main",
    });
    if (!response.toolCalls.length) {
      ctx.notes.push(`Manual instruction completed with ${calls} tool calls.`);
      return;
    }
    messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });
    for (const call of response.toolCalls) {
      if (calls === 12) break;
      calls++;
      let input = call.arguments;
      if (isObject(input)) {
        if (isObject(input.draft)) {
          const draft = input.draft as unknown as DraftInput;
          input = {
            ...input,
            draft: { ...draft, textBody: formatDraft(draft.textBody, ctx.profile, ctx.drafts) },
          };
        } else if (call.name === "reply_draft" && typeof input.textBody === "string") {
          input = { ...input, textBody: formatDraft(input.textBody, ctx.profile, ctx.drafts) };
        }
      }
      try {
        const result = await ctx.callTool(call.name, input);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify(result),
          isError: result.isError,
        });
      } catch (error) {
        if (!(error instanceof AgentError) || !error.code.startsWith("INPUT_")) throw error;
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify({ error: error.message, code: error.code }),
          isError: true,
        });
      }
    }
  }
  ctx.notes.push("Manual tool-call limit reached (12); remaining work requires another run.");
}
