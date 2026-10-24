import type { AgentRun, TaskRun, TaskRunTrigger } from "@passport/types";
import { describeAgentRun, type TaskService } from "./service.js";
import { frameUntrusted } from "./untrusted.js";

/** Why a run is continued: a server restart cut it off, or the person resumed after a limit. */
export type ContinuationReason = "restarted" | "limit";

const WHY: Record<ContinuationReason, string> = {
  restarted:
    "Passport restarted while your previous run on this task was in progress, so that run stopped part-way.",
  limit:
    "Your previous run on this task stopped because the model's usage limit was reached. The person asked to continue it now.",
};

/**
 * Starts a run that continues `previous` (restart continuation and limit resume). A message run
 * continues as a message run on the same `user_message` item, so the status rules treat it as the
 * person's; watch and wake runs continue as a background `wake` run. Resolves once the new
 * TaskRun is persisted; `done` settles when it ends.
 */
export async function continueRun(
  service: TaskService,
  previous: TaskRun,
  reason: ContinuationReason,
  inFlight = "",
): Promise<{ run: TaskRun; done: Promise<AgentRun> }> {
  const task = await service.task(previous.taskId);
  const recent = await service.tasks.items.recent(task.id, ["user_message", "notification"], 200);
  const trigger = previous.trigger;
  const fromPerson = trigger.kind === "message";
  const requests: string[] = [];
  const context: string[] = [];
  for (const item of [...recent].reverse()) {
    const own = item.runId === previous.id;
    if (item.kind === "user_message" && fromPerson && (own || item.id === trigger.itemId)) {
      requests.push(item.payload.text);
    } else if (item.kind === "notification" && own) {
      context.push(item.payload.summary);
    }
  }
  const next: TaskRunTrigger = fromPerson
    ? { kind: "message", itemId: trigger.itemId, mode: "queue" }
    : { kind: "wake", reason: reason === "restarted" ? "restarted" : "limit_resumed" };
  const instruction = [
    `You are working on the task "${task.title}" (task id ${task.id}).`,
    WHY[reason],
    inFlight,
    "Check what the previous run already did (mail state, drafts, this task's changes) before repeating any write, then carry on.",
    requests.length ? `The person's request:\n${requests.join("\n\n")}` : "",
    context.length
      ? `What started the previous run:\n${frameUntrusted("task-history", context.join("\n"))}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  let created!: (run: TaskRun) => void;
  const persisted = new Promise<TaskRun>((resolve) => {
    created = resolve;
  });
  const done = service.runner.execute(
    {
      taskId: task.id,
      trigger: next,
      priority: fromPerson ? "interactive" : "background",
      cancellable: true,
      onCreated: created,
    },
    (options) =>
      service.options.agent.run(
        { kind: "manual", instruction },
        fromPerson ? options : { ...options, priority: "background" },
      ),
    describeAgentRun,
  );
  // The outcome is on the run and the timeline; callers need not await `done`.
  done.catch(() => undefined);
  const run = (await Promise.race([persisted, done.then(() => null)])) ?? (await persisted);
  if (reason !== "restarted") {
    return { run, done };
  }
  const marked = await service.tasks.runs.update(run.id, { restartOf: previous.id });
  service.options.bus.emit({ type: "task.run.updated", run: marked });
  return { run: marked, done };
}
