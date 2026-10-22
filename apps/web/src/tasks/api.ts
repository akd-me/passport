import type {
  Page,
  Task,
  TaskDetail,
  TaskInteractionMode,
  TaskItem,
  TaskMessageMode,
  TaskPatch,
  TaskRun,
  TrustLevel,
} from "@passport/types";
import { queryString, request } from "../api";

/** `POST /api/tasks` body (docs/tasks.md); the route rejects any other field. */
export interface NewTaskInput {
  message: string;
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
/** The sidebar list: everything except archived tasks. */
export const LIST_QUERY = queryString({
  status: ["inbox", "working", "snoozed", "settled"],
  limit: 200,
});
export const ITEMS_PAGE = 100;

const path = (id: string, rest = "") => `/tasks/${encodeURIComponent(id)}${rest}`;
const send = <T>(url: string, method: string, body?: unknown) =>
  request<T>(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const taskApi = {
  list: (query = LIST_QUERY) => request<Page<Task>>(`/tasks${query}`),
  get: (id: string, signal?: AbortSignal) => request<TaskDetail>(path(id), { signal }),
  items: (id: string, afterSeq: number, limit = ITEMS_PAGE) =>
    request<TaskItemsPage>(path(id, `/items${queryString({ afterSeq, limit })}`)),
  create: (input: NewTaskInput) => send<{ task: Task; run: TaskRun }>("/tasks", "POST", input),
  message: (id: string, text: string, mode: TaskMessageMode = "queue") =>
    send<{ task: Task; run: TaskRun }>(path(id, "/messages"), "POST", { text, mode }),
  interrupt: (id: string) => send<Task>(path(id, "/interrupt"), "POST"),
  snooze: (id: string, until: string) => send<Task>(path(id, "/snooze"), "POST", { until }),
  settle: (id: string) => send<Task>(path(id, "/settle"), "POST"),
  archive: (id: string) => send<Task>(path(id, "/archive"), "POST"),
  pin: (id: string, pinned: boolean) => send<Task>(path(id, pinned ? "/pin" : "/unpin"), "POST"),
  unwatch: (id: string, threadHandle?: string) =>
    send<Task>(path(id, "/unwatch"), "POST", threadHandle ? { threadHandle } : {}),
  patch: (id: string, patch: TaskPatch) => send<Task>(path(id), "PATCH", patch),
};
