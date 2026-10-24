import type { SecretRequest, TaskItem, WebhookDelivery } from "@passport/types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { type Job, jobsApi } from "../scheduler-api";
import { useResource } from "../state";
import { NewRoutineForm } from "../views/NewRoutineForm";
import { Automations } from "./Automations";
import { Deliveries } from "./Deliveries";
import { SecretRequestItem } from "./SecretRequest";

vi.mock("../state", async (original) => ({
  ...(await original<typeof import("../state")>()),
  useResource: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());
const now = "2026-10-24T12:00:00.000Z";
const job: Job = {
  id: "routine:hook",
  taskId: "task-1",
  name: "Issues",
  kind: "user",
  schedule: { type: "webhook" },
  runOn: "bound",
  enabled: true,
  running: false,
  lastRunAt: now,
  lastStatus: "ok",
  lastDurationMs: 1,
  lastError: null,
  consecutiveFailures: 0,
  nextRunAt: null,
  runCount: 1,
  history: [],
  webhookUrl: "/api/hooks/private-token",
};
function resource(data: unknown) {
  vi.mocked(useResource).mockReturnValue({ data, loading: false, refresh: vi.fn() });
}
describe("scheduler task panels", () => {
  it("shows only this task's automations and runs, pauses and resumes them", async () => {
    const pause = vi.spyOn(jobsApi, "pause").mockResolvedValue(job);
    const resume = vi.spyOn(jobsApi, "resume").mockResolvedValue(job);
    const run = vi
      .spyOn(jobsApi, "run")
      .mockResolvedValue({ runId: "run", startedAt: now, durationMs: 1, status: "ok" });
    resource([job, { ...job, id: "other", name: "Other task", taskId: "task-2" }]);
    const view = render(<Automations taskId="task-1" />);
    expect(screen.getByRole("region", { name: "Automations" })).toBeInTheDocument();
    expect(screen.queryByText("Other task")).not.toBeInTheDocument();
    expect(screen.getByText("On webhook delivery")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(run).toHaveBeenCalledWith(job.id));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(pause).toHaveBeenCalledWith(job.id));
    resource([{ ...job, enabled: false }]);
    view.rerender(<Automations taskId="task-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith(job.id));
  });
  it("shows delivery outcomes and safe prompt text, and rotates the URL", async () => {
    const deliveries: WebhookDelivery[] = [
      {
        id: "one",
        jobId: job.id,
        receivedAt: now,
        outcome: "accepted",
        prompt: "<img src='https://remote.example/beacon'>",
      },
      { id: "two", jobId: job.id, receivedAt: now, outcome: "rejected_signature" },
    ];
    resource(deliveries);
    vi.spyOn(jobsApi, "rotateToken").mockResolvedValue({ webhookUrl: "/api/hooks/new-token" });
    const { container } = render(<Deliveries job={job} />);
    // R2-19: outcomes are toned badges, like the run history.
    expect(screen.getByText("rejected signature")).toHaveClass("badge", "danger");
    expect(screen.getByText("accepted")).toHaveClass("badge", "good");
    expect(screen.getByText("<img src='https://remote.example/beacon'>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Rotate webhook URL" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Webhook URL")).toHaveValue(
        new URL("/api/hooks/new-token", window.location.origin).href,
      ),
    );
  });
  it("submits a password privately and clears the input after saving", async () => {
    const state: SecretRequest = {
      id: "request-1",
      taskId: "task-1",
      clientRequestId: "request",
      text: "IMAP password",
      status: "pending",
      createdAt: now,
      expiresAt: "2026-10-24T12:05:00.000Z",
    };
    const item: Extract<TaskItem, { kind: "secret_request" }> = {
      id: "item",
      taskId: state.taskId,
      runId: null,
      seq: 1,
      at: now,
      kind: "secret_request",
      payload: { requestId: state.id, text: state.text, expiresAt: state.expiresAt },
    };
    resource(state);
    const post = vi.spyOn(api, "request").mockResolvedValue({ ...state, status: "saved" });
    const { container } = render(<SecretRequestItem item={item} />);
    // R2-12: a visible "Private input" heading names the region; Save is the primary action.
    expect(screen.getByRole("region", { name: "Private input" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save privately" })).toHaveClass("btn-primary");
    const input = screen.getByLabelText("Secret");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.change(input, { target: { value: "private-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Save privately" }));
    await waitFor(() => expect(screen.getByText("Secret saved privately.")).toBeInTheDocument());
    expect(post).toHaveBeenCalledWith("/tasks/task-1/secrets/request-1", {
      method: "POST",
      body: JSON.stringify({ value: "private-password" }),
    });
    expect(container.textContent).not.toContain("private-password");
    expect(screen.queryByLabelText("Secret")).not.toBeInTheDocument();
  });
  it("creates a fresh webhook routine with signature, dedupe and filters", async () => {
    const add = vi.spyOn(jobsApi, "add").mockResolvedValue(job);
    render(<NewRoutineForm onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Issues" } });
    fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "webhook" } });
    fireEvent.change(screen.getByLabelText("Run on"), { target: { value: "fresh" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Verify HMAC signatures" }));
    fireEvent.change(screen.getByLabelText("Secret reference"), {
      target: { value: "secret:opaque" },
    });
    fireEvent.change(screen.getByLabelText("Replay key"), {
      target: { value: "{{headers.x-delivery}}" },
    });
    fireEvent.change(screen.getByLabelText("Coalesce key"), {
      target: { value: "{{body.issue.number}}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: "body.action" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "opened" } });
    fireEvent.change(screen.getByLabelText("Instruction"), {
      target: { value: "Review {{body}}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create routine" }));
    await waitFor(() => expect(add).toHaveBeenCalled());
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        runOn: "fresh",
        schedule: expect.objectContaining({
          type: "webhook",
          signature: {
            header: "x-hub-signature-256",
            encoding: "hex",
            prefix: "sha256=",
            secretRef: "secret:opaque",
          },
          dedupe: { replayKey: "{{headers.x-delivery}}", coalesceKey: "{{body.issue.number}}" },
          filters: [{ path: "body.action", op: "equals", value: "opened" }],
        }),
      }),
    );
  });
});
