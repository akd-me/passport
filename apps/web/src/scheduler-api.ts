import { request } from "./api";
/** Scheduler HTTP wire types; the web app has no scheduler runtime dependency. */
export type JobSchedule =
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
  name: string;
  schedule: JobSchedule;
  routine: { instruction: string };
}
const path = (id: string) => `/jobs/${encodeURIComponent(id)}`;
export const jobsApi = {
  add: (routine: NewRoutine) =>
    request<Job>("/jobs", { method: "POST", body: JSON.stringify(routine) }),
  run: (id: string) => request<JobRun>(`${path(id)}/run`, { method: "POST" }),
  pause: (id: string) => request<Job>(`${path(id)}/pause`, { method: "POST" }),
  resume: (id: string) => request<Job>(`${path(id)}/resume`, { method: "POST" }),
  remove: (id: string) => request<{ ok: boolean }>(path(id), { method: "DELETE" }),
};
