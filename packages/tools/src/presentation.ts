import type { ActionRecord, CalendarEvent, Email } from "@passport/types";
import type { ToolResult } from "./types.js";

const BODY_LIMIT = 2000;
const clip = (text: string, max = BODY_LIMIT) => text.slice(0, max);

/** Deliberate projection: no raw provider headers, account settings, credentials or action results. */
export function emailView(email: Email, full = false) {
  const { id, accountId, threadId, mailboxIds, keywords, from, to, cc, bcc, replyTo, subject, receivedAt, sentAt, size, matterId, personIds, category, verification } = email;
  const body = (value: string | null | undefined) => value == null ? undefined : full ? value : clip(value);
  return {
    id, accountId, threadId, mailboxIds, keywords, from, to, cc, bcc, replyTo, subject, receivedAt, sentAt,
    deleted: email.keywords.$deleted === true,
    preview: clip(email.preview, 240), size, matterId, personIds, category, verification,
    attachments: email.attachments.map(({ id, name, type, size, blobId }) => ({ id, name, type, size, blobId })),
    headers: { messageId: email.headers.messageId, inReplyTo: email.headers.inReplyTo, references: email.headers.references, listId: email.headers.listId },
    canUnsubscribe: Boolean(email.headers.listUnsubscribe),
    textBody: body(email.textBody), htmlBody: body(email.htmlBody == null ? email.htmlBody : stripTrackingPixels(email.htmlBody)),
    truncated: !full && ((email.textBody?.length ?? 0) > BODY_LIMIT || (email.htmlBody?.length ?? 0) > BODY_LIMIT),
    ...(!full && ((email.textBody?.length ?? 0) > BODY_LIMIT || (email.htmlBody?.length ?? 0) > BODY_LIMIT) ? { continueFrom: BODY_LIMIT } : {}),
  };
}

export function eventView(event: CalendarEvent, full = false) {
  return { ...event, description: full ? event.description : event.description == null ? event.description : clip(event.description),
    truncated: !full && (event.description?.length ?? 0) > BODY_LIMIT };
}

export function actionView(action: ActionRecord) {
  return {
    id: action.id, actionId: action.id, outcome: action.decision.outcome, type: action.request.type, accountId: action.request.accountId,
    actor: action.request.actor, category: action.request.category, reason: action.decision.reason, actionReason: action.request.reason,
    status: action.status, decision: { outcome: action.decision.outcome, reason: action.decision.reason, trustLevel: action.decision.trustLevel },
    holdUntil: action.holdUntil ?? action.decision.holdUntil ?? null, createdAt: action.createdAt,
  };
}

export function writeResult(action: ActionRecord): ToolResult {
  return json({ ...actionView(action), policy_note: `Applied ${action.decision.trustLevel} trust for ${action.decision.category} to this ${action.request.actor.kind} action: ${action.decision.outcome}.` }, action.decision.outcome === "deny" || action.status === "failed");
}

export function json(value: object, isError = false): ToolResult {
  return { ...value, ...(isError ? { isError: true } : {}) };
}

export class ToolError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "ToolError"; }
}

export function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new ToolError("NOT_FOUND", `${label} not found.`);
  return value;
}

export function errorResult(error: unknown, write: boolean): ToolResult {
  // Provider exceptions may contain tokens or connection URLs. The host owns private diagnostics.
  return json({ error: error instanceof ToolError ? error.code : "DEPENDENCY_ERROR",
    reason: error instanceof ToolError ? error.message : "A Passport dependency failed; consult the server's private diagnostics.",
    ...(write ? { policy_note: "No successful policy result was returned; do not assume the action ran." } : {}) }, true);
}

/** Remove remote images and hidden image beacons from HTML previews; never fetch their URLs. */
export function stripTrackingPixels(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, tag => /(?:src\s*=\s*["']?https?:|(?:width|height)\s*=\s*["']?[01](?:["'\s>])|display\s*:\s*none|visibility\s*:\s*hidden)/i.test(tag) ? "" : tag);
}
