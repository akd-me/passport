import type { ActionRecord, Task } from "@passport/types";
import { Feedback, Icon } from "../components/ui";
import { actionLabel } from "../labels";
import { useTask } from "../state";
import { draftOf, recipients } from "../views/decision-model";
import { QuickDecision } from "./ApprovalItem";
import { useActions } from "./actions-store";
import { ProfileProposal } from "./ProfileProposal";

/** Reversible proposals among `ids`: the ones "approve all" may take in one click. */
export const reversibleIds = (ids: string[], records: Map<string, ActionRecord>) =>
  ids.filter((id) => records.get(id)?.decision.reversibility === "reversible");

/** What the row is about once the record is here: who a draft goes to and its subject. */
function DraftLine({ record }: { record: ActionRecord }) {
  const draft = draftOf(record);
  return draft ? (
    <span className="approval-draft muted">
      To {recipients(draft)}: {draft.subject}
    </span>
  ) : null;
}

/**
 * Every pending approval of the task, docked above the composer (T3's pattern), with one click
 * to approve all the reversible ones ("once"). Irreversible ones are decided one by one.
 */
export function ApprovalPanel({
  task,
  summaries,
  onSelect,
}: {
  task: Task;
  /** `approval_request` summaries by action id, shown while records load. */
  summaries: Map<string, string>;
  onSelect: (actionId: string) => void;
}) {
  const actions = useActions(),
    { records } = actions;
  const pending = (task.pendingActionIds ?? []).filter((id) => !actions.decided.has(id));
  const all = useTask();
  if (!pending.length) {
    return null;
  }
  const reversible = reversibleIds(pending, records).filter((id) => !actions.busy.has(id));
  const approveAll = async () => {
    let done = 0;
    try {
      for (const id of reversible) {
        await actions.decide(id, { kind: "approve" });
        done++;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Please try again.";
      throw new Error(
        done ? `Approved ${done} of ${reversible.length}. The next one failed: ${reason}` : reason,
      );
    }
  };
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
            className="btn btn-sm btn-primary"
            disabled={all.busy}
            onClick={() =>
              all.run(
                approveAll,
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
                {record && <DraftLine record={record} />}
              </button>
              <ProfileProposal action={record} />
              <QuickDecision
                actionId={id}
                label={label}
                record={record}
                load={actions.pending}
                onRetry={actions.retryPending}
                primary={false}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
