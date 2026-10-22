import { useLocation, useNavigate, useSearchParams } from "react-router";
import { AccountDot, useAccounts } from "../accounts/AccountFilter";
import { watchLabel } from "../accounts/AccountRow";
import { Icon } from "../components/ui";
import { providerNames } from "../connect/setup-task-model";
import { useUi } from "../ui-state";
import { Group } from "./SidebarGroup";

const scopedRoutes = ["/needs-you", "/matters", "/activity"];

/** A setup waiting on the user stays reachable after its dialog is closed. */
function SetupWaiting() {
  const { connecting, setConnecting, setup } = useUi();
  const task = setup.task;
  if (connecting || task?.status !== "waiting_for_user") {
    return null;
  }
  return (
    <li>
      <button type="button" className="side-row setup-waiting" onClick={() => setConnecting(true)}>
        <Icon name="alert" size={14} />
        <span className="side-label">
          Setup needs you
          <small>Connecting {providerNames[task.provider]}</small>
        </span>
      </button>
    </li>
  );
}

export function AccountsGroup() {
  const { accounts } = useAccounts(),
    { setConnecting } = useUi(),
    [params] = useSearchParams(),
    location = useLocation(),
    navigate = useNavigate();
  const active = params.get("accountId");
  const mail = accounts.filter((a) => a.capabilities.mail);
  return (
    <Group
      title="Accounts"
      action={
        <button
          type="button"
          className="icon-btn tiny"
          aria-label="Connect an account"
          title="Connect an account"
          onClick={() => setConnecting(true)}
        >
          <Icon name="plus" size={14} />
        </button>
      }
    >
      {mail.map((account) => {
        const selected = active === account.id,
          state = watchLabel(account),
          attention = state !== "Watching" || !!account.lastSyncError;
        return (
          <li key={account.id}>
            <button
              type="button"
              className={`side-row account ${selected ? "active" : ""}`}
              aria-pressed={selected}
              title={selected ? "Show all accounts" : `Show only ${account.emailAddress}`}
              onClick={() => {
                const base = scopedRoutes.includes(location.pathname)
                  ? location.pathname
                  : "/needs-you";
                const next = new URLSearchParams(base === location.pathname ? params : undefined);
                if (selected) {
                  next.delete("accountId");
                } else {
                  next.set("accountId", account.id);
                }
                navigate(`${base}${next.size ? `?${next}` : ""}`);
              }}
            >
              <AccountDot id={account.id} />
              <span className="side-label">
                {account.emailAddress}
                <small className={attention ? "warn" : ""}>{state}</small>
              </span>
              {attention && <Icon name="alert" size={13} className="warn" />}
            </button>
          </li>
        );
      })}
      <SetupWaiting />
      <li>
        <button type="button" className="side-row quiet" onClick={() => setConnecting(true)}>
          <Icon name="plus" size={14} />
          <span className="side-label">
            {mail.length ? "Connect another" : "Connect an account"}
          </span>
        </button>
      </li>
    </Group>
  );
}
