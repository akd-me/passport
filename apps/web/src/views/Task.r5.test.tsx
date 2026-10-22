import type { ActionRecord, Task, TaskItem, TaskRun } from "@passport/types";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceProvider } from "../state";
import { TasksProvider } from "../tasks/store";
import { action, FakeSocket, item, run, task } from "../tasks/test-fixtures";
import { Harness, stubApi } from "../test-utils";
import { TaskPage } from "./Task";

/** Review R5: the task page's request budget, approvals and live state. */
interface Backend {
  task: Task;
  runs: TaskRun[];
  items: TaskItem[];
  records: ActionRecord[];
  /** `/decisions`: the open proposals, a failure, or never answering. */
  decisions?: "ok" | "fail" | "hang";
}

function setup(backend: Backend) {
  vi.stubGlobal("WebSocket", FakeSocket);
  const fetchMock = stubApi({
    "/tasks": (url: URL) => {
      const path = url.pathname.replace(/^\/api/, "");
      if (path === "/tasks") {
        return { items: [backend.task], total: 1 };
      }
      if (path === `/tasks/${backend.task.id}`) {
        return { task: backend.task, runs: backend.runs };
      }
      if (path.endsWith("/items")) {
        const after = Number(url.searchParams.get("afterSeq"));
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const items = backend.items.filter((i) => i.seq > after).slice(0, limit);
        return { items, lastSeq: items.at(-1)?.seq ?? after };
      }
      return backend.task;
    },
    "/decisions": () =>
      backend.decisions === "fail"
        ? Response.json({ error: { code: "BOOM", message: "Down" } }, { status: 500 })
        : backend.decisions === "hang"
          ? new Promise(() => {})
          : { items: backend.records.filter((r) => r.status === "proposed") },
    "/actions": (url: URL, init?: RequestInit) => {
      const id = url.pathname.split("/")[3];
      if (init?.method === "POST") {
        const record = backend.records.find((r) => r.id === id) ?? backend.records[0];
        return { ...record, status: url.pathname.endsWith("/reject") ? "rejected" : "approved" };
      }
      const runId = url.searchParams.get("runId");
      return { items: backend.records.filter((r) => !runId || r.request.runId === runId) };
    },
    "/trust": {
      config: { globalMode: "supervised", alwaysAsk: [] },
      categories: [],
      promotionOffers: [],
    },
  });
  render(
    <WorkspaceProvider>
      <Harness path={`/tasks/${backend.task.id}`}>
        <TasksProvider>
          <Routes>
            <Route path="/tasks/:id" element={<TaskPage />} />
          </Routes>
        </TasksProvider>
      </Harness>
    </WorkspaceProvider>,
  );
  const requests = () =>
    fetchMock.mock.calls.map(([input, init]) => {
      const url = new URL(String(input), "http://localhost");
      return {
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
    });
  return { requests };
}

const send = (event: unknown) => act(() => FakeSocket.last?.send(event));
const runRequests = (requests: { path: string }[]) =>
  requests.filter((r) => r.path.startsWith("/api/actions?")).length;

beforeEach(() => {
  FakeSocket.last = undefined;
});

/** An inbox task with 40 arrival runs, each with an executed archive. */
function busyInbox(): Backend {
  const runs = Array.from({ length: 40 }, (_, i) =>
    run(`ir-${i}`, "t1", {
      agentRunId: `arrival:em-${i}`,
      trigger: { kind: "arrival", emailId: `em-${i}` },
      actionIds: [`ia-${i}`],
    }),
  );
  const records = runs.map((r, i) =>
    action(`ia-${i}`, "reversible", {
      status: "executed",
      request: { ...action(`ia-${i}`, "reversible").request, runId: r.agentRunId },
    }),
  );
  const items = runs.map((r, i) =>
    item(
      "notification",
      { source: "arrival", summary: `Arrival ${i}` },
      { seq: i + 1, runId: r.id },
    ),
  );
  return { task: task("t1", { kind: "inbox" }), runs, items, records };
}

describe("R5-2 action records", () => {
  it("R5-2: opens a 40-run task without one /api/actions request per run, and frames add none", async () => {
    const { requests } = setup(busyInbox());
    await screen.findByText("Arrival 39");
    expect(runRequests(requests())).toBe(0);
    send({ type: "task.updated", task: { ...task("t1", { kind: "inbox" }), revision: 9 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runRequests(requests())).toBe(0);
  });

  it("R5-2: loads a run's records once, when its change summary opens", async () => {
    const { requests } = setup(busyInbox());
    await screen.findByText("Arrival 39");
    const toggles = screen.getAllByRole("button", { name: /1 change/ });
    fireEvent.click(toggles.at(-1)!);
    expect(await screen.findByText("Reason ia-39")).toBeInTheDocument();
    expect(requests().filter((r) => r.path.startsWith("/api/actions?"))).toEqual([
      expect.objectContaining({ path: "/api/actions?runId=arrival%3Aem-39&limit=200" }),
    ]);
    fireEvent.click(screen.getAllByRole("button", { name: /Archive 1/ }).at(-1)!);
    fireEvent.click(screen.getAllByRole("button", { name: /Archive 1/ }).at(-1)!);
    expect(runRequests(requests())).toBe(1);
  });
});

describe("R5-6 approvals need the record", () => {
  const pendingTask = () =>
    task("t1", { needsUser: "approval", pendingActionIds: ["a2"], status: "inbox" });
  const outward = () =>
    action("a2", "delayed", {
      request: {
        ...action("a2", "delayed").request,
        params: {
          draft: {
            accountId: "acc-1",
            to: [{ email: "billing@example.com" }],
            subject: "Re: Invoice",
            textBody: "Please send the PDF.",
          },
        },
      },
    });
  const items = () => [
    item("approval_request", { actionId: "a2", summary: "Reply to billing" }, { seq: 1 }),
  ];

  it("R5-6: shows Loading… with Approve disabled until the record arrives", async () => {
    setup({ task: pendingTask(), runs: [], items: items(), records: [], decisions: "hang" });
    const panel = await screen.findByRole("region", { name: "1 change waits for you" });
    expect(within(panel).getByText("Loading…")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Approve: Reply to billing" })).toBeDisabled();
    for (const button of screen.getAllByRole("button", { name: /^Approve/ })) {
      expect(button).toBeDisabled();
    }
  });

  it("R5-6: offers no approval when the record fails to load, only retry and the queue", async () => {
    setup({ task: pendingTask(), runs: [], items: items(), records: [], decisions: "fail" });
    const panel = await screen.findByRole("region", { name: "1 change waits for you" });
    expect(await within(panel).findByText("This change did not load.")).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /^Approve/ })).toHaveLength(0);
    expect(within(panel).getByRole("link", { name: "Review in Needs you" })).toHaveAttribute(
      "href",
      "/needs-you?decision=a2",
    );
  });

  it("R5-6: once loaded, shows the type, the Sends badge and the draft before Approve", async () => {
    setup({ task: pendingTask(), runs: [], items: items(), records: [outward()] });
    const panel = await screen.findByRole("region", { name: "1 change waits for you" });
    expect(await within(panel).findByText("Sends")).toBeInTheDocument();
    expect(within(panel).getByText("To billing@example.com: Re: Invoice")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Approve: Reason a2" })).toBeEnabled();
  });

  it("R5-14: a proposed record is pending even when the task omits pendingActionIds", async () => {
    setup({
      task: task("t1", { pendingActionIds: undefined }),
      runs: [run("r1", "t1", { actionIds: ["a2"] })],
      items: items(),
      records: [outward()],
    });
    // The run's records load when its summary opens; the card then offers the decision.
    fireEvent.click(await screen.findByRole("button", { name: /1 change/ }));
    expect(await screen.findByRole("article", { name: "Reason a2" })).toBeInTheDocument();
  });

  it("R5-15: a decided approval leaves the panel at once and cannot be approved twice", async () => {
    const backend = { task: pendingTask(), runs: [], items: items(), records: [outward()] };
    const { requests } = setup(backend);
    const panel = await screen.findByRole("region", { name: "1 change waits for you" });
    fireEvent.click(await within(panel).findByRole("button", { name: "Approve: Reason a2" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: /wait/ })).toBeNull());
    expect(screen.queryByRole("article", { name: "Reason a2" })).toBeNull();
    expect(requests().filter((r) => r.path === "/api/actions/a2/approve")).toHaveLength(1);
  });
});

describe("approve scope", () => {
  it("sends scope task or always from the card; Approve all reversible stays once", async () => {
    const backend: Backend = {
      task: task("t1", { needsUser: "approval", pendingActionIds: ["a1", "a2", "a3"] }),
      runs: [],
      items: ["a1", "a2", "a3"].map((id, i) =>
        item("approval_request", { actionId: id, summary: `Do ${id}` }, { seq: i + 1 }),
      ),
      records: [action("a1", "reversible"), action("a2", "delayed"), action("a3", "delayed")],
    };
    const { requests } = setup(backend);
    const second = await screen.findByRole("article", { name: "Reason a2" });
    fireEvent.click(within(second).getByRole("button", { name: "Approve for this task" }));
    await waitFor(() =>
      expect(requests()).toContainEqual(
        expect.objectContaining({ path: "/api/actions/a2/approve", body: { scope: "task" } }),
      ),
    );
    const third = screen.getByRole("article", { name: "Reason a3" });
    fireEvent.click(within(third).getByRole("button", { name: "Always" }));
    await waitFor(() =>
      expect(requests()).toContainEqual(
        expect.objectContaining({ path: "/api/actions/a3/approve", body: { scope: "always" } }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /Approve 1 reversible|Approve all/ }));
    await waitFor(() =>
      expect(requests()).toContainEqual(
        expect.objectContaining({ path: "/api/actions/a1/approve", body: undefined }),
      ),
    );
  });
});

describe("R5-4 / R5-8 live state", () => {
  it("R5-4: after a reconnect, a run that ended offline no longer shows Stop", async () => {
    const backend: Backend = {
      task: task("t1", { status: "inbox" }),
      runs: [run("r1", "t1", { status: "running", endedAt: null })],
      items: [item("user_message", { text: "Go" }, { seq: 1 })],
      records: [],
    };
    setup(backend);
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    const first = FakeSocket.last;
    act(() => first?.open());
    act(() => first?.drop());
    backend.runs = [run("r1", "t1", { status: "completed" })];
    await waitFor(() => expect(FakeSocket.last).not.toBe(first), { timeout: 2500 });
    act(() => FakeSocket.last?.open());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
  });

  it("R5-8: an inbox task's arrival run offers neither Stop nor steer", async () => {
    setup({
      task: task("t1", { kind: "inbox", status: "working" }),
      runs: [run("r1", "t1", { status: "running", endedAt: null })],
      items: [item("user_message", { text: "Go" }, { seq: 1 })],
      records: [],
    });
    await screen.findByText("Go");
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByText("steer")).toBeNull();
  });
});

describe("R5-5 long histories", () => {
  it("R5-5: opens at the newest items and pages older ones on request", async () => {
    const items = Array.from({ length: 1000 }, (_, i) =>
      item("assistant_message", { text: `Note ${i + 1}` }, { seq: i + 1, runId: null }),
    );
    const { requests } = setup({ task: task("t1"), runs: [], items, records: [] });
    expect(await screen.findByText("Note 1000")).toBeInTheDocument();
    expect(screen.queryByText("Note 1")).toBeNull();
    expect(screen.queryByText("Note 700")).toBeNull();
    const pages = requests().filter((r) => r.path.includes("/items?"));
    // The head page, one-item probes, then the tail: never every page in order.
    expect(pages.filter((r) => r.path.endsWith("limit=100")).length).toBeLessThan(3);
    expect(pages.length).toBeLessThan(16);
    fireEvent.click(screen.getByRole("button", { name: "Show earlier items" }));
    expect(await screen.findByText("Note 850")).toBeInTheDocument();
  });
});
