import type { ActionRecord, Task, TaskRun } from "@passport/types";
import { useState } from "react";
import { AccountDot, useAccounts } from "../accounts/AccountFilter";
import { Feedback, relativeTime } from "../components/ui";
import { Automations } from "../scheduler/Automations";
import { ProposalDetails } from "../views/ProposalDetails";
import { modeLabel } from "../views/trust-modes";
import { taskApi } from "./api";
import { duration, kindLabel, triggerText } from "./model";
import { RunStatus } from "./RunHeader";
import { useTasks } from "./store";

export const statusLabel = (task: Task) =>
  task.status === "snoozed" && task.snoozedUntil
    ? `Snoozed until ${new Date(task.snoozedUntil).toLocaleString(undefined, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      })}`
    : {
        inbox: "Inbox",
        working: "Working",
        snoozed: "Snoozed",
        settled: "Settled",
        archived: "Archived",
      }[task.status];

function Watches({ task }: { task: Task }) {
  const { upsert } = useTasks(),
    [error, setError] = useState("");
  if (!task.watches.length) {
    return null;
  }
  const stop = async (threadHandle?: string) => {
    setError("");
    try {
      upsert(await taskApi.unwatch(task.id, threadHandle));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The watch did not stop.");
    }
  };
  return (
    <section>
      <h3>Watching</h3>
      <ul className="link-list watch-list">
        {task.watches.map((watch) => (
          <li key={watch.threadHandle}>
            <AccountDot id={watch.account} />
            <span>
              A conversation, since {relativeTime(watch.since).toLowerCase()}
              {watch.lastWakeAt && <small>Last reply {relativeTime(watch.lastWakeAt)}</small>}
            </span>
            <button
              type="button"
              className="link-btn"
              onClick={() => void stop(watch.threadHandle)}
            >
              Stop watching
            </button>
          </li>
        ))}
      </ul>
      <Feedback error={error} />
    </section>
  );
}

function Runs({ runs }: { runs: TaskRun[] }) {
  if (!runs.length) {
    return null;
  }
  return (
    <section>
      <h3>Runs</h3>
      <ul className="run-list">
        {runs.slice(0, 12).map((run) => (
          <li key={run.id}>
            <span className="run-list-what">
              {triggerText(run.trigger)}
              <small>
                {relativeTime(run.createdAt)}
                {duration(run) ? `, ${duration(run)}` : ""}
                {run.usage
                  ? `, ${run.usage.toolCalls} tool calls, ${(run.usage.inputTokens + run.usage.outputTokens).toLocaleString()} tokens`
                  : ""}
              </small>
            </span>
            <RunStatus run={run} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The right panel: the selected approval's context, then the task's facts, watches and runs. */
export function TaskDetails({
  task,
  runs,
  selected,
}: {
  task: Task;
  runs: TaskRun[];
  selected?: ActionRecord;
}) {
  const { accounts } = useAccounts();
  return (
    <div className="details-stack">
      {selected && <ProposalDetails action={selected} />}
      <section>
        <h3>Task</h3>
        <dl className="facts compact">
          <dt>Status</dt>
          <dd>{statusLabel(task)}</dd>
          <dt>Kind</dt>
          <dd>
            {kindLabel(task) ?? (task.createdBy === "agent" ? "Started by Passport" : "Yours")}
          </dd>
          <dt>Mode</dt>
          <dd>
            {modeLabel(task.permissionMode)}
            {task.interactionMode === "plan" ? ", plan only" : ""}
          </dd>
          <dt>Started</dt>
          <dd>{relativeTime(task.createdAt)}</dd>
          {task.accountIds.length > 0 && (
            <>
              <dt>Accounts</dt>
              <dd>
                {task.accountIds.map((id) => (
                  <span key={id} className="account-line">
                    <AccountDot id={id} />
                    {accounts.find((a) => a.id === id)?.emailAddress ?? "Account"}
                  </span>
                ))}
              </dd>
            </>
          )}
        </dl>
      </section>
      <Watches task={task} />
      <Automations taskId={task.id} />
      <Runs runs={runs} />
    </div>
  );
}
