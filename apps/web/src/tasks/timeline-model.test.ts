import { describe, expect, it } from "vitest";
import { item, run, tool } from "./test-fixtures";
import { buildTimeline, summarizeTools, type ToolCallItem } from "./timeline-model";

const shape = (entries: ReturnType<typeof buildTimeline>) =>
  entries.map((e) =>
    e.kind === "run"
      ? `run:${e.run.id}`
      : e.kind === "tools"
        ? `tools:${e.calls.map((c) => c.seq).join(",")}`
        : `${e.item.kind}:${e.item.seq}`,
  );

describe("timeline grouping", () => {
  it("collapses consecutive tool calls of one run, heads each run, and keeps seq order", () => {
    const items = [
      item("user_message", { text: "Find invoices" }, { seq: 1, runId: "r1" }),
      tool("mail_search", {}, { seq: 3, runId: "r1" }),
      tool("mail_read", {}, { seq: 2, runId: "r1" }),
      item("assistant_message", { text: "Found 9" }, { seq: 4, runId: "r1" }),
      tool("mail_read", {}, { seq: 5, runId: "r1" }),
      tool("archive_emails", {}, { seq: 6, runId: "r2" }),
      item("notification", { source: "arrival", summary: "New mail" }, { seq: 7, runId: null }),
    ];
    const runs = [run("r1", "t1"), run("r2", "t1"), run("r3", "t1", { status: "queued" })];
    expect(shape(buildTimeline(items, runs))).toEqual([
      "run:r1",
      "user_message:1",
      "tools:2,3",
      "assistant_message:4",
      "tools:5",
      // A new run breaks the group even without another item in between.
      "run:r2",
      "tools:6",
      "notification:7",
      // A queued run with nothing yet sits at the end.
      "run:r3",
    ]);
  });
});

describe("tool group summary", () => {
  const calls = (...list: ToolCallItem[]) => list;

  it("names at most two categories, writes first, and counts the rest", () => {
    expect(
      summarizeTools(
        calls(
          tool("mail_search"),
          tool("mail_search"),
          tool("mail_read"),
          tool("mail_read"),
          tool("mail_read"),
          tool("mail_read"),
          tool("archive_emails", { inputSummary: 'emailIds=[40 items] reason="noise"' }),
        ),
      ),
    ).toBe("Archived 40, read 4 messages and 1 other step");
  });

  it("says twice and once", () => {
    expect(summarizeTools(calls(tool("mail_search"), tool("mail_search")))).toBe("Searched twice");
    expect(summarizeTools(calls(tool("mail_search")))).toBe("Searched once");
  });

  it("never over-claims: proposals, plans and failures", () => {
    expect(
      summarizeTools(
        calls(
          tool("archive_emails", {
            inputSummary: 'emailIds=["a"]',
            resultSummary: "status proposed, action x",
          }),
          tool("send", { planned: true, resultSummary: "Planned (plan mode, not executed)" }),
        ),
      ),
    ).toBe("Asked to archive 1, planned to send 1 message");
    expect(
      summarizeTools(calls(tool("send", { isError: true, resultSummary: "SEND_FAILED" }))),
    ).toBe("1 call failed");
    expect(summarizeTools(calls(tool("mail_search"), tool("send", { isError: true })))).toBe(
      "Searched once; 1 failed",
    );
  });
});
