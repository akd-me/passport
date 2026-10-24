/**
 * Additive contract (v0.3 wave 2): tasks. A task is the unit of agent work, the email analogue of
 * a T3 Code thread: a durable conversation with runs, a streamed item timeline, approvals and a
 * server-owned lifecycle (inbox ↔ working ↔ snoozed ↔ settled). See `docs/design/on-demand.md`
 * §3–4.3 and `docs/tasks.md` (HTTP + WebSocket contract). Re-exported from `./index.ts`.
 *
 * Every string in a `TaskItem.payload` that came from a provider (subjects, senders, snippets,
 * tool results) is untrusted data; items carrying such strings set `untrusted: true` and have
 * their command sigils neutralized. Clients render them as plain text.
 */

import type { AgentRunOptions, AgentRunPriority } from "./agent-ondemand.js";
import type {
  ActionCategory,
  AgentRun,
  AgentTrigger,
  Id,
  MailRow,
  Page,
  Reversibility,
  RiskLevel,
  Timestamp,
  TrustLevel,
} from "./index.js";

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

/** Sidebar section. `working` = running or monitoring; `inbox` = came back to the person. */
export type TaskStatus = "inbox" | "working" | "snoozed" | "settled" | "archived";
export const TASK_STATUSES: readonly TaskStatus[] = [
  "inbox",
  "working",
  "snoozed",
  "settled",
  "archived",
];

/** `task` = started by a person or agent; `inbox` = per-account arrivals; `routine` = scheduled job. */
export type TaskKind = "task" | "inbox" | "routine";
export type TaskCreatedBy = "user" | "agent" | "system";
/** `plan` = investigate read-only and return a proposal list; write tools never execute. */
export type TaskInteractionMode = "default" | "plan";
/**
 * Why the task is in the person's inbox. Null = nothing pending. `question` is reserved.
 * `limited` (v0.4): a run stopped at a subscription or provider usage limit (`Task.limited`).
 */
export type TaskNeedsUser = null | "approval" | "question" | "failure" | "limited";

/** `watch_conversation`: wake the task when someone else replies on this conversation. */
export interface ConversationWatch {
  /** Opaque thread handle (`MailRow.threadId`). */
  threadHandle: string;
  /** Account id the thread belongs to. */
  account: Id;
  /** Only messages received after this wake the task. */
  since: Timestamp;
  lastWakeAt?: Timestamp;
  /** Wakes in a row that were auto-replies or produced nothing; 3 stops the watch. */
  consecutiveWakes: number;
}

export interface Task {
  /** One-time, bounded Sent sampling on first connect (v0.4). Trusted server metadata. */
  voiceLearning?: { accountId: Id; sentContainer: string };
  id: Id;
  title: string;
  accountIds: Id[];
  status: TaskStatus;
  pinned: boolean;
  snoozedUntil?: Timestamp | null;
  /** Clamped to the global trust dial and, for child tasks, to the parent's mode. */
  permissionMode: TrustLevel;
  interactionMode: TaskInteractionMode;
  createdBy: TaskCreatedBy;
  kind: TaskKind;
  parentTaskId?: Id | null;
  needsUser: TaskNeedsUser;
  lastActivityAt: Timestamp;
  createdAt: Timestamp;
  settledAt?: Timestamp | null;
  watches: ConversationWatch[];
  /**
   * The person chose `permissionMode` explicitly (PATCH). System tasks (inbox, routine) without it
   * follow the global trust dial: their mode is refreshed to it before each run.
   */
  permissionModePinned?: boolean;
  /** Proposed ActionRecords from this task's runs still awaiting a decision (approval panel). */
  pendingActionIds?: Id[];
  /** Routine tasks: the scheduler job bound to this task. */
  jobId?: string | null;
  /** Monotonic, incremented on every persisted change. */
  revision?: number;
  /**
   * "Approve for this task" grants (`POST /api/actions/:id/approve` with `scope: "task"`): later
   * proposals of the same category in this task are approved without asking, within the bounds
   * the grant recorded. Append-only.
   */
  approvalGrants?: TaskApprovalGrant[];
  /**
   * v0.4: when the task last came back to the person (T3's inbox order): created, reopened, a run
   * requested by the person, or a run that handed it back. Moves with `lastActivityAt`; absent
   * on rows written before v0.4 (fall back to `lastActivityAt`).
   */
  returnedAt?: Timestamp | null;
  /** v0.4: when the person last marked the task seen (`POST /api/tasks/:id/seen`). */
  seenAt?: Timestamp | null;
  /** v0.4: an outcome the person has not seen yet: `done` (their run finished) or `woke`. */
  unseenOutcome?: TaskUnseenOutcome;
  /** v0.4: follow-ups waiting behind the active run, in run order (`/api/tasks/:id/queue`). */
  queue?: TaskQueueEntry[];
  /** v0.4: the queue stopped after `/interrupt` (or settle, archive) until resumed. */
  queueHeld?: boolean;
  /** v0.4: the last run hit a usage limit; set with `needsUser: "limited"`. */
  limited?: TaskLimited | null;
  /** v0.4: the title was proposed by the fast model; false once the person renames. */
  titleGenerated?: boolean;
}

/** `done`: a run the person started finished. `woke`: the task woke itself and came back. */
export type TaskUnseenOutcome = "done" | "woke" | null;

/** A queued follow-up. `runId` is the TaskRun (status `queued`) it becomes when it starts. */
export interface TaskQueueEntry {
  runId: Id;
  text: string;
  createdAt: Timestamp;
}

/** `GET /api/tasks/:id/queue` and every queue mutation. */
export interface TaskQueue {
  taskId: Id;
  held: boolean;
  entries: TaskQueueEntry[];
}

/** Where a usage limit came from: the host CLI's subscription, or an API provider's 429. */
export type TaskLimitSource = "host_agent" | "provider";

/** `Task.limited`: the run that hit the limit and how it recovers. */
export interface TaskLimited {
  /** The TaskRun that stopped; `/resume` continues it. */
  runId: Id;
  /** When the limit resets, if the CLI or provider said so. */
  resetAt: Timestamp | null;
  /** `/resume-at-reset` was requested: the server continues the run at `resetAt`. */
  autoResume: boolean;
  source: TaskLimitSource;
  at: Timestamp;
}

/** The fields settle, snooze and archive replace, as they were before (for undo). */
export interface TaskRestoreState {
  status: TaskStatus;
  snoozedUntil: Timestamp | null;
  settledAt: Timestamp | null;
}

/** Response of settle, snooze, archive and the reopen routes: the task plus what it was. */
export type TaskWithPrevious = Task & { previous: TaskRestoreState };

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type TaskRunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";

/** What started a run. `wake` = a watched conversation changed. */
export type TaskRunTrigger =
  | { kind: "message"; itemId: Id; mode: TaskMessageMode }
  | { kind: "arrival"; emailId: Id }
  | { kind: "schedule"; jobId: string; name: string }
  | { kind: "watch"; threadHandle: string; emailId: Id }
  | { kind: "wake"; reason: string };

export interface TaskRunUsage {
  llmCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface TaskRun {
  id: Id;
  taskId: Id;
  status: TaskRunStatus;
  trigger: TaskRunTrigger;
  priority: AgentRunPriority;
  /** The agent runtime's run id (`ActionRequest.runId`); equals `id` for task-started runs. */
  agentRunId: Id;
  createdAt: Timestamp;
  startedAt?: Timestamp | null;
  endedAt?: Timestamp | null;
  summary?: string | null;
  /** ActionRecords created during the run: the per-run change summary with undo links. */
  actionIds: Id[];
  usage?: TaskRunUsage | null;
  error?: string | null;
  /** v0.4: this run continues one a server restart interrupted (continued at most once). */
  restartOf?: Id | null;
}

// ---------------------------------------------------------------------------
// Items (the timeline)
// ---------------------------------------------------------------------------

export type TaskItemKind =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "approval_request"
  | "question"
  | "system_notice"
  | "notification"
  | "secret_request";

export interface TaskToolCallPayload {
  name: string;
  /** Redacted, at most 200 characters. */
  inputSummary: string;
  /** Redacted, at most 200 characters. */
  resultSummary: string;
  cost?: Record<string, number>;
  durationMs: number;
  isError: boolean;
  /** Write tool in plan mode: recorded as a proposal, not executed. */
  planned?: boolean;
}

export interface TaskItemPayloads {
  secret_request: { requestId: string; text: string; expiresAt: Timestamp };
  user_message: { text: string };
  assistant_message: { text: string };
  tool_call: TaskToolCallPayload;
  approval_request: { actionId: Id; summary: string };
  question: { text: string };
  system_notice: { text: string; code?: string };
  /** Monitor or trigger context, e.g. a new arrival with its `MailRow`. */
  notification: {
    source: "arrival" | "watch" | "schedule" | "system";
    summary: string;
    row?: MailRow;
  };
}

export type TaskItem = {
  [K in TaskItemKind]: {
    id: Id;
    /** Null for items outside a run (e.g. a lifecycle notice). */
    runId: Id | null;
    taskId: Id;
    /** Per-task monotonic sequence, starting at 1. Page with `afterSeq`. */
    seq: number;
    kind: K;
    at: Timestamp;
    payload: TaskItemPayloads[K];
    /** Payload strings include provider-derived data (neutralized); render as plain text. */
    untrusted?: boolean;
  };
}[TaskItemKind];

/** An item before the store assigns `id` and `seq`. */
export type TaskItemInput = TaskItem extends unknown ? Omit<TaskItem, "id" | "seq"> : never;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** `queue` = run after the active run; `steer` = cancel it (when cancellable) and restart. */
export type TaskMessageMode = "queue" | "steer";

export interface TaskMessage {
  text: string;
  mode?: TaskMessageMode;
}

export interface CreateTaskInput {
  title?: string;
  accountIds?: Id[];
  permissionMode?: TrustLevel;
  interactionMode?: TaskInteractionMode;
  parentTaskId?: Id | null;
  createdBy?: TaskCreatedBy;
  message: string;
  /** Composer context forwarded to the run (`/api/agent/run` compatibility). */
  emailIds?: Id[];
  matterId?: Id;
}

export interface TaskPatch {
  title?: string;
  permissionMode?: TrustLevel;
  interactionMode?: TaskInteractionMode;
}

export interface TaskQuery {
  status?: TaskStatus[];
  kind?: TaskKind[];
  pinned?: boolean;
  limit?: number;
  /** Opaque cursor from `Page.nextCursor`. Order: lastActivityAt desc, id desc. */
  cursor?: string | null;
}

/** `GET /api/tasks/:id` */
export interface TaskDetail {
  task: Task;
  /** Newest first, at most 50. */
  runs: TaskRun[];
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface StoreTasks {
  get(id: Id): Promise<Task | null>;
  list(q?: TaskQuery): Promise<Page<Task>>;
  insert(task: Task): Promise<Task>;
  /** Read-modify-write in one transaction; bumps `revision`. */
  update(id: Id, patch: Partial<Task> | ((task: Task) => Partial<Task>)): Promise<Task>;
  /** The system inbox task of an account, if created. */
  inboxFor(accountId: Id): Promise<Task | null>;
  routineFor(jobId: string): Promise<Task | null>;
  /** Tasks with at least one conversation watch. */
  watching(): Promise<Task[]>;
  runs: {
    get(id: Id): Promise<TaskRun | null>;
    byAgentRunId(agentRunId: Id): Promise<TaskRun | null>;
    list(taskId: Id, limit?: number): Promise<TaskRun[]>;
    /** Runs left `queued`/`running`/`waiting` (e.g. by a restart). */
    unfinished(): Promise<TaskRun[]>;
    /**
     * The newest run whose `actionIds` lists the action; with `agentRunId`, only that agent
     * run's TaskRuns are searched (indexed). Optional so other stores still conform.
     */
    byActionId?(actionId: Id, agentRunId?: Id): Promise<TaskRun | null>;
    insert(run: TaskRun): Promise<TaskRun>;
    update(
      id: Id,
      patch: Partial<TaskRun> | ((run: TaskRun) => Partial<TaskRun>),
    ): Promise<TaskRun>;
  };
  items: {
    /** Assigns `id` and the next `seq` atomically. */
    append(item: TaskItemInput): Promise<TaskItem>;
    list(q: { taskId: Id; afterSeq?: number; limit?: number }): Promise<TaskItem[]>;
    /** Newest items of a kind, newest first (prompt context). */
    recent(taskId: Id, kinds: TaskItemKind[], limit: number): Promise<TaskItem[]>;
  };
}

declare module "./index.js" {
  interface Store {
    /** Tasks, runs and items (v0.3). Optional so other Store implementations still conform. */
    tasks?: StoreTasks;
  }
  interface AgentRuntime {
    run(trigger: AgentTrigger, options?: AgentRunOptions): Promise<AgentRun>;
  }
}

// ---------------------------------------------------------------------------
// Run hooks (agent runtime + tool registry)
// ---------------------------------------------------------------------------

/** One completed tool call, reported by the tool registry's observer. */
export interface ToolCallEvent {
  name: string;
  input: unknown;
  result: { isError?: boolean; [key: string]: unknown };
  durationMs: number;
  risk: "read" | "write";
  runId?: string;
  taskId?: string;
  /** Write tool skipped because the registry is read-only (plan mode). */
  planned?: boolean;
}

export interface AgentRunObserver {
  toolCall?(event: ToolCallEvent): void;
  /** Free-text model output (not structured JSON steps). */
  assistantMessage?(text: string): void;
}

declare module "./agent-ondemand.js" {
  interface AgentRunOptions {
    /** Trusted limits for the one-time voice-learning task; never model-supplied. */
    voiceLearning?: { accountId: Id; sentContainer: string };
    /** Use this run id instead of a generated one (task runs: `TaskRun.agentRunId`). */
    runId?: string;
    observer?: AgentRunObserver;
    /** Plan mode: write tools record a proposal instead of executing. */
    readOnly?: boolean;
    /** Task bound to this run; forwarded to tools as `ToolContext.taskId`. */
    taskId?: string;
    /** Cooperative cancellation, checked before each model call and tool call. */
    signal?: AbortSignal;
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type TaskEvent =
  | { type: "task.updated"; task: Task }
  | { type: "task.run.updated"; run: TaskRun }
  | { type: "task.item.appended"; item: TaskItem };

// ---------------------------------------------------------------------------
// Constants and pure helpers
// ---------------------------------------------------------------------------

export const TASK_LIMITS = {
  /** Tasks idle this long in `inbox` are settled by the `tasks.auto_settle` job. */
  autoSettleIdleMs: 3 * 86_400_000,
  /** A conversation watch older than this wakes the task once and ends. */
  watchMaxAgeMs: 14 * 86_400_000,
  /** Consecutive auto-reply / no-op wakes before a watch stops. */
  watchLoopLimit: 3,
  /** Replay key (RFC 822 Message-ID) memory for watch wakes. */
  watchReplayMs: 7 * 86_400_000,
  /** Replies on one thread within this window coalesce into one wake. */
  watchCoalesceMs: 120_000,
  titleMax: 60,
  summaryMax: 200,
  /** v0.4: queued follow-ups per task. */
  queueMax: 20,
} as const;

/** Title from the first message: whitespace collapsed, at most 60 characters. */
export function taskTitleFrom(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= TASK_LIMITS.titleMax) {
    return flat || "Untitled task";
  }
  return `${flat.slice(0, TASK_LIMITS.titleMax - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Approval scopes (v0.3: "approve for this task" / "always")
// ---------------------------------------------------------------------------

/**
 * `POST /api/actions/:id/approve` `{ scope }`. `once` (default) approves this action only.
 * `task` also approves later proposals of the same category in the same task. `always` pins the
 * category's trust level when the trust ladder can express it, and otherwise acts as `task`.
 */
export type ApprovalScope = "once" | "task" | "always";
export const APPROVAL_SCOPES: readonly ApprovalScope[] = ["once", "task", "always"];

/**
 * One "approve for this task" grant. A later proposal is approved automatically only when it is
 * no riskier and no less reversible than the approved one, and when its effective trust level
 * (global dial, ladder, task mode) is at least `trustLevel`: lowering any of them voids the grant.
 */
export interface TaskApprovalGrant {
  category: ActionCategory;
  /** The approved action that created the grant. */
  actionId: Id;
  /** `decision.trustLevel` of that action. */
  trustLevel: TrustLevel;
  risk: RiskLevel;
  reversibility: Reversibility;
  grantedAt: Timestamp;
}

/** What `scope` did, returned with the approved `ActionRecord` as `approvalScope`. */
export interface ApprovalScopeResult {
  requested: ApprovalScope;
  /** `always` falls back to `task` when no trust pin can express it. */
  applied: ApprovalScope;
  taskId?: Id;
  /** The level `always` pinned for the category, when it pinned one. */
  pinnedLevel?: TrustLevel;
  /** Stable code when `always` fell back: `ALWAYS_UNAVAILABLE`. */
  code?: string;
}

/** `GET /api/tasks/by-action/:actionId` */
export interface TaskByAction {
  taskId: Id;
  runId: Id;
}

// ---------------------------------------------------------------------------
// v0.4 lifecycle: the Working predicate and the badge vocabulary
// ---------------------------------------------------------------------------

/** One status vocabulary for the sidebar, the task header, Needs you and the menu bar. */
export type TaskBadge =
  | "approval"
  | "input"
  | "working"
  | "waiting"
  | "limited"
  | "failed"
  | "woke"
  | "done";

/** What the task row alone does not say: how many of its runs are queued or running. */
export interface TaskActivity {
  activeRuns: number;
}

/**
 * T3's `isThreadWorking` over a task: not while it waits on the person (approval, question,
 * failure, limit); otherwise working while a run is active or a conversation is watched.
 */
export function isTaskWorking(
  task: Pick<Task, "needsUser" | "watches">,
  activity: TaskActivity,
): boolean {
  if (task.needsUser) {
    return false;
  }
  return activity.activeRuns > 0 || task.watches.length > 0;
}

/**
 * The single badge for a task, highest priority first: approval, input (question), working
 * (a run is active), waiting (watching), limited, failed, woke, done; null when nothing is new.
 */
export function taskBadge(
  task: Pick<Task, "needsUser" | "watches" | "unseenOutcome">,
  activity: TaskActivity,
): TaskBadge | null {
  if (task.needsUser === "approval") {
    return "approval";
  }
  if (task.needsUser === "question") {
    return "input";
  }
  if (isTaskWorking(task, activity)) {
    return activity.activeRuns > 0 ? "working" : "waiting";
  }
  if (task.needsUser === "limited") {
    return "limited";
  }
  if (task.needsUser === "failure") {
    return "failed";
  }
  return task.unseenOutcome ?? null;
}
