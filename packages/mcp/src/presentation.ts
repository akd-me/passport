import type { ActionRecord, CalendarEvent, Email, Matter, Person } from "@passport/types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const BODY_LIMIT = 1200;
const clip = (text: string, max = BODY_LIMIT) => text.slice(0, max);

/** Deliberate projection: no raw provider headers, account settings, credentials or action results. */
export function emailView(email: Email, full = false) {
  const { id, accountId, threadId, mailboxIds, keywords, from, to, cc, bcc, replyTo, subject, receivedAt, sentAt, size, matterId, personIds, category, verification } = email;
  const body = (value: string | null | undefined) => value == null ? undefined : full ? value : clip(value);
  return {
    id, accountId, threadId, mailboxIds, keywords, from, to, cc, bcc, replyTo, subject, receivedAt, sentAt,
    preview: clip(email.preview, 240), size, matterId, personIds, category, verification,
    attachments: email.attachments.map(({ id, name, type, size, blobId }) => ({ id, name, type, size, blobId })),
    headers: { messageId: email.headers.messageId, inReplyTo: email.headers.inReplyTo, references: email.headers.references, listId: email.headers.listId },
    canUnsubscribe: Boolean(email.headers.listUnsubscribe),
    textBody: body(email.textBody), htmlBody: body(email.htmlBody),
    truncated: !full && (email.textBody !== undefined || email.htmlBody !== undefined),
  };
}

export function eventView(event: CalendarEvent, full = false) {
  return { ...event, description: full ? event.description : event.description == null ? event.description : clip(event.description),
    truncated: !full && (event.description?.length ?? 0) > BODY_LIMIT };
}

export function actionView(action: ActionRecord) {
  return {
    id: action.id, type: action.request.type, accountId: action.request.accountId,
    actor: action.request.actor, category: action.request.category, reason: action.request.reason,
    status: action.status, decision: { outcome: action.decision.outcome, reason: action.decision.reason, trustLevel: action.decision.trustLevel },
    holdUntil: action.holdUntil ?? action.decision.holdUntil ?? null, createdAt: action.createdAt,
  };
}

export function writeResult(action: ActionRecord): CallToolResult {
  return json({ ...actionView(action), policy_note: `Applied ${action.decision.trustLevel} trust for ${action.decision.category} to this external-agent action: ${action.decision.outcome}.` }, action.decision.outcome === "deny" || action.status === "failed");
}

export function json(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

export class MailboxMcpError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "MailboxMcpError"; }
}

export function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new MailboxMcpError("NOT_FOUND", `${label} not found.`);
  return value;
}

export function errorResult(error: unknown, write: boolean): CallToolResult {
  // Provider exceptions may contain tokens or connection URLs. The host owns private diagnostics.
  return json({ error: error instanceof MailboxMcpError ? error.code : "DEPENDENCY_ERROR",
    reason: error instanceof MailboxMcpError ? error.message : "A Passport dependency failed; consult the server's private diagnostics.",
    ...(write ? { policy_note: "No successful policy result was returned; do not assume the action ran." } : {}) }, true);
}

const line = (value: string) => value.replace(/[\r\n]/g, " ");
export function personMarkdown(person: Person): string {
  return `# ${line(person.displayName)}\n\nID: ${person.id}\n\n${person.emails.map(line).join(", ")}\n\nRelationship: ${person.relationship}; verification: ${person.verification}\n\n${person.notes ?? ""}`;
}

export function matterMarkdown(matter: Matter, emails: Email[], events: CalendarEvent[], people: Person[]): string {
  return [
    `# ${line(matter.title)}`, `ID: ${matter.id} · ${matter.status}`, matter.summary,
    `Next step: ${matter.nextStep ?? "None"}`, `Due: ${matter.dueAt ?? "None"}`,
    "## People", ...people.map(person => `- ${line(person.displayName)} <${person.primaryEmail}> (${person.relationship})`),
    "## Emails", ...emails.map(email => `- ${email.id}: ${line(email.subject)} — ${clip(line(email.preview), 240)}`),
    "## Events", ...events.map(event => `- ${event.id}: ${line(event.title)} (${event.start} – ${event.end})`),
  ].join("\n\n");
}

export function decisionsMarkdown(actions: ActionRecord[], nextCursor?: string | null): string {
  return ["# Pending decisions", ...actions.map(action => `- ${action.id} [${action.status}] ${action.request.type}: ${line(action.request.reason)} — ${line(action.decision.reason)}${action.holdUntil ? ` (held until ${action.holdUntil})` : ""}`),
    ...(actions.length ? [] : ["No pending decisions."]), ...(nextCursor ? [`More results: call list_pending_decisions with cursor ${JSON.stringify(nextCursor)}.`] : [])].join("\n\n");
}
