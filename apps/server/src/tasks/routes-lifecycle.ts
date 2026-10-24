import type { Hono } from "hono";
import type { Backend } from "../backend.js";
import { ApiError } from "../errors.js";
import { jsonBody } from "../route-input.js";
import { only, system, text } from "./routes.js";

/**
 * v0.4 lifecycle routes (docs/tasks.md "HTTP API"): seen and mark-unread, reopen, the follow-up
 * queue and the Limited state. Every change is also a `task.updated` frame.
 */
export function installTaskLifecycleRoutes(app: Hono, backend: Backend): void {
  app.post("/api/tasks/:id/seen", async (c) =>
    c.json(await system(backend).lifecycle.seen(c.req.param("id"))),
  );
  app.post("/api/tasks/:id/mark-unread", async (c) =>
    c.json(await system(backend).lifecycle.markUnread(c.req.param("id"))),
  );
  app.post("/api/tasks/:id/unsettle", async (c) =>
    c.json(await system(backend).lifecycle.unsettle(c.req.param("id"))),
  );
  app.post("/api/tasks/:id/unsnooze", async (c) =>
    c.json(await system(backend).lifecycle.unsnooze(c.req.param("id"))),
  );
  app.post("/api/tasks/:id/unarchive", async (c) =>
    c.json(await system(backend).lifecycle.unarchive(c.req.param("id"))),
  );

  app.get("/api/tasks/:id/queue", async (c) =>
    c.json(await system(backend).queue.get(c.req.param("id"))),
  );
  app.post("/api/tasks/:id/queue/reorder", async (c) => {
    const body = await jsonBody(c.req.raw);
    only(body, ["runIds"]);
    const runIds = body.runIds;
    if (!Array.isArray(runIds) || runIds.some((runId) => typeof runId !== "string")) {
      throw new ApiError("INVALID_FIELD", "runIds must be an array of strings");
    }
    return c.json(await system(backend).queue.reorder(c.req.param("id"), runIds as string[]));
  });
  app.post("/api/tasks/:id/queue/resume", async (c) =>
    c.json(await system(backend).queue.resume(c.req.param("id"))),
  );
  app.patch("/api/tasks/:id/queue/:runId", async (c) => {
    const body = await jsonBody(c.req.raw);
    only(body, ["text"]);
    return c.json(
      await system(backend).queue.edit(
        c.req.param("id"),
        c.req.param("runId"),
        text(body.text, "text"),
      ),
    );
  });
  app.delete("/api/tasks/:id/queue/:runId", async (c) =>
    c.json(await system(backend).queue.remove(c.req.param("id"), c.req.param("runId"))),
  );
  app.post("/api/tasks/:id/queue/:runId/promote-to-steer", async (c) =>
    c.json(await system(backend).queue.promote(c.req.param("id"), c.req.param("runId")), 202),
  );

  app.post("/api/tasks/:id/resume", async (c) =>
    c.json(await system(backend).limits.resume(c.req.param("id")), 202),
  );
  app.post("/api/tasks/:id/resume-at-reset", async (c) =>
    c.json(await system(backend).limits.resumeAtReset(c.req.param("id"))),
  );
}
