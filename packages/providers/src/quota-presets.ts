import type { MailProviderKind, RateLimitScope } from "@passport/types";

/**
 * Gmail API quota units per method (quota page updated 2026-10-16; research report 03 §1.3).
 * Every Gmail reader call declares its cost from this table before calling the API.
 */
export const GMAIL_UNIT_COSTS = {
  getProfile: 1,
  labelsList: 1,
  labelsGet: 1,
  labelsCreate: 5,
  historyList: 2,
  messagesList: 5,
  threadsList: 10,
  draftsList: 5,
  messagesGetMetadata: 20,
  messagesGetFull: 60,
  threadsGetMetadata: 40,
  threadsGetFull: 120,
  attachmentsGet: 20,
  messagesModify: 5,
  threadsModify: 10,
  batchModify: 50,
  messagesTrash: 20,
  messagesUntrash: 5,
  draftsCreate: 10,
  draftsUpdate: 15,
  draftsDelete: 10,
  messagesSend: 100,
  draftsSend: 100,
  watch: 100,
  stop: 50,
  filtersList: 1,
  filtersCreate: 5,
} as const;

/** Longest an interactive call may wait for quota or retries before failing with RATE_LIMITED. */
export const INTERACTIVE_MAX_WAIT_MS = 5_000;

/**
 * While an interactive call waits, `arrivals` and `background` together may spend at most this
 * share of the units that refill (and never more than this share of the bucket), so interactive
 * calls get at least 70% of throughput and the other lanes are never starved.
 */
export const BACKGROUND_SHARE = 0.3;

/** Token-bucket limits for one account. `Infinity` disables a limit. */
export interface QuotaConfig {
  /** Bucket size: the largest burst, in provider units (Gmail) or requests (Graph). */
  capacity: number;
  /** Units restored per second. */
  refillPerSecond: number;
  /** Maximum concurrent leases (Graph: 4 per mailbox; IMAP: 1 pipeline per connection). */
  maxInFlight: number;
  /** Reported in `RateLimitedError.scope` when the governor refuses to wait. */
  scope: RateLimitScope;
}

/**
 * Defaults per provider kind (research §5.1). Gmail: 6,000 units/min as 100/s with a 1,500 burst.
 * Graph: 1,000 requests/min with a 250 burst and 4 in flight. IMAP: one command pipeline per
 * connection, no unit budget. JMAP: 4 concurrent requests (the RFC 8620 `maxConcurrentRequests`
 * default). Mock: unlimited, so tests opt into limits by configuring another kind.
 */
export const QUOTA_PRESETS: Readonly<Record<MailProviderKind, QuotaConfig>> = {
  gmail: {
    capacity: 1_500,
    refillPerSecond: 100,
    maxInFlight: Infinity,
    scope: "gmail:user-quota",
  },
  graph: { capacity: 250, refillPerSecond: 1_000 / 60, maxInFlight: 4, scope: "graph:mailbox" },
  imap: { capacity: Infinity, refillPerSecond: Infinity, maxInFlight: 1, scope: "imap:connection" },
  jmap: { capacity: Infinity, refillPerSecond: Infinity, maxInFlight: 4, scope: "jmap:session" },
  mock: {
    capacity: Infinity,
    refillPerSecond: Infinity,
    maxInFlight: Infinity,
    scope: "passport:governor",
  },
};

/** Provider throttling signals: 429 / Retry-After and Graph `x-ms-throttle-limit-percentage`. */
export interface ThrottleSignal {
  retryAfterSeconds?: number;
  /** Fraction of the provider limit already used (Graph reports 0.8–1.8). */
  throttlePercentage?: number;
}
