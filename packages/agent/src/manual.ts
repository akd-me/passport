import type { ActionCategory, Counterparty, DraftInput, Email, EmailAddress, Matter } from "@passport/types";
import type { RunContext } from "./context.js";
import { normalizeAddress } from "./data.js";
import { AgentError } from "./errors.js";
import { isObject, validateJson } from "./llm/json.js";
import type { JsonSchema, LlmMessage, LlmTool, LlmToolCall } from "./llm/types.js";
import { formatDraft } from "./profile.js";
import { manualPrompt, systemPrompt } from "./prompts/index.js";
import { categorySchema, objectSchema, string, strings } from "./schemas.js";

const emailIds: JsonSchema = { ...strings, minItems: 1, maxItems: 100 };
const address = objectSchema({ email: string, name: { type: "string" } }, ["email"]);
const draftSchema = objectSchema({ accountId: string, inReplyToEmailId: string, to: { type: "array", items: address, minItems: 1 }, cc: { type: "array", items: address }, bcc: { type: "array", items: address }, subject: string, textBody: string }, ["accountId", "to", "subject", "textBody"]);
const matterPatch = objectSchema({ title: string, summary: string, nextStep: { type: ["string", "null"] }, status: { type: "string", enum: ["active", "waiting", "snoozed", "done"] } }, []);
function tool(name: string, description: string, schema: JsonSchema): LlmTool { return { name, description, inputSchema: schema }; }

export const MANUAL_TOOLS: LlmTool[] = [
  tool("search_mail", "Search stored mail; quote FTS literals when needed.", objectSchema({ text: string, accountId: string, limit: { type: "integer", minimum: 1, maximum: 100 } }, [])),
  tool("read_email", "Read one stored email and its body.", objectSchema({ emailId: string })),
  tool("read_matter", "Read one matter.", objectSchema({ matterId: string })),
  tool("list_matters", "Find matters by text or person.", objectSchema({ text: string, personId: string }, [])),
  tool("free_busy", "Read non-cancelled, non-declined calendar busy intervals.", objectSchema({ start: string, end: string })),
  tool("draft", "Submit a draft for policy review; does not send.", objectSchema({ draft: draftSchema, category: categorySchema }, ["draft"])),
  tool("send", "Submit an existing draft or a new draft to the policy-controlled outbox.", objectSchema({ draftEmailId: string, draft: draftSchema, category: categorySchema }, [])),
  tool("archive", "Submit archive actions for stored emails.", objectSchema({ emailIds, category: categorySchema }, ["emailIds"])),
  tool("label", "Submit label actions for stored emails.", objectSchema({ emailIds, label: string, category: categorySchema }, ["emailIds", "label"])),
  tool("matter_create", "Submit a new matter. Use only existing email/person IDs.", objectSchema({ accountId: string, title: string, summary: string, kind: string, nextStep: { type: "string" }, emailIds: strings, personIds: strings }, ["accountId", "title", "summary"])),
  tool("matter_update", "Submit changes to an existing matter.", objectSchema({ accountId: string, matterId: string, patch: matterPatch })),
  tool("matter_attach", "Submit attachment of existing emails or people to a matter.", objectSchema({ accountId: string, matterId: string, emailIds: strings, personIds: strings }, ["accountId", "matterId"])),
];

async function readEmail(ctx: RunContext, id: string): Promise<Email> {
  const email = await ctx.store.emails.get(id, { includeBodies: true });
  if (!email) throw new AgentError("Email not found", "INPUT_EMAIL");
  return email;
}

async function readMatter(ctx: RunContext, id: string): Promise<Matter> {
  const matter = await ctx.store.matters.get(id);
  if (!matter) throw new AgentError("Matter not found", "INPUT_MATTER");
  return matter;
}

async function account(ctx: RunContext, id: string): Promise<void> {
  if (!await ctx.store.accounts.get(id)) throw new AgentError("Account not found", "INPUT_ACCOUNT");
}

async function checkRefs(ctx: RunContext, accountId: string, emails: string[] = [], people: string[] = []): Promise<void> {
  await account(ctx, accountId);
  for (const id of emails) if ((await readEmail(ctx, id)).accountId !== accountId) throw new AgentError("Email belongs to a different account", "INPUT_ACCOUNT");
  for (const id of people) if (!await ctx.store.people.get(id)) throw new AgentError("Person not found", "INPUT_PERSON");
}

async function prepareDraft(ctx: RunContext, raw: unknown): Promise<DraftInput> {
  validateJson(raw, draftSchema);
  const draft = raw as DraftInput;
  await account(ctx, draft.accountId);
  if (draft.inReplyToEmailId && (await readEmail(ctx, draft.inReplyToEmailId)).accountId !== draft.accountId) throw new AgentError("Reply belongs to a different account", "INPUT_ACCOUNT");
  return { ...draft, textBody: formatDraft(draft.textBody, ctx.profile, ctx.drafts) };
}

async function counterparties(ctx: RunContext, addresses: EmailAddress[]): Promise<Counterparty> {
  const emails = [...new Set(addresses.map(address => normalizeAddress(address.email)))];
  const classes: Counterparty["class"][] = [];
  for (const email of emails) {
    const person = await ctx.store.people.getByEmail(email);
    classes.push(ctx.selfAddresses.has(email) ? "self" : !person || person.relationship === "stranger" ? "stranger" : person.relationship === "service" ? "service" : person.verification === "blue" ? "blue" : person.relationship === "known" ? "green_known" : "stranger");
  }
  const priority: Counterparty["class"][] = ["stranger", "service", "green_known", "blue", "self"];
  return { emails, class: priority.find(value => classes.includes(value)) ?? "stranger" };
}

async function execute(ctx: RunContext, call: LlmToolCall): Promise<unknown> {
  const definition = MANUAL_TOOLS.find(item => item.name === call.name);
  if (!definition) throw new AgentError("Unknown tool", "INPUT_TOOL");
  validateJson(call.arguments, definition.inputSchema);
  if (!isObject(call.arguments)) throw new AgentError("Tool arguments must be an object", "INPUT_TOOL");
  const args = call.arguments;
  const category = (args.category ?? "other") as ActionCategory;
  const reason = `Manual instruction: ${call.name}`;
  switch (call.name) {
    case "search_mail": return ctx.store.emails.query({ text: args.text as string | undefined, accountId: args.accountId as string | undefined, limit: (args.limit as number | undefined) ?? 20 });
    case "read_email": return readEmail(ctx, String(args.emailId));
    case "read_matter": return readMatter(ctx, String(args.matterId));
    case "list_matters": return ctx.store.matters.list({ text: args.text as string | undefined, personId: args.personId as string | undefined, limit: 30 });
    case "free_busy": {
      const start = String(args.start), end = String(args.end);
      if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) >= Date.parse(end)) throw new AgentError("Invalid calendar range", "INPUT_RANGE");
      return (await ctx.store.events.query({ range: { start, end } })).filter(item => item.status !== "cancelled" && item.myStatus !== "declined").map(item => ({ start: item.start, end: item.end }));
    }
    case "draft": {
      const draft = await prepareDraft(ctx, args.draft);
      return ctx.submit({ type: "draft_create", accountId: draft.accountId, category, reason, counterparty: await counterparties(ctx, [...draft.to, ...draft.cc ?? [], ...draft.bcc ?? []]), params: { draft } });
    }
    case "send": {
      if (Boolean(args.draftEmailId) === Boolean(args.draft)) throw new AgentError("Provide exactly one draftEmailId or draft", "INPUT_DRAFT");
      if (args.draftEmailId) {
        const email = await readEmail(ctx, String(args.draftEmailId));
        if (!email.keywords.$draft) throw new AgentError("Only a draft can be submitted for send", "INPUT_DRAFT");
        return ctx.submit({ type: "send", accountId: email.accountId, category, reason, counterparty: await counterparties(ctx, [...email.to, ...email.cc, ...email.bcc]), params: { draftEmailId: email.id } });
      }
      const draft = await prepareDraft(ctx, args.draft);
      return ctx.submit({ type: "send", accountId: draft.accountId, category, reason, counterparty: await counterparties(ctx, [...draft.to, ...draft.cc ?? [], ...draft.bcc ?? []]), params: { draft } });
    }
    case "archive": case "label": {
      const groups = new Map<string, Email[]>();
      for (const id of args.emailIds as string[]) {
        const email = await readEmail(ctx, id);
        groups.set(email.accountId, [...groups.get(email.accountId) ?? [], email]);
      }
      const records = [];
      for (const [accountId, emails] of groups) {
        const common = { accountId, category, reason };
        records.push(call.name === "archive"
          ? await ctx.submit({ ...common, type: "archive", params: { emailIds: emails.map(email => email.id) } })
          : await ctx.submit({ ...common, type: "label", params: { emailIds: emails.map(email => email.id), label: String(args.label) } }));
      }
      return records;
    }
    case "matter_create": {
      const accountId = String(args.accountId);
      const emails = (args.emailIds ?? []) as string[], people = (args.personIds ?? []) as string[];
      await checkRefs(ctx, accountId, emails, people);
      return ctx.submit({ type: "matter_create", accountId, category: "matters", reason, params: { matter: { title: String(args.title), summary: String(args.summary), kind: args.kind as string | undefined, nextStep: args.nextStep as string | undefined, status: "active", emailIds: emails, personIds: people, eventIds: [] } } });
    }
    case "matter_update": {
      const accountId = String(args.accountId), matterId = String(args.matterId);
      await account(ctx, accountId);
      await readMatter(ctx, matterId);
      return ctx.submit({ type: "matter_update", accountId, category: "matters", reason, matterId, params: { matterId, patch: args.patch as Partial<Matter> } });
    }
    case "matter_attach": {
      const accountId = String(args.accountId), matterId = String(args.matterId);
      const emails = (args.emailIds ?? []) as string[], people = (args.personIds ?? []) as string[];
      await checkRefs(ctx, accountId, emails, people);
      await readMatter(ctx, matterId);
      return ctx.submit({ type: "matter_attach", accountId, category: "matters", reason, matterId, params: { matterId, emailIds: emails, personIds: people } });
    }
    default: throw new AgentError("Unknown tool", "INPUT_TOOL");
  }
}

export async function manual(ctx: RunContext, trigger: Extract<import("@passport/types").AgentTrigger, { kind: "manual" }>): Promise<void> {
  const selected = await Promise.all((trigger.emailIds ?? []).map(id => readEmail(ctx, id)));
  const matter = trigger.matterId ? await readMatter(ctx, trigger.matterId) : undefined;
  const messages: LlmMessage[] = [{ role: "user", content: manualPrompt(trigger.instruction, { emails: selected, matter }) }];
  let calls = 0;
  while (calls < 12) {
    const response = await ctx.complete({ system: systemPrompt(ctx.profile, ctx.drafts), messages, tools: MANUAL_TOOLS, model: "main" });
    if (!response.toolCalls.length) {
      // Retain only operational metadata, never a raw transcript or full email bodies.
      ctx.notes.push(`Manual instruction completed with ${calls} tool calls.`);
      return;
    }
    messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });
    for (const call of response.toolCalls) {
      if (calls === 12) break;
      calls++;
      let result: unknown;
      let isError = false;
      try { result = await execute(ctx, call); }
      catch (error) {
        if (!(error instanceof AgentError) || !error.code.startsWith("INPUT_")) throw error;
        result = { error: error.message, code: error.code };
        isError = true;
      }
      messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result), isError });
    }
  }
  ctx.notes.push("Manual tool-call limit reached (12); remaining work requires another run.");
}
