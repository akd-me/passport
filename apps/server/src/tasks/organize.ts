import {
  type Task,
  type TaskOrganizeInput,
  type TaskOrganizeResult,
  type TaskToolCaller,
  taskTitleFrom,
} from "@passport/types";
import { ApiError } from "../errors.js";
import type { TaskLifecycle } from "./lifecycle.js";
import type { TaskService } from "./service.js";
import { clip, neutralize } from "./untrusted.js";

/**
 * `task_organize` (T3 `t3_thread_organize`): the agent files its own task. Everything applies
 * now except settle, which is recorded as `settleRequested` and applied by the status rules
 * when the run ends (`resolveTaskStatus`), unless something then waits on the person. The agent
 * never overrides the person (R1-36): no snooze or unsnooze of a settled or archived task or of
 * the person's snooze, and no rename of a title the person chose (`PERSON_CHOICE`).
 */
export class TaskOrganizer {
  /** Snoozes the agent set, by task (`snoozedUntil`); after a restart a snooze counts as the person's. */
  private readonly snoozes = new Map<string, string>();

  constructor(
    private readonly service: TaskService,
    private readonly lifecycle: TaskLifecycle,
  ) {}

  async organize(caller: TaskToolCaller, input: TaskOrganizeInput): Promise<TaskOrganizeResult> {
    const current = await this.service.task(caller.taskId);
    const id = current.id;
    let task: Task;
    let applies: TaskOrganizeResult["applies"] = "now";
    switch (input.action) {
      case "snooze":
        this.assertSnoozable(current);
        task = await this.lifecycle.snooze(id, input.until ?? "");
        if (task.snoozedUntil) {
          this.snoozes.set(id, task.snoozedUntil);
        }
        break;
      case "unsnooze":
        this.assertSnoozable(current);
        task = await this.lifecycle.unsnooze(id);
        this.snoozes.delete(id);
        break;
      case "settle":
        applies = "run_end";
        task = await this.service.runner.updateTask(id, (current) =>
          current.status === "settled" || current.status === "archived"
            ? {}
            : { settleRequested: true },
        );
        break;
      case "pin":
      case "unpin":
        task = await this.service.pin(id, input.action === "pin");
        break;
      case "rename":
        if (await this.personNamed(current)) {
          throw new ApiError("PERSON_CHOICE", "The person named this task; keep their title.", 409);
        }
        // Model text: neutralized, and styled as generated until the person renames it.
        task = await this.service.runner.updateTask(id, {
          title: taskTitleFrom(clip(neutralize(input.title ?? ""), 200)),
          titleGenerated: true,
        });
        break;
      case "mark_unread":
        task = await this.lifecycle.markUnread(id);
        break;
    }
    return {
      action: input.action,
      applies,
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        pinned: task.pinned,
        snoozedUntil: task.snoozedUntil ?? null,
        settleRequested: task.settleRequested === true,
      },
    };
  }

  private assertSnoozable(task: Task): void {
    if (task.status === "settled" || task.status === "archived") {
      throw new ApiError(
        "TASK_SETTLED",
        "The person settled or archived this task; leave it there.",
        409,
      );
    }
    if (task.status === "snoozed" && this.snoozes.get(task.id) !== task.snoozedUntil) {
      throw new ApiError("PERSON_CHOICE", "The person snoozed this task; leave the snooze.", 409);
    }
  }

  /** A rename (`titleGenerated: false`) or a title given at creation. */
  private async personNamed(task: Task): Promise<boolean> {
    if (task.titleGenerated !== undefined) {
      return task.titleGenerated === false;
    }
    if (task.kind !== "task" || task.createdBy !== "user") {
      return false;
    }
    const [first] = (await this.service.tasks.items.list({ taskId: task.id, limit: 20 })).filter(
      (item) => item.kind === "user_message",
    );
    return first?.kind === "user_message" && task.title !== taskTitleFrom(first.payload.text);
  }
}
