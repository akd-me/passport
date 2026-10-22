import type { ActionRecord, Page } from "@passport/types";
import { Link, NavLink, useSearchParams } from "react-router";
import { useAccounts } from "../accounts/AccountFilter";
import { Icon, Kbd, mod } from "../components/ui";
import { useResource, useWorkspace } from "../state";
import { needsYou } from "../tasks/model";
import { useTasks } from "../tasks/store";
import { useUi } from "../ui-state";
import { ModeMenu } from "../views/Trust";
import { AccountsGroup } from "./SidebarAccounts";
import { TaskList } from "./TaskList";

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

/**
 * Navigation: mode first, then the task list (Pinned, Inbox, Working, Snoozed, Settled), accounts,
 * and the context units (matters, people). Settings live behind the gear.
 */
export function Sidebar() {
  const { toggleSidebar, setPalette, openSettings } = useUi(),
    { connection } = useWorkspace(),
    { mode } = useAccounts(),
    tasks = useTasks(),
    [params] = useSearchParams();
  const decisions = useResource<Page<ActionRecord>>("/decisions");
  const proposed = decisions.data?.items.filter((a) => a.status === "proposed") ?? [];
  const waiting = tasks.available ? needsYou(tasks.tasks).length : proposed.length;
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
        <Link to="/" className="brand" aria-label="Passport, start a new task">
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
        <NavLink to="/" end className={({ isActive }) => `side-row ${isActive ? "active" : ""}`}>
          <Icon name="plus" size={15} />
          <span className="side-label">New task</span>
        </NavLink>
        <NavLink
          to={withScope("/needs-you")}
          className={({ isActive }) => `side-row ${isActive ? "active" : ""}`}
        >
          <Icon name="queue" size={15} />
          <span className="side-label">Needs you</span>
          {waiting > 0 && (
            <span className="side-count strong">
              {waiting}
              <span className="sr-only"> need you</span>
            </span>
          )}
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
        <nav aria-label="Tasks" className="task-nav">
          <TaskList />
        </nav>
        <AccountsGroup />
        <nav className="side-group side-secondary" aria-label="Context">
          <NavLink
            to={withScope("/matters")}
            className={({ isActive }) => `side-row ${isActive ? "active" : ""}`}
          >
            <Icon name="matters" size={15} />
            <span className="side-label">Matters</span>
          </NavLink>
          <NavLink
            to="/people"
            className={({ isActive }) => `side-row ${isActive ? "active" : ""}`}
          >
            <Icon name="people" size={15} />
            <span className="side-label">People</span>
          </NavLink>
        </nav>
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
