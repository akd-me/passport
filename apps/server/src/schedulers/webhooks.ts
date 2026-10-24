import { randomBytes } from "node:crypto";
import {
  type JobRun,
  matchesWebhookFilters,
  renderWebhookTemplate,
  verifyWebhookSignature,
  type WebhookRequest,
  webhookKey,
} from "@passport/scheduler";
import type {
  EventBus,
  Store,
  WebhookDelivery,
  WebhookDeliveryOutcome,
  WebhookSchedule,
} from "@passport/types";
import { ApiError } from "../errors.js";
import { logger } from "../logger.js";
import { frameUntrusted } from "../tasks/untrusted.js";

interface PendingWindow {
  receivedAt: number;
  key: string;
  deliveryId: string;
  latestDeliveryId?: string;
  dueAt: number;
  prompt: string;
}
interface HookState {
  token: string;
  replay: Record<string, number>;
  pending: PendingWindow[];
  deliveries: WebhookDelivery[];
  rate: { minute: number; deliveries: number; updates: number; requests: number; rejected: number };
}
export interface HookRoutine {
  id: string;
  enabled: boolean;
  running: boolean;
  schedule: WebhookSchedule;
  instruction: string;
}
export interface HookResult {
  outcome: WebhookDeliveryOutcome;
  status: 202 | 200 | 401 | 410 | 429;
}
const KEY = "scheduler:webhooks";
const REPLAY_MS = 7 * 86400_000;

/** Durable intake queue. Mutations serialize; dispatch never holds the intake lock. */
export class RoutineWebhooks {
  private states: Record<string, HookState> = {};
  private queue: Promise<unknown> = Promise.resolve();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private active = new Set<string>();
  private stopped = false;
  constructor(
    private store: Store,
    private bus: EventBus,
    private routine: (id: string) => HookRoutine | undefined,
    private dispatch: (id: string, prompt: string) => Promise<JobRun>,
    private now = () => Date.now(),
  ) {}
  async load() {
    const saved = await this.store.kv.get(KEY);
    this.states = saved ? JSON.parse(saved) : {};
  }
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run);
    this.queue = result.catch(() => logger.warn("Webhook state update failed"));
    return result;
  }
  private save() {
    return this.store.kv.set(KEY, JSON.stringify(this.states));
  }
  async ensure(id: string) {
    return this.exclusive(async () => {
      if (!this.states[id]) {
        this.states[id] = {
          token: randomBytes(32).toString("hex"),
          replay: {},
          pending: [],
          deliveries: [],
          rate: { minute: 0, deliveries: 0, updates: 0, requests: 0, rejected: 0 },
        };
        await this.save();
      }
      return this.path(id);
    });
  }
  path(id: string): string | undefined {
    const state = this.states[id];
    return state ? "/api/hooks/" + state.token : undefined;
  }
  async rotate(id: string) {
    return this.exclusive(async () => {
      const state = this.states[id];
      if (!state || !this.routine(id)) {
        throw new ApiError("NOT_FOUND", "Webhook routine not found", 404);
      }
      state.token = randomBytes(32).toString("hex");
      await this.save();
      return { webhookUrl: this.path(id)! };
    });
  }
  deliveries(id: string) {
    return structuredClone(this.states[id]?.deliveries ?? []);
  }
  async remove(id: string) {
    await this.exclusive(async () => {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      delete this.states[id];
      await this.save();
      await this.store.encryptedKv?.delete("webhook-signature:" + id);
    });
  }
  start() {
    this.stopped = false;
    for (const id of Object.keys(this.states)) {
      this.arm(id);
    }
  }
  async stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    await this.queue;
  }
  private log(id: string, state: HookState, outcome: WebhookDeliveryOutcome, prompt?: string) {
    const delivery: WebhookDelivery = {
      id: crypto.randomUUID(),
      jobId: id,
      receivedAt: new Date(this.now()).toISOString(),
      outcome,
      ...(prompt === undefined ? {} : { prompt }),
    };
    state.deliveries = [...state.deliveries, delivery].slice(-50);
    this.bus.emit({ type: "job.delivery", delivery });
    return delivery;
  }
  async receive(token: string, raw: Uint8Array, request: WebhookRequest): Promise<HookResult> {
    const result = await this.exclusive(async (): Promise<HookResult> => {
      const entry = Object.entries(this.states).find(([, state]) => state.token === token);
      if (!entry) {
        throw new ApiError("NOT_FOUND", "Webhook not found", 404);
      }
      const [id, state] = entry;
      const routine = this.routine(id);
      if (!routine) {
        throw new ApiError("NOT_FOUND", "Webhook not found", 404);
      }
      const reject = async (outcome: WebhookDeliveryOutcome, status: HookResult["status"]) => {
        if (["disabled", "rejected_signature", "expired"].includes(outcome)) {
          state.rate.rejected = (state.rate.rejected ?? 0) + 1;
        }
        // One rate-limit record per minute bounds writes during a flood.
        const alreadyLimited =
          outcome === "rate_limited" &&
          state.deliveries.some(
            (delivery) =>
              delivery.outcome === outcome && Date.parse(delivery.receivedAt) >= minute * 60000,
          );
        if (alreadyLimited) {
          return { outcome, status };
        }
        this.log(id, state, outcome);
        await this.save();
        return { outcome, status };
      };
      const minute = Math.floor(this.now() / 60000);
      if (state.rate.minute !== minute) {
        state.rate = { minute, deliveries: 0, updates: 0, requests: 0, rejected: 0 };
      }
      // Bound invalid/disabled requests too, before any HMAC work.
      state.rate.requests = (state.rate.requests ?? 0) + 1;
      if (state.rate.requests > 70 || state.rate.rejected >= 10) {
        return reject("rate_limited", 429);
      }
      if (!routine.enabled) {
        state.rate.deliveries++;
        return reject("disabled", 410);
      }
      const schedule = routine.schedule;
      if (schedule.signature) {
        const secret = await this.store.encryptedKv?.get("webhook-signature:" + id);
        if (!secret || !verifyWebhookSignature(raw, request.headers, schedule.signature, secret)) {
          state.rate.deliveries++;
          return reject("rejected_signature", 401);
        }
      }
      if (schedule.maxDeliveryAgeMinutes !== undefined) {
        // Direct requests arrive now; relay receive times can only make them older.
        const value =
          request.headers["x-t3-relay-received-at"] ?? request.headers["x-webhook-timestamp"];
        const numeric = value ? Number(value) : Number.NaN;
        const parsed = Number.isFinite(numeric)
          ? numeric * (numeric < 1e12 ? 1000 : 1)
          : Date.parse(value ?? "");
        const timestamp = Number.isFinite(parsed) ? Math.min(parsed, this.now()) : this.now();
        if (this.now() - timestamp > schedule.maxDeliveryAgeMinutes * 60000) {
          state.rate.deliveries++;
          return reject("expired", 200);
        }
      }
      if (!matchesWebhookFilters(request, schedule.filters)) {
        state.rate.deliveries++;
        return reject("filtered", 200);
      }
      state.replay = Object.fromEntries(
        Object.entries(state.replay).filter(([, at]) => this.now() - at < REPLAY_MS),
      );
      const replay = webhookKey(schedule.dedupe?.replayKey, request);
      if (replay && state.replay[replay] !== undefined) {
        state.rate.deliveries++;
        return reject("duplicate", 200);
      }
      const key = webhookKey(schedule.dedupe?.coalesceKey, request);
      const pending = key
        ? state.pending.find((window) => window.key === key && window.dueAt > this.now())
        : undefined;
      if (pending ? state.rate.updates >= 60 : state.rate.deliveries >= 10) {
        return reject("rate_limited", 429);
      }
      // The agent sees a scrubbed request, never bearer/cookie credentials.
      const safe = structuredClone(request);
      for (const header of Object.keys(safe.headers)) {
        if (
          /auth|cookie|password|credential|key|token|secret|signature|hmac|jwt|assertion/i.test(
            header,
          ) ||
          header === schedule.signature?.header
        ) {
          delete safe.headers[header];
        }
      }
      for (const key of Object.keys(safe.query)) {
        if (/auth|password|credential|key|token|secret|signature/i.test(key)) {
          safe.query[key] = "[redacted]";
        }
      }
      const prompt = renderWebhookTemplate(routine.instruction, safe, frameUntrusted);
      if (replay) {
        state.replay[replay] = this.now();
      }
      if (pending) {
        state.rate.updates++;
        pending.prompt = prompt;
        pending.receivedAt = this.now();
        pending.latestDeliveryId = this.log(id, state, "coalesced", prompt).id;
      } else {
        state.rate.deliveries++;
        const delivery = this.log(id, state, "accepted", prompt);
        state.pending.push({
          receivedAt: this.now(),
          key: key ?? delivery.id,
          deliveryId: delivery.id,
          prompt,
          dueAt: this.now() + (key ? (schedule.dedupe?.coalesceWindowSeconds ?? 120) * 1000 : 0),
        });
      }
      await this.save();
      this.arm(id);
      return { outcome: pending ? "coalesced" : "accepted", status: 202 };
    });
    return result;
  }
  private arm(id: string) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const state = this.states[id];
    if (this.stopped || this.active.has(id) || !state?.pending.length) {
      return;
    }
    const due = Math.min(...state.pending.map((window) => window.dueAt));
    const timer = setTimeout(
      () => {
        this.timers.delete(id);
        void this.flush(id).catch(() => logger.warn("Webhook dispatch state failed"));
      },
      Math.max(0, Math.min(2 ** 31 - 1, due - this.now())),
    );
    timer.unref?.();
    this.timers.set(id, timer);
  }
  private async flush(id: string) {
    if (this.active.has(id) || this.stopped) {
      return;
    }
    this.active.add(id);
    try {
      const window = await this.exclusive(async () => {
        const state = this.states[id];
        return state?.pending
          .filter((entry) => entry.dueAt <= this.now())
          .sort((a, b) => a.dueAt - b.dueAt)[0];
      });
      if (!window) {
        return;
      }
      const routine = this.routine(id);
      let outcome: WebhookDeliveryOutcome = "disabled";
      const expired =
        routine?.schedule.maxDeliveryAgeMinutes !== undefined &&
        this.now() - window.receivedAt > routine.schedule.maxDeliveryAgeMinutes * 60000;
      if (expired) {
        outcome = "expired";
      } else if (routine?.enabled) {
        try {
          const result = await this.dispatch(id, window.prompt);
          outcome = result.status === "ok" ? "accepted" : "dispatch_failed";
        } catch {
          // Do not put raw provider exceptions or payloads in the delivery log.
          logger.warn("Webhook routine dispatch failed");
          outcome = "dispatch_failed";
        }
      }
      await this.exclusive(async () => {
        const state = this.states[id];
        if (!state) {
          return;
        }
        state.pending = state.pending.filter((entry) => entry.deliveryId !== window.deliveryId);
        const delivery =
          state.deliveries.find((entry) => entry.id === window.deliveryId) ??
          state.deliveries.find((entry) => entry.id === window.latestDeliveryId);
        if (delivery) {
          delivery.outcome = outcome;
          this.bus.emit({ type: "job.delivery", delivery });
        }
        await this.save();
      });
    } finally {
      this.active.delete(id);
      this.arm(id);
    }
  }
}
