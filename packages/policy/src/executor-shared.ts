import type {
  ActionCategory,
  ActionRequest,
  ActionType,
  CalendarEvent,
  CalendarProvider,
  DraftInput,
  Email,
  EventBus,
  MailProvider,
  Matter,
  Person,
  PolicyEngine,
  QuotaLane,
  Store,
  Timestamp,
} from "@passport/types";
import type { ResolveDns } from "./unsubscribe.js";
export interface ActionExecutorOptions {
  /** Optional operational diagnostics; messages never include action payloads. */
  log?: (message: string) => void;
  store: Store;
  bus: EventBus;
  policy: PolicyEngine;
  mailProviderFor(accountId: string): MailProvider | Promise<MailProvider>;
  calendarProviderFor(accountId: string): CalendarProvider | Promise<CalendarProvider>;
  /** HTTP transport for header/link unsubscribe; optional test override; defaults to DNS-pinned HTTPS requests. */
  fetch?: typeof globalThis.fetch;
  /** Resolve all addresses before each unsubscribe request, including redirect hops. */
  resolveDns?: ResolveDns;
  now?: () => Timestamp;
}
export type Request = { [K in ActionType]: ActionRequest<K> }[ActionType];
export type EmailPatch = Pick<Email, "id" | "matterId" | "personIds" | "category">;
/**
 * Body-free pre-image of a mail mutation: enough to compute and display the inverse. Read with
 * `fresh: true` so it reflects provider state, not a possibly stale cache.
 */
export type MailPreImage = Pick<
  Email,
  "id" | "accountId" | "providerId" | "threadId" | "mailboxIds" | "keywords" | "subject"
>;
export const preImageOf = (email: Email): MailPreImage => ({
  id: email.id,
  accountId: email.accountId,
  providerId: email.providerId,
  threadId: email.threadId,
  mailboxIds: [...email.mailboxIds],
  keywords: { ...email.keywords },
  subject: email.subject,
});
/** Pre-image reads: provider-fresh labels and flags, no bodies. */
export const FRESH_PRE_IMAGE = { fresh: true, includeBodies: false } as const;
/** Quota lane for an action's provider reads: agent work stays off the user's interactive lane. */
export const readLaneOf = (request: Pick<ActionRequest, "actor">): QuotaLane =>
  request.actor?.kind === "agent" ? "arrivals" : "interactive";
/** `FRESH_PRE_IMAGE` in the request's lane. */
export const freshPreImage = (request: Pick<ActionRequest, "actor">) => ({
  ...FRESH_PRE_IMAGE,
  lane: readLaneOf(request),
});
export type Snapshot =
  | { kind: "mail"; emails: MailPreImage[]; createdMailboxIds?: string[] }
  | { kind: "draft"; email: Email | null; createdId?: string }
  | { kind: "event"; event: CalendarEvent | null; createdId?: string }
  | {
      kind: "matter";
      matter: Matter | null;
      id: string;
      emails: EmailPatch[];
      events: CalendarEvent[];
    }
  | { kind: "person"; person: Person | null; createdId?: string }
  | { kind: "snooze"; matter: Matter | null; kv: Array<{ key: string; value: string | null }> };
export const marker = "__passportPolicyInverse";
export const snapshotOf = (request: ActionRequest) =>
  (request.params as unknown as Record<string, Snapshot>)[marker];
export const patchOf = (email: Email): EmailPatch => ({
  id: email.id,
  matterId: email.matterId ?? null,
  personIds: [...email.personIds],
  category: email.category ?? null,
});
export const draftOf = (email: Email): DraftInput => ({
  accountId: email.accountId,
  to: email.to,
  cc: email.cc,
  bcc: email.bcc,
  subject: email.subject,
  textBody: email.textBody ?? "",
  htmlBody: email.htmlBody,
  attachments: email.attachments.map(({ name, type, blobId }) => ({ name, type, blobId })),
});
export const normalizedDraft = (draft: DraftInput): DraftInput =>
  structuredClone({
    ...draft,
    inReplyToEmailId: draft.inReplyToEmailId ?? null,
    cc: draft.cc ?? [],
    bcc: draft.bcc ?? [],
    htmlBody: draft.htmlBody ?? null,
    attachments: draft.attachments ?? [],
  });
export const isCompletePerson = (patch: Partial<Person>): patch is Person =>
  typeof patch.id === "string" &&
  patch.id.length > 0 &&
  typeof patch.displayName === "string" &&
  typeof patch.primaryEmail === "string" &&
  Array.isArray(patch.emails) &&
  patch.emails.every((email) => typeof email === "string") &&
  ["self", "known", "stranger", "service"].includes(patch.relationship ?? "") &&
  ["blue", "green", "unknown"].includes(patch.verification ?? "") &&
  !!patch.stats &&
  typeof patch.stats.sent === "number" &&
  typeof patch.stats.received === "number" &&
  (patch.stats.lastContactAt === null || typeof patch.stats.lastContactAt === "string") &&
  typeof patch.createdAt === "string" &&
  typeof patch.updatedAt === "string";
export const agentEmailPatchOf = (
  request: ActionRequest,
): Partial<Pick<Email, "category" | "personIds">> => {
  const patch = (request.params as { emailPatch?: unknown }).emailPatch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return {};
  }
  const { category, personIds } = patch as Record<string, unknown>;
  const categories: readonly ActionCategory[] = [
    "triage",
    "newsletters",
    "receipts",
    "notifications",
    "scheduling",
    "replies_known",
    "replies_stranger",
    "money",
    "legal",
    "unsubscribe",
    "matters",
    "other",
  ];
  return {
    ...(category === null || categories.includes(category as ActionCategory)
      ? { category: category as Email["category"] }
      : {}),
    ...(Array.isArray(personIds) && personIds.every((id) => typeof id === "string")
      ? { personIds }
      : {}),
  };
};
