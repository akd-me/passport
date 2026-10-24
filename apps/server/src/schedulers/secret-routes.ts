import type { SecretRequest, Task } from "@passport/types";
import type { Hono } from "hono";
import type { Backend } from "../backend.js";
import { ApiError, required } from "../errors.js";
import { resolveTaskStatus } from "../tasks/status.js";
import { object } from "../validation.js";

/** Private, authenticated human input. Values never enter task messages or domain events. */
export function installSecretRoutes(app: Hono, backend: Backend) {
  /**
   * A resolved request leaves `pendingSecretRequestIds` and hands `needsUser` over through the
   * status rules (`question_resolved`), so an open `ask_user` question or another secret request
   * keeps the task waiting on the person (R1-18).
   */
  const publish = async (request: SecretRequest, emit = true) => {
    const { tasks, secrets } = backend.store;
    if (request.status !== "pending" && tasks && secrets) {
      const recent = await tasks.items.recent(request.taskId, ["secret_request"], 200);
      const states = await Promise.all(
        recent.map((item) =>
          item.kind === "secret_request" && item.payload.requestId !== request.id
            ? secrets.requests.get(item.payload.requestId, request.taskId, new Date().toISOString())
            : null,
        ),
      );
      // Rows written before the task listed its requests: the timeline is the fallback.
      const open = states.some((state) => state?.status === "pending");
      const resolve = (current: Task): Partial<Task> => {
        const listed = current.pendingSecretRequestIds ?? [];
        const ids = listed.filter((id) => id !== request.id);
        const next = { ...current, pendingSecretRequestIds: ids };
        return {
          ...(ids.length === listed.length ? {} : { pendingSecretRequestIds: ids }),
          ...(open && !ids.length ? {} : resolveTaskStatus(next, { kind: "question_resolved" })),
        };
      };
      if (await tasks.get(request.taskId)) {
        const runner = backend.tasks?.service.runner;
        if (runner) {
          await runner.updateTask(request.taskId, resolve);
        } else {
          const task = await tasks.update(request.taskId, resolve);
          backend.bus.emit({ type: "task.updated", task });
        }
      }
    }
    if (emit) {
      backend.bus.emit({ type: "secret.request.updated", request });
    }
  };
  const requests = () => {
    if (!backend.store.secrets) {
      throw new ApiError("SECRETS_UNAVAILABLE", "Encrypted secrets are unavailable", 501);
    }
    return backend.store.secrets.requests;
  };
  app.get("/api/tasks/:taskId/secrets/:id", async (c) => {
    const request = required(
      await requests().get(c.req.param("id"), c.req.param("taskId"), new Date().toISOString()),
      "Secret request",
    );
    const { secretRef: _ref, ...safe } = request;
    if (request.status !== "pending") {
      await publish(request, false);
    }
    return c.json(safe);
  });
  app.post("/api/tasks/:taskId/secrets/:id", async (c) => {
    let input: Record<string, unknown>;
    try {
      input = object(await c.req.json());
    } catch {
      throw new ApiError("INVALID_JSON", "Expected a private response object");
    }
    const validStatus = input.status === "declined" || input.status === "cancelled";
    if (
      Object.keys(input).some((key) => !["value", "status"].includes(key)) ||
      (input.value !== undefined && input.status !== undefined) ||
      (!validStatus &&
        (typeof input.value !== "string" || !input.value || input.value.length > 65536))
    ) {
      throw new ApiError("INVALID_FIELD", "Supply a secret value, or decline/cancel the request");
    }
    const request = required(
      await requests().respond(
        c.req.param("id"),
        c.req.param("taskId"),
        validStatus
          ? { status: input.status as "declined" | "cancelled" }
          : { value: input.value as string },
        new Date().toISOString(),
      ),
      "Secret request",
    );
    await publish(request);
    const { secretRef: _ref, ...safe } = request;
    return c.json(safe);
  });
}
