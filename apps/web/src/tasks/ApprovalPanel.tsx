import type { ActionRecord, Task } from "@passport/types";
import { api } from "../api";
import { Feedback, Icon } from "../components/ui";
import { actionLabel } from "../labels";
import { useTask } from "../state";
import { QuickDecision } from "./ApprovalItem";

/** Reversible proposals among `ids`: the ones "approve all" may take in one click. */
export const reversibleIds = (ids: string[], records: Map<string, ActionRecord>) =>
  ids.filter((id) => records.get(id)?.decision.reversibility === "reversible");

/**
 * Every pending approval of the task, docked above the composer (T3's pattern), with one click
 * to approve all the reversible ones. Irreversible ones are decided one by one.
 */
export function ApprovalPanel({
  task,
  records,
  summaries,
  onSelect,
}: {
  task: Task;
  records: Map<string, ActionRecord>;
  /** `approval_request` summaries by action id, for records that have not loaded. */
  summaries: Map<string, string>;
  onSelect: (actionId: string) => void;
}) {
  const pending = task.pendingActionIds ?? [];
  const all = useTask();
  if (!pending.length) {
    return null;
  }
  const reversible = reversibleIds(pending, records);
  return (
    <section className="approval-panel" aria-labelledby="approval-panel-title">
      <div className="approval-panel-head">
        <h2 id="approval-panel-title">
          <Icon name="approval" size={14} />
          {pending.length === 1
            ? "1 change waits for you"
            : `${pending.length} changes wait for you`}
        </h2>
        {reversible.length > 0 && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={all.busy}
            onClick={() =>
              all.run(
                async () => {
                  for (const id of reversible) {
                    await api.approve(id);
                  }
                },
                `Approved ${reversible.length} reversible ${reversible.length === 1 ? "change" : "changes"}.`,
              )
            }
          >
            <Icon name="check" size={13} />
            Approve{" "}
            {reversible.length === pending.length ? "all" : `${reversible.length} reversible`}
          </button>
        )}
      </div>
      <Feedback error={all.error} />
      <ul>
        {pending.map((id) => {
          const record = records.get(id);
          const label = record?.request.reason ?? summaries.get(id) ?? "Proposed change";
          return (
            <li key={id}>
              <button type="button" className="approval-what" onClick={() => onSelect(id)}>
                {record && <strong>{actionLabel(record.request.type)}</strong>}
                <span>{label}</span>
                {record && record.decision.reversibility !== "reversible" && (
                  <span className="badge warn">
                    {record.decision.reversibility === "delayed" ? "Sends" : "Can’t undo"}
                  </span>
                )}
              </button>
              <QuickDecision actionId={id} label={label} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
