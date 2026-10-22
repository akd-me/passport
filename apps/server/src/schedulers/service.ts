import {
  createScheduler,
  type JobDefinition,
  type JobState,
  type Schedule,
  type Scheduler,
  validateSchedule,
} from "@passport/scheduler";
import type { Account } from "@passport/types";
import type { Backend } from "../backend.js";
import { ApiError } from "../errors.js";
import { logger } from "../logger.js";
import { routineBinding } from "../tasks/jobs.js";
import { object, string } from "../validation.js";
import { calendarSyncJob, pushJob, watchJob, watchJobId } from "./account-jobs.js";
import { registerSystemJobs } from "./system-jobs.js";

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
  if (!result || result.length > max) {
    throw new ApiError("INVALID_FIELD", `${name} must contain 1–${max} characters`);
  }
  return result;
}
function instruction(value: unknown) {
  const routine = object(value);
  if (Object.keys(routine).some((k) => k !== "instruction")) {
    throw new ApiError("INVALID_FIELD", "Unknown routine field");
  }
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
      runOnTask: (taskId, ctx, run) =>
        backend.tasks ? backend.tasks.triggers.runJob(taskId, ctx, run) : run(ctx),
    });
    this.ready = this.initialize();
    // Successful onboarding/sync outside the HTTP API also discovers new accounts.
    const discover = () => {
      if (!this.stopped) {
        void this.reconcileAccounts().catch(() => {
          // Keep the existing operational log and fallback; never include the caught payload.
          return logger.warn("Scheduler account discovery failed");
        });
      }
    };
    const unsubscribers = [
      backend.bus.on("account.synced", discover),
      backend.bus.on("account.watch.started", discover),
    ];
    this.unsubscribe = () => {
      for (const off of unsubscribers) {
        off();
      }
    };
    void this.ready.catch(() => {
      // Keep the existing operational log and fallback; never include the caught payload.
      return logger.error("Scheduler initialization failed");
    });
  }
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {
      // Scheduler update failed; later updates may continue.
      logger.warn("Scheduler update failed; later updates may continue");
      return undefined;
    });
    return result;
  }
  private async register(def: JobDefinition) {
    this.definitions.set(def.id, def);
    try {
      await this.scheduler.register(def);
    } catch (error) {
      // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

      this.definitions.delete(def.id);
      throw error;
    }
  }
  private async initialize() {
    const { backend } = this;
    await registerSystemJobs(
      backend,
      (def) => this.register(def),
      () => this.reconcileAccounts(),
      () => this.accounts.size,
    );
    const saved = await backend.store.kv.get(ROUTINES_KEY);
    if (saved) {
      for (const value of JSON.parse(saved) as RoutineDefinition[]) {
        try {
          const def = {
            id: value.id,
            name: text(value.name, "name", 200),
            schedule: validateSchedule(value.schedule),
            routine: instruction(value.routine),
          };
          await this.registerRoutine(def);
          this.routines.set(def.id, def);
        } catch {
          // One invalid saved routine must not keep the scheduler (and account routes) down.
          logger.warn("Skipped a saved routine that no longer validates");
        }
      }
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
      ...(await routineBinding(this.backend, def.id, def.name)),
      run: async ({ agentRunOptions }) => {
        const run = await this.backend.agent.run(
          { kind: "manual", instruction: this.routines.get(def.id)!.routine.instruction },
          // Routines run in the background lane; the composer keeps the interactive one.
          { ...agentRunOptions, priority: "background" },
        );
        if (run.error) {
          throw new Error(run.error);
        }
        return { summary: run.summary };
      },
    });
  }
  private saveRoutines() {
    return this.backend.store.kv.set(ROUTINES_KEY, JSON.stringify([...this.routines.values()]));
  }
  private async addAccount(account: Account) {
    const syncId = `sync:${account.id}`;
    // Calendars keep a bounded sync; mail is never mirrored, only watched.
    if (account.capabilities.calendar && !this.scheduler.get(syncId)) {
      await this.register(calendarSyncJob(this.backend, account));
      if (!this.scheduler.get(syncId)!.lastRunAt) {
        this.bootRuns.add(syncId);
      }
    }
    const id = watchJobId(account.id);
    const watch = watchJob(this.backend, account);
    if (watch && !this.scheduler.get(id)) {
      await this.register(watch);
      // Every start checks for new mail at once; the first tick ever only takes a cursor.
      this.bootRuns.add(id);
    }
    const pushId = `${id}:push`;
    const push = !!watch && !!account.capabilities.push && !!this.backend.waitForChanges;
    if (push && !this.scheduler.get(pushId)) {
      await this.register(
        pushJob(this.backend, account, async () => {
          if (this.scheduler.get(id)?.enabled) {
            await this.scheduler.runNow(id);
          }
        }),
      );
      this.bootRuns.add(pushId);
    } else if (!push && this.scheduler.get(pushId)) {
      await this.scheduler.unregister(pushId);
      this.definitions.delete(pushId);
    }
    this.accounts.set(account.id, push);
    this.launchBootRuns();
  }
  private launchBootRuns() {
    if (!this.started || this.stopped) {
      return;
    }
    for (const id of this.bootRuns) {
      this.bootRuns.delete(id);
      if (this.scheduler.get(id)?.enabled) {
        void this.scheduler.runNow(id).catch(() => {
          // Keep the existing operational log and fallback; never include the caught payload.
          return logger.warn("Initial account job failed");
        });
      }
    }
  }
  private async discoverAccounts() {
    const accounts = await this.backend.store.accounts.list();
    const ids = new Set(accounts.map((a) => a.id));
    for (const id of this.accounts.keys()) {
      if (!ids.has(id)) {
        await this.dropAccount(id);
      }
    }
    for (const account of accounts) {
      await this.addAccount(account);
    }
  }
  private async dropAccount(accountId: string) {
    const watch = watchJobId(accountId);
    for (const id of [`sync:${accountId}`, watch, `${watch}:push`, `sync:${accountId}:watch`]) {
      if (this.scheduler.get(id)) {
        await this.scheduler.unregister(id);
        this.definitions.delete(id);
        this.bootRuns.delete(id);
      }
    }
    this.accounts.delete(accountId);
  }
  async reconcileAccounts() {
    await this.ready;
    if (!this.stopped) {
      await this.exclusive(() => this.discoverAccounts());
    }
  }
  async registerAccount(accountId: string) {
    await this.ready;
    await this.exclusive(async () => {
      const account = await this.backend.store.accounts.get(accountId);
      if (!account) {
        throw new ApiError("NOT_FOUND", "Account not found", 404);
      }
      await this.addAccount(account);
    });
  }
  async unregisterAccount(accountId: string) {
    await this.ready;
    await this.exclusive(() => this.dropAccount(accountId));
  }
  async start() {
    await this.ready;
    if (this.stopped || this.started) {
      return;
    }
    this.started = true;
    await this.scheduler.start();
    this.launchBootRuns();
  }
  async stop() {
    this.stopped = true;
    this.started = false;
    this.unsubscribe();
    await this.ready.catch(() => {
      // Scheduler initialization failed before shutdown.
      logger.warn("Scheduler initialization failed before shutdown");
      return undefined;
    });
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
    if (Object.keys(body).some((k) => !["name", "schedule", "routine"].includes(k))) {
      throw new ApiError("INVALID_FIELD", "Unknown routine field");
    }
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
        // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

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
      if (!state) {
        throw new ApiError("NOT_FOUND", "Job not found", 404);
      }
      if (Object.keys(body).some((k) => !["schedule", "enabled", "name", "routine"].includes(k))) {
        throw new ApiError("INVALID_FIELD", "Unknown job field");
      }
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
        throw new ApiError("INVALID_FIELD", "enabled must be boolean");
      }
      const schedule = body.schedule === undefined ? undefined : validateSchedule(body.schedule);
      const routine = this.routines.get(id);
      if (!routine && (body.name !== undefined || body.routine !== undefined)) {
        throw new ApiError("INVALID_FIELD", "System job names and handlers are fixed");
      }
      const name = body.name === undefined ? undefined : text(body.name, "name", 200);
      const nextInstruction = body.routine === undefined ? undefined : instruction(body.routine);
      if (routine) {
        if (name) {
          routine.name = name;
          this.definitions.get(id)!.name = name;
        }
        if (schedule) {
          routine.schedule = schedule;
        }
        if (nextInstruction) {
          routine.routine = nextInstruction;
        }
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
