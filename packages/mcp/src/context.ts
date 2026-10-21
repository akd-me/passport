import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ActionExecutor, EventBus, PolicyEngine, Store } from "@passport/types";
import { MailboxMcpError, required } from "./presentation.js";

/** Collaborators are owned by the host; closing an MCP server never closes the store or bus. */
export interface MailboxMcpDependencies {
  log?: (message: string) => void;
  store: Store;
  executor: ActionExecutor;
  policy: PolicyEngine;
  bus: EventBus;
  /** Trusted host override; otherwise the MCP initialization client's name is used as an audit label. */
  clientName?: string;
  /** Maximum serialized response size in bytes, including resource content. Default 512 KiB. */
  responseByteBudget?: number;
  freeBusy?: import("@passport/tools").FreeBusyResolver;
}

export class Context {
  readonly store: Store;
  constructor(
    readonly deps: MailboxMcpDependencies,
    readonly server: McpServer,
  ) {
    this.store = deps.store;
  }

  async matterBundle(id: string, limit = 25, cursor?: string | null, includeBodies = false) {
    const matter = required(await this.store.matters.get(id), "Matter");
    // The contract tracks explicit attachments in matter.*Ids and also permits back-links.
    const [attachedEmails, linkedEmails, attachedEvents, linkedEvents, people] = await Promise.all([
      Promise.all(matter.emailIds.map((id) => this.store.emails.get(id))),
      this.store.emails.query({
        matterId: id,
        limit: 100,
        includeBodies: false,
        includeDeleted: true,
      }),
      Promise.all(matter.eventIds.map((id) => this.store.events.get(id))),
      this.store.events.query({ matterId: id, limit: 100 }),
      Promise.all(matter.personIds.map((id) => this.store.people.get(id))),
    ]);
    const emails = [
      ...new Map(
        [...attachedEmails.filter((email) => email !== null), ...linkedEmails.items].map(
          (email) => [email.id, email],
        ),
      ).values(),
    ].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || a.id.localeCompare(b.id));
    let offset = 0;
    if (cursor != null) {
      offset = emails.findIndex((email) => email.id === cursor) + 1;
      if (offset === 0) {
        throw new MailboxMcpError(
          "INVALID_CURSOR",
          "Matter cursor must be an email ID from this matter.",
        );
      }
    }
    const page = emails.slice(offset, offset + limit);
    const withBodies = includeBodies
      ? (
          await Promise.all(
            page.map((email) => this.store.emails.get(email.id, { includeBodies: true })),
          )
        ).filter((email) => email !== null)
      : page;
    return {
      matter,
      emails: withBodies,
      nextCursor: offset + limit < emails.length ? (page.at(-1)?.id ?? null) : null,
      // Linked queries may have further pages; report their cursor explicitly, never silently omit it.
      linkedEmailsNextCursor: linkedEmails.nextCursor ?? null,
      events: [
        ...new Map(
          [...attachedEvents.filter((event) => event !== null), ...linkedEvents].map((event) => [
            event.id,
            event,
          ]),
        ).values(),
      ],
      people: people.filter((person) => person !== null),
    };
  }
}
