import { Context } from "./context.js";
import { registerExtra } from "./extra.js";
import { registerMailExport } from "./mail-export.js";
import { registerReads } from "./reads.js";
import { registerOnDemandReads } from "./reads-ondemand.js";
import { registerOnDemandExtra } from "./reads-ondemand-extra.js";
import { registerMailRead } from "./reads-ondemand-read.js";
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
  registerOnDemandReads(ctx);
  registerMailRead(ctx);
  registerOnDemandExtra(ctx);
  registerMailExport(ctx);
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
      ...tool.annotations,
    },
  }));
export type { FreeBusyResolver } from "./availability.js";
export { availability, availabilityEvents, expandRecurringEvents } from "./availability.js";
export type { CategorizeInput } from "./categorize.js";
export { categorize } from "./categorize.js";
export { SCRATCH_MAX_AGE_MS, sweepScratchDir } from "./mail-export.js";
export { neutralize, UNTRUSTED_NOTICE } from "./ondemand-support.js";
export { ToolError } from "./presentation.js";
export { collapseQuoted, htmlToText } from "./quoted.js";
export {
  DEFAULT_RESPONSE_BYTE_BUDGET,
  limitResponse,
  responseByteBudget,
} from "./response-budget.js";
export type { JsonSchema } from "./schema.js";
export type {
  Tool,
  ToolAnnotations,
  ToolContext,
  ToolRegistryOptions,
  ToolResult,
} from "./types.js";
