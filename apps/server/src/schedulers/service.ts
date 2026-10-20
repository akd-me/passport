import {
  createScheduler,
  validateSchedule,
  type JobDefinition,
  type JobState,
  type Schedule,
  type Scheduler,
} from "@passport/scheduler";
import type { Account, Store } from "@passport/types";
import type { Backend } from "../backend.js";
import { ApiError } from "../errors.js";
import { logger } from "../logger.js";
import { object, string } from "../validation.js";

export interface RoutineDefinition {
  id: string;
  name: string;
  schedule: Schedule;
  routine: { instruction: string };
}
export interface JobView extends JobState {
  routine?: { instruction: string };
  definition: Omit<JobDefinition, "run"> & {
    routine?: { instruction: string };
  };
}
const services = new WeakMap<Backend, SchedulerService>();
const ROUTINES_KEY = "scheduler:routines";
function text(value: unknown, name: string, max: number) {
  const result = string(value, name).trim();
  if (!result || result.length > max)
    throw new ApiError(
      "INVALID_FIELD",
      `${name} must contain 1–${max} characters`,
    );
  return result;
}
function instruction(value: unknown) {
  const routine = object(value);
  if (Object.keys(routine).some((k) => k !== "instruction"))
    throw new ApiError("INVALID_FIELD", "Unknown routine field");
  return { instruction: text(routine.instruction, "instruction", 20000) };
}
/** One shared instance per backend; merely creating the HTTP app does not start timers. */
export function getSchedulerService(backend: Backend): SchedulerService {
  let service = services.get(backend);
  if (!service) {
    service = new SchedulerService(backend);
    services.set(backend, service);
  }
  return service;
}
export function existingSchedulerService(backend: Backend) {
  return services.get(backend);
}

export class SchedulerService {
  readonly scheduler: Scheduler;
  readonly ready: Promise<void>;
  private definitions = new Map<string, JobDefinition>();
  private routines = new Map<string, RoutineDefinition>();
  private accounts = new Map<string, boolean>();
  private queue: Promise<unknown> = Promise.resolve();
  private started = false;
  private stopped = false;
  private unsubscribe: () => void;
  private bootRuns = new Set<string>();
  constructor(private backend: Backend) {
    this.scheduler = createScheduler({
      store: backend.store,
      bus: backend.bus,
      logger,
    });
    this.ready = this.initialize();
    // Successful onboarding/sync outside the HTTP API also discovers new accounts.
    this.unsubscribe = backend.bus.on("account.synced", () => {
      if (!this.stopped)
        void this.reconcileAccounts().catch(() =>
          logger.warn("Scheduler account discovery failed"),
        );
    });
    void this.ready.catch(() =>
      logger.error("Scheduler initialization failed"),
    );
  }
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async register(def: JobDefinition) {
    this.definitions.set(def.id, def);
    try {
      await this.scheduler.register(def);
    } catch (error) {
      this.definitions.delete(def.id);
      throw error;
    }
  }
  private async initialize() {
    const { backend } = this;
    const system = (
      id: string,
      name: string,
      schedule: Schedule,
      run: JobDefinition["run"],
      extra: Partial<JobDefinition> = {},
    ) => this.register({ id, name, kind: "system", schedule, run, ...extra });
    await system(
      "outbox.release",
      "Release delayed outbox",
      { type: "interval", everyMs: 30000 },
      async () => ({
        summary: `Released ${(await backend.executor.releaseDue()).length} actions`,
      }),
      { retry: { maxAttempts: 5, baseMs: 30000, maxMs: 3600000 } },
    );
    await system(
      "trust.decay",
      "Trust decay",
      { type: "daily", at: "03:00" },
      async () => ({
        summary: `Reviewed ${(await backend.policy.applyDecay()).length} trust categories`,
      }),
    );
    await system(
      "agent.daily_digest",
      "Daily digest",
      {
        type: "daily",
        at: `${String(backend.config.dailyDigestHour).padStart(2, "0")}:00`,
      },
      async () => {
        const run = await backend.agent.run({
          kind: "schedule",
          name: "daily_digest",
        });
        if (run.error) throw new Error(run.error);
        return { summary: run.summary };
      },
      { timeoutMs: 300000 },
    );
    await system(
      "agent.matter_review",
      "Review active matters",
      { type: "daily", at: "04:00" },
      async () => {
        const run = await backend.agent.run({
          kind: "schedule",
          name: "matter_review",
        });
        if (run.error) throw new Error(run.error);
        return { summary: run.summary };
      },
      { timeoutMs: 300000 },
    );
    await system(
      "store.maintenance",
      "Store maintenance",
      { type: "weekly", days: [0], at: "03:30" },
      async () => {
        const store = backend.store as Store & {
          maintenance?: () => Promise<void>;
          vacuum?: () => Promise<void>;
          optimizeFts?: () => Promise<void>;
        };
        if (store.maintenance) await store.maintenance();
        else if (store.vacuum || store.optimizeFts) {
          await store.vacuum?.();
          await store.optimizeFts?.();
        } else
          return {
            status: "skipped",
            summary: "This store does not expose maintenance operations",
          };
        return { summary: "Store maintenance complete" };
      },
    );
    // Reconcile non-HTTP account changes too, without another ad-hoc timer loop.
    await system(
      "accounts.refresh",
      "Discover account changes",
      { type: "interval", everyMs: backend.config.syncIntervalSeconds * 1000 },
      async () => {
        await this.reconcileAccounts();
        return { summary: `${this.accounts.size} accounts registered` };
      },
    );
    const saved = await backend.store.kv.get(ROUTINES_KEY);
    if (saved)
      for (const value of JSON.parse(saved) as RoutineDefinition[]) {
        const def = {
          id: value.id,
          name: text(value.name, "name", 200),
          schedule: validateSchedule(value.schedule),
          routine: instruction(value.routine),
        };
        this.routines.set(def.id, def);
        await this.registerRoutine(def);
      }
    await this.discoverAccounts();
  }
  private async registerRoutine(def: RoutineDefinition) {
    await this.register({
      id: def.id,
      name: def.name,
      kind: "user",
      schedule: def.schedule,
      timeoutMs: 300000,
      run: async () => {
        const run = await this.backend.agent.run({
          kind: "manual",
          instruction: this.routines.get(def.id)!.routine.instruction,
        });
        if (run.error) throw new Error(run.error);
        return { summary: run.summary };
      },
    });
  }
  private saveRoutines() {
    return this.backend.store.kv.set(
      ROUTINES_KEY,
      JSON.stringify([...this.routines.values()]),
    );
  }
  private async addAccount(account: Account) {
    const id = `sync:${account.id}`;
    const everyMs = this.backend.config.syncIntervalSeconds * 1000;
    if (!this.scheduler.get(id)) {
      await this.register({
        id,
        name: `Sync ${account.displayName}`,
        kind: "system",
        schedule: { type: "interval", everyMs },
        run: async () => {
          await this.backend.syncAccount(account.id);
          return { summary: "Account synchronized" };
        },
        timeoutMs: 300000,
      });
      if (!this.scheduler.get(id)!.lastRunAt) this.bootRuns.add(id);
    }
    const watchId = `${id}:watch`;
    const push = !!account.capabilities.push && !!this.backend.waitForChanges;
    if (push && !this.scheduler.get(watchId)) {
      await this.register({
        id: watchId,
        name: `Watch ${account.displayName} for changes`,
        kind: "system",
        schedule: { type: "interval", everyMs },
        run: async ({ signal }) => {
          // Bound each long poll; all recurring scheduling belongs to the scheduler.
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          let abort!: () => void;
          const ended = new Promise<boolean>((resolve) => {
            abort = () => {
              controller.abort();
              resolve(false);
            };
            signal.addEventListener("abort", abort, { once: true });
            timer = setTimeout(abort, everyMs);
            timer.unref?.();
            if (signal.aborted) abort();
          });
          try {
            const changed = await Promise.race([
              this.backend.waitForChanges!(account.id, controller.signal).then(
                () => !controller.signal.aborted,
              ),
              ended,
            ]);
            if (changed && !signal.aborted && this.scheduler.get(id)?.enabled)
              await this.scheduler.runNow(id);
            return {
              summary: changed
                ? "Provider signaled changes"
                : "Long poll ended",
              nextRunInMs: 1000,
            };
          } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            controller.abort();
          }
        },
      });
      this.bootRuns.add(watchId);
    } else if (!push && this.scheduler.get(watchId)) {
      await this.scheduler.unregister(watchId);
      this.definitions.delete(watchId);
    }
    this.accounts.set(account.id, push);
    this.launchBootRuns();
  }
  private launchBootRuns() {
    if (!this.started || this.stopped) return;
    for (const id of this.bootRuns) {
      this.bootRuns.delete(id);
      if (this.scheduler.get(id)?.enabled)
        void this.scheduler
          .runNow(id)
          .catch(() => logger.warn("Initial account job failed"));
    }
  }
  private async discoverAccounts() {
    const accounts = await this.backend.store.accounts.list();
    const ids = new Set(accounts.map((a) => a.id));
    for (const id of this.accounts.keys())
      if (!ids.has(id)) await this.dropAccount(id);
    for (const account of accounts) await this.addAccount(account);
  }
  private async dropAccount(accountId: string) {
    for (const id of [`sync:${accountId}`, `sync:${accountId}:watch`])
      if (this.scheduler.get(id)) {
        await this.scheduler.unregister(id);
        this.definitions.delete(id);
        this.bootRuns.delete(id);
      }
    this.accounts.delete(accountId);
  }
  async reconcileAccounts() {
    await this.ready;
    if (!this.stopped) await this.exclusive(() => this.discoverAccounts());
  }
  async registerAccount(accountId: string) {
    await this.ready;
    await this.exclusive(async () => {
      const account = await this.backend.store.accounts.get(accountId);
      if (!account) throw new ApiError("NOT_FOUND", "Account not found", 404);
      await this.addAccount(account);
    });
  }
  async unregisterAccount(accountId: string) {
    await this.ready;
    await this.exclusive(() => this.dropAccount(accountId));
  }
  async start() {
    await this.ready;
    if (this.stopped || this.started) return;
    this.started = true;
    await this.scheduler.start();
    this.launchBootRuns();
  }
  async stop() {
    this.stopped = true;
    this.started = false;
    this.unsubscribe();
    await this.ready.catch(() => undefined);
    await this.queue;
    await this.scheduler.stop();
    services.delete(this.backend);
  }
  list(): JobView[] {
    return this.scheduler.list().map((state) => {
      const { run: _run, ...definition } = this.definitions.get(state.id)!;
      const routine = this.routines.get(state.id)?.routine;
      return {
        ...state,
        routine,
        definition: { ...definition, schedule: state.schedule, routine },
      };
    });
  }
  async addRoutine(input: unknown) {
    await this.ready;
    const body = object(input);
    if (
      Object.keys(body).some(
        (k) => !["name", "schedule", "routine"].includes(k),
      )
    )
      throw new ApiError("INVALID_FIELD", "Unknown routine field");
    const def: RoutineDefinition = {
      id: `routine:${crypto.randomUUID()}`,
      name: text(body.name, "name", 200),
      schedule: validateSchedule(body.schedule),
      routine: instruction(body.routine),
    };
    return this.exclusive(async () => {
      this.routines.set(def.id, def);
      try {
        await this.saveRoutines();
        await this.registerRoutine(def);
      } catch (error) {
        this.routines.delete(def.id);
        await this.saveRoutines();
        throw error;
      }
      return this.list().find((j) => j.id === def.id)!;
    });
  }
  async update(id: string, input: unknown) {
    await this.ready;
    return this.exclusive(async () => {
      const body = object(input),
        state = this.scheduler.get(id);
      if (!state) throw new ApiError("NOT_FOUND", "Job not found", 404);
      if (
        Object.keys(body).some(
          (k) => !["schedule", "enabled", "name", "routine"].includes(k),
        )
      )
        throw new ApiError("INVALID_FIELD", "Unknown job field");
      if (body.enabled !== undefined && typeof body.enabled !== "boolean")
        throw new ApiError("INVALID_FIELD", "enabled must be boolean");
      const schedule =
        body.schedule === undefined
          ? undefined
          : validateSchedule(body.schedule);
      const routine = this.routines.get(id);
      if (!routine && (body.name !== undefined || body.routine !== undefined))
        throw new ApiError(
          "INVALID_FIELD",
          "System job names and handlers are fixed",
        );
      const name =
        body.name === undefined ? undefined : text(body.name, "name", 200);
      const nextInstruction =
        body.routine === undefined ? undefined : instruction(body.routine);
      if (routine) {
        if (name) {
          routine.name = name;
          this.definitions.get(id)!.name = name;
        }
        if (schedule) routine.schedule = schedule;
        if (nextInstruction) routine.routine = nextInstruction;
        await this.saveRoutines();
      }
      await this.scheduler.update(id, {
        schedule,
        enabled: body.enabled as boolean | undefined,
        name,
      });
      return this.list().find((j) => j.id === id)!;
    });
  }
  async remove(id: string) {
    await this.ready;
    await this.exclusive(async () => {
      await this.scheduler.remove(id);
      this.routines.delete(id);
      this.definitions.delete(id);
      await this.saveRoutines();
    });
  }
}
