import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
import { exceedsWebhookDepth, WEBHOOK_SECRET_KEY } from "./webhook-request.js";

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
  status: 202 | 200 | 400 | 401 | 410 | 429;
}
const KEY = "scheduler:webhooks";
const INDEX_KEY = KEY + ":index";
const REPLAY_MS = 7 * 86400_000;
export const MAX_PENDING_PER_ROUTINE = 10;
export const MAX_PENDING_GLOBAL = 100;
const PREVIEW_CHARS = 2048;
// The shared outcome union is owned by the types stream; keep the wire addition local here.
const REJECTED = "rejected" as WebhookDeliveryOutcome;

/** Durable intake queue. Mutations serialize; dispatch never holds the intake lock. */
export class RoutineWebhooks {
  private states: Record<string, HookState> = {};
  private queue: Promise<unknown> = Promise.resolve();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private active = new Set<string>();
  private pendingCount = 0;
  private tokens = new Map<string, { id: string; digest: Buffer }>();
  private unknownSources = new Map<string, { minute: number; count: number }>();
  private stopped = false;
  constructor(
    private store: Store,
    private bus: EventBus,
    private routine: (id: string) => HookRoutine | undefined,
    private dispatch: (id: string, prompt: string) => Promise<JobRun>,
    private now = () => Date.now(),
  ) {}
  async load() {
    const index = await this.store.kv.get(INDEX_KEY);
    if (index) {
      for (const id of JSON.parse(index) as string[]) {
        const saved = await this.store.kv.get(KEY + ":" + id);
        if (saved) {
          this.states[id] = JSON.parse(saved);
        }
      }
    } else {
      // Migrate the old shared record once, preserving accepted work and replay state.
      const legacy = await this.store.kv.get(KEY);
      this.states = legacy ? JSON.parse(legacy) : {};
      for (const id of Object.keys(this.states)) {
        this.states[id]!.deliveries = this.states[id]!.deliveries.map((delivery) => ({
          ...delivery,
          ...(delivery.prompt === undefined
            ? {}
            : { prompt: delivery.prompt.slice(0, PREVIEW_CHARS) }),
        }));
        await this.save(id);
      }
      await this.saveIndex();
    }
    await this.store.kv.delete(KEY);
    this.pendingCount = Object.values(this.states).reduce(
      (total, state) => total + state.pending.length,
      0,
    );
    for (const [id, state] of Object.entries(this.states)) {
      this.indexToken(id, state.token);
    }
  }
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run);
    this.queue = result.catch((error) => {
      if (!(error instanceof ApiError)) {
        logger.warn("Webhook state update failed");
      }
    });
    return result;
  }
  private save(id: string) {
    return this.store.kv.set(KEY + ":" + id, JSON.stringify(this.states[id]));
  }
  private saveIndex() {
    return this.store.kv.set(INDEX_KEY, JSON.stringify(Object.keys(this.states)));
  }
  private indexToken(id: string, token: string) {
    const digest = createHash("sha256").update(token).digest();
    this.tokens.set(digest.toString("hex"), { id, digest });
  }
  private findToken(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) {
      return undefined;
    }
    const digest = createHash("sha256").update(token).digest();
    const entry = this.tokens.get(digest.toString("hex"));
    // Compare fixed-size fingerprints without a token-dependent string comparison.
    return timingSafeEqual(digest, entry?.digest ?? Buffer.alloc(32)) ? entry?.id : undefined;
  }
  /** Resolve capability URLs before reading a body; peer addresses never come from headers. */
  authorize(token: string, source: string): 404 | 429 | undefined {
    const id = this.findToken(token);
    if (id && this.routine(id)) {
      return undefined;
    }
    const minute = Math.floor(this.now() / 60000);
    for (const [key, bucket] of this.unknownSources) {
      if (bucket.minute !== minute) {
        this.unknownSources.delete(key);
      }
    }
    // Bound the address map too; excess sources share one overflow bucket.
    const key =
      this.unknownSources.has(source) || this.unknownSources.size < 1024 ? source : "overflow";
    const bucket = this.unknownSources.get(key) ?? { minute, count: 0 };
    bucket.count++;
    this.unknownSources.set(key, bucket);
    // Expected misses are silent, including during a flood.
    return bucket.count > 60 ? 429 : 404;
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
        await this.save(id);
        await this.saveIndex();
        this.indexToken(id, this.states[id]!.token);
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
      const old = state.token;
      state.token = randomBytes(32).toString("hex");
      await this.save(id);
      this.tokens.delete(createHash("sha256").update(old).digest("hex"));
      this.indexToken(id, state.token);
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
      this.pendingCount -= this.states[id]?.pending.length ?? 0;
      const token = this.states[id]?.token;
      if (token) {
        this.tokens.delete(createHash("sha256").update(token).digest("hex"));
      }
      delete this.states[id];
      await this.saveIndex();
      await this.store.kv.delete(KEY + ":" + id);
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
      ...(prompt === undefined ? {} : { prompt: prompt.slice(0, PREVIEW_CHARS) }),
    };
    state.deliveries = [...state.deliveries, delivery].slice(-50);
    this.bus.emit({ type: "job.delivery", delivery });
    return delivery;
  }
  async receive(token: string, raw: Uint8Array, request: WebhookRequest): Promise<HookResult> {
    const id = this.findToken(token);
    if (!id) {
      throw new ApiError("NOT_FOUND", "Webhook not found", 404);
    }
    const result = await this.exclusive(async (): Promise<HookResult> => {
      const state = this.states[id];
      if (!state || this.findToken(token) !== id) {
        throw new ApiError("NOT_FOUND", "Webhook not found", 404);
      }
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
        await this.save(id);
        return { outcome, status };
      };
      const minute = Math.floor(this.now() / 60000);
      if (state.rate.minute !== minute) {
        state.rate = { minute, deliveries: 0, updates: 0, requests: 0, rejected: 0 };
      }
      if (!routine.enabled) {
        if (state.rate.rejected >= 10) {
          return reject("rate_limited", 429);
        }
        return reject("disabled", 410);
      }
      const schedule = routine.schedule;
      if (schedule.signature) {
        const secret = await this.store.encryptedKv?.get("webhook-signature:" + id);
        if (!secret || !verifyWebhookSignature(raw, request.headers, schedule.signature, secret)) {
          if (state.rate.rejected >= 10) {
            return reject("rate_limited", 429);
          }
          return reject("rejected_signature", 401);
        }
      }
      // Invalid signatures have a separate budget and cannot spend valid intake capacity.
      state.rate.requests = (state.rate.requests ?? 0) + 1;
      if (state.rate.requests > 70) {
        return reject("rate_limited", 429);
      }
      if (exceedsWebhookDepth(request.body)) {
        return reject(REJECTED, 400);
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
          return reject("expired", 200);
        }
      }
      if (!matchesWebhookFilters(request, schedule.filters)) {
        return reject("filtered", 200);
      }
      state.replay = Object.fromEntries(
        Object.entries(state.replay).filter(([, at]) => this.now() - at < REPLAY_MS),
      );
      const replay = webhookKey(schedule.dedupe?.replayKey, request);
      if (replay && state.replay[replay] !== undefined) {
        return reject("duplicate", 200);
      }
      const key = webhookKey(schedule.dedupe?.coalesceKey, request);
      const pending = key
        ? state.pending.find((window) => window.key === key && window.dueAt > this.now())
        : undefined;
      if (pending ? state.rate.updates >= 60 : state.rate.deliveries >= 10) {
        return reject("rate_limited", 429);
      }
      if (
        !pending &&
        (state.pending.length >= MAX_PENDING_PER_ROUTINE || this.pendingCount >= MAX_PENDING_GLOBAL)
      ) {
        return reject("rate_limited", 429);
      }
      // The agent sees a scrubbed request, never bearer/cookie credentials.
      const safe = structuredClone(request);
      for (const header of Object.keys(safe.headers)) {
        if (
          WEBHOOK_SECRET_KEY.test(header) ||
          header.toLowerCase() === schedule.signature?.header.toLowerCase()
        ) {
          delete safe.headers[header];
        }
      }
      for (const key of Object.keys(safe.query)) {
        if (WEBHOOK_SECRET_KEY.test(key)) {
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
        this.pendingCount++;
      }
      await this.save(id);
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
        const remaining = state.pending.filter((entry) => entry.deliveryId !== window.deliveryId);
        this.pendingCount -= state.pending.length - remaining.length;
        state.pending = remaining;
        const delivery =
          state.deliveries.find((entry) => entry.id === window.deliveryId) ??
          state.deliveries.find((entry) => entry.id === window.latestDeliveryId);
        if (delivery) {
          delivery.outcome = outcome;
          this.bus.emit({ type: "job.delivery", delivery });
        }
        await this.save(id);
      });
    } finally {
      this.active.delete(id);
      this.arm(id);
    }
  }
}
