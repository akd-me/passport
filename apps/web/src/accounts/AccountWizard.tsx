import { useEffect, useState } from "react";
import type { Account } from "@passport/types";
import { api, type ProviderDescriptor } from "../api";
import { useTask, useWorkspace } from "../state";
import { Feedback } from "../components/ui";
import { SetupTaskPanel } from "./SetupTaskPanel";
import {
  accountApi,
  type ConnectedAccount,
  type ConnectionAttempt,
  type ConnectionStatus,
} from "./api";

export function AccountWizard({
  providers,
  accounts = [],
  account,
  onClose,
}: {
  providers: ProviderDescriptor[];
  accounts?: ConnectedAccount[];
  account?: Account;
  onClose: () => void;
}) {
  const choices = providers.filter((p) =>
    ["gmail", "graph", "imap", "mock"].includes(p.kind),
  );
  const [kind, setKind] = useState(
    account?.kind ?? choices[0]?.kind ?? "gmail",
  );
  const [fields, setFields] = useState<Record<string, string>>({
    clientId: String(account?.settings.clientId ?? ""),
    port: "993",
    tls: "true",
    smtpPort: "465",
    smtpTls: "true",
  });
  const [emailAddress, setEmail] = useState(account?.emailAddress ?? ""),
    [displayName, setName] = useState(account?.displayName ?? "");
  const [calendar, setCalendar] = useState(
      account?.settings.calendarGranted !== false,
    ),
    [attempt, setAttempt] = useState<ConnectionAttempt>();
  const [status, setStatus] = useState<ConnectionStatus>(),
    [tested, setTested] = useState(false);
  const descriptor = choices.find((p) => p.kind === kind),
    oauth = kind === "gmail" || kind === "graph",
    task = useTask(),
    { refresh } = useWorkspace();
  useEffect(() => {
    if (!attempt) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await accountApi.status(attempt.attemptId);
        if (stopped) return;
        setStatus(result);
        if (result.status === "connected") {
          refresh();
          return;
        }
        if (result.status === "failed") return;
        timer = setTimeout(poll, 2000);
      } catch {
        if (!stopped)
          setStatus({
            status: "failed",
            error: "Authorization expired. Connect again to retry.",
          });
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [attempt, refresh]);
  const linked = accounts.find((a) => a.id === status?.accountId);
  const input = () => ({
    kind,
    emailAddress,
    displayName,
    fields: {
      ...Object.fromEntries(
        Object.entries(fields).filter(([key]) =>
          descriptor?.fields.some((field) => field.id === key),
        ),
      ),
      ...(descriptor?.fields.some((f) => f.id === "emailAddress")
        ? { emailAddress }
        : {}),
      ...(descriptor?.fields.some((f) => f.id === "displayName")
        ? { displayName }
        : {}),
    },
  });
  const setField = (id: string, value: string) => {
    setFields((f) => ({ ...f, [id]: value }));
    setTested(false);
  };
  return (
    <form
      className="panel add-account-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (oauth) {
          // Reserve the tab during the click, before the asynchronous API response.
          const tab = window.open("about:blank", "_blank");
          if (tab) tab.opener = null;
          const ok = await task.run(async () => {
            const result = await accountApi.start({
              kind,
              clientId: fields.clientId ?? "",
              ...(fields.clientSecret
                ? { clientSecret: fields.clientSecret }
                : {}),
              calendar,
              accountId: account?.id,
            });
            setAttempt(result);
            setStatus({ status: "authorizing" });
            setFields((f) => ({ ...f, clientSecret: "" }));
            if (tab) tab.location.href = result.authUrl;
          }, "Authorization opened. Return here after granting access.");
          if (!ok) tab?.close();
        } else {
          const ok = await task.run(async () => {
            const added = await api.addAccount(input());
            setFields({});
            await api.sync(added.id);
          }, "Account connected and synced.");
          if (ok) onClose();
        }
      }}
    >
      <div className="section-heading">
        <h2>
          {account
            ? `Re-authorize ${account.emailAddress}`
            : "Connect a mailbox"}
        </h2>
        <button type="button" className="button text" onClick={onClose}>
          Close
        </button>
      </div>
      <label>
        Provider
        <select
          value={kind}
          disabled={!!account || task.busy}
          onChange={(e) => {
            setKind(e.target.value as typeof kind);
            setAttempt(undefined);
            setStatus(undefined);
            setFields({
              port: "993",
              tls: "true",
              smtpPort: "465",
              smtpTls: "true",
            });
            setTested(false);
          }}
        >
          {choices.map((p) => (
            <option key={p.kind} value={p.kind}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {oauth ? (
        <>
          {!account && <SetupTaskPanel provider={kind === "gmail" ? "gmail" : "microsoft"} calendar={calendar} />}
          <div className="info-note oauth-guide">
            {kind === "gmail" ? (
              <>
                <strong>Your own Google OAuth client</strong>
                <p>
                  Google Cloud console → APIs &amp; Services → Library: enable
                  Gmail API and Google Calendar API. Google Auth Platform →
                  Audience: add your address as a test user. Clients → Create
                  client → Desktop app. Paste its client ID below; the
                  downloaded JSON also contains an optional client secret.
                </p>
              </>
            ) : (
              <>
                <strong>Your own Microsoft app registration</strong>
                <p>
                  Azure portal → Microsoft Entra ID → App registrations → New
                  registration. Choose organizational and personal Microsoft
                  accounts. Authentication → Add a platform → Mobile and desktop
                  applications → add the redirect below. Advanced settings →
                  Allow public client flows → Yes. API permissions → Microsoft
                  Graph → Delegated: User.Read, Mail.ReadWrite, Mail.Send,
                  Calendars.ReadWrite, offline_access. If the portal rejects
                  127.0.0.1, add the URI in Manifest →
                  publicClient.redirectUris.
                </p>
              </>
            )}
            <p>
              Callback: <code>{location.origin}/oauth/callback</code>. Open
              Passport at{" "}
              <code>http://127.0.0.1:{location.port || "3000"}/accounts</code>{" "}
              for local authorization.
            </p>
          </div>
          <label>
            OAuth client ID
            <input
              autoComplete="off"
              required
              value={fields.clientId ?? ""}
              onChange={(e) => setField("clientId", e.target.value)}
            />
          </label>
          <label>
            OAuth client secret (optional)
            <input
              type="password"
              autoComplete="new-password"
              value={fields.clientSecret ?? ""}
              onChange={(e) => setField("clientSecret", e.target.value)}
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={calendar}
              onChange={(e) => setCalendar(e.target.checked)}
            />
            Connect calendar too
          </label>
          <p className="subtle">
            The provider supplies your address after consent. Repeat this wizard
            for each account.
          </p>
        </>
      ) : (
        <>
          <div className="form-columns">
            <label>
              Email address
              <input
                type="email"
                required
                value={emailAddress}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setTested(false);
                }}
              />
            </label>
            <label>
              Display name
              <input
                value={displayName}
                onChange={(e) => setName(e.target.value)}
                placeholder="Personal mailbox"
              />
            </label>
          </div>
          {descriptor?.fields
            .filter((f) => !["emailAddress", "displayName"].includes(f.id))
            .map((field) => (
              <label key={field.id}>
                {field.label}
                {["tls", "smtpTls"].includes(field.id) ? (
                  <select
                    value={fields[field.id] ?? "true"}
                    onChange={(e) => setField(field.id, e.target.value)}
                  >
                    <option value="true">TLS</option>
                    <option value="false">STARTTLS</option>
                  </select>
                ) : (
                  <input
                    type={
                      field.secret
                        ? "password"
                        : ["port", "smtpPort"].includes(field.id)
                          ? "number"
                          : "text"
                    }
                    required={field.required}
                    value={fields[field.id] ?? ""}
                    onChange={(e) => setField(field.id, e.target.value)}
                    autoComplete={field.secret ? "new-password" : "off"}
                  />
                )}
                {field.help && <small>{field.help}</small>}
              </label>
            ))}
          {kind === "imap" && (
            <button
              type="button"
              className="button secondary"
              disabled={task.busy}
              onClick={() =>
                task.run(async () => {
                  await accountApi.test(input());
                  setTested(true);
                }, "Connection test passed.")
              }
            >
              Test connection
            </button>
          )}
          {tested && <p role="status">Connection test passed.</p>}
        </>
      )}
      <Feedback error={task.error || status?.error} />
      {attempt && (
        <div className="connection-progress" role="status">
          {status?.status === "connected"
            ? linked?.lastSyncError
              ? `Connected. Sync needs attention: ${linked.lastSyncError}`
              : linked?.lastSyncAt && !linked.syncing
                ? `Connected and synced ${linked.messageCount ?? 0} messages.`
                : "Connected. Initial sync is running…"
            : status?.status === "failed"
              ? "Connection was not completed."
              : "Waiting for authorization in the other tab…"}
          {status?.status === "authorizing" && (
            <p>
              <a
                href={attempt.authUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open authorization tab
              </a>
            </p>
          )}
        </div>
      )}
      <button
        className="button primary"
        disabled={task.busy || !descriptor || status?.status === "authorizing"}
      >
        {task.busy ? "Connecting…" : oauth ? "Connect" : "Add account"}
      </button>
    </form>
  );
}
