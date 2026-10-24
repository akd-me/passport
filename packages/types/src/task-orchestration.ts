/**
 * Additive contract (v0.4, W2A): questions, subtasks and self-organisation. The agent asks the
 * person a question (`ask_user`), delegates work to child tasks (`task_delegate`, `task_status`,
 * `task_cancel`) and organises its own task (`task_organize`). T3 Code's pending `user_input`
 * requests, `delegate_task` and `t3_thread_organize`, adapted to tasks. See `docs/tasks.md`
 * ("Questions", "Subtasks", "Organise") and `docs/tools.md`. Re-exported from `./index.ts`.
 */

import type { Id, Timestamp, TrustLevel } from "./index.js";
import type { Task, TaskNeedsUser, TaskRun, TaskRunStatus, TaskStatus } from "./tasks.js";

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/** A `question` item still waiting for an answer (`Task.pendingQuestions`). */
export interface TaskPendingQuestion {
  /** The `question` item; answer or dismiss with `/api/tasks/:id/questions/:itemId/…`. */
  itemId: Id;
  runId: Id | null;
  /** The agent's question (neutralized model text). */
  text: string;
  /** Suggested answers, at most 6. */
  options?: string[];
  /** The run ended to wait for the answer. */
  blocking: boolean;
  askedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Subtasks
// ---------------------------------------------------------------------------

/** `async`: carry on and hear back later. `wait`: end the turn; the parent wakes with the result. */
export type TaskDelegateMode = "async" | "wait";

/**
 * When a finished subtask wakes its parent. `always`: on every completion. `settled_only`
 * (default): once none of the parent's subtasks is still working. A child's question and a
 * `wait` child always wake the parent. Completions that arrive before the wake starts join it.
 */
export type TaskCompletionWake = "always" | "settled_only";

/** Set on a task started by `task_delegate` (a subtask). Absent on every other task. */
export interface TaskDelegation {
  /** The parent run that delegated it. */
  parentRunId: Id | null;
  mode: TaskDelegateMode;
  completionWake: TaskCompletionWake;
  /** 1 for a child of a top-level task, 2 for a grandchild; never more. */
  depth: number;
  delegatedAt: Timestamp;
  /** The parent stopped it with `task_cancel`; its end does not wake the parent. */
  cancelledByParent?: boolean;
}

declare module "./tasks.js" {
  interface Task {
    /** v0.4: questions the agent asked that wait for an answer, oldest first. */
    pendingQuestions?: TaskPendingQuestion[];
    /** v0.4: present on subtasks (`kind: "task"` with `parentTaskId`). */
    delegation?: TaskDelegation | null;
    /** v0.4: subtasks started with `mode: "wait"` that have not finished; the task rests in Working. */
    waitingOnTaskIds?: Id[];
    /** v0.4: `task_organize` settle, applied when the run ends unless something waits on the person. */
    settleRequested?: boolean;
  }
  interface TaskQueueEntry {
    /** v0.4: the `question` items this queued message answers. */
    answers?: Id[];
  }
  interface TaskQuery {
    /** v0.4: only the children of this task. */
    parentTaskId?: Id;
  }
}

/** Where a subtask stands, from its parent's point of view (`task_status`). */
export type TaskWorkState =
  /** A run is queued or running. */
  | "working"
  /** It asked a question its parent should answer (`task_delegate` with its `taskId`). */
  | "question"
  /** A proposal, failure or usage limit waits on the person. */
  | "needs_person"
  /** Its last run finished; `result` holds the reply. */
  | "result_available"
  | "failed"
  | "cancelled";

/** `task_status`, `task_delegate` and `task_cancel` results: one subtask. */
export interface TaskSubtaskStatus {
  taskId: Id;
  title: string;
  workState: TaskWorkState;
  status: TaskStatus;
  needsUser: TaskNeedsUser;
  mode: TaskDelegateMode;
  completionWake: TaskCompletionWake;
  activeRuns: number;
  /** Queued follow-ups not started yet. */
  queued: number;
  pendingApprovals: number;
  pendingQuestion: Pick<TaskPendingQuestion, "itemId" | "text" | "options"> | null;
  lastRun: Pick<TaskRun, "id" | "status" | "error" | "endedAt"> | null;
  /** The child's last reply (untrusted model text, at most 2,000 characters). */
  result: string | null;
}

/** `GET /api/tasks/:id/lineage`: the Lineage panel. */
export interface TaskLineage {
  taskId: Id;
  /** The parent task, when this is a child. */
  parent: Task | null;
  /** Children, newest first, at most 50. */
  children: TaskLineageChild[];
}

export interface TaskLineageChild {
  task: Task;
  /** Queued or running runs (the Working predicate needs it). */
  activeRuns: number;
  lastRunStatus: TaskRunStatus | null;
}

// ---------------------------------------------------------------------------
// Organise
// ---------------------------------------------------------------------------

export type TaskOrganizeAction =
  | "snooze"
  | "unsnooze"
  | "settle"
  | "pin"
  | "unpin"
  | "rename"
  | "mark_unread";

export const TASK_ORGANIZE_ACTIONS: readonly TaskOrganizeAction[] = [
  "snooze",
  "unsnooze",
  "settle",
  "pin",
  "unpin",
  "rename",
  "mark_unread",
];

// ---------------------------------------------------------------------------
// The host seam the registry tools call
// ---------------------------------------------------------------------------

/** The trusted caller of an orchestration tool: the task and run it belongs to. */
export interface TaskToolCaller {
  taskId: Id;
  runId?: Id;
}

export interface TaskAskInput {
  text: string;
  options?: string[];
  blocking: boolean;
}

export interface TaskAskResult {
  itemId: Id;
  /** `pending`: the person sees it. `forwarded`: a subtask's question went to its parent task. */
  status: "pending" | "forwarded";
  blocking: boolean;
}

export interface TaskDelegateInput {
  message: string;
  title?: string;
  accountIds?: Id[];
  /** `inherit` (default) or a lower mode; never above the parent's effective mode. */
  permissionMode?: "inherit" | TrustLevel;
  mode: TaskDelegateMode;
  completionWake: TaskCompletionWake;
  /** Follow up on an existing subtask instead (answers its pending question). */
  taskId?: Id;
}

export interface TaskOrganizeInput {
  action: TaskOrganizeAction;
  /** `snooze`: future ISO time. */
  until?: Timestamp;
  /** `rename`: the new title. */
  title?: string;
}

export interface TaskOrganizeResult {
  action: TaskOrganizeAction;
  /** `now`, or `run_end` for settle. */
  applies: "now" | "run_end";
  task: Pick<Task, "id" | "title" | "status" | "pinned" | "snoozedUntil"> & {
    settleRequested: boolean;
  };
}

/**
 * Implemented by the server's task system and passed to each task run
 * (`AgentRunOptions.orchestrator`), so the registry tools can act on tasks without importing
 * the server. Without it the tools answer `TASK_REQUIRED`.
 */
export interface TaskOrchestrator {
  ask(caller: TaskToolCaller, input: TaskAskInput): Promise<TaskAskResult>;
  delegate(caller: TaskToolCaller, input: TaskDelegateInput): Promise<TaskSubtaskStatus>;
  /** The caller's subtasks, or one of them. */
  status(caller: TaskToolCaller, taskId?: Id): Promise<TaskSubtaskStatus[]>;
  cancel(caller: TaskToolCaller, taskId: Id): Promise<TaskSubtaskStatus>;
  organize(caller: TaskToolCaller, input: TaskOrganizeInput): Promise<TaskOrganizeResult>;
}

declare module "./agent-ondemand.js" {
  interface AgentRunOptions {
    /** Task runs: the host behind `ask_user`, `task_delegate`, `task_status`, `task_cancel`, `task_organize`. */
    orchestrator?: TaskOrchestrator;
  }
}

/** Bounds of the subtask tree. */
export const SUBTASK_LIMITS = {
  /** A top-level task's child is depth 1, its grandchild depth 2; nothing deeper. */
  maxDepth: 2,
  /** Subtasks of one task that may be working at once. */
  maxActive: 10,
  /** Suggested answers on a question. */
  maxOptions: 6,
  /** Pending questions per task. */
  maxPendingQuestions: 5,
} as const;
