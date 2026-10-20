import type { Context } from "./context.js";
import { errorResult } from "./presentation.js";
import { schema, type Output, type Schema } from "./schema.js";
import type { ToolResult } from "./types.js";

export function register<S extends Record<string, Schema<unknown>>>(ctx: Context, name: string, description: string,
  shape: S, write: boolean, handler: (args: Output<S>, ctx: Context) => Promise<ToolResult>) {
  const input = schema.strictObject(shape);
  ctx.tools.push({ name, description, inputSchema: input.json as typeof input.json & { type: "object" }, risk: write ? "write" : "read",
    async handler(args, callContext) {
      try { return await handler(input.parse(args), ctx.forCall(callContext)); }
      catch (error) { return errorResult(error, write); }
    },
  });
}
