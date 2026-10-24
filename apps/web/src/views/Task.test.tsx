import type { ActionRecord, Task, TaskItem, TaskRun } from "@passport/types";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceProvider } from "../state";
import { TasksProvider } from "../tasks/store";
import { action, FakeSocket, item, run, task, tool } from "../tasks/test-fixtures";
import { Harness, stubApi } from "../test-utils";
import { TaskPage } from "./Task";

interface Backend {
  task: Task;
  runs: TaskRun[];
  items: TaskItem[];
  records: ActionRecord[];
  patch?: (body: Record<string, unknown>) => Partial<Task>;
}

function setup(backend: Backend) {
  vi.stubGlobal("WebSocket", FakeSocket);
  const tasks = async (url: URL, init?: RequestInit) => {
    const path = url.pathname.replace(/^\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/tasks") {
      return { items: [backend.task], total: 1 };
    }
    if (path === "/tasks/t1" && method === "GET") {
      return { task: backend.task, runs: backend.runs };
    }
    if (path === "/tasks/t1/items") {
      const after = Number(url.searchParams.get("afterSeq"));
      const items = backend.items.filter((i) => i.seq > after);
      return { items, lastSeq: items.at(-1)?.seq ?? after };
    }
    if (path === "/tasks/t1" && method === "PATCH") {
      backend.task = {
        ...backend.task,
        ...body,
        ...backend.patch?.(body),
        revision: (backend.task.revision ?? 0) + 1,
      };
      return backend.task;
    }
    if (path === "/tasks/t1/messages") {
      return Response.json({ task: backend.task, run: backend.runs[0] }, { status: 202 });
    }
    return backend.task;
  };
  const fetchMock = stubApi({
    "/tasks": tasks,
    "/decisions": () => ({ items: backend.records.filter((r) => r.status === "proposed") }),
    "/actions": (url: URL) =>
      url.pathname.endsWith("/approve") || url.pathname.endsWith("/reject")
        ? backend.records[0]
        : { items: backend.records },
    "/trust": {
      config: { globalMode: "supervised", alwaysAsk: [] },
      categories: [],
      promotionOffers: [],
    },
  });
  render(
    <WorkspaceProvider>
      <Harness path="/tasks/t1">
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

beforeEach(() => {
  FakeSocket.last = undefined;
});

describe("task timeline", () => {
  it("renders model text as structure only, and mail text as plain text, never links", async () => {
    const quoted = "Pay **now** [here](http://evil.example/x) <img src=x onerror=alert(1)>";
    setup({
      task: task("t1"),
      runs: [run("r1", "t1")],
      records: [],
      items: [
        item("user_message", { text: "Find the invoice" }, { seq: 1 }),
        item("assistant_message", { text: quoted }, { seq: 2, untrusted: true }),
        item(
          "notification",
          {
            source: "arrival",
            summary: "New mail from <b>Billing</b>",
            row: {
              id: "m1",
              threadId: "th1",
              rfc822Id: null,
              account: "acc-1",
              date: "2026-10-22T11:00:00Z",
              from: "Billing <billing@example.com>",
              to: [],
              subject: "Invoice [link](http://evil.example)",
              snippet: "<script>alert(1)</script>",
              labels: [],
              unread: true,
              flagged: false,
              attachments: 1,
            },
          },
          { seq: 3, runId: null, untrusted: true },
        ),
      ],
    });
    const log = await screen.findByRole("log", { name: "Timeline" });
    const bold = await within(log).findByText("now");
    expect(bold.tagName).toBe("STRONG");
    const message = bold.closest(".md");
    expect(message).toHaveTextContent(
      "Pay now here (http://evil.example/x) <img src=x onerror=alert(1)>",
    );
    expect(message?.querySelector("a, img")).toBeNull();
    expect(within(log).getByText("New mail from <b>Billing</b>")).toBeInTheDocument();
    expect(within(log).getByText("Invoice [link](http://evil.example)")).toBeInTheDocument();
    expect(within(log).getByText("<script>alert(1)</script>")).toBeInTheDocument();
    expect(log.querySelector("img, script, b, strong a, a[href*='evil']")).toBeNull();
    expect(within(log).queryAllByRole("link")).toHaveLength(0);
  });

  it("collapses tool calls into one line that expands into each call", async () => {
    setup({
      task: task("t1"),
      runs: [run("r1", "t1")],
      records: [],
      items: [
        tool("mail_search", { inputSummary: 'query="from:hetzner"', cost: { gmailUnits: 5 } }),
        tool("mail_search", { inputSummary: 'query="invoice"', durationMs: 412 }),
        tool("send", { isError: true, resultSummary: "SEND_FAILED: no account" }),
      ].map((call, i) => ({ ...call, seq: i + 1 })),
    });
    const head = await screen.findByRole("button", { name: /Searched twice; 1 failed/ });
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText('query="invoice"')).toBeNull();
    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText('query="from:hetzner"')).toBeInTheDocument();
    expect(screen.getByText("5 gmail units")).toBeInTheDocument();
    expect(screen.getByText("412 ms")).toBeInTheDocument();
    expect(screen.getByText("SEND_FAILED: no account")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });
});

describe("approvals", () => {
  it("wires inline cards and the composer panel to approve and reject, following pendingActionIds", async () => {
    const reversible = action("a1", "reversible");
    const outward = action("a2", "delayed", {
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
    const backend: Backend = {
      task: task("t1", { needsUser: "approval", pendingActionIds: ["a1", "a2"] }),
      runs: [run("r1", "t1", { actionIds: ["a1", "a2"] })],
      records: [reversible, outward],
      items: [
        item("approval_request", { actionId: "a1", summary: "Archive 3" }, { seq: 1 }),
        item("approval_request", { actionId: "a2", summary: "Reply to billing" }, { seq: 2 }),
      ],
    };
    const { requests } = setup(backend);
    const panel = await screen.findByRole("region", { name: "2 changes wait for you" });
    // The draft is editable inline (the queue's decision card).
    const card = await screen.findByRole("article", { name: "Reason a2" });
    expect(within(card).getByRole("button", { name: /Edit/ })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Approve 1 reversible" }));
    await waitFor(() =>
      expect(requests()).toContainEqual(
        expect.objectContaining({ path: "/api/actions/a1/approve", method: "POST" }),
      ),
    );
    expect(requests().some((r) => r.path === "/api/actions/a2/approve")).toBe(false);

    backend.records = [{ ...reversible, status: "executed" }, outward];
    send({
      type: "task.updated",
      task: { ...backend.task, pendingActionIds: ["a2"], revision: 2 },
    });
    expect(
      await screen.findByRole("region", { name: "1 change waits for you" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reject: Reason a2" }));
    await waitFor(() =>
      expect(requests()).toContainEqual(
        expect.objectContaining({ path: "/api/actions/a2/reject", method: "POST" }),
      ),
    );
    send({
      type: "task.updated",
      task: { ...backend.task, pendingActionIds: [], needsUser: null, revision: 3 },
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: /wait/ })).toBeNull());
    expect(screen.queryByRole("article", { name: "Reason a2" })).toBeNull();
  });
});

describe("approval cards under a real pointer", () => {
  it("acts on the first click on an unselected draft card: pressing does not select and reflow it", async () => {
    const draft = (id: string) =>
      action(id, "delayed", {
        request: {
          ...action(id, "delayed").request,
          params: {
            draft: {
              accountId: "acc-1",
              to: [{ email: "billing@example.com" }],
              subject: `Re: ${id}`,
              textBody: "One\nTwo\nThree\nFour\nFive",
            },
          },
        },
      });
    const { requests } = setup({
      task: task("t1", { needsUser: "approval", pendingActionIds: ["a1", "a2"] }),
      runs: [run("r1", "t1", { actionIds: ["a1", "a2"] })],
      records: [draft("a1"), draft("a2")],
      items: [
        item("approval_request", { actionId: "a1", summary: "Reply 1" }, { seq: 1 }),
        item("approval_request", { actionId: "a2", summary: "Reply 2" }, { seq: 2 }),
      ],
    });
    const card = await screen.findByRole("article", { name: "Reason a2" });
    expect(card).not.toHaveAttribute("aria-current");
    const approve = within(card).getByRole("button", { name: "Approve" });
    // A mouse press: pointerdown, then focus lands on the button (Chromium) or the card (WebKit).
    fireEvent.pointerDown(approve);
    act(() => approve.focus());
    expect(card).not.toHaveAttribute("aria-current");
    expect(card).not.toHaveClass("selected");
    fireEvent.pointerDown(approve);
    act(() => card.focus());
    expect(card).not.toHaveClass("selected");
    fireEvent.click(approve);
    await waitFor(() =>
      expect(requests().filter((r) => r.path === "/api/actions/a2/approve")).toHaveLength(1),
    );
    expect(card).toHaveAttribute("aria-current", "true");
  });

  it("still selects a card that takes keyboard focus", async () => {
    setup({
      task: task("t1", { needsUser: "approval", pendingActionIds: ["a1", "a2"] }),
      runs: [run("r1", "t1", { actionIds: ["a1", "a2"] })],
      records: [action("a1", "delayed"), action("a2", "delayed")],
      items: [
        item("approval_request", { actionId: "a1", summary: "Reply 1" }, { seq: 1 }),
        item("approval_request", { actionId: "a2", summary: "Reply 2" }, { seq: 2 }),
      ],
    });
    const card = await screen.findByRole("article", { name: "Reason a2" });
    act(() => card.focus());
    expect(card).toHaveAttribute("aria-current", "true");
  });
});

describe("task composer", () => {
  it("queues with Enter, steers with ⌘Enter, stops a running task and toggles plan", async () => {
    const { requests } = setup({
      task: task("t1", { status: "working" }),
      runs: [run("r1", "t1", { status: "running", endedAt: null })],
      records: [],
      items: [item("user_message", { text: "Start" }, { seq: 1 })],
    });
    const input = await screen.findByLabelText("Message for this task");
    fireEvent.change(input, { target: { value: "Only PDFs" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(requests()).toContainEqual({
        path: "/api/tasks/t1/messages",
        method: "POST",
        body: { text: "Only PDFs", mode: "queue" },
      }),
    );
    fireEvent.change(input, { target: { value: "Actually stop, do X" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    await waitFor(() =>
      expect(requests()).toContainEqual({
        path: "/api/tasks/t1/messages",
        method: "POST",
        body: { text: "Actually stop, do X", mode: "steer" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(requests()).toContainEqual(
        expect.objectContaining({ path: "/api/tasks/t1/interrupt", method: "POST" }),
      ),
    );
    const plan = screen.getByRole("button", { name: "Plan" });
    expect(plan).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(plan);
    await waitFor(() => expect(plan).toHaveAttribute("aria-pressed", "true"));
    expect(requests()).toContainEqual({
      path: "/api/tasks/t1",
      method: "PATCH",
      body: { interactionMode: "plan" },
    });
  });

  it("says when the server clamps the requested permission mode", async () => {
    const { requests } = setup({
      task: task("t1"),
      runs: [],
      records: [],
      items: [],
      // The global dial is Auto-accept edits: anything higher comes back lowered.
      patch: () => ({ permissionMode: "auto_accept_edits" }),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Task permission mode: Supervised" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Clamped to Auto-accept edits by the account ladder",
    );
    expect(requests()).toContainEqual({
      path: "/api/tasks/t1",
      method: "PATCH",
      body: { permissionMode: "full_access" },
    });
    expect(
      screen.getByRole("button", { name: "Task permission mode: Auto-accept edits" }),
    ).toBeInTheDocument();
  });
});

describe("live updates", () => {
  it("appends items from the socket, pages over gaps, and refetches after a reconnect", async () => {
    const backend: Backend = {
      task: task("t1", { status: "working" }),
      runs: [run("r1", "t1", { status: "running", endedAt: null })],
      records: [],
      items: [
        item("user_message", { text: "First" }, { seq: 1 }),
        item("assistant_message", { text: "Second" }, { seq: 2 }),
      ],
    };
    const { requests } = setup(backend);
    await screen.findByText("Second");
    const third = item("assistant_message", { text: "Third, live" }, { seq: 3 });
    backend.items.push(third);
    send({ type: "task.item.appended", item: third });
    expect(await screen.findByText("Third, live")).toBeInTheDocument();
    expect(requests().some((r) => r.path.includes("afterSeq=2"))).toBe(false);

    // Seq 4 was missed: 5 arrives, the gap is paged in from afterSeq=3.
    const fourth = item("assistant_message", { text: "Fourth, missed" }, { seq: 4 });
    const fifth = item("assistant_message", { text: "Fifth" }, { seq: 5 });
    backend.items.push(fourth, fifth);
    send({ type: "task.item.appended", item: fifth });
    expect(await screen.findByText("Fourth, missed")).toBeInTheDocument();
    expect(requests()).toContainEqual(
      expect.objectContaining({ path: "/api/tasks/t1/items?afterSeq=3&limit=100" }),
    );

    // The socket drops; while it is down seq 6 lands. The reconnect refetches.
    const sixth = item("assistant_message", { text: "Sixth, while offline" }, { seq: 6 });
    backend.items.push(sixth);
    const first = FakeSocket.last;
    act(() => first?.drop());
    await waitFor(() => expect(FakeSocket.last).not.toBe(first), { timeout: 2500 });
    const detailCalls = requests().filter((r) => r.path === "/api/tasks/t1").length;
    act(() => FakeSocket.last?.open());
    expect(await screen.findByText("Sixth, while offline")).toBeInTheDocument();
    expect(requests()).toContainEqual(
      expect.objectContaining({ path: "/api/tasks/t1/items?afterSeq=5&limit=100" }),
    );
    expect(requests().filter((r) => r.path === "/api/tasks/t1").length).toBeGreaterThan(
      detailCalls,
    );
  });
});
