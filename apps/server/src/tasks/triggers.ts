import type { JobContext, JobResult } from "@passport/scheduler";
import { newId } from "@passport/store";
import {
  type AgentRunOptions,
  type AgentRuntime,
  formatMailAddress,
  type Task,
  toMailRow,
} from "@passport/types";
import { type DroppedCounts, droppedNotice } from "../arrival-backlog.js";
import type { ArrivalTrigger } from "../arrivals.js";
import { describeAgentRun, type TaskService } from "./service.js";
import { clip, neutralize, safeRow } from "./untrusted.js";

/**
 * System tasks that receive proactive work: one `inbox` task per mail account (arrival triage)
 * and one `routine` task per model-backed scheduler job.
 */
export class TaskTriggers {
  private readonly creating = new Map<string, Promise<Task>>();

  constructor(private readonly service: TaskService) {}

  ensureInbox(accountId: string): Promise<Task> {
    return this.once(`inbox:${accountId}`, async () => {
      const existing = await this.service.tasks.inboxFor(accountId);
      if (existing) {
        return existing;
      }
      const account = await this.service.options.store.accounts.get(accountId);
      const label = account?.displayName || account?.emailAddress || accountId;
      return this.insert({
        title: `Inbox · ${clip(neutralize(label), 50)}`,
        accountIds: [accountId],
        kind: "inbox",
      });
    });
  }

  ensureRoutine(jobId: string, name: string): Promise<Task> {
    return this.once(`routine:${jobId}`, async () => {
      const existing = await this.service.tasks.routineFor(jobId);
      if (existing) {
        return existing;
      }
      const accounts = await this.service.options.store.accounts.list();
      return this.insert({
        title: clip(name, 60),
        accountIds: accounts.map((account) => account.id),
        kind: "routine",
        jobId,
      });
    });
  }

  /** A notice on each account's inbox task for arrivals dropped before triage (R4-11, R4-12). */
  async reportDroppedArrivals(counts: DroppedCounts): Promise<void> {
    for (const [accountId, count] of Object.entries(counts)) {
      if (!(await this.service.options.store.accounts.get(accountId))) {
        continue;
      }
      const task = await this.ensureInbox(accountId);
      await this.service.runner.appendItem({
        taskId: task.id,
        runId: null,
        kind: "system_notice",
        at: this.service.now(),
        payload: { text: droppedNotice(count), code: "ARRIVALS_DROPPED" },
      });
    }
  }

  /** Wraps the agent the ArrivalQueue drives so each triage run lands on the account's inbox task. */
  arrivalAgent(agent: AgentRuntime): AgentRuntime {
    return {
      getUserProfile: () => agent.getUserProfile(),
      setUserProfile: (markdown) => agent.setUserProfile(markdown),
      run: async (trigger, options?: AgentRunOptions) => {
        if (trigger.kind !== "email.received") {
          return agent.run(trigger, options);
        }
        const email = await this.service.options.store.emails.get(trigger.emailId);
        if (!email) {
          return agent.run(trigger, options);
        }
        const task = await this.followDial(await this.ensureInbox(email.accountId));
        const agentRunId = (trigger as ArrivalTrigger).runId ?? `arrival:${email.id}`;
        const retry = await this.service.tasks.runs.byAgentRunId(agentRunId);
        const sender = email.from[0] ? formatMailAddress(email.from[0]) : "unknown sender";
        return this.service.runner.execute(
          {
            taskId: task.id,
            trigger: { kind: "arrival", emailId: email.id },
            priority: "background",
            agentRunId,
            cancellable: false,
            items: [
              retry
                ? { kind: "system_notice", payload: { text: "Retrying triage.", code: "RETRY" } }
                : {
                    kind: "notification",
                    untrusted: true,
                    payload: {
                      source: "arrival",
                      summary: clip(neutralize(`New mail from ${sender}: ${email.subject}`)),
                      row: safeRow(toMailRow(email)),
                    },
                  },
            ],
          },
          (runOptions) => agent.run(trigger, { ...options, ...runOptions }),
          describeAgentRun,
        );
      },
    };
  }

  /** `SchedulerOptions.runOnTask`: records a job run on its routine task. */
  async runJob(
    taskId: string,
    ctx: JobContext,
    run: (ctx: JobContext) => Promise<JobResult>,
  ): Promise<JobResult> {
    const found = await this.service.tasks.get(taskId);
    if (!found) {
      return run(ctx);
    }
    const task = await this.followDial(found);
    return this.service.runner.execute(
      {
        taskId,
        trigger: { kind: "schedule", jobId: ctx.jobId, name: task.title },
        priority: "background",
        cancellable: false,
      },
      (options) =>
        run({
          ...ctx,
          agentRunOptions: {
            ...options,
            signal: options.signal ? AbortSignal.any([options.signal, ctx.signal]) : ctx.signal,
          },
        }),
      (result) => ({
        summary: result.summary ?? null,
        error: result.status === "error" ? "JOB_FAILED" : null,
      }),
    );
  }

  /** System tasks follow the global trust dial unless the person pinned a mode. */
  private async followDial(task: Task): Promise<Task> {
    if (task.createdBy !== "system" || task.permissionModePinned) {
      return task;
    }
    const mode = await this.service.clampMode(undefined);
    return mode === task.permissionMode
      ? task
      : this.service.runner.updateTask(task.id, { permissionMode: mode });
  }

  private once(key: string, create: () => Promise<Task>): Promise<Task> {
    const pending = this.creating.get(key);
    if (pending) {
      return pending;
    }
    const job = create().finally(() => this.creating.delete(key));
    this.creating.set(key, job);
    return job;
  }

  private async insert(input: Pick<Task, "title" | "accountIds" | "kind"> & { jobId?: string }) {
    const now = this.service.now();
    const task = await this.service.tasks.insert({
      id: newId(),
      ...input,
      status: "inbox",
      pinned: false,
      permissionMode: await this.service.clampMode(undefined),
      interactionMode: "default",
      createdBy: "system",
      needsUser: null,
      lastActivityAt: now,
      createdAt: now,
      watches: [],
      pendingActionIds: [],
    });
    this.service.options.bus.emit({ type: "task.updated", task });
    return task;
  }
}
