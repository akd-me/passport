/**
 * @passport/types — the shared contract for every package in the monorepo.
 *
 * Rules:
 *  - This package has NO runtime dependencies. Types, enums-as-unions, and tiny pure helpers only.
 *  - Every other package imports from here and never from each other's internals.
 *  - The data model is JMAP-shaped (RFC 8620 / 8621 / JMAP Calendars) so that any provider
 *    (Gmail API, Microsoft Graph, IMAP, JMAP, CalDAV) normalizes into the same records.
 *  - Changing a type here is a cross-package change. Add, don't rename, during parallel work.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Opaque identifier, always a string (ULID preferred; providers' ids live in `providerId`). */
export type Id = string;
/** ISO-8601 timestamp, always UTC with trailing Z. */
export type Timestamp = string;

export interface EmailAddress {
  name?: string;
  email: string;
}

// ---------------------------------------------------------------------------
// Accounts & providers
// ---------------------------------------------------------------------------

export type MailProviderKind = "gmail" | "graph" | "imap" | "jmap" | "mock";
export type CalendarProviderKind = "google-calendar" | "graph-calendar" | "caldav" | "jmap-calendar" | "mock";
export type ProviderKind = MailProviderKind | CalendarProviderKind;

export interface AccountCapabilities {
  mail: boolean;
  calendar: boolean;
  contacts: boolean;
  /** Provider supports push / long-poll change notification. */
  push: boolean;
  /** Provider supports server-side labels (Gmail) vs. folders (IMAP). */
  labels: boolean;
  /** Can the provider itself submit mail, or do we need a separate SMTP transport? */
  submit: boolean;
}

/**
 * Credentials are stored by the Store encrypted at rest. Shape is provider-specific
 * (OAuth refresh token, IMAP app password, JMAP bearer token). Never log this object.
 */
export type AccountCredentials = Record<string, string>;

export interface Account {
  id: Id;
  kind: ProviderKind;
  displayName: string;
  /** Primary address for mail accounts; owner address for calendar accounts. */
  emailAddress: string;
  capabilities: AccountCapabilities;
  /** Provider-specific, non-secret settings (host, port, tls, clientId, calendarIds…). */
  settings: Record<string, string | number | boolean>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** Last successful sync, if any. */
  lastSyncAt?: Timestamp | null;
  lastSyncError?: string | null;
}

// ---------------------------------------------------------------------------
// Mail (JMAP-shaped)
// ---------------------------------------------------------------------------

export type MailboxRole =
  | "inbox"
  | "archive"
  | "drafts"
  | "sent"
  | "trash"
  | "junk"
  | "important"
  | "all"
  | null;

export interface Mailbox {
  id: Id;
  accountId: Id;
  providerId: string;
  name: string;
  role: MailboxRole;
  parentId?: Id | null;
  totalEmails: number;
  unreadEmails: number;
}

/** JMAP keywords. Standard ones are listed; providers may add their own (e.g. gmail labels as `label:Foo`). */
export type Keyword = "$seen" | "$flagged" | "$draft" | "$answered" | "$forwarded" | "$junk" | "$notjunk" | (string & {});

export interface Attachment {
  id: Id;
  name: string;
  type: string;
  size: number;
  /** Opaque handle for MailProvider.getBlob. */
  blobId: string;
  disposition?: "attachment" | "inline";
  cid?: string | null;
}

export interface EmailHeaders {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  listId?: string | null;
  listUnsubscribe?: string | null;
  listUnsubscribePost?: string | null;
  /** Raw Authentication-Results header(s) if present. */
  authenticationResults?: string[];
  /** Any additional headers the provider exposed, lower-cased names. */
  extra?: Record<string, string>;
}

export type AuthResult = "pass" | "fail" | "none" | "unknown";

/**
 * Verification is computed by the client from cryptographic checks, never from message content.
 * `passport` is the blue/green state: blue = signed by a Passport identity we can verify,
 * green = legacy email, downgraded = this sender was blue before and is not now (possible impersonation).
 */
export interface VerificationState {
  dkim: AuthResult;
  spf: AuthResult;
  dmarc: AuthResult;
  passport: "blue" | "green" | "downgraded";
  /** Signing identity (Passport address or DKIM d=) when known. */
  signer?: string | null;
  /** The signed actor claim, when the message carries one (SMTP+). */
  actor?: ActorKind | null;
}

export interface Email {
  id: Id;
  accountId: Id;
  providerId: string;
  threadId: Id;
  mailboxIds: Id[];
  keywords: Partial<Record<Keyword, boolean>>;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  subject: string;
  sentAt: Timestamp | null;
  receivedAt: Timestamp;
  preview: string;
  /** Bodies are optional in list results; fetched on demand via Store/Provider. */
  textBody?: string | null;
  htmlBody?: string | null;
  attachments: Attachment[];
  headers: EmailHeaders;
  size: number;
  verification: VerificationState;
  /** Set by the matter engine. */
  matterId?: Id | null;
  /** Set by the people graph; resolved from from/to/cc. */
  personIds: Id[];
  /** Agent classification, set by triage. */
  category?: ActionCategory | null;
}

export interface Thread {
  id: Id;
  accountId: Id;
  emailIds: Id[];
}

/** A draft the agent or human is composing. Maps to a `$draft` Email once saved to the provider. */
export interface DraftInput {
  accountId: Id;
  /** If replying, the Email this is in reply to (sets In-Reply-To/References and threadId). */
  inReplyToEmailId?: Id | null;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  textBody: string;
  htmlBody?: string | null;
  attachments?: Array<{ name: string; type: string; blobId: string }>;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export type ParticipationStatus = "needs-action" | "accepted" | "declined" | "tentative";

export interface Participant {
  email: string;
  name?: string;
  status: ParticipationStatus;
  role?: "organizer" | "attendee" | "optional";
}

export interface Calendar {
  id: Id;
  accountId: Id;
  providerId: string;
  name: string;
  isPrimary: boolean;
  timeZone?: string | null;
}

export interface CalendarEvent {
  id: Id;
  accountId: Id;
  calendarId: Id;
  providerId: string;
  title: string;
  description?: string | null;
  location?: string | null;
  start: Timestamp;
  end: Timestamp;
  timeZone?: string | null;
  allDay: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  organizer?: EmailAddress | null;
  participants: Participant[];
  /** Our own participation status, if we're invited. */
  myStatus?: ParticipationStatus | null;
  /** Link back to the invite email, if we learned about this via mail. */
  sourceEmailId?: Id | null;
  matterId?: Id | null;
  recurrenceRule?: string | null;
  updatedAt: Timestamp;
}

export interface TimeRange {
  start: Timestamp;
  end: Timestamp;
}

// ---------------------------------------------------------------------------
// People & matters — the two new units
// ---------------------------------------------------------------------------

/** How we know this person. Drives counterparty risk in policy. */
export type Relationship = "self" | "known" | "stranger" | "service";

export interface Person {
  id: Id;
  displayName: string;
  emails: string[];
  primaryEmail: string;
  avatarUrl?: string | null;
  verification: "blue" | "green" | "unknown";
  /** If they were ever blue, when we last saw a blue message. Used to flag downgrades. */
  lastSeenBlueAt?: Timestamp | null;
  relationship: Relationship;
  /** Free-form notes the user or agent keeps ("my accountant", "recruiter at Acme"). */
  notes?: string | null;
  stats: {
    sent: number;
    received: number;
    lastContactAt: Timestamp | null;
  };
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type MatterStatus = "active" | "waiting" | "snoozed" | "done";

export interface Matter {
  id: Id;
  title: string;
  /** Agent-maintained one-paragraph summary of where things stand. */
  summary: string;
  status: MatterStatus;
  /** Loose type: "trip", "hiring", "purchase", "project", "subscription", "personal"... */
  kind?: string | null;
  personIds: Id[];
  emailIds: Id[];
  eventIds: Id[];
  /** What the agent thinks should happen next, if anything. */
  nextStep?: string | null;
  dueAt?: Timestamp | null;
  snoozedUntil?: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Actions — everything that changes state goes through one of these
// ---------------------------------------------------------------------------

export type ActorKind = "human" | "agent" | "external-agent";

export interface Actor {
  kind: ActorKind;
  /** "user", an agent run id, or an MCP client name. */
  id: string;
}

/**
 * Trust is earned per category. Categories are the rows of the trust ladder.
 * Keep this list short; it is user-visible.
 */
export type ActionCategory =
  | "triage" // label / archive / mark read of non-human mail
  | "newsletters"
  | "receipts"
  | "notifications"
  | "scheduling"
  | "replies_known" // replying to a known person
  | "replies_stranger"
  | "money"
  | "legal"
  | "unsubscribe"
  | "matters" // creating/editing matters and people (internal, always reversible)
  | "other";

export type ActionType =
  | "label"
  | "unlabel"
  | "archive"
  | "unarchive"
  | "mark_read"
  | "mark_unread"
  | "flag"
  | "unflag"
  | "move"
  | "delete"
  | "draft_create"
  | "draft_update"
  | "draft_delete"
  | "send" // send a new message or an existing draft
  | "unsubscribe"
  | "calendar_propose" // send a proposal (reversible: it's a draft/send of an invite)
  | "calendar_create"
  | "calendar_update"
  | "calendar_respond" // accept/decline/tentative
  | "calendar_delete"
  | "matter_create"
  | "matter_update"
  | "matter_attach"
  | "person_update"
  | "snooze";

export type CounterpartyClass = "self" | "blue" | "green_known" | "stranger" | "service";

export interface Counterparty {
  personId?: Id | null;
  emails: string[];
  class: CounterpartyClass;
}

/** Parameters per ActionType. Keep params JSON-serializable. */
export interface ActionParams {
  label: { emailIds: Id[]; label: string };
  unlabel: { emailIds: Id[]; label: string };
  archive: { emailIds: Id[] };
  unarchive: { emailIds: Id[]; toMailboxId?: Id };
  mark_read: { emailIds: Id[] };
  mark_unread: { emailIds: Id[] };
  flag: { emailIds: Id[] };
  unflag: { emailIds: Id[] };
  move: { emailIds: Id[]; toMailboxId: Id };
  delete: { emailIds: Id[] };
  draft_create: { draft: DraftInput };
  draft_update: { draftEmailId: Id; draft: DraftInput };
  draft_delete: { draftEmailId: Id };
  send: { draftEmailId?: Id; draft?: DraftInput };
  unsubscribe: { emailId: Id; method: "header" | "link" | "reply" };
  calendar_propose: { draft: DraftInput; slots: TimeRange[] };
  calendar_create: { event: Omit<CalendarEvent, "id" | "providerId" | "updatedAt"> };
  calendar_update: { eventId: Id; patch: Partial<CalendarEvent> };
  calendar_respond: { eventId: Id; status: ParticipationStatus; comment?: string };
  calendar_delete: { eventId: Id };
  matter_create: { matter: Omit<Matter, "id" | "createdAt" | "updatedAt"> };
  matter_update: { matterId: Id; patch: Partial<Matter> };
  matter_attach: { matterId: Id; emailIds?: Id[]; eventIds?: Id[]; personIds?: Id[] };
  person_update: { personId: Id; patch: Partial<Person> };
  snooze: { emailIds?: Id[]; matterId?: Id; until: Timestamp };
}

export interface ActionRequest<T extends ActionType = ActionType> {
  type: T;
  accountId: Id;
  params: ActionParams[T];
  /** One line, human readable, shown in the decisions feed and the action log. */
  reason: string;
  actor: Actor;
  category: ActionCategory;
  counterparty?: Counterparty | null;
  matterId?: Id | null;
  /** Correlates all actions proposed in one agent run. */
  runId?: Id | null;
}

export type ActionStatus =
  | "proposed" // waiting for a human decision
  | "approved"
  | "rejected"
  | "held" // in the delayed outbox, can still be cancelled
  | "executing"
  | "executed"
  | "undone"
  | "failed"
  | "expired";

export interface ActionRecord {
  id: Id;
  request: ActionRequest;
  decision: PolicyDecision;
  status: ActionStatus;
  createdAt: Timestamp;
  decidedAt?: Timestamp | null;
  /** For `held`: when the outbox will release it. */
  holdUntil?: Timestamp | null;
  executedAt?: Timestamp | null;
  undoneAt?: Timestamp | null;
  /** The inverse action, computed at execution time. Null = irreversible. */
  inverse?: ActionRequest | null;
  /** Provider result, e.g. the sent message id. */
  result?: Record<string, unknown> | null;
  /** If a human edited a draft before approving, normalized edit distance 0..1. */
  editDistance?: number | null;
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Policy & trust
// ---------------------------------------------------------------------------

/**
 * Mirrors the four modes in the UI picker:
 *  supervised          — suggest only; every action needs approval
 *  auto_accept_edits   — reversible actions run; anything outward-facing asks
 *  auto                — runs where trust is earned; novel or irreversible asks
 *  full_access         — runs everything except the fixed always-ask set
 */
export type TrustLevel = "supervised" | "auto_accept_edits" | "auto" | "full_access";

export const TRUST_LEVELS: readonly TrustLevel[] = ["supervised", "auto_accept_edits", "auto", "full_access"];

/** User-visible learning state derived from TrustState. */
export type TrustStage = "learning" | "trusted" | "autonomous";

export type RiskLevel = "low" | "medium" | "high" | "critical";

/**
 * reversible   — inverse exists and is cheap (label, archive, draft)
 * delayed      — irreversible once released, but we hold it in the outbox first (send)
 * irreversible — no inverse (delete from trash, unsubscribe via link, calendar respond to externals)
 */
export type Reversibility = "reversible" | "delayed" | "irreversible";

export interface TrustState {
  category: ActionCategory;
  level: TrustLevel;
  /** 0..1 earned score. Approvals without edits raise it, edits/rejections lower it, inactivity decays it. */
  score: number;
  stage: TrustStage;
  approvals: number;
  approvalsUnchanged: number;
  edits: number;
  rejections: number;
  lastActivityAt: Timestamp | null;
  /** Set when the user explicitly pinned a level for this category (overrides earned level). */
  pinnedLevel?: TrustLevel | null;
}

export type PolicyOutcome =
  | "allow" // execute now
  | "hold" // execute after holdUntil unless cancelled (delayed outbox)
  | "ask" // queue as a decision for the human
  | "deny"; // never (e.g. external agent trying to delete)

export interface PolicyDecision {
  outcome: PolicyOutcome;
  risk: RiskLevel;
  reversibility: Reversibility;
  /** Effective trust level that was applied to this request. */
  trustLevel: TrustLevel;
  category: ActionCategory;
  /** Human-readable justification; shown next to the action. */
  reason: string;
  holdUntil?: Timestamp | null;
  /** Set when the engine detects a "ready to promote" moment, e.g. 11 of 12 unchanged. */
  promotionOffer?: PromotionOffer | null;
}

export interface PromotionOffer {
  category: ActionCategory;
  from: TrustLevel;
  to: TrustLevel;
  message: string;
  evidence: { approvalsUnchanged: number; approvals: number; window: string };
}

export interface GlobalPolicyConfig {
  /** The dial in the UI. Per-category levels can't exceed it. */
  globalMode: TrustLevel;
  /** Minutes a `send` is held in the outbox. 0 disables the hold (not recommended). */
  outboxHoldMinutes: number;
  /** Days of inactivity after which a category's score begins to decay. */
  decayAfterDays: number;
  /** Fixed always-ask set: categories that never auto-execute regardless of trust. */
  alwaysAsk: ActionCategory[];
  /** What external agents (via MCP, or other people's agents) may do at most. */
  externalAgentCeiling: TrustLevel;
}

export type OutcomeFeedback = "approved_unchanged" | "approved_edited" | "rejected";

export interface PolicyEngine {
  evaluate(request: ActionRequest): Promise<PolicyDecision>;
  /** Called when a human decides a proposed action. Updates trust for the category. */
  recordOutcome(actionId: Id, feedback: OutcomeFeedback, editDistance?: number): Promise<TrustState>;
  getTrust(): Promise<TrustState[]>;
  getTrustFor(category: ActionCategory): Promise<TrustState>;
  pinLevel(category: ActionCategory, level: TrustLevel | null): Promise<TrustState>;
  getConfig(): Promise<GlobalPolicyConfig>;
  setConfig(patch: Partial<GlobalPolicyConfig>): Promise<GlobalPolicyConfig>;
  /** Apply time-based decay. Idempotent; call from a scheduler. */
  applyDecay(now?: Timestamp): Promise<TrustState[]>;
}

// ---------------------------------------------------------------------------
// Store — the single persistence interface (SQLite in the reference impl)
// ---------------------------------------------------------------------------

export interface Page<T> {
  items: T[];
  nextCursor?: string | null;
  total?: number;
}

export interface EmailQuery {
  accountId?: Id;
  mailboxId?: Id;
  threadId?: Id;
  matterId?: Id | null;
  personId?: Id;
  /** Full-text query over subject/from/body (FTS5 syntax). */
  text?: string;
  keywords?: { has?: Keyword[]; not?: Keyword[] };
  category?: ActionCategory;
  after?: Timestamp;
  before?: Timestamp;
  limit?: number;
  cursor?: string | null;
  /** Default: receivedAt desc. */
  sort?: "receivedAt_desc" | "receivedAt_asc";
  includeBodies?: boolean;
}

export interface ActionQuery {
  status?: ActionStatus[];
  category?: ActionCategory;
  actorKind?: ActorKind;
  runId?: Id;
  matterId?: Id;
  after?: Timestamp;
  before?: Timestamp;
  limit?: number;
  cursor?: string | null;
}

export interface SyncState {
  accountId: Id;
  /** Opaque provider cursor (Gmail historyId, Graph deltaLink, IMAP uidvalidity/uidnext, JMAP state). */
  cursor: string | null;
  updatedAt: Timestamp;
}

export interface Store {
  // lifecycle
  migrate(): Promise<void>;
  close(): Promise<void>;

  accounts: {
    list(): Promise<Account[]>;
    get(id: Id): Promise<Account | null>;
    upsert(account: Account): Promise<Account>;
    delete(id: Id): Promise<void>;
    /** Credentials are encrypted with the store's master key. */
    setCredentials(accountId: Id, creds: AccountCredentials): Promise<void>;
    getCredentials(accountId: Id): Promise<AccountCredentials | null>;
  };

  syncState: {
    get(accountId: Id): Promise<SyncState | null>;
    set(state: SyncState): Promise<void>;
  };

  mailboxes: {
    list(accountId: Id): Promise<Mailbox[]>;
    get(id: Id): Promise<Mailbox | null>;
    upsertMany(mailboxes: Mailbox[]): Promise<void>;
    deleteMany(ids: Id[]): Promise<void>;
  };

  emails: {
    get(id: Id, opts?: { includeBodies?: boolean }): Promise<Email | null>;
    getByProviderId(accountId: Id, providerId: string): Promise<Email | null>;
    query(q: EmailQuery): Promise<Page<Email>>;
    upsertMany(emails: Email[]): Promise<void>;
    patchMany(ids: Id[], patch: Partial<Pick<Email, "keywords" | "mailboxIds" | "matterId" | "category" | "personIds">>): Promise<void>;
    deleteMany(ids: Id[]): Promise<void>;
  };

  threads: {
    get(id: Id): Promise<Thread | null>;
    upsertMany(threads: Thread[]): Promise<void>;
  };

  calendars: {
    list(accountId: Id): Promise<Calendar[]>;
    upsertMany(calendars: Calendar[]): Promise<void>;
  };

  events: {
    get(id: Id): Promise<CalendarEvent | null>;
    query(q: { accountId?: Id; range?: TimeRange; matterId?: Id; limit?: number }): Promise<CalendarEvent[]>;
    upsertMany(events: CalendarEvent[]): Promise<void>;
    deleteMany(ids: Id[]): Promise<void>;
  };

  people: {
    get(id: Id): Promise<Person | null>;
    getByEmail(email: string): Promise<Person | null>;
    list(q?: { relationship?: Relationship; text?: string; limit?: number }): Promise<Person[]>;
    upsert(person: Person): Promise<Person>;
    merge(keepId: Id, mergeId: Id): Promise<Person>;
  };

  matters: {
    get(id: Id): Promise<Matter | null>;
    list(q?: { status?: MatterStatus[]; personId?: Id; text?: string; limit?: number }): Promise<Matter[]>;
    upsert(matter: Matter): Promise<Matter>;
    delete(id: Id): Promise<void>;
  };

  actions: {
    get(id: Id): Promise<ActionRecord | null>;
    query(q: ActionQuery): Promise<Page<ActionRecord>>;
    insert(record: ActionRecord): Promise<ActionRecord>;
    update(id: Id, patch: Partial<ActionRecord>): Promise<ActionRecord>;
    /** Held actions whose holdUntil <= now, for the outbox scheduler. */
    dueHeld(now: Timestamp): Promise<ActionRecord[]>;
  };

  trust: {
    list(): Promise<TrustState[]>;
    get(category: ActionCategory): Promise<TrustState | null>;
    upsert(state: TrustState): Promise<TrustState>;
    getConfig(): Promise<GlobalPolicyConfig | null>;
    setConfig(config: GlobalPolicyConfig): Promise<void>;
  };

  /** Arbitrary small KV for things like USER.md content, agent memory, UI state. */
  kv: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
}

// ---------------------------------------------------------------------------
// Providers — adapters normalize into the model above
// ---------------------------------------------------------------------------

export type SyncDelta =
  | { kind: "mailbox"; op: "upsert"; mailbox: Mailbox }
  | { kind: "mailbox"; op: "delete"; id: Id }
  | { kind: "email"; op: "upsert"; email: Email }
  | { kind: "email"; op: "delete"; providerId: string }
  | { kind: "thread"; op: "upsert"; thread: Thread }
  | { kind: "cursor"; cursor: string };

export type MailChange =
  | { op: "setKeywords"; providerIds: string[]; add?: Keyword[]; remove?: Keyword[] }
  | { op: "move"; providerIds: string[]; toMailboxProviderId: string }
  | { op: "addToMailbox"; providerIds: string[]; mailboxProviderId: string }
  | { op: "removeFromMailbox"; providerIds: string[]; mailboxProviderId: string }
  | { op: "delete"; providerIds: string[] };

export interface SendResult {
  providerId: string;
  messageId: string | null;
  threadId?: string | null;
}

export interface MailProvider {
  readonly kind: MailProviderKind;
  readonly capabilities: AccountCapabilities;
  connect(account: Account, credentials: AccountCredentials): Promise<void>;
  disconnect(): Promise<void>;
  /** Incremental sync from a cursor (null = full). Must yield a final `cursor` delta. */
  sync(cursor: string | null, opts?: { maxEmails?: number; since?: Timestamp }): AsyncIterable<SyncDelta>;
  /** Fetch a full email including bodies. */
  getEmail(providerId: string): Promise<Email | null>;
  getBlob(blobId: string): Promise<{ type: string; data: Uint8Array }>;
  applyChanges(changes: MailChange[]): Promise<void>;
  createDraft(draft: DraftInput): Promise<Email>;
  updateDraft(providerId: string, draft: DraftInput): Promise<Email>;
  deleteDraft(providerId: string): Promise<void>;
  /** Send a draft (by providerId) or a fresh DraftInput. */
  send(input: { draftProviderId?: string; draft?: DraftInput }): Promise<SendResult>;
  /** Optional push: resolves when the provider signals changes or the signal aborts. */
  waitForChanges?(signal: AbortSignal): Promise<void>;
}

export interface CalendarProvider {
  readonly kind: CalendarProviderKind;
  connect(account: Account, credentials: AccountCredentials): Promise<void>;
  disconnect(): Promise<void>;
  listCalendars(): Promise<Calendar[]>;
  sync(cursor: string | null, range?: TimeRange): AsyncIterable<
    | { kind: "event"; op: "upsert"; event: CalendarEvent }
    | { kind: "event"; op: "delete"; providerId: string }
    | { kind: "cursor"; cursor: string }
  >;
  createEvent(event: Omit<CalendarEvent, "id" | "providerId" | "updatedAt">): Promise<CalendarEvent>;
  updateEvent(providerId: string, patch: Partial<CalendarEvent>): Promise<CalendarEvent>;
  deleteEvent(providerId: string): Promise<void>;
  respond(providerId: string, status: ParticipationStatus, comment?: string): Promise<void>;
  freeBusy(range: TimeRange): Promise<TimeRange[]>;
}

export interface ProviderRegistry {
  mail(kind: MailProviderKind): MailProvider;
  calendar(kind: CalendarProviderKind): CalendarProvider;
  /** Interactive setup descriptor for the UI/CLI (which fields, OAuth URL builder…). */
  describe(kind: ProviderKind): ProviderSetupDescriptor;
}

export interface ProviderSetupDescriptor {
  kind: ProviderKind;
  label: string;
  /** Fields the user must supply. `secret` fields go to credentials, others to settings. */
  fields: Array<{ id: string; label: string; secret: boolean; required: boolean; placeholder?: string; help?: string }>;
  /** For OAuth providers: how to build the consent URL and exchange the code. */
  oauth?: {
    buildAuthUrl(settings: Record<string, string>, redirectUri: string, state: string): string;
    exchangeCode(settings: Record<string, string>, redirectUri: string, code: string): Promise<AccountCredentials>;
    scopes: string[];
  };
  docsUrl?: string;
}

// ---------------------------------------------------------------------------
// Domain events — the bus between sync, agent, policy, UI
// ---------------------------------------------------------------------------

export type DomainEvent =
  | { type: "account.synced"; accountId: Id; at: Timestamp; emailsUpserted: number }
  | { type: "email.received"; email: Email }
  | { type: "email.updated"; emailId: Id }
  | { type: "action.proposed"; action: ActionRecord }
  | { type: "action.decided"; action: ActionRecord }
  | { type: "action.held"; action: ActionRecord }
  | { type: "action.executed"; action: ActionRecord }
  | { type: "action.undone"; action: ActionRecord }
  | { type: "action.failed"; action: ActionRecord }
  | { type: "trust.changed"; state: TrustState }
  | { type: "trust.promotion_offered"; offer: PromotionOffer }
  | { type: "matter.updated"; matter: Matter }
  | { type: "person.downgraded"; person: Person; emailId: Id }
  | { type: "agent.run.started"; runId: Id; trigger: string }
  | { type: "agent.run.finished"; runId: Id; proposed: number; executed: number; error?: string | null };

export interface EventBus {
  emit(event: DomainEvent): void;
  on<T extends DomainEvent["type"]>(type: T, handler: (e: Extract<DomainEvent, { type: T }>) => void): () => void;
  onAny(handler: (e: DomainEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// Action execution — shared by the agent runtime, MCP server, and HTTP API.
// Implemented in @passport/policy (it owns the outbox and undo), so every entry point
// goes through the same gate.
// ---------------------------------------------------------------------------

export interface ActionExecutor {
  /**
   * Evaluate the request against policy and either execute, hold, queue as a decision, or deny.
   * Always returns the persisted ActionRecord.
   */
  submit(request: ActionRequest): Promise<ActionRecord>;
  /** Human approves a proposed action, optionally with an edited version of the request. */
  approve(actionId: Id, edited?: ActionRequest): Promise<ActionRecord>;
  reject(actionId: Id, reason?: string): Promise<ActionRecord>;
  /** Cancel a held (outbox) action before release. */
  cancelHold(actionId: Id): Promise<ActionRecord>;
  /** Execute the stored inverse. Fails if inverse is null. */
  undo(actionId: Id): Promise<ActionRecord>;
  /** Release due held actions. Call from a scheduler. Returns executed records. */
  releaseDue(now?: Timestamp): Promise<ActionRecord[]>;
}

// ---------------------------------------------------------------------------
// Agent runtime
// ---------------------------------------------------------------------------

export type LlmProviderKind = "anthropic" | "openai" | "openai-compatible" | "ollama";

export interface LlmConfig {
  provider: LlmProviderKind;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** Cheaper model for classification; defaults to `model`. */
  fastModel?: string;
}

export type AgentTrigger =
  | { kind: "email.received"; emailId: Id }
  | { kind: "schedule"; name: "daily_digest" | "matter_review" | "outbox" }
  | { kind: "manual"; instruction: string; emailIds?: Id[]; matterId?: Id };

export interface AgentRun {
  id: Id;
  trigger: AgentTrigger;
  startedAt: Timestamp;
  finishedAt?: Timestamp | null;
  /** Action ids submitted during this run. */
  actionIds: Id[];
  /** Model transcript, for the daily log / debugging. Keep it summarized, not raw. */
  summary: string;
  error?: string | null;
}

export interface AgentRuntime {
  run(trigger: AgentTrigger): Promise<AgentRun>;
  /** Returns the current USER.md (standing instructions, tone, relationships). */
  getUserProfile(): Promise<string>;
  setUserProfile(markdown: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Tiny pure helpers (no deps)
// ---------------------------------------------------------------------------

export function nowIso(): Timestamp {
  return new Date().toISOString();
}

/** Compare trust levels; returns negative if a < b. */
export function compareTrust(a: TrustLevel, b: TrustLevel): number {
  return TRUST_LEVELS.indexOf(a) - TRUST_LEVELS.indexOf(b);
}

export function minTrust(a: TrustLevel, b: TrustLevel): TrustLevel {
  return compareTrust(a, b) <= 0 ? a : b;
}

/** Default global policy. The reference policy engine starts from this. */
export const DEFAULT_POLICY_CONFIG: GlobalPolicyConfig = {
  globalMode: "auto_accept_edits",
  outboxHoldMinutes: 5,
  decayAfterDays: 14,
  alwaysAsk: ["money", "legal"],
  externalAgentCeiling: "auto_accept_edits",
};

/** Static risk by action type. The engine may raise it based on counterparty and content. */
export const BASE_RISK: Record<ActionType, RiskLevel> = {
  label: "low",
  unlabel: "low",
  archive: "low",
  unarchive: "low",
  mark_read: "low",
  mark_unread: "low",
  flag: "low",
  unflag: "low",
  move: "low",
  delete: "medium",
  draft_create: "low",
  draft_update: "low",
  draft_delete: "low",
  send: "high",
  unsubscribe: "medium",
  calendar_propose: "medium",
  calendar_create: "medium",
  calendar_update: "medium",
  calendar_respond: "medium",
  calendar_delete: "high",
  matter_create: "low",
  matter_update: "low",
  matter_attach: "low",
  person_update: "low",
  snooze: "low",
};

export const BASE_REVERSIBILITY: Record<ActionType, Reversibility> = {
  label: "reversible",
  unlabel: "reversible",
  archive: "reversible",
  unarchive: "reversible",
  mark_read: "reversible",
  mark_unread: "reversible",
  flag: "reversible",
  unflag: "reversible",
  move: "reversible",
  delete: "reversible", // to trash; purge is not exposed
  draft_create: "reversible",
  draft_update: "reversible",
  draft_delete: "reversible",
  send: "delayed",
  unsubscribe: "irreversible",
  calendar_propose: "delayed",
  calendar_create: "reversible",
  calendar_update: "reversible",
  calendar_respond: "irreversible", // organizer is notified
  calendar_delete: "irreversible",
  matter_create: "reversible",
  matter_update: "reversible",
  matter_attach: "reversible",
  person_update: "reversible",
  snooze: "reversible",
};
