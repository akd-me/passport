import type {
  Account,
  ActionExecutor,
  ActionRecord,
  ActionRequest,
  Calendar,
  CalendarEvent,
  DomainEvent,
  Email,
  EmailQuery,
  EventBus,
  GlobalPolicyConfig,
  Mailbox,
  Matter,
  Page,
  Person,
  PolicyEngine,
  PolicyOutcome,
  Store,
  SyncState,
  Thread,
  TrustState,
} from "@passport/types";
import { BASE_REVERSIBILITY, BASE_RISK, DEFAULT_POLICY_CONFIG } from "@passport/types";

const clone = <T>(value: T): T => structuredClone(value);
const error = (message: string) => Object.assign(new Error(message), { code: "FAKE_UNSUPPORTED" });
function page<T>(items: T[], limit = 25, cursor?: string | null): Page<T> {
  const offset = cursor ? Number(cursor.replace("offset:", "")) : 0;
  return {
    items: clone(items.slice(offset, offset + limit)),
    total: items.length,
    nextCursor: offset + limit < items.length ? `offset:${offset + limit}` : null,
  };
}
const upsert = <T extends { id: string }>(map: Map<string, T>, items: T[]) => {
  for (const item of items) map.set(item.id, clone(item));
};

/** Full contract fake. Text matching is intentionally simple; FTS parsing belongs to the store. */
export class MemoryStore implements Store {
  data = {
    accounts: new Map<string, Account>(),
    mailboxes: new Map<string, Mailbox>(),
    emails: new Map<string, Email>(),
    threads: new Map<string, Thread>(),
    calendars: new Map<string, Calendar>(),
    events: new Map<string, CalendarEvent>(),
    people: new Map<string, Person>(),
    matters: new Map<string, Matter>(),
    actions: new Map<string, ActionRecord>(),
    trust: new Map<string, TrustState>(),
    sync: new Map<string, SyncState>(),
    kv: new Map<string, string>(),
  };
  credentialReads = 0;
  emailQueries: EmailQuery[] = [];
  config: GlobalPolicyConfig | null = null;
  async migrate() {}
  async close() {}
  accounts: Store["accounts"] = {
    list: async () => clone([...this.data.accounts.values()]),
    get: async (id) => clone(this.data.accounts.get(id) ?? null),
    upsert: async (value) => {
      upsert(this.data.accounts, [value]);
      return clone(value);
    },
    delete: async (id) => {
      this.data.accounts.delete(id);
    },
    setCredentials: async () => {
      throw error("Credential writes are outside MCP tests");
    },
    getCredentials: async () => {
      this.credentialReads++;
      return { token: "fixture-secret-never-expose" };
    },
  };
  syncState: Store["syncState"] = {
    get: async (id) => clone(this.data.sync.get(id) ?? null),
    set: async (state) => {
      this.data.sync.set(state.accountId, clone(state));
    },
  };
  mailboxes: Store["mailboxes"] = {
    list: async (accountId) =>
      clone([...this.data.mailboxes.values()].filter((value) => value.accountId === accountId)),
    get: async (id) => clone(this.data.mailboxes.get(id) ?? null),
    upsertMany: async (items) => upsert(this.data.mailboxes, items),
    deleteMany: async (ids) => {
      for (const id of ids) this.data.mailboxes.delete(id);
    },
  };
  emails: Store["emails"] = {
    get: async (id, opts) => this.withBodies(this.data.emails.get(id), opts?.includeBodies),
    getByProviderId: async (accountId, providerId) =>
      clone(
        [...this.data.emails.values()].find(
          (value) => value.accountId === accountId && value.providerId === providerId,
        ) ?? null,
      ),
    query: async (query) => {
      this.emailQueries.push(clone(query));
      let items = [...this.data.emails.values()].filter(
        (value) =>
          (query.includeDeleted || value.keywords.$deleted !== true) &&
          (!query.accountId || value.accountId === query.accountId) &&
          (!query.mailboxId || value.mailboxIds.includes(query.mailboxId)) &&
          (!query.threadId || value.threadId === query.threadId) &&
          (query.matterId === undefined || (value.matterId ?? null) === query.matterId) &&
          (!query.personId || value.personIds.includes(query.personId)) &&
          (!query.category || value.category === query.category) &&
          (!query.after || value.receivedAt > query.after) &&
          (!query.before || value.receivedAt < query.before) &&
          (!query.text ||
            `${value.subject} ${value.textBody ?? ""} ${value.from.map((address) => address.email).join(" ")}`
              .toLowerCase()
              .includes(query.text.toLowerCase())) &&
          (query.keywords?.has ?? []).every((keyword) => value.keywords[keyword]) &&
          (query.keywords?.not ?? []).every((keyword) => !value.keywords[keyword]),
      );
      items = items.sort((a, b) =>
        query.sort === "receivedAt_asc"
          ? a.receivedAt.localeCompare(b.receivedAt)
          : b.receivedAt.localeCompare(a.receivedAt),
      );
      return page(
        items.map((item) => this.withBodies(item, query.includeBodies)!),
        query.limit,
        query.cursor,
      );
    },
    upsertMany: async (items) => upsert(this.data.emails, items),
    patchMany: async (ids, patch) => {
      for (const id of ids) {
        const value = this.data.emails.get(id);
        if (value) this.data.emails.set(id, { ...value, ...clone(patch) });
      }
    },
    deleteMany: async (ids) => {
      for (const id of ids) this.data.emails.delete(id);
    },
  };
  private withBodies(value?: Email, includeBodies = false): Email | null {
    if (!value) return null;
    const copy = clone(value);
    if (!includeBodies) {
      delete copy.textBody;
      delete copy.htmlBody;
    }
    return copy;
  }
  threads: Store["threads"] = {
    get: async (id) => clone(this.data.threads.get(id) ?? null),
    upsertMany: async (items) => upsert(this.data.threads, items),
  };
  calendars: Store["calendars"] = {
    list: async (accountId) =>
      clone([...this.data.calendars.values()].filter((value) => value.accountId === accountId)),
    upsertMany: async (items) => upsert(this.data.calendars, items),
  };
  events: Store["events"] = {
    get: async (id) => clone(this.data.events.get(id) ?? null),
    query: async (query) =>
      clone(
        [...this.data.events.values()]
          .filter(
            (value) =>
              (!query.accountId || value.accountId === query.accountId) &&
              (!query.matterId || value.matterId === query.matterId) &&
              (!query.range ||
                (value.start < query.range.end && value.end > query.range.start) ||
                (query.includeRecurring &&
                  (Boolean(value.recurringEventId) ||
                    (Boolean(value.recurrenceRule) && value.start < query.range.end)))),
          )
          .slice(0, query.limit),
      ),
    upsertMany: async (items) => upsert(this.data.events, items),
    deleteMany: async (ids) => {
      for (const id of ids) this.data.events.delete(id);
    },
  };
  people: Store["people"] = {
    get: async (id) => clone(this.data.people.get(id) ?? null),
    getByEmail: async (email) =>
      clone(
        [...this.data.people.values()].find((value) =>
          value.emails.some((address) => address.toLowerCase() === email.toLowerCase()),
        ) ?? null,
      ),
    list: async (query) =>
      clone(
        [...this.data.people.values()]
          .filter(
            (value) =>
              (!query?.relationship || value.relationship === query.relationship) &&
              (!query?.text ||
                `${value.displayName} ${value.emails.join(" ")}`
                  .toLowerCase()
                  .includes(query.text.toLowerCase())),
          )
          .slice(0, query?.limit),
      ),
    upsert: async (value) => {
      upsert(this.data.people, [value]);
      return clone(value);
    },
    merge: async () => {
      throw error("Merge is not exposed by MCP");
    },
  };
  matters: Store["matters"] = {
    get: async (id) => clone(this.data.matters.get(id) ?? null),
    list: async (query) =>
      clone(
        [...this.data.matters.values()]
          .filter(
            (value) =>
              (!query?.status || query.status.includes(value.status)) &&
              (!query?.personId || value.personIds.includes(query.personId)) &&
              (!query?.text ||
                `${value.title} ${value.summary}`.toLowerCase().includes(query.text.toLowerCase())),
          )
          .slice(0, query?.limit),
      ),
    upsert: async (value) => {
      upsert(this.data.matters, [value]);
      return clone(value);
    },
    delete: async (id) => {
      this.data.matters.delete(id);
    },
  };
  actions: Store["actions"] = {
    get: async (id) => clone(this.data.actions.get(id) ?? null),
    query: async (query) =>
      page(
        [...this.data.actions.values()].filter(
          (value) =>
            (!query.status || query.status.includes(value.status)) &&
            (!query.category || value.request.category === query.category) &&
            (!query.actorKind || value.request.actor.kind === query.actorKind) &&
            (!query.runId || value.request.runId === query.runId) &&
            (!query.matterId || value.request.matterId === query.matterId) &&
            (!query.after || value.createdAt > query.after) &&
            (!query.before || value.createdAt < query.before),
        ),
        query.limit,
        query.cursor,
      ),
    insert: async (value) => {
      upsert(this.data.actions, [value]);
      return clone(value);
    },
    update: async (id, patch) => {
      const value = this.data.actions.get(id);
      if (!value) throw error("Action not found");
      const updated = { ...value, ...clone(patch) };
      this.data.actions.set(id, updated);
      return clone(updated);
    },
    dueHeld: async (now) =>
      clone(
        [...this.data.actions.values()].filter(
          (value) => value.status === "held" && value.holdUntil && value.holdUntil <= now,
        ),
      ),
  };
  trust: Store["trust"] = {
    list: async () => clone([...this.data.trust.values()]),
    get: async (category) => clone(this.data.trust.get(category) ?? null),
    upsert: async (value) => {
      this.data.trust.set(value.category, clone(value));
      return clone(value);
    },
    getConfig: async () => clone(this.config),
    setConfig: async (value) => {
      this.config = clone(value);
    },
  };
  kv: Store["kv"] = {
    get: async (key) => this.data.kv.get(key) ?? null,
    set: async (key, value) => {
      this.data.kv.set(key, value);
    },
    delete: async (key) => {
      this.data.kv.delete(key);
    },
  };
}

export class MemoryPolicy implements PolicyEngine {
  outcome: PolicyOutcome = "ask";
  config = clone(DEFAULT_POLICY_CONFIG);
  async evaluate(request: ActionRequest) {
    return {
      outcome: this.outcome,
      risk: BASE_RISK[request.type],
      reversibility: BASE_REVERSIBILITY[request.type],
      trustLevel: this.outcome === "ask" ? ("supervised" as const) : ("auto_accept_edits" as const),
      category: request.category,
      reason:
        this.outcome === "deny"
          ? "External agent denied by policy"
          : `Fake policy: ${this.outcome}`,
      ...(this.outcome === "hold" ? { holdUntil: "2099-10-20T12:05:00.000Z" } : {}),
    };
  }
  async getTrust(): Promise<TrustState[]> {
    return [await this.getTrustFor("triage")];
  }
  async getTrustFor(category: TrustState["category"]): Promise<TrustState> {
    return {
      category,
      level: "supervised",
      score: 0,
      stage: "learning",
      approvals: 0,
      approvalsUnchanged: 0,
      edits: 0,
      rejections: 0,
      lastActivityAt: null,
    };
  }
  async getConfig() {
    return clone(this.config);
  }
  async setConfig(patch: Partial<GlobalPolicyConfig>) {
    this.config = { ...this.config, ...patch };
    return clone(this.config);
  }
  async pinLevel(): Promise<TrustState> {
    throw error("MCP cannot change trust");
  }
  async recordOutcome(): Promise<TrustState> {
    throw error("MCP cannot record human approval");
  }
  async applyDecay() {
    return this.getTrust();
  }
}

/** Configurable policy outcomes and persisted audit records; deliberately no provider effects. */
export class MemoryExecutor implements ActionExecutor {
  submitted: ActionRequest[] = [];
  cancelled: string[] = [];
  constructor(
    readonly store: MemoryStore,
    readonly policy: MemoryPolicy,
  ) {}
  async submit(request: ActionRequest): Promise<ActionRecord> {
    this.submitted.push(clone(request));
    const decision = await this.policy.evaluate(request);
    return this.store.actions.insert({
      id: `action-${this.submitted.length}`,
      request: clone(request),
      decision,
      status:
        decision.outcome === "ask"
          ? "proposed"
          : decision.outcome === "hold"
            ? "held"
            : decision.outcome === "deny"
              ? "rejected"
              : "executed",
      holdUntil: decision.holdUntil ?? null,
      createdAt: new Date().toISOString(),
    });
  }
  async cancelHold(actionId: string) {
    this.cancelled.push(actionId);
    return this.store.actions.update(actionId, { status: "rejected", holdUntil: null });
  }
  async approve(): Promise<ActionRecord> {
    throw error("MCP cannot approve");
  }
  async reject(): Promise<ActionRecord> {
    throw error("MCP cannot reject human decisions");
  }
  async undo(
    actionId: string,
    context?: Parameters<ActionExecutor["undo"]>[1],
  ): Promise<ActionRecord> {
    const original = await this.store.actions.get(actionId);
    if (!original?.inverse) throw error("Missing inverse");
    return this.submit({
      ...original.inverse,
      category: original.request.category,
      actor: context?.actor ?? { kind: "human", id: "undo" },
      reason: `Undo ${actionId}: ${context?.reason}`,
      runId: "run-1",
    });
  }
  async releaseDue(): Promise<ActionRecord[]> {
    throw error("The host scheduler owns outbox release");
  }
}

export class MemoryBus implements EventBus {
  private handlers = new Set<(event: DomainEvent) => void>();
  get listenerCount() {
    return this.handlers.size;
  }
  emit(event: DomainEvent) {
    for (const handler of this.handlers) handler(clone(event));
  }
  on<T extends DomainEvent["type"]>(
    type: T,
    handler: (event: Extract<DomainEvent, { type: T }>) => void,
  ) {
    return this.onAny((event) => {
      if (event.type === type) handler(event as Extract<DomainEvent, { type: T }>);
    });
  }
  onAny(handler: (event: DomainEvent) => void) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}
