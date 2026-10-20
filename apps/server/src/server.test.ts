import { once } from "node:events";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { createDemoBackend } from "./demo/index.js";
import { defaultConfig } from "./config.js";
import { startServer } from "./server.js";

describe("HTTP + WebSocket listener", () => {
  it("streams raw DomainEvents, then closes sockets, timers, and storage", async () => {
    const backend = await createDemoBackend({ ...defaultConfig(), port: 0 });
    const handle = startServer(backend);
    await once(handle.server, "listening");
    const address = handle.server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP listener");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    try {
      await once(socket, "open");
      const message = once(socket, "message");
      backend.bus.emit({ type: "email.updated", emailId: "email-0" });
      expect(JSON.parse(String((await message)[0]))).toEqual({
        type: "email.updated",
        emailId: "email-0",
      });
      expect(
        (
          (await fetch(`http://127.0.0.1:${address.port}/api/health`).then(
            (r) => r.json(),
          )) as { mode: string }
        ).mode,
      ).toBe("demo");
    } finally {
      socket.terminate();
      await handle.close();
    }
    expect(handle.server.listening).toBe(false);
  });
});
