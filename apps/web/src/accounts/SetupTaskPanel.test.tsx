import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupTask } from "@passport/types";
import { SetupTaskPanel } from "./SetupTaskPanel";
import { setupApi } from "../setup-api";

const task = (patch: Partial<SetupTask> = {}): SetupTask => ({
  id: "t1",
  provider: "gmail",
  status: "waiting_for_user",
  steps: [
    { id: "prepare", title: "Start the browser and agent", status: "done", detail: "Codex with Google Chrome" },
    { id: "sign_in", title: "Sign in to Google Cloud", status: "running" },
  ],
  prompt: { id: "p1", kind: "sign_in", message: "Sign in to Google in the browser window I opened, then click Continue." },
  log: [{ at: "2026-10-21T00:00:00.000Z", level: "info", text: "Browser: opened https://console.cloud.google.com/" }],
  ...patch,
});

describe("setup task panel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts a task, shows steps, prompt and log, and answers and cancels", async () => {
    const start = vi.spyOn(setupApi, "start").mockResolvedValue({ id: "t1" });
    vi.spyOn(setupApi, "get").mockResolvedValue(task());
    const respond = vi.spyOn(setupApi, "respond").mockResolvedValue(task({ status: "running", prompt: { id: "p2", kind: "question", message: "Which address?" } }));
    const cancel = vi.spyOn(setupApi, "cancel").mockResolvedValue(task({ status: "cancelled", prompt: undefined }));
    render(<SetupTaskPanel provider="gmail" calendar={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up with my agent" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith({ provider: "gmail", calendar: false }));
    expect(await screen.findByText(/Sign in to Google in the browser window/)).toBeInTheDocument();
    expect(screen.getByText(/Codex with Google Chrome/)).toBeInTheDocument();
    expect(screen.getByText("Browser: opened https://console.cloud.google.com/")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up with my agent" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith("t1", "p1", "done"));
    fireEvent.change(await screen.findByLabelText("Answer"), { target: { value: "alex@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(respond).toHaveBeenLastCalledWith("t1", "p2", "alex@example.com"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel setup" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("t1"));
    expect(await screen.findByText("Status: cancelled")).toBeInTheDocument();
  });

  it("shows why a task could not start", async () => {
    vi.spyOn(setupApi, "start").mockRejectedValue(new Error("A setup task is already running; finish or cancel it first"));
    render(<SetupTaskPanel provider="microsoft" calendar />);
    fireEvent.click(screen.getByRole("button", { name: "Set up with my agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already running");
  });
});
