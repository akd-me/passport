import { type ConversationWatch, parseMailHandle, stampTask, type Task } from "@passport/types";
import type { Context } from "./context.js";
import { json, ToolError } from "./presentation.js";
import { register } from "./register.js";
import { schema as z } from "./schema.js";

/** Watches kept per task; older ones are dropped first. */
const MAX_WATCHES = 20;

const threadHandle = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .describe("Conversation handle: the `threadId` of a mail_search / mail_list / mail_read row.");

/** The calling task, from the trusted call context only. */
async function currentTask(
  ctx: Context,
): Promise<{ task: Task; tasks: NonNullable<Context["store"]["tasks"]> }> {
  const tasks = ctx.store.tasks;
  if (!tasks) {
    throw new ToolError("TASKS_UNAVAILABLE", "This Passport host does not keep tasks.");
  }
  const taskId = ctx.callContext.taskId;
  if (!taskId) {
    throw new ToolError(
      "TASK_REQUIRED",
      "Conversation watches belong to a Passport task; call this from a task run.",
    );
  }
  const task = await tasks.get(taskId);
  if (!task) {
    throw new ToolError("NOT_FOUND", "Task not found.");
  }
  return { task, tasks };
}

/** The person settled or archived the task (possibly while this run was working): no new watches. */
function refuseClosed(task: Task) {
  if (task.status === "settled" || task.status === "archived") {
    throw new ToolError(
      "TASK_SETTLED",
      "The person settled or archived this task; it can no longer watch conversations.",
    );
  }
}

/**
 * `watch_conversation` / `unwatch_conversation`. Both are write tools: they change the task's
 * lifecycle, so plan mode records them instead of running them (R4-18). The email analogue of
 * `watch_pull_request`.
 */
export function registerTaskWatches(ctx: Context) {
  register(
    ctx,
    "watch_conversation",
    "Wake this task when someone other than the user replies on a conversation, a bounce or auto-reply arrives, or after 14 days. Only messages after now count. While watching, the task waits in Working instead of the user's inbox; call unwatch_conversation when handing back. Settled or archived tasks cannot watch (TASK_SETTLED).",
    {
      threadHandle,
      account: z
        .string()
        .trim()
        .min(1)
        .max(512)
        .optional()
        .describe("Account id; defaults to the handle's account."),
    },
    true,
    async (args, call) => {
      const { task, tasks } = await currentTask(call);
      refuseClosed(task);
      // Only a real thread handle: arbitrary text would sit in later wake prompts (R4-17).
      const parsed = parseMailHandle(args.threadHandle);
      if (parsed?.type !== "thread") {
        throw new ToolError(
          "INVALID_INPUT",
          "Pass the conversation (thread) handle from a mail row's threadId.",
        );
      }
      const accountId = args.account ?? parsed.accountId;
      if (accountId !== parsed.accountId) {
        throw new ToolError("ACCOUNT_MISMATCH", "The handle belongs to a different account.");
      }
      const account = await call.account(accountId);
      const watch: ConversationWatch = {
        threadHandle: args.threadHandle,
        account: account.id,
        since: call.now(),
        consecutiveWakes: 0,
      };
      // An agent action, not the person's: `lastActivityAt` and `returnedAt` stay (R1-19).
      const updated = await tasks.update(task.id, (current) => {
        refuseClosed(current);
        return stampTask(current, {
          watches: [
            ...current.watches.filter((item) => item.threadHandle !== watch.threadHandle),
            watch,
          ].slice(-MAX_WATCHES),
        });
      });
      call.deps.bus.emit({ type: "task.updated", task: updated });
      return json({ watching: true, threadHandle: watch.threadHandle, since: watch.since });
    },
  );
  register(
    ctx,
    "unwatch_conversation",
    "Stop watching a conversation for this task (or every conversation when threadHandle is omitted). The task returns to the user's inbox when nothing else keeps it working.",
    { threadHandle: threadHandle.optional() },
    true,
    async (args, call) => {
      const { task, tasks } = await currentTask(call);
      const updated = await tasks.update(task.id, (current) =>
        stampTask(current, {
          watches: args.threadHandle
            ? current.watches.filter((item) => item.threadHandle !== args.threadHandle)
            : [],
        }),
      );
      call.deps.bus.emit({ type: "task.updated", task: updated });
      return json({ watching: updated.watches.map((item) => item.threadHandle) });
    },
  );
}
