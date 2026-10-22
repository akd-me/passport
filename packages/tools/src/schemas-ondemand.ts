import { schema as z } from "./schema.js";
import * as s from "./schemas.js";

/** Input schemas shared by the on-demand mail tools (research 03 §2.3). */
export const account = s.id.describe(
  "Account id (see mail_accounts); optional when exactly one account is connected.",
);
export const accountOrAll = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .describe(
    'Account id, or "all" to fan out across every account and merge by date. Default: the only account, else all.',
  );
export const pageToken = z
  .string()
  .max(8000)
  .describe("Opaque nextPageToken from the previous call with otherwise identical input.");
export const query = z
  .string()
  .max(2000)
  .describe(
    'Portable query: from: to: cc: with: subject: has:attachment filename: after:/before: (YYYY-MM-DD) newer_than:/older_than: (7d, 2m, 1y) in:inbox|sent|… label: is:unread|read|starred larger:/smaller: list: rfc822msgid:, bare words, "phrases", OR, -negation and parentheses.',
  );
export const rawQuery = z
  .string()
  .max(2000)
  .describe(
    "Provider-native query passed through untranslated (Gmail q, Graph KQL, IMAP SEARCH). Use instead of query.",
  );
export const handle = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .describe("Mail handle from a row (id or threadId), or a legacy Passport email/thread id.");
export const handles = z
  .array(handle)
  .min(1)
  .max(100)
  .describe("One to 100 mail handles (row ids or threadIds).");
const date = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/,
    "Use YYYY-MM-DD or a UTC timestamp.",
  );
export const listFilter = z
  .strictObject({
    from: z.string().max(320).optional().describe("Sender address or name substring."),
    fromDomain: z.string().max(253).optional().describe("Sender domain; subdomains match."),
    unread: z.boolean().optional(),
    flagged: z.boolean().optional(),
    hasAttachment: z.boolean().optional(),
    after: date.optional().describe("Inclusive lower bound on the received date."),
    before: date.optional().describe("Exclusive upper bound on the received date."),
    largerThan: z.number().int().min(0).optional().describe("Minimum size in bytes."),
  })
  .describe("Structural filters only; never matches bodies.");
export const confirmCost = z
  .boolean()
  .default(false)
  .describe("Run even when the estimated quota cost is high (otherwise WOULD_EXCEED_BUDGET).");
export const container = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .describe('Label or folder: id, display name or role ("inbox", "sent", …).');
