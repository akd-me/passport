import type { Context } from "./context.js";
import { errorResult } from "./presentation.js";
import { limitResponse } from "./response-budget.js";
import { type Output, type Schema, schema } from "./schema.js";
import type { ToolAnnotations, ToolContext, ToolResult } from "./types.js";

export function register<S extends Record<string, Schema<unknown>>>(
  ctx: Context,
  name: string,
  description: string,
  shape: S,
  write: boolean,
  handler: (args: Output<S>, ctx: Context) => Promise<ToolResult>,
  annotations?: ToolAnnotations,
) {
  const input = schema.strictObject(shape);
  ctx.tools.push({
    name,
    description,
    inputSchema: input.json as typeof input.json & { type: "object" },
    risk: write ? "write" : "read",
    ...(annotations ? { annotations } : {}),
    async handler(args, callContext) {
      const started = Date.now();
      const observe = (result: ToolResult, planned = false) => {
        observeCall(ctx, { name, args, write, result, started, callContext, planned });
        return result;
      };
      if (write && ctx.deps.readOnly) {
        return observe(plannedResult(name), true);
      }
      try {
        return observe(
          limitResponse(
            await handler(input.parse(args), ctx.forCall(callContext)),
            ctx.deps.responseByteBudget,
          ),
        );
      } catch (error) {
        // Tool request failed; returning the existing bounded error.
        ctx.deps.log?.("Tool request failed; returning the existing bounded error");

        try {
          return observe(limitResponse(errorResult(error, write), ctx.deps.responseByteBudget));
        } catch {
          // Tool error exceeds the response budget; returning the minimal error.
          ctx.deps.log?.("Tool error exceeds the response budget; returning the minimal error");

          return observe({
            isError: true,
            error: "RESPONSE_TOO_LARGE",
            reason: "Request fewer results.",
          });
        }
      }
    },
  });
}

/** Plan mode: a write tool records the intended change instead of executing it. */
function plannedResult(name: string): ToolResult {
  return {
    status: "planned",
    tool: name,
    note: "Plan mode: nothing was changed. List this step in your proposal; the person runs it after approving the plan.",
  };
}

/** Reports a finished call to the registry observer; observer failures never fail the tool. */
function observeCall(
  ctx: Context,
  call: {
    name: string;
    args: unknown;
    write: boolean;
    result: ToolResult;
    started: number;
    callContext?: ToolContext;
    planned: boolean;
  },
) {
  const observer = ctx.deps.observer;
  if (!observer) {
    return;
  }
  try {
    observer({
      name: call.name,
      input: call.args,
      result: call.result,
      durationMs: Date.now() - call.started,
      risk: call.write ? "write" : "read",
      ...(call.callContext?.runId ? { runId: call.callContext.runId } : {}),
      ...(call.callContext?.taskId ? { taskId: call.callContext.taskId } : {}),
      ...(call.planned ? { planned: true } : {}),
    });
  } catch {
    // The observer is a timeline recorder; a failure there must not change the tool result.
    ctx.deps.log?.("Tool call observer failed; the tool result is unchanged");
  }
}
