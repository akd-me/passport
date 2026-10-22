import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/** Desktop-only preferences in userData. Launch-at-login state lives with macOS, not here. */
export interface DesktopSettings {
  /** Hide the Dock icon while no window is open, for a pure menu-bar feel. */
  menuBarOnly: boolean;
  notifications: boolean;
}

const DEFAULTS: DesktopSettings = { menuBarOnly: false, notifications: true };
const path = () => join(app.getPath("userData"), "desktop-settings.json");

export function loadSettings(): DesktopSettings {
  try {
    const saved = JSON.parse(readFileSync(path(), "utf8")) as Partial<DesktopSettings>;
    return {
      menuBarOnly:
        typeof saved.menuBarOnly === "boolean" ? saved.menuBarOnly : DEFAULTS.menuBarOnly,
      notifications:
        typeof saved.notifications === "boolean" ? saved.notifications : DEFAULTS.notifications,
    };
  } catch (error) {
    // First run (or a damaged file): start from the defaults, which the next save rewrites.
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: DesktopSettings): void {
  const temp = `${path()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path());
}
