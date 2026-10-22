import type { Account } from "@passport/types";
import { useEffect, useState } from "react";
import { api, type ProviderDescriptor } from "../api";
import { Feedback, Icon } from "../components/ui";
import { logger } from "../logger";
import { useTask, useWorkspace } from "../state";
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
  title,
  initialKind,
}: {
  providers: ProviderDescriptor[];
  accounts?: ConnectedAccount[];
  account?: Account;
  onClose: () => void;
  /** Heading; the connect dialog supplies its own context. */
  title?: string;
  /** Provider to preselect, e.g. the one chosen before falling back to manual setup. */
  initialKind?: string;
}) {
  const choices = providers.filter((p) => ["gmail", "graph", "imap", "mock"].includes(p.kind));
  const [kind, setKind] = useState(
    account?.kind ??
      (choices.some((c) => c.kind === initialKind) ? initialKind : undefined) ??
      choices[0]?.kind ??
      "gmail",
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
  const [calendar, setCalendar] = useState(account?.settings.calendarGranted !== false),
    [attempt, setAttempt] = useState<ConnectionAttempt>();
  const [status, setStatus] = useState<ConnectionStatus>(),
    [tested, setTested] = useState(false);
  const descriptor = choices.find((p) => p.kind === kind),
    oauth = kind === "gmail" || kind === "graph",
    task = useTask(),
    { refresh } = useWorkspace();
  useEffect(() => {
    if (!attempt) {
      return;
    }
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await accountApi.status(attempt.attemptId);
        if (stopped) {
          return;
        }
        setStatus(result);
        if (result.status === "connected") {
          refresh();
          return;
        }
        if (result.status === "failed") {
          return;
        }
        timer = setTimeout(poll, 2000);
      } catch {
        // Authorization status refresh failed.
        logger.warn("Authorization status refresh failed");

        if (!stopped) {
          setStatus({
            status: "failed",
            error: "Authorization expired. Connect again to retry.",
          });
        }
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
      ...(descriptor?.fields.some((f) => f.id === "emailAddress") ? { emailAddress } : {}),
      ...(descriptor?.fields.some((f) => f.id === "displayName") ? { displayName } : {}),
    },
  });
  const setField = (id: string, value: string) => {
    setFields((f) => ({ ...f, [id]: value }));
    setTested(false);
  };
  const callback = `${location.origin}/oauth/callback`;
  function connectionMessage() {
    if (status?.status === "connected") {
      if (linked?.lastSyncError) {
        return `Connected. Sync needs attention: ${linked.lastSyncError}`;
      }
      if (linked?.lastSyncAt && !linked.syncing) {
        return "Connected. Passport reads your mail on demand and watches for new mail.";
      }
      return "Connected. Passport reads your mail on demand and watches for new mail.";
    }
    if (status?.status === "failed") {
      return "Connection was not completed.";
    }
    return "Waiting for authorization in the other tab…";
  }
  return (
    <form
      className="manual-setup"
      onSubmit={async (e) => {
        e.preventDefault();
        if (oauth) {
          // Reserve the tab during the click, before the asynchronous API response.
          const tab = window.open("about:blank", "_blank");
          if (tab) {
            tab.opener = null;
          }
          const ok = await task.run(async () => {
            const result = await accountApi.start({
              kind,
              clientId: fields.clientId ?? "",
              ...(fields.clientSecret ? { clientSecret: fields.clientSecret } : {}),
              calendar,
              accountId: account?.id,
            });
            setAttempt(result);
            setStatus({ status: "authorizing" });
            setFields((f) => ({ ...f, clientSecret: "" }));
            if (tab) {
              tab.location.href = result.authUrl;
            } else {
              // The Mac app refuses blank popups and hands http(s) URLs to the system browser.
              window.open(result.authUrl, "_blank", "noopener");
            }
          }, "Authorization opened. Return here after granting access.");
          if (!ok) {
            tab?.close();
          }
        } else {
          const ok = await task.run(async () => {
            const added = await api.addAccount(input());
            setFields({});
            await api.sync(added.id);
          }, "Account connected and synced.");
          if (ok) {
            onClose();
          }
        }
      }}
    >
      <div className="block-heading">
        <h3>{account ? `Re-authorize ${account.emailAddress}` : (title ?? "Connect a mailbox")}</h3>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <label className="field">
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
          <div className="guide">
            {kind === "gmail" ? (
              <>
                <strong>Create your own Google OAuth client</strong>
                <ol>
                  <li>
                    Google Cloud console → APIs &amp; Services → Library: enable Gmail API and
                    Google Calendar API.
                  </li>
                  <li>Google Auth Platform → Audience: add your address as a test user.</li>
                  <li>
                    Clients → Create client → Desktop app. Paste its client ID below; the downloaded
                    JSON also contains an optional client secret.
                  </li>
                </ol>
              </>
            ) : (
              <>
                <strong>Register your own Microsoft app</strong>
                <ol>
                  <li>
                    Azure portal → Microsoft Entra ID → App registrations → New registration. Choose
                    organizational and personal Microsoft accounts.
                  </li>
                  <li>
                    Authentication → Add a platform → Mobile and desktop applications → add the
                    redirect below. Advanced settings → Allow public client flows → Yes.
                  </li>
                  <li>
                    API permissions → Microsoft Graph → Delegated: User.Read, Mail.ReadWrite,
                    Mail.Send, Calendars.ReadWrite, offline_access. If the portal rejects 127.0.0.1,
                    add the URI in Manifest → publicClient.redirectUris.
                  </li>
                </ol>
              </>
            )}
            <p>
              Redirect URI <code>{callback}</code>. Open Passport at{" "}
              <code>http://127.0.0.1:{location.port || "3000"}</code> so the browser can return
              here.
            </p>
          </div>
          <label className="field">
            OAuth client ID
            <input
              autoComplete="off"
              required
              value={fields.clientId ?? ""}
              onChange={(e) => setField("clientId", e.target.value)}
            />
          </label>
          <label className="field">
            OAuth client secret (optional)
            <input
              type="password"
              autoComplete="new-password"
              value={fields.clientSecret ?? ""}
              onChange={(e) => setField("clientSecret", e.target.value)}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={calendar}
              onChange={(e) => setCalendar(e.target.checked)}
            />
            Connect calendar too
          </label>
        </>
      ) : (
        <>
          <div className="field-row">
            <label className="field">
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
            <label className="field">
              Display name
              <input
                value={displayName}
                onChange={(e) => setName(e.target.value)}
                placeholder="Work"
              />
            </label>
          </div>
          <div className="field-grid">
            {descriptor?.fields
              .filter((f) => !["emailAddress", "displayName"].includes(f.id))
              .map((field) => (
                <label key={field.id} className="field">
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
          </div>
          {tested && (
            <p role="status" className="ok-note">
              <Icon name="check" size={14} />
              Connection test passed.
            </p>
          )}
        </>
      )}
      <Feedback error={task.error || status?.error} />
      {attempt && (
        <div className="progress-note" role="status">
          {status?.status === "authorizing" && <Icon name="spinner" size={14} />}
          <span>{connectionMessage()}</span>
          {status?.status === "authorizing" && (
            <a href={attempt.authUrl} target="_blank" rel="noopener noreferrer">
              Open authorization tab
            </a>
          )}
        </div>
      )}
      <div className="form-actions">
        {kind === "imap" && (
          <button
            type="button"
            className="btn"
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
        <button
          className="btn btn-primary"
          disabled={task.busy || !descriptor || status?.status === "authorizing"}
        >
          {task.busy ? "Connecting…" : oauth ? "Connect" : "Add account"}
        </button>
      </div>
    </form>
  );
}
