import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ActionRecord, CalendarEvent, Email, Matter, Person } from "@passport/types";

const BODY_LIMIT = 2000;
const clip = (text: string, max = BODY_LIMIT) => text.slice(0, max);

export function json(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

export class MailboxMcpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MailboxMcpError";
  }
}

export function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) {
    throw new MailboxMcpError("NOT_FOUND", `${label} not found.`);
  }
  return value;
}

export function errorResult(error: unknown, write: boolean): CallToolResult {
  // Provider exceptions may contain tokens or connection URLs. The host owns private diagnostics.
  return json(
    {
      error: error instanceof MailboxMcpError ? error.code : "DEPENDENCY_ERROR",
      reason:
        error instanceof MailboxMcpError
          ? error.message
          : "A Passport dependency failed; consult the server's private diagnostics.",
      ...(write
        ? { policy_note: "No successful policy result was returned; do not assume the action ran." }
        : {}),
    },
    true,
  );
}

const line = (value: string) => value.replace(/[\r\n]/g, " ");
export function personMarkdown(person: Person): string {
  return `# ${line(person.displayName)}\n\nID: ${person.id}\n\n${person.emails.map(line).join(", ")}\n\nRelationship: ${person.relationship}; verification: ${person.verification}\n\n${person.notes ?? ""}`;
}

export function matterMarkdown(
  matter: Matter,
  emails: Email[],
  events: CalendarEvent[],
  people: Person[],
): string {
  return [
    `# ${line(matter.title)}`,
    `ID: ${matter.id} · ${matter.status}`,
    matter.summary,
    `Next step: ${matter.nextStep ?? "None"}`,
    `Due: ${matter.dueAt ?? "None"}`,
    "## People",
    ...people.map(
      (person) => `- ${line(person.displayName)} <${person.primaryEmail}> (${person.relationship})`,
    ),
    "## Emails",
    ...emails.map(
      (email) => `- ${email.id}: ${line(email.subject)} — ${clip(line(email.preview), 240)}`,
    ),
    "## Events",
    ...events.map((event) => `- ${event.id}: ${line(event.title)} (${event.start} – ${event.end})`),
  ].join("\n\n");
}

export function decisionsMarkdown(actions: ActionRecord[], nextCursor?: string | null): string {
  return [
    "# Pending decisions",
    ...actions.map(
      (action) =>
        `- ${action.id} [${action.status}] ${action.request.type}: ${line(action.request.reason)} — ${line(action.decision.reason)}${action.holdUntil ? ` (held until ${action.holdUntil})` : ""}`,
    ),
    ...(actions.length ? [] : ["No pending decisions."]),
    ...(nextCursor
      ? [`More results: call list_pending_decisions with cursor ${JSON.stringify(nextCursor)}.`]
      : []),
  ].join("\n\n");
}
