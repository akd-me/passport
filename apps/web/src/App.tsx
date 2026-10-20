import {
  NavLink,
  Route,
  Routes,
  Link,
  useSearchParams,
  useLocation,
} from "react-router";
import type { ActionRecord, Page } from "@passport/types";
import { useResource, useWorkspace } from "./state";
import { Icon } from "./components/ui";
import { Matters, MatterPage } from "./views/Matters";
import { People, PersonPage } from "./views/People";
import { Trust } from "./views/Trust";
import { Activity } from "./views/Activity";
import { Accounts } from "./views/Accounts";
import { Scheduler } from "./views/Scheduler";
import { AccountScope, AccountFilter } from "./accounts/AccountFilter";
import { StartPage } from "./accounts/StartPage";
const navigation = [
  ["/", "Decisions", "decisions"],
  ["/matters", "Matters", "matters"],
  ["/people", "People", "people"],
  ["/trust", "Trust", "trust"],
  ["/activity", "Activity", "activity"],
  ["/accounts", "Accounts", "accounts"],
  ["/scheduler", "Scheduler", "clock"],
];
export function App() {
  return (
    <AccountScope>
      <WorkspaceShell />
    </AccountScope>
  );
}
function WorkspaceShell() {
  const [params] = useSearchParams(),
    location = useLocation();
  const { connection, notice } = useWorkspace(),
    decisions = useResource<Page<ActionRecord>>("/decisions"),
    health = useResource<{ mode: string }>("/health");
  const pending =
    decisions.data?.items.filter((a) => a.status === "proposed").length ?? 0;
  return (
    <div className="app-shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link className="brand" to="/" aria-label="Passport home">
          <span className="brand-mark">
            <svg
              viewBox="0 0 32 32"
              width="25"
              height="25"
              fill="none"
              aria-hidden="true"
            >
              <rect
                x="7"
                y="4"
                width="18"
                height="24"
                rx="4"
                stroke="currentColor"
                strokeWidth="1.7"
              />
              <circle
                cx="16"
                cy="14"
                r="5"
                stroke="currentColor"
                strokeWidth="1.4"
              />
              <path
                d="M11 14h10m-5-5c-3 4-3 6 0 10 3-4 3-6 0-10ZM12 23h8"
                stroke="currentColor"
                strokeWidth="1.3"
              />
            </svg>
          </span>
          <span>
            passport<span className="brand-period">.</span>
          </span>
        </Link>
        <div className="workspace-label">
          <span className="workspace-dot" />
          Personal workspace
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
          >
            <path d="m3 5 3 3 3-3" stroke="currentColor" />
          </svg>
        </div>
        <div className="nav-label">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          {navigation.map(([path, label, icon]) => (
            <NavLink
              key={path}
              to={`${path}${params.get("accountId") ? `?accountId=${encodeURIComponent(params.get("accountId")!)}` : ""}`}
              end={path === "/"}
              className={({ isActive }) =>
                `nav-link ${isActive ? "active" : ""}`
              }
            >
              <Icon name={icon!} size={19} />
              <span>{label}</span>
              {path === "/" && pending > 0 && (
                <span className="nav-count">{pending}</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span
              className={`connection-dot ${connection === "Live" ? "online" : ""}`}
            />
            <span>
              {connection === "Live" ? "Passport is with you" : connection}
            </span>
          </div>
          {health.data?.mode === "demo" && (
            <div className="demo-label">DEMO WORKSPACE · LOCAL ONLY</div>
          )}
          <div className="user-card">
            <span className="user-avatar">AM</span>
            <div>
              <strong>Alex Morgan</strong>
              <small>Your personal workspace</small>
            </div>
          </div>
        </div>
      </aside>
      <div className="workspace-main">
        <div className="topbar">
          <span>A calmer way to keep things moving.</span>
          <div>
            <span
              className={`connection-dot ${connection === "Live" ? "online" : ""}`}
            />
            {connection}
            <span className="topbar-divider" />
            {health.data?.mode === "demo"
              ? "Demo workspace"
              : "Local workspace"}
            <Icon name="trust" size={16} />
          </div>
        </div>
        <main id="main">
          {["/", "/matters", "/activity"].includes(location.pathname) && (
            <AccountFilter />
          )}
          <Routes>
            <Route path="/" element={<StartPage />} />
            <Route path="/matters" element={<Matters />} />
            <Route path="/matters/:id" element={<MatterPage />} />
            <Route path="/people" element={<People />} />
            <Route path="/people/:id" element={<PersonPage />} />
            <Route path="/trust" element={<Trust />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/scheduler" element={<Scheduler />} />
            <Route
              path="*"
              element={
                <div className="empty">
                  <h1>That page has moved.</h1>
                  <Link to="/">Back to decisions</Link>
                </div>
              }
            />
          </Routes>
          <footer className="page-footer">
            <span className="footer-mark">passport.</span>
            <span>A little less inbox. A little more life.</span>
          </footer>
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Icon name="check" size={18} />
          {notice}
        </div>
      )}
    </div>
  );
}
