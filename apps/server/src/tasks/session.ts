/**
 * Agentic task runs (v0.4, W1A): what a run tells the agent runtime about its provider session,
 * and the observer hooks that record the session and run notices. The runtime decides whether a
 * run becomes a host-agent session; these helpers only describe the task's side of it.
 */
import type {
  AgentRunObserver,
  AgentSessionRunOptions,
  Store,
  StoreTasks,
  Task,
  TaskItemInput,
  TaskRun,
} from "@passport/types";
import { clip, frameUntrusted } from "./untrusted.js";

const SINCE_CHARS = 4000;
const APPROVALS = 10;

/**
 * Session options for a task run. `resolveResume` reads the task when the run starts: with a
 * recorded provider session it returns the short turn a resumed session needs. The runtime falls
 * back to the run's full history instruction when the host agent changed or the provider no
 * longer has the session.
 */
export function taskSessionOptions(
  store: Store,
  tasks: StoreTasks,
  taskId: string,
  request: { texts: string[]; beforeSeq: number } | { instruction: string },
): AgentSessionRunOptions {
  return {
    resolveResume: async () => {
      const task = await tasks.get(taskId);
      if (!task?.providerSessionId || !task.providerSessionKind) {
        return undefined;
      }
      const instruction =
        "instruction" in request
          ? request.instruction
          : await resumeInstruction(store, tasks, task, request.texts, request.beforeSeq);
      return { kind: task.providerSessionKind, id: task.providerSessionId, instruction };
    },
  };
}

/**
 * The next turn of a resumed session: the session already holds the earlier conversation and
 * its tool results, so only what happened since (notices, wakes, approval outcomes) and the
 * person's new message are sent. Mail-derived text stays framed as untrusted data.
 */
async function resumeInstruction(
  store: Store,
  tasks: StoreTasks,
  task: Task,
  texts: string[],
  beforeSeq: number,
): Promise<string> {
  const recent = (
    await tasks.items.recent(
      task.id,
      ["user_message", "notification", "system_notice", "approval_request"],
      40,
    )
  ).filter((item) => item.seq < beforeSeq);
  const previousMessage = recent.find((item) => item.kind === "user_message")?.seq ?? 0;
  let since = "";
  for (const item of [...recent].reverse()) {
    if (item.seq <= previousMessage) {
      continue;
    }
    const line =
      item.kind === "notification"
        ? `Notification: ${item.payload.summary}`
        : item.kind === "system_notice"
          ? `Notice${item.payload.code ? ` (${item.payload.code})` : ""}: ${item.payload.text}`
          : "";
    if (line) {
      since = `${since}${line}\n`.slice(-SINCE_CHARS);
    }
  }
  const approvals: string[] = [];
  for (const item of recent) {
    if (item.kind !== "approval_request" || approvals.length >= APPROVALS) {
      continue;
    }
    const action = await store.actions.get(item.payload.actionId);
    approvals.push(
      `- ${clip(item.payload.summary, 120)}: ${action ? action.status : "unknown"} (action ${item.payload.actionId})`,
    );
  }
  const parts = [
    `Follow-up on the task "${task.title}" (task id ${task.id}). Your session holds the earlier turns.`,
    task.interactionMode === "plan"
      ? "Plan mode: investigate with read tools and answer with a concrete numbered proposal list. Write tools do not execute in this mode."
      : "Mode for this turn: default. Write tools run under policy.",
    since ? `Since your last turn:\n${frameUntrusted("task-events", since)}` : "",
    approvals.length
      ? `Your proposals in this task and their status now:\n${frameUntrusted("task-approvals", approvals.join("\n"))}`
      : "",
    texts.length > 1
      ? `The person's request (they added to it while you worked):\n${texts.join("\n\n")}`
      : `The person's request:\n${texts[0] ?? ""}`,
  ];
  return parts.filter(Boolean).join("\n\n");
}

/** Timeline and task writes the session hooks need from the runner. */
export interface SessionHookTarget {
  appendItem(item: TaskItemInput): Promise<unknown>;
  updateTask(id: string, patch: Partial<Task>): Promise<Task>;
  now(): string;
}

/**
 * Observer hooks for a run: a `notice` becomes a `system_notice` item (e.g. `BUDGET_EXHAUSTED`)
 * and a provider session is recorded on the task so the next turn can resume it.
 */
export function sessionObserver(
  target: SessionHookTarget,
  run: () => TaskRun,
  queue: (write: () => Promise<unknown>) => void,
): Pick<AgentRunObserver, "notice" | "providerSession"> {
  return {
    notice: (notice) =>
      queue(() =>
        target.appendItem({
          taskId: run().taskId,
          runId: run().id,
          kind: "system_notice",
          at: target.now(),
          payload: { text: clip(notice.text, 400), code: notice.code },
        }),
      ),
    providerSession: (session) =>
      queue(() =>
        target.updateTask(run().taskId, {
          providerSessionId: session.id,
          providerSessionKind: session.kind,
        }),
      ),
  };
}
