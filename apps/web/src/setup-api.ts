import { request } from "./api";

/** Agent-driven account setup: a host agent registers the OAuth client and connects the mailbox. */
export type SetupProvider = "gmail" | "microsoft";
export type SetupTaskStatus =
  | "running"
  | "waiting_for_user"
  | "completed"
  | "failed"
  | "cancelled";
export interface SetupStep {
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "failed";
  detail?: string;
}
export interface SetupPrompt {
  id: string;
  kind: "sign_in" | "confirm" | "question";
  message: string;
}
export interface SetupTask {
  id: string;
  provider: SetupProvider;
  status: SetupTaskStatus;
  steps: SetupStep[];
  prompt?: SetupPrompt;
  result?: { accountIds: string[] };
  error?: string;
  log: Array<{ at: string; level: "info" | "warn" | "error"; text: string }>;
}
export const isFinished = (task: SetupTask) =>
  task.status === "completed" ||
  task.status === "failed" ||
  task.status === "cancelled";
const path = (id: string) => `/setup/tasks/${encodeURIComponent(id)}`;
const post = <T>(url: string, body?: unknown) =>
  request<T>(url, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
export const setupApi = {
  start: (input: { provider: SetupProvider; calendar: boolean }) =>
    post<{ id: string }>("/setup/tasks", input),
  get: (id: string) => request<SetupTask>(path(id)),
  respond: (id: string, promptId: string, answer: string) =>
    post<SetupTask>(`${path(id)}/respond`, { promptId, answer }),
  cancel: (id: string) => post<SetupTask>(`${path(id)}/cancel`),
};
