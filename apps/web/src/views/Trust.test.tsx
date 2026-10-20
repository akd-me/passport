import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TrustPicker } from "./Trust";

describe("trust permission picker", () => {
  it("exposes all four modes and highlights only the current one", () => {
    render(<TrustPicker value="auto_accept_edits" onChange={vi.fn()} />);
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(
      screen.getByRole("radio", { name: /Auto-accept edits/ }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /^Supervised/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(
      screen.getByRole("radio", { name: /Full access/ }),
    ).toHaveTextContent("always-ask");
  });
  it("reports the selected contract value and supports disabled saving state", () => {
    const change = vi.fn(),
      { rerender } = render(
        <TrustPicker value="supervised" onChange={change} />,
      );
    fireEvent.click(screen.getByRole("radio", { name: /^Auto Passport/ }));
    expect(change).toHaveBeenCalledWith("auto");
    rerender(<TrustPicker value="auto" onChange={change} disabled />);
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    expect(change).toHaveBeenCalledTimes(1);
  });
});
