import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logs = mkdtempSync(join(tmpdir(), "passport-desktop-decisions-"));
vi.mock("electron", () => ({ app: { getPath: () => logs, isPackaged: false } }));
const { DecisionWatcher } = await import("./decisions");

/** A socket that never connects: the watcher's refreshes come from connect() itself. */
class QuietSocket {
  addEventListener() {}
  close() {}
}

describe("DecisionWatcher", () => {
  let items: { id: string; status: string; request?: { type: string } }[];
  beforeEach(() => {
    items = [];
    vi.stubGlobal("WebSocket", QuietSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("R3-14: the count clears while the server is away, and proposals made meanwhile are announced", async () => {
    const watcher = new DecisionWatcher();
    const counts: number[] = [];
    const announced: string[][] = [];
    watcher.on("count", (count) => counts.push(count));
    watcher.on("proposed", (decisions) => announced.push(decisions.map((d) => d.id)));
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
    expect(announced).toEqual([["b"]]);
    watcher.disconnect();
  });
});
