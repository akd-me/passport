import type { JobDefinition } from "@passport/scheduler";
import type { Backend } from "../backend.js";
import { logger } from "../logger.js";
import { sweepExports } from "../ondemand-wiring.js";

/** `{ taskId }` binding a model-backed job to its routine task, or `{}` without tasks. */
export async function routineBinding(
  backend: Backend,
  jobId: string,
  name: string,
): Promise<Pick<JobDefinition, "taskId">> {
  const task = await backend.tasks?.triggers.ensureRoutine(jobId, name);
  return task ? { taskId: task.id } : {};
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
