import type { Task, TaskMessageMode } from "@passport/types";
import { useState } from "react";
import { Feedback, Icon, Kbd, mod } from "../components/ui";
import { logger } from "../logger";
import { useUi } from "../ui-state";
import { ApprovalPanel } from "./ApprovalPanel";
import { taskApi } from "./api";
import { useTasks } from "./store";
import { type Clamp, ClampNotice, PlanToggle, TaskModePicker } from "./TaskModes";

/** The default send mode: a follow-up waits for the active run. */
export const DEFAULT_SEND_MODE: TaskMessageMode = "queue";

/**
 * Enter sends in the default mode; ⌘Enter (Ctrl elsewhere) sends in the opposite one. Steering
 * only means something while a run of a person's task is live, so without one both queue.
 */
export function sendModeFor(
  event: { metaKey: boolean; ctrlKey: boolean },
  live: boolean,
): TaskMessageMode {
  const opposite: TaskMessageMode = DEFAULT_SEND_MODE === "queue" ? "steer" : "queue";
  const mode = event.metaKey || event.ctrlKey ? opposite : DEFAULT_SEND_MODE;
  return live ? mode : "queue";
}

/**
 * Follow-ups for an open task. Enter queues after the active run; ⌘Enter steers (cancels the
 * active message run and restarts with both messages). Stop interrupts every cancellable run.
 */
export function TaskComposer({
  task,
  running,
  summaries,
  clamp,
  onClamp,
  onSelectApproval,
}: {
  task: Task;
  running: boolean;
  summaries: Map<string, string>;
  clamp: Clamp | null;
  onClamp: (clamp: Clamp | null) => void;
  onSelectApproval: (actionId: string) => void;
}) {
  const [text, setText] = useState(""),
    [sending, setSending] = useState<TaskMessageMode | "stop" | null>(null),
    [error, setError] = useState("");
  const { composer } = useUi(),
    { upsert, trackRuns } = useTasks();
  // Inbox and routine runs can't be stopped or steered; messages to them queue (R5-8).
  const live = running && task.kind === "task";
  const send = async (mode: TaskMessageMode) => {
    const message = text.trim();
    if (!message || sending) {
      return;
    }
    setSending(mode);
    setError("");
    setText("");
    try {
      const result = await taskApi.message(task.id, message, mode);
      upsert(result.task);
      trackRuns([result.run]);
    } catch (e) {
      logger.warn("Task message failed; restoring the draft");
      setText((draft) => draft || message);
      setError(e instanceof Error ? e.message : "The message did not send.");
    } finally {
      setSending(null);
    }
  };
  const stop = async () => {
    setSending("stop");
    setError("");
    try {
      upsert(await taskApi.interrupt(task.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The task did not stop.");
    } finally {
      setSending(null);
    }
  };
  return (
    <div className="composer-wrap task-composer">
      <ApprovalPanel task={task} summaries={summaries} onSelect={onSelectApproval} />
      <ClampNotice clamp={clamp} />
      <form
        className={`composer ${sending ? "busy" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          void send("queue");
        }}
      >
        <Feedback error={error} />
        <label className="sr-only" htmlFor="task-composer-input">
          Message for this task
        </label>
        <textarea
          id="task-composer-input"
          ref={composer}
          rows={1}
          value={text}
          placeholder={
            running
              ? "Add a follow-up. It runs after this one…"
              : "Reply, or ask for something else…"
          }
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(sendModeFor(e, live));
            } else if (e.key === "Escape") {
              e.currentTarget.blur();
            }
          }}
        />
        <div className="composer-footer">
          <TaskModePicker task={task} onClamp={onClamp} />
          <PlanToggle task={task} />
          <span className="composer-hint" aria-hidden="true">
            <Kbd>↵</Kbd> {running ? "queue" : "send"}
            {live && (
              <>
                <Kbd>{mod}↵</Kbd> steer
              </>
            )}
          </span>
          {live && (
            <button
              type="button"
              className="btn btn-sm stop-btn"
              onClick={() => void stop()}
              disabled={sending === "stop"}
            >
              <Icon name="stop" size={12} />
              Stop
            </button>
          )}
          <button
            type="submit"
            className="send-btn"
            aria-label={running ? "Queue message" : "Send message"}
            disabled={!text.trim() || !!sending}
          >
            <Icon name={sending && sending !== "stop" ? "spinner" : "up"} size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
