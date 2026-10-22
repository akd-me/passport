import type {
  MailReader,
  MailReaderResolver,
  MailReadOptions,
  QuotaLane,
  ReadMeta,
} from "@passport/types";

/** Provider reads one run may spend, matching the manual loop's twelve tool calls. */
export const RUN_READ_BUDGET = 12;

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
  /** The metered reader for an account, or null when none is injected or the provider has none. */
  reader(accountId: string): Promise<AgentReader | null>;
}

export function emptyReadUsage(): ReadUsage {
  return { calls: 0, failures: 0, skipped: 0, gmailUnits: 0, graphRequests: 0, imapCommands: 0 };
}

/** Per-run reader access; resolvers are called at most once per account per run. */
export function createRunReads(opts: {
  readers?: MailReaderResolver;
  lane: QuotaLane;
  budget?: number;
  log?: (message: string) => void;
}): RunReads {
  const usage = emptyReadUsage();
  const budget = opts.budget ?? RUN_READ_BUDGET;
  const resolved = new Map<string, Promise<AgentReader | null>>();
  const meter = (reader: MailReader): AgentReader => ({
    async call(op) {
      if (usage.calls >= budget) {
        usage.skipped++;
        return null;
      }
      usage.calls++;
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
    reader(accountId) {
      const readers = opts.readers;
      if (!readers) {
        return Promise.resolve(null);
      }
      let found = resolved.get(accountId);
      if (!found) {
        found = readers(accountId).then(
          (reader) => (reader ? meter(reader) : null),
          () => {
            opts.log?.("Agent reader resolution failed; continuing with local data");
            return null;
          },
        );
        resolved.set(accountId, found);
      }
      return found;
    },
  };
}

/** Quote an address for a portable query, or null when it cannot be expressed safely. */
export function queryAddress(address: string): string | null {
  return /^[^\s"()\\]+@[^\s"()\\]+$/.test(address) ? `"${address}"` : null;
}
