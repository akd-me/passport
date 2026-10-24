import type { RoutineRunOn, WebhookDelivery, WebhookSchedule } from "@passport/types";
import { request } from "./api";
/** Scheduler HTTP wire types; the web app has no scheduler runtime dependency. */
export type JobSchedule =
  | WebhookSchedule
  | { type: "interval"; everyMs: number; jitterMs?: number }
  | { type: "daily"; at: string; timeZone?: string }
  | { type: "weekly"; days: number[]; at: string; timeZone?: string }
  | { type: "manual" };
export interface JobRun {
  runId: string;
  startedAt: string;
  durationMs: number;
  status: "ok" | "error" | "skipped";
  summary?: string;
}
export interface Job {
  taskId?: string;
  runOn?: RoutineRunOn;
  webhookUrl?: string;
  id: string;
  name: string;
  kind: "system" | "user";
  schedule: JobSchedule;
  enabled: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastStatus: JobRun["status"] | null;
  lastDurationMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextRunAt: string | null;
  runCount: number;
  history: JobRun[];
  routine?: { instruction: string };
}
export interface NewRoutine {
  runOn?: RoutineRunOn;
  name: string;
  schedule: JobSchedule;
  routine: { instruction: string };
}
const path = (id: string) => `/jobs/${encodeURIComponent(id)}`;
export const jobsApi = {
  deliveries: (id: string) => request<WebhookDelivery[]>(path(id) + "/deliveries"),
  rotateToken: (id: string) =>
    request<{ webhookUrl: string }>(path(id) + "/rotate-token", { method: "POST" }),
  update: (id: string, patch: Partial<NewRoutine>) =>
    request<Job>(path(id), { method: "PATCH", body: JSON.stringify(patch) }),
  add: (routine: NewRoutine) =>
    request<Job>("/jobs", { method: "POST", body: JSON.stringify(routine) }),
  run: (id: string) => request<JobRun>(`${path(id)}/run`, { method: "POST" }),
  pause: (id: string) => request<Job>(`${path(id)}/pause`, { method: "POST" }),
  resume: (id: string) => request<Job>(`${path(id)}/resume`, { method: "POST" }),
  remove: (id: string) => request<{ ok: boolean }>(path(id), { method: "DELETE" }),
};
