import type { AgentRun, Task, TaskItem, TaskRun, TaskRunTrigger } from "@passport/types";
import { answeredRequest } from "./questions.js";
import { describeAgentRun, type TaskService } from "./service.js";
import { frameUntrusted, taskLabel } from "./untrusted.js";

/** Why a run is continued: a server restart cut it off, or the person resumed after a limit. */
export type ContinuationReason = "restarted" | "limit";

const WHY: Record<ContinuationReason, string> = {
  restarted:
    "Passport restarted while your previous run on this task was in progress, so that run stopped part-way.",
  limit:
    "Your previous run on this task stopped because the model's usage limit was reached. The person asked to continue it now.",
};

const PLAN =
  "Plan mode: investigate with read tools and answer with a concrete numbered proposal list. Write tools do not execute in this mode.";

/**
 * Starts a run that continues `previous` (restart continuation and limit resume). A message run
 * continues as a message run on the same `user_message` item, so the status rules treat it as the
 * person's (but keep a snooze they chose); watch and wake runs continue as a background `wake`
 * run. Like every task run it is a session on host agents and resumes the task's provider session
 * (R1-4). The prompt repeats the run's whole request (a steer's included, answers with their
 * questions) and, for a fresh session, the task history (R1-17). Resolves once the new TaskRun is
 * persisted; `done` settles when it ends.
 */
export async function continueRun(
  service: TaskService,
  previous: TaskRun,
  reason: ContinuationReason,
  inFlight = "",
): Promise<{ run: TaskRun; done: Promise<AgentRun> }> {
  const task = await service.task(previous.taskId);
  const recent = [
    ...(await service.tasks.items.recent(task.id, ["user_message", "notification"], 200)),
  ].reverse();
  const trigger = previous.trigger;
  const fromPerson = trigger.kind === "message";
  const own = recent.filter(
    (item) => item.runId === previous.id || (fromPerson && item.id === trigger.itemId),
  );
  const requests = fromPerson ? await requestOf(service, task, previous, own) : [];
  const context = own.flatMap((item) =>
    item.kind === "notification" ? [item.payload.summary] : [],
  );
  const beforeSeq = own.length ? Math.min(...own.map((item) => item.seq)) : Number.MAX_SAFE_INTEGER;
  const from = task.delegation ? "The request from your parent task" : "The person's request";
  const body = [
    WHY[reason],
    task.interactionMode === "plan" ? PLAN : "",
    inFlight,
    "Check what the previous run already did (mail state, drafts, this task's changes) before repeating any write, then carry on.",
  ];
  const tail = [
    requests.length ? `${from}:\n${requests.join("\n\n")}` : "",
    context.length
      ? `What started the previous run:\n${frameUntrusted("task-history", context.join("\n"))}`
      : "",
  ];
  const instruction = join([
    `You are working on ${taskLabel(task)}.`,
    ...body,
    await service.history(task, beforeSeq),
    ...tail,
  ]);
  // A resumed provider session already holds the history.
  const resumed = join([
    `Follow-up on ${taskLabel(task)}. Your session holds the earlier turns.`,
    ...body,
    ...tail,
  ]);
  const next: TaskRunTrigger = fromPerson
    ? { kind: "message", itemId: trigger.itemId, mode: "queue" }
    : { kind: "wake", reason: reason === "restarted" ? "restarted" : "limit_resumed" };
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
      continuation: true,
      ...(requests.length ? { request: requests } : {}),
      // In the insert, so a crash cannot leave a continuation without its once-only mark.
      ...(reason === "restarted" ? { restartOf: previous.id } : {}),
    },
    (options) =>
      service.options.agent.run(
        { kind: "manual", instruction },
        {
          ...options,
          ...(fromPerson ? {} : { priority: "background" as const }),
          session: service.sessionOptions(task.id, { instruction: resumed }),
        },
      ),
    describeAgentRun,
  );
  // The outcome is on the run and the timeline; callers need not await `done`.
  done.catch(() => undefined);
  const run = (await Promise.race([persisted, done.then(() => null)])) ?? (await persisted);
  return { run, done };
}

/**
 * The request a message run carried: `TaskRun.request` (a steer's includes the cancelled
 * message), else its own `user_message` items, answers quoted with their questions.
 */
async function requestOf(
  service: TaskService,
  task: Task,
  previous: TaskRun,
  own: TaskItem[],
): Promise<string[]> {
  if (previous.request?.length) {
    return previous.request;
  }
  const texts: string[] = [];
  for (const item of own) {
    if (item.kind !== "user_message") {
      continue;
    }
    const answers = item.payload.answers ?? [];
    texts.push(
      answers.length
        ? await answeredRequest(service.tasks, task, answers, item.payload.text)
        : item.payload.text,
    );
  }
  return texts;
}

function join(parts: string[]): string {
  return parts.filter(Boolean).join("\n\n");
}
