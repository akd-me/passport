import type {
  EmailGetOptions,
  MailReader,
  MailReaderResolver,
  MailReadOptions,
  QuotaLane,
  ReadMeta,
} from "@passport/types";

/** Provider reads one run may spend, matching the manual loop's twelve tool calls. */
export const RUN_READ_BUDGET = 12;
/**
 * Provider reads relationship evidence may spend per run, on top of `RUN_READ_BUDGET`, so a wide
 * recipient list cannot starve the body, thread and matter reads triage needs.
 */
export const PEOPLE_READ_BUDGET = 10;
/** Which budget a reader draws from. */
export type ReadPool = "run" | "people";

/** Provider reads a run spent, reported in `AgentRunResult.toolBudget.reads`. */
export interface ReadUsage {
  calls: number;
  failures: number;
  /** Reads refused because the run budget was spent. */
  skipped: number;
  gmailUnits: number;
  graphRequests: number;
  imapCommands: number;
}

/** One account's reader, metered against the run budget and pinned to the run's quota lane. */
export interface AgentReader {
  /**
   * Runs one reader call. Returns null, never throws, when the budget is spent or the read fails
   * (rate limits, stale ids, network): callers degrade to cached or local data.
   */
  call<T extends ReadMeta>(
    op: (reader: MailReader, opts: MailReadOptions) => Promise<T>,
  ): Promise<T | null>;
}

export interface RunReads {
  usage: ReadUsage;
  /**
   * The metered reader for an account, or null when none is injected or the provider has none.
   * `pool` selects the budget (default `"run"`).
   */
  reader(accountId: string, pool?: ReadPool): Promise<AgentReader | null>;
  /**
   * Options for a read-through `Store.emails` read: the run's lane, charged as one run read; once
   * the run budget is spent, cache only. Uncharged when no readers are injected.
   */
  storeRead(opts?: EmailGetOptions): EmailGetOptions;
}

export function emptyReadUsage(): ReadUsage {
  return { calls: 0, failures: 0, skipped: 0, gmailUnits: 0, graphRequests: 0, imapCommands: 0 };
}

/** Per-run reader access; resolvers are called at most once per account per run. */
export function createRunReads(opts: {
  readers?: MailReaderResolver;
  lane: QuotaLane;
  budget?: number;
  peopleBudget?: number;
  log?: (message: string) => void;
}): RunReads {
  const usage = emptyReadUsage();
  const limits: Record<ReadPool, number> = {
    run: opts.budget ?? RUN_READ_BUDGET,
    people: opts.peopleBudget ?? PEOPLE_READ_BUDGET,
  };
  const spent: Record<ReadPool, number> = { run: 0, people: 0 };
  const charge = (pool: ReadPool): boolean => {
    if (spent[pool] >= limits[pool]) {
      usage.skipped++;
      return false;
    }
    spent[pool]++;
    usage.calls++;
    return true;
  };
  const resolved = new Map<string, Promise<MailReader | null>>();
  const meter = (reader: MailReader, pool: ReadPool): AgentReader => ({
    async call(op) {
      if (!charge(pool)) {
        return null;
      }
      try {
        const result = await op(reader, { lane: opts.lane });
        usage.gmailUnits += result.cost.gmailUnits ?? 0;
        usage.graphRequests += result.cost.graphRequests ?? 0;
        usage.imapCommands += result.cost.imapCommands ?? 0;
        return result;
      } catch {
        // Provider errors may echo message content; record the failure without its payload.
        usage.failures++;
        opts.log?.("Agent provider read failed; continuing with local data");
        return null;
      }
    },
  });
  return {
    usage,
    async reader(accountId, pool = "run") {
      const readers = opts.readers;
      if (!readers) {
        return null;
      }
      let found = resolved.get(accountId);
      if (!found) {
        found = readers(accountId).catch(() => {
          opts.log?.("Agent reader resolution failed; continuing with local data");
          return null;
        });
        resolved.set(accountId, found);
      }
      const reader = await found;
      return reader ? meter(reader, pool) : null;
    },
    storeRead(read = {}) {
      if (!opts.readers) {
        return { ...read, lane: opts.lane };
      }
      return charge("run") ? { ...read, lane: opts.lane } : { ...read, cacheOnly: true };
    },
  };
}

/** Quote an address for a portable query, or null when it cannot be expressed safely. */
export function queryAddress(address: string): string | null {
  return /^[^\s"()\\]+@[^\s"()\\]+$/.test(address) ? `"${address}"` : null;
}
