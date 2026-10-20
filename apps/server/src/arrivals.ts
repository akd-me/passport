import { newId } from "@passport/store";
import type { AgentRuntime, AgentTrigger, Email, EventBus, Store } from "@passport/types";
import { logger } from "./logger.js";
import { compareAndSetKv, mutateKv } from "./atomic-kv.js";
import { calendarsReady } from "./calendar-safety.js";

export type ArrivalTrigger = AgentTrigger & { runId?: string; availabilityUnverified?: boolean };

export interface Arrival {
  accountId: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  attentionActionId?: string;
  startedAt?: string;
  completedAt?: string;
  calendarWaitStartedAt?: string;
}
const INDEX = "arrival:pending";
const delays = [60000, 300000, 900000, 3600000];
const writes = new WeakMap<Store, Promise<unknown>>();
const arrivalKey = (id: string) => `arrival:${id}`;

// Store.kv has no prefix scan. Serialize changes to a durable discovery index.
function indexed<T>(store: Store, task: () => Promise<T>): Promise<T> {
  const result = (writes.get(store) ?? Promise.resolve()).then(task);
  writes.set(
    store,
    result.catch(() => undefined),
  );
  return result;
}
async function pending(store: Store): Promise<Record<string, string>> {
  return JSON.parse((await store.kv.get(INDEX)) ?? "{}");
}
export async function persistArrival(
  store: Store,
  email: Email,
): Promise<void> {
  await indexed(store, async () => {
    const key = arrivalKey(email.id);
    if (!(await store.kv.get(key))) {
      const entry: Arrival = {
        accountId: email.accountId,
        attempts: 0,
        nextAttemptAt: new Date().toISOString(),
        lastError: null,
      };
      compareAndSetKv(store, key, null, JSON.stringify(entry));
    }
    // Both writes finish before sync stores the email, so interrupted ingestion
    // retries registration before the email can be considered already ingested.
    mutateKv(store, INDEX, current => JSON.stringify({ ...JSON.parse(current ?? "{}"), [email.id]: email.accountId }));
  });
}

/** Durable retries and the immediate arrival path share the same per-account lock. */
export class ArrivalQueue {
  private accounts = new Map<string, Promise<void>>();
  private active = new Map<string, Promise<void>>();
  private draining?: Promise<void>;
  constructor(
    private store: Store,
    private bus: EventBus,
    private agent: AgentRuntime,
    private enabled: () => boolean,
  ) {}

  private async acknowledge(emailId: string, keepEntry = false) {
    await indexed(this.store, async () => {
      mutateKv(this.store, INDEX, current => {
        const index = JSON.parse(current ?? "{}");
        delete index[emailId];
        return JSON.stringify(index);
      });
      if (!keepEntry) await this.store.kv.delete(arrivalKey(emailId));
    });
  }
  private save(emailId: string, entry: Arrival) {
    return this.store.kv.set(arrivalKey(emailId), JSON.stringify(entry));
  }
  private async attention(email: Email, entry: Arrival) {
    entry.nextAttemptAt = null;
    entry.attentionActionId ??= newId();
    await this.save(email.id, entry);
    if (!(await this.store.actions.get(entry.attentionActionId))) {
      const reason = "Needs your attention: triage failed";
      const action = await this.store.actions.insert({
        id: entry.attentionActionId,
        status: "proposed",
        createdAt: new Date().toISOString(),
        request: {
          accountId: email.accountId,
          actor: { kind: "agent", id: "agent.arrivals" },
          category: "matters",
          reason,
          ...(email.matterId
            ? {
                type: "matter_update" as const,
                matterId: email.matterId,
                params: {
                  matterId: email.matterId,
                  patch: {
                    nextStep: `Review email manually: ${email.subject}`,
                  },
                },
              }
            : {
                type: "matter_create" as const,
                params: {
                  matter: {
                    title: email.subject || "Email needs review",
                    summary: reason,
                    status: "active" as const,
                    kind: "triage",
                    personIds: email.personIds,
                    emailIds: [email.id],
                    eventIds: [],
                    nextStep: "Review this email manually.",
                  },
                },
              }),
        },
        decision: {
          outcome: "ask",
          reason:
            "Review this email manually after five failed triage attempts",
          risk: "low",
          reversibility: "reversible",
          trustLevel: "supervised",
          category: "matters",
        },
      });
      this.bus.emit({ type: "action.proposed", action });
    }
    await this.acknowledge(email.id, true);
  }
  private async process(emailId: string) {
    if (!this.enabled()) return;
    const claimKey = `arrival-claim:${emailId}`;
    let claim = await this.store.kv.get(claimKey);
    if (claim && Date.parse(JSON.parse(claim).expiresAt) > Date.now()) return;
    const id = crypto.randomUUID();
    const renewed = () => JSON.stringify({ id, pid: process.pid, expiresAt: new Date(Date.now() + 60000).toISOString() });
    const next = renewed();
    if (!compareAndSetKv(this.store, claimKey, claim, next)) return;
    claim = next;
    const timer = setInterval(() => {
      try {
        const next = renewed();
        if (compareAndSetKv(this.store, claimKey, claim, next)) claim = next;
        else clearInterval(timer);
      } catch {
        logger.warn("Arrival claim heartbeat failed; retrying at the next heartbeat");
      }
    }, 10000);
    timer.unref();
    try { await this.processClaimed(emailId); }
    finally {
      clearInterval(timer);
      compareAndSetKv(this.store, claimKey, claim, null);
    }
  }
  private async processClaimed(emailId: string) {
    const saved = await this.store.kv.get(arrivalKey(emailId));
    if (!saved) return;
    const entry: Arrival = JSON.parse(saved);
    const runId = `arrival:${emailId}`;
    const journal = await this.store.kv.get(`run:${runId}`);
    const checkpoint = journal ? JSON.parse(journal) : null;
    if (entry.completedAt || (checkpoint?.finishedAt && !checkpoint.error) ||
        (await this.store.actions.query({ runId, limit: 1 })).items.length) {
      await this.acknowledge(emailId);
      return;
    }
    const email = await this.store.emails.get(emailId);
    if (!email) {
      // An indexed arrival can precede its email if sync was interrupted.
      if (!(await this.store.accounts.get(entry.accountId)))
        await this.acknowledge(emailId);
      return;
    }
    if (email.keywords.$deleted) {
      await this.acknowledge(emailId);
      return;
    }
    if (entry.attempts >= 5) {
      await this.attention(email, entry);
      return;
    }
    if (!entry.nextAttemptAt || Date.parse(entry.nextAttemptAt) > Date.now())
      return;
    const ready = await calendarsReady(this.store, email.accountId);
    if (!ready) {
      entry.calendarWaitStartedAt ??= new Date().toISOString();
      const deadline = Date.parse(entry.calendarWaitStartedAt) + 600000;
      if (Date.now() < deadline) {
        entry.nextAttemptAt = new Date(Math.min(Date.now() + 30000, deadline)).toISOString();
        await this.save(emailId, entry);
        return;
      }
    }
    entry.attempts++;
    entry.startedAt = new Date().toISOString();
    // Persist a claim before inference, including a retry deadline if the process
    // exits mid-run. The fifth interrupted attempt is surfaced on the next drain.
    entry.nextAttemptAt = new Date(
      Date.now() + (delays[entry.attempts - 1] ?? 0),
    ).toISOString();
    await this.save(emailId, entry);
    try {
      const trigger: ArrivalTrigger = { kind: "email.received", emailId, runId, ...(!ready ? { availabilityUnverified: true } : {}) };
      const run = await this.agent.run(trigger);
      if (run.error) throw new Error(run.error);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      entry.lastError =
        typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
          ? code
          : "TRIAGE_FAILED";
      if (entry.attempts === 5)
        await this.attention(
          (await this.store.emails.get(emailId)) ?? email,
          entry,
        );
      else {
        entry.nextAttemptAt = new Date(
          Date.now() + delays[entry.attempts - 1]!,
        ).toISOString();
        await this.save(emailId, entry);
      }
      logger.warn("Email triage failed; outcome recorded");
      return;
    }
    entry.completedAt = new Date().toISOString();
    await this.save(emailId, entry);
    await this.acknowledge(emailId);
  }
  enqueue(emailId: string, accountId: string): Promise<void> {
    const active = this.active.get(emailId);
    if (active) return active;
    const job = (this.accounts.get(accountId) ?? Promise.resolve()).then(() =>
      this.process(emailId),
    );
    // A persistence error leaves the entry available for a later scheduler pass.
    const settled = job.catch(() => {
      logger.warn("Arrival processing interrupted; entry retained for retry");
    });
    this.active.set(emailId, settled);
    this.accounts.set(accountId, settled);
    void settled.then(() => {
      this.active.delete(emailId);
      if (this.accounts.get(accountId) === settled)
        this.accounts.delete(accountId);
    });
    return settled;
  }
  drainDue(signal?: AbortSignal): Promise<void> {
    if (this.draining) return this.draining;
    const job = (async () => {
      if (!this.enabled() || signal?.aborted) return;
      const index = await pending(this.store);
      const jobs: Promise<void>[] = [];
      for (const [emailId, accountId] of Object.entries(index)) {
        if (signal?.aborted) break;
        jobs.push(this.enqueue(emailId, accountId));
      }
      await Promise.all(jobs);
    })().finally(() => {
      this.draining = undefined;
    });
    this.draining = job;
    return job;
  }
  async drain(): Promise<void> {
    while (this.draining || this.active.size)
      await Promise.all([this.draining, ...this.active.values()]);
  }
}
