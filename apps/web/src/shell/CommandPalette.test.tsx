import { useEffect } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Harness, stubApi } from "../test-utils";
import { useUi } from "../ui-state";
import { CommandPalette, filterCommands, type Command } from "./CommandPalette";

function OpenPalette() {
  const ui = useUi();
  useEffect(() => ui.setPalette(true), []); // eslint-disable-line react-hooks/exhaustive-deps
  return <output aria-label="settings section">{ui.settings ?? "closed"}</output>;
}
function renderPalette() {
  stubApi({
    "/matters": [{ id: "m1", title: "Northstar launch", status: "active", nextStep: "Confirm Thursday" }],
    "/people": [{ id: "p1", displayName: "Maya Chen", primaryEmail: "maya@example.com", emails: ["maya@example.com"] }],
  });
  return render(
    <Harness>
      <OpenPalette />
      <CommandPalette />
    </Harness>,
  );
}

describe("command palette", () => {
  it("matches every token across label, hint and keywords, ranking label hits first", () => {
    const cmd = (label: string, extra: Partial<Command> = {}): Command => ({
      id: label,
      group: "Actions",
      label,
      icon: "sparkle",
      run: vi.fn(),
      ...extra,
    });
    const list = [cmd("Settings: Trust & rules"), cmd("Permission mode: Auto", { keywords: "trust ladder" }), cmd("Queue")];
    expect(filterCommands(list, "trust").map((c) => c.label)).toEqual([
      "Settings: Trust & rules",
      "Permission mode: Auto",
    ]);
    expect(filterCommands(list, "ladder auto").map((c) => c.label)).toEqual(["Permission mode: Auto"]);
    expect(filterCommands(list, "")).toHaveLength(3);
  });

  it("filters as you type, runs the active command with Enter and closes", async () => {
    renderPalette();
    const input = await screen.findByRole("combobox", { name: /Search commands/ });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "trust rules" } });
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("Settings: Trust & rules");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByLabelText("settings section")).toHaveTextContent("trust");
  });

  it("finds matters and people, moves with arrows and closes on Escape", async () => {
    renderPalette();
    const input = await screen.findByRole("combobox");
    fireEvent.change(input, { target: { value: "maya" } });
    expect(await screen.findByRole("option", { name: /Maya Chen/ })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[1]!.id);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
