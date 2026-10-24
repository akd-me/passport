/** W2A web: the question card, the Lineage panel, the subtasks line, sidebar and Needs you. */
import type { Task, TaskLineage } from "@passport/types";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceProvider } from "../state";
import { Harness, stubApi } from "../test-utils";
import { TaskPage } from "../views/Task";
import { TasksNeedingYou } from "../views/TasksNeedingYou";
import { subtasksSummary } from "./lineage-model";
import { groupTasks } from "./model";
import { TasksProvider } from "./store";
import { FakeSocket, run, task } from "./test-fixtures";

const delegation = {
  parentRunId: "r1",
  mode: "async" as const,
  completionWake: "settled_only" as const,
  depth: 1,
  delegatedAt: "2026-10-22T11:00:00Z",
};

function setup(parent: Task, lineage: TaskLineage, list: Task[] = [parent]) {
  vi.stubGlobal("WebSocket", FakeSocket);
  let current = parent;
  const fetchMock = stubApi({
    "/tasks": (url: URL, init?: RequestInit) => {
      const path = url.pathname.replace(/^\/api/, "");
      if (path === "/tasks") {
        return { items: list, total: list.length };
      }
      if (path === "/tasks/t1") {
        return { task: current, runs: [run("r1", "t1")] };
      }
      if (path === "/tasks/t1/items") {
        return { items: [], lastSeq: 0 };
      }
      if (path === "/tasks/t1/lineage") {
        return lineage;
      }
      if (path.endsWith("/answer")) {
        current = { ...current, pendingQuestions: [], needsUser: null, revision: 9 };
        return Response.json({ task: current, run: run("r2", "t1") }, { status: 202 });
      }
      if (path.endsWith("/dismiss") && init?.method === "POST") {
        current = { ...current, pendingQuestions: [], needsUser: null, revision: 9 };
        return current;
      }
      return current;
    },
    "/decisions": { items: [] },
    "/actions": { items: [] },
    "/trust": { config: { globalMode: "supervised", alwaysAsk: [] }, categories: [] },
  });
  render(
    <WorkspaceProvider>
      <Harness path="/tasks/t1">
        <TasksProvider>
          <Routes>
            <Route path="/tasks/:id" element={<TaskPage />} />
          </Routes>
          <TasksNeedingYou />
        </TasksProvider>
      </Harness>
    </WorkspaceProvider>,
  );
  return {
    posts: () =>
      fetchMock.mock.calls
        .filter(([, init]) => init?.method === "POST")
        .map(([input, init]) => ({
          path: new URL(String(input), "http://localhost").pathname,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        })),
  };
}

const question = {
  itemId: "q1",
  runId: "r1",
  text: "Which **year**?",
  options: ["2025", "2026"],
  blocking: true,
  askedAt: "2026-10-22T11:50:00Z",
};
const noLineage: TaskLineage = { taskId: "t1", parent: null, children: [] };

beforeEach(() => {
  FakeSocket.last = undefined;
});

describe("questions", () => {
  it("shows the open question above the composer and answers with an option", async () => {
    const parent = task("t1", { needsUser: "question", pendingQuestions: [question] });
    const { posts } = setup(parent, noLineage);
    const panel = await screen.findByRole("region", { name: "Questions" });
    expect(within(panel).getByText("year").tagName).toBe("STRONG");
    expect(within(panel).getByText(/waiting for your answer/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "2026" }));
    await waitFor(() =>
      expect(posts()).toContainEqual({
        path: "/api/tasks/t1/questions/q1/answer",
        body: { text: "2026" },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("region", { name: "Questions" })).toBeNull());
  });

  it("dismisses a question", async () => {
    const parent = task("t1", { needsUser: "question", pendingQuestions: [question] });
    const { posts } = setup(parent, noLineage);
    const panel = await screen.findByRole("region", { name: "Questions" });
    fireEvent.click(within(panel).getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(posts().map((p) => p.path)).toContain("/api/tasks/t1/questions/q1/dismiss"),
    );
  });

  it("groups questions in Needs you with the question text", async () => {
    const asking = task("t1", { needsUser: "question", pendingQuestions: [question] });
    const approving = task("t2", { needsUser: "approval", pendingActionIds: ["a1"] });
    setup(asking, noLineage, [asking, approving]);
    const group = await screen.findByRole("region", { name: "Questions for you" });
    expect(within(group).getByText("Which **year**?")).toBeInTheDocument();
    const rest = screen.getByRole("region", { name: "Tasks waiting on you" });
    expect(within(rest).getByText("Task t2")).toBeInTheDocument();
    expect(within(rest).queryByText("Task t1")).toBeNull();
  });
});

describe("subtasks", () => {
  const child = (id: string, patch: Partial<Task> = {}) =>
    task(id, { parentTaskId: "t1", createdBy: "agent", delegation, ...patch });

  it("shows the Lineage panel and one collapsed timeline line", async () => {
    const lineage: TaskLineage = {
      taskId: "t1",
      parent: null,
      children: [
        { task: child("c1", { title: "Invoices" }), activeRuns: 1, lastRunStatus: "running" },
        { task: child("c2", { title: "Receipts" }), activeRuns: 1, lastRunStatus: "queued" },
        { task: child("c3", { title: "Refunds" }), activeRuns: 0, lastRunStatus: "completed" },
      ],
    };
    setup(task("t1"), lineage);
    const line = await screen.findByText("Started 3 subtasks, 2 working");
    expect(line.tagName).toBe("SUMMARY");
    const panel = (await screen.findByRole("heading", { name: "Lineage" })).closest("section")!;
    expect(within(panel).getByRole("link", { name: "Invoices" })).toHaveAttribute(
      "href",
      "/tasks/c1",
    );
    expect(within(panel).getByText("Done")).toBeInTheDocument();
  });

  it("names the parent on a subtask", async () => {
    const lineage: TaskLineage = {
      taskId: "t1",
      parent: task("p1", { title: "Sort invoices" }),
      children: [],
    };
    setup(task("t1", { parentTaskId: "p1", delegation }), lineage);
    const link = await screen.findByRole("link", { name: "Sort invoices" });
    expect(link.closest("p")).toHaveTextContent("Subtask of Sort invoices");
    expect(screen.queryByText(/^Started \d+ subtask/)).toBeNull();
  });

  it("hides subtasks from the sidebar until they need the person", () => {
    const groups = groupTasks([
      task("t1"),
      child("c1"),
      child("c2", { needsUser: "approval", pendingActionIds: ["a1"] }),
      task("r1", { parentTaskId: "routine" }),
    ]);
    expect(groups.inbox.map((t) => t.id).sort()).toEqual(["c2", "r1", "t1"]);
  });

  it("summarises only delegated children", () => {
    const rows = [
      { task: child("c1"), activeRuns: 0, lastRunStatus: null, working: true },
      { task: child("c2"), activeRuns: 0, lastRunStatus: null, working: false },
    ];
    expect(subtasksSummary(rows)).toBe("Started 2 subtasks, 1 working");
    expect(subtasksSummary(rows.slice(1))).toBe("Started 1 subtask");
  });
});
