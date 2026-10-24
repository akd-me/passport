import type { Task } from "@passport/types";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useGlobalShortcuts } from "../App";
import { NOTICE_MS, useWorkspace, WorkspaceProvider } from "../state";
import { TasksProvider } from "../tasks/store";
import { sendModeFor } from "../tasks/TaskComposer";
import { FakeSocket, minutesAgo, task } from "../tasks/test-fixtures";
import { Harness, stubApi } from "../test-utils";
import { Surface } from "./Surface";
import { TaskList, useTaskJumpKeys } from "./TaskList";

/** The shell's keyboard hooks, as `Shell` mounts them. */
function Keys() {
  useGlobalShortcuts();
  useTaskJumpKeys();
  return null;
}
function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}
function Notice() {
  const { notice } = useWorkspace();
  return notice ? <p data-testid="notice">{notice}</p> : null;
}

const tasks: Task[] = [
  task("settled", { title: "Settled", status: "settled", lastActivityAt: minutesAgo(0) }),
  task("nap", { title: "Snoozed", status: "snoozed", snoozedUntil: minutesAgo(-60) }),
  task("run", { title: "Running", status: "working", lastActivityAt: minutesAgo(3) }),
  task("new", { title: "Newest inbox", lastActivityAt: minutesAgo(1) }),
  task("old", { title: "Older inbox", lastActivityAt: minutesAgo(30) }),
  task("pin", { title: "Pinned", pinned: true, lastActivityAt: minutesAgo(90) }),
];

function renderShell(pin?: (url: URL) => unknown) {
  vi.stubGlobal("WebSocket", FakeSocket);
  const fetchMock = stubApi({
    "/tasks": (url: URL) =>
      /\/(un)?pin$/.test(url.pathname) && pin
        ? pin(url)
        : { items: tasks.filter((t) => t.status !== "settled"), total: 5 },
  });
  render(
    <WorkspaceProvider>
      <Harness>
        <TasksProvider>
          <Keys />
          <Where />
          <Notice />
          <nav aria-label="Tasks">
            <TaskList />
          </nav>
        </TasksProvider>
      </Harness>
    </WorkspaceProvider>,
  );
  return fetchMock;
}

const where = () => screen.getByTestId("where").textContent;

afterEach(() => {
  vi.useRealTimers();
});

describe("⌘1–⌘9", () => {
  it("open the first nine tasks in sidebar order, with ⌘ or Ctrl", async () => {
    renderShell();
    await screen.findByText("Newest inbox");
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(where()).toBe("/tasks/pin");
    fireEvent.keyDown(window, { key: "3", metaKey: true });
    expect(where()).toBe("/tasks/old");
    fireEvent.keyDown(window, { key: "5", ctrlKey: true });
    expect(where()).toBe("/tasks/nap");
    // Past the last open task nothing happens; settled tasks never take a number.
    fireEvent.keyDown(window, { key: "6", metaKey: true });
    expect(where()).toBe("/tasks/nap");
  });

  it("are announced on the rows they open", async () => {
    renderShell();
    const row = (await screen.findByText("Running")).closest("a")!;
    expect(row).toHaveAttribute("aria-keyshortcuts", "Meta+4 Control+4");
  });

  it("leave an open dialog alone and ignore other modifiers", async () => {
    renderShell();
    await screen.findByText("Newest inbox");
    fireEvent.keyDown(window, { key: "2", metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "2" });
    expect(where()).toBe("/");
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(where()).toBe("/");
    dialog.remove();
  });
});

describe("⌘Enter", () => {
  it("sends with the opposite of the default mode while a run is live", () => {
    expect(sendModeFor({ metaKey: false, ctrlKey: false }, true)).toBe("queue");
    expect(sendModeFor({ metaKey: true, ctrlKey: false }, true)).toBe("steer");
    expect(sendModeFor({ metaKey: false, ctrlKey: true }, true)).toBe("steer");
  });

  it("queues either way when nothing is running to steer", () => {
    expect(sendModeFor({ metaKey: false, ctrlKey: false }, false)).toBe("queue");
    expect(sendModeFor({ metaKey: true, ctrlKey: false }, false)).toBe("queue");
  });
});

describe("Escape", () => {
  function renderSurface() {
    render(
      <Harness>
        <Keys />
        <Surface title="Task" details={<p>Facts</p>} detailsLabel="Task details">
          <textarea aria-label="Draft" />
        </Surface>
      </Harness>,
    );
  }
  const panel = () => screen.queryByRole("complementary", { name: "Task details" });

  it("closes the details panel", () => {
    renderSurface();
    expect(panel()).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(panel()).toBeNull();
    // ⌘. brings it back.
    fireEvent.keyDown(window, { key: ".", metaKey: true });
    expect(panel()).toBeInTheDocument();
  });

  it("belongs to the text field or the dialog when one has focus", () => {
    renderSurface();
    fireEvent.keyDown(screen.getByLabelText("Draft"), { key: "Escape" });
    expect(panel()).toBeInTheDocument();
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(panel()).toBeInTheDocument();
    dialog.remove();
  });
});

describe("⌘Z", () => {
  const pinRoute = (calls: string[]) => (url: URL) => {
    calls.push(url.pathname);
    const pinned = url.pathname.endsWith("/pin");
    return { ...tasks.find((t) => t.id === "old")!, pinned, revision: calls.length + 1 };
  };
  const pin = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Older inbox" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    await screen.findByText("Pinned.");
  };
  const pinnedRows = () =>
    within(screen.getByRole("region", { name: "Pinned" }))
      .queryAllByRole("link")
      .map((link) => link.textContent);

  it("undoes a pin while its toast shows", async () => {
    const calls: string[] = [];
    renderShell(pinRoute(calls));
    await pin();
    expect(pinnedRows().some((text) => text?.includes("Older inbox"))).toBe(true);
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() => expect(calls).toEqual(["/api/tasks/old/pin", "/api/tasks/old/unpin"]));
    await waitFor(() =>
      expect(pinnedRows().some((text) => text?.includes("Older inbox"))).toBe(false),
    );
    expect(await screen.findByText("Unpinned.")).toBeInTheDocument();
  });

  it("does nothing once the five-second window has passed, or inside a text field", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls: string[] = [];
    renderShell(pinRoute(calls));
    await pin();
    const field = document.createElement("input");
    document.body.append(field);
    fireEvent.keyDown(field, { key: "z", metaKey: true });
    expect(calls).toHaveLength(1);
    field.remove();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTICE_MS);
    });
    await waitFor(() => expect(screen.queryByTestId("notice")).toBeNull());
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(calls).toHaveLength(1);
  });
});
