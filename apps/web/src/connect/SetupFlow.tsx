import { useState } from "react";
import { useAccounts } from "../accounts/AccountFilter";
import { AccountWizard } from "../accounts/AccountWizard";
import { ApiError, type ProviderDescriptor } from "../api";
import { Feedback, Icon, Loading } from "../components/ui";
import { logger } from "../logger";
import { type SetupProvider, setupApi } from "../setup-api";
import { useResource } from "../state";
import { useUi } from "../ui-state";
import { ProviderMark, TaskView } from "./SetupTaskView";
import { findActiveTask } from "./setup-session";
import { providerNames } from "./setup-task-model";

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
    [manual, setManual] = useState<{ note?: string } | null>(null),
    [starting, setStarting] = useState(false),
    [error, setError] = useState("");
  const { setup } = useUi(),
    task = setup.task;
  const start = async () => {
    setStarting(true);
    setError("");
    try {
      const { id } = await setupApi.start({ provider, calendar });
      setup.update(await setupApi.get(id));
    } catch (e) {
      // Automatic setup could not start.
      logger.warn("Automatic setup could not start");

      if (e instanceof ApiError && (e.status === 404 || e.status === 501)) {
        setManual({
          note: "Automatic setup is not available on this Passport server yet. Set the account up with your own OAuth client instead.",
        });
      } else if (e instanceof ApiError && e.code === "SETUP_BUSY") {
        const resumed = await resumeBusy();
        if (!resumed) {
          setError(e.message);
        }
      } else {
        setError(e instanceof Error ? e.message : "Setup could not start.");
      }
    } finally {
      setStarting(false);
    }
  };
  /** Another task already holds the slot (another tab, say): show that one instead. */
  const resumeBusy = async () => {
    try {
      const found = await findActiveTask();
      if (found) {
        setup.update(found);
      }
      return !!found;
    } catch {
      // The running task could not be listed; the busy error is shown instead.
      logger.warn("Running setup task could not be listed");
      return false;
    }
  };
  if (manual) {
    return (
      <ManualSetup
        note={manual.note}
        provider={provider}
        onBack={() => setManual(null)}
        onDone={onDone}
      />
    );
  }
  if (task) {
    return (
      <TaskView
        task={task}
        onUpdate={setup.update}
        onAnswered={setup.resolvePrompt}
        onDone={() => {
          setup.update(undefined);
          onDone();
        }}
        onManual={() => setManual({})}
        onRetry={() => {
          setup.update(undefined);
          void start();
        }}
      />
    );
  }
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
        <input type="checkbox" checked={calendar} onChange={(e) => setCalendar(e.target.checked)} />
        Connect calendar too
      </label>
      <p className="hint">
        Claude Code or Codex on this computer opens a browser, registers a private app in your{" "}
        {provider === "gmail" ? "Google" : "Microsoft"} account and connects it. You only sign in.
        Mail stays on this machine.
      </p>
      <Feedback error={error} />
      <div className="form-actions spread">
        <button type="button" className="link-btn" onClick={() => setManual({})}>
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
