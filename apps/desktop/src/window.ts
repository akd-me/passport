// The single app window. It only ever shows the local server's origin; every other http(s)
// link, including OAuth consent pages, opens in the system browser.
import { join } from "node:path";
import { app, BrowserWindow, type Session, shell } from "electron";
import { loginUrl } from "./discovery";
import { log } from "./paths";
import type { ServerState } from "./server";

const LOGIN_TTL_MS = 23 * 60 * 60 * 1000; // The server's cookie session lasts 24 h.
const REAUTH_INTERVAL_MS = 10_000;
/** Permissions the Passport UI may use; everything else (camera, location, …) is denied. */
const PERMISSIONS = new Set(["notifications", "clipboard-sanitized-write"]);

/** True when `url` (http or WebSocket) goes to the server at `origin`. */
export function toServer(url: string, origin: string): boolean {
  try {
    const target = new URL(url);
    const server = new URL(origin);
    const ws = server.protocol === "https:" ? "wss:" : "ws:";
    return target.host === server.host && [server.protocol, ws].includes(target.protocol);
  } catch {
    // Not a URL: never ours.
    return false;
  }
}

function openExternal(url: string): void {
  try {
    const { protocol } = new URL(url);
    if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") {
      void shell.openExternal(url);
    }
  } catch {
    // Not a URL: there is nothing safe to open.
  }
}

function statusPage(title: string, detail: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  };
  const escapeHtml = (value: string) => value.replace(/[&<>"]/g, (c) => entities[c] ?? c);
  const html = `<!doctype html><meta charset="utf-8"><title>Passport</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#222;background:#fafafa}
@media (prefers-color-scheme:dark){body{color:#eee;background:#1c1c1e}}main{max-width:440px;text-align:center}p{opacity:.7;line-height:1.45}</style>
<main><h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p></main>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export class MainWindow {
  private window: BrowserWindow | null = null;
  private server: ServerState = { status: "starting", detail: "Starting Passport…" };
  private loggedIn: { generation: number; at: number } | null = null;
  private pendingRoute = "/";
  /** Each render takes a ticket so a slow login cannot navigate over a newer render. */
  private renders = 0;

  private lastReauth = 0;

  constructor(
    private readonly onVisibilityChange: () => void,
    /** The server answered 401 although the window sends the token: it may have rotated. */
    private readonly onUnauthorized: () => void = () => {},
  ) {}

  get isOpen(): boolean {
    return !!this.window && !this.window.isDestroyed();
  }

  /** Show (creating if needed) and navigate. Without a route, an open window is only focused. */
  show(route?: string): void {
    const created = !this.window || this.window.isDestroyed();
    const window = created ? this.create() : (this.window as BrowserWindow);
    this.window = window;
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
    if (route !== undefined || created) {
      this.pendingRoute = route ?? "/";
      void this.render();
    } else if (this.server.status === "ready" && !this.fresh(this.server.generation)) {
      // A window left open past its cookie session: sign in again where it was.
      this.pendingRoute = this.currentRoute(this.server) ?? this.pendingRoute;
      void this.render();
    }
  }

  /** Called on every server state change; reloads only when the visible content is stale. */
  setServer(state: ServerState): void {
    const previous = this.server;
    this.server = state;
    if (!this.isOpen) {
      return;
    }
    const sameServer =
      previous.status === "ready" &&
      state.status === "ready" &&
      previous.generation === state.generation;
    if (!sameServer) {
      // The page shown belongs to the previous state, so read its route against that.
      this.pendingRoute = this.currentRoute(previous) ?? this.pendingRoute;
      void this.render();
    }
  }

  private fresh(generation: number): boolean {
    return this.loggedIn?.generation === generation && Date.now() - this.loggedIn.at < LOGIN_TTL_MS;
  }

  private currentRoute(shown: ServerState): string | null {
    if (shown.status !== "ready" || !this.window) {
      return null;
    }
    try {
      const url = new URL(this.window.webContents.getURL());
      return url.protocol === "data:" ? null : `${url.pathname}${url.search}`;
    } catch {
      // An empty or unparsable URL has no route to preserve.
      return null;
    }
  }

  /** Superseded loads reject with ERR_ABORTED; only a newer render can cause that, so ignore it. */
  private async load(window: BrowserWindow, url: string): Promise<boolean> {
    try {
      await window.loadURL(url);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code !== "ERR_ABORTED") {
        log(
          "warn",
          `The window could not load the Passport UI (${(error as { code?: string }).code})`,
        );
      }
      return false;
    }
  }

  private async render(): Promise<void> {
    const window = this.window;
    if (!window || window.isDestroyed()) {
      return;
    }
    const ticket = ++this.renders;
    const state = this.server;
    if (state.status !== "ready") {
      const title = state.status === "failed" ? "Passport could not start" : "Starting Passport…";
      await this.load(window, statusPage(title, state.detail));
      return;
    }
    const target = `${state.origin}${this.pendingRoute}`;
    if (!this.fresh(state.generation)) {
      // The login URL sets the HttpOnly session cookie in this window's session and redirects to /.
      const ok = await this.load(window, loginUrl(state.origin, state.token));
      if (!ok || ticket !== this.renders || window.isDestroyed()) {
        return;
      }
      this.loggedIn = { generation: state.generation, at: Date.now() };
      if (this.pendingRoute === "/") {
        return;
      }
    }
    await this.load(window, target);
  }

  /**
   * The window authenticates every request to the server with its token, so an expired cookie
   * session or a restarted server never strands it on the token prompt. A 401 despite that means
   * the token changed: re-read it and sign in again, at most every 10 s.
   */
  private guardSession(session: Session): void {
    const server = () => (this.server.status === "ready" ? this.server : null);
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      const ready = server();
      if (ready && toServer(details.url, ready.origin)) {
        details.requestHeaders.Authorization = `Bearer ${ready.token}`;
      }
      callback({ requestHeaders: details.requestHeaders });
    });
    session.webRequest.onCompleted((details) => {
      const ready = server();
      if (!ready || details.statusCode !== 401 || !toServer(details.url, ready.origin)) {
        return;
      }
      if (Date.now() - this.lastReauth < REAUTH_INTERVAL_MS) {
        return;
      }
      this.lastReauth = Date.now();
      log("warn", "The server rejected the window's session; signing in again");
      this.loggedIn = null;
      this.onUnauthorized();
      this.pendingRoute = this.currentRoute(this.server) ?? this.pendingRoute;
      void this.render();
    });
    const allowed = (permission: string, url: string) => {
      const ready = server();
      return PERMISSIONS.has(permission) && !!ready && toServer(url, ready.origin);
    };
    session.setPermissionRequestHandler((contents, permission, callback) =>
      callback(allowed(permission, contents.getURL())),
    );
    session.setPermissionCheckHandler((_contents, permission, origin) =>
      allowed(permission, origin),
    );
  }

  private create(): BrowserWindow {
    const window = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 880,
      minHeight: 560,
      title: "Passport",
      show: false,
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    const sameOrigin = (url: string) => {
      try {
        return this.server.status === "ready" && new URL(url).origin === this.server.origin;
      } catch {
        // Unparsable navigation targets are never followed.
        return false;
      }
    };
    window.webContents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: "deny" };
    });
    // will-navigate misses server redirects and subframes, so guard those routes off the origin too.
    const leave = (event: Electron.Event & { url: string }) => {
      if (!sameOrigin(event.url)) {
        event.preventDefault();
        openExternal(event.url);
      }
    };
    window.webContents.on("will-navigate", leave);
    window.webContents.on("will-redirect", leave);
    window.webContents.on("will-frame-navigate", (event) => {
      if (!event.isMainFrame && !sameOrigin(event.url)) {
        event.preventDefault();
      }
    });
    this.guardSession(window.webContents.session);
    window.on("closed", () => {
      this.window = null;
      this.onVisibilityChange();
    });
    if (process.platform === "darwin") {
      void app.dock?.show();
    }
    this.onVisibilityChange();
    return window;
  }
}
