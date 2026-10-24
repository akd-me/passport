import type { Task } from "@passport/types";
import { useRef, useState } from "react";
import { Feedback } from "../components/ui";
import { logger } from "../logger";
import { taskApi } from "./api";
import { useTasks } from "./store";

/**
 * The task page title, renamed in place: click it, type, Enter saves and Escape cancels. A title
 * the fast model proposed (`titleGenerated`) stays muted until the person renames it.
 */
export function TaskTitle({ task }: { task: Task }) {
  const { upsert } = useTasks(),
    [draft, setDraft] = useState<string | null>(null),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  /** Cleared first, so the blur that follows Enter or Escape does nothing more. */
  const open = useRef(false);
  const start = () => {
    open.current = true;
    setError("");
    setDraft(task.title);
  };
  const cancel = () => {
    open.current = false;
    setDraft(null);
  };
  const save = async (value: string) => {
    if (!open.current) {
      return;
    }
    cancel();
    const title = value.trim();
    if (!title || (title === task.title && !task.titleGenerated)) {
      return;
    }
    setSaving(true);
    try {
      upsert(await taskApi.patch(task.id, { title }));
    } catch (e) {
      logger.warn("Task rename failed");
      setError(e instanceof Error ? e.message : "The title did not save.");
    } finally {
      setSaving(false);
    }
  };
  if (draft !== null) {
    return (
      <h1 className="task-title-edit">
        <input
          aria-label="Task title"
          // biome-ignore lint/a11y/noAutofocus: renaming starts from a click on the title
          autoFocus
          maxLength={200}
          value={draft}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save(draft)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void save(draft);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              cancel();
            }
          }}
        />
      </h1>
    );
  }
  const generated = !!task.titleGenerated;
  return (
    <>
      <h1>
        <button
          type="button"
          className={`task-title-btn ${generated ? "generated" : ""} ${saving ? "saving" : ""}`}
          title={generated ? "Title suggested by Passport. Click to rename" : "Click to rename"}
          onClick={start}
        >
          {task.title}
        </button>
      </h1>
      <Feedback error={error} />
    </>
  );
}
