import type {
  DomainEvent,
  HostAgentKind,
  SetupLogEntry,
  SetupPrompt,
  SetupProvider,
  SetupStep,
  SetupTask,
  SetupTaskStatus,
} from "@passport/types";
import { request } from "./api";

/**
 * Agent-driven account setup: a host agent (Codex, else Claude Code) drives a visible browser
 * to create the user's own OAuth client, asking the user to sign in and approve.
 * Changes also arrive on the WebSocket as `setup.task.updated` with the full task.
 */
export type { SetupLogEntry, SetupPrompt, SetupProvider, SetupStep, SetupTask, SetupTaskStatus };

export interface StartSetupTask {
  provider: SetupProvider;
  calendar: boolean;
  /** Defaults to Codex when signed in, then Claude Code. */
  agent?: HostAgentKind;
}

const path = (id: string) => `/setup/tasks/${encodeURIComponent(id)}`;
const post = <T>(url: string, body: unknown) =>
  request<T>(url, { method: "POST", body: JSON.stringify(body) });

export const setupApi = {
  /** 409 SETUP_BUSY while another task runs; 400 DEMO_ONLY in the demo workspace. */
  start: (input: StartSetupTask) => post<{ id: string }>("/setup/tasks", input),
  get: (id: string) => request<SetupTask>(path(id)),
  /** Most recent first; the server keeps the last 20. */
  list: () => request<SetupTask[]>("/setup/tasks"),
  /** `answer` is `"done"` for sign_in/confirm prompts, free text for questions. */
  respond: (id: string, promptId: string, answer: string) =>
    post<SetupTask>(`${path(id)}/respond`, { promptId, answer }),
  cancel: (id: string) => post<SetupTask>(`${path(id)}/cancel`, {}),
};

export const isSetupTaskFinished = (task: Pick<SetupTask, "status">) =>
  task.status === "completed" || task.status === "failed" || task.status === "cancelled";
export const isFinished = isSetupTaskFinished;

/** The task carried by a WebSocket event, if it is a setup update for `id`. */
export function setupTaskFromEvent(event: DomainEvent, id?: string): SetupTask | undefined {
  if (event.type !== "setup.task.updated") return;
  return !id || event.task.id === id ? event.task : undefined;
}
