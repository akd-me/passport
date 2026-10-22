import type { ActionRecord, Task, TaskRun } from "@passport/types";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { taskApi } from "../tasks/api";
import { Harness, stubApi } from "../test-utils";
import { groupProposals, WorkQueue } from "./Decisions";

function proposal(
  id: string,
  matterId: string | null,
  createdAt: string,
  status: ActionRecord["status"] = "proposed",
): ActionRecord {
  return {
    id,
    status,
    createdAt,
    holdUntil: status === "held" ? new Date(Date.now() + 90000).toISOString() : null,
    request: {
      type: "send",
      accountId: "acct",
      actor: { kind: "agent", id: "agent" },
      category: "replies_known",
      matterId,
      reason: `Reason ${id}`,
      params: {
        draft: {
          accountId: "acct",
          to: [{ name: `Person ${id}`, email: `${id}@example.com` }],
          subject: `Subject ${id}`,
          textBody: `Body ${id}`,
          inReplyToEmailId: id === "p1" ? "e1" : null,
        },
      },
    },
    decision: {
      outcome: "ask",
      risk: "high",
      reversibility: "delayed",
      category: "replies_known",
      trustLevel: "supervised",
      reason: "Needs approval",
    },
  };
}
const items = [
  proposal("p1", "m1", "2026-10-20T09:00:00Z"),
  proposal("p2", "m2", "2026-10-20T11:00:00Z"),
  proposal("p3", "m1", "2026-10-20T10:00:00Z"),
  proposal("p4", null, "2026-10-20T12:00:00Z"),
  proposal("h1", "m2", "2026-10-20T08:00:00Z", "held"),
];
const matters = [
  { id: "m1", title: "Northstar launch", status: "active" },
  { id: "m2", title: "Portland trip", status: "waiting" },
];

function stubQueue() {
  return stubApi({
    "/decisions": { items },
    "/matters": matters,
    ...Object.fromEntries(
      matters.map((m) => [
        `/matters/${m.id}`,
        {
          matter: { ...m, summary: "", personIds: [], emailIds: [], eventIds: [] },
          emails: { items: [] },
          events: [],
          actions: { items: [] },
          people: [],
        },
      ]),
    ),
    "/actions": { items: [] },
    "/trust": {
      config: { globalMode: "supervised", alwaysAsk: [] },
      categories: [],
      promotionOffers: [],
    },
    "/accounts": { accounts: [], mode: "real" },
  });
}

describe("work queue", () => {
  it("groups by matter in first-seen order with unfiled proposals last, or newest first", () => {
    const proposed = items.filter((a) => a.status === "proposed");
    expect(
      groupProposals(proposed, "matter").map(([id, list]) => [id, list.map((a) => a.id)]),
    ).toEqual([
      ["m1", ["p1", "p3"]],
      ["m2", ["p2"]],
      ["unassigned", ["p4"]],
    ]);
    expect(groupProposals(proposed, "newest")[0]![1].map((a) => a.id)).toEqual([
      "p4",
      "p2",
      "p3",
      "p1",
    ]);
  });

  it("shows the count, matter groups, and the outbox with a cancel control", async () => {
    stubQueue();
    render(
      <Harness>
        <WorkQueue />
      </Harness>,
    );
    expect(
      await screen.findByRole("heading", { name: "4 proposals need you" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Northstar launch" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Not in a matter" })).toBeInTheDocument();
    const outbox = screen.getByRole("region", { name: /Leaving soon/ });
    expect(within(outbox).getByText("To Person h1")).toBeInTheDocument();
    expect(
      within(outbox).getByRole("button", { name: "Cancel send: Reason h1" }),
    ).toBeInTheDocument();
  });

  it("moves with j/k and approves the selected proposal with a", async () => {
    stubQueue();
    const approve = vi.spyOn(api, "approve").mockResolvedValue(items[0]!);
    render(
      <Harness>
        <WorkQueue />
      </Harness>,
    );
    const first = await screen.findByRole("article", { name: "Reason p1" });
    await waitFor(() => expect(first).toHaveAttribute("aria-current", "true"));
    fireEvent.keyDown(window, { key: "j" });
    expect(screen.getByRole("article", { name: "Reason p3" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    fireEvent.keyDown(window, { key: "a" });
    await waitFor(() => expect(approve).toHaveBeenCalledWith("p3", undefined, "once"));
    fireEvent.keyDown(window, { key: "k" });
    expect(first).toHaveAttribute("aria-current", "true");
  });

  it("switches to newest-first ordering", async () => {
    stubQueue();
    render(
      <Harness>
        <WorkQueue />
      </Harness>,
    );
    fireEvent.click(await screen.findByRole("radio", { name: "Newest" }));
    const order = screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"));
    expect(order).toEqual(["Reason p4", "Reason p2", "Reason p3", "Reason p1"]);
  });

  it("starts a task from the composer, mentioning the selected proposal's message", async () => {
    stubQueue();
    const created = {
      task: { id: "t1", permissionMode: "supervised" } as Task,
      run: { id: "r1", taskId: "t1", status: "queued" } as TaskRun,
    };
    const create = vi.spyOn(taskApi, "create").mockResolvedValue(created);
    render(
      <Harness>
        <WorkQueue />
      </Harness>,
    );
    const input = await screen.findByLabelText("Instruction for Passport");
    // The selected proposal's source message rides along as context.
    expect(
      await screen.findByRole("button", { name: "Don’t include Subject p1" }),
    ).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "Draft replies" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        message: "Draft replies\n\nMessage: “Subject p1” (id e1).",
        title: "Draft replies",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Don’t include Subject p1" }));
    fireEvent.change(input, { target: { value: "Summarise" } });
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));
    await waitFor(() => expect(create).toHaveBeenLastCalledWith({ message: "Summarise" }));
  });
});
