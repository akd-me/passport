import { Context } from "./context.js";
import { registerExtra } from "./extra.js";
import { registerReads } from "./reads.js";
import { responseByteBudget } from "./response-budget.js";
import type { Tool, ToolRegistryOptions } from "./types.js";
import { registerWrites } from "./writes.js";

/** One tool surface for built-in agents, MCP and provider function calling. */
export function createToolRegistry(options: ToolRegistryOptions): Tool[] {
  responseByteBudget(options.responseByteBudget);
  const ctx = new Context(options);
  registerReads(ctx);
  registerWrites(ctx);
  registerExtra(ctx);
  return ctx.tools;
}

/** Shape adapters only: schemas and descriptions remain owned by the registry. */
export const toAnthropicTools = (tools: readonly Tool[]) =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
export const toOpenAiTools = (tools: readonly Tool[]) =>
  tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
export const toMcpTools = (tools: readonly Tool[]) =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      readOnlyHint: tool.risk === "read",
      destructiveHint: tool.risk === "write",
      idempotentHint: tool.risk === "read",
      openWorldHint: tool.risk === "write",
    },
  }));
export type { FreeBusyResolver } from "./availability.js";
export { availability, availabilityEvents, expandRecurringEvents } from "./availability.js";
export type { CategorizeInput } from "./categorize.js";
export { categorize } from "./categorize.js";
export { ToolError } from "./presentation.js";
export {
  DEFAULT_RESPONSE_BYTE_BUDGET,
  limitResponse,
  responseByteBudget,
} from "./response-budget.js";
export type { JsonSchema } from "./schema.js";
export type { Tool, ToolContext, ToolRegistryOptions, ToolResult } from "./types.js";
