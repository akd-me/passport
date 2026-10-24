import type {
  Page,
  Task,
  TaskDetail,
  TaskInteractionMode,
  TaskItem,
  TaskMessageMode,
  TaskPatch,
  TaskQueue,
  TaskRun,
  TaskWithPrevious,
  TrustLevel,
} from "@passport/types";
import { queryString, request } from "../api";

/** `POST /api/tasks` body (docs/tasks.md); older servers reject `matterId` and `emailIds`. */
export interface NewTaskInput {
  message: string;
  /** Context the agent reads through its tools, as ids (never as text in `message`). */
  matterId?: string;
  emailIds?: string[];
  title?: string;
  accountIds?: string[];
  permissionMode?: TrustLevel;
  interactionMode?: TaskInteractionMode;
  parentTaskId?: string;
}
export interface TaskItemsPage {
  items: TaskItem[];
  lastSeq: number;
}
export const ITEMS_PAGE = 100;

const path = (id: string, rest = "") => `/tasks/${encodeURIComponent(id)}${rest}`;
const send = <T>(url: string, method: string, body?: unknown) =>
  request<T>(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const taskApi = {
  list: (query: string) => request<Page<Task>>(`/tasks${query}`),
  get: (id: string, signal?: AbortSignal) => request<TaskDetail>(path(id), { signal }),
  /** The task holding an action, for `?decision=` links; 404 when unknown or on older servers. */
  byAction: (actionId: string) =>
    request<{ taskId: string; runId?: string | null }>(
      `/tasks/by-action/${encodeURIComponent(actionId)}`,
    ),
  items: (id: string, afterSeq: number, limit = ITEMS_PAGE) =>
    request<TaskItemsPage>(path(id, `/items${queryString({ afterSeq, limit })}`)),
  create: (input: NewTaskInput) => send<{ task: Task; run: TaskRun }>("/tasks", "POST", input),
  message: (id: string, text: string, mode: TaskMessageMode = "queue") =>
    send<{ task: Task; run: TaskRun }>(path(id, "/messages"), "POST", { text, mode }),
  interrupt: (id: string) => send<Task>(path(id, "/interrupt"), "POST"),
  /** Settle, snooze and archive answer with `previous` (v0.4); older servers send the task alone. */
  snooze: (id: string, until: string) =>
    send<Partial<TaskWithPrevious> & Task>(path(id, "/snooze"), "POST", { until }),
  settle: (id: string) => send<Partial<TaskWithPrevious> & Task>(path(id, "/settle"), "POST"),
  archive: (id: string) => send<Partial<TaskWithPrevious> & Task>(path(id, "/archive"), "POST"),
  /** Reopen a settled, snoozed or archived task; unchanged when it is not in that state. */
  reopen: (id: string, from: "settled" | "snoozed" | "archived") =>
    send<TaskWithPrevious>(
      path(id, { settled: "/unsettle", snoozed: "/unsnooze", archived: "/unarchive" }[from]),
      "POST",
    ),
  seen: (id: string) => send<Task>(path(id, "/seen"), "POST"),
  markUnread: (id: string) => send<Task>(path(id, "/mark-unread"), "POST"),
  /** Continue a run stopped at a usage limit now (`run` is null when the stopped run is gone). */
  resume: (id: string) => send<{ task: Task; run: TaskRun | null }>(path(id, "/resume"), "POST"),
  resumeAtReset: (id: string) => send<Task>(path(id, "/resume-at-reset"), "POST"),
  pin: (id: string, pinned: boolean) => send<Task>(path(id, pinned ? "/pin" : "/unpin"), "POST"),
  unwatch: (id: string, threadHandle?: string) =>
    send<Task>(path(id, "/unwatch"), "POST", threadHandle ? { threadHandle } : {}),
  patch: (id: string, patch: TaskPatch) => send<Task>(path(id), "PATCH", patch),
};

const entry = (id: string, runId: string, rest = "") =>
  path(id, `/queue/${encodeURIComponent(runId)}${rest}`);

/** The follow-up queue (`/api/tasks/:id/queue`); every change answers with the whole queue. */
export const queueApi = {
  get: (id: string) => request<TaskQueue>(path(id, "/queue")),
  edit: (id: string, runId: string, text: string) =>
    send<TaskQueue>(entry(id, runId), "PATCH", { text }),
  reorder: (id: string, runIds: string[]) =>
    send<TaskQueue>(path(id, "/queue/reorder"), "POST", { runIds }),
  remove: (id: string, runId: string) => send<TaskQueue>(entry(id, runId), "DELETE"),
  promote: (id: string, runId: string) =>
    send<{ task: Task; run: TaskRun }>(entry(id, runId, "/promote-to-steer"), "POST"),
  resume: (id: string) => send<TaskQueue>(path(id, "/queue/resume"), "POST"),
};
