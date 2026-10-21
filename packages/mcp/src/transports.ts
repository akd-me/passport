import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server as HttpServer, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MailboxMcpError } from "./presentation.js";
import { bindTransportActor, cloneMailboxServer } from "./server.js";

/** Attach stdio. The host must keep stdout exclusive to MCP, and call server.close() at shutdown. */
export async function serveStdio(server: McpServer): Promise<void> {
  await server.connect(new StdioServerTransport());
}

export interface MailboxHttpHandle {
  httpServer: HttpServer;
  url: string;
  /** Closes every MCP session and the listener, without closing injected collaborators. */
  close(): Promise<void>;
}

/** Authenticated Streamable HTTP; isolated sessions, loopback-bound unless host is explicit. */
export async function serveHttp(
  server: McpServer,
  options: {
    port: number;
    path?: string;
    token: string;
    host?: string;
    log?: (message: string) => void;
  },
): Promise<MailboxHttpHandle> {
  if (!options.token || /\s/.test(options.token)) {
    throw new MailboxMcpError(
      "TOKEN_REQUIRED",
      "A nonempty bearer token without whitespace is required for HTTP.",
    );
  }
  const host = options.host ?? "127.0.0.1";
  const urlHost = host.includes(":") ? `[${host}]` : host;
  const path = options.path ?? "/mcp";
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new MailboxMcpError("INVALID_PORT", "port must be an integer from 0 to 65535.");
  }
  if (!/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(path)) {
    throw new MailboxMcpError(
      "INVALID_PATH",
      "path must be an absolute URL path without a query or fragment.",
    );
  }
  if (server.isConnected()) {
    throw new MailboxMcpError("ALREADY_CONNECTED", "Use a fresh MCP server for HTTP.");
  }
  // Validate cloneability before opening a listener; each client requires its own SDK protocol state.
  await cloneMailboxServer(server).close();
  const sessions = new Map<
    string,
    { server: McpServer; transport: StreamableHTTPServerTransport }
  >();
  const active = new Set<McpServer>();
  let first = true;
  let closing = false;
  let port = options.port;
  const fail = (res: ServerResponse, status: number, message: string) => {
    if (!res.headersSent) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    } else {
      res.end();
    }
  };
  const httpServer = createServer(async (req, res) => {
    try {
      if (closing) {
        fail(res, 503, "Server is shutting down.");
        return;
      }
      const authorization = req.headers.authorization ?? "";
      const expected = Buffer.from(`Bearer ${options.token}`);
      const actual = Buffer.from(authorization);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        res.setHeader("WWW-Authenticate", "Bearer");
        fail(res, 401, "Bearer token required.");
        return;
      }
      const local = req.socket.localAddress?.replace(/^::ffff:/, "");
      const localHost = local?.includes(":") ? `[${local}]` : local;
      const allowedHosts = [
        `${urlHost}:${port}`,
        ...(host === "127.0.0.1" ? [`localhost:${port}`] : []),
        ...(["0.0.0.0", "::"].includes(host) && localHost ? [`${localHost}:${port}`] : []),
      ];
      if (!req.headers.host || !allowedHosts.includes(req.headers.host)) {
        fail(res, 403, "Invalid Host.");
        return;
      }
      const origin = req.headers.origin;
      if (origin && !allowedHosts.map((host) => `http://${host}`).includes(origin)) {
        fail(res, 403, "Invalid Origin.");
        return;
      }
      if (new URL(req.url ?? "/", `http://127.0.0.1:${port}`).pathname !== path) {
        fail(res, 404, "Not found.");
        return;
      }
      if (!["POST", "GET", "DELETE"].includes(req.method ?? "")) {
        res.setHeader("Allow", "POST, GET, DELETE");
        fail(res, 405, "Method not allowed.");
        return;
      }
      const sessionId = req.headers["mcp-session-id"];
      if (sessionId !== undefined) {
        const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
        if (!session) {
          fail(res, 404, "Unknown MCP session.");
          return;
        }
        await session.transport.handleRequest(req, res);
        return;
      }
      if (req.method !== "POST") {
        fail(res, 400, "Initialize an MCP session with POST first.");
        return;
      }
      const sessionServer = first ? server : cloneMailboxServer(server);
      first = false;
      active.add(sessionServer);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          bindTransportActor(sessionServer, id);
          sessions.set(id, { server: sessionServer, transport });
        },
      });
      await sessionServer.connect(transport);
      const previousClose = sessionServer.server.onclose;
      sessionServer.server.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
        active.delete(sessionServer);
        previousClose?.();
      };
      try {
        await transport.handleRequest(req, res);
      } finally {
        if (!transport.sessionId) {
          await sessionServer.close();
        }
      }
    } catch {
      // MCP HTTP request failed; returning the existing transport error.
      options.log?.("MCP HTTP request failed; returning the existing transport error");

      fail(res, 500, "MCP transport failed.");
    }
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new MailboxMcpError("LISTEN_FAILED", "HTTP listener did not provide a port.");
  }
  port = address.port;
  let shutdown: Promise<void> | undefined;
  return {
    httpServer,
    url: `http://${urlHost}:${port}${path}`,
    close() {
      shutdown ??= (async () => {
        closing = true;
        const stopped = new Promise<void>((resolve, reject) =>
          httpServer.close((error) => (error ? reject(error) : resolve())),
        );
        await Promise.all([...active].map((sessionServer) => sessionServer.close()));
        await server.close();
        httpServer.closeAllConnections();
        await stopped;
      })();
      return shutdown;
    },
  };
}
