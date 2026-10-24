import {
  type ActionType,
  type AgentRun,
  type AgentRuntime,
  type ConversationWatch,
  type Email,
  TASK_LIMITS,
  type Task,
  toMailRow,
} from "@passport/types";
import { logger } from "../logger.js";
import { arrivalContext } from "../watch/arrival.js";
import { describeAgentRun, type TaskService } from "./service.js";
import { hidden, surface } from "./status.js";
import { clip, frameUntrusted, neutralize, safeRow, taskLabel } from "./untrusted.js";
import { classifyWake, quoteHandle, sameThread, WAKE_LABEL } from "./watch-classify.js";
import { type PendingWake, PendingWakes, pendingKey, SeenKeys } from "./watch-pending.js";

export { classifyWake, type WakeKind } from "./watch-classify.js";

/** Outward-facing actions: one executed without the person deciding may answer an autoresponder. */
const OUTBOUND = new Set<ActionType>(["send", "calendar_propose", "calendar_respond"]);
const LOOP_REASON =
  "three wakes in a row were automatic replies or bounces, changed nothing, or only sent mail without your approval";

interface Armed {
  wake: PendingWake;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * `watch_conversation` monitor. The new-mail watcher reports added messages; a message on a
 * watched thread received after the watch began, not from the person, wakes the task in the
 * background lane. Replay key: RFC 822 Message-ID (7 days), recorded once the wake's run exists.
 * Coalesce: one wake per thread per 120 s with the latest message; pending wakes are persisted
 * (kv `task-watch-pending`) and re-armed after a restart. Loop guard: see `countWake`.
 */
export class TaskWatchMonitor {
  private readonly pending = new Map<string, Armed>();
  private readonly runs = new Set<Promise<unknown>>();
  private readonly observing = new Set<Promise<unknown>>();
  private readonly saved: PendingWakes;
  private readonly seenKeys: SeenKeys;
  private resumed?: Promise<void>;
  private closed = false;

  constructor(
    private readonly service: TaskService,
    private readonly agent: AgentRuntime,
    private readonly coalesceMs: number = TASK_LIMITS.watchCoalesceMs,
  ) {
    this.saved = new PendingWakes(service.options.store.kv);
    this.seenKeys = new SeenKeys(service.options.store.kv, service.now);
  }

  /** Re-arms the wakes a previous process persisted (idempotent). */
  resume(): Promise<void> {
    this.resumed ??= (async () => {
      for (const wake of await this.saved.all()) {
        const key = pendingKey(wake.taskId, wake.threadHandle);
        if (!this.pending.has(key)) {
          this.arm(key, wake);
        }
      }
    })().catch(() => {
      logger.warn("Pending conversation watch wakes could not be restored");
    });
    return this.resumed;
  }

  async observe(accountId: string, emails: Email[]): Promise<void> {
    if (this.closed || !emails.length) {
      return;
    }
    await this.resume();
    const tasks = (await this.service.tasks.watching()).filter((task) =>
      task.watches.some((watch) => watch.account === accountId),
    );
    if (!tasks.length) {
      return;
    }
    const ctx = await arrivalContext(this.service.options.store, accountId, []);
    for (const email of emails) {
      if (email.from.some((address) => ctx.self.has(address.email.trim().toLowerCase()))) {
        continue;
      }
      // The person's own copy in Sent or Drafts (e.g. sent from an alias) is not a reply.
      const roles = email.mailboxIds.map((id) => ctx.roleOf(id));
      if (roles.includes("sent") || roles.includes("drafts")) {
        continue;
      }
      for (const task of tasks) {
        const watch = task.watches.find((item) => sameThread(item, email));
        if (!watch || Date.parse(email.receivedAt) <= Date.parse(watch.since)) {
          continue;
        }
        const replayKey = email.headers.messageId ?? email.id;
        if (await this.seen(task.id, replayKey)) {
          continue;
        }
        await this.coalesce(task.id, watch.threadHandle, email, replayKey);
      }
    }
  }

  /** The watcher hook: matches in the background; `flush` waits for it. */
  observeLater(accountId: string, emails: Email[]): void {
    const job = this.observe(accountId, emails).catch(() => {
      // Watch matching is best effort per tick; the arrival path is unaffected.
      logger.warn("Conversation watch matching failed");
    });
    this.observing.add(job);
    void job.finally(() => this.observing.delete(job));
  }

  /** Fires every pending coalesced wake now (tests), after in-flight matching. */
  async flush(): Promise<void> {
    await this.resume();
    await this.matched();
    for (const [key, entry] of [...this.pending]) {
      this.disarm(key, entry);
      this.track(this.fire(key, entry.wake));
    }
    await this.idle();
  }

  /**
   * Stops matching and the coalesce timers. Pending wakes stay persisted, so the next process
   * fires them; call before draining the agent lanes so no wake starts during shutdown.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.matched();
    for (const [key, entry] of [...this.pending]) {
      this.disarm(key, entry);
    }
    await this.saved.settled();
  }

  /** Resolves once every wake already firing has finished its run. */
  async idle(): Promise<void> {
    while (this.runs.size) {
      await Promise.allSettled([...this.runs]);
    }
  }

  /** Watches older than 14 days end with one wake so the task can follow up or hand back. */
  async expire(): Promise<number> {
    const cutoff = Date.parse(this.service.now()) - TASK_LIMITS.watchMaxAgeMs;
    let expired = 0;
    for (const task of await this.service.tasks.watching()) {
      const old = task.watches.filter((watch) => Date.parse(watch.since) < cutoff);
      if (!old.length) {
        continue;
      }
      expired += old.length;
      await this.service.runner.updateTask(task.id, (current) => ({
        watches: current.watches.filter(
          (watch) => !old.some((o) => o.threadHandle === watch.threadHandle),
        ),
      }));
      const summary = `No reply after 14 days on ${old.length === 1 ? "a watched conversation" : `${old.length} watched conversations`}; the watch ended.`;
      await this.service.runner.appendItem({
        taskId: task.id,
        runId: null,
        kind: "system_notice",
        at: this.service.now(),
        payload: { text: summary, code: "WATCH_EXPIRED" },
      });
      this.track(
        this.wake(task, {
          trigger: { kind: "wake", reason: "watch_expired" },
          summary,
          instruction: `${summary} Conversation handles: ${old.map((w) => quoteHandle(w.threadHandle)).join(", ")}. Decide whether to follow up (watch again after sending) or hand the task back to the person.`,
        }),
      );
    }
    return expired;
  }

  private async matched() {
    while (this.observing.size) {
      await Promise.allSettled([...this.observing]);
    }
  }

  /** Seen for this task in the last 7 days, or already waiting in a pending wake. */
  private async seen(taskId: string, replayKey: string): Promise<boolean> {
    for (const { wake } of this.pending.values()) {
      if (wake.taskId === taskId && wake.keys.includes(replayKey)) {
        return true;
      }
    }
    return this.seenKeys.has(taskId, replayKey);
  }

  private async coalesce(taskId: string, threadHandle: string, email: Email, replayKey: string) {
    const key = pendingKey(taskId, threadHandle);
    const existing = this.pending.get(key);
    const wake: PendingWake = {
      taskId,
      threadHandle,
      emailId: email.id,
      row: toMailRow(email),
      kind: classifyWake(email),
      due: existing?.wake.due ?? Date.now() + this.coalesceMs,
      keys: [...new Set([...(existing?.wake.keys ?? []), replayKey])],
    };
    if (existing) {
      existing.wake = wake;
    } else {
      this.arm(key, wake);
    }
    await this.saved.put(wake);
  }

  private arm(key: string, wake: PendingWake) {
    const entry: Armed = { wake, timer: null };
    this.pending.set(key, entry);
    if (this.closed) {
      return;
    }
    entry.timer = setTimeout(
      () => {
        this.pending.delete(key);
        this.track(this.fire(key, entry.wake));
      },
      Math.max(0, wake.due - Date.now()),
    );
    entry.timer.unref?.();
  }

  private disarm(key: string, entry: Armed) {
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    this.pending.delete(key);
  }

  private track(job: Promise<unknown>) {
    const settled = job.catch(() => {
      // A failed wake is on the task timeline; the watcher tick must not fail.
      logger.warn("Conversation watch wake failed");
    });
    this.runs.add(settled);
    void settled.finally(() => this.runs.delete(settled));
  }

  /** The wake's run exists: its messages are seen and the pending entry is done. */
  private async consume(key: string, wake: PendingWake) {
    await this.seenKeys.add(wake.taskId, wake.keys);
    await this.saved.remove(key);
  }

  private async fire(key: string, wake: PendingWake) {
    const { threadHandle } = wake;
    const task = await this.service.tasks.get(wake.taskId);
    const watch = task?.watches.find((item) => item.threadHandle === threadHandle);
    if (!task || !watch) {
      await this.consume(key, wake);
      return;
    }
    if (wake.kind !== "reply" && watch.consecutiveWakes + 1 >= TASK_LIMITS.watchLoopLimit) {
      // A third automatic message in a row stops the watch without running the agent.
      await this.consume(key, wake);
      await this.stopWatch(task.id, threadHandle, LOOP_REASON);
      return;
    }
    await this.setWatch(task.id, threadHandle, { lastWakeAt: this.service.now() });
    const label = WAKE_LABEL[wake.kind];
    const row = safeRow(wake.row);
    const summary = clip(neutralize(`${label} from ${wake.row.from}: ${wake.row.subject}`));
    let consumed: Promise<void> | undefined;
    let run: AgentRun | undefined;
    try {
      run = await this.wake(task, {
        trigger: { kind: "watch", threadHandle, emailId: wake.emailId },
        summary,
        row,
        emailIds: [wake.emailId],
        onCreated: () => {
          consumed = this.consume(key, wake);
        },
        instruction: [
          `A conversation this task watches changed (${label.toLowerCase()}).`,
          frameUntrusted("mail", JSON.stringify(row)),
          `Read it with mail_read if you need more. Decide whether the person needs to act. When the conversation no longer needs watching, call unwatch_conversation with threadHandle ${quoteHandle(threadHandle)}.`,
        ].join("\n\n"),
      });
    } catch {
      logger.warn("Conversation watch wake failed");
    } finally {
      await consumed;
    }
    if (consumed) {
      await this.countWake(task.id, wake, run);
    }
  }

  /**
   * Loop guard, counted once per wake after its run. A wake is a strike when it was an automatic
   * reply or bounce, when its run created no ActionRecords (or failed), or when the run sent
   * mail that nobody approved (an autoresponder answering the agent's own reply looks like a
   * real reply). A real reply whose run did something else, or asked the person, resets the
   * count. Three strikes in a row stop the watch and hand the task back.
   */
  private async countWake(taskId: string, wake: PendingWake, run: AgentRun | undefined) {
    const actions = [];
    for (const id of run?.actionIds ?? []) {
      const action = await this.service.options.store.actions.get(id);
      if (action) {
        actions.push(action);
      }
    }
    const unattended = actions.some(
      (a) => OUTBOUND.has(a.request.type) && a.decision.outcome !== "ask",
    );
    const strike = wake.kind !== "reply" || !run || !actions.length || unattended;
    const current = (await this.service.tasks.get(taskId))?.watches.find(
      (w) => w.threadHandle === wake.threadHandle,
    );
    if (!current) {
      return;
    }
    const count = strike ? current.consecutiveWakes + 1 : 0;
    if (count >= TASK_LIMITS.watchLoopLimit) {
      await this.stopWatch(taskId, wake.threadHandle, LOOP_REASON);
    } else {
      await this.setWatch(taskId, wake.threadHandle, { consecutiveWakes: count });
    }
  }

  private wake(
    task: Task,
    input: {
      trigger:
        | { kind: "watch"; threadHandle: string; emailId: string }
        | { kind: "wake"; reason: string };
      summary: string;
      instruction: string;
      row?: ReturnType<typeof safeRow>;
      emailIds?: string[];
      onCreated?: () => void;
    },
  ) {
    return this.service.runner.execute(
      {
        taskId: task.id,
        trigger: input.trigger,
        priority: "background",
        cancellable: true,
        ...(input.onCreated ? { onCreated: input.onCreated } : {}),
        items: [
          {
            kind: "notification",
            untrusted: true,
            payload: {
              source: "watch",
              summary: input.summary,
              ...(input.row ? { row: input.row } : {}),
            },
          },
        ],
      },
      async (options) => {
        const instruction = `You are working on ${taskLabel(task)}.\n\n${input.instruction}`;
        return this.agent.run(
          { kind: "manual", instruction, ...(input.emailIds ? { emailIds: input.emailIds } : {}) },
          {
            ...options,
            priority: "background",
            session: this.service.sessionOptions(task.id, { instruction }),
          },
        );
      },
      describeAgentRun,
    );
  }

  private async setWatch(taskId: string, threadHandle: string, patch: Partial<ConversationWatch>) {
    await this.service.runner.updateTask(taskId, (task) => ({
      watches: task.watches.map((w) => (w.threadHandle === threadHandle ? { ...w, ...patch } : w)),
    }));
  }

  /** Ends a watch and surfaces the task so the notice is seen before auto-settle (R4-10). */
  private async stopWatch(taskId: string, threadHandle: string, why: string) {
    const now = this.service.now();
    const task = await this.service.runner.updateTask(taskId, (current) => {
      const watches = current.watches.filter((w) => w.threadHandle !== threadHandle);
      if (current.status === "settled" || hidden(current.status)) {
        return { watches };
      }
      if (this.service.runner.activeRuns(taskId).length) {
        return { watches, needsUser: "failure" as const, lastActivityAt: now };
      }
      return { watches, ...surface("failure", now) };
    });
    await this.service.runner.appendItem({
      taskId: task.id,
      runId: null,
      kind: "system_notice",
      at: now,
      payload: { text: `Stopped watching a conversation: ${why}.`, code: "WATCH_LOOP_GUARD" },
    });
  }
}
