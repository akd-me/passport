import { useState } from "react";
import "../accounts/accounts.css";
import type { Account, LlmConfig } from "@passport/types";
import { api, type AccountData, type ProviderDescriptor } from "../api";
import { AccountWizard } from "../accounts/AccountWizard";
import { AccountRow } from "../accounts/AccountRow";
import { DoctorCard } from "../accounts/DoctorCard";
import { ModelCard } from "../accounts/ModelCard";
import type { ConnectedAccount } from "../accounts/api";
import { useResource, useTask } from "../state";
import { Badge, Feedback, Icon, Loading, PageHeader } from "../components/ui";
function LlmSettings({
  llm,
  demo,
}: {
  llm: AccountData["llm"];
  demo: boolean;
}) {
  const [provider, setProvider] = useState(llm.provider),
    [model, setModel] = useState(llm.model),
    [baseUrl, setBaseUrl] = useState(llm.baseUrl ?? ""),
    [fastModel, setFastModel] = useState(llm.fastModel ?? ""),
    task = useTask();
  return (
    <form
      className="panel settings-panel"
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
      <div className="panel-heading">
        <div>
          <h2>Bring your own model.</h2>
          <p className="subtle">A familiar model, working on your behalf.</p>
        </div>
        <Icon name="sparkle" size={24} />
      </div>
      {demo && (
        <div className="info-note">
          Demo mode uses a local toy agent. These preferences are editable; no
          model calls are made.
        </div>
      )}
      {!demo && !llm.configured && (
        <div className="info-note">
          LLM not configured. Set an API key on the server or choose a local
          model to enable the agent.
        </div>
      )}
      <div className="form-columns">
        <label>
          Model provider
          <select
            value={provider}
            onChange={(e) =>
              setProvider(e.target.value as LlmConfig["provider"])
            }
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="openai-compatible">OpenAI-compatible</option>
            <option value="ollama">Ollama · local</option>
            <option value="codex">Codex · subscription</option>
            <option value="claude-code">Claude Code · subscription</option>
          </select>
        </label>
        <label>
          Model
          <input
            value={model}
            required
            onChange={(e) => setModel(e.target.value)}
            placeholder="Model name"
          />
        </label>
      </div>
      <div className="form-columns">
        <label>
          Base URL
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
          />
        </label>
        <label>
          Fast model <span className="subtle">(optional)</span>
          <input
            value={fastModel}
            onChange={(e) => setFastModel(e.target.value)}
            placeholder="For lighter classification work"
          />
        </label>
      </div>
      <p className="subtle">
        {llm.apiKeyConfigured
          ? "An API key is configured on the server."
          : "For cloud models, set PASSPORT_LLM_API_KEY in the server environment."}{" "}
        Keys stay on the server and are never returned to the browser.
      </p>
      <Feedback error={task.error} />
      <button className="button secondary" disabled={task.busy}>
        {task.busy ? "Saving…" : "Save model settings"}
      </button>
    </form>
  );
}
function ProfileEditor({ markdown }: { markdown: string }) {
  const [body, setBody] = useState(markdown),
    task = useTask();
  return (
    <form
      className="panel settings-panel"
      onSubmit={(e) => {
        e.preventDefault();
        void task.run(
          () => api.saveProfile(body),
          "Your standing instructions are saved.",
        );
      }}
    >
      <div className="panel-heading">
        <div>
          <h2>A little about how you work.</h2>
          <p className="subtle">
            Your tone, preferences, and standing instructions.
          </p>
        </div>
        <Badge>USER.md</Badge>
      </div>
      <label className="sr-only" htmlFor="user-profile">
        USER.md standing instructions
      </label>
      <textarea
        id="user-profile"
        className="profile-editor"
        rows={12}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        spellCheck={false}
      />
      <div className="profile-footer">
        <span className="subtle">Plain Markdown. Always yours to change.</span>
        <button className="button primary" disabled={task.busy}>
          {task.busy ? "Saving…" : "Save instructions"}
        </button>
      </div>
      <Feedback error={task.error} />
    </form>
  );
}
export function Accounts() {
  const accounts = useResource<
      Omit<AccountData, "accounts"> & { accounts: ConnectedAccount[] }
    >("/accounts"),
    providers = useResource<ProviderDescriptor[]>("/providers"),
    profile = useResource<{ markdown: string }>("/user-profile"),
    [adding, setAdding] = useState(false),
    [reauthorizing, setReauthorizing] = useState<Account>();
  return (
    <>
      <PageHeader
        eyebrow="MAKE YOURSELF AT HOME"
        title="Your workspace. Your way."
        description="Connect your accounts and give Passport a sense of how you work."
      >
        <button
          className="button primary"
          onClick={() => {
            setReauthorizing(undefined);
            setAdding(!adding);
          }}
          disabled={!providers.data?.length}
        >
          <Icon name="plus" size={16} />
          Add account
        </button>
      </PageHeader>
      <Feedback error={accounts.error ?? providers.error ?? profile.error} />
      {!accounts.data ? (
        !accounts.error && <Loading />
      ) : (
        <>
          {accounts.data.mode === "demo" && (
            <div className="demo-banner">
              <Icon name="sparkle" size={19} />
              <span>
                You’re in the demo workspace. Explore freely — all changes stay
                in memory and reset when the server restarts.
              </span>
              <Badge tone="green">Demo</Badge>
            </div>
          )}
          <section className="panel">
            <div className="panel-heading">
              <h2>Connected accounts</h2>
              <span className="subtle">
                {accounts.data.accounts.length} connected
              </span>
            </div>
            {accounts.data.accounts.map((a) => (
              <AccountRow
                key={a.id}
                account={a}
                reauthorize={() => {
                  setReauthorizing(
                    accounts.data?.accounts.find(
                      (item) => item.id === a.settings.mailAccountId,
                    ) ?? a,
                  );
                  setAdding(true);
                }}
              />
            ))}
          </section>
          {(adding || !accounts.data.accounts.length) && providers.data && (
            <AccountWizard
              key={reauthorizing?.id ?? "new"}
              account={reauthorizing}
              accounts={accounts.data.accounts}
              providers={providers.data}
              onClose={() => {
                setAdding(false);
                setReauthorizing(undefined);
              }}
            />
          )}
          <DoctorCard />
          <ModelCard llm={accounts.data.llm} demo={accounts.data.mode === "demo"} />
          <LlmSettings
            key={JSON.stringify(accounts.data.llm)}
            llm={accounts.data.llm}
            demo={accounts.data.mode === "demo"}
          />
          {profile.data && <ProfileEditor markdown={profile.data.markdown} />}
        </>
      )}
    </>
  );
}
