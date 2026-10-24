import type { Task, TaskLineage, TaskRun } from "@passport/types";
import { request } from "../api";

const path = (id: string, rest: string) => `/tasks/${encodeURIComponent(id)}${rest}`;
const post = <T>(url: string, body: unknown = {}) =>
  request<T>(url, { method: "POST", body: JSON.stringify(body) });

/** v0.4 (W2A): answer or dismiss a question, and the Lineage panel (docs/tasks.md). */
export const orchestrationApi = {
  answer: (taskId: string, itemId: string, text: string) =>
    post<{ task: Task; run: TaskRun }>(
      path(taskId, `/questions/${encodeURIComponent(itemId)}/answer`),
      { text },
    ),
  dismiss: (taskId: string, itemId: string) =>
    post<Task>(path(taskId, `/questions/${encodeURIComponent(itemId)}/dismiss`)),
  lineage: (taskId: string) => request<TaskLineage>(path(taskId, "/lineage")),
};
