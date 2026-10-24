import {
  type Task,
  type TaskOrganizeInput,
  type TaskOrganizeResult,
  type TaskToolCaller,
  taskTitleFrom,
} from "@passport/types";
import type { TaskLifecycle } from "./lifecycle.js";
import type { TaskService } from "./service.js";
import { clip, neutralize } from "./untrusted.js";

/**
 * `task_organize` (T3 `t3_thread_organize`): the agent files its own task. Everything applies
 * now except settle, which is recorded as `settleRequested` and applied by the status rules
 * when the run ends (`resolveTaskStatus`), unless something then waits on the person.
 */
export class TaskOrganizer {
  constructor(
    private readonly service: TaskService,
    private readonly lifecycle: TaskLifecycle,
  ) {}

  async organize(caller: TaskToolCaller, input: TaskOrganizeInput): Promise<TaskOrganizeResult> {
    const id = (await this.service.task(caller.taskId)).id;
    let task: Task;
    let applies: TaskOrganizeResult["applies"] = "now";
    switch (input.action) {
      case "snooze":
        task = await this.lifecycle.snooze(id, input.until ?? "");
        break;
      case "unsnooze":
        task = await this.lifecycle.unsnooze(id);
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
}
