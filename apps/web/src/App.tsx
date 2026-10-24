import { type CSSProperties, useEffect, useLayoutEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useNavigate, useSearchParams } from "react-router";
import { AccountScope, useAccounts } from "./accounts/AccountFilter";
import { FIRST_RUN_CONNECTED } from "./accounts/api";
import { Icon, Kbd, Loading, mod } from "./components/ui";
import { ConnectDialog } from "./connect/ConnectDialog";
import { SetupFlow } from "./connect/SetupFlow";
import { SettingsDialog } from "./settings/SettingsDialog";
import { CommandPalette } from "./shell/CommandPalette";
import { BrandMark, Sidebar } from "./shell/Sidebar";
import { Surface } from "./shell/Surface";
import { useTaskJumpKeys, useTaskListKeys } from "./shell/TaskList";
import { useWorkspace } from "./state";
import { DecisionLink } from "./tasks/DecisionLink";
import { TasksProvider } from "./tasks/store";
import { isTyping, type SettingsSection, useUi } from "./ui-state";
import { useWindowKeydown } from "./use-window-keydown";
import { Activity } from "./views/Activity";
import { WorkQueue } from "./views/Decisions";
import { MatterPage, Matters } from "./views/Matters";
import { NewTask } from "./views/NewTask";
import { People, PersonPage } from "./views/People";
import { TaskPage } from "./views/Task";
import { Tasks } from "./views/Tasks";

export function App() {
  return (
    <AccountScope>
      <TasksProvider>
        <Shell />
      </TasksProvider>
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
    if (connected) {
      notify(FIRST_RUN_CONNECTED);
    }
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
          Passport reads your mail on this machine, proposes replies and clean-up, and asks before
          anything leaves. You decide how much it does on its own.
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
  if (!loaded) {
    return <Loading />;
  }
  return accounts.length ? <NewTask /> : <Welcome />;
}

/** The overlay sidebar of narrow windows (the media query in styles/shell.css). */
const overlaySidebar = () => window.matchMedia?.("(max-width: 860px)").matches ?? false;

export function useGlobalShortcuts() {
  const ui = useUi(),
    { noticeAction, notify } = useWorkspace(),
    navigate = useNavigate();
  useWindowKeydown((event) => {
    /** ⌘-chords; true when handled. */
    const chord = (event: KeyboardEvent, modal: boolean) => {
      const key = event.key.toLowerCase();
      if (key === "k") {
        ui.setPalette(!ui.palette);
      } else if (key === ",") {
        ui.openSettings();
      } else if (key === "b") {
        ui.toggleSidebar();
      } else if (key === ".") {
        ui.toggleDetails();
      } else if (
        // ⌘Z undoes the last sidebar action while its toast offers Undo; text fields keep theirs.
        key === "z" &&
        !event.shiftKey &&
        noticeAction?.undo &&
        !isTyping(event.target) &&
        !modal
      ) {
        notify("");
        noticeAction.run();
      } else {
        return false;
      }
      return true;
    };
    /** Plain keys outside text fields and dialogs; true when handled. */
    const plain = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Dialogs and popovers close themselves; Escape then closes the open panel.
        if (ui.details && document.querySelector(".details-panel")) {
          ui.toggleDetails();
        } else if (ui.sidebar && overlaySidebar()) {
          ui.toggleSidebar();
        } else {
          return false;
        }
      } else if (event.key === "/") {
        if (!ui.composer.current) {
          navigate("/");
        }
        setTimeout(ui.focusComposer, 0);
      } else {
        return false;
      }
      return true;
    };
    const modal = !!document.querySelector('[aria-modal="true"]');
    const handled =
      event.metaKey || event.ctrlKey
        ? chord(event, modal)
        : !modal && !isTyping(event.target) && plain(event);
    if (handled) {
      event.preventDefault();
    }
  });
}

/**
 * Where the toast sits: above the composer dock when one is on screen, so it never covers the
 * mode chips or Send (R2-20); otherwise at the bottom edge.
 */
function useToastLift(notice: string): CSSProperties | undefined {
  const [bottom, setBottom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const dock = notice ? document.querySelector(".dock") : null;
    const top = dock?.getBoundingClientRect().top;
    setBottom(top ? Math.max(0, window.innerHeight - top) : null);
  }, [notice]);
  return bottom ? { bottom: `calc(${bottom}px + var(--s-3))` } : undefined;
}

function Shell() {
  const { notice, noticeAction, notify } = useWorkspace(),
    ui = useUi(),
    toastLift = useToastLift(notice);
  useGlobalShortcuts();
  useTaskListKeys();
  useTaskJumpKeys();
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
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/tasks/:id" element={<TaskPage />} />
          <Route path="/needs-you" element={<WorkQueue />} />
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
                      <Link to="/">Start a new task</Link>
                    </p>
                  </div>
                </div>
              </Surface>
            }
          />
        </Routes>
      </main>
      <DecisionLink />
      <CommandPalette />
      <SettingsDialog />
      <ConnectDialog />
      {notice && (
        <div className="toast" role="status" style={toastLift}>
          <Icon name="check" size={15} />
          {notice}
          {noticeAction && (
            <button
              type="button"
              className="link-btn toast-action"
              onClick={() => {
                notify("");
                noticeAction.run();
              }}
            >
              {noticeAction.label}
            </button>
          )}
          {noticeAction?.undo && <Kbd>{mod}Z</Kbd>}
        </div>
      )}
    </div>
  );
}
