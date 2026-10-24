import type { Task, TaskQueue, TaskQueueEntry } from "@passport/types";
import { type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { Feedback, Icon } from "../components/ui";
import { logger } from "../logger";
import { queueApi } from "./api";
import { useTasks } from "./store";

/** `ids` with the entry at `from` moved to index `to` (both within bounds). */
export function moveEntry<T>(ids: readonly T[], from: number, to: number): T[] {
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) {
    next.splice(Math.max(0, Math.min(next.length, to)), 0, moved);
  }
  return next;
}

/**
 * Follow-ups waiting behind the active run, above the composer (docs/tasks.md "Follow-up
 * queue"). Each row edits in place, drags (or Alt+↑/↓) to reorder, sends now as a steer, or goes
 * away. After Stop the queue is held until Resume.
 */
export function QueueStrip({ task, live }: { task: Task; live: boolean }) {
  const { get, upsert, trackRuns } = useTasks();
  const entries = task.queue ?? [];
  /** A reorder not answered yet, for the server order it was made from. */
  const [guess, setGuess] = useState<{ from: string; ids: string[] } | null>(null),
    [editing, setEditing] = useState<{ runId: string; text: string } | null>(null),
    [busy, setBusy] = useState<string | null>(null),
    [dragging, setDragging] = useState<string | null>(null),
    [over, setOver] = useState<number | null>(null),
    [error, setError] = useState("");
  const rows = useRef(new Map<string, HTMLLIElement>());
  /** The row to focus after the next render, and whether its text button had focus. */
  const focusAfter = useRef<string | null>(null),
    focusText = useRef(false),
    /** The row being edited; cleared first, so the blur after Enter or Escape does not save. */
    edited = useRef<string | null>(null);
  useEffect(() => {
    if (focusAfter.current) {
      const row = rows.current.get(focusAfter.current);
      ((focusText.current && row?.querySelector<HTMLElement>(".queue-text")) || row)?.focus();
      focusAfter.current = null;
      focusText.current = false;
    }
  });
  if (!entries.length) {
    return null;
  }
  const byId = new Map(entries.map((e) => [e.runId, e]));
  // A new queue from the server replaces the local guess.
  const serverOrder = entries.map((e) => e.runId);
  const order = guess && guess.from === serverOrder.join(",") ? guess.ids : serverOrder;
  const shown = order.map((id) => byId.get(id)).filter((e): e is TaskQueueEntry => !!e);
  const held = !!task.queueHeld;

  /** Apply a queue answer to the task row (the server also sends it as `task.updated`). */
  const apply = (queue: TaskQueue) => {
    const current = get(task.id) ?? task;
    upsert({ ...current, queue: queue.entries, queueHeld: queue.held });
  };
  const run = async (key: string, change: () => Promise<void>) => {
    setBusy(key);
    setError("");
    try {
      await change();
    } catch (e) {
      logger.warn("Queue change failed; reloading the queue");
      const gone = e instanceof ApiError && (e.code === "NOT_FOUND" || e.code === "QUEUE_CHANGED");
      setError(
        gone
          ? "The queue changed while you were editing it. This is the current order."
          : e instanceof Error
            ? e.message
            : "The queue did not change.",
      );
      setGuess(null);
      await queueApi
        .get(task.id)
        .then(apply)
        .catch(() => logger.warn("Queue reload failed"));
    } finally {
      setBusy(null);
    }
  };
  const reorder = (ids: string[]) => {
    if (ids.join(",") === shown.map((e) => e.runId).join(",")) {
      return;
    }
    setGuess({ from: serverOrder.join(","), ids });
    void run("reorder", async () => apply(await queueApi.reorder(task.id, ids)));
  };
  const edit = (entry: TaskQueueEntry) => {
    edited.current = entry.runId;
    setEditing({ runId: entry.runId, text: entry.text });
  };
  const stopEditing = () => {
    edited.current = null;
    setEditing(null);
  };
  const save = (entry: TaskQueueEntry, text: string) => {
    if (edited.current !== entry.runId) {
      return;
    }
    stopEditing();
    const value = text.trim();
    if (!value || value === entry.text) {
      return;
    }
    // Shown at once; the server's answer (or a reload on failure) replaces it.
    apply({
      taskId: task.id,
      held,
      entries: entries.map((e) => (e.runId === entry.runId ? { ...e, text: value } : e)),
    });
    void run(entry.runId, async () => apply(await queueApi.edit(task.id, entry.runId, value)));
  };
  const remove = (entry: TaskQueueEntry) =>
    run(entry.runId, async () => apply(await queueApi.remove(task.id, entry.runId)));
  const promote = (entry: TaskQueueEntry) =>
    run(entry.runId, async () => {
      const result = await queueApi.promote(task.id, entry.runId);
      upsert(result.task);
      trackRuns([result.run]);
    });
  const resume = () => run("resume", async () => apply(await queueApi.resume(task.id)));

  const ids = shown.map((e) => e.runId);
  const onRowKey = (event: KeyboardEvent<HTMLLIElement>, index: number) => {
    // Alt+↑/↓ anywhere in the row (its text button is where Tab lands), except while editing.
    const target = event.target as HTMLElement;
    if (!event.altKey || target.closest("textarea, input")) {
      return;
    }
    const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    const to = index + step;
    if (!step || to < 0 || to >= ids.length) {
      return;
    }
    event.preventDefault();
    focusAfter.current = ids[index] ?? null;
    focusText.current = target.classList.contains("queue-text");
    reorder(moveEntry(ids, index, to));
  };
  const onDragOver = (event: DragEvent<HTMLLIElement>, index: number) => {
    if (!dragging) {
      return;
    }
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    const after = box.height > 0 && event.clientY > box.top + box.height / 2;
    setOver(index + (after ? 1 : 0));
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const from = dragging ? ids.indexOf(dragging) : -1;
    if (from >= 0 && over !== null) {
      reorder(moveEntry(ids, from, over > from ? over - 1 : over));
    }
    setDragging(null);
    setOver(null);
  };

  return (
    <section className={`queue-strip ${held ? "held" : ""}`} aria-label="Queued messages">
      <div className="queue-strip-head">
        <span className="queue-strip-title">
          Queued <span className="count">{shown.length}</span>
        </span>
        {held ? (
          <span className="queue-held" role="status">
            Queue held
            <span aria-hidden="true"> · </span>
            <button
              type="button"
              className="link-btn"
              onClick={() => void resume()}
              disabled={busy === "resume"}
            >
              Resume
            </button>
          </span>
        ) : (
          <span className="muted">Runs after the current one, in this order</span>
        )}
      </div>
      <Feedback error={error} />
      <ol className="queue-rows" onDragLeave={() => setOver(null)}>
        {shown.map((entry, index) => {
          const isEditing = editing?.runId === entry.runId;
          const movable = !isEditing && shown.length > 1;
          const drop = dragging && over === index ? "drop-before" : "";
          const dropAfter = dragging && over === index + 1 && index === shown.length - 1;
          return (
            <li
              key={entry.runId}
              ref={(node) => {
                if (node) {
                  rows.current.set(entry.runId, node);
                } else {
                  rows.current.delete(entry.runId);
                }
              }}
              className={`queue-row ${dragging === entry.runId ? "dragging" : ""} ${drop} ${dropAfter ? "drop-after" : ""}`}
              data-queue-row={entry.runId}
              tabIndex={-1}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              onKeyDown={(event) => onRowKey(event, index)}
              draggable={movable}
              onDragStart={(event) => {
                event.dataTransfer?.setData("text/plain", entry.runId);
                if (event.dataTransfer) {
                  event.dataTransfer.effectAllowed = "move";
                }
                setDragging(entry.runId);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDragOver={(event) => onDragOver(event, index)}
              onDrop={onDrop}
            >
              <span
                className={`queue-grip ${movable ? "" : "fixed"}`}
                aria-hidden="true"
                title="Drag to reorder (Alt+↑ or Alt+↓ on the row)"
              >
                <Icon name="grip" size={14} />
              </span>
              {isEditing ? (
                <textarea
                  className="queue-edit"
                  aria-label="Edit queued message"
                  // biome-ignore lint/a11y/noAutofocus: editing starts from a click on this row
                  autoFocus
                  rows={Math.min(6, Math.max(1, editing.text.split("\n").length))}
                  value={editing.text}
                  maxLength={20_000}
                  onChange={(e) => setEditing({ runId: entry.runId, text: e.target.value })}
                  onBlur={() => save(entry, editing.text)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      focusAfter.current = entry.runId;
                      save(entry, editing.text);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      focusAfter.current = entry.runId;
                      stopEditing();
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="queue-text"
                  title="Edit"
                  aria-label={`Edit queued message: ${entry.text}`}
                  aria-description={movable ? "Alt+Up or Alt+Down moves it" : undefined}
                  onClick={() => edit(entry)}
                >
                  {entry.text}
                </button>
              )}
              <span className="queue-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={busy === entry.runId}
                  title={
                    live
                      ? "Stop the current run and send this now, with the message it was working on"
                      : "Send this now"
                  }
                  onClick={() => void promote(entry)}
                >
                  {live ? "Steer now" : "Send now"}
                </button>
                <button
                  type="button"
                  className="icon-btn tiny"
                  aria-label={`Remove queued message: ${entry.text}`}
                  title="Remove"
                  disabled={busy === entry.runId}
                  onClick={() => void remove(entry)}
                >
                  <Icon name="close" size={13} />
                </button>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
