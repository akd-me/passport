import type { SecretRequest } from "@passport/types";
import type { Hono } from "hono";
import type { Backend } from "../backend.js";
import { ApiError, required } from "../errors.js";
import { object } from "../validation.js";

/** Private, authenticated human input. Values never enter task messages or domain events. */
export function installSecretRoutes(app: Hono, backend: Backend) {
  const publish = async (request: SecretRequest, emit = true) => {
    const { tasks, secrets } = backend.store;
    if (request.status !== "pending" && tasks && secrets) {
      const recent = await tasks.items.recent(request.taskId, ["secret_request"], 200);
      const states = await Promise.all(
        recent.map((item) =>
          item.kind === "secret_request"
            ? secrets.requests.get(item.payload.requestId, request.taskId, new Date().toISOString())
            : null,
        ),
      );
      if (!states.some((state) => state?.status === "pending")) {
        const current = await tasks.get(request.taskId);
        if (current?.needsUser === "question") {
          const task = await tasks.update(request.taskId, { needsUser: null });
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
