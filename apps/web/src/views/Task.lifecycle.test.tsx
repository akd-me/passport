import type { Task, TaskItem } from "@passport/types";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { WorkspaceProvider } from "../state";
import { lifecycleBackend } from "../tasks/lifecycle-backend";
import { moveEntry } from "../tasks/QueueStrip";
import { TasksProvider } from "../tasks/store";
import { FakeSocket, item, minutesAgo, task } from "../tasks/test-fixtures";
import { Harness } from "../test-utils";
import { TaskPage } from "./Task";

function open(t: Task, items: TaskItem[] = []) {
  const backend = lifecycleBackend([t], { items });
  render(
    <WorkspaceProvider>
      <Harness path={`/tasks/${t.id}`}>
        <TasksProvider>
          <Routes>
            <Route path="/tasks/:id" element={<TaskPage />} />
          </Routes>
        </TasksProvider>
      </Harness>
    </WorkspaceProvider>,
  );
  return backend;
}

const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
const entry = (runId: string, text: string) => ({ runId, text, createdAt: minutesAgo(1) });
const strip = () => screen.getByRole("region", { name: "Queued messages" });
const queued = () =>
  within(strip())
    .getAllByRole("button", { name: /^Edit queued message/ })
    .map((b) => b.textContent);

beforeEach(() => {
  FakeSocket.last = undefined;
});

describe("seen", () => {
  it("opening the task clears its Done badge through /seen", async () => {
    const backend = open(task("t1", { title: "Finished", unseenOutcome: "done" }));
    await screen.findByRole("heading", { name: "Finished" });
    await waitFor(() => expect(backend.writes()).toEqual(["POST /tasks/t1/seen"]));
    expect(backend.tasks.get("t1")?.unseenOutcome).toBeNull();
  });

  it("asks nothing when there is nothing to clear", async () => {
    const backend = open(task("t1", { title: "Quiet", seenAt: minutesAgo(1) }));
    await screen.findByRole("heading", { name: "Quiet" });
    await act(async () => {});
    expect(backend.writes()).toEqual([]);
  });

  it("marks it seen again when it comes back while open, but not after Mark unread", async () => {
    const backend = open(task("t1", { title: "Open", seenAt: minutesAgo(1) }));
    await screen.findByRole("heading", { name: "Open" });
    const t = backend.tasks.get("t1") as Task;
    act(() =>
      FakeSocket.last?.send({
        type: "task.updated",
        task: { ...t, unseenOutcome: "woke", revision: 200 },
      }),
    );
    await waitFor(() => expect(backend.writes()).toEqual(["POST /tasks/t1/seen"]));
    fireEvent.click(screen.getByRole("button", { name: "Actions for Open" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark unread" }));
    await waitFor(() => expect(backend.writes()).toContain("POST /tasks/t1/mark-unread"));
    await act(async () => {});
    expect(backend.writes()).toEqual(["POST /tasks/t1/seen", "POST /tasks/t1/mark-unread"]);
  });
});

describe("generated title", () => {
  it("reads muted until renamed in place from the header", async () => {
    const backend = open(task("t1", { title: "Hetzner invoices", titleGenerated: true }));
    const title = await screen.findByRole("button", { name: "Hetzner invoices" });
    expect(title).toHaveClass("generated");
    fireEvent.click(title);
    const field = screen.getByRole("textbox", { name: "Task title" });
    fireEvent.change(field, { target: { value: "Taxes: Hetzner 2026" } });
    fireEvent.keyDown(field, { key: "Enter" });
    const renamed = await screen.findByRole("button", { name: "Taxes: Hetzner 2026" });
    expect(renamed).not.toHaveClass("generated");
    expect(backend.calls.find((c) => c.method === "PATCH")?.body).toEqual({
      title: "Taxes: Hetzner 2026",
    });
  });

  it("Escape keeps the title, and saving it unchanged accepts the suggestion", async () => {
    const backend = open(task("t1", { title: "Suggested", titleGenerated: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Suggested" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Task title" }), { key: "Escape" });
    expect(screen.getByRole("button", { name: "Suggested" })).toBeInTheDocument();
    expect(backend.writes()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Suggested" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Task title" }), { key: "Enter" });
    await waitFor(() => expect(backend.writes()).toEqual(["PATCH /tasks/t1"]));
  });
});

describe("restart notice", () => {
  it("renders RESTARTED as a calm block with what was in flight, as plain text", async () => {
    open(task("t1", { title: "Cut off" }), [
      item(
        "system_notice",
        {
          code: "RESTARTED",
          text: "Passport restarted while this task was working. Interrupted: your request. Continuing it once.",
        },
        { taskId: "t1", runId: null, seq: 1 },
      ),
    ]);
    const title = await screen.findByText("Picked up after a restart");
    const block = title.closest(".tl-notice") as HTMLElement;
    expect(block).toHaveClass("restarted");
    expect(block).not.toHaveClass("warn");
    expect(within(block).getByText(/Interrupted: your request/)).toBeInTheDocument();
  });
});

describe("Limited", () => {
  const limited = (resetAt: string | null, patch: Partial<Task> = {}) =>
    task("t1", {
      title: "Paused",
      needsUser: "limited",
      limited: { runId: "r1", resetAt, autoResume: false, source: "host_agent", at: minutesAgo(1) },
      ...patch,
    });

  it("shows the badge, the reset time and resumes now", async () => {
    const backend = open(limited(hours(2)));
    expect(await screen.findByText("Limited")).toBeInTheDocument();
    expect(screen.getByText(/Paused at a usage limit\. Resets/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(backend.writes()).toEqual(["POST /tasks/t1/resume"]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Resume" })).toBeNull());
  });

  it("resumes at the reset, after which it says so instead of offering it", async () => {
    const backend = open(limited(hours(2)));
    fireEvent.click(await screen.findByRole("button", { name: "Resume at reset" }));
    await waitFor(() => expect(backend.writes()).toEqual(["POST /tasks/t1/resume-at-reset"]));
    expect(await screen.findByText(/Resumes on its own/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume at reset" })).toBeNull();
  });

  it("snoozes until the reset", async () => {
    const resetAt = hours(3);
    const backend = open(limited(resetAt));
    fireEvent.click(await screen.findByRole("button", { name: "Snooze until reset" }));
    await waitFor(() => expect(backend.writes()).toEqual(["POST /tasks/t1/snooze"]));
    expect(backend.calls.at(-1)?.body).toEqual({ until: resetAt });
  });

  it("offers only Resume when the reset time is unknown", async () => {
    open(limited(null));
    expect(await screen.findByText(/The reset time is not known/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume at reset" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Snooze until reset" })).toBeNull();
  });

  it("says why when the task is no longer limited", async () => {
    const backend = open(limited(hours(1)));
    backend.fail.set("/tasks/t1/resume", { status: 409, code: "NOT_LIMITED" });
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    expect(await screen.findByText("This task is no longer paused.")).toBeInTheDocument();
  });
});

describe("queue strip", () => {
  const withQueue = (patch: Partial<Task> = {}) =>
    task("t1", {
      title: "Busy",
      status: "working",
      queue: [entry("q1", "First follow-up"), entry("q2", "Second"), entry("q3", "Third")],
      ...patch,
    });

  it("lists queued messages above the composer and edits one in place", async () => {
    const backend = open(withQueue());
    await screen.findByRole("region", { name: "Queued messages" });
    expect(queued()).toEqual(["First follow-up", "Second", "Third"]);
    fireEvent.click(screen.getByRole("button", { name: "Edit queued message: Second" }));
    const field = screen.getByRole("textbox", { name: "Edit queued message" });
    fireEvent.change(field, { target: { value: "Second, but only PDFs" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(queued()).toEqual(["First follow-up", "Second, but only PDFs", "Third"]),
    );
    expect(backend.writes()).toEqual(["PATCH /tasks/t1/queue/q2"]);
    expect(backend.calls.at(-1)?.body).toEqual({ text: "Second, but only PDFs" });
  });

  it("Escape leaves an edit without saving", async () => {
    const backend = open(withQueue());
    fireEvent.click(await screen.findByRole("button", { name: "Edit queued message: Third" }));
    const field = screen.getByRole("textbox", { name: "Edit queued message" });
    fireEvent.change(field, { target: { value: "Changed my mind" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(queued()).toEqual(["First follow-up", "Second", "Third"]);
    expect(backend.writes()).toEqual([]);
  });

  it("reorders with Alt+arrows on a row", async () => {
    const backend = open(withQueue());
    await screen.findByRole("region", { name: "Queued messages" });
    const row = strip().querySelector('[data-queue-row="q1"]') as HTMLElement;
    fireEvent.keyDown(row, { key: "ArrowDown", altKey: true });
    expect(queued()).toEqual(["Second", "First follow-up", "Third"]);
    await waitFor(() => expect(backend.writes()).toEqual(["POST /tasks/t1/queue/reorder"]));
    expect(backend.calls.at(-1)?.body).toEqual({ runIds: ["q2", "q1", "q3"] });
    // At the top, Alt+↑ does nothing.
    fireEvent.keyDown(strip().querySelector('[data-queue-row="q2"]') as HTMLElement, {
      key: "ArrowUp",
      altKey: true,
    });
    expect(backend.writes()).toHaveLength(1);
  });

  it("reorders by dragging a row onto another", async () => {
    const backend = open(withQueue());
    await screen.findByRole("region", { name: "Queued messages" });
    const row = (id: string) => strip().querySelector(`[data-queue-row="${id}"]`) as HTMLElement;
    fireEvent.dragStart(row("q3"));
    fireEvent.dragOver(row("q1"), { clientY: 0 });
    fireEvent.drop(row("q1"));
    expect(queued()).toEqual(["Third", "First follow-up", "Second"]);
    await waitFor(() => expect(backend.calls.at(-1)?.body).toEqual({ runIds: ["q3", "q1", "q2"] }));
  });

  it("shows the server's order again when a reorder is refused", async () => {
    const backend = open(withQueue());
    await screen.findByRole("region", { name: "Queued messages" });
    backend.fail.set("/tasks/t1/queue/reorder", { status: 409, code: "QUEUE_CHANGED" });
    fireEvent.keyDown(strip().querySelector('[data-queue-row="q1"]') as HTMLElement, {
      key: "ArrowDown",
      altKey: true,
    });
    expect(
      await screen.findByText(/The queue changed while you were editing it/),
    ).toBeInTheDocument();
    expect(queued()).toEqual(["First follow-up", "Second", "Third"]);
    expect(backend.calls.at(-1)).toMatchObject({ method: "GET", path: "/tasks/t1/queue" });
  });

  it("promotes one to a steer and removes another", async () => {
    const backend = open(withQueue());
    await screen.findByRole("region", { name: "Queued messages" });
    fireEvent.click(within(strip()).getAllByRole("button", { name: "Send now" })[1] as HTMLElement);
    await waitFor(() => expect(queued()).toEqual(["First follow-up", "Third"]));
    fireEvent.click(screen.getByRole("button", { name: "Remove queued message: Third" }));
    await waitFor(() => expect(queued()).toEqual(["First follow-up"]));
    expect(backend.writes()).toEqual([
      "POST /tasks/t1/queue/q2/promote-to-steer",
      "DELETE /tasks/t1/queue/q3",
    ]);
  });

  it("after Stop says the queue is held, and Resume releases it", async () => {
    const backend = open(withQueue({ status: "inbox", queueHeld: true }));
    const held = await screen.findByText(/^Queue held/);
    expect(screen.getAllByRole("button", { name: "Send now" })).toHaveLength(3);
    fireEvent.click(within(held).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(screen.queryByText(/^Queue held/)).toBeNull());
    expect(backend.writes()).toEqual(["POST /tasks/t1/queue/resume"]);
  });

  it("is absent without queued messages", async () => {
    open(task("t1", { title: "Nothing queued", queue: [] }));
    await screen.findByRole("heading", { name: "Nothing queued" });
    expect(screen.queryByRole("region", { name: "Queued messages" })).toBeNull();
  });

  it("moves entries within bounds", () => {
    expect(moveEntry(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveEntry(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveEntry(["a", "b", "c"], 1, 9)).toEqual(["a", "c", "b"]);
  });
});
