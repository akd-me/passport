import type { EmailAddress, MailboxRole, MailEnvelope } from "@passport/types";
import { type QueryNode, relativeCutoff } from "./query.js";

/** A label or folder an email belongs to, as seen by the matcher. */
export interface MatchLabel {
  name: string;
  role: MailboxRole;
}

/** Context for evaluating a query locally. */
export interface MatchContext {
  /** Reference time for `newer_than:` / `older_than:`. */
  now: Date;
  /** Labels / folders of the email (resolved from `mailboxIds`). */
  labels: (email: MailEnvelope) => MatchLabel[];
}

/** An envelope, optionally with its text body for bare-word matching. */
export type MatchableEmail = MailEnvelope & { textBody?: string | null };

const contains = (haystack: string | null | undefined, needle: string) =>
  (haystack ?? "").toLowerCase().includes(needle.toLowerCase());

function matchesAddress(addresses: readonly EmailAddress[], value: string): boolean {
  const needle = value.toLowerCase();
  if (needle.startsWith("@")) {
    // Domain match: the domain itself or any subdomain.
    const domain = needle.slice(1);
    return addresses.some((a) => {
      const address = a.email.toLowerCase();
      return address.endsWith(`@${domain}`) || address.endsWith(`.${domain}`);
    });
  }
  return addresses.some((a) => contains(a.email, needle) || contains(a.name, needle));
}

function stripBrackets(value: string): string {
  return value.trim().replace(/^</, "").replace(/>$/, "").toLowerCase();
}

function matchesField(email: MatchableEmail, node: Extract<QueryNode, { kind: "field" }>): boolean {
  switch (node.field) {
    case "from":
      return matchesAddress(email.from, node.value);
    case "to":
      return matchesAddress(email.to, node.value);
    case "cc":
      return matchesAddress(email.cc, node.value);
    case "bcc":
      return matchesAddress(email.bcc, node.value);
    case "with":
      return matchesAddress([...email.from, ...email.to, ...email.cc, ...email.bcc], node.value);
    case "subject":
      return contains(email.subject, node.value);
    case "filename":
      return email.attachments.some((a) => contains(a.name, node.value));
    case "list":
      return contains(email.headers.listId, node.value);
    case "rfc822msgid":
      return (
        email.headers.messageId !== null &&
        stripBrackets(email.headers.messageId) === stripBrackets(node.value)
      );
  }
}

function matchesContainer(labels: MatchLabel[], value: string): boolean {
  switch (value) {
    case "anywhere":
      return true;
    case "spam":
      return labels.some((l) => l.role === "junk");
    case "inbox":
    case "sent":
    case "drafts":
    case "trash":
    case "archive":
      return labels.some((l) => l.role === value || l.name.toLowerCase() === value);
    default:
      return labels.some((l) => l.name.toLowerCase() === value.toLowerCase());
  }
}

/**
 * Evaluates a portable query against one email locally. Used by the mock reader, and by real
 * readers for client-side filtering (Graph `$search+clientFilter`, IMAP post-filters, grep).
 * Bare words match the subject, preview and text body, case-insensitively.
 */
export function matchesQuery(node: QueryNode, email: MatchableEmail, ctx: MatchContext): boolean {
  switch (node.kind) {
    case "and":
      return node.nodes.every((n) => matchesQuery(n, email, ctx));
    case "or":
      return node.nodes.some((n) => matchesQuery(n, email, ctx));
    case "not":
      return !matchesQuery(node.node, email, ctx);
    case "text":
      return (
        contains(email.subject, node.value) ||
        contains(email.preview, node.value) ||
        contains(email.textBody, node.value)
      );
    case "field":
      return matchesField(email, node);
    case "has":
      return email.attachments.some((a) => a.disposition !== "inline");
    case "is":
      if (node.value === "flagged") {
        return Boolean(email.keywords.$flagged);
      }
      return Boolean(email.keywords.$seen) === (node.value === "read");
    case "in":
      return matchesContainer(ctx.labels(email), node.value);
    case "label":
      return matchesContainer(ctx.labels(email), node.value.toLowerCase());
    case "date": {
      const received = Date.parse(email.receivedAt);
      const at = Date.parse(node.at);
      return node.op === "after" ? received >= at : received < at;
    }
    case "relative": {
      const received = Date.parse(email.receivedAt);
      const cutoff = relativeCutoff(node, ctx.now).getTime();
      return node.op === "newer_than" ? received >= cutoff : received < cutoff;
    }
    case "size":
      return node.op === "larger" ? email.size > node.bytes : email.size < node.bytes;
  }
}
