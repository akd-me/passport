import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, ResourceListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMailboxMcpServer } from "./index.js";
import { MemoryBus, MemoryExecutor, MemoryPolicy, MemoryStore } from "./testing/fakes.js";
import * as f from "./testing/fixtures.js";

const toolNames = [
  "search_emails", "get_email", "get_thread", "list_mailboxes", "list_matters", "get_matter", "list_people", "get_person",
  "list_events", "free_busy", "list_pending_decisions", "list_actions", "get_trust", "get_user_profile",
  "archive_emails", "label_emails", "mark_read", "move_emails", "create_draft", "reply_draft", "send", "unsubscribe",
  "respond_to_event", "propose_meeting", "create_matter", "update_matter", "attach_to_matter", "update_person", "snooze", "undo_action", "cancel_held_action",
];

describe("mailbox MCP over SDK InMemoryTransport", () => {
  let store: MemoryStore;
  let policy: MemoryPolicy;
  let executor: MemoryExecutor;
  let bus: MemoryBus;
  let client: Client;
  let server: ReturnType<typeof createMailboxMcpServer>;
  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    const text = response.content.find(content => content.type === "text");
    if (text?.type !== "text") throw new Error("Expected text tool response");
    return { response, value: text.text.startsWith("{") ? JSON.parse(text.text) : { error: "SDK_VALIDATION", reason: text.text } };
  }
  beforeEach(async () => {
    store = new MemoryStore(); policy = new MemoryPolicy(); executor = new MemoryExecutor(store, policy); bus = new MemoryBus();
    await store.accounts.upsert(f.account());
    await store.mailboxes.upsertMany([f.mailbox(), f.mailbox({ id: "archive-1", name: "Archive", role: "archive" })]);
    await store.emails.upsertMany([f.email()]);
    await store.threads.upsertMany([{ id: "thread-1", accountId: "account-1", emailIds: ["email-1"] }]);
    await store.people.upsert(f.person()); await store.matters.upsert(f.matter()); await store.events.upsertMany([f.event()]);
    await store.kv.set("user_profile", "# USER.md\n\nKeep replies brief.");
    server = createMailboxMcpServer({ store, executor, policy, bus });
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
  });
  afterEach(async () => { await client.close(); await server.close(); expect(bus.listenerCount).toBe(0); });

  it("lists every required tool with described JSON schemas and accurate read/write annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual([...toolNames].sort());
    expect(tools.every(tool => tool.description && tool.inputSchema.type === "object")).toBe(true);
    expect(tools.find(tool => tool.name === "search_emails")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find(tool => tool.name === "send")?.annotations?.readOnlyHint).toBe(false);
    expect(tools.some(tool => /delete|purge|approve|set_trust/.test(tool.name))).toBe(false);
    expect(tools.find(tool => tool.name === "search_emails")?.inputSchema.properties?.text).toMatchObject({ description: expect.stringContaining("FTS5") });
  });
  it("searches using EmailQuery and passes FTS and pagination to the injected store", async () => {
    const { value } = await call("search_emails", { text: "project", accountId: "account-1", mailboxId: "inbox-1", limit: 1 });
    expect(value.items).toHaveLength(1); expect(value.items[0].subject).toBe("Project update");
    expect(value.items[0]).not.toHaveProperty("textBody");
    expect(store.emailQueries.at(-1)).toMatchObject({ text: "project", accountId: "account-1", mailboxId: "inbox-1", limit: 1, includeBodies: false });
    await call("search_emails", { text: '"quarterly report" AND renewal', keywords: { has: ["$seen"], not: ["$draft"] }, matterId: null, personId: "person-1", cursor: "offset:1", sort: "receivedAt_asc" });
    expect(store.emailQueries.at(-1)).toMatchObject({ text: '"quarterly report" AND renewal', keywords: { has: ["$seen"], not: ["$draft"] }, matterId: null, cursor: "offset:1", sort: "receivedAt_asc" });
  });
  it("truncates text and HTML bodies by default and respects explicit full=true", async () => {
    await store.emails.upsertMany([f.email({ textBody: "x".repeat(2000), htmlBody: "y".repeat(3000) })]);
    const compact = (await call("get_email", { emailId: "email-1" })).value;
    expect(compact.textBody).toHaveLength(1200); expect(compact.htmlBody).toHaveLength(1200); expect(compact.truncated).toBe(true);
    const full = (await call("get_email", { emailId: "email-1", full: true })).value;
    expect(full.textBody).toHaveLength(2000); expect(full.htmlBody).toHaveLength(3000); expect(full.truncated).toBe(false);
    const search = (await call("search_emails", { full: true })).value;
    expect(search.items[0].textBody).toHaveLength(2000);
  });
  it("paginates thread email bodies without returning unbounded email ID lists", async () => {
    await store.emails.upsertMany([f.email({ id: "email-2", receivedAt: "2026-10-21T12:00:00.000Z" })]);
    const first = (await call("get_thread", { threadId: "thread-1", limit: 1 })).value;
    expect(first.items[0].id).toBe("email-1"); expect(first.nextCursor).toBe("offset:1");
    expect(first).not.toHaveProperty("emailIds");
    expect((await call("get_thread", { threadId: "thread-1", limit: 1, cursor: first.nextCursor })).value.items[0].id).toBe("email-2");
  });
  it.each(["ask", "allow", "hold", "deny"] as const)("returns an honest %s policy result and policy_note for writes", async outcome => {
    policy.outcome = outcome;
    const { response, value } = await call("archive_emails", { emailIds: ["email-1"], reason: "Inbox triage" });
    expect(value.decision.outcome).toBe(outcome); expect(value.decision.reason).toBeTruthy();
    expect(value.status).toBe(({ ask: "proposed", allow: "executed", hold: "held", deny: "rejected" })[outcome]);
    expect(value.policy_note).toContain(value.decision.trustLevel);
    expect(Boolean(response.isError)).toBe(outcome === "deny");
    expect(executor.submitted[0]?.actor).toEqual({ kind: "external-agent", id: "test-client" });
    expect(store.data.emails.get("email-1")?.mailboxIds).toEqual(["inbox-1"]); // Only executor may mutate.
    expect(value).not.toHaveProperty("params");
  });
  it("allows a trusted host to set the audit client name", async () => {
    await client.close(); await server.close();
    server = createMailboxMcpServer({ store, executor, policy, bus, clientName: "codex-workspace" });
    const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
    await call("mark_read", { emailIds: ["email-1"], reason: "Read" });
    expect(executor.submitted[0]?.actor).toEqual({ kind: "external-agent", id: "codex-workspace" });
  });
  it("does not allow actor/category injection or identity verification edits", async () => {
    expect((await call("archive_emails", { emailIds: ["email-1"], reason: "Archive", actor: { kind: "human", id: "user" } })).response.isError).toBe(true);
    expect((await call("archive_emails", { emailIds: ["email-1"], reason: "Archive", category: "triage" })).response.isError).toBe(true);
    expect((await call("update_person", { personId: "person-1", patch: { verification: "blue" }, reason: "Verify" })).response.isError).toBe(true);
    expect(executor.submitted).toHaveLength(0);
  });
  it("builds a threaded reply with quoted text and reply-only recipients", async () => {
    await call("reply_draft", { emailId: "email-1", textBody: "Tuesday works", reason: "Reply to Ada" });
    const request = executor.submitted[0];
    expect(request).toMatchObject({ type: "draft_create", accountId: "account-1", category: "replies_known", counterparty: { class: "green_known" }, params: { draft: {
      inReplyToEmailId: "email-1", subject: "Re: Project update", to: [{ name: "Ada", email: "ada@example.com" }],
      textBody: expect.stringContaining("> The project is ready.\n> Can we meet?"),
    } } });
  });
  it("respects Reply-To, preserves Re:, excludes own accounts and BCC, and deduplicates reply-all", async () => {
    await store.accounts.upsert(f.account({ id: "account-2", emailAddress: "alias@example.com" }));
    await store.people.upsert(f.person({ id: "self", relationship: "self", emails: ["own-alias@example.com"], primaryEmail: "own-alias@example.com" }));
    await store.emails.upsertMany([f.email({ subject: "RE: Launch", replyTo: [{ email: "reply@example.com" }],
      to: [{ email: "me@example.com" }, { email: "alias@example.com" }, { email: "own-alias@example.com" }, { email: "reply@example.com" }, { email: "colleague@example.com" }],
      cc: [{ email: "COLLEAGUE@example.com" }, { email: "other@example.com" }], bcc: [{ email: "private@example.com" }] })]);
    await call("reply_draft", { emailId: "email-1", textBody: "Thanks", replyAll: true, quoteOriginal: false, reason: "Reply all" });
    expect(executor.submitted[0]).toMatchObject({ category: "replies_stranger", params: { draft: { subject: "RE: Launch", textBody: "Thanks",
      to: [{ email: "reply@example.com" }, { email: "colleague@example.com" }], cc: [{ email: "other@example.com" }], inReplyToEmailId: "email-1" } } });
    expect(executor.submitted[0]?.params).not.toHaveProperty("draft.bcc");
  });
  it("replies to sent mail using the original recipient instead of ourselves", async () => {
    await store.emails.upsertMany([f.email({ from: [{ email: "me@example.com" }], to: [{ email: "ada@example.com" }] })]);
    await call("reply_draft", { emailId: "email-1", textBody: "Following up", reason: "Follow up" });
    expect(executor.submitted[0]?.params).toMatchObject({ draft: { to: [{ email: "ada@example.com" }] } });
  });
  it("passes sends through policy and preserves hold timestamps", async () => {
    policy.outcome = "hold";
    const result = await call("send", { draft: f.draft(), reason: "Send update" });
    expect(result.value.status).toBe("held"); expect(result.value.holdUntil).toBe("2099-10-20T12:05:00.000Z");
    expect(executor.submitted[0]).toMatchObject({ type: "send", category: "replies_known", params: { draft: f.draft() } });
  });
  it("accepts saved drafts, classifies BCC recipients, and rejects ambiguous/non-draft sends", async () => {
    await store.emails.upsertMany([f.email({ id: "draft-1", keywords: { $draft: true }, to: [{ email: "ada@example.com" }], bcc: [{ email: "stranger@example.com" }] })]);
    await call("send", { draftEmailId: "draft-1", reason: "Send saved draft" });
    expect(executor.submitted[0]).toMatchObject({ type: "send", category: "replies_stranger", counterparty: { class: "stranger" }, params: { draftEmailId: "draft-1" } });
    for (const args of [{}, { draftEmailId: "email-1" }, { draftEmailId: "draft-1", draft: f.draft() }]) {
      expect((await call("send", { ...args, reason: "Send" })).response.isError).toBe(true);
    }
    expect(executor.submitted).toHaveLength(1);
  });
  it("rejects cross-account targets and unsafe move destinations before submission", async () => {
    await store.accounts.upsert(f.account({ id: "account-2" }));
    await store.emails.upsertMany([f.email({ id: "email-2", accountId: "account-2" })]);
    await store.mailboxes.upsertMany([f.mailbox({ id: "trash", role: "trash" })]);
    for (const [name, args] of [
      ["archive_emails", { emailIds: ["email-1", "email-2"] }],
      ["move_emails", { emailIds: ["email-2"], toMailboxId: "archive-1" }],
      ["move_emails", { emailIds: ["email-1"], toMailboxId: "trash" }],
      ["create_draft", { draft: f.draft({ accountId: "account-2", inReplyToEmailId: "email-1" }) }],
    ] as const) expect((await call(name, { ...args, reason: "Change" })).response.isError).toBe(true);
    expect(executor.submitted).toHaveLength(0);
  });
  it.each([
    ["label_emails", { emailIds: ["email-1"], label: "Launch" }, "label"],
    ["label_emails", { emailIds: ["email-1"], label: "Launch", remove: true }, "unlabel"],
    ["mark_read", { emailIds: ["email-1"] }, "mark_read"],
    ["move_emails", { emailIds: ["email-1"], toMailboxId: "archive-1" }, "move"],
    ["create_draft", { draft: f.draft() }, "draft_create"],
    ["respond_to_event", { eventId: "event-1", status: "accepted", comment: "Thanks" }, "calendar_respond"],
    ["propose_meeting", { draft: f.draft(), slots: [{ start: "2099-10-21T13:00:00Z", end: "2099-10-21T14:00:00Z" }] }, "calendar_propose"],
    ["create_matter", { matter: { title: "New launch" } }, "matter_create"],
    ["update_matter", { matterId: "matter-1", patch: { summary: "Ready" } }, "matter_update"],
    ["attach_to_matter", { matterId: "matter-1", emailIds: ["email-1"], eventIds: ["event-1"], personIds: ["person-1"] }, "matter_attach"],
    ["update_person", { personId: "person-1", patch: { notes: "Project lead" } }, "person_update"],
    ["snooze", { matterId: "matter-1", emailIds: ["email-1"], until: "2099-10-21T14:00:00Z" }, "snooze"],
  ] as const)("routes %s through the executor without direct domain writes", async (name, args, type) => {
    const result = await call(name, { ...args, reason: "Agent request" });
    expect(result.response.isError).toBeUndefined(); expect(result.value.policy_note).toContain("supervised");
    expect(executor.submitted).toHaveLength(1); expect(executor.submitted[0]).toMatchObject({ type, reason: "Agent request", actor: { kind: "external-agent", id: "test-client" } });
  });
  it("requires a List-Unsubscribe header for header unsubscribe and infers its category", async () => {
    expect((await call("unsubscribe", { emailId: "email-1", reason: "Leave" })).response.isError).toBe(true);
    await store.emails.upsertMany([f.email({ headers: { messageId: null, inReplyTo: null, references: [], listUnsubscribe: "<mailto:leave@example.com>" } })]);
    await call("unsubscribe", { emailId: "email-1", reason: "Leave" });
    expect(executor.submitted[0]).toMatchObject({ type: "unsubscribe", category: "unsubscribe", params: { emailId: "email-1", method: "header" } });
  });
  it("rejects invalid slots, empty patches, missing targets, and past snoozes", async () => {
    for (const [name, args] of [
      ["propose_meeting", { draft: f.draft(), slots: [{ start: "2026-10-21T14:00:00Z", end: "2026-10-21T13:00:00Z" }] }],
      ["snooze", { emailIds: ["email-1"], until: "2000-01-01T00:00:00Z" }], ["snooze", { until: "2099-01-01T00:00:00Z" }],
      ["update_matter", { matterId: "matter-1", patch: {} }], ["update_person", { personId: "person-1", patch: { primaryEmail: "other@example.com" } }],
      ["attach_to_matter", { matterId: "matter-1" }],
      ["archive_emails", { emailIds: ["email-1"], reason: "Multiline\nreason" }],
    ] as const) expect((await call(name, { reason: "Change", ...args })).response.isError).toBe(true);
    expect(executor.submitted).toHaveLength(0);
  });
  it("resubmits undo inverses with external identity so a human actor cannot be inherited", async () => {
    const inverse = { ...f.action().request, type: "unarchive" as const, actor: { kind: "human" as const, id: "user" } };
    await store.actions.insert(f.action({ id: "original", request: { ...f.action().request, category: "legal" }, inverse }));
    policy.outcome = "ask";
    const result = await call("undo_action", { actionId: "original", reason: "Restore to inbox" });
    expect(result.value.status).toBe("proposed");
    expect(executor.submitted[0]).toMatchObject({ type: "unarchive", category: "legal", actor: { kind: "external-agent", id: "test-client" }, reason: "Undo original: Restore to inbox" });
    expect((await store.actions.get("original"))?.status).toBe("executed");
    expect((await call("undo_action", { actionId: "action-1", reason: "Undo proposed" })).response.isError).toBe(true);
  });
  it("cancels this client's held action using the executor and rejects other owners", async () => {
    policy.outcome = "hold";
    const held = await call("send", { draft: f.draft(), reason: "Send later" });
    const cancelled = await call("cancel_held_action", { actionId: held.value.id });
    expect(cancelled.value.status).toBe("rejected"); expect(executor.cancelled).toEqual([held.value.id]);
    await store.actions.insert(f.action({ id: "human-held", status: "held", request: { ...f.action().request, actor: { kind: "human", id: "user" } } }));
    expect((await call("cancel_held_action", { actionId: "human-held" })).value.error).toBe("NOT_OWNER");
    expect(executor.cancelled).toHaveLength(1);
  });
  it("reads matters with attached emails, events and people even without backlinks", async () => {
    const result = (await call("get_matter", { matterId: "matter-1" })).value;
    expect(result.matter.title).toBe("Launch"); expect(result.emails[0].id).toBe("email-1"); expect(result.emails[0].truncated).toBe(true);
    expect(result.events[0].id).toBe("event-1"); expect(result.people[0].id).toBe("person-1");
  });
  it("deduplicates and paginates explicit and linked matter emails", async () => {
    await store.emails.upsertMany([f.email({ matterId: "matter-1" }), f.email({ id: "linked", matterId: "matter-1", receivedAt: "2026-10-21T12:00:00Z" })]);
    const first = (await call("get_matter", { matterId: "matter-1", limit: 1 })).value;
    expect(first.emails.map((email: { id: string }) => email.id)).toEqual(["linked"]);
    expect(first.nextCursor).toBe("linked");
    const second = (await call("get_matter", { matterId: "matter-1", limit: 1, cursor: first.nextCursor, full: true })).value;
    expect(second.emails.map((email: { id: string }) => email.id)).toEqual(["email-1"]);
    expect(second.emails[0].truncated).toBe(false); expect(second.nextCursor).toBeNull();
    expect((await call("get_matter", { matterId: "matter-1", cursor: "not-in-matter" })).value.error).toBe("INVALID_CURSOR");
  });
  it("calculates merged clipped busy ranges while excluding cancelled/declined events", async () => {
    await store.events.upsertMany([f.event({ id: "overlap", start: "2026-10-21T13:30:00Z", end: "2026-10-21T15:00:00Z" }),
      f.event({ id: "cancelled", status: "cancelled", start: "2026-10-21T15:00:00Z", end: "2026-10-21T16:00:00Z" }),
      f.event({ id: "declined", myStatus: "declined", start: "2026-10-21T16:00:00Z", end: "2026-10-21T17:00:00Z" })]);
    const range = { start: "2026-10-21T13:45:00Z", end: "2026-10-21T16:30:00Z" };
    expect((await call("free_busy", { range })).value).toEqual({ range, source: "local_store", busy: [{ start: "2026-10-21T13:45:00.000Z", end: "2026-10-21T15:00:00.000Z" }] });
  });
  it("reads mailbox, matter, people, calendar, trust and USER.md listings", async () => {
    expect((await call("list_mailboxes")).value.items).toHaveLength(2);
    expect((await call("list_matters", { status: ["active"] })).value.items[0].id).toBe("matter-1");
    expect((await call("list_people", { relationship: "known" })).value.items[0].id).toBe("person-1");
    expect((await call("get_person", { personId: "person-1" })).value.displayName).toBe("Ada");
    expect((await call("list_events", { range: { start: "2026-10-21T00:00:00Z", end: "2026-10-22T00:00:00Z" } })).value.items[0].id).toBe("event-1");
    expect((await call("get_trust")).value.config.externalAgentCeiling).toBe("auto_accept_edits");
    expect((await call("get_user_profile")).value.markdown).toContain("Keep replies brief");
  });
  it("keeps pending decisions distinct from the complete audit log and omits raw secrets/results", async () => {
    await call("archive_emails", { emailIds: ["email-1"], reason: "Triage" });
    policy.outcome = "allow"; await call("mark_read", { emailIds: ["email-1"], reason: "Read" });
    await store.actions.update("action-2", { result: { token: "fixture-secret-never-expose" }, error: "fixture-secret-never-expose" });
    const pending = (await call("list_pending_decisions")).value;
    expect(pending.items.map((item: { id: string }) => item.id)).toEqual(["action-1"]);
    const log = (await call("list_actions")).value; expect(log.items).toHaveLength(2);
    expect(JSON.stringify(log)).not.toContain("fixture-secret-never-expose");
    expect(store.credentialReads).toBe(0);
  });
  it("returns safe tool errors on missing records or dependency exceptions", async () => {
    expect((await call("get_email", { emailId: "missing" })).value.error).toBe("NOT_FOUND");
    vi.spyOn(executor, "submit").mockRejectedValueOnce(new Error("Authorization: fixture-secret-never-expose"));
    const failed = await call("archive_emails", { emailIds: ["email-1"], reason: "Archive" });
    expect(failed.response.isError).toBe(true); expect(failed.value.policy_note).toBeTruthy();
    expect(JSON.stringify(failed)).not.toContain("fixture-secret-never-expose");
  });
  it("lists and reads all resource families as markdown with no mutation", async () => {
    const listed = await client.listResources();
    expect(listed.resources.map(resource => resource.uri)).toEqual(expect.arrayContaining(["passport://user-profile", "passport://decisions", "passport://matters/matter-1", "passport://people/person-1"]));
    const templates = await client.listResourceTemplates(); expect(templates.resourceTemplates).toHaveLength(2);
    for (const [uri, contains] of [["passport://matters/matter-1", "# Launch"], ["passport://people/person-1", "# Ada"],
      ["passport://user-profile", "Keep replies brief"], ["passport://decisions", "No pending decisions"]]) {
      const resource = await client.readResource({ uri: uri! });
      expect(resource.contents[0]).toMatchObject({ uri, mimeType: "text/markdown", text: expect.stringContaining(contains!) });
    }
    expect(executor.submitted).toHaveLength(0);
  });
  it("redacts dependency exceptions in both resource reads and discovery", async () => {
    vi.spyOn(store.matters, "get").mockRejectedValueOnce(new Error("fixture-secret-never-expose"));
    await expect(client.readResource({ uri: "passport://matters/matter-1" })).rejects.toThrow("Unable to read this Passport resource");
    vi.spyOn(store.matters, "list").mockRejectedValueOnce(new Error("fixture-secret-never-expose"));
    await expect(client.listResources()).rejects.toThrow("Unable to list Passport resources");
  });
  it("notifies clients of resource changes without forwarding full domain events", async () => {
    const changed = vi.fn();
    client.setNotificationHandler(ResourceListChangedNotificationSchema, changed);
    bus.emit({ type: "matter.updated", matter: f.matter() });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(JSON.stringify(changed.mock.calls)).not.toContain("Launch planning");
  });
  it("renders pending policy reasons in the decisions resource and exposes both prompts", async () => {
    await call("archive_emails", { emailIds: ["email-1"], reason: "Triage newsletter" });
    const resource = await client.readResource({ uri: "passport://decisions" });
    expect(resource.contents[0]).toMatchObject({ text: expect.stringContaining("Fake policy: ask") });
    expect((await client.listPrompts()).prompts.map(prompt => prompt.name)).toEqual(["triage_inbox", "summarize_matter"]);
    const prompt = await client.getPrompt({ name: "summarize_matter", arguments: { matterId: "matter-1" } });
    expect(prompt.messages[0]?.content).toMatchObject({ type: "text", text: expect.stringContaining("passport://matters/matter-1") });
  });
});
