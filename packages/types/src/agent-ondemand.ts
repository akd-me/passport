/**
 * Additive contract (v0.3): agent runtime on on-demand readers. Re-exported from `./index.ts`.
 * See `docs/design/on-demand.md` §4.2–4.3 and research report 03 §4.3.
 */

import type { Person, Timestamp } from "./index.js";

/**
 * Cached relationship evidence on the structured person row. `Person.stats.sent` and
 * `.received` hold capped provider counts (`countIds`): sent is 0 or 1 ("have we ever sent to
 * them"), received is 0–3 (the count class; 3 means "3 or more").
 */
export interface PersonStatsCache {
  /** When `stats` was last counted from the provider; absent or null = never (or store-derived). */
  statsRefreshedAt?: Timestamp | null;
}

/** A person row that may carry `PersonStatsCache` fields (persisted in the row's JSON data). */
export type PersonWithStatsCache = Person & PersonStatsCache;

/** Provider counts older than this are recounted on the next arrival that involves the person. */
export const PERSON_STATS_MAX_AGE_MS = 7 * 86_400_000;

/** Caps passed to `MailReader.countIds` for relationship evidence. */
export const PERSON_STATS_CAPS = { sent: 1, received: 3 } as const;

/**
 * Agent run queue priority. Interactive runs (composer, manual) start before any queued
 * background run (arrival triage, schedules); runs never preempt one already in progress.
 */
export type AgentRunPriority = "interactive" | "background";

/** Options for `run(trigger, options)` on the built-in agent runtime. */
export interface AgentRunOptions {
  /** Default: `"interactive"` for manual triggers, `"background"` otherwise. */
  priority?: AgentRunPriority;
}
