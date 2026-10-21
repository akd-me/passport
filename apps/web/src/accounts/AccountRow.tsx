import { useState } from "react";
import { api } from "../api";
import { Feedback, Icon, relativeTime } from "../components/ui";
import { useTask } from "../state";
import { AccountDot } from "./AccountFilter";
import { accountApi, type ConnectedAccount } from "./api";

const kindLabel: Record<string, string> = {
  gmail: "Gmail",
  graph: "Outlook",
  imap: "IMAP",
  jmap: "JMAP",
  mock: "Demo",
  "google-calendar": "Google Calendar",
  "graph-calendar": "Outlook Calendar",
  caldav: "CalDAV",
};
const providerName = (kind: string) => kindLabel[kind] ?? kind;
export const needsReauthorization = (account: ConnectedAccount) =>
  !!account.settings.reauthorizationRequired || account.lastSyncError === "REAUTHORIZE_REQUIRED";
export function syncSummary(account: ConnectedAccount) {
  if (needsReauthorization(account)) {
    return "Sign-in expired";
  }
  if (account.syncing) {
    return "Syncing…";
  }
  if (account.lastSyncError) {
    return "Sync failed";
  }
  return account.lastSyncAt
    ? `Synced ${relativeTime(account.lastSyncAt).toLowerCase()}`
    : "Not synced yet";
}

export function AccountRow({
  account,
  reauthorize,
}: {
  account: ConnectedAccount;
  reauthorize: () => void;
}) {
  const task = useTask(),
    [days, setDays] = useState(365);
  const needsAuth = needsReauthorization(account);
  const oauth = ["gmail", "graph", "google-calendar", "graph-calendar"].includes(account.kind);
  return (
    <div className="account-row">
      <AccountDot id={account.id} />
      <div className="account-main">
        <strong>{account.displayName}</strong>
        <div className="meta">
          <span>{account.emailAddress}</span>
          <span>{providerName(account.kind)}</span>
          <span className={needsAuth || account.lastSyncError ? "warn" : ""}>
            {syncSummary(account)}
          </span>
          {account.capabilities.mail && (
            <span className="num">{account.messageCount ?? 0} messages</span>
          )}
        </div>
        <Feedback
          error={
            needsAuth
              ? "Access expired or was revoked. Re-authorize to resume sync."
              : account.lastSyncError
                ? `Last sync error: ${account.lastSyncError}`
                : task.error
          }
        />
        {account.capabilities.mail && account.kind !== "mock" && (
          <details className="backfill">
            <summary>Load older mail</summary>
            <div className="backfill-row">
              <label className="input-unit">
                <input
                  aria-label={`Days of history for ${account.emailAddress}`}
                  type="number"
                  min={1}
                  max={36500}
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                />
                <span>days</span>
              </label>
              <button
                className="btn btn-sm"
                disabled={
                  task.busy || account.syncing || needsAuth || !Number.isInteger(days) || days < 1
                }
                onClick={() =>
                  task.run(() => accountApi.backfill(account.id, days), "Older mail synced.")
                }
              >
                Backfill
              </button>
            </div>
          </details>
        )}
      </div>
      <div className="row-actions">
        {oauth && (needsAuth || account.kind !== "mock") && (
          <button
            className={`btn btn-sm ${needsAuth ? "btn-primary" : "btn-ghost"}`}
            disabled={task.busy}
            onClick={reauthorize}
          >
            Re-authorize
          </button>
        )}
        <button
          className="btn btn-sm"
          disabled={task.busy || account.syncing || needsAuth}
          onClick={() => task.run(() => api.sync(account.id), "Account synced.")}
        >
          <Icon name="sync" size={14} />
          Sync now
        </button>
        <button
          className="icon-btn danger"
          aria-label={`Remove ${account.emailAddress}`}
          title="Remove account"
          disabled={task.busy}
          onClick={() => {
            if (
              window.confirm(
                `Remove ${account.emailAddress} from Passport? This removes its local account data and linked calendar.`,
              )
            ) {
              void task.run(() => accountApi.remove(account.id), "Account removed.");
            }
          }}
        >
          <Icon name="trash" size={15} />
        </button>
      </div>
    </div>
  );
}
