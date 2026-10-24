import type { Hono } from "hono";
import type { Backend } from "../backend.js";
import { ApiError } from "../errors.js";
import { system } from "./routes.js";

/** Fetch a specific durable run without the task detail's recent-runs window. */
export function installTaskRunRoutes(app: Hono, backend: Backend): void {
  app.get("/api/tasks/:id/runs/:runId", async (c) => {
    const { service } = system(backend);
    const task = await service.task(c.req.param("id"));
    const run = await service.tasks.runs.get(c.req.param("runId"));
    if (!run || run.taskId !== task.id) {
      throw new ApiError("NOT_FOUND", "Task run not found", 404);
    }
    return c.json(run);
  });
}
