import type { Task, TaskRun } from "@passport/types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { taskApi } from "../tasks/api";
import { TasksProvider } from "../tasks/store";
import { run, task } from "../tasks/test-fixtures";
import { Harness, stubApi } from "../test-utils";
import { NewTask } from "./NewTask";

function Opened() {
  const location = useLocation();
  const clamp = (location.state as { clamp?: { got: string } } | null)?.clamp;
  return (
    <output aria-label="opened">
      {location.pathname} {clamp ? `clamped to ${clamp.got}` : "not clamped"}
    </output>
  );
}

function renderHome() {
  stubApi({
    "/tasks": { items: [task("w", { title: "Waiting task", needsUser: "approval" })], total: 1 },
    "/trust": {
      config: { globalMode: "auto_accept_edits", alwaysAsk: [] },
      categories: [],
      promotionOffers: [],
    },
  });
  render(
    <Harness>
      <TasksProvider>
        <Routes>
          <Route path="/" element={<NewTask />} />
          <Route path="/tasks/:id" element={<Opened />} />
        </Routes>
      </TasksProvider>
    </Harness>,
  );
}

const created = (patch: Partial<Task> = {}) => ({
  task: task("t-new", patch),
  run: run("r-new", "t-new", { status: "queued" }) as TaskRun,
});

describe("new task", () => {
  it("starts a task with the defaults and opens it", async () => {
    const create = vi.spyOn(taskApi, "create").mockResolvedValue(created());
    renderHome();
    expect(await screen.findByText("Waiting task")).toBeInTheDocument();
    const input = screen.getByLabelText("Instruction for Passport");
    // Mode follows the global dial until the person picks one.
    expect(
      await screen.findByRole("button", {
        name: "Permission mode for this task: Auto-accept edits",
      }),
    ).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "Find the Hetzner invoices" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ message: "Find the Hetzner invoices" }),
    );
    expect(await screen.findByLabelText("opened")).toHaveTextContent("/tasks/t-new not clamped");
  });

  it("sends the chosen mode and Plan, and carries a clamp to the task view", async () => {
    const create = vi
      .spyOn(taskApi, "create")
      .mockResolvedValue(created({ permissionMode: "auto_accept_edits", interactionMode: "plan" }));
    renderHome();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Permission mode for this task: Auto-accept edits",
      }),
    );
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    const input = screen.getByLabelText("Instruction for Passport");
    fireEvent.change(input, { target: { value: "Clean up newsletters" } });
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        message: "Clean up newsletters",
        permissionMode: "full_access",
        interactionMode: "plan",
      }),
    );
    expect(await screen.findByLabelText("opened")).toHaveTextContent(
      "/tasks/t-new clamped to auto_accept_edits",
    );
  });
});
