import { describe, expect, it } from "vitest";
import { describeTask, snapshot } from "./attention";

describe("snapshot", () => {
  const send = (id: string) => ({ id, status: "proposed", request: { type: "send" } });

  it("counts tasks that need the person plus proposals no task owns", () => {
    const tasks = [
      { id: "t1", status: "inbox", needsUser: "approval", pendingActionIds: ["a1", "a2"] },
      { id: "t2", status: "working", needsUser: null },
      { id: "t3", status: "archived", needsUser: "failure" },
    ];
    const result = snapshot([send("a1"), send("a2"), send("mcp")], tasks, null);
    expect(result.count).toBe(2); // t1 and the host agent's proposal
    expect(result.fresh).toEqual([]); // the baseline announces nothing
  });

  it("announces a task once per need, by its task link", () => {
    const failing = { id: "t1", title: "Chase invoice", status: "inbox", needsUser: "failure" };
    const first = snapshot([], [failing], null);
    expect(snapshot([], [failing], first.seen).fresh).toEqual([]);
    const asking = { ...failing, needsUser: "approval", pendingActionIds: ["a1"] };
    const second = snapshot([send("a1")], [asking], first.seen);
    expect(second.fresh).toEqual([
      { link: "passport://task/t1", title: "Waiting for your approval: Chase invoice" },
    ]);
    // A further proposal in the same task nudges again, still as the task.
    const third = snapshot(
      [send("a1"), send("a2")],
      [{ ...asking, pendingActionIds: ["a1", "a2"] }],
      second.seen,
    );
    expect(third.fresh.map((a) => a.link)).toEqual(["passport://task/t1"]);
  });

  it("without task routes counts and announces pending decisions", () => {
    const first = snapshot([send("a")], null, null);
    const second = snapshot([send("a"), send("b"), { id: "c", status: "held" }], null, first.seen);
    expect(second.count).toBe(2);
    expect(second.fresh.map((a) => a.link)).toEqual(["passport://decision/b"]);
  });
});

describe("describeTask", () => {
  it("collapses whitespace and truncates long titles", () => {
    expect(describeTask({ id: "t", needsUser: "question", title: `a\n${"b".repeat(100)}` })).toBe(
      `Has a question for you: a ${"b".repeat(77)}…`,
    );
  });
});
