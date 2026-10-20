import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ActionExecutor, ActionParams, ActionRequest, ActionType, Email, EventBus, PolicyEngine, Store } from "@passport/types";
import { categorize } from "./categorize.js";
import { MailboxMcpError, required } from "./presentation.js";

/** Collaborators are owned by the host; closing an MCP server never closes the store or bus. */
export interface MailboxMcpDependencies {
  store: Store;
  executor: ActionExecutor;
  policy: PolicyEngine;
  bus: EventBus;
  /** Trusted host override; otherwise the MCP initialization client's name is used as an audit label. */
  clientName?: string;
}

export class Context {
  readonly store: Store;
  constructor(readonly deps: MailboxMcpDependencies, readonly server: McpServer) { this.store = deps.store; }

  actor() {
    return { kind: "external-agent" as const, id: this.deps.clientName ?? this.server.server.getClientVersion()?.name ?? "mcp-client" };
  }

  async account(accountId?: string) {
    if (accountId) return required(await this.store.accounts.get(accountId), "Account");
    const accounts = await this.store.accounts.list();
    if (accounts.length !== 1) throw new MailboxMcpError("ACCOUNT_REQUIRED", "Provide accountId when there is not exactly one account.");
    return required(accounts[0], "Account");
  }

  async email(id: string, includeBodies = false) {
    return required(await this.store.emails.get(id, { includeBodies }), "Email");
  }

  async emailBatch(ids: string[], accountId?: string) {
    const emails = await Promise.all([...new Set(ids)].map(id => this.email(id)));
    const inferredId = accountId ?? required(emails[0], "Email").accountId;
    if (emails.some(email => email.accountId !== inferredId)) throw new MailboxMcpError("ACCOUNT_MISMATCH", "Split mail operations into separate calls per account.");
    await this.account(inferredId);
    return { accountId: inferredId, emails };
  }

  async submit<T extends ActionType>(type: T, accountId: string, params: ActionParams[T], reason: string,
    context: { emails?: Email[]; recipientEmails?: string[]; personIds?: string[]; matterId?: string; sensitiveCategory?: "money" | "legal" } = {}) {
    const accounts = await this.store.accounts.list();
    const addresses = [...new Set([...(context.recipientEmails ?? []), ...(context.emails ?? []).flatMap(email => email.from.map(address => address.email))].map(email => email.trim().toLowerCase()))];
    const people = (await Promise.all([
      ...addresses.map(email => this.store.people.getByEmail(email)),
      ...(context.personIds ?? []).map(id => this.store.people.get(id)),
    ])).filter(person => person !== null);
    const inference = categorize({ type, emails: context.emails, people, recipientEmails: context.recipientEmails, matterId: context.matterId, selfEmails: accounts.map(account => account.emailAddress) });
    if (context.sensitiveCategory === "legal" || (context.sensitiveCategory === "money" && inference.category !== "legal")) inference.category = context.sensitiveCategory;
    const request: ActionRequest<T> = {
      type, accountId, params, reason, actor: this.actor(), ...inference,
      ...(context.matterId ? { matterId: context.matterId } : {}),
    };
    return this.deps.executor.submit(request);
  }

  async matterBundle(id: string, limit = 25, cursor?: string | null, includeBodies = false) {
    const matter = required(await this.store.matters.get(id), "Matter");
    // The contract tracks explicit attachments in matter.*Ids and also permits back-links.
    const [attachedEmails, linkedEmails, attachedEvents, linkedEvents, people] = await Promise.all([
      Promise.all(matter.emailIds.map(id => this.store.emails.get(id))),
      this.store.emails.query({ matterId: id, limit: 100, includeBodies: false }),
      Promise.all(matter.eventIds.map(id => this.store.events.get(id))),
      this.store.events.query({ matterId: id, limit: 100 }),
      Promise.all(matter.personIds.map(id => this.store.people.get(id))),
    ]);
    const emails = [...new Map([...attachedEmails.filter(email => email !== null), ...linkedEmails.items].map(email => [email.id, email])).values()]
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || a.id.localeCompare(b.id));
    let offset = 0;
    if (cursor != null) {
      offset = emails.findIndex(email => email.id === cursor) + 1;
      if (offset === 0) throw new MailboxMcpError("INVALID_CURSOR", "Matter cursor must be an email ID from this matter.");
    }
    const page = emails.slice(offset, offset + limit);
    const withBodies = includeBodies ? (await Promise.all(page.map(email => this.store.emails.get(email.id, { includeBodies: true })))).filter(email => email !== null) : page;
    return { matter, emails: withBodies,
      nextCursor: offset + limit < emails.length ? page.at(-1)?.id ?? null : null,
      // Linked queries may have further pages; report their cursor explicitly, never silently omit it.
      linkedEmailsNextCursor: linkedEmails.nextCursor ?? null,
      events: [...new Map([...attachedEvents.filter(event => event !== null), ...linkedEvents].map(event => [event.id, event])).values()],
      people: people.filter(person => person !== null) };
  }
}
