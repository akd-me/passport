import { useState } from "react";
import { api } from "../api";
import { useTask } from "../state";
import { Avatar, Badge, Feedback, relativeTime } from "../components/ui";
import { accountApi, type ConnectedAccount } from "./api";
import { AccountDot } from "./AccountFilter";

export function AccountRow({
  account,
  reauthorize,
}: {
  account: ConnectedAccount;
  reauthorize: () => void;
}) {
  const task = useTask(),
    [days, setDays] = useState(365);
  const needsAuth =
    account.settings.reauthorizationRequired ||
    account.lastSyncError === "REAUTHORIZE_REQUIRED";
  const oauth = [
    "gmail",
    "graph",
    "google-calendar",
    "graph-calendar",
  ].includes(account.kind);
  return (
    <div className="account-row">
      <Avatar name={account.displayName} />
      <div className="account-main">
        <strong>
          <AccountDot id={account.id} /> {account.displayName}
        </strong>
        <p>{account.emailAddress}</p>
        <small>
          {account.syncing
            ? "Syncing…"
            : account.lastSyncAt
              ? `Synced ${relativeTime(account.lastSyncAt)}`
              : "Not synced yet"}{" "}
          · {account.messageCount ?? 0} messages
        </small>
        <Feedback
          error={
            needsAuth
              ? "Access expired or was revoked. Re-authorize to resume sync."
              : account.lastSyncError
                ? `Last sync error: ${account.lastSyncError}`
                : task.error
          }
        />
      </div>
      <Badge tone={needsAuth ? "amber" : "green"}>
        {account.kind === "mock" ? "Demo" : account.kind}
      </Badge>
      <div className="account-actions">
        <button
          className="button secondary"
          disabled={task.busy || account.syncing || !!needsAuth}
          onClick={() =>
            task.run(() => api.sync(account.id), "Account sync complete.")
          }
        >
          Sync now
        </button>
        {oauth && (
          <button
            className="button secondary"
            disabled={task.busy}
            onClick={reauthorize}
          >
            Re-authorize
          </button>
        )}
        <button
          className="button text"
          disabled={task.busy}
          onClick={() => {
            if (
              window.confirm(
                `Remove ${account.emailAddress} from Passport? This removes its local account data and linked calendar.`,
              )
            )
              void task.run(
                () => accountApi.remove(account.id),
                "Account removed.",
              );
          }}
        >
          Remove
        </button>
        {account.capabilities.mail && account.kind !== "mock" && (
          <details className="backfill-control">
            <summary>Load older mail</summary>
            <label>
              Days of history
              <input
                aria-label={`Days of history for ${account.emailAddress}`}
                type="number"
                min={1}
                max={36500}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              />
            </label>
            <button
              className="button secondary"
              disabled={
                task.busy ||
                account.syncing ||
                !!needsAuth ||
                !Number.isInteger(days) ||
                days < 1
              }
              onClick={() =>
                task.run(
                  () => accountApi.backfill(account.id, days),
                  "Older mail synced.",
                )
              }
            >
              Backfill
            </button>
          </details>
        )}
      </div>
    </div>
  );
}
