import type { Task } from "@passport/types";
import { describe, expect, it } from "vitest";
import {
  groupTasks,
  isFresh,
  jumpOrder,
  needsSeen,
  needsYou,
  snoozePresets,
  stateLabel,
  stateText,
  type TaskState,
  taskState,
} from "./model";
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

  it("orders the inbox by returnedAt, falling back to lastActivityAt on older rows", () => {
    const groups = groupTasks([
      // Busy in the background a minute ago, but it came back to you an hour ago.
      task("quiet", { lastActivityAt: minutesAgo(1), returnedAt: minutesAgo(60) }),
      task("back", { lastActivityAt: minutesAgo(20), returnedAt: minutesAgo(2) }),
      task("old-row", { lastActivityAt: minutesAgo(10) }),
    ]);
    expect(groups.inbox.map((t) => t.id)).toEqual(["back", "old-row", "quiet"]);
    const needs = needsYou([
      task("a", {
        needsUser: "approval",
        lastActivityAt: minutesAgo(1),
        returnedAt: minutesAgo(9),
      }),
      task("b", { needsUser: "failure", lastActivityAt: minutesAgo(5), returnedAt: minutesAgo(5) }),
    ]);
    expect(needs.map((t) => t.id)).toEqual(["b", "a"]);
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

describe("task state", () => {
  const watches = [
    { threadHandle: "th", account: "acc-1", since: minutesAgo(5), consecutiveWakes: 0 },
  ];
  /** v0.4 lifecycle fields (W1B). */
  const later = (fields: Partial<Task>) => fields;

  it("prefers what needs the person over activity, in taskBadge's order", () => {
    expect(taskState(task("a", { needsUser: "failure", status: "working" }), true)).toBe("failed");
    expect(taskState(task("a", { needsUser: "approval", unseenOutcome: "done" }))).toBe("approval");
    // `limited` without `needsUser` still reads Limited.
    expect(
      taskState(
        task("a", {
          limited: {
            runId: "r",
            resetAt: null,
            autoResume: true,
            source: "host_agent",
            at: minutesAgo(1),
          },
        }),
      ),
    ).toBe("limited");
    expect(taskState(task("a", { needsUser: "approval" }), true)).toBe("approval");
    expect(taskState(task("a", { needsUser: "question" }), true)).toBe("input");
    expect(taskState(task("a", later({ needsUser: "limited" })), true)).toBe("limited");
    expect(taskState(task("a", { status: "working" }))).toBe("working");
    expect(taskState(task("a"), true)).toBe("working");
    expect(taskState(task("a", { status: "working", watches }))).toBe("waiting");
    expect(taskState(task("a"))).toBe("idle");
  });

  it("shows Woke and Done only while the outcome is unseen", () => {
    expect(taskState(task("a", later({ unseenOutcome: "woke" })))).toBe("woke");
    expect(taskState(task("a", later({ unseenOutcome: "done" })))).toBe("done");
    expect(taskState(task("a", later({ unseenOutcome: null })))).toBe("idle");
    // Working outranks an unseen outcome.
    expect(taskState(task("a", later({ unseenOutcome: "done" })), true)).toBe("working");
  });

  it("names every state in the shared vocabulary", () => {
    const states: TaskState[] = [
      "approval",
      "input",
      "waiting",
      "working",
      "limited",
      "failed",
      "woke",
      "done",
    ];
    expect(states.map((s) => stateLabel[s])).toEqual([
      "Approval",
      "Input",
      "Waiting",
      "Working",
      "Limited",
      "Failed",
      "Woke",
      "Done",
    ]);
    expect(states.every((s) => stateText[s])).toBe(true);
  });

  it("brings a row forward only when it needs the person or an outcome is unseen", () => {
    expect(isFresh(task("a"))).toBe(false);
    expect(isFresh(task("a", { needsUser: "approval" }))).toBe(true);
    expect(isFresh(task("a", later({ unseenOutcome: "done" })))).toBe(true);
    expect(isFresh(task("a", later({ unseenOutcome: "woke", seenAt: minutesAgo(1) })))).toBe(true);
    // The server's rule: a return without an outcome (a reopen) recedes.
    expect(isFresh(task("a", later({ returnedAt: minutesAgo(2), seenAt: minutesAgo(5) })))).toBe(
      false,
    );
  });

  it("asks /seen only when there is something to clear", () => {
    expect(needsSeen(task("a"))).toBe(false);
    expect(needsSeen(task("a", { unseenOutcome: "done" }))).toBe(true);
    expect(needsSeen(task("a", { returnedAt: minutesAgo(2), seenAt: minutesAgo(5) }))).toBe(true);
    expect(needsSeen(task("a", { returnedAt: minutesAgo(5), seenAt: minutesAgo(2) }))).toBe(false);
    // Never seen and nothing to clear: no request.
    expect(needsSeen(task("a", { returnedAt: minutesAgo(5) }))).toBe(false);
  });
});

describe("jump order", () => {
  it("numbers the open sections in sidebar order and skips settled", () => {
    const tasks = [
      task("settled", { status: "settled", lastActivityAt: minutesAgo(0) }),
      task("nap", { status: "snoozed", snoozedUntil: minutesAgo(-60) }),
      task("run", { status: "working", lastActivityAt: minutesAgo(3) }),
      task("in", { status: "inbox", lastActivityAt: minutesAgo(9) }),
      task("pin", { status: "inbox", pinned: true, lastActivityAt: minutesAgo(60) }),
    ];
    expect(jumpOrder(tasks).map((t) => t.id)).toEqual(["pin", "in", "run", "nap"]);
    const many = Array.from({ length: 12 }, (_, i) => task(`t${i}`));
    expect(jumpOrder(many)).toHaveLength(9);
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
