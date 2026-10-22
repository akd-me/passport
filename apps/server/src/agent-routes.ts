import type { Hono } from "hono";
import type { Backend } from "./backend.js";
import { ApiError, required } from "./errors.js";
import { readEmail } from "./ondemand-wiring.js";
import { jsonBody } from "./route-input.js";
import { string } from "./validation.js";

export function installAgentRoutes(app: Hono, backend: Backend): void {
  app.post("/api/agent/triage/:id", async (c) => {
    // Accepts a ULID or a mail handle; an uncached handle is fetched and cached for triage.
    const email = required(
      await readEmail(backend.store, backend.readers, c.req.param("id")),
      "Email",
    );
    if (!(await backend.store.emails.get(email.id, { cacheOnly: true }))) {
      await backend.store.emails.upsertMany([email]);
    }
    return c.json(
      await backend.agent.run(
        { kind: "email.received", emailId: email.id },
        { priority: "interactive" },
      ),
    );
  });
  app.post("/api/agent/run", async (c) => {
    const body = await jsonBody(c.req.raw, true);
    if (
      body.emailIds !== undefined &&
      (!Array.isArray(body.emailIds) || body.emailIds.some((id) => typeof id !== "string"))
    ) {
      throw new ApiError("INVALID_FIELD", "emailIds must be strings");
    }
    const instruction =
      body.instruction === undefined
        ? "Review active matters and prepare next steps."
        : string(body.instruction, "instruction");
    const matterId = body.matterId === undefined ? undefined : string(body.matterId, "matterId");
    const emailIds = body.emailIds as string[] | undefined;
    if (backend.tasks) {
      // v0.2 composer compatibility: every instruction becomes a task; the reply is the run.
      const { task, done } = await backend.tasks.service.create({
        message: instruction,
        emailIds,
        matterId,
      });
      return c.json({ ...(await done), taskId: task.id });
    }
    return c.json(
      await backend.agent.run(
        { kind: "manual", instruction, matterId, emailIds },
        { priority: "interactive" },
      ),
    );
  });
  app.get("/api/digest/:date", async (c) => {
    const date = c.req.param("date");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
    ) {
      throw new ApiError("INVALID_DATE", "Use YYYY-MM-DD");
    }
    return c.json({
      date,
      markdown: required(await backend.store.kv.get(`digest:${date}`), "Digest"),
    });
  });
}
