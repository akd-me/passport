import type { SecretRequest } from "@passport/types";
import type { Context } from "./context.js";
import { neutralize } from "./ondemand-support.js";
import { json, ToolError } from "./presentation.js";
import { register } from "./register.js";
import { schema as z } from "./schema.js";

/** Await private input, returning only its one-use reference to the agent. */
export function registerSecrets(ctx: Context) {
  register(
    ctx,
    "request_secret",
    "Ask the person for a secret in a private task field. Never ask them to paste it in chat. Returns only status and a one-use secretRef, never the value. Reuse clientRequestId on retries to show one request.",
    {
      text: z.string().trim().min(1).max(1000),
      clientRequestId: z.string().trim().min(1).max(200),
      timeoutSeconds: z.number().int().min(10).max(600).default(300),
    },
    true,
    async (args, call) => {
      const { secrets, tasks } = call.store;
      const taskId = call.callContext.taskId;
      if (!taskId || !tasks) {
        throw new ToolError("TASK_REQUIRED", "Request a secret from a task run.");
      }
      if (!secrets) {
        throw new ToolError("SECRETS_UNAVAILABLE", "This store has no encrypted secret service.");
      }
      const createdAt = call.now();
      const { request, item } = await secrets.requests.create({
        taskId,
        runId: call.callContext.runId,
        clientRequestId: args.clientRequestId,
        text: neutralize(args.text),
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + args.timeoutSeconds * 1000).toISOString(),
      });
      if (item) {
        call.deps.bus.emit({ type: "task.item.appended", item });
      }
      if (request.status !== "pending") {
        return json(requestResult(request));
      }
      const task = await tasks.update(taskId, (current) => ({
        needsUser: current.pendingActionIds?.length ? "approval" : "question",
        status: "inbox",
        lastActivityAt: createdAt,
      }));
      call.deps.bus.emit({ type: "task.updated", task });
      const result = await new Promise<SecretRequest>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const signal = call.callContext.signal;
        const cleanup = () => {
          clearTimeout(timer);
          off();
          signal?.removeEventListener("abort", cancel);
        };
        const finish = (value: SecretRequest) => {
          if (value.id !== request.id || value.status === "pending") {
            return;
          }
          cleanup();
          resolve(value);
        };
        const off = call.deps.bus.on("secret.request.updated", ({ request: updated }) =>
          finish(updated),
        );
        const delay = Math.max(0, Date.parse(request.expiresAt) - Date.parse(call.now()));
        const respond = (status: "timed_out" | "cancelled") => {
          void secrets.requests
            .respond(
              request.id,
              taskId,
              { status },
              status === "timed_out" ? request.expiresAt : call.now(),
            )
            .then((updated) => {
              if (updated) {
                call.deps.bus.emit({ type: "secret.request.updated", request: updated });
              }
            })
            .catch((error: unknown) => {
              cleanup();
              reject(error);
            });
        };
        const cancel = () => respond("cancelled");
        timer = setTimeout(() => respond("timed_out"), delay);
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) {
          cancel();
        }
        // Close the race between request creation and listener registration.
        void secrets.requests.get(request.id, taskId, call.now()).then(
          (updated) => {
            if (updated) {
              finish(updated);
            }
          },
          (error: unknown) => {
            cleanup();
            reject(error);
          },
        );
      });
      const recent = await tasks.items.recent(taskId, ["secret_request"], 200);
      const pending = await Promise.all(
        recent.map((item) =>
          item.kind === "secret_request"
            ? secrets.requests.get(item.payload.requestId, taskId, call.now())
            : null,
        ),
      );
      // Questions from ask_user keep the task waiting on the person (v0.4).
      const updated = await tasks.update(taskId, (current) => ({
        ...(current.needsUser === "question" &&
        !current.pendingQuestions?.length &&
        !pending.some((item) => item?.status === "pending")
          ? { needsUser: null }
          : {}),
      }));
      call.deps.bus.emit({ type: "task.updated", task: updated });
      return json(requestResult(result));
    },
  );
}

function requestResult(request: SecretRequest) {
  return {
    requestId: request.id,
    status: request.status,
    ...(request.status === "saved" ? { secretRef: request.secretRef } : {}),
  };
}
