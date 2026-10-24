/**
 * Additive contract (v0.4, review R1): account scope for task runs, transcript persistence,
 * secret requests on the task row, the run's request texts, and the shared task stamping rule.
 * Re-exported from `./index.ts`.
 */

import type { Task, TaskNeedsUser } from "./tasks.js";

declare module "./tasks.js" {
  interface Task {
    /**
     * Open `request_secret` requests of this task (ids). Like `pendingQuestions`, they keep the
     * task waiting on the person (`needsUser: "question"` unless an approval is pending).
     */
    pendingSecretRequestIds?: string[];
  }
  interface TaskRun {
    /**
     * The request texts this run was started with, oldest first (the person's messages, a
     * steer's combined messages, or the framed notification of a wake). Continuations rebuild
     * their prompt from it.
     */
    request?: string[];
  }
}

declare module "./agent-ondemand.js" {
  interface AgentRunOptions {
    /**
     * Accounts the run's tools may use (`Task.accountIds`). Reads and writes on any other
     * account fail with `ACCOUNT_FORBIDDEN`; absent means every connected account.
     */
    accountIds?: string[];
  }
}

declare module "./agent-session.js" {
  interface AgentSessionRunOptions {
    /**
     * Keep the CLI transcript so a later run can resume this session, and record its id on the
     * task. Default: true only when the run can resume (`resume` or `resolveResume` is set) and
     * is not voice learning. Arrivals, routines and other one-off runs run without a transcript
     * (`--no-session-persistence`, Codex `--ephemeral`). `false` also skips any resume.
     */
    persist?: boolean;
  }
}

/**
 * Derived fields applied to every task write, so no call site has to remember them:
 * - `returnedAt` follows `lastActivityAt`, which moves only when the task comes back to the
 *   person or they act on it.
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

/**
 * What the task waits on the person for: approvals first, then questions and open secret
 * requests. A subtask's questions wait on its parent task, never on the person; its secret
 * requests still wait on the person, who alone can answer them.
 */
export function taskWaitingOn(
  task: Pick<Task, "pendingActionIds" | "pendingQuestions" | "pendingSecretRequestIds"> &
    Partial<Pick<Task, "delegation">>,
): TaskNeedsUser {
  if (task.pendingActionIds?.length) {
    return "approval";
  }
  if (task.pendingQuestions?.length && !task.delegation) {
    return "question";
  }
  if (task.pendingSecretRequestIds?.length) {
    return "question";
  }
  return null;
}
