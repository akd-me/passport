import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ActionRecord, DraftInput } from "@passport/types";
import { api } from "../api";
import { DecisionCard } from "./Decisions";
function action(status: "proposed" | "held" = "proposed"): ActionRecord {
  return {
    id: "action-test",
    status,
    createdAt: new Date().toISOString(),
    holdUntil: new Date(Date.now() + 120000).toISOString(),
    request: {
      type: "send",
      accountId: "account-test",
      actor: { kind: "agent", id: "test-agent" },
      category: "replies_known",
      reason: "Confirm the launch with Maya.",
      params: {
        draft: {
          accountId: "account-test",
          to: [{ name: "Maya", email: "maya@example.com" }],
          subject: "Thursday’s launch",
          textBody: "Hi Maya, Thursday works.\n\nAlex",
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
describe("DecisionCard", () => {
  it("approves the original request", async () => {
    const approve = vi.spyOn(api, "approve").mockResolvedValue(action("held"));
    render(<DecisionCard action={action()} />);
    expect(
      screen.getByText("Confirm the launch with Maya."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith("action-test", undefined),
    );
  });
  it("edits the draft, focuses the editor, and approves the edited body", async () => {
    const approve = vi.spyOn(api, "approve").mockResolvedValue(action("held"));
    render(<DecisionCard action={action()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Draft body" });
    expect(editor).toHaveFocus();
    fireEvent.change(editor, {
      target: { value: "Hi Maya, let’s make it Friday." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit & approve" }));
    await waitFor(() => expect(approve).toHaveBeenCalled());
    const edited = approve.mock.calls[0]?.[1];
    expect((edited?.params as { draft: DraftInput }).draft.textBody).toBe(
      "Hi Maya, let’s make it Friday.",
    );
  });
  it("rejects a proposal and disables controls while the decision is pending", async () => {
    let finish!: (value: ActionRecord) => void;
    const reject = vi.spyOn(api, "reject").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<DecisionCard action={action()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(reject).toHaveBeenCalledWith("action-test");
    finish({ ...action(), status: "rejected" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled(),
    );
  });
  it("shows the hold countdown and cancels an outgoing message", async () => {
    const cancel = vi
      .spyOn(api, "cancel")
      .mockResolvedValue({ ...action(), status: "rejected" });
    render(<DecisionCard action={action("held")} />);
    expect(screen.getByText("2:00")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel send" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("action-test"));
  });
  it("keeps the draft and displays an actionable error when approval fails", async () => {
    vi.spyOn(api, "approve").mockRejectedValue(
      new Error("This action has already been decided."),
    );
    render(<DecisionCard action={action()} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "already been decided",
    );
    expect(screen.getByText(/Hi Maya, Thursday works/)).toBeInTheDocument();
  });
  it("does not allow approving an empty edited draft", () => {
    render(<DecisionCard action={action()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  " } });
    expect(
      screen.getByRole("button", { name: "Edit & approve" }),
    ).toBeDisabled();
  });
});
