import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Backend } from "../backend.js";
import { ApiError, required } from "../errors.js";
import { getSchedulerService } from "./service.js";

/** Public capability URL; normal API auth still protects every administration route. */
export function installWebhookRoutes(app: Hono, backend: Backend) {
  app.post(
    "/api/hooks/:token",
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (c) =>
        c.json({ error: { code: "BODY_TOO_LARGE", message: "Webhook body exceeds 256 KiB" } }, 413),
    }),
    async (c) => {
      if (!/^[a-f0-9]{64}$/.test(c.req.param("token"))) {
        throw new ApiError("NOT_FOUND", "Webhook not found", 404);
      }
      const raw = new Uint8Array(await c.req.arrayBuffer());
      const text = new TextDecoder().decode(raw);
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Non-JSON requests remain plain text (form fields are addressable too).
        if (c.req.header("content-type")?.includes("application/x-www-form-urlencoded")) {
          body = Object.fromEntries(new URLSearchParams(text));
        }
      }
      const service = getSchedulerService(backend);
      await service.ready;
      const result = await service.webhooks.receive(c.req.param("token"), raw, {
        body,
        bodyText: text,
        method: "POST",
        path: "/api/hooks/[redacted]",
        headers: Object.fromEntries(c.req.raw.headers),
        query: Object.fromEntries(new URL(c.req.url).searchParams),
      });
      if (result.status === 429) {
        c.header("Retry-After", "60");
      }
      return c.json({ outcome: result.outcome }, result.status);
    },
  );
  app.get("/api/jobs/:id/deliveries", async (c) => {
    const service = getSchedulerService(backend);
    await service.ready;
    required(service.scheduler.get(c.req.param("id")), "Routine");
    return c.json(service.webhooks.deliveries(c.req.param("id")));
  });
  app.post("/api/jobs/:id/rotate-token", async (c) => {
    const service = getSchedulerService(backend);
    await service.ready;
    return c.json(await service.webhooks.rotate(c.req.param("id")));
  });
}
