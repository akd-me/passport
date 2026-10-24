// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Every stylesheet under src (the entry, its layers, and feature sheets), as one sheet. */
const src = new URL("./", import.meta.url);
const files = readdirSync(src, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".css"))
  .sort();
const sheets = files.map((file) => [file, readFileSync(new URL(file, src), "utf8")] as const);
const css = sheets.map(([, text]) => text).join("\n");

/** `[light, dark]` for a `--name: light-dark(#light, #dark)` token. */
function token(name: string) {
  const match = css.match(new RegExp(`--${name}: light-dark\\((#[0-9a-f]{6}), (#[0-9a-f]{6})\\)`));
  if (!match) {
    throw new Error(`No light-dark token --${name}`);
  }
  return match.slice(1, 3);
}

/** The custom property a rule sets `color` from. */
function colorToken(selector: string) {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) {
    throw new Error(`No rule for ${selector}`);
  }
  const body = css.slice(start, css.indexOf("}", start));
  const name = body.match(/\n {2}color: var\(--([a-z0-9-]+)\);/)?.[1];
  if (!name) {
    throw new Error(`${selector} sets no color token`);
  }
  return name;
}

function luminance(hex: string) {
  const weights = [0.2126, 0.7152, 0.0722];
  return weights.reduce((sum, weight, index) => {
    const channel = Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return sum + weight * linear;
  }, 0);
}

function contrast(foreground: string, background: string) {
  const a = luminance(foreground),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("instructional text contrast", () => {
  const rules: [selector: string, background: string][] = [
    [".composer textarea::placeholder", "raised"],
    [".composer-hint", "raised"],
    [".key-hints", "sunken"],
    [".side-empty", "sunken"],
  ];
  for (const [selector, background] of rules) {
    it(`V2-16: ${selector} reaches 4.5:1 in light and dark`, () => {
      const foreground = token(colorToken(selector)),
        surface = token(background);
      foreground.forEach((color, theme) => {
        expect(contrast(color, surface[theme] ?? "")).toBeGreaterThanOrEqual(4.5);
      });
    });
  }

  it("V2-16: --faint is kept for decorative strokes and disabled glyphs", () => {
    const users = [...css.matchAll(/\n([^\n{}]+) \{[^}]*\n {2}color: var\(--faint\);/g)].map(
      (match) => match[1],
    );
    // Every user is a glyph or icon beside readable text, never the text itself.
    expect(users.sort()).toEqual([
      ".crumb-sep",
      ".empty .icon",
      ".section-toggle .icon",
      ".send-btn:disabled",
      ".tool-group-head .icon",
    ]);
  });
});

describe("stylesheets", () => {
  it("reads every sheet, including feature sheets outside styles/", () => {
    expect(files).toEqual(expect.arrayContaining(["styles.css", "tasks/orchestration.css"]));
  });

  it("uses no custom property that no sheet declares", () => {
    const declared = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const unknown = sheets.flatMap(([file, text]) =>
      [...text.matchAll(/var\((--[a-z0-9-]+)/g)]
        .filter((m) => !declared.has(m[1]))
        .map((m) => `${file}: ${m[1]}`),
    );
    expect(unknown).toEqual([]);
  });
});

describe("one accent (brief §3)", () => {
  it("R2-10: is used only for the primary action, focus and what returns to the person", () => {
    const users = new Set(
      sheets
        .filter(([file]) => file !== "styles/tokens.css")
        .flatMap(([, text]) =>
          [...`\n${text}`.matchAll(/\n([^\n{}]+(?:,\n[^\n{}]+)*) \{([^}]*)\}/g)]
            .filter((m) => m[2]?.includes("var(--accent"))
            .flatMap((m) => (m[1] ?? "").split(",\n").map((selector) => selector.trim())),
        ),
    );
    expect([...users].sort()).toEqual(
      [
        // The primary action.
        ".btn-primary",
        ".btn-primary:hover:not(:disabled)",
        ".send-btn",
        ".send-btn:hover:not(:disabled)",
        // Focus, the selected decision, text being edited, and a drop target while dragging.
        ":focus-visible",
        ":where(input, select, textarea):focus-visible",
        "::selection",
        ".chip-toggle:has(:focus-visible)",
        ".composer:focus-within",
        ".input-unit:focus-within",
        ".search-field:focus-within",
        ".proposal:focus-visible",
        ".proposal.selected::before",
        ".queue-edit",
        ".task-title-edit input",
        ".queue-row.drop-after::after",
        ".queue-row.drop-before::before",
        // What needs the person: the count, Approval, Input, Woke, questions and setup prompts.
        ".side-count.strong",
        ".task-card-what .need",
        ".task-glyph.approval",
        ".task-glyph.input",
        ".task-glyph.woke",
        ".state-word.approval",
        ".state-word.input",
        ".state-word.woke",
        ".approval-panel-head h2 .icon",
        ".change-status.proposed",
        ".tl-approval .proposal",
        ".tl-approval.pending",
        ".tl-approval.pending .tl-line > .icon",
        ".tl-message.question",
        ".question-panel",
        ".setup-prompt",
        ".setup-prompt > .icon",
        ".side-row.setup-waiting .icon",
        // The person's own messages (the brief's tinted block) and the brand mark.
        ".tl-message.from-user",
        ".brand-mark",
      ].sort(),
    );
  });
});

describe("design tokens", () => {
  const pairs: [foreground: string, background: string][] = [
    ["muted", "canvas"],
    ["muted", "sunken"],
    ["muted", "selected"],
    ["text-2", "sunken"],
    ["accent", "canvas"],
    ["accent", "raised"],
    ["accent", "accent-soft"],
    ["amber", "canvas"],
    ["red", "canvas"],
    ["green", "canvas"],
  ];
  for (const [foreground, background] of pairs) {
    it(`--${foreground} on --${background} reaches 4.5:1 in light and dark`, () => {
      const fg = token(foreground),
        bg = token(background);
      fg.forEach((color, theme) => {
        expect(contrast(color, bg[theme] ?? "")).toBeGreaterThanOrEqual(4.5);
      });
    });
  }

  it("white on the accent fill reaches 4.5:1 in both themes", () => {
    for (const fill of token("accent-fill")) {
      expect(contrast("#ffffff", fill)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("uses one radius for controls and one for panels", () => {
    const radii = new Set(
      [...css.matchAll(/border-radius: var\(--(r-[a-z]+)\)/g)].map((m) => m[1]),
    );
    expect([...radii].sort()).toEqual(["r-control", "r-panel"]);
  });

  it("keeps to five type sizes", () => {
    const sizes = new Set([...css.matchAll(/font-size: var\(--(t-[a-z]+)\)/g)].map((m) => m[1]));
    expect([...sizes].sort()).toEqual(["t-l", "t-m", "t-s", "t-xl", "t-xs"]);
  });

  it("draws no gradients or glass", () => {
    expect(css).not.toMatch(/gradient\(|backdrop-filter|inset 0 0 0/);
  });
});
