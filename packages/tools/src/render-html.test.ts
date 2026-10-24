import { describe, expect, it } from "vitest";
import { RENDER_MAX_BYTES, renderHeight, sanitizeRenderHtml } from "./render-html.js";

describe("restricted render parser", () => {
  it("keeps the full structural allowlist and only class on span/div", () => {
    const html =
      '<h1>Day</h1><h2>A</h2><h3>B</h3><h4>C</h4><h5>D</h5><h6>E</h6><p>Summary <strong>bold</strong> <em>emphasis</em> <code>x</code></p><ul><li>A</li></ul><ol><li>B</li></ol><table><thead><tr><th>A</th></tr></thead><tbody><tr><td>B</td></tr></tbody></table><pre>x</pre><blockquote>Quote</blockquote><hr><div class="muted"><span class="num">1</span></div>';
    expect(sanitizeRenderHtml(html)).toBe(html);
    expect(
      sanitizeRenderHtml(
        '<p class="x" id="y">P</p><div class="quiet invalid!" style="color:red" title="t">D</div>',
      ),
    ).toBe('<p>P</p><div class="quiet">D</div>');
  });

  it.each([
    "<script>alert(1)</script><p>Safe</p>",
    "<svg><script>alert(1)</script></svg><p>Safe</p>",
    "<style>body{background:url(https://evil)}</style><p>Safe</p>",
    '<iframe src="https://evil"></iframe><p>Safe</p>',
    '<form action="https://evil"><input name="secret"></form><p>Safe</p>',
    '<img src="https://evil/beacon"><link rel="stylesheet" href="https://evil"><p>Safe</p>',
    "<!-- <script> --><p>Safe</p>",
  ])("removes active content and external loads: %s", (html) => {
    expect(sanitizeRenderHtml(html)).toBe("<p>Safe</p>");
  });

  it("removes event handlers, attributes, and CSS in mixed case and malformed markup", () => {
    expect(
      sanitizeRenderHtml(
        '<DIV onclick="alert(1)" oNmOuSeOvEr=bad class="quiet"><p style="background:url(https://evil)" onload=bad>Hello</p></DIV>',
      ),
    ).toBe('<div class="quiet"><p>Hello</p></div>');
    expect(sanitizeRenderHtml("<p/onload=alert(1)>Hi</p>")).toBe("<p>Hi</p>");
  });

  it("renders every link as label plus visible URL, including javascript: URLs", () => {
    const html = sanitizeRenderHtml(
      '<a href="https://example.com?a=1&amp;b=2">Example</a> <a href="jav&#x61;script:alert(1)" onclick="bad">Open</a>',
    );
    expect(html).toBe("Example (https://example.com?a=1&amp;b=2) Open (javascript:alert(1))");
    expect(html).not.toContain("<a");
  });

  it("cannot escape srcdoc through nested quotes, entities or closing iframe/style tags", () => {
    const html = sanitizeRenderHtml(
      '<div class="x&quot; onload=&quot;bad">&lt;/iframe&gt;&lt;script&gt;bad&lt;/script&gt;</div></style></iframe><span class=\'x" onload="bad\'>safe</span>',
    );
    expect(html).not.toMatch(/<\/?(?:iframe|script|style)|onload|srcdoc|sandbox/);
    expect(html).toContain("&lt;/iframe&gt;&lt;script&gt;bad&lt;/script&gt;");
    expect(sanitizeRenderHtml(html)).toBe(html);
  });

  it("escapes malformed text and balances allowed nesting without browser-dependent repair", () => {
    expect(sanitizeRenderHtml("<p><strong>A</p>B &amp; C < 3")).toBe(
      "<p><strong>A</strong></p>B &amp; C &lt; 3",
    );
    expect(sanitizeRenderHtml('<div title="unterminated><script>bad')).not.toContain("<script>");
  });

  it("neutralises decoded command sigils as well as literal text", () => {
    expect(sanitizeRenderHtml("<p>&#36;skill &#64;agent</p>")).toBe(
      "<p>$\u200bskill @\u200bagent</p>",
    );
  });

  it("caps raw and sanitised UTF-8 bytes, including expansion and multibyte input", () => {
    expect(() => sanitizeRenderHtml("a".repeat(RENDER_MAX_BYTES + 1))).toThrow(/64 KiB/);
    expect(() => sanitizeRenderHtml("é".repeat(RENDER_MAX_BYTES / 2 + 1))).toThrow(/64 KiB/);
    expect(() => sanitizeRenderHtml("&".repeat(14000))).toThrow(/64 KiB/);
    expect(sanitizeRenderHtml("a".repeat(RENDER_MAX_BYTES))).toHaveLength(RENDER_MAX_BYTES);
  });

  it("bounds content-derived and requested heights", () => {
    expect(renderHeight("x")).toBe(80);
    expect(renderHeight("<p>x</p>".repeat(200))).toBe(1200);
    expect(renderHeight("x", 450)).toBe(450);
    for (const height of [79, 1201, 80.5, Number.NaN]) {
      expect(() => renderHeight("x", height)).toThrow(/height/);
    }
  });
});
