import { SchedulerError } from "@passport/scheduler";
import { Hono } from "hono";
import type { Backend } from "../backend.js";
import { ApiError, required } from "../errors.js";
import { logger } from "../logger.js";
import { object } from "../validation.js";
import { existingSchedulerService, getSchedulerService } from "./service.js";

async function body(request: Request) {
  try {
    return object(await request.json());
  } catch (error) {
    // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError("INVALID_JSON", "Expected a JSON object");
  }
}
/** One composition hook; account onboarding implementations need no scheduler imports. */
export function installJobRoutes(app: Hono, backend: Backend) {
  app.use("/api/*", async (c, next) => {
    await next();
    if (
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      c.res.ok &&
      c.req.path.startsWith("/api/accounts")
    ) {
      // The account change already happened; a scheduler problem must not turn it into a 500.
      await existingSchedulerService(backend)
        ?.reconcileAccounts()
        .catch(() => logger.warn("Scheduler account reconcile failed"));
    }
  });
  const routes = new Hono();
  routes.onError((error, c) => {
    if (error instanceof SchedulerError) {
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.code === "JOB_NOT_FOUND" ? 404 : error.code === "SYSTEM_JOB" ? 409 : 400,
      );
    }
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    throw error;
  });
  const service = async () => {
    const s = getSchedulerService(backend);
    await s.ready;
    return s;
  };
  routes.get("/", async (c) => c.json((await service()).list()));
  routes.post("/", async (c) =>
    c.json(await (await service()).addRoutine(await body(c.req.raw)), 201),
  );
  routes.patch("/:id", async (c) =>
    c.json(await (await service()).update(c.req.param("id"), await body(c.req.raw))),
  );
  routes.delete("/:id", async (c) => {
    await (await service()).remove(c.req.param("id"));
    return c.json({ ok: true });
  });
  routes.get("/:id/history", async (c) =>
    c.json(required((await service()).scheduler.get(c.req.param("id")), "Job").history),
  );
  routes.post("/:id/run", async (c) =>
    c.json(await (await service()).scheduler.runNow(c.req.param("id"))),
  );
  for (const action of ["pause", "resume"] as const) {
    routes.post(`/:id/${action}`, async (c) =>
      c.json(await (await service()).scheduler[action](c.req.param("id"))),
    );
  }
  app.route("/api/jobs", routes);
}
