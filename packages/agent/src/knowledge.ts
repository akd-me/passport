/**
 * People and matters as agent-maintained notes (research report 03 §4.3): triage records what
 * happened as dated log lines in notes, and checks the saved `Matter.watch` queries of open
 * matters against each arrival. Security state (relationship, verification, stats) is written
 * only by `people.ts`, exactly as before.
 */
import type { ActionCategory, Email, Matter, Person } from "@passport/types";
import { MATTER_WATCH_PER_ARRIVAL } from "@passport/types";
import type { RunContext } from "./context.js";
import { AgentError } from "./errors.js";
import type { AgentReader } from "./reads.js";

/** Open matters scanned for a `watch` query per arrival (then capped at five checks). */
const WATCH_SCAN = 200;
/** Log lines quote at most this much of a subject or summary. */
const QUOTE_MAX = 120;
/** Categories whose arrivals are not worth a line in the sender's person notes. */
const ROUTINE: readonly ActionCategory[] = ["newsletters", "notifications", "receipts", "triage"];

const clip = (text: string, max = QUOTE_MAX) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A Message-ID a portable `rfc822msgid:` term can carry, without angle brackets. */
function messageIdTerm(messageId: string | null): string | null {
  const bare = messageId?.trim().replace(/^<|>$/g, "");
  return bare && /^[^\s"()<>]+$/.test(bare) ? bare : null;
}

/**
 * Open matters whose saved `watch` query matches this arrival. Checks at most
 * `MATTER_WATCH_PER_ARRIVAL` matters (those involving the message's people first, then the most
 * recently updated), one provider search each (`(<watch>) rfc822msgid:<id>`, limit 1) in the
 * run's lane (`arrivals` for arrival triage). Without a reader or a Message-ID nothing is checked.
 */
export async function watchedMatters(
  ctx: Pick<RunContext, "store" | "notes">,
  email: Email,
  personIds: readonly string[],
  reader: AgentReader | null,
): Promise<Matter[]> {
  const id = messageIdTerm(email.headers.messageId);
  if (!reader || !id) {
    return [];
  }
  const open = (
    await ctx.store.matters.list({ status: ["active", "waiting"], limit: WATCH_SCAN })
  ).filter((matter) => matter.watch?.trim());
  const involved = (matter: Matter) => matter.personIds.some((pid) => personIds.includes(pid));
  const checked = [...open.filter(involved), ...open.filter((matter) => !involved(matter))].slice(
    0,
    MATTER_WATCH_PER_ARRIVAL,
  );
  const matched: Matter[] = [];
  for (const matter of checked) {
    const query = `(${matter.watch!.trim()}) rfc822msgid:${id}`;
    const rows = await reader.call((r, opts) => r.search({ query, limit: 1 }, opts));
    if (rows?.items.length) {
      matched.push(matter);
      ctx.notes.push(`Watch of matter ${matter.id} matched ${email.id}.`);
    }
  }
  return matched;
}

/** Appends one line through `notes_write`; a refused or failed write never fails triage. */
async function appendLine(
  ctx: RunContext,
  input: { kind: "person" | "matter"; id: string; accountId: string; line: string },
  reason: string,
): Promise<void> {
  try {
    await ctx.callTool("notes_write", {
      kind: input.kind,
      id: input.id,
      notes: input.line,
      mode: "append",
      accountId: input.accountId,
      reason,
    });
  } catch (error) {
    // Notes are best-effort knowledge; the action log already records the triage outcome.
    if (!(error instanceof AgentError)) {
      throw error;
    }
    ctx.notes.push(`Could not log ${input.kind} notes for ${input.id}.`);
  }
}

/**
 * Records the arrival as knowledge: one dated line in the matter's notes and, for material
 * (non-routine) mail, one in the sender's person notes. Lines name the message handle so a
 * later reader can open it, e.g. `- 2026-10-20: “Lease renewal” from Dana (acc:email:…): …`.
 */
export async function logArrival(
  ctx: RunContext,
  input: {
    email: Email;
    category: ActionCategory;
    matter: { id?: string; summary: string };
    sender: Person | undefined;
    watched: readonly Matter[];
  },
): Promise<void> {
  const { email, category, matter, sender } = input;
  const from = clip(email.from[0]?.name || email.from[0]?.email || "unknown sender", 60);
  const subject = `“${clip(email.subject || "(no subject)")}”`;
  const day = email.receivedAt.slice(0, 10);
  if (matter.id) {
    const watched = input.watched.some((item) => item.id === matter.id) ? " [watch]" : "";
    const summary = matter.summary.trim() ? `: ${clip(matter.summary)}` : "";
    await appendLine(
      ctx,
      {
        kind: "matter",
        id: matter.id,
        accountId: email.accountId,
        line: `- ${day}: ${category} ${subject} from ${from} (${email.id})${watched}${summary}`,
      },
      `Log ${category} mail in matter notes: ${clip(email.subject, 60)}`,
    );
  }
  if (sender && sender.relationship !== "service" && !ROUTINE.includes(category)) {
    await appendLine(
      ctx,
      {
        kind: "person",
        id: sender.id,
        accountId: email.accountId,
        line: `- ${day}: wrote ${subject} (${email.id})`,
      },
      `Log mail from ${from} in person notes`,
    );
  }
}
