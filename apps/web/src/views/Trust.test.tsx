import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TrustPicker } from "./Trust";

describe("trust permission picker", () => {
  it("exposes all four modes and highlights only the current one", () => {
    render(<TrustPicker value="auto_accept_edits" onChange={vi.fn()} />);
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(screen.getByRole("radio", { name: /Auto-accept edits/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: /^Supervised/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("radio", { name: /Full access/ })).toHaveTextContent("always-ask");
  });
  it("reports the selected contract value and supports disabled saving state", () => {
    const change = vi.fn(),
      { rerender } = render(<TrustPicker value="supervised" onChange={change} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Auto Passport/ }));
    expect(change).toHaveBeenCalledWith("auto");
    rerender(<TrustPicker value="auto" onChange={change} disabled />);
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    expect(change).toHaveBeenCalledTimes(1);
  });
});

import { api } from "../api";
import { Harness, stubApi } from "../test-utils";
import { ModeMenu, PromotionPrompts } from "./Trust";

const trustData = {
  config: {
    globalMode: "auto_accept_edits",
    outboxHoldMinutes: 5,
    decayAfterDays: 14,
    alwaysAsk: ["money", "legal"],
    externalAgentCeiling: "auto_accept_edits",
  },
  categories: [
    {
      category: "newsletters",
      level: "auto_accept_edits",
      score: 0.8,
      stage: "trusted",
      approvals: 27,
      approvalsUnchanged: 25,
      edits: 2,
      rejections: 0,
      lastActivityAt: null,
    },
  ],
  promotionOffers: [
    {
      category: "newsletters",
      from: "auto_accept_edits",
      to: "auto",
      message: "Consistent.",
      evidence: { approvals: 27, approvalsUnchanged: 25, window: "30 days" },
    },
  ],
};

describe("permission mode menu", () => {
  it("shows the current mode on its trigger and switches mode from the popover", async () => {
    stubApi({ "/trust": trustData });
    const set = vi.spyOn(api, "setTrust").mockResolvedValue(trustData.config as never);
    render(
      <Harness>
        <ModeMenu />
      </Harness>,
    );
    const trigger = await screen.findByRole("button", {
      name: "Permission mode: Auto-accept edits",
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    const popover = screen.getByRole("dialog", { name: "Permission mode: Auto-accept edits" });
    expect(popover).toHaveTextContent("Always asks about money, legal.");
    expect(screen.getByRole("radio", { name: /Auto-accept edits/ })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("radio", { name: /Auto-accept edits/ }), {
      key: "ArrowDown",
    });
    expect(screen.getByRole("radio", { name: /^Auto Passport/ })).toHaveFocus();
    fireEvent.click(screen.getByRole("radio", { name: /^Auto Passport/ }));
    await waitFor(() => expect(set).toHaveBeenCalledWith({ globalMode: "auto" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("closes on Escape and returns focus to the trigger", async () => {
    stubApi({ "/trust": trustData });
    render(
      <Harness>
        <ModeMenu />
      </Harness>,
    );
    const trigger = await screen.findByRole("button", { name: /Permission mode/ });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe("promotion prompts", () => {
  it("offers the promotion in context and pins the category when accepted", async () => {
    stubApi({ "/trust": trustData });
    const pin = vi.spyOn(api, "pin").mockResolvedValue(trustData.categories[0] as never);
    render(<PromotionPrompts />);
    expect(
      await screen.findByText(/25 of 27 approved without changes in 30 days/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow Auto" }));
    await waitFor(() => expect(pin).toHaveBeenCalledWith("newsletters", "auto"));
  });
  it("remembers a dismissal", async () => {
    localStorage.clear();
    stubApi({ "/trust": trustData });
    const { unmount } = render(<PromotionPrompts />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Dismiss the Newsletters suggestion" }),
    );
    expect(screen.queryByText(/approved without changes/)).not.toBeInTheDocument();
    unmount();
    render(<PromotionPrompts />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByText(/approved without changes/)).not.toBeInTheDocument();
    localStorage.clear();
  });
});
