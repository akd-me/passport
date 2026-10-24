import { neutralize, type ToolContext } from "@passport/tools";
import { type ActionCategory, type AgentTrigger, type EventBus, toMailRow } from "@passport/types";
import type { RunContext } from "./context.js";
import { normalizeAddress } from "./data.js";
import { recordDecision } from "./decisions.js";
import { AgentError } from "./errors.js";
import { watchedMatters } from "./knowledge.js";
import { isObject } from "./llm/json.js";
import { frameUntrusted } from "./prompts/frame.js";
import { heuristicCategory, prepareTriage, sensitiveCategory, triage } from "./triage.js";

const ROUTINE = new Set(["newsletters", "receipts", "notifications"]);

/** Bounded after neutralization, before framing, so both frame delimiters always survive. */
function frame(source: string, value: unknown, bytes: number): string {
  const text = neutralize(JSON.stringify(value));
  return frameUntrusted(source, Buffer.from(text).subarray(0, bytes).toString("utf8"));
}

/** A short arrival instruction. Mail and heuristic evidence are data, never instructions. */
export function triagePrompt(
  email: import("@passport/types").Email,
  preclassification: ActionCategory | undefined,
  watched: string[],
  sensitive?: ActionCategory,
  alwaysAsk: ActionCategory[] = [],
): string {
  return `Triage this one arrival on the account's Inbox task. Use Passport tools and policy for every change.
Read the message/thread with mail_read (quoted: collapse). Resolve context with people_lookup, notes_search and notes_read; identity/security evidence is maintained by Passport, never promote a relationship yourself.
Choose a category (money/legal before routine signals; replies_known only for known senders). Use create_matter or attach_to_matter with category and this email id, attach an existing relevant matter or create a factual one. Read matter notes and consider saved watch matches first. Passport attaches the resolved people automatically. Append one dated arrival line in matter notes and a line in the sender's notes for material mail, using notes_write.
Only propose a reply_draft when a known correspondent needs a reply; no courtesy reply to automated mail. Money, legal, stranger requests and alwaysAsk categories need human review; explain the decision. Never send mail or approve a proposal.
For invitations, inspect list_events and free_busy/find_free_slots over the next 14 days; respond_to_event for a linked invite, tentative if busy. Otherwise propose_meeting with checked free slots, or a reply_draft if no slots. Do not claim unverified availability.
Report actual proposal/execution status and stop. Truncated data can be read through tools.
Always ask categories: ${alwaysAsk.join(", ")}.
${frame("arrival", { heuristic: preclassification ?? null, sensitive: sensitive ?? null, row: toMailRow(email) }, 1500)}
${frame("matter-watch-matches", watched, 300)}`;
}

/** Routine mail never enters inference. Other mail gets one native session/tool loop. */
export async function sessionTriage(
  ctx: RunContext,
  emailId: string,
  bus: EventBus,
  run: (trigger: Extract<AgentTrigger, { kind: "manual" }>) => Promise<void>,
): Promise<void> {
  const prepared = await prepareTriage(ctx, emailId, bus);
  const { email, resolved, reader } = prepared;
  const heuristic = heuristicCategory(email);
  const sensitive = sensitiveCategory(email, resolved.people);
  if (heuristic && ROUTINE.has(heuristic) && !sensitive) {
    await triage(ctx, emailId, bus, prepared, true);
    return;
  }
  const watched = await watchedMatters(ctx, email, resolved.persistedIds, reader);
  const { alwaysAsk } = await ctx.policy.getConfig();
  ctx.arrival = {
    email,
    people: resolved.people,
    personIds: resolved.persistedIds,
    category: sensitive ?? heuristic,
    alwaysAsk,
  };
  await run({
    kind: "manual",
    instruction: triagePrompt(
      email,
      heuristic,
      watched.map((matter) => matter.id),
      sensitive,
      alwaysAsk,
    ),
  });
  const organized = ctx.actions.some((action) =>
    ["matter_create", "matter_attach"].includes(action.request.type),
  );
  if (!organized && !ctx.budget.exhausted && !ctx.readOnly) {
    throw new AgentError("Arrival session did not organize the message", "TRIAGE_INCOMPLETE");
  }
  const category = ctx.arrival.category ?? "other";
  if (
    !ctx.readOnly &&
    (alwaysAsk.includes(category) || !["replies_known", "scheduling"].includes(category))
  ) {
    const stored = await ctx.store.emails.get(email.id, { cacheOnly: true, includeBodies: false });
    const matter = stored?.matterId ? await ctx.store.matters.get(stored.matterId) : null;
    const decision = {
      emailId: email.id,
      ...(matter ? { matterId: matter.id } : {}),
      summary: `${matter?.summary ?? "Review this arrival"}${alwaysAsk.includes(category) ? `; ${category} is in alwaysAsk and requires human approval.` : ""}`,
    };
    ctx.decisions.push(decision);
    await recordDecision(ctx.store, ctx.run.id, decision);
  }
  ctx.notes.push(`Triaged ${email.id} as ${ctx.arrival.category ?? "other"}.`);
}

/** Classification is model output; sensitive and known-sender floors remain code-derived. */
export function arrivalToolContext(ctx: RunContext, name: string, input: unknown): ToolContext {
  const arrival = ctx.arrival;
  if (!arrival) {
    return {};
  }
  if (
    ["send", "unsubscribe", "profile_update", "add_standing_rule", "remove_standing_rule"].includes(
      name,
    )
  ) {
    throw new AgentError(
      "Arrival triage organizes and proposes; this action requires a separate task",
      "INPUT_TRIAGE",
    );
  }
  if (
    ["create_draft", "reply_draft", "propose_meeting", "respond_to_event"].includes(name) &&
    arrival.category &&
    arrival.alwaysAsk.includes(arrival.category)
  ) {
    throw new AgentError(
      "This arrival category is in alwaysAsk; explain the need for human review without proposing a reply",
      "INPUT_TRIAGE",
    );
  }
  if (["create_matter", "attach_to_matter"].includes(name) && isObject(input)) {
    const ids =
      name === "create_matter" && isObject(input.matter) ? input.matter.emailIds : input.emailIds;
    if (!Array.isArray(ids) || ids.length !== 1 || ids[0] !== arrival.email.id) {
      throw new AgentError("Organize only this arrival's email id", "INPUT_TRIAGE");
    }
    if (typeof input.category !== "string" || input.category === "profile_update") {
      throw new AgentError("Provide the arrival category on the matter tool", "INPUT_TRIAGE");
    }
    let category =
      sensitiveCategory(arrival.email, arrival.people) ?? (input.category as ActionCategory);
    const known = arrival.people.some(
      (person) =>
        ["known", "self"].includes(person.relationship) &&
        arrival.email.from.some((from) => person.emails.includes(normalizeAddress(from.email))),
    );
    if (
      category === "replies_known" &&
      (!known || ctx.downgrades.length || arrival.email.verification.passport === "downgraded")
    ) {
      category = "replies_stranger";
    }
    arrival.category = category;
  }
  return {
    classification: arrival.category,
    projectedPeople: arrival.people,
    emailPatch: { category: arrival.category, personIds: arrival.personIds },
  };
}
