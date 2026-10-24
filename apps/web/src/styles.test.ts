// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The entry plus every layer it imports, as one sheet. */
const dir = new URL("./styles/", import.meta.url);
const css = [
  readFileSync(new URL("./styles.css", import.meta.url), "utf8"),
  ...readdirSync(dir)
    .filter((file) => file.endsWith(".css"))
    .map((file) => readFileSync(new URL(file, dir), "utf8")),
].join("\n");

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
      ".queue-grip",
      ".section-toggle .icon",
      ".send-btn:disabled",
      ".task-glyph.idle",
      ".tool-group-head .icon",
    ]);
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
