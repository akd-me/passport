import type { ActionRecord, DraftInput, Email } from "@passport/types";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { ApprovalItem } from "../tasks/ApprovalItem";
import { ActionsProvider } from "../tasks/actions-store";
import { renderApi } from "../tasks/render-api";
import { task as taskFixture } from "../tasks/test-fixtures";
import { DecisionCard } from "./DecisionCard";

const draft: DraftInput = {
  accountId: "account-1",
  inReplyToEmailId: "mail-1",
  to: [{ name: "Dana", email: "dana@example.com" }],
  subject: "Tomorrow",
  textBody: "Thursday works.",
};
const action: ActionRecord = {
  id: "draft-action",
  status: "proposed",
  createdAt: "2026-10-24T10:00:00Z",
  request: {
    type: "draft_create",
    accountId: "account-1",
    actor: { kind: "agent", id: "agent" },
    category: "replies_known",
    reason: "Draft a reply",
    params: { draft },
  },
  decision: {
    outcome: "ask",
    risk: "low",
    reversibility: "reversible",
    category: "replies_known",
    trustLevel: "supervised",
    reason: "Review first",
  },
};
const source = {
  id: "mail-1",
  threadId: "thread-1",
  from: [{ name: "Dana", email: "dana@example.com" }],
  subject: "Tomorrow",
  receivedAt: "2026-10-24T09:00:00Z",
  textBody: "Could we meet? <script>bad</script>",
  preview: "Meet?",
  keywords: {},
} as Email;
function threadReads() {
  return vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      const path = String(input);
      const result = path.includes("/threads/")
        ? { thread: { id: "thread-1" }, emails: { items: [source], total: 1, nextCursor: null } }
        : source;
      return new Response(JSON.stringify(result));
    }),
  );
}
const saved = (textBody: string): ActionRecord => ({
  ...action,
  request: { ...action.request, params: { draft: { ...draft, textBody, htmlBody: null } } },
});
const open = () => {
  fireEvent.click(screen.getByRole("button", { name: "Review draft" }));
  return screen.getByRole("dialog");
};

describe("side-by-side draft review", () => {
  it("opens from Needs you with conversation text and an editable draft", async () => {
    threadReads();
    render(<DecisionCard action={action} />);
    const dialog = open();
    expect(within(dialog).getByRole("region", { name: "Conversation" })).toBeInTheDocument();
    expect(await within(dialog).findByText(source.textBody!)).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Review draft body" })).toHaveValue(
      draft.textBody,
    );
    expect(document.querySelector("script")).toBeNull();
    expect(fetch).toHaveBeenCalledWith("/api/threads/thread-1", expect.anything());
  });

  it("opens the same review from a pending task approval and retains one-click approve", async () => {
    threadReads();
    const approve = vi.spyOn(api, "approve").mockResolvedValue({ ...action, status: "executed" });
    render(
      <ApprovalItem
        item={{
          id: "item-1",
          taskId: "task-1",
          runId: "run-1",
          seq: 1,
          at: action.createdAt,
          kind: "approval_request",
          payload: { actionId: action.id, summary: "Draft a reply" },
        }}
        task={{ ...taskFixture("task-1"), pendingActionIds: [action.id] }}
        record={action}
        load="loaded"
        onRetry={() => {}}
        selected={false}
        onSelect={() => {}}
      />,
    );
    open();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith(action.id, undefined, "once"));
  });

  it("saves inline edits without approving and reopens with the saved content", async () => {
    threadReads();
    const save = vi.spyOn(renderApi, "saveDraft").mockResolvedValue(saved("Friday works."));
    const approve = vi.spyOn(api, "approve");
    render(
      <ActionsProvider>
        <DecisionCard action={action} />
      </ActionsProvider>,
    );
    const dialog = open();
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Friday works." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(action.id, "Friday works."));
    await waitFor(() =>
      expect(within(dialog).getByRole("status")).toHaveTextContent("Saved draft"),
    );
    expect(approve).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(within(open()).getByRole("textbox")).toHaveValue("Friday works.");
  });

  it("previews the edited draft and quoted history through the server and the same sandbox", async () => {
    threadReads();
    const preview = vi.spyOn(renderApi, "preview").mockResolvedValue({
      html: "<pre>Friday</pre><blockquote>Could we meet?</blockquote>",
      height: 320,
    });
    render(<DecisionCard action={action} />);
    const dialog = open();
    await within(dialog).findByText(source.textBody!);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Friday" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "As they will see it" }));
    const frame = await within(dialog).findByTitle("Draft as received");
    expect(preview.mock.calls[0]?.[0]).toContain('<div class="mail"><p>Friday</p></div>');
    expect(preview.mock.calls[0]?.[0]).toContain("&lt;script&gt;bad&lt;/script&gt;");
    // R2-9: the quoted history reads a date the way a mail client writes it, not ISO.
    const quotedOn = new Date(source.receivedAt).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    expect(preview.mock.calls[0]?.[0]).toContain(`On ${quotedOn},`);
    expect(preview.mock.calls[0]?.[0]).not.toContain(source.receivedAt);
    expect(within(dialog).getByRole("button", { name: "As they will see it" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame.getAttribute("srcdoc")).toContain("<blockquote>Could we meet?</blockquote>");
    fireEvent.click(within(dialog).getByRole("button", { name: "As they will see it" }));
    expect(within(dialog).getByRole("textbox")).toHaveValue("Friday");
  });

  it("approves an unsaved inline edit through the existing approval route", async () => {
    threadReads();
    const approve = vi
      .spyOn(api, "approve")
      .mockResolvedValue({ ...saved("Friday"), status: "executed" });
    render(<DecisionCard action={action} />);
    const dialog = open();
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Friday" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith(
        action.id,
        expect.objectContaining({
          params: { draft: { ...draft, textBody: "Friday", htmlBody: null } },
        }),
        "once",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows a preview failure and lets the person return to their editable draft", async () => {
    threadReads();
    vi.spyOn(renderApi, "preview").mockRejectedValue(
      new Error("Render HTML must fit within 64 KiB."),
    );
    render(<DecisionCard action={action} />);
    const dialog = open();
    await within(dialog).findByText(source.textBody!);
    fireEvent.click(within(dialog).getByRole("button", { name: "As they will see it" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("64 KiB");
    expect(within(dialog).queryByTitle("Draft as received")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "As they will see it" }));
    expect(within(dialog).getByRole("textbox")).toHaveValue(draft.textBody);
  });

  it("keeps edits and an actionable error on save failure, and rejects blank drafts", async () => {
    threadReads();
    vi.spyOn(renderApi, "saveDraft").mockRejectedValue(
      new Error("This proposal has already been decided."),
    );
    render(<DecisionCard action={action} />);
    const dialog = open();
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Friday" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already been decided");
    expect(within(dialog).getByRole("textbox")).toHaveValue("Friday");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "  " } });
    expect(within(dialog).getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Approve" })).toBeDisabled();
  });
});
