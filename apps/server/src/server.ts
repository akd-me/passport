import { serve } from "@hono/node-server";
import { WebSocket, WebSocketServer } from "ws";
import type { Backend } from "./backend.js";
import { createApp } from "./app.js";
import { startSchedulers } from "./schedulers/index.js";
import { serveHttp } from "@passport/mcp";
import { logger } from "./logger.js";
import { loadMcpToken } from "./mcp-token.js";

/** Bind locally by default; the WebSocket emits raw DomainEvent JSON at /ws. */
export function startServer(backend: Backend) {
  const app = createApp(backend),
    server = serve({
      fetch: app.fetch,
      hostname: backend.config.host,
      port: backend.config.port,
    });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on("upgrade", (request, socket, head) => {
    if (
      request.url !== "/ws" ||
      (request.headers.origin &&
        request.headers.origin !== `http://${request.headers.host}`)
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on("error", () => {});
      wss.emit("connection", ws, request);
    });
  });
  const unsubscribe = backend.bus.onAny((event) => {
    const message = JSON.stringify(event);
    for (const client of wss.clients)
      if (client.readyState === WebSocket.OPEN) {
        if (client.bufferedAmount > 1024 * 1024) client.terminate();
        else client.send(message);
      }
  });
  const schedulers = startSchedulers(backend);
  const mcp = backend.createMcpServer
    ? loadMcpToken(backend.config.dataDir).then(token => serveHttp(backend.createMcpServer!(), {
        port: backend.config.mcpPort ?? 4318,
        token,
      }))
    : undefined;
  const ready = mcp?.then((handle) => {
    logger.info(`Mailbox MCP → ${handle.url}`);
    return handle.url;
  });
  void ready?.catch(() => logger.error("MCP HTTP listener failed"));
  let closing: Promise<void> | undefined;
  return {
    app,
    server,
    ready: ready ?? Promise.resolve(),
    close: () =>
      (closing ??= (async () => {
        unsubscribe();
        await schedulers.stop();
        await mcp?.then(
          (handle) => handle.close(),
          () => undefined,
        );
        for (const client of wss.clients) client.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await backend.close();
      })()),
  };
}
