import type { Account, DraftInput, SyncDelta } from "@passport/types";
import { expect, vi } from "vitest";
import type { CalendarDelta, EventInput } from "../mock.js";

export const account: Account = {
  id: "account-1",
  kind: "mock",
  displayName: "Alex",
  emailAddress: "alex@example.com",
  capabilities: {
    mail: true,
    calendar: true,
    contacts: false,
    push: false,
    labels: true,
    submit: true,
  },
  settings: {},
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
export const draft: DraftInput = {
  accountId: account.id,
  to: [{ email: "sam@example.com", name: "Sam" }],
  subject: "Hello",
  textBody: "Shall we meet Tuesday?",
};
export const range = { start: "2026-01-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z" };
export const eventInput: EventInput = {
  accountId: account.id,
  calendarId: `${account.id}:calendar:primary`,
  title: "Review",
  start: "2026-01-20T14:00:00.000Z",
  end: "2026-01-20T15:00:00.000Z",
  allDay: false,
  status: "confirmed",
  participants: [{ email: account.emailAddress, status: "needs-action" }],
};
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}
export function lastCursor(deltas: Array<SyncDelta | CalendarDelta>): string {
  const final = deltas.at(-1);
  expect(final?.kind).toBe("cursor");
  if (final?.kind !== "cursor") {
    throw new Error("Missing cursor");
  }
  return final.cursor;
}
export function response(body: unknown, status = 200, headers?: Record<string, string>): Response {
  if (status === 204 || status === 202) {
    return new Response(null, { status, headers });
  }
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: {
      "content-type": typeof body === "string" ? "text/plain" : "application/json",
      ...headers,
    },
  });
}
export function fixtureFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
) {
  return vi.fn(async (input: string | URL | Request, init: RequestInit = {}) =>
    handler(new URL(String(input)), init),
  ) as ReturnType<typeof vi.fn<typeof fetch>>;
}
export function jsonBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}
