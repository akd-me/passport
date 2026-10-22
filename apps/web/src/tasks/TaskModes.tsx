import { type Task, TRUST_LEVELS, type TrustLevel } from "@passport/types";
import { useState } from "react";
import { Popover } from "../components/Popover";
import { Feedback, Icon } from "../components/ui";
import { useWorkspace } from "../state";
import { TrustLadder, TrustPicker } from "../views/TrustControls";
import { modeLabel } from "../views/trust-modes";
import { taskApi } from "./api";
import { useTasks } from "./store";

/** The server lowered the requested mode (global dial, or a parent task). */
export interface Clamp {
  requested: TrustLevel;
  got: TrustLevel;
}
export const clampOf = (requested: TrustLevel, got: TrustLevel): Clamp | null =>
  TRUST_LEVELS.indexOf(got) < TRUST_LEVELS.indexOf(requested) ? { requested, got } : null;

export function ClampNotice({ clamp }: { clamp: Clamp | null }) {
  if (!clamp) {
    return null;
  }
  return (
    <p className="clamp-note" role="status">
      <Icon name="lock" size={13} />
      Clamped to {modeLabel(clamp.got)} by the account ladder. You asked for{" "}
      {modeLabel(clamp.requested)}; raise the permission mode in the sidebar first.
    </p>
  );
}

/** Per-task permission mode (`PATCH permissionMode`), reporting a clamp. */
export function TaskModePicker({
  task,
  onClamp,
}: {
  task: Task;
  onClamp: (clamp: Clamp | null) => void;
}) {
  const { upsert } = useTasks(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const level = task.permissionMode;
  return (
    <Popover
      label={`Task permission mode: ${modeLabel(level)}`}
      placement="above"
      className="mode-menu in-composer"
      triggerClassName={`mode-trigger in-composer mode-${level}`}
      trigger={
        <>
          <TrustLadder level={level} />
          <span className="mode-trigger-label">{modeLabel(level)}</span>
          <Icon name="chevron" size={14} className="chevron" />
        </>
      }
    >
      {(close) => (
        <>
          <div className="popover-title">How much this task does without asking</div>
          <TrustPicker
            compact
            value={level}
            disabled={busy}
            onChange={async (mode) => {
              if (mode === level) {
                return close();
              }
              setBusy(true);
              setError("");
              try {
                const result = await taskApi.patch(task.id, { permissionMode: mode });
                upsert(result);
                onClamp(clampOf(mode, result.permissionMode));
                close();
              } catch (e) {
                setError(e instanceof Error ? e.message : "The mode did not change.");
              } finally {
                setBusy(false);
              }
            }}
          />
          <Feedback error={error} />
          <div className="popover-footer">
            <span>A task never goes above the account ladder or its parent task.</span>
          </div>
        </>
      )}
    </Popover>
  );
}

/** Plan: investigate read-only and return a proposal list. */
export function PlanToggle({ task }: { task: Task }) {
  const { upsert } = useTasks(),
    { notify } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const plan = task.interactionMode === "plan";
  return (
    <button
      type="button"
      className={`composer-chip plan-toggle ${plan ? "on" : ""}`}
      aria-pressed={plan}
      disabled={busy}
      title={
        plan
          ? "Plan: reads only and proposes; nothing changes"
          : "Default: acts within the permission mode"
      }
      onClick={async () => {
        setBusy(true);
        try {
          upsert(await taskApi.patch(task.id, { interactionMode: plan ? "default" : "plan" }));
        } catch (e) {
          notify(e instanceof Error ? e.message : "The mode did not change.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="plan" size={14} />
      <span>Plan</span>
    </button>
  );
}
