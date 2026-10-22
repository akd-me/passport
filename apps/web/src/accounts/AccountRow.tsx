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
  !!account.settings.reauthorizationRequired ||
  account.lastSyncError === "REAUTHORIZE_REQUIRED" ||
  account.watch?.status === "needs-sign-in";

/** Short state for the sidebar: mail is watched, not synced. */
export function watchLabel(account: ConnectedAccount): "Watching" | "Paused" | "Needs sign-in" {
  if (needsReauthorization(account)) {
    return "Needs sign-in";
  }
  const status = account.watch?.status;
  return status && ["backoff", "stale", "error", "unsupported"].includes(status)
    ? "Paused"
    : "Watching";
}

const clockTime = (at: string) =>
  new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** Account settings line: "Watching since <time> · last check <ago>", or why watching paused. */
export function watchSummary(account: ConnectedAccount): string {
  if (needsReauthorization(account)) {
    return "Sign-in expired";
  }
  if (!account.capabilities.mail) {
    return account.lastSyncAt
      ? `Calendar synced ${relativeTime(account.lastSyncAt).toLowerCase()}`
      : "Calendar not synced yet";
  }
  const watch = account.watch;
  if (watch?.status === "backoff") {
    return watch.retryAt
      ? `Paused by the provider's rate limit · next check ${relativeTime(watch.retryAt).toLowerCase()}`
      : "Paused by the provider's rate limit";
  }
  if (watch?.status === "unsupported") {
    return "This provider cannot be watched yet";
  }
  if (watch?.status === "error") {
    return `Paused: ${watch.error ?? "last check failed"}`;
  }
  if (!watch?.since) {
    return "Starting to watch for new mail…";
  }
  const lastCheck = watch.lastTickAt
    ? ` · last check ${relativeTime(watch.lastTickAt).toLowerCase()}`
    : "";
  return `Watching since ${clockTime(watch.since)}${lastCheck}`;
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
  const paused = watchLabel(account) !== "Watching";
  const oauth = ["gmail", "graph", "google-calendar", "graph-calendar"].includes(account.kind);
  return (
    <div className="account-row">
      <AccountDot id={account.id} />
      <div className="account-main">
        <strong>{account.displayName}</strong>
        <div className="meta">
          <span>{account.emailAddress}</span>
          <span>{providerName(account.kind)}</span>
          <span className={paused || account.lastSyncError ? "warn" : ""}>
            {watchSummary(account)}
          </span>
          {account.capabilities.mail && typeof account.messageCount === "number" && (
            <span className="num">{account.messageCount.toLocaleString()} in Inbox</span>
          )}
        </div>
        <Feedback
          error={
            needsAuth
              ? "Access expired or was revoked. Re-authorize to resume watching."
              : account.lastSyncError
                ? `Last check failed: ${account.lastSyncError}`
                : task.error
          }
        />
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
