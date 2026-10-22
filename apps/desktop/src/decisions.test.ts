import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingAction, TaskSummary } from "./attention";

const logs = mkdtempSync(join(tmpdir(), "passport-desktop-decisions-"));
vi.mock("electron", () => ({ app: { getPath: () => logs, isPackaged: false } }));
const { DecisionWatcher } = await import("./decisions");

/** A socket that never connects: the watcher's refreshes come from connect() itself. */
class QuietSocket {
  addEventListener() {}
  close() {}
}

describe("DecisionWatcher", () => {
  let items: PendingAction[];
  /** Null = the server has no task routes (demo answers 501 TASKS_UNAVAILABLE). */
  let tasks: TaskSummary[] | null;
  let requested: string[];
  beforeEach(() => {
    items = [];
    tasks = null;
    requested = [];
    vi.stubGlobal("WebSocket", QuietSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const { pathname, search } = new URL(url);
        requested.push(`${pathname}${search}`);
        if (pathname === "/api/tasks") {
          return tasks
            ? Response.json({ items: tasks, nextCursor: null })
            : Response.json({ error: { code: "TASKS_UNAVAILABLE" } }, { status: 501 });
        }
        return Response.json({ items });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  function watch() {
    const watcher = new DecisionWatcher();
    const counts: number[] = [];
    const announced: string[][] = [];
    watcher.on("count", (count) => counts.push(count));
    watcher.on("attention", (list) => announced.push(list.map((a) => a.link)));
    return { watcher, counts, announced };
  }

  it("R3-14: the count clears while the server is away, and proposals made meanwhile are announced", async () => {
    const { watcher, counts, announced } = watch();
    items = [{ id: "a", status: "proposed", request: { type: "send" } }];
    watcher.connect("http://127.0.0.1:3917", "token");
    await settle();
    expect(counts).toEqual([1]);
    expect(announced).toEqual([]); // the first snapshot is the baseline

    watcher.disconnect(); // the server stopped
    expect(counts).toEqual([1, 0]);
    expect(watcher.count).toBe(0);

    items.push({ id: "b", status: "proposed", request: { type: "archive" } });
    watcher.connect("http://127.0.0.1:3917", "token"); // back, after b was proposed
    await settle();
    expect(counts).toEqual([1, 0, 2]);
    expect(announced).toEqual([["passport://decision/b"]]);
    watcher.disconnect();
  });

  it("counts tasks that need the person when the server has task routes, and opens the task", async () => {
    const { watcher, counts, announced } = watch();
    tasks = [{ id: "t1", title: "Plan offsite", status: "inbox", needsUser: "failure" }];
    watcher.connect("http://127.0.0.1:3917", "token");
    await settle();
    expect(counts).toEqual([1]);
    expect(requested).toContain("/api/tasks?status=inbox,working,snoozed&limit=500");

    watcher.disconnect();
    items = [{ id: "a1", status: "proposed", request: { type: "send" } }];
    tasks.push({ id: "t2", status: "inbox", needsUser: "approval", pendingActionIds: ["a1"] });
    watcher.connect("http://127.0.0.1:3917", "token");
    await settle();
    // t2 and its proposal are one thing that needs you, announced as the task.
    expect(counts).toEqual([1, 0, 2]);
    expect(announced).toEqual([["passport://task/t2"]]);
    watcher.disconnect();
  });

  it("falls back to pending decisions once the server reports no task routes", async () => {
    const { watcher, counts } = watch();
    items = [
      { id: "a", status: "proposed" },
      { id: "b", status: "approved" },
    ];
    watcher.connect("http://127.0.0.1:3917", "token");
    await settle();
    expect(counts).toEqual([1]);
    expect(requested.filter((path) => path.startsWith("/api/tasks"))).toHaveLength(1);
    watcher.disconnect();
  });
});
