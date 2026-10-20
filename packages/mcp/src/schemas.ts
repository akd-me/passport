import { z } from "zod";

export const id = z.string().trim().min(1).max(512).describe("Passport record ID (not a provider ID).");
export const ids = z.array(id).min(1).max(100).describe("One to 100 Passport IDs, all from one account for mail operations.");
export const timestamp = z.iso.datetime().describe("UTC ISO-8601 timestamp, ending in Z.");
export const limit = z.number().int().min(1).max(100).default(25).describe("Maximum results (1–100; default 25).");
export const full = z.boolean().default(false).describe("Return complete message bodies. Otherwise bodies are clipped to 1200 characters and marked truncated.");
export const category = z.enum(["triage", "newsletters", "receipts", "notifications", "scheduling", "replies_known", "replies_stranger", "money", "legal", "unsubscribe", "matters", "other"]);
export const status = z.enum(["proposed", "approved", "rejected", "held", "executing", "executed", "undone", "failed", "expired"]);
export const relationship = z.enum(["self", "known", "stranger", "service"]);
export const matterStatus = z.enum(["active", "waiting", "snoozed", "done"]);
export const reason = z.string().trim().min(1).max(1000).regex(/^[^\r\n]+$/, "Reason must be one line").describe("One-line explanation shown in the human decisions feed and action log.");
export const address = z.strictObject({ email: z.email(), name: z.string().max(200).optional() });
export const addresses = z.array(address).max(100);
export const range = z.strictObject({ start: timestamp, end: timestamp }).refine(value => Date.parse(value.start) < Date.parse(value.end), "start must precede end");
export const draft = z.strictObject({
  accountId: id,
  inReplyToEmailId: id.nullable().optional().describe("Original email ID; provider sets thread, In-Reply-To and References."),
  to: addresses.min(1), cc: addresses.optional(), bcc: addresses.optional(),
  subject: z.string().max(1000), textBody: z.string().max(1_000_000),
  htmlBody: z.string().max(1_000_000).nullable().optional(),
  attachments: z.array(z.strictObject({ name: z.string(), type: z.string(), blobId: id })).max(50).optional(),
});
export const emailQuery = {
  accountId: id.optional(), mailboxId: id.optional(), threadId: id.optional(),
  matterId: id.nullable().optional(), personId: id.optional(),
  text: z.string().max(2000).optional().describe("FTS5 query over subject, sender and body; e.g. invoice AND renewal, or a quoted phrase."),
  keywords: z.strictObject({ has: z.array(z.string()).max(100).optional(), not: z.array(z.string()).max(100).optional() }).optional(),
  category: category.optional(), after: timestamp.optional(), before: timestamp.optional(),
  limit, cursor: z.string().max(2000).nullable().optional(),
  sort: z.enum(["receivedAt_desc", "receivedAt_asc"]).optional(),
  includeBodies: z.boolean().default(false).describe("Include bodies in search results (still truncated unless full=true)."), full,
};
export const actionQuery = {
  status: z.array(status).optional(), category: category.optional(),
  actorKind: z.enum(["human", "agent", "external-agent"]).optional(),
  runId: id.optional(), matterId: id.optional(), after: timestamp.optional(), before: timestamp.optional(),
  limit, cursor: z.string().max(2000).nullable().optional(),
};
export const matterFields = {
  title: z.string().trim().min(1).max(1000), summary: z.string().max(10_000), status: matterStatus,
  kind: z.string().max(200).nullable().optional(), personIds: z.array(id).max(100),
  emailIds: z.array(id).max(100), eventIds: z.array(id).max(100),
  nextStep: z.string().max(5000).nullable().optional(), dueAt: timestamp.nullable().optional(), snoozedUntil: timestamp.nullable().optional(),
};
export const matterPatch = z.strictObject(matterFields).partial().refine(value => Object.keys(value).length > 0, "Provide at least one field");
// Verification and contact statistics are derived; external agents cannot overwrite them.
export const personPatch = z.strictObject({
  displayName: z.string().trim().min(1).max(200).optional(), emails: z.array(z.email()).min(1).max(100).optional(),
  primaryEmail: z.email().optional(), avatarUrl: z.url().nullable().optional(), relationship: relationship.optional(),
  notes: z.string().max(10_000).nullable().optional(),
}).refine(value => Object.keys(value).length > 0, "Provide at least one field");
