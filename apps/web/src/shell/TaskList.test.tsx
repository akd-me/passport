import type { Task } from "@passport/types";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TasksProvider } from "../tasks/store";
import { minutesAgo, task } from "../tasks/test-fixtures";
import { Harness, stubApi } from "../test-utils";
import { TaskList } from "./TaskList";

const tasks: Task[] = [
  task("older", { title: "Older inbox task", lastActivityAt: minutesAgo(40) }),
  task("newer", {
    title: "Hetzner invoices",
    needsUser: "approval",
    pendingActionIds: ["a1", "a2"],
    lastActivityAt: minutesAgo(2),
  }),
  task("digest", { title: "Daily digest", kind: "routine", lastActivityAt: minutesAgo(20) }),
  task("run", { title: "Running task", status: "working" }),
  task("pin", { title: "Pinned task", pinned: true, status: "working" }),
  task("nap", { title: "Snoozed task", status: "snoozed", snoozedUntil: minutesAgo(-120) }),
  task("done", { title: "Settled task", status: "settled" }),
];

function renderList(pin: (url: URL, init?: RequestInit) => unknown = () => tasks[0]) {
  const fetchMock = stubApi({
    "/tasks": (url: URL, init?: RequestInit) =>
      url.pathname.endsWith("/pin") ? pin(url, init) : { items: tasks, total: tasks.length },
  });
  render(
    <Harness>
      <TasksProvider>
        <nav aria-label="Tasks">
          <TaskList />
        </nav>
      </TasksProvider>
    </Harness>,
  );
  return fetchMock;
}

const rows = (section: string) =>
  within(screen.getByRole("region", { name: section }))
    .queryAllByRole("link")
    .map((link) => link.querySelector(".side-label")?.firstChild?.textContent);

describe("sidebar task list", () => {
  it("groups into Pinned, Inbox, Working, Snoozed and a collapsed Settled, newest first", async () => {
    renderList();
    await screen.findByText("Hetzner invoices");
    const sections = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(sections).toEqual(["Pinned", "Inbox", "Working", "Snoozed", "Settled"]);
    expect(rows("Inbox")).toEqual(["Hetzner invoices", "Daily digest", "Older inbox task"]);
    expect(rows("Pinned")).toEqual(["Pinned task"]);
    // Settled starts folded.
    const settled = screen.getByRole("button", { name: "Settled" });
    expect(settled).toHaveAttribute("aria-expanded", "false");
    expect(rows("Settled")).toEqual([]);
    fireEvent.click(settled);
    expect(rows("Settled")).toEqual(["Settled task"]);
  });

  it("shows the kind badge, status glyph and pending approval count", async () => {
    renderList();
    const row = (await screen.findByText("Hetzner invoices")).closest("a")!;
    expect(within(row).getByTitle("2 waiting for approval")).toHaveTextContent(
      "2 waiting for approval",
    );
    expect(within(row).getByText("Needs your approval")).toBeInTheDocument();
    const digest = screen.getByText("Daily digest").closest("a")!;
    expect(within(digest).getByText("Routine")).toBeInTheDocument();
    const running = screen.getByText("Running task").closest("a")!;
    expect(within(running).getByText("Working")).toBeInTheDocument();
  });

  it("pins optimistically from the row menu and rolls back when the server refuses", async () => {
    let fail = false;
    renderList(() =>
      fail
        ? Response.json({ error: { code: "BUSY", message: "Try again" } }, { status: 500 })
        : { ...tasks[0], pinned: true, revision: 2 },
    );
    await screen.findByText("Older inbox task");
    fireEvent.click(screen.getByRole("button", { name: "Actions for Older inbox task" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    // Moves before the server answers…
    expect(rows("Pinned").includes("Older inbox task")).toBe(true);
    await waitFor(() => expect(rows("Pinned").includes("Older inbox task")).toBe(true));

    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Actions for Hetzner invoices" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    expect(rows("Pinned").includes("Hetzner invoices")).toBe(true);
    // …and goes back when the call fails.
    await waitFor(() => expect(rows("Inbox").includes("Hetzner invoices")).toBe(true));
  });

  it("moves through rows with j and k", async () => {
    renderList();
    await screen.findByText("Hetzner invoices");
    fireEvent.keyDown(window, { key: "j" });
    expect(document.activeElement).toHaveTextContent("Pinned task");
    fireEvent.keyDown(window, { key: "j" });
    expect(document.activeElement).toHaveTextContent("Hetzner invoices");
    fireEvent.keyDown(window, { key: "k" });
    expect(document.activeElement).toHaveTextContent("Pinned task");
    expect(document.activeElement).toHaveAttribute("href", "/tasks/pin");
  });

  it("explains that the demo backend has no tasks", async () => {
    stubApi({
      "/tasks": () =>
        Response.json(
          { error: { code: "TASKS_UNAVAILABLE", message: "Tasks need the real backend" } },
          { status: 501 },
        ),
    });
    render(
      <Harness>
        <TasksProvider>
          <TaskList />
        </TasksProvider>
      </Harness>,
    );
    expect(await screen.findByText(/Tasks need the full backend/)).toBeInTheDocument();
  });
});
