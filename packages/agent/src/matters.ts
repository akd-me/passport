import {
  type ActionCategory,
  type Email,
  type EmailGetOptions,
  type Matter,
  mailHandle,
  parseMailHandle,
  type Store,
} from "@passport/types";
import type { RunContext } from "./context.js";
import { normalizeAddress } from "./data.js";
import { AgentError } from "./errors.js";
import type { AgentMatterAttachParams, AgentMatterCreateParams } from "./integration.js";
import { isObject } from "./llm/json.js";
import { matterPrompt } from "./prompts/index.js";
import { type AgentReader, queryAddress } from "./reads.js";
import { matterSchema } from "./schemas.js";

/** Candidates offered to the model, and the open matters scanned for references. */
export const MATTER_CANDIDATE_LIMIT = 12;
const OPEN_MATTER_SCAN = 200;

/**
 * Candidate matters without an FTS scan over bodies: the email's own matter, matters referencing
 * this thread, matters of the people involved, matters referencing recent mail with the sender
 * (`with:<addr> newer_than:90d` through the reader), and matters whose title or summary shares a
 * subject word. Without a reader, the thread's stored rows stand in for the provider search.
 */
export async function matterCandidates(
  ctx: Pick<RunContext, "store" | "selfAddresses">,
  email: Email,
  personIds: string[],
  reader?: AgentReader | null,
): Promise<Matter[]> {
  const { store } = ctx;
  const matters = new Map<string, Matter>();
  const addId = async (id?: string | null): Promise<void> => {
    if (id && !matters.has(id)) {
      const matter = await store.matters.get(id);
      if (matter) {
        matters.set(id, matter);
      }
    }
  };
  await addId(email.matterId);
  const refs = new Set((await store.threads.get(email.threadId))?.emailIds ?? []);
  // One bounded page of this thread's stored rows (v0.2 matters list their ULIDs).
  const thread = await store.emails.query({ threadId: email.threadId, limit: 30 });
  for (const item of thread.items) {
    await addId(item.matterId);
  }
  if (reader) {
    /** A provider handle and, when cached, its local row (a v0.2 row keeps its ULID). */
    const reference = async (providerId: string) => {
      const local = await store.emails.getByProviderId(email.accountId, providerId, {
        cacheOnly: true,
        includeBodies: false,
      });
      refs.add(mailHandle(email.accountId, "email", providerId));
      if (local) {
        refs.add(local.id);
        await addId(local.matterId);
      }
    };
    const sender = email.from
      .map((address) => normalizeAddress(address.email))
      .find((address) => !ctx.selfAddresses.has(address));
    const term = sender ? queryAddress(sender) : null;
    const rows = term
      ? await reader.call((r, opts) =>
          r.search({ query: `with:${term} newer_than:90d`, limit: 10 }, opts),
        )
      : null;
    for (const row of rows?.items ?? []) {
      const handle = parseMailHandle(row.id);
      if (handle?.type === "email" && handle.accountId === email.accountId) {
        await reference(handle.providerId);
      } else {
        refs.add(row.id);
      }
    }
    // The message this one replies to, re-found by Message-ID when the thread ids differ.
    const parent = email.headers.inReplyTo;
    if (parent && !thread.items.some((item) => item.headers.messageId === parent)) {
      const found = await reader.call((r, opts) => r.findByRfc822(parent, opts));
      if (found?.value) {
        await reference(found.value);
      }
    }
  }
  refs.delete(email.id);
  const open = await store.matters.list({
    status: ["active", "waiting"],
    limit: OPEN_MATTER_SCAN,
  });
  for (const matter of open) {
    if (!matters.has(matter.id) && matter.emailIds.some((id) => refs.has(id))) {
      matters.set(matter.id, matter);
    }
  }
  for (const personId of personIds) {
    for (const matter of await store.matters.list({
      personId,
      status: ["active", "waiting"],
      limit: 8,
    })) {
      matters.set(matter.id, matter);
    }
  }
  const words = [
    ...new Set(email.subject.match(/[\p{L}\p{N}]{4,}/gu)?.map((word) => word.toLowerCase())),
  ].slice(0, 4);
  for (const word of words) {
    if (matters.size >= MATTER_CANDIDATE_LIMIT) {
      break;
    }
    for (const matter of await store.matters.list({
      text: word,
      status: ["active", "waiting"],
      limit: 4,
    })) {
      matters.set(matter.id, matter);
    }
  }
  return [...matters.values()].slice(0, MATTER_CANDIDATE_LIMIT);
}

export async function attachMatter(
  ctx: RunContext,
  email: Email,
  category: ActionCategory,
  personIds: string[],
  reader?: AgentReader | null,
): Promise<{ id?: string; summary: string }> {
  const options = await matterCandidates(ctx, email, personIds, reader);
  const vendor = (email.from[0]?.name || email.from[0]?.email.split("@")[1] || "Unknown vendor")
    .replace(/[\r\n/\\]/g, " ")
    .trim();
  const purchaseTitle = `Purchases/${vendor}`;
  if (category === "receipts") {
    for (const matter of await ctx.store.matters.list({ text: purchaseTitle, limit: 10 })) {
      if (!options.some((m) => m.id === matter.id)) {
        options.push(matter);
      }
    }
  }
  const proposal = await ctx.structured(matterSchema, matterPrompt(email, options));
  const selected =
    category === "receipts"
      ? options.find((matter) => matter.title === purchaseTitle)
      : options.find((matter) => matter.id === proposal.matterId);
  if (category !== "receipts" && proposal.matterId !== null && !selected) {
    throw new AgentError("Model selected a matter outside the candidate set", "LLM_MATTER");
  }
  const summary = String(proposal.summary);
  const emailPatch = { category, personIds };
  if (selected) {
    const params: AgentMatterAttachParams = {
      matterId: selected.id,
      emailIds: [email.id],
      personIds,
      emailPatch,
    };
    await ctx.callTool(
      "attach_to_matter",
      {
        accountId: email.accountId,
        matterId: params.matterId,
        emailIds: params.emailIds,
        personIds: params.personIds,
        reason: `Organize “${email.subject}” in ${selected.title}`,
      },
      { emailPatch, matterId: selected.id },
    );
    return { id: selected.id, summary };
  }
  const params: AgentMatterCreateParams = {
    matter: {
      title: category === "receipts" ? purchaseTitle : String(proposal.title),
      kind: category === "receipts" ? "purchase" : String(proposal.kind),
      summary,
      nextStep: String(proposal.nextStep),
      status: "active",
      personIds,
      emailIds: [email.id],
      eventIds: [],
    },
    emailPatch,
  };
  await ctx.callTool(
    "create_matter",
    {
      accountId: email.accountId,
      matter: params.matter,
      reason: `Create matter: ${params.matter.title}. ${summary}`,
    },
    { emailPatch },
  );
  const record = ctx.actions.at(-1)!;
  if (record.status !== "executed") {
    return { summary };
  }
  const id = createdMatterId(record.result);
  // Only the local matter link is needed: never a provider read.
  const attached = await ctx.store.emails.get(email.id, { cacheOnly: true, includeBodies: false });
  const persisted = id
    ? await ctx.store.matters.get(id)
    : attached?.matterId
      ? await ctx.store.matters.get(attached.matterId)
      : (await ctx.store.matters.list()).find((matter) => matter.emailIds.includes(email.id));
  if (!persisted) {
    throw new AgentError(
      "Executed matter_create did not persist or return a discoverable matter",
      "EXECUTOR_RESULT",
    );
  }
  return { id: persisted.id, summary };
}

function createdMatterId(result: Record<string, unknown> | null | undefined): string | undefined {
  const resultMatter = isObject(result?.matter) ? result.matter : undefined;
  if (typeof result?.matterId === "string") {
    return result.matterId;
  }
  if (typeof resultMatter?.id === "string") {
    return resultMatter.id;
  }
  if (typeof result?.id === "string") {
    return result.id;
  }
  return undefined;
}

/** Stored thread members read (with bodies) when the provider thread call is unavailable. */
export const THREAD_FALLBACK_EMAILS = 10;

/**
 * The thread for reply drafting, oldest first. With a reader this is one provider `thread` call
 * (text bodies); otherwise the newest `THREAD_FALLBACK_EMAILS` members of the stored thread
 * record (each read through `storeRead`, the run's lane and budget), or the newest 50 stored rows.
 */
export async function readThread(
  store: Store,
  email: Email,
  reader?: AgentReader | null,
  storeRead: (opts: EmailGetOptions) => EmailGetOptions = (opts) => opts,
): Promise<Email[]> {
  const handle = parseMailHandle(email.threadId);
  if (reader && handle?.type === "thread" && handle.accountId === email.accountId) {
    const thread = await reader.call((r, opts) =>
      r.thread(handle.providerId, { format: "text", ...opts }),
    );
    if (thread) {
      return [...thread.value].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    }
  }
  const thread = await store.threads.get(email.threadId);
  if (thread) {
    const items = await Promise.all(
      thread.emailIds
        .slice(-THREAD_FALLBACK_EMAILS)
        .map((id) => store.emails.get(id, storeRead({ includeBodies: true }))),
    );
    return items
      .filter((item): item is Email => item !== null)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }
  const page = await store.emails.query({
    threadId: email.threadId,
    includeDeleted: true,
    includeBodies: true,
    sort: "receivedAt_desc",
    limit: 50,
  });
  return page.items.reverse();
}
