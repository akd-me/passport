// Passport.app main process: one instance, a server child (or an attached `passport serve`),
// one window onto its UI, and a menu-bar item that keeps working with the window closed.
import { join, resolve } from "node:path";
import { app, BrowserWindow, dialog, Notification, safeStorage, shell } from "electron";
import type { Attention } from "./attention";
import { installShim } from "./cli-shim";
import { DecisionWatcher } from "./decisions";
import { linkFromArgv, routeFor, SCHEME } from "./deep-links";
import { desktopMasterKey, MasterKeyError } from "./master-key";
import { dataDir, log, logDir } from "./paths";
import { ServerSupervisor } from "./server";
import { loadSettings, saveSettings } from "./settings";
import { MenuBar } from "./tray";
import { MainWindow } from "./window";

const MAX_NOTIFICATIONS = 3;
const NEEDS_YOU = "/needs-you";

// Lets a test run use its own sealed keys, settings, logs and single-instance lock.
if (process.env.PASSPORT_DESKTOP_USER_DATA) {
  const userData = resolve(process.env.PASSPORT_DESKTOP_USER_DATA);
  app.setPath("userData", userData);
  app.setAppLogsPath(join(userData, "logs"));
}

// open-url can fire before ready (a link that launched the app); queue until the window exists.
const pendingLinks: string[] = [];
let handleLink = (url: string) => {
  pendingLinks.push(url);
};
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleLink(url);
});

if (app.requestSingleInstanceLock()) {
  void start();
} else {
  app.quit();
}

async function start(): Promise<void> {
  await app.whenReady();
  const dir = dataDir();
  const settings = loadSettings();
  const launchedAtLogin =
    app.getLoginItemSettings().wasOpenedAtLogin || process.argv.includes("--hidden");
  log("info", `Passport ${app.getVersion()} starting; data directory ${dir}`);
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(SCHEME);
  }

  let masterKey: string | null = null;
  const supervisor = new ServerSupervisor(dir, {
    masterKey: () => masterKey,
    spawnMarker: join(app.getPath("userData"), "server-child.json"),
  });
  const watcher = new DecisionWatcher();
  const window = new MainWindow(
    () => {
      updateDock();
      refreshTray();
    },
    () => supervisor.refreshToken(),
  );
  let started = false;

  const startServer = () => {
    try {
      masterKey = desktopMasterKey(dir, safeStorage, app.getPath("userData"))?.key ?? null;
    } catch (error) {
      // Without the right key, starting the server would fail or strand credentials.
      const detail =
        error instanceof MasterKeyError
          ? error.message
          : `Passport could not prepare its encryption key (${(error as NodeJS.ErrnoException).code ?? (error as Error).name}: ${(error as Error).message}). Fix that, then choose Restart Server from the menu bar.`;
      log("error", `Not starting the server: ${detail}`);
      supervisor.state = { status: "failed", detail };
      window.setServer(supervisor.state);
      refreshTray();
      return;
    }
    started = true;
    supervisor.start();
  };

  const updateDock = () => {
    if (process.platform !== "darwin" || !app.dock) {
      return;
    }
    if (settings.menuBarOnly && !window.isOpen) {
      app.dock.hide();
    } else {
      void app.dock.show();
    }
  };

  // Notifications must stay referenced until clicked or closed, or their handlers are collected.
  const live = new Set<Notification>();
  const notify = (items: Attention[]) => {
    const focused = BrowserWindow.getFocusedWindow();
    if (!settings.notifications || focused || !Notification.isSupported()) {
      log("info", `Skipped notifications (${focused ? "window focused" : "disabled"})`);
      return;
    }
    const shown = items.slice(0, MAX_NOTIFICATIONS).map((item) => ({
      body: item.title,
      route: routeFor(item.link) ?? NEEDS_YOU,
    }));
    const extra = items.length - shown.length;
    if (extra > 0) {
      shown.push({ body: `${extra} more need${extra === 1 ? "s" : ""} you`, route: NEEDS_YOU });
    }
    for (const { body, route } of shown) {
      const notification = new Notification({ title: "Passport needs you", body });
      live.add(notification);
      notification.on("click", () => {
        live.delete(notification);
        window.show(route);
      });
      notification.on("close", () => live.delete(notification));
      notification.show();
    }
    log("info", `Showed ${shown.length} notification(s)`);
  };

  const tray = new MenuBar({
    open: (route) => window.show(route),
    restartServer: () => {
      if (started) {
        void supervisor.restart();
      } else {
        startServer();
      }
    },
    openLogs: () => void shell.openPath(logDir()),
    setOpenAtLogin: (enabled) => {
      app.setLoginItemSettings({ openAtLogin: enabled });
      refreshTray();
    },
    setSetting: (key, value) => {
      settings[key] = value;
      saveSettings(settings);
      updateDock();
      refreshTray();
    },
    installCli: () => void installCli(),
    quit: () => app.quit(),
  });
  function refreshTray() {
    tray.update({
      count: watcher.count,
      server: supervisor.state,
      settings,
      openAtLogin: app.isPackaged && app.getLoginItemSettings().openAtLogin,
      loginItemAvailable: app.isPackaged,
    });
  }

  async function installCli() {
    const result = installShim(dir);
    await dialog.showMessageBox({
      type: result.ok ? "info" : "warning",
      message: result.ok ? "Installed the passport command" : "Could not install the command",
      detail: result.ok
        ? `${result.path} runs this app's bundled CLI. Make sure ~/.local/bin is on your PATH. If you move Passport.app, install it again.`
        : result.reason,
    });
  }

  supervisor.on("state", (state) => {
    window.setServer(state);
    if (state.status === "ready") {
      watcher.connect(state.origin, state.token);
    } else {
      watcher.disconnect();
    }
    refreshTray();
  });
  watcher.on("count", (count) => {
    log("info", `Needing you: ${count}`);
    app.setBadgeCount(count);
    refreshTray();
  });
  watcher.on("attention", notify);

  // The menu bar keeps Passport (and its agent) running with every window closed.
  app.on("window-all-closed", () => {});
  app.on("activate", () => window.show());
  app.on("second-instance", (_event, argv) => {
    const link = linkFromArgv(argv);
    if (link) {
      handleLink(link);
    } else {
      window.show();
    }
  });
  let exiting = false;
  let stopping = false;
  app.on("before-quit", (event) => {
    if (exiting) {
      return;
    }
    event.preventDefault();
    if (stopping) {
      return;
    }
    stopping = true;
    log("info", "Quitting: stopping the server");
    watcher.disconnect();
    void supervisor.stop().finally(() => {
      exiting = true;
      app.quit();
    });
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => app.quit());
  }

  handleLink = (url) => {
    const route = routeFor(url);
    if (!route) {
      log("warn", "Ignored an unrecognised passport:// link");
    }
    window.show(route ?? undefined);
  };
  refreshTray();
  updateDock();
  startServer();
  if (pendingLinks.length) {
    for (const url of pendingLinks.splice(0)) {
      handleLink(url);
    }
  } else if (!launchedAtLogin) {
    window.show("/");
  }
  log("info", `Logs: ${join(logDir(), "server.log")}`);
}
