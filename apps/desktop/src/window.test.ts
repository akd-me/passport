import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: never[]) => unknown;
const logs = mkdtempSync(join(tmpdir(), "passport-desktop-window-"));
const opened: string[] = [];

/** Just enough of Electron's BrowserWindow, webContents and session for MainWindow. */
class FakeWindow {
  static last: FakeWindow;
  url = "";
  loads: string[] = [];
  events = new Map<string, Listener>();
  hooks: Record<string, Listener> = {};
  webContents = {
    setWindowOpenHandler: () => {},
    on: (name: string, listener: Listener) => this.events.set(name, listener),
    getURL: () => this.url,
    session: {
      webRequest: {
        onBeforeSendHeaders: (listener: Listener) => {
          this.hooks.headers = listener;
        },
        onCompleted: (listener: Listener) => {
          this.hooks.completed = listener;
        },
      },
      setPermissionRequestHandler: (listener: Listener) => {
        this.hooks.permission = listener;
      },
      setPermissionCheckHandler: (listener: Listener) => {
        this.hooks.check = listener;
      },
    },
  };
  constructor() {
    FakeWindow.last = this;
  }
  async loadURL(url: string) {
    this.loads.push(url);
    // The ?token= login URL redirects to /, as the server does.
    this.url = url.includes("?token=") ? `${new URL(url).origin}/` : url;
  }
  isDestroyed = () => false;
  isMinimized = () => false;
  restore() {}
  show() {}
  focus() {}
  on() {}
}

vi.mock("electron", () => ({
  app: { getPath: () => logs, isPackaged: false, dock: undefined },
  BrowserWindow: FakeWindow,
  shell: { openExternal: async (url: string) => opened.push(url) },
}));
const { MainWindow, toServer } = await import("./window");

const ORIGIN = "http://127.0.0.1:3917";
const ready = (generation = 1, token = "t".repeat(64)) => ({
  status: "ready" as const,
  origin: ORIGIN,
  token,
  attached: false,
  pid: 1,
  generation,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MainWindow", () => {
  beforeEach(() => {
    opened.length = 0;
  });

  it("R3-6: every request to the server carries the token, so an expired cookie never strands the window", async () => {
    const window = new MainWindow(() => {});
    window.setServer(ready());
    window.show("/");
    await settle();
    const fake = FakeWindow.last;
    const send = (url: string) => {
      let sent: Record<string, string> = {};
      fake.hooks.headers?.(
        { url, requestHeaders: {} } as never,
        ((result: { requestHeaders: Record<string, string> }) => {
          sent = result.requestHeaders;
        }) as never,
      );
      return sent;
    };
    expect(send(`${ORIGIN}/api/decisions`).Authorization).toBe(`Bearer ${"t".repeat(64)}`);
    expect(send("ws://127.0.0.1:3917/ws").Authorization).toBe(`Bearer ${"t".repeat(64)}`);
    expect(send("https://accounts.google.com/").Authorization).toBeUndefined();
    expect(send("http://127.0.0.1:3000/api/decisions").Authorization).toBeUndefined();
    expect(toServer("http://127.0.0.1:3917.evil.example/", ORIGIN)).toBe(false);
  });

  it("R3-6: a 401 from the server re-reads the token and signs in again where the user was", async () => {
    const unauthorized = vi.fn();
    const window = new MainWindow(() => {}, unauthorized);
    window.setServer(ready());
    window.show("/matters/m1");
    await settle();
    const fake = FakeWindow.last;
    expect(fake.loads).toEqual([`${ORIGIN}/?token=${"t".repeat(64)}`, `${ORIGIN}/matters/m1`]);
    fake.hooks.completed?.({ url: `${ORIGIN}/api/matters/m1`, statusCode: 401 } as never);
    await settle();
    expect(unauthorized).toHaveBeenCalledOnce();
    expect(fake.loads.slice(2)).toEqual([
      `${ORIGIN}/?token=${"t".repeat(64)}`,
      `${ORIGIN}/matters/m1`,
    ]);
    // Rate-limited: a page firing many 401s does not loop logins.
    fake.hooks.completed?.({ url: `${ORIGIN}/api/x`, statusCode: 401 } as never);
    expect(unauthorized).toHaveBeenCalledOnce();
  });

  it("R3-6: focusing a window whose login went stale signs in again; a ready→failed→ready cycle keeps the route", async () => {
    const window = new MainWindow(() => {});
    window.setServer(ready(1));
    window.show("/trust");
    await settle();
    const fake = FakeWindow.last;
    const loads = fake.loads.length;
    window.show(); // fresh login: focus only
    await settle();
    expect(fake.loads).toHaveLength(loads);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    window.show(); // "Open Passport" after a day
    vi.useRealTimers();
    await settle();
    expect(fake.loads.slice(loads)).toEqual([
      `${ORIGIN}/?token=${"t".repeat(64)}`,
      `${ORIGIN}/trust`,
    ]);
    fake.url = `${ORIGIN}/matters/m2`; // the user moved on inside the web app
    window.setServer({ status: "failed", detail: "stopped" });
    await settle();
    window.setServer(ready(2));
    await settle();
    expect(fake.loads.at(-1)).toBe(`${ORIGIN}/matters/m2`);
  });

  it("R3-12: server redirects off the origin are stopped, and only notifications are permitted", async () => {
    const window = new MainWindow(() => {});
    window.setServer(ready());
    window.show("/");
    await settle();
    const fake = FakeWindow.last;
    const event = (url: string, isMainFrame = true) => {
      const prevent = vi.fn();
      return { url, isMainFrame, preventDefault: prevent, prevent };
    };
    const redirect = event("https://accounts.google.com/o/oauth2/v2/auth");
    fake.events.get("will-redirect")?.(redirect as never);
    expect(redirect.prevent).toHaveBeenCalled();
    expect(opened).toEqual(["https://accounts.google.com/o/oauth2/v2/auth"]);
    const local = event(`${ORIGIN}/accounts`);
    fake.events.get("will-redirect")?.(local as never);
    expect(local.prevent).not.toHaveBeenCalled();
    const frame = event("https://tracker.example/", false);
    fake.events.get("will-frame-navigate")?.(frame as never);
    expect(frame.prevent).toHaveBeenCalled();
    const decide = (permission: string, url = `${ORIGIN}/`) => {
      let granted: boolean | undefined;
      fake.hooks.permission?.(
        { getURL: () => url } as never,
        permission as never,
        ((value: boolean) => {
          granted = value;
        }) as never,
      );
      return granted;
    };
    expect(decide("notifications")).toBe(true);
    expect(decide("media")).toBe(false);
    expect(decide("geolocation")).toBe(false);
    expect(decide("notifications", "https://elsewhere.example/")).toBe(false);
    expect(fake.hooks.check?.({} as never, "media" as never, ORIGIN as never)).toBe(false);
  });
});
