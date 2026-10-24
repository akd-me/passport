import type { JobDefinition } from "@passport/scheduler";
import { newId } from "@passport/store";
import type { Task } from "@passport/types";
import type { Backend } from "../backend.js";
import { logger } from "../logger.js";
import { sweepExports } from "../ondemand-wiring.js";
import type { TaskService } from "./service.js";

/** `{ taskId }` binding a model-backed job to its routine task, or `{}` without tasks. */
export async function routineBinding(
  backend: Backend,
  jobId: string,
  name: string,
): Promise<Pick<JobDefinition, "taskId">> {
  const task = await backend.tasks?.triggers.ensureRoutine(jobId, name);
  return task ? { taskId: task.id } : {};
}

/** Each fresh run starts with no approvals, watches, history, or provider session of its parent. */
export async function freshRoutineTask(service: TaskService, parent: Task): Promise<Task> {
  const now = service.now();
  const task = await service.tasks.insert({
    id: newId(),
    title: parent.title,
    accountIds: [...parent.accountIds],
    kind: "task",
    parentTaskId: parent.id,
    permissionMode: await service.clampMode(parent.permissionMode, parent.id),
    interactionMode: parent.interactionMode,
    status: "inbox",
    pinned: false,
    createdBy: "system",
    needsUser: null,
    watches: [],
    pendingActionIds: [],
    createdAt: now,
    lastActivityAt: now,
  });
  service.options.bus.emit({ type: "task.updated", task });
  return task;
}

/** Exported-mail sweep; a failure never fails the maintenance job. */
async function sweep(backend: Backend): Promise<string> {
  try {
    return `${await sweepExports(backend.config.dataDir)} exports removed`;
  } catch {
    logger.warn("Scratch export sweep failed");
    return "export sweep failed";
  }
}

/**
 * `tasks.maintenance`: snoozed tasks whose time came, 3-day auto-settle, 14-day watch expiry,
 * and `mail_export` sessions older than 24 h (also swept once at registration, i.e. startup).
 */
export async function registerTaskJobs(
  backend: Backend,
  register: (def: JobDefinition) => Promise<void>,
): Promise<void> {
  const tasks = backend.tasks;
  if (!tasks) {
    return;
  }
  void sweep(backend);
  await register({
    id: "tasks.maintenance",
    name: "Task maintenance",
    kind: "system",
    schedule: { type: "interval", everyMs: 10 * 60_000 },
    concurrency: "single",
    run: async () => ({ summary: `${await tasks.maintain()}, ${await sweep(backend)}` }),
  });
}
