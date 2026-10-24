import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useGlobalShortcuts } from "../App";
import { useWorkspace, WorkspaceProvider } from "../state";
import { lifecycleBackend } from "../tasks/lifecycle-backend";
import { TasksProvider } from "../tasks/store";
import { minutesAgo, task } from "../tasks/test-fixtures";
import { Harness } from "../test-utils";
import { TaskList } from "./TaskList";

function Keys() {
  useGlobalShortcuts();
  return null;
}
function Toast() {
  const { notice, noticeAction } = useWorkspace();
  return notice ? (
    <div data-testid="toast">
      {notice}
      {noticeAction && (
        <button type="button" onClick={noticeAction.run}>
          {noticeAction.label}
        </button>
      )}
    </div>
  ) : null;
}

function renderSidebar() {
  render(
    <WorkspaceProvider>
      <Harness>
        <TasksProvider>
          <Keys />
          <Toast />
          <nav aria-label="Tasks">
            <TaskList />
          </nav>
        </TasksProvider>
      </Harness>
    </WorkspaceProvider>,
  );
}

const rows = (section: string) =>
  within(screen.getByRole("region", { name: section }))
    .queryAllByRole("link")
    .map((link) => link.querySelector(".task-title")?.textContent);
const link = (title: string) => screen.getByText(title).closest("a") as HTMLElement;
const menu = async (title: string) =>
  fireEvent.click(await screen.findByRole("button", { name: `Actions for ${title}` }));
const undoKey = () => fireEvent.keyDown(window, { key: "z", metaKey: true });

describe("sidebar inbox (v0.4 lifecycle)", () => {
  it("orders by returnedAt, recedes seen rows and shows Done and Woke", async () => {
    lifecycleBackend([
      // Busy a minute ago in the background, but it came back to you an hour ago.
      task("bg", {
        title: "Background busy",
        lastActivityAt: minutesAgo(1),
        returnedAt: minutesAgo(60),
      }),
      task("done", {
        title: "Finished unseen",
        returnedAt: minutesAgo(5),
        unseenOutcome: "done",
      }),
      task("woke", { title: "Woke unseen", returnedAt: minutesAgo(10), unseenOutcome: "woke" }),
      task("seen", { title: "Seen already", returnedAt: minutesAgo(20), seenAt: minutesAgo(15) }),
    ]);
    renderSidebar();
    await screen.findByText("Finished unseen");
    expect(rows("Inbox")).toEqual([
      "Finished unseen",
      "Woke unseen",
      "Seen already",
      "Background busy",
    ]);
    expect(link("Finished unseen")).toHaveClass("fresh");
    expect(link("Woke unseen")).toHaveClass("fresh");
    expect(link("Seen already")).toHaveClass("recede");
    expect(within(link("Finished unseen")).getByText("Finished, not yet seen")).toBeInTheDocument();
    expect(within(link("Woke unseen")).getByText("Woke up with something new")).toBeInTheDocument();
  });

  it("marks a seen row unread from its menu, and ⌘Z marks it seen again", async () => {
    const backend = lifecycleBackend([task("a", { title: "Read it", seenAt: minutesAgo(3) })]);
    renderSidebar();
    await menu("Read it");
    fireEvent.click(screen.getByRole("button", { name: "Mark unread" }));
    await screen.findByText("Marked unread.");
    expect(link("Read it")).toHaveClass("fresh");
    expect(within(link("Read it")).getByText("Finished, not yet seen")).toBeInTheDocument();
    // An unread row does not offer it again.
    await menu("Read it");
    expect(screen.queryByRole("button", { name: "Mark unread" })).toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    undoKey();
    await waitFor(() => expect(link("Read it")).toHaveClass("recede"));
    expect(backend.writes()).toEqual(["POST /tasks/a/mark-unread", "POST /tasks/a/seen"]);
  });
});

describe("undo settle, snooze and archive", () => {
  it("⌘Z reopens a settled task through /unsettle inside the toast window", async () => {
    const backend = lifecycleBackend([
      task("a", { title: "Put away" }),
      task("b", { title: "Other" }),
    ]);
    renderSidebar();
    await menu("Put away");
    fireEvent.click(screen.getByRole("button", { name: "Settle" }));
    await screen.findByText(/^Settled\./);
    expect(rows("Inbox")).toEqual(["Other"]);
    undoKey();
    await waitFor(() => expect(rows("Inbox")).toContain("Put away"));
    expect(backend.writes()).toEqual(["POST /tasks/a/settle", "POST /tasks/a/unsettle"]);
    expect(await screen.findByText("Put back.")).toBeInTheDocument();
  });

  it("the toast's Undo reopens a snoozed task through /unsnooze", async () => {
    const backend = lifecycleBackend([task("a", { title: "Later" })]);
    renderSidebar();
    await menu("Later");
    fireEvent.click(screen.getByRole("button", { name: "Snooze until…" }));
    fireEvent.click(screen.getByRole("button", { name: /^In an hour/ }));
    await screen.findByText(/^Snoozed\./);
    expect(rows("Snoozed")).toEqual(["Later"]);
    fireEvent.click(within(screen.getByTestId("toast")).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(rows("Inbox")).toEqual(["Later"]));
    expect(backend.writes()).toEqual(["POST /tasks/a/snooze", "POST /tasks/a/unsnooze"]);
  });

  it("undoing an archive that replaced a snooze unarchives, then snoozes until the old time", async () => {
    const until = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const backend = lifecycleBackend([
      task("a", { title: "Napping", status: "snoozed", snoozedUntil: until }),
    ]);
    renderSidebar();
    await menu("Napping");
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await screen.findByText(/^Archived\./);
    expect(screen.queryByText("Napping")).toBeNull();
    undoKey();
    await waitFor(() => expect(backend.writes()).toHaveLength(3));
    await waitFor(() => expect(rows("Snoozed")).toEqual(["Napping"]));
    expect(backend.writes()).toEqual([
      "POST /tasks/a/archive",
      "POST /tasks/a/unarchive",
      "POST /tasks/a/snooze",
    ]);
    expect(backend.calls.at(-1)?.body).toEqual({ until });
  });

  it("offers no Undo when the server sends no previous state", async () => {
    const backend = lifecycleBackend([task("a", { title: "Old server" })]);
    renderSidebar();
    await screen.findByText("Old server");
    // A v0.3 server: settle answers with the bare task.
    const settled = { ...task("a", { title: "Old server" }), status: "settled" as const, revision: 500 };
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) =>
      String(input).endsWith("/settle") ? Response.json(settled) : original(input, init);
    await menu("Old server");
    fireEvent.click(screen.getByRole("button", { name: "Settle" }));
    await screen.findByText(/^Settled\./);
    expect(within(screen.getByTestId("toast")).queryByRole("button")).toBeNull();
    globalThis.fetch = original;
  });

  it("rolls the row back and says so when the reopen is refused", async () => {
    const backend = lifecycleBackend([task("a", { title: "Stuck" })]);
    renderSidebar();
    await menu("Stuck");
    fireEvent.click(screen.getByRole("button", { name: "Settle" }));
    await screen.findByText(/^Settled\./);
    backend.fail.set("/tasks/a/unsettle", { status: 500, code: "INTERNAL" });
    undoKey();
    expect(await screen.findByText("Refused: INTERNAL")).toBeInTheDocument();
    expect(rows("Inbox")).toEqual([]);
  });
});
