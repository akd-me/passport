import type { JobDefinition } from "@passport/scheduler";
import type { Backend } from "../backend.js";

/** `{ taskId }` binding a model-backed job to its routine task, or `{}` without tasks. */
export async function routineBinding(
  backend: Backend,
  jobId: string,
  name: string,
): Promise<Pick<JobDefinition, "taskId">> {
  const task = await backend.tasks?.triggers.ensureRoutine(jobId, name);
  return task ? { taskId: task.id } : {};
}

/** `tasks.maintenance`: snoozed tasks whose time came, 3-day auto-settle, 14-day watch expiry. */
export async function registerTaskJobs(
  backend: Backend,
  register: (def: JobDefinition) => Promise<void>,
): Promise<void> {
  const tasks = backend.tasks;
  if (!tasks) {
    return;
  }
  await register({
    id: "tasks.maintenance",
    name: "Task maintenance",
    kind: "system",
    schedule: { type: "interval", everyMs: 10 * 60_000 },
    concurrency: "single",
    run: async () => ({ summary: await tasks.maintain() }),
  });
}
