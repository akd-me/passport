import { useEffect, useState } from "react";
import type { LlmConfig } from "@passport/types";
import { api, type AccountData } from "../api";
import { authHeaders } from "../auth";
import { useTask } from "../state";
import { useUi, type ThemePreference } from "../ui-state";
import { useAccounts } from "../accounts/AccountFilter";
import { Feedback, Icon } from "../components/ui";

const apiProviders: LlmConfig["provider"][] = [
  "anthropic",
  "openai",
  "openai-compatible",
  "ollama",
];
const apiProviderNames: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-compatible": "OpenAI-compatible",
  ollama: "Ollama (local)",
};

function ApiKeyProvider({ llm, demo }: { llm: AccountData["llm"]; demo: boolean }) {
  const usingApi = apiProviders.includes(llm.provider as LlmConfig["provider"]);
  const [provider, setProvider] = useState<LlmConfig["provider"]>(
      usingApi ? (llm.provider as LlmConfig["provider"]) : "anthropic",
    ),
    [model, setModel] = useState(usingApi ? llm.model : ""),
    [baseUrl, setBaseUrl] = useState(llm.baseUrl ?? ""),
    [fastModel, setFastModel] = useState(llm.fastModel ?? ""),
    task = useTask();
  return (
    <form
      className="settings-block"
      onSubmit={(e) => {
        e.preventDefault();
        void task.run(
          () => api.saveLlm({ provider, model, baseUrl, fastModel }),
          demo
            ? "Model preferences saved for this demo session."
            : "Model settings saved.",
        );
      }}
    >
      <h3>API-key model providers</h3>
      <p className="hint">
        Call a model endpoint directly instead of a host agent.{" "}
        {llm.apiKeyConfigured
          ? "An API key is configured on the server."
          : "Set PASSPORT_LLM_API_KEY in the server environment for cloud models."}{" "}
        Keys stay on the server and never reach the browser.
      </p>
      <div className="field-row">
        <label className="field">
          Provider
          <select
            value={provider}
            onChange={(e) =>
              setProvider(e.target.value as LlmConfig["provider"])
            }
          >
            {apiProviders.map((p) => (
              <option key={p} value={p}>
                {apiProviderNames[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Model
          <input
            value={model}
            required
            onChange={(e) => setModel(e.target.value)}
            placeholder="Model name"
          />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          Base URL
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
          />
        </label>
        <label className="field">
          Fast model (optional)
          <input
            value={fastModel}
            onChange={(e) => setFastModel(e.target.value)}
            placeholder="For lighter classification"
          />
        </label>
      </div>
      <Feedback error={task.error} />
      <div className="form-actions">
        <button className="btn" disabled={task.busy}>
          {task.busy ? "Saving…" : "Use this provider"}
        </button>
      </div>
    </form>
  );
}

function Appearance() {
  const { theme, setTheme } = useUi();
  return (
    <section className="settings-block">
      <h3>Appearance</h3>
      <div className="segmented" role="radiogroup" aria-label="Theme">
        {(["system", "light", "dark"] as ThemePreference[]).map((value) => (
          <button
            type="button"
            role="radio"
            aria-checked={theme === value}
            key={value}
            onClick={() => setTheme(value)}
          >
            <Icon name={value} size={14} />
            {value === "system" ? "Match system" : value === "light" ? "Light" : "Dark"}
          </button>
        ))}
      </div>
    </section>
  );
}

function DataAndAccess() {
  const [tokenPath, setTokenPath] = useState<string>(),
    { mode } = useAccounts(),
    task = useTask();
  useEffect(() => {
    let active = true;
    fetch("/api/auth/status", { credentials: "same-origin" })
      .then((r) => r.json() as Promise<{ tokenPath?: string }>)
      .then((s) => active && setTokenPath(s.tokenPath))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const dataDir = tokenPath?.replace(/[/\\][^/\\]+$/, "");
  return (
    <section className="settings-block">
      <h3>Data and access</h3>
      <dl className="facts">
        <dt>Workspace</dt>
        <dd>{mode === "demo" ? "Demo, in memory" : "Persistent, on this machine"}</dd>
        {dataDir && (
          <>
            <dt>Data directory</dt>
            <dd>
              <code>{dataDir}</code>
            </dd>
          </>
        )}
        <dt>API token</dt>
        <dd>
          {tokenPath ? <code>{tokenPath}</code> : "Stored in the data directory"}
          <small>
            Run <code>passport token</code> to print it. MCP clients use a
            separate token.
          </small>
        </dd>
      </dl>
      <Feedback error={task.error} />
      <div className="form-actions start">
        <button
          className="btn"
          disabled={task.busy}
          onClick={() =>
            task.run(async () => {
              await fetch("/api/auth/logout", {
                method: "POST",
                credentials: "same-origin",
                headers: authHeaders,
              });
              window.location.replace("/");
            }, "Signed out.")
          }
        >
          Sign out of this browser
        </button>
      </div>
    </section>
  );
}

/** Settings → Advanced. */
export function AdvancedSettings() {
  const { llm, mode } = useAccounts();
  return (
    <>
      <Appearance />
      {llm && (
        <ApiKeyProvider
          key={JSON.stringify(llm)}
          llm={llm}
          demo={mode === "demo"}
        />
      )}
      <DataAndAccess />
    </>
  );
}
