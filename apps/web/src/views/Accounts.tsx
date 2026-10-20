import { useState } from "react";
import type { Account, LlmConfig } from "@passport/types";
import { api, type AccountData, type ProviderDescriptor } from "../api";
import { useResource, useTask } from "../state";
import {
  Avatar,
  Badge,
  Feedback,
  Icon,
  Loading,
  PageHeader,
  relativeTime,
} from "../components/ui";
function AccountRow({ account }: { account: Account }) {
  const task = useTask();
  return (
    <div className="account-row">
      <Avatar name={account.displayName} />
      <div className="account-main">
        <strong>{account.displayName}</strong>
        <p>{account.emailAddress}</p>
        <small>
          {account.lastSyncError
            ? "Sync needs attention"
            : account.lastSyncAt
              ? `Synced ${relativeTime(account.lastSyncAt)}`
              : "Not synced yet"}
        </small>
        <Feedback
          error={
            account.lastSyncError
              ? "The last sync failed. Check your provider settings and try again."
              : task.error
          }
        />
      </div>
      <Badge tone="green">
        {account.kind === "mock" ? "Demo" : account.kind}
      </Badge>
      <button
        className="button secondary"
        disabled={task.busy}
        onClick={() =>
          task.run(() => api.sync(account.id), "Mailbox sync complete.")
        }
      >
        {task.busy ? "Syncing…" : "Sync now"}
      </button>
    </div>
  );
}
function AddAccount({
  providers,
  onClose,
}: {
  providers: ProviderDescriptor[];
  onClose: () => void;
}) {
  const [kind, setKind] = useState(providers[0]?.kind ?? ""),
    [fields, setFields] = useState<Record<string, string>>({}),
    [emailAddress, setEmail] = useState(""),
    [displayName, setName] = useState("");
  const descriptor = providers.find((p) => p.kind === kind),
    task = useTask();
  return (
    <form
      className="panel add-account-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await task.run(
          () =>
            api.addAccount({
              kind,
              emailAddress,
              displayName,
              fields: {
                ...fields,
                ...(descriptor?.fields.some((f) => f.id === "emailAddress")
                  ? { emailAddress }
                  : {}),
                ...(descriptor?.fields.some((f) => f.id === "displayName")
                  ? { displayName }
                  : {}),
              },
            }),
          "Account added.",
        );
        if (ok) {
          setFields({});
          onClose();
        }
      }}
    >
      <div className="section-heading">
        <h2>Connect a mailbox</h2>
        <button type="button" className="button text" onClick={onClose}>
          Close
        </button>
      </div>
      <label>
        Provider
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setFields({});
          }}
        >
          {providers.map((provider) => (
            <option key={provider.kind} value={provider.kind}>
              {provider.label}
            </option>
          ))}
        </select>
      </label>
      <div className="form-columns">
        <label>
          Email address
          <input
            type="email"
            autoComplete="email"
            required
            value={emailAddress}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </label>
        <label>
          Display name
          <input
            required
            value={displayName}
            onChange={(e) => setName(e.target.value)}
            placeholder="Personal mailbox"
          />
        </label>
      </div>
      {descriptor?.fields
        .filter((field) => !["emailAddress", "displayName"].includes(field.id))
        .map((field) => (
          <label key={field.id}>
            {field.label}
            <input
              type={field.secret ? "password" : "text"}
              required={field.required}
              autoComplete={field.secret ? "new-password" : "off"}
              placeholder={field.placeholder}
              value={fields[field.id] ?? ""}
              onChange={(e) =>
                setFields((current) => ({
                  ...current,
                  [field.id]: e.target.value,
                }))
              }
            />
            {field.help && <small>{field.help}</small>}
          </label>
        ))}
      {descriptor?.oauth && (
        <p className="subtle">
          This provider uses OAuth. Consent and token exchange are connected
          during backend integration.
        </p>
      )}
      <Feedback error={task.error} />
      <button className="button primary" disabled={task.busy || !descriptor}>
        <Icon name="plus" size={16} />
        {task.busy ? "Connecting…" : "Add account"}
      </button>
    </form>
  );
}
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
          ? "An API key is configured in the server environment."
          : "For cloud models, set PASSPORT_LLM_API_KEY in the server environment."}{" "}
        Keys are never stored in the config file.
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
  const accounts = useResource<AccountData>("/accounts"),
    providers = useResource<ProviderDescriptor[]>("/providers"),
    profile = useResource<{ markdown: string }>("/user-profile"),
    [adding, setAdding] = useState(false);
  return (
    <>
      <PageHeader
        eyebrow="MAKE YOURSELF AT HOME"
        title="Your workspace. Your way."
        description="Connect your accounts and give Passport a sense of how you work."
      >
        <button
          className="button primary"
          onClick={() => setAdding(!adding)}
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
              <AccountRow key={a.id} account={a} />
            ))}
          </section>
          {adding && providers.data && (
            <AddAccount
              providers={providers.data}
              onClose={() => setAdding(false)}
            />
          )}
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
