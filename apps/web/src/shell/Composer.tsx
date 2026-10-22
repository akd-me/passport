import type { TrustLevel } from "@passport/types";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useAccounts } from "../accounts/AccountFilter";
import type { TrustData } from "../api";
import { Popover } from "../components/Popover";
import { Icon, Kbd } from "../components/ui";
import { logger } from "../logger";
import { providerLabel } from "../settings/ModelSettings";
import { useResource } from "../state";
import { taskApi } from "../tasks/api";
import { useTasks } from "../tasks/store";
import { clampOf } from "../tasks/TaskModes";
import { useUi } from "../ui-state";
import { TrustLadder, TrustPicker } from "../views/TrustControls";
import { modeLabel } from "../views/trust-modes";

type RunState =
  | { state: "idle" }
  | { state: "running"; instruction: string }
  | { state: "failed"; instruction: string; error: string };

const suggestions = [
  "Draft replies to anything waiting on me",
  "Archive newsletters I haven’t opened this week",
  "What’s due in the next few days?",
];

/** The task route takes the message only; context the agent should read rides along in it. */
function withContext(
  instruction: string,
  matter?: { id: string; title: string },
  email?: { emailId: string; label: string },
) {
  const lines = [instruction];
  if (matter) {
    lines.push(`Matter: “${matter.title}” (id ${matter.id}).`);
  }
  if (email) {
    lines.push(`Message: “${email.label}” (id ${email.emailId}).`);
  }
  return lines.join("\n\n");
}

/** The new task's permission mode; it starts at the global dial and can only be clamped. */
function TaskModeChoice({
  value,
  onChange,
}: {
  value: TrustLevel;
  onChange: (mode: TrustLevel) => void;
}) {
  return (
    <Popover
      label={`Permission mode for this task: ${modeLabel(value)}`}
      placement="above"
      className="mode-menu in-composer"
      triggerClassName={`mode-trigger in-composer mode-${value}`}
      trigger={
        <>
          <TrustLadder level={value} />
          <span className="mode-trigger-label">{modeLabel(value)}</span>
          <Icon name="chevron" size={14} className="chevron" />
        </>
      }
    >
      {(close) => (
        <>
          <div className="popover-title">How much this task does without asking</div>
          <TrustPicker
            compact
            value={value}
            onChange={(mode) => {
              onChange(mode);
              close();
            }}
          />
          <div className="popover-footer">
            <span>Passport lowers it to the account ladder if you pick higher.</span>
          </div>
        </>
      )}
    </Popover>
  );
}

/**
 * Start a task in plain language (`POST /api/tasks`) and open it. The footer carries the task's
 * permission mode, Plan, and the model, as in a coding agent’s composer.
 */
export function Composer({
  matterId,
  matterTitle,
  showSuggestions = false,
  context,
  autoFocus = false,
}: {
  matterId?: string;
  matterTitle?: string;
  showSuggestions?: boolean;
  /** The message the user is looking at; mentioned in the task unless they remove it. */
  context?: { emailId: string; label: string };
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(""),
    [run, setRun] = useState<RunState>({ state: "idle" }),
    [dropped, setDropped] = useState<string>(),
    [chosenMode, setMode] = useState<TrustLevel>(),
    [plan, setPlan] = useState(false);
  const attached = context && context.emailId !== dropped ? context : undefined;
  const { composer, openSettings } = useUi(),
    { upsert, trackRuns } = useTasks(),
    navigate = useNavigate(),
    { llm, mode } = useAccounts(),
    trust = useResource<TrustData>("/trust");
  const dial = trust.data?.config.globalMode ?? "supervised",
    taskMode = chosenMode ?? dial;
  const submit = async (instruction = text.trim()) => {
    if (!instruction || run.state === "running") {
      return;
    }
    setRun({ state: "running", instruction });
    if (instruction === text.trim()) {
      setText("");
    }
    try {
      const result = await taskApi.create({
        message: withContext(
          instruction,
          matterId ? { id: matterId, title: matterTitle ?? "Matter" } : undefined,
          attached,
        ),
        ...(matterId || attached ? { title: instruction.slice(0, 200) } : {}),
        ...(chosenMode ? { permissionMode: chosenMode } : {}),
        ...(plan ? { interactionMode: "plan" as const } : {}),
      });
      upsert(result.task);
      trackRuns([result.run]);
      setRun({ state: "idle" });
      navigate(`/tasks/${encodeURIComponent(result.task.id)}`, {
        state: { clamp: chosenMode ? clampOf(chosenMode, result.task.permissionMode) : null },
      });
    } catch (e) {
      logger.warn("Task creation failed; restoring the instruction");
      setText((draft) => draft || instruction);
      setRun({
        state: "failed",
        instruction,
        error: e instanceof Error ? e.message : "The task could not start.",
      });
    }
  };
  const provider = llm
      ? mode === "demo"
        ? "Demo agent"
        : (providerLabel[llm.provider] ?? llm.provider)
      : "Model",
    model = mode === "demo" ? "" : llm?.model;
  return (
    <div className="composer-wrap">
      {showSuggestions && run.state === "idle" && !text && (
        <div className="suggestions" aria-label="Suggestions">
          {suggestions.map((s) => (
            <button key={s} type="button" className="chip" onClick={() => void submit(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <form
        className={`composer ${run.state === "running" ? "busy" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {run.state !== "idle" && (
          <div className={`run-status ${run.state}`} role="status" aria-live="polite">
            <Icon name={run.state === "running" ? "spinner" : "alert"} size={14} />
            <span className="run-instruction">{run.instruction}</span>
            <span className="run-result">
              {run.state === "running" ? "Starting the task…" : run.error}
            </span>
            {run.state === "failed" && text && text !== run.instruction && (
              <button
                type="button"
                className="link-btn"
                aria-label={`Retry: ${run.instruction}`}
                onClick={() => void submit(run.instruction)}
              >
                Retry
              </button>
            )}
            {run.state === "failed" && (
              <button
                type="button"
                className="icon-btn"
                aria-label="Dismiss"
                onClick={() => setRun({ state: "idle" })}
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
        )}
        <label className="sr-only" htmlFor="composer-input">
          Instruction for Passport
        </label>
        <textarea
          id="composer-input"
          ref={composer}
          rows={1}
          value={text}
          // biome-ignore lint/a11y/noAutofocus: the new-task page exists to type into this field
          autoFocus={autoFocus}
          placeholder={
            matterTitle
              ? `Ask Passport about ${matterTitle}…`
              : "Tell Passport what to do with your mail…"
          }
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              e.currentTarget.blur();
            }
          }}
        />
        <div className="composer-footer">
          <TaskModeChoice value={taskMode} onChange={setMode} />
          <button
            type="button"
            className={`composer-chip plan-toggle ${plan ? "on" : ""}`}
            aria-pressed={plan}
            title="Plan: reads only and proposes; nothing changes"
            onClick={() => setPlan(!plan)}
          >
            <Icon name="plan" size={14} />
            <span>Plan</span>
          </button>
          <button
            type="button"
            className="composer-chip"
            onClick={() => openSettings("model")}
            title="Change model"
          >
            <Icon name="agent" size={14} />
            <span>{provider}</span>
            {model && <span className="muted model-name">{model}</span>}
          </button>
          {attached && (
            <span
              className="composer-chip static context"
              title="Passport will read this message with your instruction"
            >
              <Icon name="mail" size={14} />
              <span>{attached.label}</span>
              <button
                type="button"
                className="chip-x"
                aria-label={`Don’t include ${attached.label}`}
                onClick={() => setDropped(attached.emailId)}
              >
                <Icon name="close" size={11} />
              </button>
            </span>
          )}
          {matterTitle && (
            <span className="composer-chip static" title="This task is about the matter">
              <Icon name="matters" size={14} />
              <span>{matterTitle}</span>
            </span>
          )}
          <span className="composer-hint" aria-hidden="true">
            <Kbd>↵</Kbd> start
          </span>
          <button
            className="send-btn"
            aria-label="Start task"
            disabled={!text.trim() || run.state === "running"}
          >
            <Icon name={run.state === "running" ? "spinner" : "up"} size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
