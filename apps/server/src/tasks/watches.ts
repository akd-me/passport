import {
  type AgentRuntime,
  type ConversationWatch,
  type Email,
  formatMailAddress,
  parseMailHandle,
  TASK_LIMITS,
  type Task,
  toMailRow,
} from "@passport/types";
import { logger } from "../logger.js";
import { arrivalContext } from "../watch/arrival.js";
import { describeAgentRun, type TaskService } from "./service.js";
import { idleStatus } from "./status.js";
import { clip, frameUntrusted, neutralize, safeRow } from "./untrusted.js";

export type WakeKind = "reply" | "bounce" | "auto_reply";

const BOUNCE_FROM = /^(mailer-daemon|postmaster)@/i;
const BOUNCE_SUBJECT =
  /undeliver|delivery status notification|delivery (has )?failed|mail delivery (failed|subsystem)|returned mail/i;
const AUTO_SUBJECT =
  /^(automatic reply|auto(matic)?[- ]?(reply|response)|out of (the )?office|autoreply|abwesenheit|r[ée]ponse automatique)/i;

/** Bounce and auto-reply detection from headers first, then sender and subject conventions. */
export function classifyWake(email: Email): WakeKind {
  const headers = Object.fromEntries(
    Object.entries(email.headers.extra ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value.toLowerCase(),
    ]),
  );
  if (email.from.some((a) => BOUNCE_FROM.test(a.email)) || BOUNCE_SUBJECT.test(email.subject)) {
    return "bounce";
  }
  const auto = headers["auto-submitted"];
  if (
    (auto && auto !== "no") ||
    headers["x-autoreply"] ||
    headers["x-autorespond"] ||
    /^(auto_reply|auto-reply)$/.test(headers.precedence ?? "") ||
    AUTO_SUBJECT.test(email.subject.trim())
  ) {
    return "auto_reply";
  }
  return "reply";
}

function sameThread(watch: ConversationWatch, email: Email): boolean {
  if (email.accountId !== watch.account) {
    return false;
  }
  if (email.threadId === watch.threadHandle) {
    return true;
  }
  const a = parseMailHandle(watch.threadHandle);
  const b = parseMailHandle(email.threadId);
  return !!a && !!b && a.type === "thread" && b.type === "thread" && a.providerId === b.providerId;
}

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  email: Email;
  kind: WakeKind;
}

const LABEL: Record<WakeKind, string> = {
  reply: "New reply",
  bounce: "Bounce",
  auto_reply: "Automatic reply",
};

/**
 * `watch_conversation` monitor. The new-mail watcher reports added messages; a message on a
 * watched thread received after the watch began, not from the person, wakes the task in the
 * background lane. Replay key: RFC 822 Message-ID (7 days). Coalesce: one wake per thread per
 * 120 s with the latest message. Loop guard: 3 auto-reply or no-op wakes in a row stop the watch.
 */
export class TaskWatchMonitor {
  private readonly pending = new Map<string, Pending>();
  private readonly runs = new Set<Promise<unknown>>();
  private closed = false;

  constructor(
    private readonly service: TaskService,
    private readonly agent: AgentRuntime,
    private readonly coalesceMs: number = TASK_LIMITS.watchCoalesceMs,
  ) {}

  async observe(accountId: string, emails: Email[]): Promise<void> {
    if (this.closed || !emails.length) {
      return;
    }
    const tasks = (await this.service.tasks.watching()).filter((task) =>
      task.watches.some((watch) => watch.account === accountId),
    );
    if (!tasks.length) {
      return;
    }
    const { self } = await arrivalContext(this.service.options.store, accountId, []);
    for (const email of emails) {
      if (email.from.some((address) => self.has(address.email.trim().toLowerCase()))) {
        continue;
      }
      for (const task of tasks) {
        const watch = task.watches.find((item) => sameThread(item, email));
        if (!watch || Date.parse(email.receivedAt) <= Date.parse(watch.since)) {
          continue;
        }
        if (!(await this.firstSighting(task.id, email.headers.messageId ?? email.id))) {
          continue;
        }
        this.coalesce(task.id, watch.threadHandle, email, classifyWake(email));
      }
    }
  }

  /** Fires every pending coalesced wake now (shutdown, tests). */
  async flush(): Promise<void> {
    for (const [key, entry] of [...this.pending]) {
      clearTimeout(entry.timer);
      this.pending.delete(key);
      this.track(this.fire(key, entry));
    }
    while (this.runs.size) {
      await Promise.allSettled([...this.runs]);
    }
  }

  close(): void {
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
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
      this.track(
        this.wake(task, {
          trigger: { kind: "wake", reason: "watch_expired" },
          summary,
          instruction: `${summary} Conversation handles: ${old.map((w) => w.threadHandle).join(", ")}. Decide whether to follow up (watch again after sending) or hand the task back to the person.`,
        }),
      );
    }
    return expired;
  }

  private coalesce(taskId: string, threadHandle: string, email: Email, kind: WakeKind) {
    const key = `${taskId}\n${threadHandle}`;
    const existing = this.pending.get(key);
    if (existing) {
      existing.email = email;
      existing.kind = kind;
      return;
    }
    const entry: Pending = {
      email,
      kind,
      timer: setTimeout(() => {
        this.pending.delete(key);
        this.track(this.fire(key, entry));
      }, this.coalesceMs),
    };
    entry.timer.unref?.();
    this.pending.set(key, entry);
  }

  private track(job: Promise<unknown>) {
    const settled = job.catch(() => {
      // A failed wake is on the task timeline; the watcher tick must not fail.
      logger.warn("Conversation watch wake failed");
    });
    this.runs.add(settled);
    void settled.finally(() => this.runs.delete(settled));
  }

  private async fire(key: string, { email, kind }: Pending) {
    const [taskId, threadHandle] = key.split("\n") as [string, string];
    const task = await this.service.tasks.get(taskId);
    const watch = task?.watches.find((item) => item.threadHandle === threadHandle);
    if (!task || !watch) {
      return;
    }
    const strikes = kind === "auto_reply" ? watch.consecutiveWakes + 1 : 0;
    if (strikes >= TASK_LIMITS.watchLoopLimit) {
      await this.stopWatch(task.id, threadHandle, "three automatic replies in a row");
      return;
    }
    await this.setWatch(task.id, threadHandle, {
      consecutiveWakes: strikes,
      lastWakeAt: this.service.now(),
    });
    const sender = email.from[0] ? formatMailAddress(email.from[0]) : "unknown sender";
    const summary = clip(neutralize(`${LABEL[kind]} from ${sender}: ${email.subject}`));
    const row = safeRow(toMailRow(email));
    const run = await this.wake(task, {
      trigger: { kind: "watch", threadHandle, emailId: email.id },
      summary,
      row,
      emailIds: [email.id],
      instruction: [
        `A conversation this task watches changed (${LABEL[kind].toLowerCase()}).`,
        frameUntrusted("mail", JSON.stringify(row)),
        `Read it with mail_read if you need more. Decide whether the person needs to act. When the conversation no longer needs watching, call unwatch_conversation with threadHandle "${threadHandle}".`,
      ].join("\n\n"),
    });
    if (run && !run.actionIds.length) {
      // A wake that changed nothing counts toward the loop guard.
      const current = (await this.service.tasks.get(task.id))?.watches.find(
        (w) => w.threadHandle === threadHandle,
      );
      if (current && current.consecutiveWakes + 1 >= TASK_LIMITS.watchLoopLimit) {
        await this.stopWatch(task.id, threadHandle, "three wakes in a row changed nothing");
      } else if (current) {
        await this.setWatch(task.id, threadHandle, {
          consecutiveWakes: current.consecutiveWakes + 1,
        });
      }
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
    },
  ) {
    return this.service.runner.execute(
      {
        taskId: task.id,
        trigger: input.trigger,
        priority: "background",
        cancellable: true,
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
      async (options) =>
        this.agent.run(
          {
            kind: "manual",
            instruction: `You are working on the task "${task.title}" (task id ${task.id}).\n\n${input.instruction}`,
            ...(input.emailIds ? { emailIds: input.emailIds } : {}),
          },
          { ...options, priority: "background" },
        ),
      describeAgentRun,
    );
  }

  private async setWatch(taskId: string, threadHandle: string, patch: Partial<ConversationWatch>) {
    await this.service.runner.updateTask(taskId, (task) => ({
      watches: task.watches.map((w) => (w.threadHandle === threadHandle ? { ...w, ...patch } : w)),
    }));
  }

  private async stopWatch(taskId: string, threadHandle: string, why: string) {
    const task = await this.service.runner.updateTask(taskId, (current) => {
      const watches = current.watches.filter((w) => w.threadHandle !== threadHandle);
      const idle = current.status === "working" && !this.service.runner.activeRuns(taskId).length;
      return { watches, ...(idle ? { status: idleStatus({ watches }) } : {}) };
    });
    await this.service.runner.appendItem({
      taskId: task.id,
      runId: null,
      kind: "system_notice",
      at: this.service.now(),
      payload: { text: `Stopped watching a conversation: ${why}.`, code: "WATCH_LOOP_GUARD" },
    });
  }

  /** Replay key memory per task (kv), pruned to the last 7 days. */
  private async firstSighting(taskId: string, key: string): Promise<boolean> {
    const kvKey = `task-watch-seen:${taskId}`;
    const now = Date.parse(this.service.now());
    const seen: Record<string, string> = JSON.parse(
      (await this.service.options.store.kv.get(kvKey)) ?? "{}",
    );
    for (const [entry, at] of Object.entries(seen)) {
      if (now - Date.parse(at) > TASK_LIMITS.watchReplayMs) {
        delete seen[entry];
      }
    }
    const fresh = !seen[key];
    seen[key] = new Date(now).toISOString();
    await this.service.options.store.kv.set(kvKey, JSON.stringify(seen));
    return fresh;
  }
}
