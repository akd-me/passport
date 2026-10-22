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
/** Short sidebar state: "Watching", "Paused" or "Needs sign-in" (no sync progress). */
export function syncSummary(account: ConnectedAccount) {
  if (needsReauthorization(account) || account.watch?.status === "needs-sign-in") {
    return "Needs sign-in";
  }
  if (!account.capabilities.mail) {
    if (account.lastSyncError) {
      return "Calendar sync failed";
    }
    return account.lastSyncAt
      ? `Calendar synced ${relativeTime(account.lastSyncAt).toLowerCase()}`
      : "Calendar not synced yet";
  }
  const status = account.watch?.status;
  return !status || status === "watching" || status === "starting" ? "Watching" : "Paused";
}
/** "Watching since 9:41 AM · last check 1m ago", or why the watcher is paused. */
export function watchDetail(account: ConnectedAccount) {
  const watch = account.watch;
  if (!account.capabilities.mail || !watch) {
    return null;
  }
  const reasons: Record<string, string> = {
    backoff: "Paused: provider rate limit, retrying shortly",
    stale: "Paused: no recent check",
    error: `Paused: ${watch.error ?? "check failed"}`,
    unsupported: "This provider cannot be watched yet",
    "needs-sign-in": "Paused until you sign in again",
  };
  if (reasons[watch.status]) {
    return reasons[watch.status];
  }
  if (!watch.since) {
    return "Starting to watch for new mail…";
  }
  const since = new Date(watch.since).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const check = watch.lastTickAt
    ? ` · last check ${relativeTime(watch.lastTickAt).toLowerCase()}`
    : "";
  return `Watching since ${since}${check}`;
}

export function AccountRow({
  account,
  reauthorize,
}: {
  account: ConnectedAccount;
  reauthorize: () => void;
}) {
  const task = useTask();
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
          {account.capabilities.mail && typeof account.messageCount === "number" && (
            <span className="num">{account.messageCount} in Inbox</span>
          )}
        </div>
        <Feedback
          error={
            needsAuth
              ? "Access expired or was revoked. Re-authorize to resume watching."
              : account.lastSyncError
                ? `Last error: ${account.lastSyncError}`
                : task.error
          }
        />
        {watchDetail(account) && <div className="meta">{watchDetail(account)}</div>}
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
          disabled={task.busy || needsAuth}
          onClick={() => task.run(() => api.sync(account.id), "Checked for new mail.")}
        >
          <Icon name="sync" size={14} />
          Check now
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
