export type { MailboxMcpDependencies } from "./context.js";
export { createMailboxMcpServer, DEFAULT_MCP_RESPONSE_BYTE_BUDGET } from "./server.js";
export type { MailboxHttpHandle } from "./transports.js";
export { serveHttp, serveStdio } from "./transports.js";
