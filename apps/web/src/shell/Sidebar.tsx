import type { ActionRecord, Matter, Page, Person } from "@passport/types";
import type { ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from "react-router";
import { AccountDot, useAccounts } from "../accounts/AccountFilter";
import { watchLabel } from "../accounts/AccountRow";
import { Icon, Kbd, mod } from "../components/ui";
import { providerNames } from "../connect/setup-task-model";
import { useResource, useWorkspace } from "../state";
import { useUi } from "../ui-state";
import { ModeMenu } from "../views/Trust";

export function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true" className="brand-mark">
      <rect
        x="3.5"
        y="2"
        width="13"
        height="16"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle cx="10" cy="9" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 14.5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function Group({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="side-group" aria-label={title}>
      <div className="side-group-head">
        <h2>{title}</h2>
        {action}
      </div>
      <ul>{children}</ul>
    </section>
  );
}

const scopedRoutes = ["/", "/matters", "/activity"];

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

function AccountsGroup() {
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
                const base = scopedRoutes.includes(location.pathname) ? location.pathname : "/";
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

function MattersGroup({ pending }: { pending: Map<string, number> }) {
  const matters = useResource<Matter[]>("/matters?status=active,waiting");
  const list = matters.data ?? [];
  return (
    <Group
      title="Matters"
      action={
        <Link to="/matters" className="quiet-link small">
          All
        </Link>
      }
    >
      {list.slice(0, 12).map((m) => (
        <li key={m.id}>
          <NavLink
            to={`/matters/${m.id}`}
            className={({ isActive }) => `side-row ${isActive ? "active" : ""} status-${m.status}`}
          >
            <span className={`matter-glyph ${m.status}`} aria-hidden="true" />
            <span className="side-label">{m.title}</span>
            {!!pending.get(m.id) && (
              <span className="side-count" aria-label={`${pending.get(m.id)} waiting for you`}>
                {pending.get(m.id)}
              </span>
            )}
          </NavLink>
        </li>
      ))}
      {matters.data && !list.length && <li className="side-empty">No open matters</li>}
    </Group>
  );
}

function PeopleGroup() {
  const people = useResource<Person[]>("/people?relationship=known&limit=40");
  const list = [...(people.data ?? [])]
    .sort((a, b) => (b.stats.lastContactAt ?? "").localeCompare(a.stats.lastContactAt ?? ""))
    .slice(0, 6);
  return (
    <Group
      title="People"
      action={
        <Link to="/people" className="quiet-link small">
          All
        </Link>
      }
    >
      {list.map((p) => {
        const downgraded =
          !!p.lastSeenBlueAt && p.verification === "green" && !p.downgradeAcknowledgedAt;
        return (
          <li key={p.id}>
            <NavLink
              to={`/people/${p.id}`}
              className={({ isActive }) => `side-row ${isActive ? "active" : ""}`}
            >
              <span className={`person-dot ${p.verification}`} aria-hidden="true" />
              <span className="side-label">{p.displayName}</span>
              {downgraded && (
                <span title="Verification changed" className="warn">
                  <Icon name="alert" size={13} />
                  <span className="sr-only">Verification changed</span>
                </span>
              )}
            </NavLink>
          </li>
        );
      })}
    </Group>
  );
}

/** Navigation: mode first, then accounts, matters and people. Settings live behind the gear. */
export function Sidebar() {
  const { toggleSidebar, setPalette, openSettings } = useUi(),
    { connection } = useWorkspace(),
    { mode } = useAccounts(),
    [params] = useSearchParams();
  const decisions = useResource<Page<ActionRecord>>("/decisions");
  const proposed = decisions.data?.items.filter((a) => a.status === "proposed") ?? [];
  const pending = new Map<string, number>();
  for (const a of proposed) {
    if (a.request.matterId) {
      pending.set(a.request.matterId, (pending.get(a.request.matterId) ?? 0) + 1);
    }
  }
  const scope = params.get("accountId");
  const withScope = (path: string) =>
    scope ? `${path}?accountId=${encodeURIComponent(scope)}` : path;
  return (
    <aside
      className="sidebar"
      aria-label="Sidebar"
      onClick={(event) => {
        // As an overlay on narrow screens, get out of the way once something is chosen.
        const target = event.target as HTMLElement;
        if (
          window.matchMedia?.("(max-width: 860px)").matches &&
          target.closest("a, .side-row.account, .sidebar-foot .icon-btn")
        ) {
          toggleSidebar();
        }
      }}
    >
      <div className="sidebar-top">
        <Link to="/" className="brand" aria-label="Passport, go to queue">
          <BrandMark />
          <span>Passport</span>
        </Link>
        <button
          type="button"
          className="icon-btn"
          aria-label={`Hide sidebar (${mod}B)`}
          title={`Hide sidebar (${mod}B)`}
          onClick={toggleSidebar}
        >
          <Icon name="sidebar" />
        </button>
      </div>
      <button type="button" className="search-btn" onClick={() => setPalette(true)}>
        <Icon name="search" size={14} />
        <span>Search or jump to</span>
        <Kbd>{mod}K</Kbd>
      </button>
      <div className="sidebar-mode">
        <ModeMenu />
      </div>
      <nav className="side-nav" aria-label="Workspace">
        <NavLink
          to={withScope("/")}
          end
          className={({ isActive }) => `side-row ${isActive ? "active" : ""}`}
        >
          <Icon name="queue" size={15} />
          <span className="side-label">Queue</span>
          {proposed.length > 0 && <span className="side-count strong">{proposed.length}</span>}
        </NavLink>
        <NavLink
          to={withScope("/activity")}
          className={({ isActive }) => `side-row ${isActive ? "active" : ""}`}
        >
          <Icon name="activity" size={15} />
          <span className="side-label">Activity</span>
        </NavLink>
      </nav>
      <div className="sidebar-scroll">
        <AccountsGroup />
        <MattersGroup pending={pending} />
        <PeopleGroup />
      </div>
      <div className="sidebar-foot">
        <span className={`live ${connection === "Live" ? "on" : ""}`} role="status">
          <span className="status-dot" aria-hidden="true" />
          {connection === "Live" ? (mode === "demo" ? "Demo workspace" : "Live") : connection}
        </span>
        <button
          type="button"
          className="icon-btn"
          aria-label="Routines"
          title="Routines"
          onClick={() => openSettings("routines")}
        >
          <Icon name="routine" size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={`Settings (${mod},)`}
          title={`Settings (${mod},)`}
          onClick={() => openSettings()}
        >
          <Icon name="settings" size={15} />
        </button>
      </div>
    </aside>
  );
}
