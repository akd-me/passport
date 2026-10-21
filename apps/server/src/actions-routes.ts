import type { Hono } from "hono";
import type { Backend } from "./backend.js";
import { required } from "./errors.js";
import { actionQuery, jsonBody } from "./route-input.js";
import { editedRequest, string } from "./validation.js";

export function installActionsRoutes(app: Hono, backend: Backend): void {
  app.get("/api/decisions", async (c) =>
    c.json(
      await backend.store.actions.query({
        status: ["proposed", "held"],
        limit: 500,
      }),
    ),
  );
  app.get("/api/actions", async (c) =>
    c.json(await backend.store.actions.query(actionQuery(c.req.query()))),
  );
  app.post("/api/actions/:id/approve", async (c) => {
    const body = await jsonBody(c.req.raw, true),
      original = required(await backend.store.actions.get(c.req.param("id")), "Action");
    const edited = body.request ?? body.editedRequest;
    return c.json(
      await backend.executor.approve(
        original.id,
        edited === undefined ? undefined : editedRequest(edited, original.request),
      ),
    );
  });
  app.post("/api/actions/:id/reject", async (c) => {
    const body = await jsonBody(c.req.raw, true);
    return c.json(
      await backend.executor.reject(
        c.req.param("id"),
        body.reason === undefined ? undefined : string(body.reason, "reason"),
      ),
    );
  });
  app.post("/api/actions/:id/cancel-hold", async (c) =>
    c.json(await backend.executor.cancelHold(c.req.param("id"))),
  );
  app.post("/api/actions/:id/undo", async (c) =>
    c.json(await backend.executor.undo(c.req.param("id"))),
  );
}
