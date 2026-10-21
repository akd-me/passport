import { useEffect, useState } from "react";
import type { AgentRun } from "@passport/types";
import { api } from "../api";
import { useWorkspace } from "../state";
import { useUi } from "../ui-state";
import { useAccounts } from "../accounts/AccountFilter";
import { providerLabel } from "../settings/ModelSettings";
import { ModeMenu } from "../views/Trust";
import { Icon, Kbd } from "../components/ui";

type RunState =
  | { state: "idle" }
  | { state: "running"; instruction: string }
  | { state: "done"; instruction: string; run: AgentRun }
  | { state: "failed"; instruction: string; error: string };

export const suggestions = [
  "Draft replies to anything waiting on me",
  "Archive newsletters I haven’t opened this week",
  "What’s due in the next few days?",
];

function outcome(run: AgentRun) {
  if (run.error) return run.error;
  const count = run.actionIds.length;
  if (!count) return run.summary || "Done. Nothing needed changing.";
  return `${count} ${count === 1 ? "action" : "actions"} ready. Anything that needs you is in the queue.`;
}

/**
 * Tell the agent what to do in plain language. The footer carries the permission mode and the
 * model, as in a coding agent’s composer.
 */
export function Composer({
  matterId,
  matterTitle,
  onRun,
  showSuggestions = false,
  context,
}: {
  matterId?: string;
  matterTitle?: string;
  onRun?: (run: AgentRun) => void;
  showSuggestions?: boolean;
  /** The message the user is looking at; sent as `emailIds` unless they remove it. */
  context?: { emailId: string; label: string };
}) {
  const [text, setText] = useState(""),
    [run, setRun] = useState<RunState>({ state: "idle" }),
    [dropped, setDropped] = useState<string>();
  const attached = context && context.emailId !== dropped ? context : undefined;
  const { composer, openSettings } = useUi(),
    { refresh } = useWorkspace(),
    { llm, mode } = useAccounts();
  useEffect(() => {
    if (run.state !== "done") return;
    const timer = setTimeout(() => setRun({ state: "idle" }), 12000);
    return () => clearTimeout(timer);
  }, [run]);
  const submit = async (instruction = text.trim()) => {
    if (!instruction || run.state === "running") return;
    setRun({ state: "running", instruction });
    setText("");
    try {
      const result = await api.runAgent({
        instruction,
        ...(matterId ? { matterId } : {}),
        ...(attached ? { emailIds: [attached.emailId] } : {}),
      });
      setRun({ state: "done", instruction, run: result });
      refresh();
      onRun?.(result);
    } catch (e) {
      setText(instruction);
      setRun({
        state: "failed",
        instruction,
        error: e instanceof Error ? e.message : "The agent could not run.",
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
            <Icon
              name={run.state === "running" ? "spinner" : run.state === "failed" ? "alert" : "check"}
              size={14}
            />
            <span className="run-instruction">{run.instruction}</span>
            <span className="run-result">
              {run.state === "running"
                ? "Working…"
                : run.state === "failed"
                  ? run.error
                  : outcome(run.run)}
            </span>
            {run.state !== "running" && (
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
          <ModeMenu placement="above" variant="composer" />
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
            <span className="composer-chip static context" title="Passport will read this message with your instruction">
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
            <span className="composer-chip static" title="This instruction is scoped to the matter">
              <Icon name="matters" size={14} />
              <span>{matterTitle}</span>
            </span>
          )}
          <span className="composer-hint" aria-hidden="true">
            <Kbd>↵</Kbd> send
          </span>
          <button
            className="send-btn"
            aria-label="Send instruction"
            disabled={!text.trim() || run.state === "running"}
          >
            <Icon name={run.state === "running" ? "spinner" : "up"} size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
