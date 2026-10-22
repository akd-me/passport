import { APPROVAL_SCOPES } from "@passport/types";
import type { Hono } from "hono";
import type { Backend } from "./backend.js";
import { ApiError, required } from "./errors.js";
import { actionQuery, jsonBody } from "./route-input.js";
import { editedRequest, member, string } from "./validation.js";

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
    const raw = body.request ?? body.editedRequest;
    const edited = raw === undefined ? undefined : editedRequest(raw, original.request);
    // `task` and `always` (docs/tasks.md): later proposals of the same category stop asking.
    const scope =
      body.scope === undefined
        ? "once"
        : member(string(body.scope, "scope"), APPROVAL_SCOPES, "scope");
    if (scope !== "once") {
      if (!backend.tasks?.approvals) {
        throw new ApiError("TASKS_UNAVAILABLE", "Approval scopes need the real backend", 501);
      }
      return c.json(await backend.tasks.approvals.approve(original, edited, scope));
    }
    return c.json(await backend.executor.approve(original.id, edited));
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
