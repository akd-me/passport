import { useEffect, useState } from "react";
import { ApiError, type ProviderDescriptor } from "../api";
import {
  isFinished,
  setupApi,
  type SetupProvider,
  type SetupStep,
  type SetupTask,
} from "../setup-api";
import { useResource, useWorkspace, useWorkspaceEvents } from "../state";
import { useAccounts } from "../accounts/AccountFilter";
import { AccountWizard } from "../accounts/AccountWizard";
import { Feedback, Icon, Loading } from "../components/ui";

const providerNames: Record<SetupProvider, string> = {
  gmail: "Gmail",
  microsoft: "Outlook",
};

function ProviderMark({ provider }: { provider: SetupProvider }) {
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
  const name =
    status === "done"
      ? "check"
      : status === "running"
        ? "spinner"
        : status === "failed"
          ? "alert"
          : "";
  return (
    <span className={`step-icon ${status}`} aria-hidden="true">
      {name && <Icon name={name} size={13} />}
    </span>
  );
}

/** Respond and cancel may echo the updated task; apply it without waiting for a poll. */
const asTask = (value: unknown) =>
  value && typeof value === "object" && "steps" in value
    ? (value as SetupTask)
    : undefined;

function TaskView({
  task,
  onUpdate,
  onRetry,
  onManual,
  onDone,
}: {
  task: SetupTask;
  onUpdate: (task: SetupTask) => void;
  onRetry: () => void;
  onManual: () => void;
  onDone: () => void;
}) {
  const [answer, setAnswer] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const { accounts } = useAccounts();
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      const next = asTask(await fn());
      if (next) onUpdate(next);
      setAnswer("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not go through.");
    } finally {
      setBusy(false);
    }
  };
  const respond = (value: string) =>
    act(() => setupApi.respond(task.id, task.prompt!.id, value));
  const connected = accounts.filter((a) =>
    task.result?.accountIds.includes(a.id),
  );
  const name = providerNames[task.provider];
  return (
    <div className="setup-task">
      <div className="setup-heading">
        <ProviderMark provider={task.provider} />
        <div>
          <h3>
            {task.status === "completed"
              ? `${name} is connected`
              : task.status === "failed"
                ? `${name} could not be connected`
                : task.status === "cancelled"
                  ? "Setup cancelled"
                  : `Connecting ${name}`}
          </h3>
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
        {task.steps.map((step) => (
          <li key={step.id} className={step.status}>
            <StepIcon status={step.status} />
            <div>
              <span>{step.title}</span>
              {step.detail && <small>{step.detail}</small>}
            </div>
            <span className="sr-only">
              {step.status === "done"
                ? "Done"
                : step.status === "running"
                  ? "In progress"
                  : step.status === "failed"
                    ? "Failed"
                    : "Not started"}
            </span>
          </li>
        ))}
      </ol>
      {task.status === "waiting_for_user" && task.prompt && (
        <div className="setup-prompt" role="alert">
          <Icon
            name={task.prompt.kind === "sign_in" ? "external" : "agent"}
            size={18}
          />
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
                  if (answer.trim()) void respond(answer.trim());
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
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => respond("yes")}
                >
                  Yes, continue
                </button>
                <button className="btn" disabled={busy} onClick={() => respond("no")}>
                  No
                </button>
              </div>
            ) : (
              <div className="form-actions start">
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => respond("done")}
                >
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

function ManualSetup({
  note,
  provider,
  onBack,
  onDone,
}: {
  note?: string;
  provider: SetupProvider;
  onBack: () => void;
  onDone: () => void;
}) {
  const providers = useResource<ProviderDescriptor[]>("/providers"),
    { accounts } = useAccounts();
  return (
    <div className="manual">
      {note && (
        <p className="note" role="status">
          <Icon name="alert" size={15} />
          {note}
        </p>
      )}
      <Feedback error={providers.error} />
      {!providers.data ? (
        !providers.error && <Loading />
      ) : (
        <AccountWizard
          title="Set up manually"
          initialKind={provider === "gmail" ? "gmail" : "graph"}
          providers={providers.data}
          accounts={accounts}
          onClose={onDone}
        />
      )}
      <button type="button" className="link-btn" onClick={onBack}>
        Back to automatic setup
      </button>
    </div>
  );
}

/**
 * Connect an account: pick a provider, then a host agent (Claude Code or Codex) registers
 * the OAuth client and connects it, asking you only to sign in.
 */
export function SetupFlow({ onDone }: { onDone: () => void }) {
  const [provider, setProvider] = useState<SetupProvider>("gmail"),
    [calendar, setCalendar] = useState(true),
    [task, setTask] = useState<SetupTask>(),
    [manual, setManual] = useState<{ note?: string } | null>(null),
    [starting, setStarting] = useState(false),
    [error, setError] = useState("");
  const { refresh } = useWorkspace();
  useWorkspaceEvents((event) => {
    if (event.type !== "setup.task.updated") return;
    const next = event.task as SetupTask;
    if (next?.id && next.id === task?.id) setTask(next);
  });
  const id = task?.id,
    finished = task ? isFinished(task) : true;
  useEffect(() => {
    // The WebSocket is the fast path; polling covers a missed frame or a reconnect.
    if (!id || finished) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const next = await setupApi.get(id);
        if (!stopped) setTask(next);
      } catch {
        /* Keep the last known state; the next tick retries. */
      }
    }, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [id, finished]);
  useEffect(() => {
    if (task?.status === "completed") refresh();
  }, [task?.status, refresh]);
  const start = async () => {
    setStarting(true);
    setError("");
    try {
      const { id } = await setupApi.start({ provider, calendar });
      setTask(await setupApi.get(id));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 501))
        setManual({
          note: "Automatic setup is not available on this Passport server yet. Set the account up with your own OAuth client instead.",
        });
      else setError(e instanceof Error ? e.message : "Setup could not start.");
    } finally {
      setStarting(false);
    }
  };
  if (manual)
    return (
      <ManualSetup
        note={manual.note}
        provider={provider}
        onBack={() => setManual(null)}
        onDone={onDone}
      />
    );
  if (task)
    return (
      <TaskView
        task={task}
        onUpdate={setTask}
        onDone={onDone}
        onManual={() => setManual({})}
        onRetry={() => {
          setTask(undefined);
          void start();
        }}
      />
    );
  return (
    <div className="setup-start">
      <div className="provider-choice" role="radiogroup" aria-label="Provider">
        {(["gmail", "microsoft"] as const).map((p) => (
          <button
            type="button"
            role="radio"
            aria-checked={provider === p}
            key={p}
            className={`provider-option ${provider === p ? "active" : ""}`}
            onClick={() => setProvider(p)}
          >
            <ProviderMark provider={p} />
            <span>
              <strong>{p === "gmail" ? "Google" : "Microsoft"}</strong>
              <small>
                {p === "gmail"
                  ? "Gmail and Google Workspace"
                  : "Outlook, Hotmail and Microsoft 365"}
              </small>
            </span>
          </button>
        ))}
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={calendar}
          onChange={(e) => setCalendar(e.target.checked)}
        />
        Connect calendar too
      </label>
      <p className="hint">
        Claude Code or Codex on this computer opens a browser, registers a
        private app in your {provider === "gmail" ? "Google" : "Microsoft"}{" "}
        account and connects it. You only sign in. Mail stays on this machine.
      </p>
      <Feedback error={error} />
      <div className="form-actions spread">
        <button
          type="button"
          className="link-btn"
          onClick={() => setManual({})}
        >
          Set up manually
        </button>
        <button
          type="button"
          className="btn btn-primary btn-lg"
          disabled={starting}
          onClick={() => void start()}
        >
          {starting && <Icon name="spinner" size={15} />}
          Connect {providerNames[provider]}
        </button>
      </div>
    </div>
  );
}
