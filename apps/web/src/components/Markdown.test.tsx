import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown, markdownToText } from "./Markdown";

const html = (text: string) => render(<Markdown text={text} />).container.firstElementChild;

describe("Markdown", () => {
  it("renders bold, italics, strike and inline code", () => {
    const root = html("Pay **now**, or *soon*, or ~~never~~ via `mail_search`.");
    expect(root?.querySelector("strong")).toHaveTextContent("now");
    expect(root?.querySelector("em")).toHaveTextContent("soon");
    expect(root?.querySelector("del")).toHaveTextContent("never");
    expect(root?.querySelector("code")).toHaveTextContent("mail_search");
    expect(root).toHaveTextContent("Pay now, or soon, or never via mail_search.");
  });

  it("keeps underscores inside words and lone asterisks as text", () => {
    const root = html("snake_case_name and 2 * 3 * 4 and a*b");
    expect(root?.querySelector("em")).toBeNull();
    expect(root).toHaveTextContent("snake_case_name and 2 * 3 * 4 and a*b");
  });

  it("renders bullet lists, including the glued `-**` form models emit", () => {
    const root = html(
      [
        "For **October 23–27**, the main item is:",
        "",
        "-**Tuesday, October 27:** Doppel interview.",
        "- **ChatJitsu alert:** RLS disabled.",
        "* Third",
      ].join("\n"),
    );
    const items = root?.querySelectorAll("ul > li") ?? [];
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Tuesday, October 27: Doppel interview.");
    expect(items[0]?.querySelector("strong")).toHaveTextContent("Tuesday, October 27:");
    expect(root?.querySelector("p strong")).toHaveTextContent("October 23–27");
  });

  it("nests lists by indentation and keeps numbering", () => {
    const root = html(
      ["3. three", "4. four", "   - nested a", "   - nested b", "5. five"].join("\n"),
    );
    const ol = root?.querySelector("ol");
    expect(ol).toHaveAttribute("start", "3");
    expect(ol?.querySelectorAll(":scope > li")).toHaveLength(3);
    expect(ol?.querySelectorAll(":scope > li > ul > li")).toHaveLength(2);
  });

  it("returns to the outer list after a nested one", () => {
    const root = html(["- a", "  - a.1", "  - a.2", "- b", "- c"].join("\n"));
    expect(root?.querySelectorAll(":scope > ul > li")).toHaveLength(3);
    expect(root?.querySelectorAll(":scope > ul > li > ul > li")).toHaveLength(2);
    expect(root?.querySelectorAll(":scope > ul > li")[1]).toHaveTextContent(/^b$/);
  });

  it("separates paragraphs on blank lines and breaks on single newlines", () => {
    const root = html("one\ntwo\n\nthree");
    const paragraphs = root?.querySelectorAll("p") ?? [];
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.querySelector("br")).not.toBeNull();
    expect(paragraphs[1]).toHaveTextContent("three");
  });

  it("renders headings, quotes, rules, fenced code and tables", () => {
    const root = html(
      [
        "## Summary",
        "> quoted *text*",
        "---",
        "```ts",
        "const a = **not bold**;",
        "```",
        "| Bill | Due |",
        "|---|---|",
        "| PSE&G | Nov 2 |",
      ].join("\n"),
    );
    expect(root?.querySelector(".md-heading")).toHaveTextContent("Summary");
    expect(root?.querySelector("blockquote em")).toHaveTextContent("text");
    expect(root?.querySelector("hr")).not.toBeNull();
    expect(root?.querySelector("pre code")).toHaveTextContent("const a = **not bold**;");
    expect(root?.querySelector("pre code strong")).toBeNull();
    expect(root?.querySelectorAll("th")).toHaveLength(2);
    expect(root?.querySelector("td")).toHaveTextContent("PSE&G");
  });

  it("never emits anchors, images or raw HTML", () => {
    const text =
      'Pay [here](http://evil.example/x) ![tracker](http://evil.example/p.gif "t") <img src=x onerror=alert(1)> <b>bold?</b>';
    const root = html(text);
    expect(root?.querySelector("a")).toBeNull();
    expect(root?.querySelector("img")).toBeNull();
    expect(root?.querySelector("b")).toBeNull();
    expect(root).toHaveTextContent("Pay here (http://evil.example/x)");
    expect(root).toHaveTextContent("tracker (http://evil.example/p.gif)");
    expect(root).toHaveTextContent("<img src=x onerror=alert(1)> <b>bold?</b>");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows a bare link once when its label is the URL", () => {
    const root = html("[https://a.example](https://a.example)");
    expect(root).toHaveTextContent(/^https:\/\/a\.example$/);
  });

  it("keeps the sigil-neutralized text the server emits intact", () => {
    const zwsp = "​";
    const root = html(`Costs $${zwsp}5 for @${zwsp}alice and /${zwsp}usr`);
    expect(root).toHaveTextContent(`Costs $${zwsp}5 for @${zwsp}alice and /${zwsp}usr`);
  });
});

describe("markdownToText", () => {
  it("drops the markers, keeps link URLs visible and makes one line", () => {
    expect(markdownToText("Priya offers **9–11** or __16–18__ *June*, ~~not~~ `July`?")).toBe(
      "Priya offers 9–11 or 16–18 June, not July?",
    );
    expect(markdownToText("# Dates\n\n- [Calendar](https://cal.example/x)\n- ![map](m.png)")).toBe(
      "Dates Calendar (https://cal.example/x) map (m.png)",
    );
    expect(markdownToText("> quoted\nline two\n\n| a | b |\n|---|---|\n| 1 | 2 |")).toBe(
      "quoted line two a b 1 2",
    );
    expect(markdownToText("snake_case and 2 * 3")).toBe("snake_case and 2 * 3");
  });
});
