import type { Account } from "@passport/types";
import { request } from "../api";

/** First-run copy shown once an account is connected (wizard and OAuth return). */
export const FIRST_RUN_CONNECTED =
  "Connected. Passport reads your mail on demand and watches for new mail.";

/** `GET /api/accounts` → `watch`: new-mail watcher health. Times are ISO UTC. */
export interface WatchStatus {
  since: string | null;
  lastTickAt: string | null;
  cursorAgeSeconds: number | null;
  status: "starting" | "watching" | "backoff" | "stale" | "error" | "unsupported" | "needs-sign-in";
  error?: string;
  retryAt?: string;
}
export type ConnectedAccount = Account & {
  /** Provider Inbox total from the last label refresh; null until known. */
  messageCount?: number | null;
  /** Null for calendar-only accounts. */
  watch?: WatchStatus | null;
};
export interface ConnectionAttempt {
  authUrl: string;
  /** Same-origin URL that binds another browser (the Mac app's system browser) to the attempt. */
  launchUrl: string;
  attemptId: string;
  redirectUri: string;
}
export interface ConnectionStatus {
  status: "authorizing" | "connected" | "failed";
  accountId?: string;
  error?: string;
}
export interface DoctorReport {
  at: string;
  ok: boolean;
  checks: Array<{
    name: string;
    status: "ok" | "warning" | "error";
    detail: string;
    accountId?: string;
  }>;
}
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: "POST",
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
export const accountApi = {
  start: (input: {
    kind: string;
    clientId: string;
    clientSecret?: string;
    calendar: boolean;
    accountId?: string;
  }) => post<ConnectionAttempt>("/accounts/oauth/start", input),
  status: (id: string) =>
    request<ConnectionStatus>(`/accounts/oauth/status/${encodeURIComponent(id)}`),
  test: (input: unknown) => post<{ ok: boolean }>("/accounts/test", input),
  remove: (id: string) =>
    request<{ ok: boolean }>(`/accounts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  doctor: () => request<DoctorReport>("/doctor"),
};
