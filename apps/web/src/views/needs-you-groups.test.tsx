import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceProvider } from "../state";
import { lifecycleBackend } from "../tasks/lifecycle-backend";
import { TasksProvider } from "../tasks/store";
import { minutesAgo, task } from "../tasks/test-fixtures";
import { Harness } from "../test-utils";
import { groupNeedsYou, needsYouGroups, registerNeedsYouGroup } from "./needs-you-groups";
import { TasksNeedingYou } from "./TasksNeedingYou";

const resetAt = () => new Date(Date.now() + 2 * 3_600_000).toISOString();
const tasks = () => [
  task("ap", { title: "Approve the reply", needsUser: "approval", pendingActionIds: ["a1"] }),
  task("lim", {
    title: "Stopped at a limit",
    needsUser: "limited",
    limited: {
      runId: "r1",
      resetAt: resetAt(),
      autoResume: false,
      source: "provider",
      at: minutesAgo(1),
    },
  }),
  task("bad", { title: "Broke", needsUser: "failure" }),
  task("ask", { title: "Needs a password", needsUser: "question" }),
  task("calm", { title: "Nothing to do" }),
];

const original = [...needsYouGroups];
afterEach(() => {
  needsYouGroups.splice(0, needsYouGroups.length, ...original);
});

function renderNeedsYou() {
  const backend = lifecycleBackend(tasks());
  render(
    <WorkspaceProvider>
      <Harness path="/needs-you">
        <TasksProvider>
          <TasksNeedingYou />
        </TasksProvider>
      </Harness>
    </WorkspaceProvider>,
  );
  return backend;
}
const headings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);

describe("Needs you groups", () => {
  it("groups by what the task waits on, and keeps an unclaimed kind visible", async () => {
    renderNeedsYou();
    await screen.findByText("Approve the reply");
    expect(headings()).toEqual([
      "Approvals",
      "Paused at a usage limit",
      "Failed",
      "Waiting on you",
    ]);
    const other = screen.getByRole("region", { name: "Waiting on you" });
    expect(within(other).getByText("Needs a password")).toBeInTheDocument();
    expect(screen.queryByText("Nothing to do")).toBeNull();
  });

  it("puts the Limited recovery actions beside the row, outside its link", async () => {
    const backend = renderNeedsYou();
    const group = await screen.findByRole("region", { name: "Paused at a usage limit" });
    const resume = within(group).getByRole("button", { name: "Resume" });
    expect(resume.closest("a")).toBeNull();
    expect(within(group).getByRole("button", { name: "Resume at reset" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Snooze until reset" })).toBeInTheDocument();
    fireEvent.click(resume);
    await waitFor(() => expect(backend.writes()).toEqual(["POST /tasks/lim/resume"]));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Paused at a usage limit" })).toBeNull(),
    );
  });

  it("takes another group by registering one entry (the questions group W2A adds)", async () => {
    registerNeedsYouGroup(
      { id: "question", label: "Questions", match: (t) => t.needsUser === "question" },
      "limited",
    );
    renderNeedsYou();
    await screen.findByText("Approve the reply");
    expect(headings()).toEqual(["Approvals", "Questions", "Paused at a usage limit", "Failed"]);
  });

  it("keeps the incoming order inside each group and drops empty groups", () => {
    const list = [
      task("f2", { needsUser: "failure" }),
      task("a1", { needsUser: "approval" }),
      task("f1", { needsUser: "failure" }),
    ];
    expect(
      groupNeedsYou(list).map(({ group, tasks }) => [group.id, tasks.map((t) => t.id)]),
    ).toEqual([
      ["approval", ["a1"]],
      ["failed", ["f2", "f1"]],
    ]);
  });
});
