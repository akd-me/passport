import { useEffect } from "react";
import { Link, Navigate, Route, Routes, useNavigate, useSearchParams } from "react-router";
import { useWorkspace } from "./state";
import { isTyping, useUi, type SettingsSection } from "./ui-state";
import { AccountScope, useAccounts } from "./accounts/AccountFilter";
import { Icon, Loading } from "./components/ui";
import { Sidebar, BrandMark } from "./shell/Sidebar";
import { Surface } from "./shell/Surface";
import { CommandPalette } from "./shell/CommandPalette";
import { SettingsDialog } from "./settings/SettingsDialog";
import { ConnectDialog } from "./connect/ConnectDialog";
import { SetupFlow } from "./connect/SetupFlow";
import { WorkQueue } from "./views/Decisions";
import { Matters, MatterPage } from "./views/Matters";
import { People, PersonPage } from "./views/People";
import { Activity } from "./views/Activity";

export function App() {
  return (
    <AccountScope>
      <Shell />
    </AccountScope>
  );
}

/** Old top-level pages now live in Settings; keep their URLs (and the OAuth return URL) working. */
function OpenSettings({ section }: { section: SettingsSection }) {
  const { openSettings } = useUi(),
    { notify } = useWorkspace(),
    [params] = useSearchParams();
  const connected = params.get("connected");
  useEffect(() => {
    openSettings(section);
    if (connected) notify("Account connected. The first sync is running.");
  }, [section, connected, openSettings, notify]);
  return <Navigate to="/" replace />;
}

/** An empty workspace starts with connecting a mailbox, in place of the queue. */
function Welcome() {
  return (
    <Surface title="Welcome">
      <div className="welcome">
        <BrandMark size={28} />
        <h1>Connect the mailbox Passport should work on</h1>
        <p className="muted">
          Passport reads your mail on this machine, proposes replies and
          clean-up, and asks before anything leaves. You decide how much it
          does on its own.
        </p>
        <div className="welcome-flow">
          <SetupFlow onDone={() => {}} />
        </div>
      </div>
    </Surface>
  );
}

function Home() {
  const { accounts, loaded } = useAccounts();
  if (!loaded) return <Loading />;
  return accounts.length ? <WorkQueue /> : <Welcome />;
}

function useGlobalShortcuts() {
  const ui = useUi(),
    navigate = useNavigate();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "k") {
        event.preventDefault();
        ui.setPalette(!ui.palette);
      } else if (command && event.key === ",") {
        event.preventDefault();
        ui.openSettings();
      } else if (command && event.key.toLowerCase() === "b") {
        event.preventDefault();
        ui.toggleSidebar();
      } else if (command && event.key === ".") {
        event.preventDefault();
        ui.toggleDetails();
      } else if (
        event.key === "/" &&
        !command &&
        !isTyping(event.target) &&
        !document.querySelector('[aria-modal="true"]')
      ) {
        event.preventDefault();
        if (!ui.composer.current) navigate("/");
        setTimeout(ui.focusComposer, 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ui, navigate]);
}

function Shell() {
  const { notice } = useWorkspace(),
    ui = useUi();
  useGlobalShortcuts();
  return (
    <div className={`app ${ui.sidebar ? "with-sidebar" : "sidebar-hidden"}`}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      {ui.sidebar && (
        <>
          <Sidebar />
          <button
            type="button"
            className="sidebar-scrim"
            aria-label="Close sidebar"
            onClick={ui.toggleSidebar}
          />
        </>
      )}
      <main className="workspace">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/matters" element={<Matters />} />
          <Route path="/matters/:id" element={<MatterPage />} />
          <Route path="/people" element={<People />} />
          <Route path="/people/:id" element={<PersonPage />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/accounts" element={<OpenSettings section="accounts" />} />
          <Route path="/trust" element={<OpenSettings section="trust" />} />
          <Route path="/scheduler" element={<OpenSettings section="routines" />} />
          <Route
            path="*"
            element={
              <Surface title="Not found">
                <div className="empty">
                  <Icon name="alert" size={18} />
                  <div>
                    <h2>There is nothing at this address.</h2>
                    <p>
                      <Link to="/">Go to your queue</Link>
                    </p>
                  </div>
                </div>
              </Surface>
            }
          />
        </Routes>
      </main>
      <CommandPalette />
      <SettingsDialog />
      <ConnectDialog />
      {notice && (
        <div className="toast" role="status">
          <Icon name="check" size={15} />
          {notice}
        </div>
      )}
    </div>
  );
}
