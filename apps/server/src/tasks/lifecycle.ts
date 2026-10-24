import type { Task, TaskRestoreState, TaskStatus, TaskWithPrevious } from "@passport/types";
import type { TaskQueueService } from "./queue.js";
import type { TaskService } from "./service.js";
import { resolveTaskStatus } from "./status.js";

function restoreState(task: Task): TaskRestoreState {
  return {
    status: task.status,
    snoozedUntil: task.snoozedUntil ?? null,
    settledAt: task.settledAt ?? null,
  };
}

/**
 * The person's lifecycle actions (v0.4): seen and mark-unread, settle, snooze and archive that
 * answer with the state they replaced (`previous`, for undo), and the reopen routes. Settle and
 * archive hold the follow-up queue first, so the runs they stop do not start the next message.
 */
export class TaskLifecycle {
  constructor(
    private readonly service: TaskService,
    private readonly queue: TaskQueueService,
  ) {}

  /** `POST /api/tasks/:id/seen`: clears the Done or Woke badge. */
  async seen(id: string): Promise<Task> {
    await this.service.task(id);
    return this.service.runner.updateTask(id, { seenAt: this.service.now(), unseenOutcome: null });
  }

  /** `POST /api/tasks/:id/mark-unread`: brings the badge back (`done` when there was none). */
  async markUnread(id: string): Promise<Task> {
    await this.service.task(id);
    return this.service.runner.updateTask(id, (task) => ({
      seenAt: null,
      unseenOutcome: task.unseenOutcome ?? "done",
    }));
  }

  settle(id: string): Promise<TaskWithPrevious> {
    return this.change(id, async () => {
      await this.queue.hold(id);
      return this.service.settle(id);
    });
  }

  archive(id: string): Promise<TaskWithPrevious> {
    return this.change(id, async () => {
      await this.queue.hold(id);
      return this.service.archive(id);
    });
  }

  snooze(id: string, until: string): Promise<TaskWithPrevious> {
    return this.change(id, () => this.service.snooze(id, until));
  }

  unsettle(id: string): Promise<TaskWithPrevious> {
    return this.reopen(id, "settled");
  }

  unsnooze(id: string): Promise<TaskWithPrevious> {
    return this.reopen(id, "snoozed");
  }

  unarchive(id: string): Promise<TaskWithPrevious> {
    return this.reopen(id, "archived");
  }

  private async change(id: string, apply: () => Promise<Task>): Promise<TaskWithPrevious> {
    const previous = restoreState(await this.service.task(id));
    return { ...(await apply()), previous };
  }

  /**
   * Back to where the task rests now (Working while a run is active or it watches, else the
   * inbox) with a fresh `returnedAt`. A task not in `from` is returned unchanged, so a repeated
   * undo is harmless. Watches that settle or archive ended stay ended; a held queue stays held.
   */
  private async reopen(id: string, from: TaskStatus): Promise<TaskWithPrevious> {
    const task = await this.service.task(id);
    if (task.status !== from) {
      return { ...task, previous: restoreState(task) };
    }
    return this.change(id, () =>
      this.service.runner.updateTask(id, (current) =>
        current.status === from
          ? resolveTaskStatus(current, {
              kind: "reopened",
              activeRuns: this.service.runner.activeRuns(id).length,
              now: this.service.now(),
            })
          : {},
      ),
    );
  }
}
