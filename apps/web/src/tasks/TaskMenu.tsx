import type { Task } from "@passport/types";
import { useState } from "react";
import { Popover } from "../components/Popover";
import { Icon } from "../components/ui";
import { snoozePresets } from "./model";
import { type TaskAction, useTasks } from "./store";

const timeText = (d: Date) =>
  d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

/** `datetime-local` value for a date, in local time. */
const localInput = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** Row and header actions: pin, mark unread, snooze until…, settle, archive. No dragging needed. */
export function TaskMenu({
  task,
  placement = "below",
  onDone,
}: {
  task: Task;
  placement?: "above" | "below";
  onDone?: (action: TaskAction) => void;
}) {
  return (
    <Popover
      label={`Actions for ${task.title}`}
      placement={placement}
      align="end"
      className="task-menu"
      triggerClassName="icon-btn tiny task-menu-trigger"
      trigger={<Icon name="more" size={14} />}
    >
      {(close) => <MenuBody task={task} close={close} onDone={onDone} />}
    </Popover>
  );
}

/** Remounts on every open, so the snooze step starts closed. */
function MenuBody({
  task,
  close,
  onDone,
}: {
  task: Task;
  close: () => void;
  onDone?: (action: TaskAction) => void;
}) {
  const { act } = useTasks(),
    [snoozing, setSnoozing] = useState(false),
    [custom, setCustom] = useState("");
  const run = (action: TaskAction) => {
    close();
    void act(task, action).then((ok) => ok && onDone?.(action));
  };
  if (snoozing) {
    const until = custom ? new Date(custom) : null;
    return (
      <div className="menu-list" role="group" aria-label="Snooze until">
        <div className="popover-title">Snooze until</div>
        {snoozePresets().map((preset) => (
          <button
            key={preset.label}
            type="button"
            className="menu-item"
            onClick={() => run({ kind: "snooze", until: preset.until.toISOString() })}
          >
            <span>{preset.label}</span>
            <span className="muted">{timeText(preset.until)}</span>
          </button>
        ))}
        <form
          className="menu-custom"
          onSubmit={(e) => {
            e.preventDefault();
            if (until && until.getTime() > Date.now()) {
              run({ kind: "snooze", until: until.toISOString() });
            }
          }}
        >
          <input
            type="datetime-local"
            aria-label="Snooze until a date and time"
            min={localInput(new Date())}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
          <button
            className="btn btn-sm"
            disabled={!until || until.getTime() <= Date.now()}
            type="submit"
          >
            Snooze
          </button>
        </form>
      </div>
    );
  }
  return (
    <div className="menu-list" role="group" aria-label="Task actions">
      <button
        type="button"
        className="menu-item"
        onClick={() => run({ kind: task.pinned ? "unpin" : "pin" })}
      >
        <Icon name="pin" size={14} />
        <span>{task.pinned ? "Unpin" : "Pin"}</span>
      </button>
      {!task.unseenOutcome && !task.needsUser && (
        <button type="button" className="menu-item" onClick={() => run({ kind: "mark_unread" })}>
          <Icon name="unread" size={14} />
          <span>Mark unread</span>
        </button>
      )}
      <button type="button" className="menu-item" onClick={() => setSnoozing(true)}>
        <Icon name="snooze" size={14} />
        <span>Snooze until…</span>
      </button>
      {task.status !== "settled" && (
        <button type="button" className="menu-item" onClick={() => run({ kind: "settle" })}>
          <Icon name="check" size={14} />
          <span>Settle</span>
        </button>
      )}
      <button type="button" className="menu-item" onClick={() => run({ kind: "archive" })}>
        <Icon name="archive" size={14} />
        <span>Archive</span>
      </button>
    </div>
  );
}
