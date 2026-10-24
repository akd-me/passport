import type { Task } from "@passport/types";
import { useState } from "react";
import { ApiError } from "../api";
import { Feedback, Icon } from "../components/ui";
import { logger } from "../logger";
import { taskApi } from "./api";
import { useTasks } from "./store";

/** "today at 3:40 PM", "Fri 3:40 PM": when a usage limit resets, in local time. */
export function resetText(at: string, now = new Date()) {
  const when = new Date(at);
  const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return when.toDateString() === now.toDateString()
    ? `today at ${time}`
    : `${when.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}

export const isLimited = (task: Task) => task.needsUser === "limited" || !!task.limited;

/**
 * A task stopped at a usage limit (docs/tasks.md "Usage limits"): when it resets, and the three
 * ways back: resume now, resume at the reset, or snooze until then. Shown in the task header and
 * on Needs you.
 */
export function LimitedActions({ task, compact = false }: { task: Task; compact?: boolean }) {
  const { upsert, trackRuns, act } = useTasks(),
    [busy, setBusy] = useState<"resume" | "reset" | "snooze" | null>(null),
    [error, setError] = useState("");
  if (!isLimited(task)) {
    return null;
  }
  const resetAt = task.limited?.resetAt ?? null;
  const ahead = !!resetAt && Date.parse(resetAt) > Date.now();
  const auto = !!task.limited?.autoResume;
  const attempt = async (kind: "resume" | "reset" | "snooze", change: () => Promise<unknown>) => {
    setBusy(kind);
    setError("");
    try {
      await change();
    } catch (e) {
      logger.warn("Usage-limit recovery failed");
      setError(
        e instanceof ApiError && e.code === "NOT_LIMITED"
          ? "This task is no longer paused."
          : e instanceof ApiError && e.code === "RESET_UNKNOWN"
            ? "The reset time is not known; resume it now or snooze it instead."
            : e instanceof Error
              ? e.message
              : "That did not work.",
      );
    } finally {
      setBusy(null);
    }
  };
  const resume = () =>
    attempt("resume", async () => {
      const result = await taskApi.resume(task.id);
      upsert(result.task);
      if (result.run) {
        trackRuns([result.run]);
      }
    });
  const atReset = () => attempt("reset", async () => upsert(await taskApi.resumeAtReset(task.id)));
  const snooze = () =>
    attempt("snooze", async () => {
      if (resetAt) {
        await act(task, { kind: "snooze", until: resetAt });
      }
    });
  return (
    <div className={`limited-actions ${compact ? "compact" : ""}`}>
      <span className="limited-when">
        {!compact && <Icon name="limit" size={13} />}
        {auto && resetAt
          ? `Resumes on its own ${resetText(resetAt)}`
          : `${compact ? "" : "Paused at a usage limit. "}${
              resetAt
                ? `${ahead ? "Resets" : "Reset"} ${resetText(resetAt)}`
                : "The reset time is not known"
            }`}
      </span>
      <span className="limited-buttons">
        <button
          type="button"
          className="btn btn-sm"
          disabled={!!busy}
          onClick={() => void resume()}
        >
          <Icon name={busy === "resume" ? "spinner" : "play"} size={12} />
          Resume
        </button>
        {resetAt && ahead && !auto && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={!!busy}
            onClick={() => void atReset()}
          >
            Resume at reset
          </button>
        )}
        {resetAt && ahead && task.status !== "snoozed" && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={!!busy}
            onClick={() => void snooze()}
          >
            <Icon name="snooze" size={12} />
            Snooze until reset
          </button>
        )}
      </span>
      <Feedback error={error} />
    </div>
  );
}

/** The Needs you row's version: the reset time and the actions, without the repeated status. */
export function LimitedRowActions({ task }: { task: Task }) {
  return <LimitedActions task={task} compact />;
}
