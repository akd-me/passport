import { useState } from "react";
import { useAccounts } from "../accounts/AccountFilter";
import { Feedback, Icon } from "../components/ui";
import { logger } from "../logger";
import {
  isFinished,
  type SetupProvider,
  type SetupStep,
  type SetupTask,
  setupApi,
} from "../setup-api";
import { asTask, providerNames } from "./setup-task-model";

export function ProviderMark({ provider }: { provider: SetupProvider }) {
  return provider === "gmail" ? (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path fill="#4285F4" d="M3 7.2V18a1.5 1.5 0 0 0 1.5 1.5H7V10.6L3 7.2Z" />
      <path fill="#34A853" d="M17 19.5h2.5A1.5 1.5 0 0 0 21 18V7.2l-4 3.4v8.9Z" />
      <path fill="#FBBC04" d="M17 5.6v5l4-3.4V6.4c0-1.7-1.9-2.6-3.2-1.6L17 5.6Z" />
      <path fill="#EA4335" d="M7 10.6v-5l5 3.8 5-3.8v5l-5 3.8-5-3.8Z" />
      <path fill="#C5221F" d="M3 6.4v.8l4 3.4v-5l-.8-.8C4.9 3.8 3 4.7 3 6.4Z" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect x="3" y="3" width="8.5" height="8.5" fill="#F25022" />
      <rect x="12.5" y="3" width="8.5" height="8.5" fill="#7FBA00" />
      <rect x="3" y="12.5" width="8.5" height="8.5" fill="#00A4EF" />
      <rect x="12.5" y="12.5" width="8.5" height="8.5" fill="#FFB900" />
    </svg>
  );
}

function StepIcon({ status }: { status: SetupStep["status"] }) {
  function stepIcon() {
    if (status === "done") {
      return "check";
    }
    if (status === "running") {
      return "spinner";
    }
    if (status === "failed") {
      return "alert";
    }
    return "";
  }
  const name = stepIcon();
  return (
    <span className={`step-icon ${status}`} aria-hidden="true">
      {name && <Icon name={name} size={13} />}
    </span>
  );
}

export function TaskView({
  task,
  onUpdate,
  onAnswered,
  onRetry,
  onManual,
  onDone,
}: {
  task: SetupTask;
  onUpdate: (task: SetupTask) => void;
  /** The server accepted an answer to this prompt. */
  onAnswered?: (promptId: string) => void;
  onRetry: () => void;
  onManual: () => void;
  onDone: () => void;
}) {
  const [answer, setAnswer] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const { accounts } = useAccounts();
  const act = async (fn: () => Promise<unknown>, answering?: string) => {
    setBusy(true);
    setError("");
    try {
      const next = asTask(await fn());
      if (answering) {
        onAnswered?.(answering);
      }
      if (next) {
        onUpdate(next);
      }
      setAnswer("");
    } catch (e) {
      // Setup response failed.
      logger.warn("Setup response failed");

      setError(e instanceof Error ? e.message : "That did not go through.");
    } finally {
      setBusy(false);
    }
  };
  const respond = async (value: string) => {
    const promptId = task.prompt?.id;
    if (promptId) {
      await act(() => setupApi.respond(task.id, promptId, value), promptId);
    }
  };
  const connected = accounts.filter((a) => task.result?.accountIds.includes(a.id));
  const name = providerNames[task.provider];
  function setupTitle() {
    if (task.status === "completed") {
      return `${name} is connected`;
    }
    if (task.status === "failed") {
      return `${name} could not be connected`;
    }
    if (task.status === "cancelled") {
      return "Setup cancelled";
    }
    return `Connecting ${name}`;
  }
  return (
    <div className="setup-task">
      <div className="setup-heading">
        <ProviderMark provider={task.provider} />
        <div>
          <h3>{setupTitle()}</h3>
          <p className="hint">
            {task.status === "completed"
              ? "The first sync is running. Proposals will appear in your queue."
              : isFinished(task)
                ? "Nothing was saved. You can try again or set it up by hand."
                : "Your host agent is doing the setup. This takes a minute or two."}
          </p>
        </div>
      </div>
      <ol className="steps" aria-label="Setup progress">
        {task.steps.map((step) => {
          function stepStatusLabel() {
            if (step.status === "done") {
              return "Done";
            }
            if (step.status === "running") {
              return "In progress";
            }
            if (step.status === "failed") {
              return "Failed";
            }
            return "Not started";
          }
          return (
            <li key={step.id} className={step.status}>
              <StepIcon status={step.status} />
              <div>
                <span>{step.title}</span>
                {step.detail && <small>{step.detail}</small>}
              </div>
              <span className="sr-only">{stepStatusLabel()}</span>
            </li>
          );
        })}
      </ol>
      {task.status === "waiting_for_user" && task.prompt && (
        <div className="setup-prompt" role="alert">
          <Icon name={task.prompt.kind === "sign_in" ? "external" : "agent"} size={18} />
          <div>
            <strong>
              {task.prompt.kind === "sign_in"
                ? "Sign in in the browser window, then continue"
                : task.prompt.kind === "confirm"
                  ? "Your agent needs a yes or no"
                  : "Your agent has a question"}
            </strong>
            <p>{task.prompt.message}</p>
            {task.prompt.kind === "question" ? (
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (answer.trim()) {
                    void respond(answer.trim());
                  }
                }}
              >
                <input
                  aria-label="Your answer"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  autoFocus
                />
                <button className="btn btn-primary" disabled={busy || !answer.trim()}>
                  Send answer
                </button>
              </form>
            ) : task.prompt.kind === "confirm" ? (
              <div className="form-actions start">
                <button className="btn btn-primary" disabled={busy} onClick={() => respond("yes")}>
                  Yes, continue
                </button>
                <button className="btn" disabled={busy} onClick={() => respond("no")}>
                  No
                </button>
              </div>
            ) : (
              <div className="form-actions start">
                <button className="btn btn-primary" disabled={busy} onClick={() => respond("done")}>
                  I’ve signed in, continue
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {task.status === "completed" && !!connected.length && (
        <ul className="connected-list">
          {connected.map((a) => (
            <li key={a.id}>
              <Icon name="check" size={14} />
              {a.emailAddress}
            </li>
          ))}
        </ul>
      )}
      <Feedback error={error || (task.status === "failed" ? task.error : undefined)} />
      {!!task.log.length && (
        <details className="setup-log">
          <summary>Agent log</summary>
          <ol>
            {task.log.map((line, i) => (
              <li key={i} className={line.level}>
                <time>
                  {new Date(line.at).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </time>
                {line.text}
              </li>
            ))}
          </ol>
        </details>
      )}
      <div className="form-actions">
        {task.status === "completed" ? (
          <button className="btn btn-primary" onClick={onDone} autoFocus>
            Done
          </button>
        ) : isFinished(task) ? (
          <>
            <button className="btn btn-ghost" onClick={onManual}>
              Set up manually
            </button>
            <button className="btn btn-primary" onClick={onRetry}>
              Try again
            </button>
          </>
        ) : (
          <button
            className="btn"
            disabled={busy}
            onClick={() => act(() => setupApi.cancel(task.id))}
          >
            Cancel setup
          </button>
        )}
      </div>
    </div>
  );
}
