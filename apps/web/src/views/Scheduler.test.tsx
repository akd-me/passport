import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Job, jobsApi } from "../scheduler-api";
import { describeSchedule, JobsTable, NewRoutineForm } from "./Scheduler";

function job(patch: Partial<Job> = {}): Job {
  return {
    id: "routine:morning",
    name: "Morning triage",
    kind: "user",
    schedule: { type: "daily", at: "07:30", timeZone: "America/New_York" },
    enabled: true,
    running: false,
    lastRunAt: new Date().toISOString(),
    lastStatus: "ok",
    lastDurationMs: 1250,
    lastError: null,
    consecutiveFailures: 0,
    nextRunAt: new Date(Date.now() + 120000).toISOString(),
    runCount: 3,
    history: [],
    ...patch,
  };
}
afterEach(() => vi.restoreAllMocks());
describe("jobs table", () => {
  it("shows schedule, status, duration, countdown and failures", () => {
    render(
      <JobsTable
        jobs={[
          job(),
          job({
            id: "outbox.release",
            name: "Outbox",
            kind: "system",
            lastStatus: "error",
            consecutiveFailures: 2,
            lastError: "Provider is offline",
            schedule: { type: "interval", everyMs: 30000 },
          }),
        ]}
        onHistory={vi.fn()}
      />,
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText(/Daily at 07:30/)).toHaveTextContent("America/New_York");
    expect(screen.getAllByText(/1.3 s/)).toHaveLength(2);
    expect(screen.getAllByText("in 2m")).toHaveLength(2);
    expect(screen.getByText("2 failures")).toBeInTheDocument();
    expect(screen.getByText("Provider is offline")).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
  });
  it("runs and pauses jobs, resumes paused jobs, and opens history", async () => {
    const run = vi.spyOn(jobsApi, "run").mockResolvedValue({
        runId: "run",
        startedAt: new Date().toISOString(),
        durationMs: 0,
        status: "ok",
      }),
      pause = vi.spyOn(jobsApi, "pause").mockResolvedValue(job({ enabled: false })),
      resume = vi.spyOn(jobsApi, "resume").mockResolvedValue(job()),
      history = vi.fn();
    const { rerender } = render(<JobsTable jobs={[job()]} onHistory={history} />);
    fireEvent.click(screen.getByRole("button", { name: "Run Morning triage now" }));
    await waitFor(() => expect(run).toHaveBeenCalledWith("routine:morning"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause Morning triage" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause Morning triage" }));
    await waitFor(() => expect(pause).toHaveBeenCalledWith("routine:morning"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause Morning triage" })).toBeEnabled(),
    );
    const paused = job({ enabled: false });
    rerender(<JobsTable jobs={[paused]} onHistory={history} />);
    expect(screen.getByText("Paused")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume Morning triage" }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith("routine:morning"));
    fireEvent.click(screen.getByRole("button", { name: "History for Morning triage" }));
    expect(history).toHaveBeenCalledWith(paused);
  });
  it("disables manual execution while running and surfaces failed run results", async () => {
    const { rerender } = render(<JobsTable jobs={[job({ running: true })]} onHistory={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Run Morning triage now" })).toBeDisabled();
    rerender(<JobsTable jobs={[job()]} onHistory={vi.fn()} />);
    vi.spyOn(jobsApi, "run").mockResolvedValue({
      runId: "run",
      startedAt: new Date().toISOString(),
      durationMs: 1,
      status: "error",
      summary: "Model unavailable",
    });
    fireEvent.click(screen.getByRole("button", { name: "Run Morning triage now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Model unavailable");
  });
  it("formats weekly and manual schedules", () => {
    expect(
      describeSchedule({
        type: "weekly",
        days: [1, 3, 5],
        at: "07:30",
        timeZone: "UTC",
      }),
    ).toBe("Mon, Wed, Fri at 07:30 · UTC");
    expect(describeSchedule({ type: "manual" })).toBe("On demand");
  });
});
describe("routine form", () => {
  it("builds a weekday routine from an example and submits the instruction", async () => {
    const add = vi.spyOn(jobsApi, "add").mockResolvedValue(job()),
      created = vi.fn();
    render(<NewRoutineForm onCreated={created} />);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "My morning" },
    });
    fireEvent.change(screen.getByLabelText("Schedule"), {
      target: { value: "weekly" },
    });
    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "America/New_York" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Morning triage" }));
    expect(screen.getByLabelText("Instruction")).toHaveValue(
      "Triage anything new, then prepare my day's digest.",
    );
    expect(
      screen.getAllByRole("checkbox").filter((c) => (c as HTMLInputElement).checked),
    ).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Create routine" }));
    await waitFor(() => expect(created).toHaveBeenCalled());
    expect(add).toHaveBeenCalledWith({
      name: "My morning",
      schedule: {
        type: "weekly",
        at: "07:30",
        days: [1, 2, 3, 4, 5],
        timeZone: "America/New_York",
      },
      routine: {
        instruction: "Triage anything new, then prepare my day's digest.",
      },
    });
  });
});
