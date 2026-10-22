import type { Account } from "@passport/types";
import { request } from "../api";

/** `GET /api/accounts` → `watch`: the new-mail watcher. Times are ISO UTC. */
export interface AccountWatch {
  since: string | null;
  lastTickAt: string | null;
  cursorAgeSeconds: number | null;
  status: "starting" | "watching" | "backoff" | "stale" | "error" | "unsupported" | "needs-sign-in";
  error?: string;
  retryAt?: string;
}
export type ConnectedAccount = Account & {
  /** Provider inbox total from the last label refresh; null until known. */
  messageCount?: number | null;
  watch?: AccountWatch | null;
  /** @deprecated v0.2 mirror progress; no longer sent. */
  syncing?: boolean;
};
export interface ConnectionAttempt {
  authUrl: string;
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
