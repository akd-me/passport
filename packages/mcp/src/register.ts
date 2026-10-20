import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorResult } from "./presentation.js";

export function register<S extends z.ZodRawShape>(server: McpServer, name: string, description: string,
  shape: S, write: boolean, handler: (args: z.output<z.ZodObject<S>>) => Promise<CallToolResult>) {
  const schema = z.strictObject(shape);
  server.registerTool<z.ZodRawShape, typeof schema>(name, {
    description, inputSchema: schema,
    annotations: { readOnlyHint: !write, destructiveHint: write, idempotentHint: !write, openWorldHint: write },
  }, async args => {
    try { return await handler(args as z.output<z.ZodObject<S>>); }
    catch (error) { return errorResult(error, write); }
  });
}
