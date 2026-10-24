import type { Email, Matter, PolicyEngine, TrustState } from "@passport/types";
import { mailRefHandle } from "@passport/types";
import type { RunContext } from "./context.js";
import { allActions } from "./data.js";
import { pendingDecisions } from "./decisions.js";
import { AgentError } from "./errors.js";
import type { AgentDecision } from "./integration.js";
import { reviewPrompt } from "./prompts/index.js";
import { reviewSchema } from "./schemas.js";

export interface Journal {
  runs: Array<{ id: string; summary: string; downgrades: string[]; decisions: AgentDecision[] }>;
  trustBefore: TrustState[];
}

export async function getJournal(
  ctx: Pick<RunContext, "store" | "run">,
  policy: PolicyEngine,
): Promise<Journal> {
  const key = `agent:journal:${ctx.run.startedAt.slice(0, 10)}`;
  const saved = await ctx.store.kv.get(key);
  if (saved) {
    return JSON.parse(saved) as Journal;
  }
  const baseline = await ctx.store.kv.get("agent:trust_snapshot");
  const journal: Journal = {
    runs: [],
    trustBefore: baseline ? (JSON.parse(baseline) as TrustState[]) : await policy.getTrust(),
  };
  await ctx.store.kv.set(key, JSON.stringify(journal));
  return journal;
}

function line(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[<>]/g, "");
}
function bullets(items: string[], empty: string): string {
  return items.length ? items.map((item) => `- ${line(item)}`).join("\n") : `- ${empty}`;
}

export async function dailyDigest(ctx: RunContext, policy: PolicyEngine): Promise<void> {
  const date = ctx.run.startedAt.slice(0, 10);
  const start = `${date}T00:00:00.000Z`,
    end = new Date(Date.parse(start) + 86_400_000).toISOString();
  // Sends may have been created yesterday and released today; filter on execution time.
  const actions = (await allActions(ctx.store, { actorKind: "agent" })).filter(
    (action) =>
      (action.executedAt ?? action.createdAt) >= start &&
      (action.executedAt ?? action.createdAt) < end,
  );
  const pending = await allActions(ctx.store, {
    status: ["proposed", "held", "approved", "executing"],
  });
  const matters = (await ctx.store.matters.list()).filter(
    (matter) => matter.updatedAt >= start && matter.updatedAt < end,
  );
  const journal = await getJournal(ctx, policy);
  const trust = await policy.getTrust();
  const changes: string[] = [];
  for (const state of trust) {
    const prior = journal.trustBefore.find((item) => item.category === state.category);
    if (!prior) {
      changes.push(`${state.category}: ${state.level}, score ${state.score.toFixed(2)} (new).`);
    } else if (
      prior.level !== state.level ||
      prior.score !== state.score ||
      prior.stage !== state.stage
    ) {
      changes.push(
        `${state.category}: ${prior.level} → ${state.level}; score ${prior.score.toFixed(2)} → ${state.score.toFixed(2)}.`,
      );
    }
  }
  const downgrades = journal.runs
    .flatMap((run) => run.downgrades)
    .map((name) => `${name}: previously blue verification is now green; review sender identity.`);
  const done = actions
    .filter((action) => action.status === "executed")
    .map((action) => `${action.request.type}: ${action.request.reason}`);
  const failed = actions
    .filter((action) => action.status === "failed")
    .map((action) => `Failed ${action.request.type}: ${action.request.reason}`);
  const decisions = (await pendingDecisions(ctx.store)).map(
    (decision) => `Decision needed for ${decision.emailId}: ${decision.summary}`,
  );
  const markdown = `# Passport daily digest — ${date}\n\n## What the agent did\n${bullets([...done, ...failed], "No completed actions today.")}\n\n## Pending decisions and outbox\n${bullets([...pending.map((action) => `[${action.status}] ${action.request.reason}`), ...decisions], "No pending decisions or held actions.")}\n\n## Matters that moved\n${bullets(
    matters.map(
      (matter) =>
        `${matter.title} — ${matter.status}. ${matter.summary}${matter.nextStep ? ` Next: ${matter.nextStep}` : ""}`,
    ),
    "No matter changes today.",
  )}\n\n## Trust changes\n${bullets([...changes, ...downgrades], "No observed trust changes today.")}\n`;
  await ctx.store.kv.set(`digest:${date}`, markdown);
  await ctx.store.kv.set("agent:trust_snapshot", JSON.stringify(trust));
  ctx.digest = { date, markdown };
  ctx.notes.push(
    `Stored daily digest for ${date}: ${done.length} completed, ${pending.length} pending actions.`,
  );
}

/** Referenced emails fetched per matter review: the newest refs (or v0.2 ids) the matter lists. */
export const MATTER_REVIEW_EMAILS = 20;
/** LLM reviews per run; the least recently updated matters go first. */
export const MATTER_REVIEWS_PER_RUN = 10;

/** Rows for the review prompt: refs read through the envelope cache (no bodies), else v0.2 ids. */
async function reviewEmails(ctx: RunContext, matter: Matter): Promise<Email[]> {
  const reads = matter.refs
    ? [...matter.refs]
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-MATTER_REVIEW_EMAILS)
        .map((ref) =>
          ctx.store.emails.get(mailRefHandle(ref), { includeBodies: false, cacheOnly: true }),
        )
    : [...new Set(matter.emailIds)]
        .slice(-MATTER_REVIEW_EMAILS)
        .map((id) => ctx.store.emails.get(id));
  const settled = await Promise.allSettled(reads);
  // A ref whose read-through fails (rate limit, deleted) is left out of the prompt only.
  return settled.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : [],
  );
}

export async function matterReviewContext(ctx: RunContext, days: number) {
  const cutoff = Date.parse(ctx.now()) - days * 86_400_000;
  const candidates: Array<{ matter: Matter; emails: Email[]; accountId: string }> = [];
  // Every active matter, oldest first: the stale ones are exactly those beyond a default page.
  const active = (await ctx.store.matters.list({ status: ["active"], limit: 2_147_483_647 })).sort(
    (a, b) => a.updatedAt.localeCompare(b.updatedAt),
  );
  for (const matter of active) {
    if (candidates.length >= MATTER_REVIEWS_PER_RUN || Date.parse(matter.updatedAt) > cutoff) {
      // Sorted by updatedAt: every later matter moved recently too.
      break;
    }
    const events = await ctx.store.events.query({ matterId: matter.id });
    // Activity comes from the refs themselves (date), so idle matters cost no reads to skip.
    const refDates = matter.refs?.map((ref) => ref.date) ?? [];
    const quick = [matter.updatedAt, ...refDates, ...events.map((event) => event.updatedAt)];
    if (Math.max(...quick.map((at) => Date.parse(at))) > cutoff) {
      continue;
    }
    // Only the matter's own references; never a store scan by matter.
    const emails = await reviewEmails(ctx, matter);
    const activity = [
      ...quick,
      ...emails.flatMap((email) => [email.receivedAt, email.sentAt ?? email.receivedAt]),
    ];
    if (Math.max(...activity.map((at) => Date.parse(at))) > cutoff) {
      continue;
    }
    const accountId =
      emails[0]?.accountId ??
      matter.refs?.at(-1)?.account ??
      events[0]?.accountId ??
      (await ctx.store.accounts.list())[0]?.id;
    if (!accountId) {
      throw new AgentError(
        "Matter review requires an account for the action log",
        "ACCOUNT_NOT_FOUND",
      );
    }
    candidates.push({
      matter,
      emails: emails.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, 10),
      accountId,
    });
  }
  return candidates;
}

/** Compatibility structured reviewer; scheduled runs now use the session and these candidates. */
export async function reviewMatters(ctx: RunContext, days: number): Promise<void> {
  const candidates = await matterReviewContext(ctx, days);
  for (const { matter, emails, accountId } of candidates) {
    const update = await ctx.structured(reviewSchema, reviewPrompt(matter, emails));
    await ctx.callTool("update_matter", {
      accountId,
      matterId: matter.id,
      reason: `Review matter inactive for ${days} days: ${matter.title}`,
      patch: {
        summary: String(update.summary),
        nextStep: String(update.nextStep),
        status: update.status as "active" | "waiting" | "done",
      },
    });
  }
  ctx.notes.push(`Reviewed ${candidates.length} inactive matters.`);
}
