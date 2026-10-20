import type { Account } from "@passport/types";
import { request } from "../api";

export type ConnectedAccount = Account & {
  messageCount?: number;
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
    request<ConnectionStatus>(
      `/accounts/oauth/status/${encodeURIComponent(id)}`,
    ),
  test: (input: unknown) => post<{ ok: boolean }>("/accounts/test", input),
  remove: (id: string) =>
    request<{ ok: boolean }>(`/accounts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  backfill: (id: string, days: number) =>
    post<{ ok: boolean }>(
      `/accounts/${encodeURIComponent(id)}/backfill?days=${days}`,
    ),
  doctor: () => request<DoctorReport>("/doctor"),
};
