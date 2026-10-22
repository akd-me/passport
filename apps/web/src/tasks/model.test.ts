import { describe, expect, it } from "vitest";
import { glyphOf, groupTasks, needsYou, snoozePresets } from "./model";
import { minutesAgo, task } from "./test-fixtures";

describe("sidebar grouping", () => {
  const tasks = [
    task("a", { status: "inbox", lastActivityAt: minutesAgo(30) }),
    task("b", { status: "inbox", lastActivityAt: minutesAgo(5) }),
    task("c", { status: "working", pinned: true, lastActivityAt: minutesAgo(50) }),
    task("d", { status: "working", lastActivityAt: minutesAgo(1) }),
    task("e", { status: "snoozed", snoozedUntil: minutesAgo(-60) }),
    task("f", { status: "settled" }),
    task("g", { status: "archived" }),
    task("h", { status: "settled", pinned: true, lastActivityAt: minutesAgo(2) }),
  ];

  it("puts pinned tasks first whatever their status, and leaves archived ones out", () => {
    const groups = groupTasks(tasks);
    const ids = Object.fromEntries(
      Object.entries(groups).map(([section, list]) => [section, list.map((t) => t.id)]),
    );
    expect(ids).toEqual({
      pinned: ["h", "c"],
      inbox: ["b", "a"],
      working: ["d"],
      snoozed: ["e"],
      settled: ["f"],
    });
  });

  it("orders each section by lastActivityAt, newest first, then by id", () => {
    const same = minutesAgo(3);
    const groups = groupTasks([
      task("x", { lastActivityAt: same }),
      task("y", { lastActivityAt: same }),
      task("z", { lastActivityAt: minutesAgo(1) }),
    ]);
    expect(groups.inbox.map((t) => t.id)).toEqual(["z", "y", "x"]);
  });

  it("lists what needs the person, not archived tasks", () => {
    const list = needsYou([
      task("a", { needsUser: "approval", lastActivityAt: minutesAgo(9) }),
      task("b", { needsUser: "failure", lastActivityAt: minutesAgo(1) }),
      task("c", { needsUser: "approval", status: "archived" }),
      task("d"),
    ]);
    expect(list.map((t) => t.id)).toEqual(["b", "a"]);
  });
});

describe("status glyph", () => {
  it("prefers what needs the person over activity", () => {
    expect(glyphOf(task("a", { needsUser: "failure", status: "working" }), true)).toBe("failure");
    expect(glyphOf(task("a", { needsUser: "approval" }), true)).toBe("approval");
    expect(glyphOf(task("a", { status: "working" }))).toBe("running");
    expect(glyphOf(task("a"), true)).toBe("running");
    const watches = [
      { threadHandle: "th", account: "acc-1", since: minutesAgo(5), consecutiveWakes: 0 },
    ];
    expect(glyphOf(task("a", { status: "working", watches }))).toBe("watching");
    expect(glyphOf(task("a"))).toBe("idle");
  });
});

describe("snooze presets", () => {
  it("are all in the future and in order", () => {
    for (const now of [new Date(2026, 9, 19, 9), new Date(2026, 9, 25, 22, 30)]) {
      const presets = snoozePresets(now);
      const times = presets.map((p) => p.until.getTime());
      expect(times.every((t) => t > now.getTime())).toBe(true);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(presets.at(-1)!.until.getDay()).toBe(1);
    }
  });
});
