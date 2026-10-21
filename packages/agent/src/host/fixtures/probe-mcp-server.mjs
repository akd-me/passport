// Tiny stdio MCP server for host-agent tests. Each call appends a line to PROBE_LOG.
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "probe", version: "1.0.0" });
server.registerTool("get_code_word", { description: "Returns today's secret code word", inputSchema: {} }, async () => {
  if (process.env.PROBE_LOG) appendFileSync(process.env.PROBE_LOG, "get_code_word\n");
  return { content: [{ type: "text", text: `The code word is ${process.env.PROBE_WORD ?? "ZEBRA"}` }] };
});
await server.connect(new StdioServerTransport());
