import type { ActionRecord, ActionType, TaskRun } from "@passport/types";
import { useEffect, useId, useState } from "react";
import { Icon, relativeTime } from "../components/ui";
import { actionLabel } from "../labels";
import { UndoButton } from "../views/DecisionCard";
import { useActions } from "./actions-store";
import { duration, isActiveRun, runStatusText, triggerText } from "./model";

const statusText: Partial<Record<ActionRecord["status"], string>> = {
  proposed: "Waiting for you",
  approved: "Approved",
  rejected: "Rejected",
  held: "In the outbox",
  executing: "Running",
  executed: "Done",
  undone: "Undone",
  failed: "Failed",
  expired: "Expired",
};

/** Counts by action type, largest first: the per-run "diff". */
export function countByType(records: ActionRecord[]): [ActionType, number][] {
  const counts = new Map<ActionType, number>();
  for (const record of records) {
    counts.set(record.request.type, (counts.get(record.request.type) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

export function RunStatus({ run }: { run: TaskRun }) {
  return (
    <span className={`run-chip ${run.status}`}>
      {isActiveRun(run) && <Icon name="spinner" size={12} />}
      {runStatusText[run.status]}
      {run.status === "failed" && run.error ? `: ${run.error}` : ""}
    </span>
  );
}

/**
 * What the run changed, with each ActionRecord and its undo. The records are fetched when the
 * summary opens (one request per run, cached), not for every run on screen (R5-2).
 */
function ChangeSummary({ run }: { run: TaskRun }) {
  const [open, setOpen] = useState(false),
    id = useId(),
    { records, runs, loadRun } = useActions();
  const count = run.actionIds.length;
  useEffect(() => {
    if (open && count) {
      loadRun(run);
    }
  }, [open, count, loadRun, run]);
  const known = run.actionIds.map((a) => records.get(a)).filter((r): r is ActionRecord => !!r);
  if (!run.actionIds.length) {
    return isActiveRun(run) ? null : <span className="change-none">No changes</span>;
  }
  return (
    <div className="change-summary">
      <button
        type="button"
        className="change-toggle"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <span className="change-counts">
          {known.length
            ? countByType(known).map(([type, n]) => (
                <span key={type} className="change-count">
                  {actionLabel(type)} <strong>{n}</strong>
                </span>
              ))
            : `${run.actionIds.length} ${run.actionIds.length === 1 ? "change" : "changes"}`}
        </span>
        <Icon name={open ? "chevron" : "next"} size={13} />
      </button>
      {open && (
        <ul className="change-list" id={id}>
          {known.map((record) => (
            <li key={record.id}>
              <span className="change-what">
                <strong>{actionLabel(record.request.type)}</strong>
                <span>{record.request.reason}</span>
              </span>
              <span className={`change-status ${record.status}`}>
                {statusText[record.status] ?? record.status}
              </span>
              {record.status === "executed" && record.inverse && !record.undoneAt ? (
                <UndoButton action={record} />
              ) : (
                <span className="undo-gap" />
              )}
            </li>
          ))}
          {known.length < count &&
            (runs.get(run.agentRunId) === "failed" ? (
              <li className="muted">
                {count - known.length} could not load.{" "}
                <button type="button" className="link-btn" onClick={() => loadRun(run)}>
                  Retry
                </button>
              </li>
            ) : (
              <li className="muted">Loading {count - known.length} more…</li>
            ))}
        </ul>
      )}
    </div>
  );
}

/** The divider before a run's items: why it ran, its state, and what it changed. */
export function RunHeader({ run }: { run: TaskRun }) {
  const took = duration(run);
  return (
    <div className="run-header" data-run={run.id}>
      <div className="run-header-line">
        <span className="run-trigger">{triggerText(run.trigger)}</span>
        <RunStatus run={run} />
        <time dateTime={run.createdAt}>{relativeTime(run.createdAt)}</time>
        {took && <span className="muted">{took}</span>}
      </div>
      <ChangeSummary run={run} />
    </div>
  );
}
