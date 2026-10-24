import { type SecretRequest, stampTask, type Task, taskWaitingOn } from "@passport/types";
import type { Context } from "./context.js";
import { neutralize } from "./ondemand-support.js";
import { json, ToolError } from "./presentation.js";
import { register } from "./register.js";
import { schema as z } from "./schema.js";

/** Longest `request_secret` wait. Host tool-call timeouts must exceed it (`ToolBeltListener`). */
export const MAX_SECRET_TIMEOUT_SECONDS = 600;

/** Await private input, returning only its one-use reference to the agent. */
export function registerSecrets(ctx: Context) {
  register(
    ctx,
    "request_secret",
    "Ask the person for a secret in a private task field. Never ask them to paste it in chat. Returns only status and a one-use secretRef, never the value. Reuse clientRequestId on retries to show one request.",
    {
      text: z.string().trim().min(1).max(1000),
      clientRequestId: z.string().trim().min(1).max(200),
      timeoutSeconds: z.number().int().min(10).max(MAX_SECRET_TIMEOUT_SECONDS).default(300),
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
      const task = await tasks.update(taskId, (current) =>
        stampTask(current, secretAsked(current, request.id, createdAt)),
      );
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
      const updated = await tasks.update(taskId, (current) =>
        stampTask(current, secretResolved(current, request.id)),
      );
      call.deps.bus.emit({ type: "task.updated", task: updated });
      return json(requestResult(result));
    },
  );
}

/**
 * A new secret request waits on the person like a question (docs/tasks.md "Status rules",
 * `question_asked`): approvals keep priority, a settled or archived task only records
 * `needsUser`, otherwise the task surfaces in the inbox.
 */
export function secretAsked(task: Task, requestId: string, now: string): Partial<Task> {
  const pendingSecretRequestIds = [
    ...(task.pendingSecretRequestIds ?? []).filter((id) => id !== requestId),
    requestId,
  ];
  const needsUser = taskWaitingOn({ ...task, pendingSecretRequestIds });
  if (task.status === "settled" || task.status === "archived") {
    return { pendingSecretRequestIds, needsUser };
  }
  if (task.status === "inbox" && task.needsUser === needsUser) {
    return { pendingSecretRequestIds };
  }
  return {
    pendingSecretRequestIds,
    status: "inbox",
    needsUser,
    snoozedUntil: null,
    lastActivityAt: now,
  };
}

/**
 * A secret request that ended (saved, timed out, cancelled): `needsUser` passes to the next thing
 * waiting on the person (`question_resolved`); a failure or limit stays.
 */
export function secretResolved(task: Task, requestId: string): Partial<Task> {
  const pendingSecretRequestIds = (task.pendingSecretRequestIds ?? []).filter(
    (id) => id !== requestId,
  );
  const next = taskWaitingOn({ ...task, pendingSecretRequestIds });
  if (next) {
    return { pendingSecretRequestIds, ...(task.needsUser === next ? {} : { needsUser: next }) };
  }
  return {
    pendingSecretRequestIds,
    ...(task.needsUser === "question" ? { needsUser: null } : {}),
  };
}

function requestResult(request: SecretRequest) {
  return {
    requestId: request.id,
    status: request.status,
    ...(request.status === "saved" ? { secretRef: request.secretRef } : {}),
  };
}
