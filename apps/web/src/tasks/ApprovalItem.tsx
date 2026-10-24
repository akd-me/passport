import type { ActionRecord, Task, TaskItem } from "@passport/types";
import { Link } from "react-router";
import { Feedback, Icon } from "../components/ui";
import { actionLabel } from "../labels";
import { DecisionCard } from "../views/DecisionCard";
import { type LoadState, useActions, useDecision } from "./actions-store";
import { PlainText } from "./TimelineItems";

type ApprovalRequest = Extract<TaskItem, { kind: "approval_request" }>;

const decided: Partial<Record<ActionRecord["status"], string>> = {
  approved: "Approved",
  executing: "Approved, running",
  executed: "Approved and done",
  held: "Approved, waiting in the outbox",
  rejected: "Rejected",
  undone: "Approved, then undone",
  failed: "Approved, but it failed",
  expired: "Expired before a decision",
};

/** Pending per the task, or per the record when the task's list is missing or behind (R5-14). */
export const isPending = (task: Task, actionId: string, record?: ActionRecord) =>
  !!task.pendingActionIds?.includes(actionId) || record?.status === "proposed";

/**
 * Approve and reject from a one-line row. Without the record (type, reversibility, draft) on
 * screen there is nothing to approve yet: the buttons stay disabled (R5-6).
 */
export function QuickDecision({
  actionId,
  label,
  record,
  load,
  onRetry,
  primary = true,
}: {
  actionId: string;
  label: string;
  record?: ActionRecord;
  load: LoadState | "idle";
  onRetry: () => void;
  /** False in the composer's panel, whose "Approve all" is the one primary action. */
  primary?: boolean;
}) {
  const decision = useDecision(actionId);
  if (!record && load === "failed") {
    return (
      <span className="quick-decision unavailable">
        <span className="muted">This change did not load.</span>
        <button type="button" className="link-btn" onClick={onRetry}>
          Retry
        </button>
        <Link to={`/needs-you?decision=${encodeURIComponent(actionId)}`}>Review in Needs you</Link>
      </span>
    );
  }
  return (
    <>
      <span className="quick-decision" aria-busy={!record || undefined}>
        {!record && <span className="muted loading-note">Loading…</span>}
        <button
          type="button"
          className={`btn btn-sm ${primary ? "btn-primary" : ""}`}
          disabled={!record || decision.busy}
          aria-label={`Approve: ${label}`}
          onClick={() => void decision.decide({ kind: "approve" }, "Approved.")}
        >
          <Icon name="check" size={13} />
          Approve
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={!record || decision.busy}
          aria-label={`Reject: ${label}`}
          onClick={() => void decision.decide({ kind: "reject" }, "Rejected.")}
        >
          Reject
        </button>
      </span>
      <Feedback error={decision.error} />
    </>
  );
}

/**
 * An `approval_request` in the timeline. While the action is pending it is the full decision
 * card (approve, edit a draft, reject) once the record has loaded; afterwards a one-line outcome.
 */
export function ApprovalItem({
  item,
  task,
  record,
  load,
  onRetry,
  selected,
  onSelect,
}: {
  item: ApprovalRequest;
  task: Task;
  record?: ActionRecord;
  load: LoadState | "idle";
  onRetry: () => void;
  selected: boolean;
  onSelect: () => void;
}) {
  const { actionId, summary } = item.payload,
    { decided: done } = useActions();
  if (isPending(task, actionId, record) && !done.has(actionId)) {
    return record ? (
      <div className="tl-approval">
        <DecisionCard action={record} selected={selected} onSelect={onSelect} />
      </div>
    ) : (
      <div className="tl-approval pending" data-approval={actionId}>
        <div className="tl-line">
          <Icon name="approval" size={14} />
          <PlainText text={summary} />
        </div>
        <QuickDecision
          actionId={actionId}
          label={summary}
          record={record}
          load={load}
          onRetry={onRetry}
        />
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`tl-approval decided ${selected ? "selected" : ""}`}
      data-approval={actionId}
      onClick={onSelect}
    >
      <Icon name={record?.status === "rejected" ? "close" : "check"} size={13} />
      <span className="tl-approval-what">
        {record ? `${actionLabel(record.request.type)}: ` : ""}
        {summary}
      </span>
      <span className="muted">
        {record ? (decided[record.status] ?? record.status) : "Decided"}
      </span>
    </button>
  );
}
