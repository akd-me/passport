import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { type SetupTask, setupApi } from "../setup-api";
import { Harness, stubApi } from "../test-utils";
import { SetupFlow } from "./SetupFlow";

function task(patch: Partial<SetupTask> = {}): SetupTask {
  return {
    id: "task-1",
    provider: "microsoft",
    status: "running",
    steps: [
      { id: "browser", title: "Open a browser", status: "done" },
      { id: "register", title: "Register a private app", status: "running", detail: "Entra ID" },
      { id: "connect", title: "Connect the mailbox", status: "pending" },
    ],
    log: [{ at: new Date().toISOString(), level: "info", text: "Opened portal.azure.com" }],
    ...patch,
  };
}
const renderFlow = (onDone = vi.fn()) =>
  render(
    <Harness>
      <SetupFlow onDone={onDone} />
    </Harness>,
  );

describe("agent-driven account setup", () => {
  it("starts a task for the chosen provider and shows live steps", async () => {
    stubApi({ "/accounts": { accounts: [] } });
    const start = vi.spyOn(setupApi, "start").mockResolvedValue({ id: "task-1" });
    vi.spyOn(setupApi, "get").mockResolvedValue(task());
    renderFlow();
    fireEvent.click(screen.getByRole("radio", { name: /Microsoft/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Connect calendar too" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect Outlook" }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({ provider: "microsoft", calendar: false }),
    );
    expect(await screen.findByRole("heading", { name: "Connecting Outlook" })).toBeInTheDocument();
    const steps = screen.getByRole("list", { name: "Setup progress" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(3);
    expect(within(steps).getByText("Register a private app").closest("li")).toHaveTextContent(
      "In progress",
    );
    expect(screen.getByText("Opened portal.azure.com")).toBeInTheDocument();
  });

  it("asks the user to sign in, continues, and finishes", async () => {
    stubApi({ "/accounts": { accounts: [] } });
    vi.spyOn(setupApi, "start").mockResolvedValue({ id: "task-1" });
    vi.spyOn(setupApi, "get").mockResolvedValue(
      task({
        status: "waiting_for_user",
        prompt: {
          id: "prompt-1",
          kind: "sign_in",
          message: "Sign in to Microsoft in the window that opened.",
        },
      }),
    );
    const respond = vi.spyOn(setupApi, "respond").mockResolvedValue(
      task({
        status: "completed",
        steps: task().steps.map((s) => ({ ...s, status: "done" as const })),
        result: { accountIds: ["acct-1"] },
      }),
    );
    const done = vi.fn();
    renderFlow(done);
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    const prompt = await screen.findByRole("alert");
    expect(prompt).toHaveTextContent("Sign in in the browser window, then continue");
    fireEvent.click(within(prompt).getByRole("button", { name: "I’ve signed in, continue" }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith("task-1", "prompt-1", "done"));
    expect(
      await screen.findByRole("heading", { name: "Outlook is connected" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(done).toHaveBeenCalled();
  });

  it("answers a question and can cancel a running task", async () => {
    stubApi({ "/accounts": { accounts: [] } });
    vi.spyOn(setupApi, "start").mockResolvedValue({ id: "task-1" });
    vi.spyOn(setupApi, "get").mockResolvedValue(
      task({
        status: "waiting_for_user",
        prompt: { id: "q", kind: "question", message: "Which tenant?" },
      }),
    );
    const respond = vi.spyOn(setupApi, "respond").mockResolvedValue(task());
    const cancel = vi.spyOn(setupApi, "cancel").mockResolvedValue(task({ status: "cancelled" }));
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    fireEvent.change(await screen.findByLabelText("Your answer"), {
      target: { value: "personal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith("task-1", "q", "personal"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel setup" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("task-1"));
    expect(await screen.findByRole("heading", { name: "Setup cancelled" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("shows the failure and offers manual setup", async () => {
    stubApi({ "/accounts": { accounts: [] }, "/providers": [] });
    vi.spyOn(setupApi, "start").mockResolvedValue({ id: "task-1" });
    vi.spyOn(setupApi, "get").mockResolvedValue(
      task({ status: "failed", error: "Google rejected the consent screen." }),
    );
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Google rejected the consent screen.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Set up manually" }));
    expect(
      await screen.findByRole("button", { name: "Back to automatic setup" }),
    ).toBeInTheDocument();
  });

  it("falls back to manual setup when the server has no setup tasks yet", async () => {
    stubApi({
      "/accounts": { accounts: [] },
      "/providers": [
        { kind: "gmail", label: "Gmail", fields: [], oauth: { scopes: [] } },
        { kind: "graph", label: "Outlook", fields: [], oauth: { scopes: [] } },
      ],
    });
    vi.spyOn(setupApi, "start").mockRejectedValue(
      new ApiError("Unknown API route", "NOT_FOUND", 404),
    );
    renderFlow();
    fireEvent.click(screen.getByRole("radio", { name: /Microsoft/ }));
    fireEvent.click(screen.getByRole("button", { name: "Connect Outlook" }));
    expect(await screen.findByText(/Automatic setup is not available/)).toBeInTheDocument();
    expect(await screen.findByLabelText("Provider")).toHaveValue("graph");
    expect(screen.getByLabelText("OAuth client ID")).toBeInTheDocument();
  });
});
