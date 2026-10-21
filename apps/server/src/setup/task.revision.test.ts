import type { SetupTask } from "@passport/types";
import { describe, expect, it } from "vitest";
import { SetupTaskState } from "./task.js";

describe("SetupTaskState revision", () => {
  it("increments the revision on every published snapshot, including rescrubs", () => {
    const published: SetupTask[] = [];
    const state = new SetupTaskState("t1", "gmail", [{ id: "a", title: "A" }], (task) =>
      published.push(task),
    );
    state.log("info", "first line mentions s3cr3tvalue");
    state.log("info", "second line");
    state.addSecret("s3cr3tvalue");
    const revisions = published.map((task) => task.revision);
    expect(revisions).toEqual([1, 2, 3]);
    expect(state.snapshot().revision).toBe(3);
    expect(published[2]?.log[0]?.text).not.toContain("s3cr3tvalue");
  });
});
