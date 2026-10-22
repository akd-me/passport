import type { Task } from "@passport/types";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspace, WorkspaceProvider } from "../state";
import { errorText } from "../tasks/RunHeader";
import { TasksProvider } from "../tasks/store";
import { FakeSocket, minutesAgo, task } from "../tasks/test-fixtures";
import { Harness, stubApi } from "../test-utils";
import { Sidebar } from "./Sidebar";
import { TaskList, useTaskListKeys, wakeText } from "./TaskList";

/** Review R5: the sidebar list, its paging and the shell around it. */
const send = (event: unknown) => act(() => FakeSocket.last?.send(event));

/** `GET /api/tasks` with status / pinned filters and offset cursors, like the server. */
function listRoute(all: () => Task[], hold?: () => Promise<void>) {
  return async (url: URL, init?: RequestInit) => {
    const path = url.pathname.replace(/^\/api/, "");
    if (path !== "/tasks" || (init?.method ?? "GET") !== "GET") {
      const id = path.split("/")[2];
      const known = all().find((t) => t.id === id)!;
      return { ...known, pinned: path.endsWith("/pin"), revision: (known.revision ?? 1) + 5 };
    }
    await hold?.();
    const status = url.searchParams.get("status")?.split(",");
    const pinned = url.searchParams.get("pinned");
    const limit = Number(url.searchParams.get("limit") ?? 50),
      from = Number(url.searchParams.get("cursor") ?? 0);
    const list = all().filter(
      (t) => (!status || status.includes(t.status)) && (!pinned || String(t.pinned) === pinned),
    );
    return {
      items: list.slice(from, from + limit),
      total: list.length,
      nextCursor: list.length > from + limit ? String(from + limit) : null,
    };
  };
}

function Keys() {
  useTaskListKeys();
  return null;
}

function renderList(tasks: () => Task[], path = "/", hold?: () => Promise<void>) {
  vi.stubGlobal("WebSocket", FakeSocket);
  const fetchMock = stubApi({ "/tasks": listRoute(tasks, hold) });
  render(
    <WorkspaceProvider>
      <Harness path={path}>
        <TasksProvider>
          <Keys />
          <nav aria-label="Tasks">
            <TaskList />
          </nav>
          <Routes>
            <Route path="*" element={<main />} />
          </Routes>
        </TasksProvider>
      </Harness>
    </WorkspaceProvider>,
  );
  const paths = () => fetchMock.mock.calls.map(([input]) => String(input));
  return { fetchMock, paths };
}

const rows = (section: string) =>
  within(screen.getByRole("region", { name: section }))
    .queryAllByRole("link")
    .map((link) => link.getAttribute("data-task-row"));

beforeEach(() => {
  FakeSocket.last = undefined;
});

describe("R5-3 sidebar paging", () => {
  const many = () => [
    task("visa", {
      status: "snoozed",
      snoozedUntil: minutesAgo(-600),
      lastActivityAt: minutesAgo(9000),
    }),
    task("news", { needsUser: "failure", lastActivityAt: minutesAgo(8000) }),
    ...Array.from({ length: 205 }, (_, i) =>
      task(`bulk-${i}`, { status: "settled", lastActivityAt: minutesAgo(i + 1) }),
    ),
    ...Array.from({ length: 230 }, (_, i) =>
      task(`in-${i}`, { lastActivityAt: minutesAgo(i + 300) }),
    ),
  ];

  it("R5-3: keeps snoozed and needs-you tasks however many settled tasks are newer", async () => {
    const tasks = many();
    const { paths } = renderList(() => tasks);
    await waitFor(() => expect(rows("Inbox")).toHaveLength(231));
    expect(rows("Snoozed")).toEqual(["visa"]);
    expect(rows("Inbox")).toContain("news");
    // Inbox paged to the end with the cursor; nothing settled fetched yet.
    expect(paths().some((p) => p.includes("status=inbox") && p.includes("cursor=200"))).toBe(true);
    expect(paths().some((p) => p.includes("status=settled&limit=50"))).toBe(false);
  });

  it("R5-3: pages settled tasks in when the fold opens, with Show more", async () => {
    const tasks = many();
    renderList(() => tasks);
    await waitFor(() => expect(rows("Inbox")).toHaveLength(231));
    fireEvent.click(screen.getByRole("button", { name: "Settled" }));
    await waitFor(() => expect(rows("Settled")).toHaveLength(50));
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(rows("Settled")).toHaveLength(100));
  });
});

describe("store merges", () => {
  it("R5-11: a newer unrelated frame does not undo an optimistic pin in flight", async () => {
    let release!: () => void;
    const tasks = [task("a", { title: "Alpha" })];
    vi.stubGlobal("WebSocket", FakeSocket);
    stubApi({
      "/tasks": async (url: URL, init?: RequestInit) => {
        if (url.pathname.endsWith("/pin")) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { ...tasks[0], pinned: true, revision: 3 };
        }
        return listRoute(() => tasks)(url, init);
      },
    });
    render(
      <WorkspaceProvider>
        <Harness>
          <TasksProvider>
            <TaskList />
          </TasksProvider>
        </Harness>
      </WorkspaceProvider>,
    );
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Actions for Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    expect(rows("Pinned")).toEqual(["a"]);
    send({
      type: "task.updated",
      task: { ...tasks[0], revision: 2, lastActivityAt: minutesAgo(1) },
    });
    expect(rows("Pinned")).toEqual(["a"]);
    await act(async () => release());
    expect(rows("Pinned")).toEqual(["a"]);
  });

  it("R5-13: a task created while the list request was out survives the response", async () => {
    let release!: () => void;
    const tasks = [task("a", { title: "Alpha" })];
    let first = true;
    renderList(
      () => tasks,
      "/",
      () =>
        first
          ? new Promise<void>((resolve) => {
              first = false;
              release = resolve;
            })
          : Promise.resolve(),
    );
    await waitFor(() => expect(release).toBeTypeOf("function"));
    send({ type: "task.updated", task: task("b", { title: "Brand new" }) });
    await act(async () => release());
    await screen.findByText("Alpha");
    expect(screen.getByText("Brand new")).toBeInTheDocument();
  });

  it("R5-9: a pin toast offers Undo, which unpins", async () => {
    const tasks = [task("a", { title: "Alpha" })];
    vi.stubGlobal("WebSocket", FakeSocket);
    const fetchMock = stubApi({ "/tasks": listRoute(() => tasks) });
    function Toast() {
      const { notice, noticeAction } = useWorkspace();
      return notice ? (
        <div role="status">
          {notice}
          {noticeAction && (
            <button type="button" onClick={noticeAction.run}>
              {noticeAction.label}
            </button>
          )}
        </div>
      ) : null;
    }
    render(
      <WorkspaceProvider>
        <Harness>
          <TasksProvider>
            <TaskList />
            <Toast />
          </TasksProvider>
        </Harness>
      </WorkspaceProvider>,
    );
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Actions for Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/tasks/a/unpin"))).toBe(true),
    );
  });
});

describe("shell", () => {
  it("R5-10: j/k move rows on a task page that shows a decision card", async () => {
    const tasks = [task("a", { title: "Alpha" }), task("b", { title: "Beta" })];
    renderList(() => tasks, "/tasks/a");
    await screen.findByText("Beta");
    const card = document.createElement("article");
    card.setAttribute("data-decision", "x");
    document.querySelector("main")?.append(card);
    fireEvent.keyDown(window, { key: "j" });
    expect(document.activeElement?.getAttribute("data-task-row")).toBeTruthy();
  });

  it("R5-12: the first socket open and a quick window focus refetch nothing", async () => {
    const tasks = [task("a", { title: "Alpha" })];
    const { paths } = renderList(() => tasks);
    await screen.findByText("Alpha");
    const before = paths().length;
    act(() => FakeSocket.last?.open());
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(paths().length).toBe(before);
  });

  it("R5-16: the Needs you badge counts tasks in the account scope", async () => {
    const tasks = [
      task("a", { needsUser: "approval", accountIds: ["acc-1"] }),
      task("b", { needsUser: "failure", accountIds: ["acc-2"] }),
    ];
    vi.stubGlobal("WebSocket", FakeSocket);
    stubApi({ "/tasks": listRoute(() => tasks), "/accounts": { accounts: [], mode: "real" } });
    render(
      <WorkspaceProvider>
        <Harness path="/?accountId=acc-2">
          <TasksProvider>
            <Sidebar />
          </TasksProvider>
        </Harness>
      </WorkspaceProvider>,
    );
    expect(await screen.findByTitle("1 task needs you")).toHaveTextContent("1");
  });

  it("R5-17: section toggles sit inside their headings", async () => {
    renderList(() => [task("a", { title: "Alpha" })]);
    await screen.findByText("Alpha");
    const heading = screen.getByRole("heading", { name: "Inbox" });
    expect(within(heading).getByRole("button", { name: "Inbox" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("R5-18: snooze and error copy read as words", () => {
    const now = Date.parse("2026-10-22T12:00:00Z");
    expect(wakeText("2026-10-22T11:55:00Z", now)).toBe("Wakes soon");
    expect(wakeText(new Date(Date.now() + 20 * 3_600_000).toISOString())).toBe("Wakes in 20h");
    expect(errorText("SERVER_RESTARTED")).toBe("server restarted");
    expect(errorText("Gmail said no")).toBe("Gmail said no");
  });
});
