import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RenderFrame, renderDocument } from "./RenderFrame";
import { TimelineItem } from "./TimelineItems";
import { item as fixtureItem } from "./test-fixtures";

describe("rich render sandbox", () => {
  it("uses an opaque sandbox, fluid frame and full-size dialog from the timeline", () => {
    const item = {
      ...fixtureItem("assistant_message", { text: "" }),
      kind: "render" as const,
      untrusted: true,
      payload: { title: "Today", html: "<h2>Day</h2><p>Ready</p>", height: 240 },
    };
    render(<TimelineItem item={item} />);
    const frame = screen.getByTitle("Today");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame).not.toHaveAttribute("allow");
    expect(frame).toHaveStyle({ height: "240px" });
    expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
    expect(frame.getAttribute("srcdoc")).toContain("<h2>Day</h2>");
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open full size" }));
    expect(screen.getByRole("dialog", { name: "Today" })).toBeInTheDocument();
    expect(screen.getAllByTitle("Today")).toHaveLength(2);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["light", "dark"] as const)("injects the original theme tokens for %s", (theme) => {
    const html = renderDocument("<p>Theme</p>", theme);
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.documentElement.dataset.theme).toBe(theme);
    expect(doc.querySelector("style")?.textContent).toContain(
      "--canvas: light-dark(#fcfcfb, #1b1b1a)",
    );
    expect(doc.querySelector("style")?.textContent).toContain(
      "--accent: light-dark(#5546b0, #a39de6)",
    );
    expect(doc.querySelectorAll("script,link,img,form,a")).toHaveLength(0);
  });

  it("R2-23: embeds the app's faces as data URLs, the serif only for mail", () => {
    const style = (html: string) =>
      new DOMParser()
        .parseFromString(renderDocument(html, "light"), "text/html")
        .querySelector("style")?.textContent ?? "";
    const doc = renderDocument("<p>Day</p>", "light");
    expect(doc).toContain("font-src data:;");
    expect(doc).toContain("default-src 'none'");
    const plain = style("<p>Day</p>");
    expect(plain).toMatch(
      /@font-face \{ font-family: "Public Sans Variable";[^}]*url\(data:font\/woff2/,
    );
    expect(plain).not.toContain('Source Serif 4 Variable"; font-display');
    expect(style('<div class="mail"><p>Hi</p></div>')).toContain(
      '@font-face { font-family: "Source Serif 4 Variable"',
    );
  });

  it("keeps nested escaped quotes inside srcdoc without creating parent DOM attributes", () => {
    render(
      <RenderFrame
        title={'" onload="bad'}
        html={"<p>&quot;&lt;/iframe&gt;&lt;script&gt;bad&lt;/script&gt;</p>"}
        height={80}
      />,
    );
    const frame = screen.getByTitle('" onload="bad');
    expect(frame).not.toHaveAttribute("onload");
    expect(document.querySelectorAll("script")).toHaveLength(0);
    expect(frame).toHaveAttribute("sandbox", "");
  });
});
