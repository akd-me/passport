// The menu-bar item: a "needs you" count as its title, and the app's few desktop settings.
import { join } from "node:path";
import { Menu, type MenuItemConstructorOptions, nativeImage, Tray } from "electron";
import type { ServerState } from "./server";
import type { DesktopSettings } from "./settings";

export interface TrayActions {
  open(route?: string): void;
  restartServer(): void;
  openLogs(): void;
  setOpenAtLogin(enabled: boolean): void;
  setSetting(key: keyof DesktopSettings, value: boolean): void;
  installCli(): void;
  quit(): void;
}

export interface TrayModel {
  count: number;
  server: ServerState;
  settings: DesktopSettings;
  openAtLogin: boolean;
  /** Login items register the running binary, so only the packaged app offers one. */
  loginItemAvailable: boolean;
}

function serverLine(state: ServerState): string {
  if (state.status === "ready") {
    const port = new URL(state.origin).port;
    return state.attached
      ? `Using passport serve (pid ${state.pid}) on port ${port}`
      : `Server running on port ${port}`;
  }
  return state.status === "failed" ? "Server stopped (retrying)" : "Server starting…";
}

export class MenuBar {
  private readonly tray: Tray;

  constructor(private readonly actions: TrayActions) {
    const icon = nativeImage.createFromPath(join(__dirname, "trayTemplate.png"));
    icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.tray.setToolTip("Passport");
  }

  update(model: TrayModel): void {
    const { count, server, settings, openAtLogin, loginItemAvailable } = model;
    this.tray.setTitle(count > 0 ? String(count) : "", { fontType: "monospacedDigit" });
    this.tray.setToolTip(count > 0 ? `Passport: ${count} need you` : "Passport");
    const a = this.actions;
    const template: MenuItemConstructorOptions[] = [
      {
        label:
          count > 0 ? `${count} decision${count === 1 ? "" : "s"} need you` : "Nothing needs you",
        enabled: count > 0,
        click: () => a.open("/"),
      },
      { label: "Open Passport", accelerator: "CommandOrControl+O", click: () => a.open() },
      { type: "separator" },
      { label: serverLine(server), enabled: false },
      ...(server.status === "failed" ? [{ label: server.detail, enabled: false }] : []),
      {
        label: "Restart Server",
        enabled: !(server.status === "ready" && server.attached),
        click: () => a.restartServer(),
      },
      { label: "Show Logs in Finder", click: () => a.openLogs() },
      { type: "separator" },
      {
        label: "Open at Login",
        type: "checkbox",
        checked: openAtLogin,
        enabled: loginItemAvailable,
        click: (item) => a.setOpenAtLogin(item.checked),
      },
      {
        label: "Hide Dock Icon When No Window Is Open",
        type: "checkbox",
        checked: settings.menuBarOnly,
        click: (item) => a.setSetting("menuBarOnly", item.checked),
      },
      {
        label: "Notifications",
        type: "checkbox",
        checked: settings.notifications,
        click: (item) => a.setSetting("notifications", item.checked),
      },
      { label: "Install `passport` Command…", click: () => a.installCli() },
      { type: "separator" },
      { label: "Quit Passport", accelerator: "CommandOrControl+Q", click: () => a.quit() },
    ];
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }
}
