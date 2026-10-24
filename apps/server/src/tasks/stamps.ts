import type { Task } from "@passport/types";

/**
 * Derived fields applied to every task write (`TaskRunner.updateTask`), so no call site has to
 * remember them:
 * - `returnedAt` follows `lastActivityAt`, which moves only when the task comes back to the
 *   person or they act on it (T3's inbox order: created, reopened, run requested, handed back).
 * - Renaming a generated title (any title change that does not say otherwise) clears
 *   `titleGenerated`.
 */
export function stampTask(
  task: Task,
  patch: Partial<Task> | ((task: Task) => Partial<Task>),
): Partial<Task> {
  const changes = typeof patch === "function" ? patch(task) : patch;
  const stamped: Partial<Task> = { ...changes };
  if (changes.lastActivityAt !== undefined && changes.returnedAt === undefined) {
    stamped.returnedAt = changes.lastActivityAt;
  }
  const renamed = changes.title !== undefined && changes.title !== task.title;
  if (renamed && changes.titleGenerated === undefined && task.titleGenerated) {
    stamped.titleGenerated = false;
  }
  return stamped;
}
