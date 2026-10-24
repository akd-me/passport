import type {
  ActionParams,
  ActionRequest,
  ActionType,
  Email,
  MailReader,
  MailReaderResolver,
  Store,
} from "@passport/types";
import { categorize } from "./categorize.js";
import { destinationGuard } from "./destination.js";
import { required, ToolError } from "./presentation.js";

import type { Tool, ToolContext, ToolRegistryOptions } from "./types.js";

export class Context {
  readonly store: Store;
  readonly tools: Tool[] = [];
  readonly now: () => string;
  constructor(
    readonly deps: ToolRegistryOptions,
    readonly callContext: ToolContext = {},
  ) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date().toISOString());
  }
  forCall(ctx?: ToolContext) {
    return ctx ? new Context(this.deps, ctx) : this;
  }

  actor() {
    return this.deps.actor;
  }
  auditReason(reason: string) {
    const label = this.deps.actorAuditLabel?.();
    return label ? `${reason} [MCP client: ${JSON.stringify(label.slice(0, 200))}]` : reason;
  }

  async account(accountId?: string) {
    if (accountId) {
      return required(await this.store.accounts.get(accountId), "Account");
    }
    const accounts = await this.store.accounts.list();
    if (accounts.length !== 1) {
      throw new ToolError(
        "ACCOUNT_REQUIRED",
        "Provide accountId when there is not exactly one account.",
      );
    }
    return required(accounts[0], "Account");
  }

  /** On-demand readers for this call: the trusted call context first, then the registry's. */
  get readers(): MailReaderResolver | undefined {
    return this.callContext.readers ?? this.deps.readers;
  }

  /** On-demand reader for an account, or null when no resolver is configured or it has none. */
  async maybeReader(accountId: string): Promise<MailReader | null> {
    return this.readers ? await this.readers(accountId) : null;
  }

  /** On-demand reader for an account; throws `ON_DEMAND_UNSUPPORTED` when there is none. */
  async reader(accountId: string): Promise<MailReader> {
    const reader = await this.maybeReader(accountId);
    if (!reader) {
      throw new ToolError(
        "ON_DEMAND_UNSUPPORTED",
        "On-demand mail reads are not available for this account: the host configured no provider reader. search_emails and get_email still read the local cache.",
      );
    }
    return reader;
  }

  async email(id: string, includeBodies = false) {
    return required(await this.store.emails.get(id, { includeBodies }), "Email");
  }

  async emailBatch(ids: string[], accountId?: string) {
    const emails = await Promise.all([...new Set(ids)].map((id) => this.email(id)));
    const inferredId = accountId ?? required(emails[0], "Email").accountId;
    if (emails.some((email) => email.accountId !== inferredId)) {
      throw new ToolError(
        "ACCOUNT_MISMATCH",
        "Split mail operations into separate calls per account.",
      );
    }
    await this.account(inferredId);
    return { accountId: inferredId, emails };
  }

  async submit<T extends ActionType>(
    type: T,
    accountId: string,
    params: ActionParams[T],
    reason: string,
    context: {
      emails?: Email[];
      recipientEmails?: string[];
      personIds?: string[];
      matterId?: string;
      sensitiveCategory?: "money" | "legal";
    } = {},
  ) {
    const accounts = await this.store.accounts.list();
    const addresses = [
      ...new Set(
        [
          ...(context.recipientEmails ?? []),
          ...(context.emails ?? []).flatMap((email) => email.from.map((address) => address.email)),
        ].map((email) => email.trim().toLowerCase()),
      ),
    ];
    const people = (
      await Promise.all([
        ...addresses.map((email) => this.store.people.getByEmail(email)),
        ...(context.personIds ?? []).map((id) => this.store.people.get(id)),
      ])
    ).filter((person) => person !== null);
    const trusted = this.actor().kind === "agent" ? this.callContext : {};
    people.unshift(...(trusted.projectedPeople ?? []));
    const inference = categorize({
      type,
      emails: context.emails,
      people,
      recipientEmails: context.recipientEmails,
      matterId: context.matterId,
      selfEmails: [...accounts.map((account) => account.emailAddress), ...this.deps.selfAddresses],
    });
    if (
      context.sensitiveCategory === "legal" ||
      (context.sensitiveCategory === "money" && inference.category !== "legal")
    ) {
      inference.category = context.sensitiveCategory;
    }
    if (
      trusted.classification &&
      !["money", "legal", "matters", "unsubscribe", "scheduling", "profile_update"].includes(
        inference.category,
      )
    ) {
      inference.category = trusted.classification;
    }
    const destructive = await destinationGuard(
      this.store,
      type,
      accountId,
      params,
      context.emails ?? [],
    );
    if (destructive && !["money", "legal"].includes(inference.category)) {
      inference.category = "other";
    }
    const request: ActionRequest<T> = {
      type,
      accountId,
      params,
      reason: this.auditReason(reason),
      actor: this.actor(),
      ...inference,
      ...(destructive ? { destructive: true } : {}),
      ...(this.callContext.runId ? { runId: this.callContext.runId } : {}),
      ...((context.matterId ?? trusted.matterId)
        ? { matterId: context.matterId ?? trusted.matterId }
        : {}),
    };
    return this.deps.executor.submit(request);
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
        throw new ToolError(
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
      // Linked queries may have further pages; report their cursor explicitly; continue search with includeDeleted:true for history.
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
