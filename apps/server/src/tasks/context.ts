import {
  type CreateTaskInput,
  type Email,
  type Store,
  type StoreTasks,
  type TaskByAction,
  toMailRow,
} from "@passport/types";
import { ApiError } from "../errors.js";
import type { RunItem } from "./runner.js";
import { clip, neutralize, safeRow } from "./untrusted.js";

/**
 * A `notification` naming the matter and messages a composer passed (`matterId`, `emailIds`),
 * so the timeline shows the context the first run received.
 */
export async function contextItems(
  store: Store,
  context: Pick<CreateTaskInput, "emailIds" | "matterId">,
): Promise<RunItem[]> {
  const matter = context.matterId ? await store.matters.get(context.matterId) : null;
  const emails = (
    await Promise.all((context.emailIds ?? []).map((id) => store.emails.get(id)))
  ).filter((email): email is Email => !!email);
  if (!matter && !emails.length) {
    return [];
  }
  const subjects = emails
    .slice(0, 3)
    .map((email) => `“${clip(email.subject || "(no subject)", 60)}”`)
    .join(", ");
  const more = emails.length > 3 ? ` and ${emails.length - 3} more` : "";
  const parts = [
    matter ? `matter “${clip(matter.title, 80)}”` : "",
    emails.length
      ? `${emails.length === 1 ? "message" : `${emails.length} messages`} ${subjects}${more}`
      : "",
  ];
  return [
    {
      kind: "notification",
      untrusted: true,
      payload: {
        source: "system",
        summary: clip(neutralize(`With ${parts.filter(Boolean).join(" and ")}`), 400),
        ...(emails.length === 1 ? { row: safeRow(toMailRow(emails[0]!)) } : {}),
      },
    },
  ];
}

/**
 * The task and run behind an action, for `?decision=<id>` deep links (archived tasks too): the
 * run whose `actionIds` lists it, else the newest run of its `request.runId`.
 */
export async function taskByAction(
  store: Store,
  tasks: StoreTasks,
  actionId: string,
): Promise<TaskByAction> {
  const action = await store.actions.get(actionId);
  const agentRunId = action?.request.runId ?? undefined;
  const run =
    (await tasks.runs.byActionId?.(actionId, agentRunId)) ??
    (agentRunId ? await tasks.runs.byAgentRunId(agentRunId) : null);
  if (!run) {
    throw new ApiError("NOT_FOUND", "No task holds this action", 404);
  }
  return { taskId: run.taskId, runId: run.id };
}
