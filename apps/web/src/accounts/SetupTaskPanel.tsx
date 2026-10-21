import { useEffect, useState } from "react";
import type { SetupProvider, SetupTask } from "@passport/types";
import { useWorkspace } from "../state";
import { isSetupTaskFinished, setupApi } from "../setup-api";

const MARK = { pending: "○", running: "…", done: "✓", failed: "✗" } as const;

/**
 * Minimal, deliberately unstyled panel for agent-driven setup: start a task, follow its
 * steps and log, answer its prompts, cancel. The UI redesign replaces the presentation.
 */
export function SetupTaskPanel({
  provider,
  calendar,
}: {
  provider: SetupProvider;
  calendar: boolean;
}) {
  const [task, setTask] = useState<SetupTask>();
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { refresh } = useWorkspace();
  const id = task?.id,
    finished = task ? isSetupTaskFinished(task) : true;
  useEffect(() => {
    if (!id || finished) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const next = await setupApi.get(id);
        if (stopped) return;
        setTask(next);
        if (next.status === "completed") refresh();
      } catch {
        /* Keep the last known state; the next poll retries. */
      }
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [id, finished, refresh]);
  const act = async (action: () => Promise<SetupTask | void>) => {
    setBusy(true);
    setError("");
    try {
      const next = await action();
      if (next) setTask(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };
  const respond = (value: string) =>
    act(async () => {
      if (!task?.prompt) return;
      const next = await setupApi.respond(task.id, task.prompt.id, value);
      setAnswer("");
      return next;
    });
  return (
    <section aria-label="Set up with my agent">
      <p>
        <button
          type="button"
          className="button secondary"
          disabled={busy || !finished}
          onClick={() =>
            act(async () => {
              const { id } = await setupApi.start({ provider, calendar });
              return setupApi.get(id);
            })
          }
        >
          Set up with my agent
        </button>{" "}
        Your agent opens a browser, creates the OAuth client for you and asks
        you to sign in and approve.
      </p>
      {error && <p role="alert">{error}</p>}
      {task && (
        <div role="status">
          <p>Status: {task.status.replace(/_/g, " ")}</p>
          <ol>
            {task.steps.map((step) => (
              <li key={step.id}>
                {MARK[step.status]} {step.title}
                {step.detail ? ` — ${step.detail}` : ""}
              </li>
            ))}
          </ol>
          {task.prompt && (
            <div>
              <p>
                <strong>{task.prompt.message}</strong>
              </p>
              {task.prompt.kind === "question" ? (
                <>
                  <input
                    aria-label="Answer"
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      if (answer.trim()) void respond(answer);
                    }}
                  />{" "}
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy || !answer.trim()}
                    onClick={() => respond(answer)}
                  >
                    Send
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="button primary"
                  disabled={busy}
                  onClick={() => respond("done")}
                >
                  Continue
                </button>
              )}
            </div>
          )}
          {task.error && <p role="alert">{task.error}</p>}
          {task.status === "completed" && (
            <p>Connected. The first sync is running.</p>
          )}
          {!finished && (
            <button
              type="button"
              className="button text"
              disabled={busy}
              onClick={() => act(() => setupApi.cancel(task.id))}
            >
              Cancel setup
            </button>
          )}
          <details>
            <summary>Agent log</summary>
            <ul>
              {task.log.map((line, index) => (
                <li key={`${line.at}-${index}`}>
                  {line.level === "info" ? "" : `${line.level}: `}
                  {line.text}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}
