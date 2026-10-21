import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SetupTask, setupApi } from "../setup-api";
import { Sidebar } from "../shell/Sidebar";
import { WorkspaceProvider } from "../state";
import { Harness, stubApi } from "../test-utils";
import { useUi } from "../ui-state";
import { ConnectDialog } from "./ConnectDialog";
import { isStaleSnapshot } from "./setup-task-model";

const at = (second: number) => `2026-10-21T10:00:${String(second).padStart(2, "0")}.000Z`;
const running: SetupTask = {
  id: "task-1",
  provider: "gmail",
  status: "running",
  steps: [{ id: "browser", title: "Open a browser", status: "running" }],
  log: [{ at: at(1), level: "info", text: "Opened the browser" }],
};
const waiting: SetupTask = {
  ...running,
  status: "waiting_for_user",
  prompt: { id: "p1", kind: "question", message: "Which project?" },
};

function OpenConnect() {
  const { setConnecting } = useUi();
  return (
    <button type="button" onClick={() => setConnecting(true)}>
      Open connect
    </button>
  );
}
const renderShell = () =>
  render(
    <Harness>
      <Sidebar />
      <OpenConnect />
      <ConnectDialog />
    </Harness>,
  );
const sidebarRoutes = {
  "/accounts": { accounts: [] },
  "/decisions": { items: [] },
  "/matters": [],
  "/people": [],
};
/** Let pending promises and React updates settle. */
const flush = () => act(async () => {});

afterEach(() => {
  vi.useRealTimers();
});

describe("setup task outlives the connect dialog", () => {
  it("V2-12: closing and reopening the dialog returns to the running task", async () => {
    stubApi(sidebarRoutes);
    vi.spyOn(setupApi, "list").mockResolvedValue([]);
    vi.spyOn(setupApi, "start").mockResolvedValue({ id: running.id });
    vi.spyOn(setupApi, "get").mockResolvedValue(waiting);
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Open connect" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    expect(await screen.findByLabelText("Your answer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open connect" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Your answer")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel setup" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Connect Gmail" })).toBeNull();
  });

  it("V2-12: a task still running after a reload is recovered from the task list", async () => {
    stubApi(sidebarRoutes);
    const done: SetupTask = { ...running, id: "task-0", status: "failed" };
    vi.spyOn(setupApi, "list").mockResolvedValue([waiting, done]);
    vi.spyOn(setupApi, "get").mockResolvedValue(waiting);
    renderShell();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Open connect" }));
    expect(within(screen.getByRole("dialog")).getByText("Which project?")).toBeInTheDocument();
  });

  it("V2-12: the sidebar shows a waiting setup while the dialog is closed and reopens it", async () => {
    stubApi(sidebarRoutes);
    vi.spyOn(setupApi, "list").mockResolvedValue([waiting]);
    vi.spyOn(setupApi, "get").mockResolvedValue(waiting);
    renderShell();
    const indicator = await screen.findByRole("button", { name: /Setup needs you/ });
    expect(indicator).toHaveTextContent("Connecting Gmail");
    fireEvent.click(indicator);
    expect(within(screen.getByRole("dialog")).getByLabelText("Your answer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Setup needs you/ })).toBeNull();
  });

  it("V2-12: starting while another task holds the slot shows that task", async () => {
    stubApi(sidebarRoutes);
    const { ApiError } = await import("../api");
    const list = vi.spyOn(setupApi, "list").mockResolvedValue([]);
    vi.spyOn(setupApi, "start").mockRejectedValue(
      new ApiError("Another setup is running", "SETUP_BUSY", 409),
    );
    vi.spyOn(setupApi, "get").mockResolvedValue(waiting);
    renderShell();
    await flush();
    list.mockResolvedValue([waiting]);
    fireEvent.click(screen.getByRole("button", { name: "Open connect" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    expect(await screen.findByLabelText("Your answer")).toBeInTheDocument();
  });
});

class FakeSocket {
  static last: FakeSocket | undefined;
  onopen?: () => void;
  onmessage?: (message: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor() {
    FakeSocket.last = this;
  }
  close() {}
  emit(task: SetupTask) {
    this.onmessage?.({ data: JSON.stringify({ type: "setup.task.updated", task }) });
  }
}

describe("setup snapshots apply in order", () => {
  it("V2-13: polling never overlaps requests", async () => {
    stubApi(sidebarRoutes);
    vi.spyOn(setupApi, "list").mockResolvedValue([]);
    vi.spyOn(setupApi, "start").mockResolvedValue({ id: running.id });
    const get = vi.spyOn(setupApi, "get").mockResolvedValue(running);
    vi.useFakeTimers();
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Open connect" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    await flush();
    expect(screen.getByRole("heading", { name: "Connecting Gmail" })).toBeInTheDocument();
    let settle!: (task: SetupTask) => void;
    get.mockClear();
    get.mockImplementationOnce(() => new Promise((resolve) => (settle = resolve)));
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => settle(running));
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("V2-13: a late poll with an older snapshot does not hide a newer prompt", async () => {
    stubApi(sidebarRoutes);
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.spyOn(setupApi, "list").mockResolvedValue([]);
    vi.spyOn(setupApi, "start").mockResolvedValue({ id: running.id });
    const get = vi.spyOn(setupApi, "get").mockResolvedValue(running);
    vi.useFakeTimers();
    render(
      <WorkspaceProvider>
        <Harness>
          <OpenConnect />
          <ConnectDialog />
        </Harness>
      </WorkspaceProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open connect" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    await flush();
    let settle!: (task: SetupTask) => void;
    get.mockImplementationOnce(() => new Promise((resolve) => (settle = resolve)));
    await act(() => vi.advanceTimersByTimeAsync(1500));
    act(() => FakeSocket.last?.emit(waiting));
    expect(screen.getByLabelText("Your answer")).toBeInTheDocument();
    await act(async () => settle(running));
    expect(screen.getByLabelText("Your answer")).toBeInTheDocument();
  });

  it("V2-13: snapshot ordering rules", () => {
    const none = new Set<string>();
    const longer: SetupTask = {
      ...running,
      log: [...running.log, { at: at(2), level: "info", text: "Signed in" }],
    };
    expect(isStaleSnapshot(running, undefined, none)).toBe(false);
    expect(isStaleSnapshot({ ...running, id: "task-2" }, longer, none)).toBe(false);
    // A shorter log never replaces a longer one, whatever the status.
    expect(isStaleSnapshot(waiting, longer, none)).toBe(true);
    expect(isStaleSnapshot(longer, waiting, none)).toBe(false);
    // At the server's log cap the length stops moving; the newest timestamp still orders.
    const capped: SetupTask = { ...running, log: [{ at: at(5), level: "info", text: "x" }] };
    expect(isStaleSnapshot(running, capped, none)).toBe(true);
    // Same log: a prompt follows the run that asked it.
    expect(isStaleSnapshot(running, waiting, none)).toBe(true);
    expect(isStaleSnapshot(waiting, running, none)).toBe(false);
    // An answered prompt never comes back, and the run after it is current.
    const answered = new Set(["p1"]);
    expect(isStaleSnapshot(waiting, running, answered)).toBe(true);
    expect(isStaleSnapshot(running, waiting, answered)).toBe(false);
    // A new prompt replaces the previous one.
    const next: SetupTask = { ...waiting, prompt: { id: "p2", kind: "confirm", message: "OK?" } };
    expect(isStaleSnapshot(next, waiting, none)).toBe(false);
    // Terminal states are final.
    expect(isStaleSnapshot(running, { ...running, status: "cancelled" }, none)).toBe(true);
    // A server revision, when present, wins over the derived order.
    const rev = (task: SetupTask, revision: number) => ({ ...task, revision }) as SetupTask;
    expect(isStaleSnapshot(rev(running, 3), rev(longer, 2), none)).toBe(false);
    expect(isStaleSnapshot(rev(longer, 2), rev(running, 3), none)).toBe(true);
  });
});
