import { useEffect, useState } from "react";
import { useAccounts } from "../accounts/AccountFilter";
import { ApiError, api, type HostAgent } from "../api";
import { Feedback, Icon, Loading } from "../components/ui";
import { useTask } from "../state";
import { useUi } from "../ui-state";

const hostAgents: Record<
  HostAgent["kind"],
  { name: string; signIn: string; models: string[]; placeholder: string }
> = {
  "claude-code": {
    name: "Claude Code",
    signIn: "claude",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    placeholder: "claude-sonnet-5-5",
  },
  codex: {
    name: "Codex",
    signIn: "codex login",
    models: [
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ],
    placeholder: "gpt-6.1-sol",
  },
};
export const providerLabel: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  anthropic: "Anthropic API",
  openai: "OpenAI API",
  "openai-compatible": "OpenAI-compatible",
  ollama: "Ollama",
};

type Detection =
  | { state: "loading" }
  | { state: "ready"; agents: HostAgent[] }
  | { state: "unsupported" }
  | { state: "error"; message: string };

function useHostAgents(): Detection {
  const [detection, setDetection] = useState<Detection>({ state: "loading" });
  useEffect(() => {
    let active = true;
    api
      .hostAgents()
      .then((agents) => active && setDetection({ state: "ready", agents }))
      .catch((error) => {
        if (!active) return;
        setDetection(
          error instanceof ApiError && error.status === 404
            ? { state: "unsupported" }
            : { state: "error", message: (error as Error).message },
        );
      });
    return () => {
      active = false;
    };
  }, []);
  return detection;
}

function agentStatus(agent: HostAgent | undefined) {
  if (!agent?.installed) return { tone: "off", text: "Not installed" };
  if (!agent.loggedIn)
    return {
      tone: "warn",
      text: `Installed${agent.version ? ` (${agent.version})` : ""}, not signed in`,
    };
  return {
    tone: "good",
    text: `Signed in${agent.account ? ` as ${agent.account}` : ""}${agent.version ? `, ${agent.version}` : ""}`,
  };
}

/** Settings → Model: drive Passport with the coding agent you already use. */
export function ModelSettings() {
  const { llm, mode } = useAccounts(),
    detection = useHostAgents(),
    { openSettings } = useUi(),
    task = useTask();
  const current = llm?.provider;
  const [choice, setChoice] = useState<HostAgent["kind"]>(
    current === "codex" ? "codex" : "claude-code",
  );
  const [model, setModel] = useState(
    current === "claude-code" || current === "codex" ? (llm?.model ?? "") : "",
  );
  const agents = detection.state === "ready" ? detection.agents : [];
  const selected = agents.find((a) => a.kind === choice);
  return (
    <>
      <section className="settings-block">
        <h3>Current model</h3>
        <div className="current-model">
          <Icon name="agent" size={18} />
          <div>
            <strong>{current ? (providerLabel[current] ?? current) : "Not set"}</strong>
            <span className="muted">{llm?.model}</span>
          </div>
          {mode === "demo" ? (
            <span className="badge">Demo: no model calls</span>
          ) : llm?.configured === false ? (
            <span className="badge warn">Not ready</span>
          ) : (
            <span className="badge good">Ready</span>
          )}
        </div>
        {mode === "demo" && (
          <p className="hint">
            The demo workspace uses a built-in toy agent. Choices here are saved for the session
            only.
          </p>
        )}
        {llm?.selection === "auto" ? (
          <p className="hint">
            Chosen automatically: Codex first, then Claude Code, then any API provider you
            configured.
          </p>
        ) : (
          <div className="form-actions">
            <button
              type="button"
              className="btn"
              disabled={task.busy}
              onClick={() =>
                void task.run(
                  () => api.saveLlm({ provider: "auto" }),
                  "Passport will pick the best available agent at startup.",
                )
              }
            >
              Choose automatically
            </button>
          </div>
        )}
      </section>
      <section className="settings-block">
        <h3>Use an agent on this computer</h3>
        <p className="hint">
          Passport can work through Claude Code or Codex with the account you are already signed in
          to. No API key needed.
        </p>
        {detection.state === "loading" && <Loading label="Looking for agents…" />}
        {detection.state === "unsupported" && (
          <p className="note">
            <Icon name="alert" size={15} />
            This Passport server cannot detect host agents yet. Update Passport, or use an API key
            under{" "}
            <button type="button" className="link-btn" onClick={() => openSettings("advanced")}>
              Advanced
            </button>
          </p>
        )}
        {detection.state === "error" && <Feedback error={detection.message} />}
        {detection.state === "ready" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void task.run(
                () =>
                  api.saveLlm({
                    provider: choice,
                    ...(model.trim() ? { model: model.trim() } : {}),
                  }),
                `Passport now works through ${hostAgents[choice].name}.`,
              );
            }}
          >
            <div className="agent-choice" role="radiogroup" aria-label="Host agent">
              {(Object.keys(hostAgents) as HostAgent["kind"][]).map((kind) => {
                const agent = agents.find((a) => a.kind === kind),
                  status = agentStatus(agent);
                return (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={choice === kind}
                    key={kind}
                    disabled={!agent?.installed}
                    className={`agent-option ${choice === kind ? "active" : ""}`}
                    onClick={() => {
                      setChoice(kind);
                      setModel(current === kind ? (llm?.model ?? "") : "");
                    }}
                  >
                    <strong>
                      {hostAgents[kind].name}
                      {current === kind && <span className="badge ink">In use</span>}
                    </strong>
                    <small className={`agent-status ${status.tone}`}>
                      <span className="status-dot" aria-hidden="true" />
                      {status.text}
                    </small>
                    {agent?.binaryPath && <small className="muted path">{agent.binaryPath}</small>}
                  </button>
                );
              })}
            </div>
            {selected?.installed && !selected.loggedIn && (
              <p className="note">
                <Icon name="key" size={15} />
                Run <code>{hostAgents[choice].signIn}</code> in a terminal to sign in, then reopen
                this panel.
              </p>
            )}
            <label className="field">
              Model
              <input
                list={`models-${choice}`}
                value={model}
                placeholder={hostAgents[choice].placeholder}
                onChange={(e) => setModel(e.target.value)}
              />
              <datalist id={`models-${choice}`}>
                {hostAgents[choice].models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
            <Feedback error={task.error} />
            <div className="form-actions">
              <button
                className="btn btn-primary"
                disabled={task.busy || !selected?.installed || !selected.loggedIn}
              >
                {task.busy ? "Saving…" : `Use ${hostAgents[choice].name}`}
              </button>
            </div>
          </form>
        )}
      </section>
    </>
  );
}
