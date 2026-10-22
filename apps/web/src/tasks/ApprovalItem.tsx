import type { ActionRecord, Task, TaskItem } from "@passport/types";
import { api } from "../api";
import { Feedback, Icon } from "../components/ui";
import { actionLabel } from "../labels";
import { useTask } from "../state";
import { DecisionCard } from "../views/DecisionCard";
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

export const isPending = (task: Task, actionId: string) =>
  !!task.pendingActionIds?.includes(actionId);

/** Approve and reject without the full record (it has not loaded yet). */
export function QuickDecision({ actionId, label }: { actionId: string; label: string }) {
  const task = useTask();
  return (
    <>
      <span className="quick-decision">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={task.busy}
          aria-label={`Approve: ${label}`}
          onClick={() => task.run(() => api.approve(actionId), "Approved.")}
        >
          <Icon name="check" size={13} />
          Approve
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={task.busy}
          aria-label={`Reject: ${label}`}
          onClick={() => task.run(() => api.reject(actionId), "Rejected.")}
        >
          Reject
        </button>
      </span>
      <Feedback error={task.error} />
    </>
  );
}

/**
 * An `approval_request` in the timeline. While the action is in `task.pendingActionIds` it is
 * the full decision card (approve, edit a draft, reject); afterwards a one-line outcome.
 */
export function ApprovalItem({
  item,
  task,
  record,
  selected,
  onSelect,
}: {
  item: ApprovalRequest;
  task: Task;
  record?: ActionRecord;
  selected: boolean;
  onSelect: () => void;
}) {
  const { actionId, summary } = item.payload;
  if (isPending(task, actionId)) {
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
        <QuickDecision actionId={actionId} label={summary} />
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
